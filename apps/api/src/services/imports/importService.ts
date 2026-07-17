import type {
  ApplyImportRequest,
  ApplyImportResponse,
  ImportBatch,
  ImportBatchCounts,
  ImportBrokerListResponse,
  ImportPreviewResponse,
  ImportRow,
  ImportRowOutcome,
  ImportRowResult,
  SearchResultItem,
  TransactionInput,
} from '@bettertrack/contracts';
import { IMPORT_MAX_ROWS, importSourceTag } from '@bettertrack/contracts';

import { ApiError, badRequest, conflict, notFound } from '../../errors';
import type {
  ImportRepository,
  ImportRowRecord,
  StageImportRowInput,
} from '../../data/repositories/importRepository';
import type { CashSourceRepository } from '../../data/repositories/cashSourceRepository';
import type { PortfolioRepository } from '../../data/repositories/portfolioRepository';
import type { TransactionRepository } from '../../data/repositories/transactionRepository';
import type { Logger } from '../../logger';
import type { PortfolioService } from '../portfolio/portfolioService';
import type { SearchService } from '../search/searchService';
import type { TaxService } from '../tax/taxService';
import { contentHash } from './contentHash';
import { parseCsv } from './csv';
import { createMapperRegistry } from './registry';
import type { ImportBatchRow } from '../../data/schema';
import type { BrokerMapper, MappedLine, NormalizedImportRow } from './types';

/**
 * Broker CSV import framework (PROJECTPLAN.md §13.4 V4-P8): upload → autodetect
 * (or manual pick) → normalized STAGING (nothing portfolio-visible is written)
 * → preview with per-row `mapped`/`unmapped`/`duplicate`/`error` flags →
 * explicit confirm → apply into a chosen portfolio + cash source.
 *
 * Boundaries (§4, issue #492):
 * - every portfolio write goes through the EXISTING services — trades via
 *   `portfolio.createTransactions` (oversell/cash/tax semantics included),
 *   dividends via `tax.recordDividend` (the V3-P4 engine applies the user's tax
 *   mode), cash via `portfolio.depositCash`/`withdrawCash`. Never SQL from here.
 * - instrument resolution goes through the local search catalog and accepts
 *   only EXACT identity matches (symbol, ISIN-as-symbol, or whole-name) — an
 *   unresolved instrument is flagged `unmapped` and excluded from apply, never
 *   silently guessed (§13.4 acceptance).
 * - apply is per-row tolerant: each row lands atomically WITH its linked cash/
 *   tax legs (the owning service's transaction), a rejected row is reported and
 *   the rest continue — never all-or-nothing across rows.
 */

export interface ImportServiceDeps {
  importRepo: ImportRepository;
  portfolioRepo: PortfolioRepository;
  transactionRepo: TransactionRepository;
  cashSourceRepo: CashSourceRepository;
  search: SearchService;
  portfolio: PortfolioService;
  tax: TaxService;
  mappers: readonly BrokerMapper[];
  logger?: Logger;
}

export interface CreateImportBatchInput {
  portfolioId: string;
  filename: string;
  /** Decoded file text (the route reads the multipart buffer as UTF-8). */
  content: string;
  /** Manual broker override; omitted → autodetect. */
  brokerId?: string;
}

export interface ImportService {
  /** The supported broker mappers, for the manual picker. */
  listBrokers(): ImportBrokerListResponse;
  /** Parse + normalize + resolve + dedupe an upload into a staged batch (§13.4). */
  createBatch(userId: string, input: CreateImportBatchInput): Promise<ImportPreviewResponse>;
  /** Re-read a staged batch (owner-scoped, 404 otherwise). */
  getBatch(userId: string, batchId: string): Promise<ImportPreviewResponse>;
  /** Apply a pending batch's valid rows; per-row outcomes, never all-or-nothing. */
  applyBatch(
    userId: string,
    batchId: string,
    input: ApplyImportRequest,
  ): Promise<ApplyImportResponse>;
  /** Discard a staged batch (any status — it is only staging data). */
  discardBatch(userId: string, batchId: string): Promise<void>;
}

