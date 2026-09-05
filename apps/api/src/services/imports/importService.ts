import type {
  ApplyImportRequest,
  ApplyImportResponse,
  ImportBatch,
  ImportBatchCounts,
  ImportBrokerListResponse,
  ImportPreviewResponse,
  ImportRow,
  ImportRowCandidate,
  ImportRowKind,
  ImportRowOutcome,
  ImportRowResult,
  ImportUnderstanding,
  ResolveImportRowRequest,
  SearchResultItem,
  TransactionInput,
} from '@bettertrack/contracts';
import {
  CASH_TAGS_PER_ITEM_MAX,
  IMPORT_MAX_DISTINCT_INSTRUMENTS,
  IMPORT_MAX_ROWS,
  IMPORT_ROW_CANDIDATE_EXCHANGE_MAX,
  IMPORT_ROW_CANDIDATE_LIMIT,
  IMPORT_ROW_CANDIDATE_NAME_MAX,
  IMPORT_ROW_CANDIDATE_SYMBOL_MAX,
  importSourceTag,
} from '@bettertrack/contracts';

import { ApiError, badRequest, conflict, notFound } from '../../errors';
import type {
  ImportRepository,
  ImportRowRecord,
  StageImportRowInput,
} from '../../data/repositories/importRepository';
import type { CashSourceRepository } from '../../data/repositories/cashSourceRepository';
import type { CashRuleRepository } from '../../data/repositories/cashRuleRepository';
import type { CashTagRepository } from '../../data/repositories/cashTagRepository';
import { tagsByRules, type EvaluableCashRule } from '../cash/cashRuleEngine';
import type { PortfolioRepository } from '../../data/repositories/portfolioRepository';
import type { TransactionRepository } from '../../data/repositories/transactionRepository';
import type { Logger } from '../../logger';
import type { ParanoidModeGuard } from '../account/paranoidEnforcement';
import type { ProblemService } from '../observability/problemService';
import { createRequestQueue, type RequestQueue } from '../../providers/requestQueue';
import type { PortfolioService } from '../portfolio/portfolioService';
import type { SearchService } from '../search/searchService';
import type { TaxService } from '../tax/taxService';
import { contentHash } from './contentHash';
import { parseCsv } from './csv';
import { createMapperRegistry } from './registry';
import { UnmappableTableError } from './columnMapping';
import type { HeaderMappingAiContext } from './columnMapping';
import { derivableKinds, deriveRowForKind, type DerivationContext } from './kindDerivation';
import type { ClassifyContext } from './rowClassifier';
import { UnsupportedFileFormatError } from './table';
import { stageGenericFile } from './genericStaging';
import type { ImportBatchRow } from '../../data/schema';
import type { BrokerMapper, MappedLine, NormalizedImportRow, PendingKindFields } from './types';

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
  /**
   * The caller's own cash rules, for pre-tagging staged cash rows (#964).
   * `listForOwner` already returns them in evaluation order (priority, then
   * age, then id), which is the order `tagsByRules` walks — the ordering
   * decision stays in the repository, exactly one place.
   */
  cashRuleRepo: Pick<CashRuleRepository, 'listForOwner'>;
  /**
   * Attaches a previewed tag to the movement an applied cash row booked (#964).
   * REQUIRED rather than optional: a silently unwired dependency would turn
   * "the preview showed a tag" into "the tag quietly never arrived", which is
   * the exact drift this slice exists to remove.
   */
  cashTagRepo: Pick<CashTagRepository, 'attachTagWithinPortfolio'>;
  search: SearchService;
  portfolio: PortfolioService;
  tax: TaxService;
  mappers: readonly BrokerMapper[];
  logger?: Logger;
  /**
   * The problems fold behind the admin cockpit (§13.5 V5-P2 arc (d)).
   *
   * Apply catches EVERY per-row failure so one bad row can never strand a
   * claimed batch — which would quietly turn a programming bug into a row that
   * merely "failed". This is where such a fault stays loud: an unexpected error
   * is captured with the batch/row ids, scrubbed and folded by the service
   * itself. Optional, because a caller without observability wiring must still
   * be able to import; absent, the failure is still reported on the row and
   * logged.
   */
  problems?: Pick<ProblemService, 'captureError'>;
  paranoid?: Pick<ParanoidModeGuard, 'assertAllowed'>;
  /**
   * Shared process-local budget for import-driven catalog/provider resolution.
   * Tests may inject a recording queue; production admits four concurrent
   * resolution chains so one slow import cannot block every other user.
   */
  resolutionQueue?: RequestQueue;
  /**
   * Per-user AI seams for the GENERIC staging path (#964), both OPTIONAL by
   * design and both returning `undefined` when the tier is unconfigured,
   * disabled, over cap, or refused.
   *
   * A factory rather than a bound seam because both binders take the calling
   * user's id (their daily cap, their audit trail), and because
   * `bindHeavyTierAi` deliberately THROWS under a test runner — the wiring
   * catches that and degrades, so no test can reach a real heavy model and no
   * deployment without an AI provider loses the ability to import.
   *
   * When both are absent the generic path is the fully deterministic pipeline:
   * headers the dictionary cannot name stay unnamed, ambiguous rows stay
   * flagged for review, and the user maps what is left by hand. That is the
   * documented degraded mode, not an error state.
   */
  headerAi?: (userId: string) => HeaderMappingAiContext['ai'] | undefined;
  rowAi?: (userId: string) => ClassifyContext['ai'] | undefined;
}

/**
 * The broker id a GENERIC batch is stamped with (#964). It is a mapper id
 * shaped like any other — `broker_id` is deliberately free text (§13.4), the
 * source tag `import:generic` satisfies `sourceTagSchema`, and the picker lists
 * it beside the hand-written mappers so a user can force this path for a file
 * a mapper would otherwise claim.
 */
export const GENERIC_BROKER_ID = 'generic';
export const GENERIC_BROKER_LABEL = 'Work it out from the file';

