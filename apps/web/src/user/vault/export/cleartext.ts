import {
  VAULT_ENTITY_ROW_SCHEMAS,
  type TaxExportLocale,
  type VaultDocument,
  type VaultEntity,
  type VaultEntityKind,
} from '@bettertrack/contracts';
import { strToU8, zip } from 'fflate';

import { localizedMessage } from '../../../i18n';
import type { VaultSyncEngine } from '../sync';
import { asMoneyFailure, moneyFailure, type VaultMoneyOutcome } from '../engine/errors';
import {
  assertVaultSnapshotCurrent,
  liveEntities,
  validatedVaultSnapshot,
} from '../engine/session';

const EXPORT_KINDS = {
  portfolio: 'portfolios',
  transaction: 'transactions',
  dividend: 'dividends',
  cashSource: 'cashSources',
  cashMovement: 'cashMovements',
  portfolioSetting: 'portfolioSettings',
  taxSetting: 'taxSettings',
  customAsset: 'customAssets',
  customAssetValue: 'customAssetPriceHistory',
  standingOrder: 'standingOrders',
  expenseCategory: 'expenseCategories',
  expenseTransaction: 'expenseTransactions',
  expenseRule: 'expenseRules',
  expenseBudget: 'expenseBudgets',
} as const satisfies Partial<Record<VaultEntityKind, string>>;

const SKIPPED = [
  ['import_batches', 'importBatches'],
  ['import_rows', 'importRows'],
  ['portfolio_daily_snapshots', 'portfolioSnapshots'],
  ['portfolio_snapshot_state', 'snapshotState'],
  ['standing_order_runs', 'standingOrderRuns'],
  ['expense_budget_fires', 'expenseBudgetFires'],
] as const;

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
 * Build an account-export-compatible archive entirely in browser memory.
 * A lock/version race after ZIP creation zeroes the produced buffer before the
 * typed abort is returned.
 */
export async function createClientCleartextExport(
  sync: VaultSyncEngine,
  options: ClientCleartextExportOptions = {},
): Promise<VaultMoneyOutcome<ClientCleartextExport>> {
  let archive: Uint8Array | null = null;
  try {
    options.signal?.throwIfAborted();
    const snapshot = validatedVaultSnapshot(sync);
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
      skippedTables: SKIPPED.map(([table, reasonKey]) => ({
        table,
        reason: localizedMessage(locale, `vaultExports.cleartext.skipped.${reasonKey}`),
      })).sort((left, right) => left.table.localeCompare(right.table)),
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
    assertVaultSnapshotCurrent(sync, snapshot);
    archive = await zipArchive(files, options.signal);
    // The worker callback resumes in a microtask. Yield once more so a lock task
    // queued during compression is observed before any bytes leave this method.
    await yieldToBrowserTask();
    options.signal?.throwIfAborted();
    assertVaultSnapshotCurrent(sync, snapshot);
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
  for (const [kind, name] of Object.entries(EXPORT_KINDS) as Array<
    [keyof typeof EXPORT_KINDS, string]
  >) {
    result[name] = liveEntities(document, kind).map((entity) => exportRow(kind, entity));
  }
  return result;
}

function exportRow(kind: keyof typeof EXPORT_KINDS, entity: VaultEntity): Record<string, unknown> {
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
  const holdings = new Map<string, { portfolioId: string; assetId: string; net: number }>();
  for (const transaction of transactions) {
    const key = `${transaction.portfolioId}:${transaction.assetId}`;
    const signed =
      (transaction.side === 'sell' ? -1 : 1) * finiteNumber(transaction.quantity, 'quantity');
    const current = holdings.get(key);
    if (current === undefined) {
      holdings.set(key, {
        portfolioId: transaction.portfolioId,
        assetId: transaction.assetId,
        net: signed,
      });
    } else {
      current.net += signed;
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
