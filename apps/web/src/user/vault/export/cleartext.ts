import {
  VAULT_ENTITY_KINDS,
  VAULT_ENTITY_ROW_SCHEMAS,
  type TaxExportLocale,
  type VaultDocument,
  type VaultEntity,
  type VaultEntityKind,
} from '@bettertrack/contracts';
import {
  reducePosition,
  type Transaction as DomainTransaction,
} from '@bettertrack/domain/holdings';
import { strToU8, zip } from 'fflate';

import { localizedMessage } from '../../../i18n';
import { asMoneyFailure, moneyFailure, type VaultMoneyOutcome } from '../engine/errors';
import {
  assertMoneySnapshotCurrent,
  liveEntities,
  validatedMoneySnapshot,
  type VaultMoneySnapshotAccess,
} from '../engine/session';

type EntityExportClassification =
  | { disposition: 'export'; dataName: string }
  | { disposition: 'skip'; table: string; reasonKey: string };

/**
 * Exhaustive by contract: a new vault entity cannot silently disappear from a
 * user's cleartext exit. Source rows are exported; derived/idempotency rows are
 * named explicitly in the manifest.
 */
const ENTITY_EXPORT_CLASSIFICATION = {
  portfolio: { disposition: 'export', dataName: 'portfolios' },
  transaction: { disposition: 'export', dataName: 'transactions' },
  dividend: { disposition: 'export', dataName: 'dividends' },
  cashSource: { disposition: 'export', dataName: 'cashSources' },
  cashMovement: { disposition: 'export', dataName: 'cashMovements' },
  portfolioSetting: { disposition: 'export', dataName: 'portfolioSettings' },
  taxSetting: { disposition: 'export', dataName: 'taxSettings' },
  customAsset: { disposition: 'export', dataName: 'customAssets' },
  customAssetValue: { disposition: 'export', dataName: 'customAssetPriceHistory' },
  standingOrder: { disposition: 'export', dataName: 'standingOrders' },
  standingOrderRun: {
    disposition: 'skip',
    table: 'standing_order_runs',
    reasonKey: 'standingOrderRuns',
  },
  importBatch: {
    disposition: 'skip',
    table: 'import_batches',
    reasonKey: 'importBatches',
  },
  importRow: { disposition: 'skip', table: 'import_rows', reasonKey: 'importRows' },
  portfolioDailySnapshot: {
    disposition: 'skip',
    table: 'portfolio_daily_snapshots',
    reasonKey: 'portfolioSnapshots',
  },
  portfolioSnapshotState: {
    disposition: 'skip',
    table: 'portfolio_snapshot_state',
    reasonKey: 'snapshotState',
  },
  expenseCategory: { disposition: 'export', dataName: 'expenseCategories' },
  expenseTransaction: { disposition: 'export', dataName: 'expenseTransactions' },
  expenseRule: { disposition: 'export', dataName: 'expenseRules' },
  expenseBudget: { disposition: 'export', dataName: 'expenseBudgets' },
  expenseBudgetFire: {
    disposition: 'skip',
    table: 'expense_budget_fires',
    reasonKey: 'expenseBudgetFires',
  },
  cashTag: { disposition: 'export', dataName: 'cashTags' },
  cashMovementTag: { disposition: 'export', dataName: 'cashMovementTags' },
  cashBudget: { disposition: 'export', dataName: 'cashBudgets' },
  cashBudgetFire: {
    disposition: 'skip',
    table: 'cash_budget_fires',
    reasonKey: 'cashBudgetFires',
  },
  cashRule: { disposition: 'export', dataName: 'cashRules' },
  cashRuleTag: { disposition: 'export', dataName: 'cashRuleTags' },
} as const satisfies Record<VaultEntityKind, EntityExportClassification>;

const FORBIDDEN_KEY =
  /^(?:vaultKeys?|vk|kek|passphrase|password|recovery(?:Key|Kit|Material|Codes?)?|wrappedKeys?|wrappedVk|ciphertext|envelope|vaultVersion|writeId|deviceId|editedBy|deletedAt|mergeLog|sync(?:Metadata|State|Candidate|Version)?|quarantine(?:d|Blob)?|secret)$/i;

export interface ClientCleartextExport {
  filename: string;
  mediaType: 'application/zip';
  bytes: Uint8Array;
  manifest: {
    format: 'bettertrack-account-export';
    version: 1;
    userId: string;
    generatedAt: string;
    entities: Record<string, number>;
    csv: string[];
    skippedTables: Array<{ table: string; reason: string }>;
  };
}