export interface CreateImportBatchInput {
  portfolioId: string;
  filename: string;
  /** Decoded file text (the route reads the multipart buffer as UTF-8). */
  content: string;
  /**
   * The upload's RAW bytes, for the generic path only (#964).
   *
   * The broker mappers keep consuming `content` exactly as before. The generic
   * path needs the bytes because its sniffer detects the encoding itself —
   * UTF-16LE and windows-1252 statements are common, and a string already
   * decoded as UTF-8 has lost the evidence (and mangled the umlauts a German
   * memo needs for keyword classification). Optional so every existing caller
   * and test is unchanged; absent, the generic path re-encodes `content`.
   */
  contentBytes?: Uint8Array;
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
  /**
   * Finish ONE staged row a person had to decide about: pin the instrument the
   * pipeline could not resolve (`assetId`, #964 directive point 4), or confirm
   * the kind it would not guess (`kind`, §16 2026-08-29 gap (b)) — exactly one
   * per call. Owner-scoped; the batch must still be `pending`. Returns the
   * refreshed preview so the client never has to guess what the change did to
   * the counts.
   */
  resolveRow(
    userId: string,
    batchId: string,
    rowId: string,
    input: ResolveImportRowRequest,
  ): Promise<ImportPreviewResponse>;
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
 * The two verdicts a resolved (or unresolved) instrument produces, written once
 * so staging and a later kind confirmation cannot describe the same state in
 * two different ways.
 */
function unresolvedInstrumentMessage(row: NormalizedImportRow): string {
  const identity = row.isin ?? row.symbol ?? row.name ?? '(unknown)';
  return (
    `Instrument "${identity}" was not found in the asset catalog — ` +
    'search for it under Assets first, then re-upload.'
  );
}

function currencyMismatchMessage(asset: SearchResultItem, row: NormalizedImportRow): string {
  return (
    `Resolved "${asset.symbol}" is quoted in ${asset.currency} but the row is ` +
    `${row.currency} — resolve via the ${row.currency} listing instead.`
  );
}

/** The duplicate verdict's wording, shared by staging, pinning and confirming. */
const DUPLICATE_MESSAGE =
  'An identical row (same date, instrument, quantity, price) already exists.';

/**
 * The same verdict for a CASH row, which has none of instrument, quantity or
 * price — it is compared on what it actually has, and says so. Telling someone
 * that a deposit matched on "instrument, quantity, price" sends them looking
 * for columns their bank statement does not contain.
 */
const CASH_DUPLICATE_MESSAGE =
  'An identical cash movement (same date, direction, amount and memo) already exists.';

function duplicateMessageFor(kind: NormalizedImportRow['kind']): string {
  return kind === 'deposit' || kind === 'withdrawal' ? CASH_DUPLICATE_MESSAGE : DUPLICATE_MESSAGE;
}

/**
 * How many entities the portfolio already holds per content hash. Cash needs
 * the count (see {@link collectExistingHashes}); every other kind reads it as
 * membership.
 */
type HashCounts = Map<string, number>;

const countOf = (counts: HashCounts, hash: string): number => counts.get(hash) ?? 0;

/**
 * How long the single-row paths may reuse one batch's ledger hashes. Long
 * enough that a bulk sweep (one PATCH per row) reads the ledger once, short
 * enough that a preview left open goes back to live data — and it decides
 * nothing on its own, because apply always re-derives (see
 * `existingHashesForBatch`).
 */
export const IMPORT_HASH_CACHE_TTL_MS = 30_000;

/** Bound on the memo — a batch × scope entry per open wizard, no more. */
const HASH_CACHE_MAX_ENTRIES = 64;

/**
 * One import may wait this long in total for background provider enrichment.
 * Local catalog reads do not spend this budget.
 */
export const IMPORT_ENRICHMENT_WAIT_BUDGET_MS = 5_000;

/**
 * Hard admission ceiling for provider-backed search queries from one import.
 * Sixteen fits inside the provider queue's five-second spacing window while
 * staying far below the 150-instrument file cap. A query may coalesce or hit a
 * provider cache, but it still spends one slot because it could start upstream
 * work.
 *
 * The INTERACTIVE half of this same decision is `BT_SEARCH_ENRICHMENT_BUDGET`
 * (`config/env.ts`, applied in `services/search/enrichmentBudget.ts`, #1709):
 * distinct enrichment queries per user per window, with the identical
 * "coalesced still spends a slot" rule. Both exist because one enrichment
 * writes into the shared global catalog and enqueues a backfill per new row;
 * the two budgets differ only in the unit that gets a ceiling — one import
 * versus one user-minute.
 */
export const IMPORT_ENRICHMENT_QUERY_BUDGET = 16;

interface EnrichmentBudget {
  remainingWaitMs: number;
  remainingQueries: number;
}

interface InstrumentIdentity {
  isin: string | null;
  symbol: string | null;
  name: string | null;
}

interface InstrumentLookupAttempt {
  query: string;
  matches(result: SearchResultItem): boolean;
}

function instrumentLookupAttempts(key: InstrumentIdentity): InstrumentLookupAttempt[] {
  const attempts: InstrumentLookupAttempt[] = [];
  if (key.symbol) {
    const wanted = key.symbol.toUpperCase();
    attempts.push({
      query: key.symbol,
      matches: (result) => result.symbol.toUpperCase() === wanted,
    });
  }
  if (key.isin) {
    const wanted = key.isin.toUpperCase();
    attempts.push({ query: key.isin, matches: (result) => result.symbol.toUpperCase() === wanted });
  }
  if (key.name) {
    const wanted = normalizeName(key.name);
    attempts.push({ query: key.name, matches: (result) => normalizeName(result.name) === wanted });
  }
  return attempts;
}

/**
 * Near-matches for ONE unresolved identity (§13.4): the ranked hits the search
 * already returned while looking for an exact identity match. Captured at zero
 * extra cost — no additional query is spent and the enrichment budgets are
 * untouched — and surfaced on the preview row as display-only suggestions.
 * A candidate NEVER resolves a row: it cannot flip `unmapped` to `mapped` and
 * can never reach the apply path.
 *
 * One LANE per lookup attempt, keyed by the attempt's query string (stable
 * across every phase that re-runs that attempt: local pass, enrichment
 * immediate + post-settle, pre-admission re-check, phase-3 sweep). Lanes are
 * kept apart rather than merged because the finalizer interleaves them — see
 * {@link finalizeCandidates}. Each lane is an insertion-ordered map of
 * UPPERCASE symbol -> already-projected candidate, so a lane is internally
 * de-duplicated and holds the search's own rank order.
 */
type CandidateSink = Map<string, Map<string, ImportRowCandidate>>;

/**
 * Project a search hit down to the display fields, truncating the three
 * provider-fed strings to their contract bounds.
 *
 * Truncation happens HERE, at capture, and not as schema rejection: a
 * pathologically long provider `name` is a cosmetic problem, and rejecting the
 * candidate over it would delete the whole row's suggestion list — punishing
 * the user for the provider's data. A clipped name still identifies the
 * instrument. Without this, one 5 MB provider name would be persisted into as
 * many staged row copies as reference that identity.
 */
function toCandidate(item: SearchResultItem): ImportRowCandidate {
  return {
    id: item.id,
    symbol: item.symbol.slice(0, IMPORT_ROW_CANDIDATE_SYMBOL_MAX),
    name: item.name.slice(0, IMPORT_ROW_CANDIDATE_NAME_MAX),
    currency: item.currency,
    exchange:
      item.exchange === null ? null : item.exchange.slice(0, IMPORT_ROW_CANDIDATE_EXCHANGE_MAX),
    type: item.type,
  };
}

/**
 * Fold one attempt's result set into that attempt's lane.
 *
 * The lane stops at {@link IMPORT_ROW_CANDIDATE_LIMIT} distinct symbols, and
 * that bound is EXACT, not an approximation: the finalizer's round-robin can
 * never read rank >= LIMIT from any lane. To reach rank LIMIT in a lane, each
 * of that lane's LIMIT earlier entries must have been either picked or skipped
 * as a duplicate of something already picked elsewhere — and because a lane is
 * internally de-duplicated, those LIMIT entries account for LIMIT distinct
 * picked symbols, which is the global cap. The loop has already stopped. So
 * retaining more can change nothing.
 *
 * Without the bound, a search returning the full catalog page for each of the
 * three attempts retained tens of thousands of `SearchResultItem`s per identity
 * to hand five of them to the UI.
 */
function captureCandidates(
  sink: CandidateSink,
  attemptQuery: string,
  results: readonly SearchResultItem[],
): void {
  let lane = sink.get(attemptQuery);
  if (!lane) {
    lane = new Map<string, ImportRowCandidate>();
    sink.set(attemptQuery, lane);
  }
  if (lane.size >= IMPORT_ROW_CANDIDATE_LIMIT) return;
  for (const item of results) {
    const dedupeKey = item.symbol.toUpperCase();
    if (lane.has(dedupeKey)) continue;
    lane.set(dedupeKey, toCandidate(item));
    if (lane.size >= IMPORT_ROW_CANDIDATE_LIMIT) return;
  }
}

/**
 * The row-facing suggestion list: {@link IMPORT_ROW_CANDIDATE_LIMIT} entries
 * INTERLEAVED across the lookup attempts — best hit of each attempt, then
 * second of each, and so on — de-duplicated by uppercase symbol, first
 * occurrence in that traversal winning.
 *
 * Round-robin rather than attempt-order concatenation because concatenation
 * STARVES the later attempts: the symbol attempt runs first, and whenever it
 * returns five or more hits it consumed the entire cap, so the ISIN and name
 * attempts contributed nothing. For a row that failed to resolve, the name
 * attempt is frequently the one carrying the suggestion a human actually wants
 * ("Muster Tech AG Inhaber" resolves against nothing, but its name search finds
 * "Muster Tech AG") — and that suggestion was being dropped for a fifth
 * mediocre symbol hit. Interleaving ranks by within-attempt rank first, so an
 * attempt's top hit always outranks another attempt's second.
 *
 * No score is invented — nothing here was measured; the order is the searches'
 * own. Null when nothing usable was seen (the contract field stays absent
 * rather than an empty array).
 */
function finalizeCandidates(sink: CandidateSink): ImportRowCandidate[] | null {
  const lanes = [...sink.values()].map((lane) => [...lane]);
  const deepest = lanes.reduce((max, lane) => Math.max(max, lane.length), 0);
  const picked: ImportRowCandidate[] = [];
  const seen = new Set<string>();
  for (let rank = 0; rank < deepest; rank += 1) {
    for (const lane of lanes) {
      if (picked.length >= IMPORT_ROW_CANDIDATE_LIMIT) return picked;
      const entry = lane[rank];
      if (!entry) continue;
      const [dedupeKey, candidate] = entry;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      picked.push(candidate);
    }
  }
  return picked.length > 0 ? picked : null;
}

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

/** What every constrained `import_rows` column is asked to hold for one row. */
interface StagedColumnValues {
  currency: string;
  quantity: number | null;
  price: number | null;
  fee: number | null;
  amountEur: number | null;
}

function stagingViolation(row: StagedColumnValues): string | null {
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

/**
 * The staging boundary, for BOTH kinds of line that carry values.
 *
 * The retained fields of an undecided row (§16 2026-08-29) go into the very
 * same constrained columns as a normalized row's, in the very same single
 * INSERT — so they need the very same guard. Without it, retaining values that
 * used to be written as nulls would have re-opened exactly the hole this
 * function closes: one 13-integer-digit quantity on one unclassifiable line
 * killing every valid row of the upload with it.
 *
 * A retained payload that violates a column DEGRADES to a plain reported error
 * rather than failing the line's neighbours: the row is exactly what it was
 * before it could be confirmed — visible, explained, unbookable.
 */
function guardStagedRow(line: MappedLine): MappedLine {
  if (line.ok) {
    const violation = stagingViolation(line.row);
    if (violation === null) return line;
    return { line: line.line, raw: line.raw, ok: false, error: violation };
  }
  if (line.pending === undefined) return line;
  const violation = stagingViolation({ ...line.pending, amountEur: line.pending.amount });
  if (violation === null) return line;
  return { line: line.line, raw: line.raw, ok: false, error: `${line.error} (${violation})` };
}

/**
 * Bind an OPTIONAL AI seam, treating every failure as "not configured" (#964).
 *
 * `bindHeavyTierAi` throws by design under a test runner, a deployment may have
 * no AI provider at all, and a binder may refuse for a user over their cap.
 * All three mean the same thing to this subsystem — run deterministically — so
 * they collapse here rather than each becoming a failed upload. This is the
 * mechanism behind the standing rule that the heavy tier is optional and its
 * absence is a graceful degrade, not a 500.
 */
function safeSeam<T>(bind: () => T | undefined): T | undefined {
  try {
    return bind();
  } catch {
    return undefined;
  }
}

export function createImportService(deps: ImportServiceDeps): ImportService {
  const {
    importRepo,
    portfolioRepo,
    transactionRepo,
    cashSourceRepo,
    cashRuleRepo,
    cashTagRepo,
    search,
    portfolio,
    tax,
  } = deps;
  const registry = createMapperRegistry(deps.mappers);
  // One queue per service instance is shared by every concurrent import request.
  // Provider clients use the same RequestQueue primitive for their own outbound
  // concurrency/spacing/backoff policy; this outer queue caps concurrent
  // import-driven resolution chains and never retries business/search failures.
  const resolutionQueue =
    deps.resolutionQueue ?? createRequestQueue({ concurrency: 4, minSpacingMs: 0, maxRetries: 0 });
  /** Per-instance memo behind {@link existingHashesForBatch}; never read by apply. */
  const hashCache = new Map<string, { expiresAt: number; hashes: HashCounts }>();

  /**
   * The row kinds whose apply books an EXTERNAL cash movement directly, and
   * therefore the rows a cash rule is about.
   *
   * Deliberately NOT buy/sell/dividend. Those book a cash leg too, and the
   * book-time engine keeps tagging it exactly as it always has — but their leg
   * is a CONSEQUENCE of a trade rather than a statement line a user wrote a
   * merchant rule for, and the preview would be claiming a suggestion for a row
   * whose money movement it does not even display. Scope stays where the slice
   * is: the deposits and withdrawals a bank statement is made of.
   */
  function isCashRowKind(kind: NormalizedImportRow['kind'] | null): boolean {
    return kind === 'deposit' || kind === 'withdrawal';
  }

  /**
   * The caller's cash rules for ONE staging pass — loaded once for the whole
   * file, never per row.
   *
   * COST SHAPE. Evaluation is O(cash rows × rules) first-match comparisons over
   * short strings, on top of exactly ONE rules query per batch; regex patterns
   * compile once each (`cashRuleEngine` memoizes them) rather than once per
   * row, so a 5000-row file does not multiply into 5000 compilations per rule.
   * The early return keeps the whole thing free for the common file that
   * carries no cash memo at all — a rule that matches nothing costs one query
   * and a walk over a few hundred short strings, which is the same bargain
   * `applyCashRulesAtBookTime` already makes.
   */
  async function cashRulesForBatch(
    userId: string,
    mapped: readonly MappedLine[],
  ): Promise<Awaited<ReturnType<CashRuleRepository['listForOwner']>>> {
    const anyTaggableRow = mapped.some(
      (line) => line.ok && isCashRowKind(line.row.kind) && (line.row.note?.trim() ?? '') !== '',
    );
    if (!anyTaggableRow) return [];
    return cashRuleRepo.listForOwner(userId);
  }

  /**
   * The rule tags to STAGE for one normalized row, or null when it earns none.
   *
   * THE NOTE IS TRIMMED BEFORE MATCHING, because that is exactly what the
   * book-time path does (`applyCashRuleTags` trims, treats a whitespace-only
   * note as no note, and hands the trimmed string to the engine). A `regex`
   * rule tests the string it is given verbatim, so previewing on the untrimmed
   * memo while booking on the trimmed one would be a drift source hiding in
   * plain sight — the two paths must feed the engine the same input.
   *
   * Today it is belt-and-braces rather than a live fix: `parseCsv` already
   * trims every cell, so a CSV-derived note reaches here with nothing to trim.
   * It is written anyway because the parity is the point — this function must
   * not be the reason the two paths disagree if a future staging source (the
   * wizard's `rowClassifier`, a pasted table) stops pre-trimming.
   *
   * The stored NOTE keeps its original spacing; only the matching input is
   * trimmed, again mirroring book time.
   */
  function stagedRuleTags(
    row: NormalizedImportRow,
    flag: StageImportRowInput['flag'],
    rules: readonly EvaluableCashRule[],
  ): string[] | null {
    // Only rows that will actually import: a duplicate / unmapped / error row
    // books nothing, so promising it a tag would promise something apply is
    // never going to do.
    if (flag !== 'mapped' || !isCashRowKind(row.kind)) return null;
    const note = row.note?.trim() ?? '';
    if (note === '') return null;
    const tags = tagsByRules(note, rules);
    if (tags.length === 0) return null;
    // Bound what a stored rule can put on the wire. No API path can build a
    // rule with more than `CASH_TAGS_PER_ITEM_MAX` tags, but this file follows
    // `cashRuleEngine`'s own stance that rows persisted before (or beside)
    // write-time validation are not trusted — and here an over-long list would
    // fail the row's `.max()` in the response contract, taking the whole
    // preview down with it on a strict client.
    return tags.slice(0, CASH_TAGS_PER_ITEM_MAX);
  }

  /**
   * Re-attach the tags the PREVIEW promised for a row, onto the movement it
   * just booked (#964).
   *
   * REPLAY, NOT RE-EVALUATION — this is the whole no-drift guarantee. The
   * book-time engine also runs on this insert and evaluates whatever the rules
   * say NOW; if that were the only thing tagging the movement, a rule edited or
   * deleted between preview and apply would silently drop a tag the user had
   * already confirmed. Writing the previewed ids back makes the preview
   * binding: every tag the user saw lands, whatever happened to the rule since.
   *
   * IDEMPOTENCY KEY: `UNIQUE(movement_id, tag_id)` inside
   * `attachTagWithinPortfolio` — in the ordinary case (rules unchanged) the
   * book-time stamp already wrote these exact pairs and every replay here is a
   * no-op, so the two paths converge instead of duplicating.
   *
   * NEVER FAILS THE ROW. The money is booked by the time this runs, and the
   * batch is already claimed, so throwing would report a `failed` row whose
   * cash is nonetheless in the ledger — a worse lie than a missing label. Same
   * rule `stampMovementTags` follows, for the same reason.
   *
   * ── THE TWO CELLS WHERE PREVIEW AND BOOKING STILL DIVERGE ─────────────────
   *
   * "Every previewed tag lands" holds everywhere except here, and both cells
   * are accepted trade-offs rather than oversights:
   *
   *  1. THE TAG ITSELF IS DELETED between preview and apply. The id no longer
   *     names anything, the INSERT's `cash_tags` join matches nothing, and the
   *     movement books WITHOUT the label the preview showed. The row still
   *     reports `applied` — see NEVER FAILS THE ROW above. Nothing else can be
   *     done: re-creating a tag the user deleted would be worse than omitting
   *     it. Pinned by `importRuleTagging.test.ts`.
   *
   *  2. A RULE IS ADDED between preview and apply. The book-time stamp still
   *     runs on this insert and evaluates the rules as they are NOW, so the
   *     movement ends up with the previewed set PLUS whatever the new rule
   *     assigns. If the new rule outranks the previewed one by priority, that
   *     is a UNION across two rules — strictly beyond the first-match-wins
   *     doctrine `cashRuleEngine` documents, and the sharpest form of this
   *     cell. Accepted: tagging is additive-never-subtractive subsystem-wide,
   *     every previewed tag still lands, and suppressing book time for import
   *     bookings would mean punching a bypass through the very seam
   *     `cashSystemTagStamp` exists to prevent.
   *
   * ── WHY A MISS IS SILENT ──────────────────────────────────────────────────
   *
   * `attachTagWithinPortfolio` reports a miss by RETURNING `false`, and the
   * return is deliberately discarded. Under `ON CONFLICT DO NOTHING …
   * RETURNING`, `false` means "no row was inserted" — which covers the miss
   * (cell 1 above, or a guard refusal) AND the entirely normal case that the
   * book-time stamp already wrote this exact pair moments earlier. In the
   * ordinary run, with rules unchanged, `false` is what EVERY call returns.
   *
   * Distinguishing the two would take a `SELECT` per tag per row on the common
   * path — a 5000-row statement under a three-tag rule is 15 000 extra
   * round-trips — to emit a log line that is empty essentially always. Not
   * worth it: the one case worth reporting is already visible to the user (the
   * movement they just imported lacks the label the preview showed) and is
   * pinned by a test. A thrown error is a different thing entirely and IS
   * logged, below.
   */
  async function replayRuleTags(
    portfolioId: string,
    movementId: string,
    tagIds: readonly string[] | null,
  ): Promise<void> {
    if (!tagIds || tagIds.length === 0) return;
    for (const tagId of tagIds) {
      try {
        // Return value intentionally unused — see WHY A MISS IS SILENT above.
        await cashTagRepo.attachTagWithinPortfolio(portfolioId, movementId, tagId);
      } catch (err) {
        deps.logger?.warn?.(
          { err, portfolioId, movementId, tagId },
          'import: previewed cash-rule tag could not be replayed onto the booked movement',
        );
      }
    }
  }

  async function requireOwnedPortfolio(userId: string, portfolioId: string): Promise<void> {
    const owned = await portfolioRepo.findByIdForUser(userId, portfolioId);
    if (!owned) throw notFound('Portfolio not found.', 'PORTFOLIO_NOT_FOUND');
  }

  /**
   * Autodetect over the CSV front end, tolerating a file it cannot parse.
   * `parseCsv` is the mappers' reader and assumes a comma/semicolon text table;
   * a UTF-16 or otherwise exotic export throwing here must fall through to the
   * generic sniffer rather than fail the upload, because the sniffer is exactly
   * the thing that can read it.
   */
  function tryDetect(content: string): BrokerMapper | null {
    try {
      const csv = parseCsv(content);
      if (!csv.header || csv.records.length === 0) return null;
      return registry.detect(csv);
    } catch {
      return null;
    }
  }

  /**
   * Resolve an identity only from Postgres; this path can never start provider
   * work. When `candidates` is given, every non-matching hit of each attempt's
   * result set is kept for the unresolved-row suggestions — the results were
   * already fetched, so this reads nothing extra.
   */
  async function resolveInstrumentLocally(
    userId: string,
    key: InstrumentIdentity,
    candidates?: CandidateSink,
  ): Promise<SearchResultItem | null> {
    for (const attempt of instrumentLookupAttempts(key)) {
      const result = await search.search(userId, attempt.query, { allowEnrichment: false });
      if (candidates) captureCandidates(candidates, attempt.query, result.results);
      const hit = result.results.find(attempt.matches);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * Admit provider enrichment for one unresolved identity under both per-batch
   * ceilings. The query slot is spent before search because that call may launch
   * fire-and-forget provider work. A settled retry is catalog-only, so neither
   * retries nor exhausted imports can silently enqueue more upstream searches.
   * Candidate capture rides on the results each attempt already receives (the
   * immediate set and the post-settle refresh) — no extra slot, ever.
   */
  async function enrichInstrument(
    userId: string,
    key: InstrumentIdentity,
    budget: EnrichmentBudget,
    candidates?: CandidateSink,
  ): Promise<SearchResultItem | null> {
    for (const attempt of instrumentLookupAttempts(key)) {
      if (budget.remainingQueries <= 0 || budget.remainingWaitMs <= 0) return null;

      budget.remainingQueries -= 1;
      // `budgetedByCaller`: the slot just spent above IS the ceiling for this
      // fan-out (#1709), so the per-user interactive budget must not charge it
      // a second time and leave an import's instruments unresolved.
      const result = await search.search(userId, attempt.query, { budgetedByCaller: true });
      if (candidates) captureCandidates(candidates, attempt.query, result.results);
      const immediateHit = result.results.find(attempt.matches);
      if (immediateHit) return immediateHit;
      if (!result.enriching) continue;

      const waitMs = budget.remainingWaitMs;
      const startedAt = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([
        search.enrichmentSettled().then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), waitMs);
        }),
      ]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
      });
      budget.remainingWaitMs = Math.max(
        0,
        budget.remainingWaitMs - Math.max(0, Date.now() - startedAt),
      );
      if (!settled) {
        budget.remainingWaitMs = 0;
        return null;
      }

      const refreshed = await search.search(userId, attempt.query, { allowEnrichment: false });
      if (candidates) captureCandidates(candidates, attempt.query, refreshed.results);
      const hit = refreshed.results.find(attempt.matches);
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
   *
   * COUNTS, NOT MEMBERSHIP, and the difference only matters for cash. Two
   * identical lines on a bank statement (`Einzahlung ;;;; 100,00` twice) are two
   * real movements: a set says "seen it" and books one of them, so the ledger
   * ends €100 short. The map says the ledger holds N of that hash, the file
   * claims M, and only the first N of the M are duplicates. Trades and
   * dividends keep set semantics (`> 0`) — collapsing two same-day fills at the
   * same price is the intended §13.4 behaviour, pinned by its own test.
   */
  async function collectExistingHashes(
    userId: string,
    portfolioId: string,
    /**
     * Which hash FAMILY the caller can actually collide with (#964 follow-up).
     *
     * `contentHash` keys on the row's kind, so a `deposit` can never collide
     * with a transaction and a `buy` can never collide with a cash movement —
     * the families are disjoint by construction. `applyBatch` needs all three
     * because a batch holds every kind; a SINGLE row's re-check (a pin, a kind
     * confirmation) needs exactly one, and the other two are a full portfolio
     * scan spent to compare against hashes that cannot match.
     *
     * That mattered once the wizard's bulk sweep made this a per-row call: a
     * 50-row statement paid 50 × (every transaction + every dividend + the
     * whole paged cash ledger) to answer 50 questions about cash alone.
     */
    scope: 'all' | 'trade' | 'dividend' | 'cash' = 'all',
  ): Promise<HashCounts> {
    const hashes: HashCounts = new Map<string, number>();
    const count = (hash: string) => hashes.set(hash, (hashes.get(hash) ?? 0) + 1);
    const txs =
      scope === 'all' || scope === 'trade'
        ? await transactionRepo.listForPortfolio(portfolioId)
        : [];
    for (const tx of txs) {
      count(
        contentHash({
          kind: tx.side,
          executedAt: tx.executedAt,
          instrument: tx.assetId,
          quantity: tx.quantity,
          price: tx.price,
          amountEur: null,
          reference: null,
        }),
      );
    }
    const { dividends } =
      scope === 'all' || scope === 'dividend'
        ? await tax.listDividends(userId, portfolioId)
        : { dividends: [] };
    for (const d of dividends) {
      count(
        contentHash({
          kind: 'dividend',
          executedAt: new Date(d.executedAt),
          instrument: d.assetId,
          quantity: null,
          price: null,
          amountEur: d.grossAmountEur,
          reference: null,
        }),
      );
    }
    let cursor: string | undefined;
    let morePages = scope === 'all' || scope === 'cash';
    while (morePages) {
      const cash = await portfolio.getCashMovements(userId, portfolioId, { cursor, limit: 200 });
      for (const m of cash.movements) {
        if (m.kind !== 'deposit' && m.kind !== 'withdrawal') continue;
        count(
          contentHash({
            kind: m.kind,
            executedAt: new Date(m.executedAt),
            instrument: null,
            quantity: null,
            price: null,
            amountEur: Math.abs(m.amountEur),
            // The memo the booking carried into the ledger — the same string
            // `applyRow` passes as the movement's `note`, so a re-import of the
            // file that created this movement hashes onto it exactly.
            reference: m.note,
          }),
        );
      }
      cursor = cash.nextCursor ?? undefined;
      morePages = cursor != null;
    }
    return hashes;
  }

  /**
   * {@link collectExistingHashes} for the SINGLE-ROW paths (a pin, a kind
   * confirmation), memoized per batch + scope for {@link IMPORT_HASH_CACHE_TTL_MS}.
   *
   * The wizard's bulk affordance is one PATCH per row, and each PATCH re-read
   * the portfolio's entire cash ledger 200 movements at a time — a page walk
   * whose every page also costs balances, sources and the page's tag join. A
   * twelve-row sweep paid twelve of them to answer twelve questions about the
   * same unchanged ledger.
   *
   * STALENESS IS BOUNDED AND CANNOT COST MONEY. What this feeds is a PREVIEW
   * verdict: a movement recorded elsewhere inside the window makes a row look
   * mapped for a few seconds longer than it deserves. `applyBatch` re-derives
   * duplicate truth from live data with no cache at all and flips such a row to
   * `skipped_duplicate` before anything books, so the authority on what lands is
   * never the cached answer. The entry is dropped when the batch is discarded
   * or applied, and the map is bounded so an idle process cannot accumulate.
   */
  async function existingHashesForBatch(
    userId: string,
    batch: ImportBatchRow,
    scope: 'trade' | 'dividend' | 'cash',
  ): Promise<HashCounts> {
    const key = `${batch.id}:${scope}`;
    const now = Date.now();
    const hit = hashCache.get(key);
    if (hit && hit.expiresAt > now) return hit.hashes;
    const hashes = await collectExistingHashes(userId, batch.portfolioId, scope);
    // Oldest-first eviction: `Map` iterates in insertion order and a refreshed
    // entry is re-inserted below, so the entry dropped is the least recently
    // COMPUTED one.
    hashCache.delete(key);
    while (hashCache.size >= HASH_CACHE_MAX_ENTRIES) {
      const oldest = hashCache.keys().next();
      if (oldest.done) break;
      hashCache.delete(oldest.value);
    }
    hashCache.set(key, { expiresAt: now + IMPORT_HASH_CACHE_TTL_MS, hashes });
    return hashes;
  }

  /** Forget a batch's memoized ledger hashes (applied, or discarded). */
  function forgetBatchHashes(batchId: string): void {
    for (const scope of ['trade', 'dividend', 'cash'] as const) {
      hashCache.delete(`${batchId}:${scope}`);
    }
  }

  /** The one hash family a row of this kind could possibly duplicate. */
  function hashScopeFor(kind: NormalizedImportRow['kind']): 'trade' | 'dividend' | 'cash' {
    if (kind === 'buy' || kind === 'sell') return 'trade';
    return kind === 'dividend' ? 'dividend' : 'cash';
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
      brokerLabel:
        batch.brokerId === GENERIC_BROKER_ID
          ? GENERIC_BROKER_LABEL
          : (registry.byId(batch.brokerId)?.label ?? batch.brokerId),
      filename: batch.filename,
      status: batch.status,
      createdAt: batch.createdAt.toISOString(),
      appliedAt: batch.appliedAt?.toISOString() ?? null,
      counts: toCounts(rows),
    };
  }