/** Case/whitespace-insensitive whole-string name identity (never fuzzy). */
function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** The file's raw instrument identity — the in-file dedupe key when unresolved. */
function rawInstrumentKey(row: NormalizedImportRow): string | null {
  if (row.isin) return `isin:${row.isin.toUpperCase()}`;
  if (row.symbol) return `symbol:${row.symbol.toUpperCase()}`;
  if (row.name) return `name:${normalizeName(row.name)}`;
  return null;
}

const needsInstrument = (kind: NormalizedImportRow['kind']): boolean =>
  kind === 'buy' || kind === 'sell' || kind === 'dividend';

/**
 * The COMPLETE staging boundary. Every normalized field a mapper emits is
 * persisted verbatim into a constrained `import_rows` column — `char(3)`
 * currency, `numeric(20,8)` quantity, `numeric(20,6)` price/fee/amount — and
 * the batch INSERT is a single statement, so any one value a column rejects
 * ("EURO", a 13-integer-digit quantity) would kill every valid row with it as
 * an unhandled 500. Per-row tolerance (§13.4) is the framework's promise, so
 * it is enforced HERE for every constrained field, not just per mapper: a
 * value that cannot be staged costs its one line, never the upload — and no
 * future mapper (George/Flatex/IBKR land against this frozen framework) can
 * crash staging with a shape the columns refuse.
 */
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** Mirrors the `import_rows` numeric columns (data/schema.ts) — the magnitude
 * ceilings derive from precision/scale so a schema change keeps them honest. */
const NUMERIC_COLUMNS: ReadonlyArray<{
  field: 'quantity' | 'price' | 'fee' | 'amountEur';
  label: string;
  precision: number;
  scale: number;
}> = [
  { field: 'quantity', label: 'Quantity', precision: 20, scale: 8 },
  { field: 'price', label: 'Price', precision: 20, scale: 6 },
  { field: 'fee', label: 'Fee', precision: 20, scale: 6 },
  { field: 'amountEur', label: 'Amount', precision: 20, scale: 6 },
];

function stagingViolation(row: NormalizedImportRow): string | null {
  if (!CURRENCY_PATTERN.test(row.currency)) {
    return `Unrecognized currency "${row.currency}".`;
  }
  for (const col of NUMERIC_COLUMNS) {
    const value = row[col.field];
    if (value === null) continue;
    const integerDigits = col.precision - col.scale;
    // Postgres rounds excess scale silently but rejects excess integer
    // digits, so the ceiling applies to the value as the column rounds it.
    const rounded = Math.round(Math.abs(value) * 10 ** col.scale) / 10 ** col.scale;
    if (!Number.isFinite(value) || rounded >= 10 ** integerDigits) {
      return `${col.label} ${value} is too large to import (must be below 10^${integerDigits}).`;
    }
  }
  return null;
}

function guardStagedRow(line: MappedLine): MappedLine {
  if (!line.ok) return line;
  const violation = stagingViolation(line.row);
  if (violation === null) return line;
  return { line: line.line, raw: line.raw, ok: false, error: violation };
}