export interface ClientCleartextExportOptions {
  generatedAt?: Date;
  locale?: TaxExportLocale;
  signal?: AbortSignal;
}

/**
 * Build an account-export-compatible archive entirely in browser memory. E6's
 * split-doc session makes this a per-vault export; the legacy v1 sync source is
 * retained so existing account-vault users keep the same exit path.
 * A lock/version race after ZIP creation zeroes the produced buffer before the
 * typed abort is returned.
 */
export async function createClientCleartextExport(
  access: VaultMoneySnapshotAccess,
  options: ClientCleartextExportOptions = {},
): Promise<VaultMoneyOutcome<ClientCleartextExport>> {
  let archive: Uint8Array | null = null;
  try {
    options.signal?.throwIfAborted();
    const snapshot = validatedMoneySnapshot(access);
    const generatedAt = options.generatedAt ?? new Date();
    if (!Number.isFinite(generatedAt.getTime())) {
      throw moneyFailure('VAULT_CORRUPT', 'The export timestamp is invalid.');
    }
    const entities = collectEntities(snapshot.document);
    const csv = buildCsv(snapshot.document);
    const locale = options.locale ?? 'en';
    const counts = Object.fromEntries(
      Object.entries(entities).map(([name, rows]) => [name, rows.length]),
    );
    const manifest: ClientCleartextExport['manifest'] = {
      format: 'bettertrack-account-export',
      version: 1,
      userId: snapshot.ownerUserId,
      generatedAt: generatedAt.toISOString(),
      entities: counts,
      csv: ['transactions', 'cash-movements', 'holdings'],
      skippedTables: VAULT_ENTITY_KINDS.flatMap((kind) => {
        const classification = ENTITY_EXPORT_CLASSIFICATION[kind];
        if (classification.disposition !== 'skip') return [];
        return [
          {
            table: classification.table,
            reason: localizedMessage(
              locale,
              `vaultExports.cleartext.skipped.${classification.reasonKey}`,
            ),
          },
        ];
      }).sort((left, right) => left.table.localeCompare(right.table)),
    };
    const files: Record<string, Uint8Array> = {
      'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
      'README.txt': strToU8(localizedMessage(locale, 'vaultExports.cleartext.readme')),
      'csv/transactions.csv': strToU8(csv.transactions),
      'csv/cash-movements.csv': strToU8(csv.cashMovements),
      'csv/holdings.csv': strToU8(csv.holdings),
    };
    for (const [name, rows] of Object.entries(entities)) {
      files[`data/${name}.json`] = strToU8(JSON.stringify(rows, null, 2));
    }

    // Cross a browser task boundary before starting worker-backed compression.
    // This lets a pending click/idle lock run, not only queued microtasks.
    await yieldToBrowserTask();
    options.signal?.throwIfAborted();
    assertMoneySnapshotCurrent(access, snapshot);
    archive = await zipArchive(files, options.signal);
    // The worker callback resumes in a microtask. Yield once more so a lock task
    // queued during compression is observed before any bytes leave this method.
    await yieldToBrowserTask();
    options.signal?.throwIfAborted();
    assertMoneySnapshotCurrent(access, snapshot);
    return {
      ok: true,
      value: {
        filename: `bettertrack-cleartext-export-${generatedAt.toISOString().slice(0, 10)}.zip`,
        mediaType: 'application/zip',
        bytes: archive,
        manifest,
      },
    };
  } catch (cause) {
    archive?.fill(0);
    return { ok: false, error: asMoneyFailure(cause) };
  }
}

function yieldToBrowserTask(): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, 0);
  });
}

function zipArchive(files: Record<string, Uint8Array>, signal?: AbortSignal): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let terminate: (() => void) | null = null;
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      terminate?.();
      cleanup();
      reject(new DOMException('Cleartext export generation was aborted.', 'AbortError'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      terminate = zip(files, (error, data) => {
        if (settled) {
          // fflate delivers data = null when error !== null.
          data?.fill(0);
          return;
        }
        settled = true;
        cleanup();
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(data);
      });
    } catch (cause) {
      settled = true;
      cleanup();
      reject(cause);
      return;
    }
    if (signal?.aborted === true) onAbort();
  });
}

function collectEntities(document: VaultDocument): Record<string, unknown[]> {
  const result: Record<string, unknown[]> = {};
  for (const kind of VAULT_ENTITY_KINDS) {
    const classification = ENTITY_EXPORT_CLASSIFICATION[kind];
    if (classification.disposition !== 'export') continue;
    result[classification.dataName] = liveEntities(document, kind).map((entity) =>
      exportRow(kind, entity),
    );
  }
  return result;
}