  /**
   * The parsed fields of a row whose KIND is still open, or null when there are
   * none to derive from (§16 2026-08-29). A date and a currency are the two
   * things every derivation needs, so a row missing either is not confirmable —
   * defensive rather than expected: staging only marks a row undecided once it
   * has both.
   */
  function pendingFieldsOf(row: ImportRowRecord): PendingKindFields | null {
    if (!row.kindUndecided || row.executedAt === null || row.currency === null) return null;
    return {
      executedAt: row.executedAt,
      isin: row.isin,
      symbol: row.symbol,
      name: row.name,
      quantity: row.quantity,
      price: row.price,
      fee: row.fee,
      // Still SIGNED — a decided row's `amountEur` is a magnitude, an undecided
      // row's is the file's own statement of direction.
      amount: row.amountEur,
      currency: row.currency,
      note: row.note,
    };
  }

  /**
   * What the BATCH's own file is known to do, for the derivation. Absent
   * understanding means a broker mapper staged this batch, and a mapper emits
   * no undecided rows at all — so the value is unreachable rather than
   * defaulted-and-hoped-for.
   */
  function derivationContext(batch: ImportBatchRow): DerivationContext {
    return { amountsSigned: batch.understanding?.amountsSigned === true };
  }

  /**
   * The kinds this row would accept, by dry-running the SAME derivation a
   * confirmation runs. Empty for every decided row and for a row that carries
   * nothing bookable — so a client offering these is never offering a choice
   * the server will refuse.
   */
  function confirmableKindsFor(row: ImportRowRecord, context: DerivationContext): ImportRowKind[] {
    const fields = pendingFieldsOf(row);
    return fields === null ? [] : derivableKinds(fields, context);
  }