export function createImportService(deps: ImportServiceDeps): ImportService {
  const { importRepo, portfolioRepo, transactionRepo, cashSourceRepo, search, portfolio, tax } =
    deps;
  const registry = createMapperRegistry(deps.mappers);

  async function requireOwnedPortfolio(userId: string, portfolioId: string): Promise<void> {
    const owned = await portfolioRepo.findByIdForUser(userId, portfolioId);
    if (!owned) throw notFound('Portfolio not found.', 'PORTFOLIO_NOT_FOUND');
  }

  /**
   * Resolve one instrument identity against the local catalog (§6.2) via the
   * search service, accepting only exact matches: the file's ticker symbol, its
   * ISIN used as a catalog symbol (common for custom assets), or the exact
   * security name. When the first pass misses and the search kicked off a
   * background provider enrichment, wait for it once and retry — a fresh
   * instrument the user never opened can then still resolve. Anything less than
   * an exact match returns null (→ `unmapped`, never a silent guess).
   */
  async function resolveInstrument(
    userId: string,
    key: { isin: string | null; symbol: string | null; name: string | null },
  ): Promise<SearchResultItem | null> {
    const attempts: Array<{ query: string; matches: (r: SearchResultItem) => boolean }> = [];
    if (key.symbol) {
      const wanted = key.symbol.toUpperCase();
      attempts.push({ query: key.symbol, matches: (r) => r.symbol.toUpperCase() === wanted });
    }
    if (key.isin) {
      const wanted = key.isin.toUpperCase();
      attempts.push({ query: key.isin, matches: (r) => r.symbol.toUpperCase() === wanted });
    }
    if (key.name) {
      const wanted = normalizeName(key.name);
      attempts.push({ query: key.name, matches: (r) => normalizeName(r.name) === wanted });
    }
    for (const attempt of attempts) {
      let result = await search.search(userId, attempt.query);
      let hit = result.results.find(attempt.matches);
      if (!hit && result.enriching) {
        await search.enrichmentSettled();
        result = await search.search(userId, attempt.query);
        hit = result.results.find(attempt.matches);
      }
      if (hit) return hit;
    }
    return null;
  }

  /**
   * Content hashes of everything already recorded in the portfolio — existing
   * transactions (the §13.4 `date+instrument+qty+price` key), dividends and
   * external cash movements — so a re-import of an already-applied file flags
   * every row `duplicate` and applies nothing. Derived from live data, so
   * deleting a mis-imported entity makes the row importable again.
   */
  async function collectExistingHashes(userId: string, portfolioId: string): Promise<Set<string>> {
    const hashes = new Set<string>();
    const txs = await transactionRepo.listForPortfolio(portfolioId);
    for (const tx of txs) {
      hashes.add(
        contentHash({
          kind: tx.side,
          executedAt: tx.executedAt,
          instrument: tx.assetId,
          quantity: tx.quantity,
          price: tx.price,
          amountEur: null,
        }),
      );
    }
    const { dividends } = await tax.listDividends(userId, portfolioId);
    for (const d of dividends) {
      hashes.add(
        contentHash({
          kind: 'dividend',
          executedAt: new Date(d.executedAt),
          instrument: d.assetId,
          quantity: null,
          price: null,
          amountEur: d.grossAmountEur,
        }),
      );
    }
    const cash = await portfolio.getCashMovements(userId, portfolioId);
    for (const m of cash.movements) {
      if (m.kind !== 'deposit' && m.kind !== 'withdrawal') continue;
      hashes.add(
        contentHash({
          kind: m.kind,
          executedAt: new Date(m.executedAt),
          instrument: null,
          quantity: null,
          price: null,
          amountEur: Math.abs(m.amountEur),
        }),
      );
    }
    return hashes;
  }

  function toCounts(rows: ImportRowRecord[]): ImportBatchCounts {
    const counts: ImportBatchCounts = {
      total: rows.length,
      mapped: 0,
      unmapped: 0,
      duplicate: 0,
      error: 0,
    };
    for (const r of rows) counts[r.flag] += 1;
    return counts;
  }

  function toBatchDto(batch: ImportBatchRow, rows: ImportRowRecord[]): ImportBatch {
    return {
      id: batch.id,
      portfolioId: batch.portfolioId,
      brokerId: batch.brokerId,
      brokerLabel: registry.byId(batch.brokerId)?.label ?? batch.brokerId,
      filename: batch.filename,
      status: batch.status,
      createdAt: batch.createdAt.toISOString(),
      appliedAt: batch.appliedAt?.toISOString() ?? null,
      counts: toCounts(rows),
    };
  }

  function toRowDto(row: ImportRowRecord): ImportRow {
    return {
      id: row.id,
      rowIndex: row.rowIndex,
      raw: row.raw,
      kind: row.kind,
      flag: row.flag,
      message: row.message,
      executedAt: row.executedAt?.toISOString() ?? null,
      isin: row.isin,
      symbol: row.symbol,
      name: row.name,
      quantity: row.quantity,
      price: row.price,
      fee: row.fee,
      amountEur: row.amountEur,
      currency: row.currency,
      note: row.note,
      asset: row.asset,
      result: row.result,
      resultMessage: row.resultMessage,
    };
  }

  async function buildPreview(batch: ImportBatchRow): Promise<ImportPreviewResponse> {
    const rows = await importRepo.listRows(batch.id);
    return { batch: toBatchDto(batch, rows), rows: rows.map(toRowDto) };
  }

  return {
    listBrokers() {
      return { brokers: registry.list() };
    },

    async createBatch(userId, input) {
      await requireOwnedPortfolio(userId, input.portfolioId);

      const csv = parseCsv(input.content);
      if (!csv.header || csv.records.length === 0) {
        throw badRequest('The file contains no data rows.', 'IMPORT_EMPTY');
      }
      if (csv.records.length > IMPORT_MAX_ROWS) {
        throw badRequest(
          `The file has more than ${IMPORT_MAX_ROWS} rows — split it and import in parts.`,
          'IMPORT_TOO_MANY_ROWS',
        );
      }

      let mapper: BrokerMapper | null;
      if (input.brokerId !== undefined) {
        mapper = registry.byId(input.brokerId);
        if (!mapper) throw badRequest('Unknown broker.', 'IMPORT_BROKER_UNKNOWN');
      } else {
        mapper = registry.detect(csv);
        if (!mapper) {
          throw badRequest(
            'This file does not match any supported broker export — pick the broker manually.',
            'IMPORT_BROKER_UNRECOGNIZED',
          );
        }
      }

      const mapped = mapper.map(csv).map(guardStagedRow);

      // Resolve each distinct instrument identity once (files repeat them a lot).
      const resolutions = new Map<string, SearchResultItem | null>();
      for (const line of mapped) {
        if (!line.ok || !needsInstrument(line.row.kind)) continue;
        const key = rawInstrumentKey(line.row);
        if (key === null || resolutions.has(key)) continue;
        resolutions.set(key, await resolveInstrument(userId, line.row));
      }

      const existing = await collectExistingHashes(userId, input.portfolioId);
      const seenInFile = new Set<string>();

      const staged: StageImportRowInput[] = mapped.map((line) => {
        if (!line.ok) {
          return {
            rowIndex: line.line,
            raw: line.raw,
            kind: null,
            flag: 'error',
            message: line.error,
            executedAt: null,
            isin: null,
            symbol: null,
            name: null,
            quantity: null,
            price: null,
            fee: null,
            amountEur: null,
            currency: null,
            note: null,
            assetId: null,
            contentHash: null,
          };
        }

        const row = line.row;
        const rawKey = rawInstrumentKey(row);
        const asset =
          needsInstrument(row.kind) && rawKey ? (resolutions.get(rawKey) ?? null) : null;

        let flag: StageImportRowInput['flag'] = 'mapped';
        let message: string | null = null;
        if (needsInstrument(row.kind) && !asset) {
          flag = 'unmapped';
          const identity = row.isin ?? row.symbol ?? row.name ?? '(unknown)';
          message =
            `Instrument "${identity}" was not found in the asset catalog — ` +
            'search for it under Assets first, then re-upload.';
        } else if ((row.kind === 'buy' || row.kind === 'sell') && asset) {
          if (asset.currency !== row.currency) {
            flag = 'error';
            message =
              `Resolved "${asset.symbol}" is quoted in ${asset.currency} but the row is ` +
              `${row.currency} — resolve via the ${row.currency} listing instead.`;
          }
        }

        const hash = contentHash({
          kind: row.kind,
          executedAt: row.executedAt,
          instrument: asset ? asset.id : rawKey,
          quantity: row.quantity,
          price: row.price,
          amountEur: row.amountEur,
        });
        if (flag === 'mapped') {
          if (existing.has(hash) || seenInFile.has(hash)) {
            flag = 'duplicate';
            message = 'An identical row (same date, instrument, quantity, price) already exists.';
          }
          seenInFile.add(hash);
        }

        return {
          rowIndex: line.line,
          raw: line.raw,
          kind: row.kind,
          flag,
          message,
          executedAt: row.executedAt,
          isin: row.isin,
          symbol: row.symbol,
          name: row.name,
          quantity: row.quantity,
          price: row.price,
          fee: row.fee,
          amountEur: row.amountEur,
          currency: row.currency,
          note: row.note,
          assetId: asset?.id ?? null,
          contentHash: hash,
        };
      });

      const batch = await importRepo.createBatch(
        {
          ownerId: userId,
          portfolioId: input.portfolioId,
          brokerId: mapper.id,
          filename: input.filename,
        },
        staged,
      );
      return buildPreview(batch);
    },

    async getBatch(userId, batchId) {
      const batch = await importRepo.findBatchForOwner(userId, batchId);
      if (!batch) throw notFound('Import not found.', 'IMPORT_NOT_FOUND');
      return buildPreview(batch);
    },

    async applyBatch(userId, batchId, input) {
      const batch = await importRepo.findBatchForOwner(userId, batchId);
      if (!batch) throw notFound('Import not found.', 'IMPORT_NOT_FOUND');
      if (batch.status !== 'pending') {
        throw conflict('This import was already applied.', 'IMPORT_ALREADY_APPLIED');
      }

      // Fail fast on a bad cash source — otherwise every row would fail alike.
      const cashSourceId = input.cashSourceId ?? null;
      if (cashSourceId) {
        const source = await cashSourceRepo.findByIdForPortfolio(batch.portfolioId, cashSourceId);
        if (!source || source.archivedAt) {
          throw badRequest('Cash source not found.', 'CASH_SOURCE_NOT_FOUND');
        }
      }
      const linkCash = input.linkCashOnTrades === true;
      // Source tag (V5-P0c): every row this apply writes is stamped
      // `import:<broker>` so imported data can never be confused with
      // hand-entered `manual` rows. Server-assigned, per the batch's mapper.
      const source = importSourceTag(batch.brokerId);

      // Claim the batch atomically (pending → applied) BEFORE any row books:
      // two concurrent applies would both pass the read-check above and each
      // run the full row loop — double-booking every trade/dividend/cash row.
      // The compare-and-set picks exactly one winner; the loser is a 409, same
      // as a sequential second apply. (Claim-first means a crash mid-loop
      // leaves the batch `applied` with partial row results — the conservative
      // side: a retry can re-upload, but can never book money twice.)
      const claimed = await importRepo.claimPendingBatch(batch.id, cashSourceId);
      if (!claimed) {
        throw conflict('This import was already applied.', 'IMPORT_ALREADY_APPLIED');
      }

      const rows = await importRepo.listRows(batch.id);
      // Duplicate truth is re-derived NOW (preview flags could be stale against
      // writes that happened since the upload).
      const existing = await collectExistingHashes(userId, batch.portfolioId);
      const appliedThisRun = new Set<string>();

      // Chronological apply so moving-average cost/tax replays see buys before
      // the sells they cover. Within a day: cash income in, then trades in file
      // order, then withdrawals — a linked buy can spend a same-day deposit.
      const dayPriority: Record<NonNullable<ImportRowRecord['kind']>, number> = {
        deposit: 0,
        dividend: 1,
        buy: 2,
        sell: 2,
        withdrawal: 3,
      };
      const ordered = [...rows].sort((a, b) => {
        const at = a.executedAt?.getTime() ?? 0;
        const bt = b.executedAt?.getTime() ?? 0;
        if (at !== bt) return at - bt;
        const ap = a.kind ? dayPriority[a.kind] : 0;
        const bp = b.kind ? dayPriority[b.kind] : 0;
        if (ap !== bp) return ap - bp;
        return a.rowIndex - b.rowIndex;
      });

      const updates: Array<{
        id: string;
        result: ImportRowResult;
        resultMessage: string | null;
        flag?: ImportRowRecord['flag'];
      }> = [];
      const outcomeByRowId = new Map<string, ImportRowOutcome>();

      const record = (
        row: ImportRowRecord,
        result: ImportRowResult,
        message: string | null,
        flag?: ImportRowRecord['flag'],
      ) => {
        updates.push({ id: row.id, result, resultMessage: message, flag });
        outcomeByRowId.set(row.id, {
          id: row.id,
          rowIndex: row.rowIndex,
          kind: row.kind,
          result,
          message,
        });
      };

      const applyRow = async (row: ImportRowRecord): Promise<void> => {
        const executedAt = row.executedAt?.toISOString();
        if (!executedAt) throw badRequest('Row has no date.', 'IMPORT_ROW_INVALID');
        if (row.kind === 'buy' || row.kind === 'sell') {
          if (!row.assetId || row.quantity === null || row.price === null) {
            throw badRequest('Row is missing trade fields.', 'IMPORT_ROW_INVALID');
          }
          const tx: TransactionInput = {
            assetId: row.assetId,
            side: row.kind,
            quantity: row.quantity,
            price: row.price,
            fee: row.fee ?? 0,
            executedAt,
            note: row.note,
            ...(linkCash && row.kind === 'buy' ? { payFromCash: true } : {}),
            ...(linkCash && row.kind === 'sell' ? { addProceedsToCash: true } : {}),
            ...(linkCash && cashSourceId ? { cashSourceId } : {}),
          };
          await portfolio.createTransactions(userId, batch.portfolioId, [tx], { source });
          return;
        }
        if (row.kind === 'dividend') {
          if (!row.assetId || row.amountEur === null) {
            throw badRequest('Row is missing dividend fields.', 'IMPORT_ROW_INVALID');
          }
          await tax.recordDividend(
            userId,
            batch.portfolioId,
            {
              assetId: row.assetId,
              grossAmountEur: row.amountEur,
              executedAt,
              ...(cashSourceId ? { cashSourceId } : {}),
              note: row.note,
            },
            { source },
          );
          return;
        }
        if (row.amountEur === null) {
          throw badRequest('Row is missing the cash amount.', 'IMPORT_ROW_INVALID');
        }
        const entry = {
          amountEur: row.amountEur,
          ...(cashSourceId ? { sourceId: cashSourceId } : {}),
          executedAt,
          note: row.note,
        };
        if (row.kind === 'deposit') {
          await portfolio.depositCash(userId, batch.portfolioId, entry, { source });
        } else {
          await portfolio.withdrawCash(userId, batch.portfolioId, entry, { source });
        }
      };

      for (const row of ordered) {
        if (row.flag === 'error') {
          record(row, 'skipped_error', row.message);
          continue;
        }
        if (row.flag === 'unmapped') {
          record(row, 'skipped_unmapped', row.message);
          continue;
        }
        if (row.flag === 'duplicate') {
          record(row, 'skipped_duplicate', row.message);
          continue;
        }
        if (
          row.contentHash &&
          (existing.has(row.contentHash) || appliedThisRun.has(row.contentHash))
        ) {
          record(
            row,
            'skipped_duplicate',
            'An identical row was recorded since this preview was created.',
            'duplicate',
          );
          continue;
        }

        try {
          await applyRow(row);
          if (row.contentHash) appliedThisRun.add(row.contentHash);
          record(row, 'applied', null);
        } catch (err) {
          if (err instanceof ApiError) {
            record(row, 'failed', err.message);
            continue;
          }
          throw err;
        }
      }

      await importRepo.setRowResults(updates);

      const finalBatch = await importRepo.findBatchForOwner(userId, batchId);
      const finalRows = await importRepo.listRows(batch.id);
      const outcomes = finalRows
        .map((r) => outcomeByRowId.get(r.id))
        .filter((o): o is ImportRowOutcome => o !== undefined);
      let applied = 0;
      let skipped = 0;
      let failed = 0;
      for (const o of outcomes) {
        if (o.result === 'applied') applied += 1;
        else if (o.result === 'failed') failed += 1;
        else skipped += 1;
      }
      return {
        batch: toBatchDto(finalBatch ?? claimed, finalRows),
        applied,
        skipped,
        failed,
        rows: outcomes,
      };
    },

    async discardBatch(userId, batchId) {
      const deleted = await importRepo.deleteBatchForOwner(userId, batchId);
      if (!deleted) throw notFound('Import not found.', 'IMPORT_NOT_FOUND');
    },
  };
}