function exportRow(kind: VaultEntityKind, entity: VaultEntity): Record<string, unknown> {
  const parsed = VAULT_ENTITY_ROW_SCHEMAS[kind].parse(entity.data);
  assertNoSensitiveKeys(parsed, `${kind}/${entity.id}`);
  // Drizzle's normal account export preserves PostgreSQL numeric columns as
  // decimal strings. Keep the strict vault row unchanged too: coercing through
  // a JS number could lose significant digits in a supposedly lossless export.
  return { id: entity.id, ...parsed };
}

function buildCsv(document: VaultDocument): {
  transactions: string;
  cashMovements: string;
  holdings: string;
} {
  const transactions = liveEntities(document, 'transaction').map((entity) => ({
    id: entity.id,
    ...VAULT_ENTITY_ROW_SCHEMAS.transaction.parse(entity.data),
  }));
  const movements = liveEntities(document, 'cashMovement').map((entity) => ({
    id: entity.id,
    ...VAULT_ENTITY_ROW_SCHEMAS.cashMovement.parse(entity.data),
  }));
  const holdings = new Map<
    string,
    { portfolioId: string; assetId: string; transactions: DomainTransaction[] }
  >();
  const orderedTransactions = [...transactions].sort(
    (left, right) =>
      Date.parse(left.executedAt) - Date.parse(right.executedAt) || left.id.localeCompare(right.id),
  );
  for (const transaction of orderedTransactions) {
    const key = `${transaction.portfolioId}:${transaction.assetId}`;
    const domainTransaction: DomainTransaction = {
      assetId: transaction.assetId,
      side: transaction.side,
      quantity: finiteNumber(transaction.quantity, 'quantity'),
      price: finiteNumber(transaction.price, 'price'),
      fee: finiteNumber(transaction.fee, 'fee'),
      executedAt: transaction.executedAt,
      allowUncovered: transaction.allowUncovered,
      uncoveredEntryPrice:
        transaction.uncoveredEntryPrice === null
          ? null
          : finiteNumber(transaction.uncoveredEntryPrice, 'uncoveredEntryPrice'),
    };
    const current = holdings.get(key);
    if (current === undefined) {
      holdings.set(key, {
        portfolioId: transaction.portfolioId,
        assetId: transaction.assetId,
        transactions: [domainTransaction],
      });
    } else {
      current.transactions.push(domainTransaction);
    }
  }
  return {
    transactions: toCsv(
      ['id', 'portfolioId', 'assetId', 'side', 'quantity', 'price', 'fee', 'executedAt', 'note'],
      transactions.map((row) => [
        row.id,
        row.portfolioId,
        row.assetId,
        row.side,
        row.quantity,
        row.price,
        row.fee,
        row.executedAt,
        row.note,
      ]),
    ),
    cashMovements: toCsv(
      ['id', 'portfolioId', 'sourceId', 'kind', 'amountEur', 'taxYear', 'executedAt', 'note'],
      movements.map((row) => [
        row.id,
        row.portfolioId,
        row.sourceId,
        row.kind,
        row.amountEur,
        row.taxYear,
        row.executedAt,
        row.note,
      ]),
    ),
    holdings: toCsv(
      ['portfolioId', 'assetId', 'netQuantity'],
      [...holdings.values()]
        .map((row) => ({ ...row, net: reducePosition(row.transactions).quantity }))
        .filter((row) => row.net !== 0)
        .map((row) => [row.portfolioId, row.assetId, row.net]),
    ),
  };
}

function toCsv(headers: string[], rows: unknown[][]): string {
  return `${[headers.join(','), ...rows.map((row) => row.map(csvCell).join(','))].join('\n')}\n`;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const raw = String(value);
  const formula = /^[=+\-@\t\r]/.test(raw) && !/^-?\d+(?:\.\d+)?$/.test(raw);
  const safe = formula ? `'${raw}` : raw;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function finiteNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw moneyFailure('VAULT_CORRUPT', `Export field ${label} is outside the numeric range.`);
  }
  return parsed;
}

function assertNoSensitiveKeys(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveKeys(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) {
      throw moneyFailure(
        'VAULT_CORRUPT',
        `Cleartext export rejected forbidden vault-internal field ${path}.${key}.`,
      );
    }
    assertNoSensitiveKeys(child, `${path}.${key}`);
  }
}