  function toRowDto(row: ImportRowRecord, context: DerivationContext): ImportRow {
    const confirmableKinds = confirmableKindsFor(row, context);
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
      ...(row.candidates && row.candidates.length > 0 ? { candidates: row.candidates } : {}),
      // Absent, not empty — a row no rule matched claims nothing, exactly as an
      // exactly-resolved row carries no `candidates`.
      ...(row.ruleTagIds && row.ruleTagIds.length > 0 ? { ruleTagIds: row.ruleTagIds } : {}),
      // Absent means the pipeline matched the instrument exactly; present means
      // a person chose it. Same additive convention as the two above.
      ...(row.resolvedBy ? { resolvedBy: row.resolvedBy } : {}),
      // Present ⇒ this row is `error` only because nobody has said what it is,
      // and these are the kinds a person may confirm. Absent on every decided
      // row, and on an undecided one that carries nothing bookable — where the
      // honest answer is that there is no question worth asking.
      ...(confirmableKinds.length > 0 ? { confirmableKinds } : {}),
    };
  }

  async function buildPreview(batch: ImportBatchRow): Promise<ImportPreviewResponse> {
    const rows = await importRepo.listRows(batch.id);
    return {
      batch: toBatchDto(batch, rows),
      rows: rows.map((row) => toRowDto(row, derivationContext(batch))),
      // Only a generically-staged batch understood any columns; a broker-mapper
      // batch reports nothing rather than an empty shape it never computed.
      ...(batch.understanding ? { understanding: batch.understanding } : {}),
    };
  }

  /**
   * Understand a file no broker mapper claims (#964). Every failure mode of the
   * generic pipeline is mapped onto a 400 the wizard can explain — an
   * unsupported container, a file with no table in it, a table whose columns
   * cannot be labelled at all — because reaching the terminal handler as a 500
   * would report the user's odd CSV as a server fault.
   */
  async function stageGenerically(
    userId: string,
    input: CreateImportBatchInput,
  ): Promise<{ mapped: MappedLine[]; understanding: ImportUnderstanding }> {
    const bytes = input.contentBytes ?? new TextEncoder().encode(input.content);
    let staged: Awaited<ReturnType<typeof stageGenericFile>>;
    try {
      staged = await stageGenericFile(bytes, input.filename, {
        // Both seams are looked up per user and either may be absent. A binder
        // that throws (the heavy tier refuses under a test runner) degrades to
        // the deterministic path rather than failing the upload.
        header: { ai: safeSeam(() => deps.headerAi?.(userId)) },
        rows: { ai: safeSeam(() => deps.rowAi?.(userId)) },
      });
    } catch (err) {
      if (err instanceof UnsupportedFileFormatError) {
        throw badRequest(
          'This file format is not supported — export your statement as CSV.',
          'IMPORT_FORMAT_UNSUPPORTED',
        );
      }
      if (err instanceof UnmappableTableError) {
        throw badRequest(
          'The columns in this file could not be identified. Export it with a header row, ' +
            'or pick the broker manually.',
          'IMPORT_COLUMNS_UNREADABLE',
        );
      }
      throw err;
    }
    if (!staged) {
      throw badRequest('The file contains no data rows.', 'IMPORT_EMPTY');
    }
    if (staged.lines.length > IMPORT_MAX_ROWS) {
      throw badRequest(
        `The file has more than ${IMPORT_MAX_ROWS} rows — split it and import in parts.`,
        'IMPORT_TOO_MANY_ROWS',
      );
    }
    return { mapped: staged.lines.map(guardStagedRow), understanding: staged.understanding };
  }

  /**
   * Pin an unresolved row to an asset the CALLER chose (#964, §16 2026-07-31
   * point 4: "resolvable IN the wizard … never a dead end and never a silent
   * mis-map").
   *
   * ── WHAT VALIDATES THE ID, AND WHAT DOES NOT ───────────────────────────────
   *
   * The row's stored `candidates` are UI suggestions and deliberately NOT the
   * validation boundary. Constraining the pick to them would re-create the dead
   * end this exists to remove: the directive's other half is "or create a custom
   * one on the spot", and a just-created custom asset is by definition not in a
   * suggestion list computed at staging time. So the id is validated with the
   * SAME rule the manual transaction path uses — a global catalog asset, or the
   * caller's OWN custom asset; anything else is a 404 that cannot distinguish
   * "missing" from "someone else's" (§10).
   *
   * That is the correct boundary because the hazard this subsystem guards
   * against is a MODEL minting an asset id, and no model reaches this method:
   * the id comes from a person, over an authenticated session, naming something
   * they could already book by hand.
   *
   * ── WHY THE ROW IS RE-JUDGED, NOT JUST STAMPED ─────────────────────────────
   *
   * Pinning an asset changes the two things staging derived from it, so both
   * are recomputed rather than left stale:
   *  - the CURRENCY agreement a trade needs (the same check staging makes);
   *  - the CONTENT HASH, which keys on the resolved asset — so a row pinned to
   *    an instrument the portfolio already holds that exact trade for flips to
   *    `duplicate` instead of quietly becoming a second copy at apply.
   */
  async function pinAsset(
    userId: string,
    batch: ImportBatchRow,
    rows: readonly ImportRowRecord[],
    row: ImportRowRecord,
    assetId: string,
  ): Promise<void> {
    // Kind first, then flag: a cash row is BOTH "not an instrument row" and
    // "not unresolved", and the first of those is the specific truth a user
    // needs to hear. The generic message would send them hunting for a
    // resolution problem on a row that can never have one.
    if (row.kind === null || !needsInstrument(row.kind)) {
      throw badRequest('This row does not reference an instrument.', 'IMPORT_ROW_NOT_INSTRUMENT');
    }
    if (row.flag !== 'unmapped') {
      throw badRequest(
        'Only a row whose instrument could not be resolved can be pinned to an asset.',
        'IMPORT_ROW_NOT_UNRESOLVED',
      );
    }
    // An `unmapped` row parsed successfully and therefore has a date; this
    // keeps the content hash honest rather than trusting that invariant.
    if (row.executedAt === null) {
      throw badRequest('This row has no date to match against.', 'IMPORT_ROW_INVALID');
    }

    // Same visibility rule as `portfolioService.loadVisibleAssets`.
    const [asset] = await portfolioRepo.assetsByIds([assetId]);
    if (!asset || (asset.ownerId !== null && asset.ownerId !== userId)) {
      throw notFound('Asset not found.', 'ASSET_NOT_FOUND');
    }

    // A trade must be quoted in the row's own currency — staging refuses the
    // mismatch, and a hand-pinned asset gets no weaker a check.
    if ((row.kind === 'buy' || row.kind === 'sell') && asset.currency !== row.currency) {
      throw badRequest(
        `${asset.symbol} is quoted in ${asset.currency} but this row is ${row.currency} — ` +
          `pick the ${row.currency} listing instead.`,
        'IMPORT_ROW_CURRENCY_MISMATCH',
      );
    }

    const hash = contentHash({
      kind: row.kind,
      executedAt: row.executedAt,
      instrument: asset.id,
      quantity: row.quantity,
      price: row.price,
      amountEur: row.amountEur,
      reference: row.note,
    });

    const duplicate = await isDuplicateHash(userId, batch, rows, row, hash, row.kind);

    // The write is conditional on the batch still being `pending`, because
    // everything between the check above and this line is `await`ed and an
    // apply can claim the batch in that gap. A refused write means the claim
    // won: the client gets the same 409 a sequential second apply gets, and
    // the row is left exactly as staging had it rather than half-pinned to an
    // import that already finished.
    const pinned = await importRepo.setRowResolution({
      id: row.id,
      assetId: asset.id,
      flag: duplicate ? 'duplicate' : 'mapped',
      message: duplicate ? duplicateMessageFor(row.kind) : null,
      contentHash: hash,
      resolvedBy: 'user',
    });
    if (!pinned) {
      throw conflict('This import was already applied.', 'IMPORT_ALREADY_APPLIED');
    }
  }

  /**
   * Duplicate truth for ONE candidate hash: against what the portfolio already
   * holds, AND against the rows this batch will itself apply — the same two
   * questions staging asks, asked again because both answers can have changed
   * since the upload.
   *
   * CASH COUNTS, EVERYTHING ELSE MATCHES. For a trade or a dividend one
   * recorded entity settles it. A cash row asks a narrower question — "is MY
   * occurrence one the ledger already holds?" — because a statement legitimately
   * repeats a line: with one €100 deposit recorded and two identical rows in the
   * batch, the first row is that deposit and the second is a movement nobody has
   * booked. The batch's own rows are ordered by `rowIndex`, so which occurrence
   * a row is does not depend on the order the person happens to confirm them in.
   */
  async function isDuplicateHash(
    userId: string,
    batch: ImportBatchRow,
    rows: readonly ImportRowRecord[],
    subject: ImportRowRecord,
    hash: string,
    kind: NormalizedImportRow['kind'],
  ): Promise<boolean> {
    const existing = await existingHashesForBatch(userId, batch, hashScopeFor(kind));
    const claimants = (flags: readonly ImportRowRecord['flag'][]) =>
      rows.filter(
        (r) =>
          r.id !== subject.id &&
          r.contentHash === hash &&
          flags.includes(r.flag) &&
          r.rowIndex < subject.rowIndex,
      ).length;
    if (isCashRowKind(kind)) {
      // Rows staged `duplicate` count too: each one has already claimed one of
      // the ledger's occurrences, which is precisely why it is a duplicate.
      return claimants(['mapped', 'duplicate']) < countOf(existing, hash);
    }
    if (existing.has(hash)) return true;
    return rows.some((r) => r.id !== subject.id && r.flag === 'mapped' && r.contentHash === hash);
  }

  /**
   * CONFIRM WHAT A ROW IS (§16 2026-08-29 gap (b)) — the person supplies the
   * kind the classifier would not guess, and the server re-stages that one row
   * around it.
   *
   * The reference case is a bank statement with no booking-type column: every
   * line is a memo and a signed amount, every line classifies below the review
   * bar, and the whole file previews perfectly and imports nothing. The machine
   * still refuses to guess — that refusal is why the question exists — so the
   * only thing that can settle it is a human, and this is the door.
   *
   * ── THE CLIENT ASSERTS A KIND. IT SUPPLIES NO DATA ─────────────────────────
   *
   * The body carries one enum member and nothing else (the contract is
   * `.strict()`, so an amount smuggled alongside is a 400 rather than a value
   * anyone might read). Every number this row books is re-derived by
   * `deriveRowForKind` from the fields STAGING parsed and persisted, and the
   * derivation may refuse — a negative amount is not confirmable as an inflow,
   * a row with no quantity and price is not confirmable as a trade. No model is
   * invoked here, and none could be: there is nothing to re-read, because the
   * upload was never retained.
   *
   * ── WHY THIS IS A RE-STAGE AND NOT A STAMP ─────────────────────────────────
   *
   * A kind decides the row's whole shape, so everything staging derives from a
   * kind is derived again, in the order staging derives it: the instrument
   * (catalog-only — a confirmation may not launch provider work, and an
   * unresolved one lands `unmapped` with its candidates, where the pinning path
   * above finishes the job), the currency agreement, the content hash and the
   * duplicate verdict, and the caller's own cash-rule tags for a row that has
   * just BECOME a cash movement. A row that skipped any of those would be a row
   * the preview describes and apply contradicts.
   *
   * ── ONE-SHOT ───────────────────────────────────────────────────────────────
   *
   * The derivation discards what the asserted kind has no use for (a cash
   * movement keeps no instrument identity — `contentHash` keys cash on a null
   * instrument, so keeping the memo there would defeat dedupe). There is
   * therefore nothing left to re-derive from, and a second confirmation is
   * refused rather than half-honoured. The same stance the pinning path takes
   * on re-pinning; recovery is the same too — discard the batch and upload
   * again, which costs nothing, because staging is a preview and not a record.
   */
  async function confirmKind(
    userId: string,
    batch: ImportBatchRow,
    rows: readonly ImportRowRecord[],
    row: ImportRowRecord,
    kind: ImportRowKind,
  ): Promise<void> {
    if (!row.kindUndecided) {
      throw badRequest(
        "This row's kind is not open for confirmation — only a row the pipeline left " +
          'undecided can be confirmed, and only once.',
        'IMPORT_ROW_KIND_DECIDED',
      );
    }
    const fields = pendingFieldsOf(row);
    // Staging only marks a row undecided once it has a date and a currency, so
    // this is defence against a row written by an older or a broken path — not
    // an expected state.
    if (fields === null) {
      throw badRequest(
        'This row has no parsed fields to derive a booking from.',
        'IMPORT_ROW_INVALID',
      );
    }

    const derived = deriveRowForKind(kind, fields, derivationContext(batch));
    if (!derived.ok) {
      throw badRequest(derived.error, 'IMPORT_ROW_KIND_UNSUPPORTED');
    }
    const normalized = derived.row;

    // The instrument, exactly as staging's phase 1 does it: the local catalog
    // only. A confirmation must not be able to launch provider enrichment —
    // one PATCH per row would otherwise turn a bulk confirmation into a burst
    // of upstream searches — and an identity the catalog does not hold lands
    // `unmapped` with its near-matches, which is a state the wizard already
    // knows how to finish.
    let asset: SearchResultItem | null = null;
    let candidates: ImportRowCandidate[] | null = null;
    let flag: StageImportRowInput['flag'] = 'mapped';
    let message: string | null = null;
    if (needsInstrument(normalized.kind)) {
      const sink: CandidateSink = new Map();
      asset = await resolutionQueue.run(() => resolveInstrumentLocally(userId, normalized, sink));
      if (asset === null) {
        flag = 'unmapped';
        message = unresolvedInstrumentMessage(normalized);
        candidates = finalizeCandidates(sink);
      } else if (
        (normalized.kind === 'buy' || normalized.kind === 'sell') &&
        asset.currency !== normalized.currency
      ) {
        // REFUSED, NOT RECORDED (review F3). Staging writes this collision as an
        // `error` row because staging has no one to ask; a confirmation does,
        // and committing it would spend the one shot on a row that can then
        // never be booked — re-confirming is refused as decided, and pinning is
        // refused because the row is no longer `unmapped`. A dead end reached
        // through the affordance built to remove dead ends.
        //
        // So a confirm answers the way the PINNING path already answers the
        // identical collision: same code, same shape, row untouched, decision
        // still open. A confirmation never writes `error`.
        throw badRequest(
          `${asset.symbol} is quoted in ${asset.currency} but this row is ` +
            `${normalized.currency} — the ${normalized.currency} listing has to exist in the ` +
            'catalog before this row can be a trade.',
          'IMPORT_ROW_CURRENCY_MISMATCH',
        );
      }
    }

    const hash = contentHash({
      kind: normalized.kind,
      executedAt: normalized.executedAt,
      instrument: asset ? asset.id : rawInstrumentKey(normalized),
      quantity: normalized.quantity,
      price: normalized.price,
      amountEur: normalized.amountEur,
      reference: normalized.note,
    });
    if (
      flag === 'mapped' &&
      (await isDuplicateHash(userId, batch, rows, row, hash, normalized.kind))
    ) {
      flag = 'duplicate';
      message = duplicateMessageFor(normalized.kind);
    }

    // A row that has just become a cash movement earns the same pre-tagging a
    // row staged as one gets, from the same rules through the same engine —
    // otherwise the preview would promise a label for one and not the other.
    const taggable = flag === 'mapped' && isCashRowKind(normalized.kind);
    const rules = taggable ? await cashRuleRepo.listForOwner(userId) : [];
    const ruleTagIds = stagedRuleTags(normalized, flag, rules);

    // Conditional on the batch still being `pending`, for the reason
    // `pinAsset` states above: several awaits separate the check from the
    // write, and `applyBatch` can claim the batch in between.
    const written = await importRepo.confirmRowKind({
      id: row.id,
      kind: normalized.kind,
      flag,
      message,
      executedAt: normalized.executedAt,
      isin: normalized.isin,
      symbol: normalized.symbol,
      name: normalized.name,
      quantity: normalized.quantity,
      price: normalized.price,
      fee: normalized.fee,
      amountEur: normalized.amountEur,
      currency: normalized.currency,
      note: normalized.note,
      assetId: asset?.id ?? null,
      contentHash: hash,
      candidates,
      ruleTagIds,
      // The same provenance a pinned asset earns: a person decided this, not
      // the pipeline. The preview badges it, so no reviewer mistakes a human's
      // assertion for a machine's exact reading.
      resolvedBy: 'user',
    });
    if (!written) {
      // The write is conditional on TWO things — the batch still pending, and
      // the row still undecided — so a refusal has two possible causes and the
      // caller deserves the right one (review F4). Telling someone whose
      // request lost a race with ANOTHER CONFIRMATION that their import "was
      // already applied" sends them looking for a batch that is still sitting
      // there, pending, waiting for the rest of their decisions.
      //
      // Re-read to find out which. This costs one query on a path that only
      // runs when a write was already refused.
      const refreshed = await importRepo.findBatchForOwner(userId, batch.id);
      if (refreshed !== null && refreshed.status === 'pending') {
        throw badRequest(
          "This row's kind is not open for confirmation — only a row the pipeline left " +
            'undecided can be confirmed, and only once.',
          'IMPORT_ROW_KIND_DECIDED',
        );
      }
      throw conflict('This import was already applied.', 'IMPORT_ALREADY_APPLIED');
    }
  }

  return {
    listBrokers() {
      // The generic entry is listed LAST and is pickable: a user whose file a
      // mapper misreads can force the understanding path, and a user whose file
      // nothing claims sees that there is a way through (§16 point 1).
      return {
        brokers: [...registry.list(), { id: GENERIC_BROKER_ID, label: GENERIC_BROKER_LABEL }],
      };
    },

    async createBatch(userId, input) {
      await deps.paranoid?.assertAllowed(userId, 'imports');
      await requireOwnedPortfolio(userId, input.portfolioId);

      // ── Which front end reads this file ──────────────────────────────────
      // The hand-written mappers keep first claim: an explicit pick wins, then
      // autodetection, and only a file NOTHING recognizes reaches the generic
      // path. That ordering is the product rule — a Trade Republic export must
      // keep importing through the mapper that was verified against it, byte
      // for byte, whatever the generic pipeline would have made of it.
      let mapper: BrokerMapper | null = null;
      let generic = false;
      if (input.brokerId === GENERIC_BROKER_ID) {
        generic = true;
      } else if (input.brokerId !== undefined) {
        mapper = registry.byId(input.brokerId);
        if (!mapper) throw badRequest('Unknown broker.', 'IMPORT_BROKER_UNKNOWN');
      }

      let mapped: MappedLine[];
      let understanding: ImportUnderstanding | null = null;
      let brokerId: string;

      if (!generic && mapper === null) {
        // Autodetect needs the CSV front end; a file it cannot parse at all is
        // still a candidate for the generic sniffer (which handles other
        // delimiters and encodings), so a parse failure here is not fatal.
        const detected = tryDetect(input.content);
        if (detected) mapper = detected;
        else generic = true;
      }

      if (mapper !== null) {
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
        mapped = mapper.map(csv).map(guardStagedRow);
        brokerId = mapper.id;
      } else {
        const staged = await stageGenerically(userId, input);
        mapped = staged.mapped;
        understanding = staged.understanding;
        brokerId = GENERIC_BROKER_ID;
      }

      // Collect before resolving so an over-cap file is rejected without doing
      // any catalog/provider work. Files repeat instruments heavily, so the raw
      // identity key is resolved exactly once for the whole batch.
      const instruments = new Map<string, NormalizedImportRow>();
      for (const line of mapped) {
        if (!line.ok || !needsInstrument(line.row.kind)) continue;
        const key = rawInstrumentKey(line.row);
        if (key !== null && !instruments.has(key)) instruments.set(key, line.row);
      }
      if (instruments.size > IMPORT_MAX_DISTINCT_INSTRUMENTS) {
        throw badRequest(
          `The file contains more than ${IMPORT_MAX_DISTINCT_INSTRUMENTS} distinct instruments — split it into files with at most ${IMPORT_MAX_DISTINCT_INSTRUMENTS} instruments each.`,
          'IMPORT_TOO_MANY_INSTRUMENTS',
        );
      }

      // Resolution runs in three phases. The catalog MUTATES mid-batch —
      // `CatalogEnrichment.run()` upserts every hit of a query, not just the
      // identity that triggered it — so a read taken before enrichment is stale
      // for every identity that never gets its own admission. Hence phase 3.

      // Phase 1 — the complete local pass, before any provider work is admitted,
      // so an already-catalogued instrument never depends on the budget. Each
      // identity also gets a candidate sink fed from the results every attempt
      // returns — used only if the identity never resolves.
      const resolutions = new Map<string, SearchResultItem | null>();
      const candidateSinks = new Map<string, CandidateSink>();
      const unresolved: Array<[key: string, row: NormalizedImportRow]> = [];
      for (const [key, row] of instruments) {
        const sink: CandidateSink = new Map();
        candidateSinks.set(key, sink);
        const local = await resolutionQueue.run(() => resolveInstrumentLocally(userId, row, sink));
        resolutions.set(key, local);
        if (local === null) unresolved.push([key, row]);
      }

      // Phase 2 — bounded enrichment for the misses, in file order.
      const enrichmentBudget: EnrichmentBudget = {
        remainingWaitMs: IMPORT_ENRICHMENT_WAIT_BUDGET_MS,
        remainingQueries: IMPORT_ENRICHMENT_QUERY_BUDGET,
      };
      let enrichmentStarted = false;
      for (const [key, row] of unresolved) {
        if (enrichmentBudget.remainingQueries <= 0 || enrichmentBudget.remainingWaitMs <= 0) {
          break;
        }
        // A sibling admission may already have upserted this identity. Re-reading
        // is catalog-only, so it costs no slot and keeps one for a genuine miss.
        if (enrichmentStarted) {
          const appeared = await resolutionQueue.run(() =>
            resolveInstrumentLocally(userId, row, candidateSinks.get(key)),
          );
          if (appeared !== null) {
            resolutions.set(key, appeared);
            continue;
          }
        }
        enrichmentStarted = true;
        const enriched = await resolutionQueue.run(() =>
          enrichInstrument(userId, row, enrichmentBudget, candidateSinks.get(key)),
        );
        if (enriched !== null) resolutions.set(key, enriched);
      }

      // Phase 3 — the post-enrichment sweep. Every identity the budget never
      // admitted still holds its phase-1 read, which is stale for any row a
      // sibling query upserted meanwhile; without this pass a valid file stages
      // `unmapped` rows whose asset is already sitting in Postgres. The sweep is
      // catalog-only (`allowEnrichment: false`), so it can neither spend a query
      // slot nor wait — it cannot re-open the provider amplification.
      if (enrichmentStarted) {
        for (const [key, row] of unresolved) {
          if (resolutions.get(key) !== null) continue;
          const local = await resolutionQueue.run(() =>
            resolveInstrumentLocally(userId, row, candidateSinks.get(key)),
          );
          if (local !== null) resolutions.set(key, local);
        }
      }

      // Suggestion lists for the identities that never resolved, from the
      // results the resolution attempts already fetched. Resolved identities
      // discard their sink — suggestions exist only where the row stays
      // `unmapped`.
      const candidateLists = new Map<string, ImportRowCandidate[]>();
      for (const [key] of unresolved) {
        if (resolutions.get(key) !== null) continue;
        const list = finalizeCandidates(candidateSinks.get(key) ?? new Map());
        if (list !== null) candidateLists.set(key, list);
      }

      const existing = await collectExistingHashes(userId, input.portfolioId);
      /** How many occurrences of each hash this file has already staged. */
      const seenInFile = new Map<string, number>();

      // The caller's own cash rules, read ONCE for the whole file (#964). The
      // staged rows below are pre-tagged from this single snapshot, which is
      // then persisted and replayed at apply — so the suggestion the user
      // confirms and the tags the movement receives come from the same read.
      const cashRules = await cashRulesForBatch(userId, mapped);

      const staged: StageImportRowInput[] = mapped.map((line) => {
        if (!line.ok) {
          // A line held back ONLY by the kind question keeps what it parsed, so
          // a person can confirm a kind later without re-uploading a file this
          // server never stored (§16 2026-08-29 gap (b)). Everything else is
          // written exactly as before — all nulls — because there is nothing
          // trustworthy to keep and nothing a confirmation could do with it.
          const pending = line.pending;
          return {
            rowIndex: line.line,
            raw: line.raw,
            // The one field a person is about to supply.
            kind: null,
            flag: 'error',
            message: line.error,
            executedAt: pending?.executedAt ?? null,
            isin: pending?.isin ?? null,
            symbol: pending?.symbol ?? null,
            name: pending?.name ?? null,
            quantity: pending?.quantity ?? null,
            price: pending?.price ?? null,
            fee: pending?.fee ?? null,
            // SIGNED on purpose while undecided: the sign is the file's own
            // statement of direction and it is what lets the derivation refuse
            // to book money out as money in. Apply never reads it — an `error`
            // row is skipped — and confirmation replaces it with the magnitude.
            amountEur: pending?.amount ?? null,
            currency: pending?.currency ?? null,
            note: pending?.note ?? null,
            assetId: null,
            // No kind, no hash: `contentHash` keys on the kind, so an undecided
            // row cannot be deduped yet. Confirmation computes it and re-runs
            // the duplicate check against what is recorded THEN.
            contentHash: null,
            candidates: null,
            ruleTagIds: null,
            kindUndecided: pending !== undefined,
          };
        }

        const row = line.row;
        const rawKey = rawInstrumentKey(row);
        const asset =
          needsInstrument(row.kind) && rawKey ? (resolutions.get(rawKey) ?? null) : null;

        let flag: StageImportRowInput['flag'] = 'mapped';
        let message: string | null = null;
        let candidates: ImportRowCandidate[] | null = null;
        if (needsInstrument(row.kind) && !asset) {
          // The row stays `unmapped` and excluded from apply; the captured
          // near-matches ride along as INFORMATION for a human decision, never
          // as one (§13.4: never silently guessed).
          flag = 'unmapped';
          message = unresolvedInstrumentMessage(row);
          candidates = (rawKey ? candidateLists.get(rawKey) : undefined) ?? null;
        } else if ((row.kind === 'buy' || row.kind === 'sell') && asset) {
          if (asset.currency !== row.currency) {
            flag = 'error';
            message = currencyMismatchMessage(asset, row);
          }
        }

        const hash = contentHash({
          kind: row.kind,
          executedAt: row.executedAt,
          instrument: asset ? asset.id : rawKey,
          quantity: row.quantity,
          price: row.price,
          amountEur: row.amountEur,
          reference: row.note,
        });
        if (flag === 'mapped') {
          const claimed = countOf(seenInFile, hash);
          // Cash by multiplicity, everything else by membership — see
          // `collectExistingHashes`. A file line that matched a recorded
          // movement has CLAIMED it, so the next identical line compares
          // against the next one; a line beyond what the ledger holds is a
          // movement nobody booked.
          const duplicate = isCashRowKind(row.kind)
            ? claimed < countOf(existing, hash)
            : existing.has(hash) || claimed > 0;
          if (duplicate) {
            flag = 'duplicate';
            message = duplicateMessageFor(row.kind);
          }
          seenInFile.set(hash, claimed + 1);
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
          candidates,
          // Pre-tag by the caller's OWN rules, through the SAME engine that
          // tags a hand-recorded movement (first match wins, its whole tag set,
          // case-insensitively).
          ruleTagIds: stagedRuleTags(row, flag, cashRules),
        };
      });

      const batch = await importRepo.createBatch(
        {
          ownerId: userId,
          portfolioId: input.portfolioId,
          brokerId,
          filename: input.filename,
          understanding,
        },
        staged,
      );
      return buildPreview(batch);
    },

    async getBatch(userId, batchId) {
      await deps.paranoid?.assertAllowed(userId, 'imports');
      const batch = await importRepo.findBatchForOwner(userId, batchId);
      if (!batch) throw notFound('Import not found.', 'IMPORT_NOT_FOUND');
      return buildPreview(batch);
    },

    async applyBatch(userId, batchId, input) {
      await deps.paranoid?.assertAllowed(userId, 'imports');
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
      // as a sequential second apply.
      //
      // CLAIM-FIRST MEANS A CRASH MID-LOOP CANNOT BE RETRIED, so the run must
      // leave behind what it did. Each row's result is written the moment that
      // row settles (`settle` below), not accumulated and flushed at the end:
      // the flush version booked every row's money and then, if anything threw
      // before it ran, left the batch `applied` with EVERY row result null and
      // every retry a 409 — money in the ledger and no record anywhere of which
      // rows put it there. Now an interrupted apply leaves the booked rows
      // stamped `applied` and the untouched ones with a null result, which is
      // exactly the "what landed, what did not" the caller needs; re-uploading
      // the file re-stages the unbooked rows and dedupes the booked ones.
      const claimed = await importRepo.claimPendingBatch(batch.id, cashSourceId);
      if (!claimed) {
        throw conflict('This import was already applied.', 'IMPORT_ALREADY_APPLIED');
      }
      // The batch is finished either way — nothing may serve a memoized answer
      // about a portfolio this run is about to write to.
      forgetBatchHashes(batch.id);

      const rows = await importRepo.listRows(batch.id);
      // Duplicate truth is re-derived NOW, uncached (preview flags could be
      // stale against writes that happened since the upload).
      const existing = await collectExistingHashes(userId, batch.portfolioId);
      const appliedThisRun = new Set<string>();
      /**
       * Ledger occurrences of a CASH hash this run has accounted for — a row
       * matched to an existing movement and a row that booked a new one both
       * consume exactly one, so the next identical row compares against what is
       * left (see `collectExistingHashes`).
       */
      const cashClaimed = new Map<string, number>();

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

      const outcomeByRowId = new Map<string, ImportRowOutcome>();

      /**
       * ONE ROW IS FINISHED: its result goes to the database before the loop
       * moves on. Durability is the point (see the claim comment above) —
       * a booked row whose result is still only in memory is a row nobody can
       * account for if the process dies on the next line.
       */
      const settle = async (
        row: ImportRowRecord,
        result: ImportRowResult,
        message: string | null,
        flag?: ImportRowRecord['flag'],
      ) => {
        outcomeByRowId.set(row.id, {
          id: row.id,
          rowIndex: row.rowIndex,
          kind: row.kind,
          result,
          message,
        });
        await importRepo.setRowResult({ id: row.id, result, resultMessage: message, flag });
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
        const booked =
          row.kind === 'deposit'
            ? await portfolio.depositCash(userId, batch.portfolioId, entry, { source })
            : await portfolio.withdrawCash(userId, batch.portfolioId, entry, { source });
        // Bind the booking to what the preview showed (#964).
        await replayRuleTags(batch.portfolioId, booked.movement.id, row.ruleTagIds);
      };

      /** This row matches something already in the ledger (or this run). */
      const alreadyRecorded = (row: ImportRowRecord): boolean => {
        if (!row.contentHash) return false;
        if (isCashRowKind(row.kind)) {
          return countOf(cashClaimed, row.contentHash) < countOf(existing, row.contentHash);
        }
        return existing.has(row.contentHash) || appliedThisRun.has(row.contentHash);
      };
      /** Account for the ledger occurrence a cash row just matched or created. */
      const claimCash = (row: ImportRowRecord): void => {
        if (!row.contentHash || !isCashRowKind(row.kind)) return;
        cashClaimed.set(row.contentHash, countOf(cashClaimed, row.contentHash) + 1);
      };

      for (const row of ordered) {
        if (row.flag === 'error') {
          await settle(row, 'skipped_error', row.message);
          continue;
        }
        if (row.flag === 'unmapped') {
          await settle(row, 'skipped_unmapped', row.message);
          continue;
        }
        if (row.flag === 'duplicate') {
          // Staging already matched this row to a recorded movement; that
          // occurrence is spoken for, so a later identical row compares against
          // the next one rather than against the same one twice.
          claimCash(row);
          await settle(row, 'skipped_duplicate', row.message);
          continue;
        }
        if (alreadyRecorded(row)) {
          claimCash(row);
          await settle(
            row,
            'skipped_duplicate',
            'An identical row was recorded since this preview was created.',
            'duplicate',
          );
          continue;
        }

        try {
          await applyRow(row);
        } catch (err) {
          if (err instanceof ApiError) {
            await settle(row, 'failed', err.message);
            continue;
          }
          // EVERYTHING ELSE IS ALSO THIS ROW'S PROBLEM, not the batch's.
          //
          // Rethrowing here was a batch-stranding bug (review F1). The claim is
          // already committed by this point — deliberately, so no row can book
          // twice — so an escaping error leaves the batch permanently `applied`
          // with the remaining rows never attempted and every retry a 409. A
          // raw driver error is exactly how that happened: a cash CHECK
          // violation (`portfolio_cash_movements_sign`) is a PostgresError, not
          // an ApiError, and it walked straight through the branch above.
          //
          // Per-row tolerance is the framework's promise (§13.4) and it cannot
          // be conditional on the failure having been anticipated.
          //
          // ── SURVIVING THE BUG MUST NOT SILENCE IT ───────────────────────────
          //
          // Catching everything buys recoverability with loudness, and a
          // swallowed TypeError is a defect that now looks like a business
          // refusal. So the error is CAPTURED into the problems fold the ops
          // cockpit reads (`captureError` scrubs every string, folds by
          // fingerprint and rate-caps, so a storm costs one row with an
          // occurrence count), carrying the batch/row ids an operator needs to
          // find the line again.
          //
          // The user is told something different from the operator, on purpose:
          // the row names itself an UNEXPECTED fault rather than borrowing the
          // wording of a refusal someone could talk them through, and the
          // driver text stays out of the API response (§10).
          const unexpected = err instanceof Error ? err : new Error('Unknown import row failure');
          deps.problems?.captureError(unexpected, {
            batchId: batch.id,
            rowId: row.id,
            rowIndex: row.rowIndex,
            brokerId: batch.brokerId,
            kind: row.kind,
          });
          deps.logger?.error?.(
            { err, batchId: batch.id, rowId: row.id, rowIndex: row.rowIndex },
            'import: row failed with an unexpected error; reported as failed',
          );
          await settle(
            row,
            'failed',
            'This row hit an unexpected error, reported to the team. Nothing was booked for it.',
          );
          continue;
        }

        // ── PAST THIS LINE THE MONEY IS BOOKED ───────────────────────────────
        //
        // `settle` is a plain UPDATE of the row's result, and it used to sit
        // inside the try above. A failing UPDATE was therefore caught by the
        // handler that assumes `applyRow` threw, and the row was reported
        // `failed` with "Nothing was booked for it." — the exact opposite of the
        // truth about a movement already in the ledger, on top of which the
        // staged `contentHash` makes a re-import dedupe it away.
        //
        // Recording the outcome may still fail; what may not happen is the
        // report denying the booking. The in-memory outcome is written first and
        // is what the response counts, so the user is told `applied` either way;
        // the durable row result is best-effort and its loss is an OPERATOR
        // problem, captured as one.
        if (row.contentHash) appliedThisRun.add(row.contentHash);
        claimCash(row);
        try {
          await settle(row, 'applied', null);
        } catch (err) {
          const unexpected = err instanceof Error ? err : new Error('Unknown import row failure');
          deps.problems?.captureError(unexpected, {
            batchId: batch.id,
            rowId: row.id,
            rowIndex: row.rowIndex,
            brokerId: batch.brokerId,
            kind: row.kind,
            stage: 'settle-applied',
          });
          deps.logger?.error?.(
            { err, batchId: batch.id, rowId: row.id, rowIndex: row.rowIndex },
            'import: row booked but recording its result failed; reported as applied',
          );
        }
      }

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

    /**
     * The two decisions a person can make about ONE staged row — pinning its
     * instrument (§16 2026-07-31 point 4) or confirming its kind (§16
     * 2026-08-29 gap (b)) — behind one owner-scoped, pending-gated entry point.
     *
     * They share an endpoint because they share everything that makes them
     * safe: the same ownership scoping, the same batch-lifecycle gate, the same
     * compare-and-set against an apply that may claim the batch mid-flight, and
     * the same whole-preview response so the client never recomputes what
     * staging decided. What differs is only which fact the row was missing.
     *
     * See {@link pinAsset} and {@link confirmKind} for each half.
     */
    async resolveRow(userId, batchId, rowId, input) {
      await deps.paranoid?.assertAllowed(userId, 'imports');
      // Exactly one intent per request. The contract enforces this too, but the
      // service is called directly (jobs, tests) and must not depend on a route
      // having validated for it — a body carrying both would otherwise silently
      // take whichever branch happens to be written first.
      const wantsKind = input.kind !== undefined;
      const wantsAsset = input.assetId !== undefined;
      if (wantsKind === wantsAsset) {
        throw badRequest('Provide exactly one of assetId or kind.', 'IMPORT_ROW_UPDATE_AMBIGUOUS');
      }

      const batch = await importRepo.findBatchForOwner(userId, batchId);
      if (!batch) throw notFound('Import not found.', 'IMPORT_NOT_FOUND');
      if (batch.status !== 'pending') {
        throw conflict('This import was already applied.', 'IMPORT_ALREADY_APPLIED');
      }

      const rows = await importRepo.listRows(batch.id);
      const row = rows.find((r) => r.id === rowId);
      // Scoped to THIS batch: a row id from someone else's import is a 404 for
      // the same reason a foreign batch id is.
      if (!row) throw notFound('Import row not found.', 'IMPORT_ROW_NOT_FOUND');

      if (input.kind !== undefined) {
        await confirmKind(userId, batch, rows, row, input.kind);
      } else {
        await pinAsset(userId, batch, rows, row, input.assetId!);
      }

      const refreshed = await importRepo.findBatchForOwner(userId, batchId);
      return buildPreview(refreshed ?? batch);
    },

    async discardBatch(userId, batchId) {
      await deps.paranoid?.assertAllowed(userId, 'imports');
      const deleted = await importRepo.deleteBatchForOwner(userId, batchId);
      if (!deleted) throw notFound('Import not found.', 'IMPORT_NOT_FOUND');
      forgetBatchHashes(batchId);
    },
  };
}
