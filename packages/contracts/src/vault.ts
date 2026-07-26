import { z } from 'zod';

import { expenseDirectionSchema, expenseRuleMatchTypeSchema } from './expenses';
import {
  importBatchStatusSchema,
  importRowFlagSchema,
  importRowKindSchema,
  importRowResultSchema,
} from './imports';
import { currencyCodeSchema } from './market';
import {
  cashMovementKindSchema,
  cashSourceTypeSchema,
  portfolioVisibilitySchema,
  taxCountrySchema,
  taxModeSchema,
  transactionSideSchema,
} from './portfolio';
import {
  standingOrderCadenceSchema,
  standingOrderKindSchema,
  standingOrderStatusSchema,
} from './standingOrders';

/**
 * Paranoid mode — the client-encrypted vault (PROJECTPLAN.md §13.5 V5-P13 arc b;
 * `docs/paranoid-design.md` §1, §2, §4). This module is the **single source of
 * truth** for the on-disk/on-wire vault format across every storage medium
 * (BetterTrack server, the user's Google Drive, or both). It is deliberately
 * import-free and isomorphic (browser + Node) so the web/PWA client and the API
 * derive the exact same shapes.
 *
 * The server is a **blind blob store with compare-and-swap**: it never decrypts,
 * parses past the header it needs for CAS, logs, or indexes the payload. The two
 * fields it reads live in {@link vaultServerHeaderSchema}; everything else in the
 * envelope is opaque to it. The key never leaves the user's devices.
 *
 * Scope note (PD2): this file pins the envelope header, the structural vault
 * document v1, the media set, the privacy-mode values and the vault endpoint
 * DTOs. The concrete per-entity payload shapes inside {@link vaultDocumentV1Schema}
 * are refined by the client crypto/valuation work (PD4/PD7); v1 fixes the
 * envelope + entity-metadata contract they build on.
 */

// ── Format constants ─────────────────────────────────────────────────────────

/** ASCII magic prefixing every envelope (`docs/paranoid-design.md` §2). */
export const VAULT_MAGIC = 'BTVAULT1';
/** Big-endian byte length of the header-length prefix that follows the magic. */
export const VAULT_HEADER_LENGTH_PREFIX_BYTES = 4;
/** Envelope layout version (`formatVersion` in the header). */
export const VAULT_FORMAT_VERSION = 1;
/** Payload document version (`schemaVersion` in the header + document). */
export const VAULT_DOCUMENT_VERSION = 1;
/** Content cipher — WebCrypto AES-256-GCM (native on every target platform). */
export const VAULT_CONTENT_CIPHER = 'A256GCM';
/** KEK derivation — Argon2id (the server's own argon2id cost family). */
export const VAULT_KDF_ALG = 'argon2id';
/** Default server-enforced ciphertext size cap: 16 MiB (`§2`, env-tunable). */
export const VAULT_MAX_BYTES_DEFAULT = 16 * 1024 * 1024;
/** Default and hard per-request bounds for blind server-history enumeration. */
export const VAULT_HISTORY_PAGE_DEFAULT = 10;
export const VAULT_HISTORY_PAGE_MAX = 10;
/** PostgreSQL `integer` ceiling shared by live and retained vault versions. */
export const VAULT_VERSION_MAX = 2_147_483_647;

// ── Privacy mode + media set ─────────────────────────────────────────────────

/**
 * Account privacy mode (`users.privacy_mode`, `docs/paranoid-design.md` §1). It
 * is account metadata (present even in Drive-only mode) — knowing THAT a user is
 * paranoid is not portfolio data; it is required to enforce the §8 kill list.
 */
export const PRIVACY_MODES = ['normal', 'paranoid'] as const;
export const privacyModeSchema = z.enum(PRIVACY_MODES);
export type PrivacyMode = z.infer<typeof privacyModeSchema>;

/**
 * A storage medium a blob syncs to (`§4`). `server` = the BetterTrack blind
 * store; `drive` = the user's Google Drive appdata folder. Both are blind
 * compare-and-swap blob stores; the client picks a non-empty subset.
 */
export const VAULT_MEDIA = ['server', 'drive'] as const;
export const vaultMediumSchema = z.enum(VAULT_MEDIA);
export type VaultMedium = z.infer<typeof vaultMediumSchema>;

/**
 * The user's chosen media (`§4` mediaSet): a NON-EMPTY subset with no repeats.
 * `{server}` = server, `{drive}` = Drive-only (zero portfolio bytes server-
 * side), `{server, drive}` = both. The last medium can never be removed.
 */
export const vaultMediaSetSchema = z
  .array(vaultMediumSchema)
  .min(1, 'a media set must contain at least one medium')
  .refine((media) => new Set(media).size === media.length, {
    message: 'a media set must not repeat a medium',
  });
export type VaultMediaSet = z.infer<typeof vaultMediaSetSchema>;

/** Durable, portfolio-free media metadata held by the account transition seam. */
export const vaultMediaStateSchema = z
  .object({
    mediaSet: vaultMediaSetSchema,
    driveAttestedVersion: z.number().int().positive().nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.driveAttestedVersion !== null && !value.mediaSet.includes('drive')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['driveAttestedVersion'],
        message: 'a Drive attestation requires the Drive medium',
      });
    }
  });
export type VaultMediaState = z.infer<typeof vaultMediaStateSchema>;

// ── Version + envelope header ────────────────────────────────────────────────

/** The monotonic CAS token (`vaultVersion`). The first stored blob is 1. */
export const vaultVersionSchema = z.number().int().min(1).max(VAULT_VERSION_MAX);

/**
 * Public metadata for one retained server-history blob. This is deliberately
 * strict: no cleartext-derived counts, entity names, hashes or payload fields
 * may cross the blind-store boundary.
 */
export const vaultHistoryMetadataSchema = z
  .object({
    version: vaultVersionSchema,
    createdAt: z.string().datetime(),
    sizeBytes: z.number().int().positive(),
    medium: z.literal('server'),
  })
  .strict();
export type VaultHistoryMetadata = z.infer<typeof vaultHistoryMetadataSchema>;

/** Keyset pagination for `GET /vault/history`, newest version first. */
export const vaultHistoryListQuerySchema = z
  .object({
    cursor: z.coerce.number().int().min(1).max(VAULT_VERSION_MAX).optional(),
    limit: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();
export type VaultHistoryListQuery = z.infer<typeof vaultHistoryListQuerySchema>;

export const vaultHistoryListResponseSchema = z
  .object({
    items: z.array(vaultHistoryMetadataSchema),
    nextCursor: vaultVersionSchema.nullable(),
  })
  .strict();
export type VaultHistoryListResponse = z.infer<typeof vaultHistoryListResponseSchema>;

/** Route params for the opaque `GET /vault/history/:version` blob read. */
export const vaultHistoryVersionParamSchema = z
  .object({ version: z.coerce.number().int().min(1).max(VAULT_VERSION_MAX) })
  .strict();
export type VaultHistoryVersionParam = z.infer<typeof vaultHistoryVersionParamSchema>;

/** Argon2id parameters that wrap the vault key (cleartext, no portfolio data). */
export const vaultKdfParamsSchema = z.object({
  alg: z.literal(VAULT_KDF_ALG),
  m: z.number().int().positive(),
  t: z.number().int().positive(),
  p: z.number().int().positive(),
  salt: z.string().min(1),
});
export type VaultKdfParams = z.infer<typeof vaultKdfParamsSchema>;

/** A passphrase-wrapped copy of the vault key. Multiple allow passphrase change. */
export const vaultWrappedKeySchema = z.object({
  keyId: z.string().uuid(),
  kdf: vaultKdfParamsSchema,
  wrappedVk: z.string().min(1),
});
export type VaultWrappedKey = z.infer<typeof vaultWrappedKeySchema>;

/**
 * The full cleartext envelope header (`§2`). It carries ONLY counters, ids and
 * crypto parameters — never portfolio information. The whole header is bound as
 * GCM additional authenticated data, so any tampering (including edits to
 * `vaultVersion` or the wrapped keys) fails decryption on the client.
 *
 * This is the CLIENT-side contract (client-validated). The server never parses
 * the full header — see {@link vaultServerHeaderSchema} for the two fields it
 * reads.
 */
export const vaultEnvelopeHeaderSchema = z.object({
  formatVersion: z.literal(VAULT_FORMAT_VERSION),
  cipher: z.literal(VAULT_CONTENT_CIPHER),
  iv: z.string().min(1),
  keyId: z.string().uuid(),
  wrappedKeys: z.array(vaultWrappedKeySchema).min(1),
  vaultVersion: vaultVersionSchema,
  schemaVersion: z.number().int().positive(),
  deviceId: z.string().uuid(),
  writeId: z.string().uuid(),
  writtenAt: z.string().datetime(),
});
export type VaultEnvelopeHeader = z.infer<typeof vaultEnvelopeHeaderSchema>;

/**
 * The ONLY view of the header the server is allowed to read — the format version
 * and the monotonic CAS token. Non-strict, so it strips every other header field
 * on parse: the server literally cannot inspect the crypto parameters or wrapped
 * keys, let alone the ciphertext. This is the mechanical guarantee behind "the
 * server never parses past the header it needs for CAS" (`§2`).
 */
export const vaultServerHeaderSchema = z.object({
  formatVersion: z.number().int().positive(),
  vaultVersion: vaultVersionSchema,
});
export type VaultServerHeader = z.infer<typeof vaultServerHeaderSchema>;

// ── Vault document v1 (structural) ───────────────────────────────────────────

/**
 * The entity kinds that live in the encrypted vault document. This matches the
 * server's `PARANOID_TABLE_CLASSIFICATION` `vault` set, including persisted
 * derived snapshots so disable/rehydration can restore every classified row
 * without deriving or silently dropping columns.
 */
export const VAULT_ENTITY_KINDS = [
  'portfolio',
  'transaction',
  'dividend',
  'cashSource',
  'cashMovement',
  'portfolioSetting',
  'taxSetting',
  'customAsset',
  'customAssetValue',
  'standingOrder',
  'standingOrderRun',
  'importBatch',
  'importRow',
  'portfolioDailySnapshot',
  'portfolioSnapshotState',
  'expenseCategory',
  'expenseTransaction',
  'expenseRule',
  'expenseBudget',
  'expenseBudgetFire',
] as const;
export const vaultEntityKindSchema = z.enum(VAULT_ENTITY_KINDS);
export type VaultEntityKind = z.infer<typeof vaultEntityKindSchema>;

/**
 * Per-entity sync metadata (`§2`/`§4`): a uuidv7 id, a monotonic `rev` bumped on
 * every edit, an `editedAt` instant + the writing `editedBy` deviceId, and a
 * `deletedAt` tombstone (kept ≥ 180 days) so long-offline merges stay correct.
 * Newer clients also retain the current mutation id and the stable ids of every
 * multi-entity mutation that included this entity. Those optional fields keep
 * old v1 documents readable while preserving atomic membership across later
 * edits and offline reconciliation.
 */
export const vaultEntityMetaSchema = z.object({
  id: z.string().uuid(),
  rev: z.number().int().nonnegative(),
  editedAt: z.string().datetime(),
  editedBy: z.string().uuid(),
  deletedAt: z.string().datetime().nullable(),
  mutationId: z.string().uuid().optional(),
  atomicMutationIds: z.array(z.string().uuid()).optional(),
});
export type VaultEntityMeta = z.infer<typeof vaultEntityMetaSchema>;

/**
 * One vault entity: sync metadata plus its `data` payload. The payload is left
 * open (a JSON record) at v1 — the concrete per-kind shapes are pinned by the
 * client crypto/valuation work (PD4/PD7), which reuses the existing portfolio
 * contracts. Server code never sees this decrypted.
 */
export const vaultEntitySchema = vaultEntityMetaSchema.extend({
  data: z.record(z.string(), z.unknown()),
});
export type VaultEntity = z.infer<typeof vaultEntitySchema>;

// ── Strict restore-source document v1 ───────────────────────────────────────

/**
 * The shipped document-v1 envelope above remains readable by existing clients.
 * Disable/rehydration uses this separate strict graph: every persisted column
 * has one same-named field and every object rejects unknown fields. Keeping the
 * strict restore contract separate preserves the immutable v1 envelope while
 * allowing the server to fail closed before any restore write.
 */

const uuidSchema = z.string().uuid();
const timestampSchema = z.string().datetime();
const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const monthSchema = z.string().regex(/^\d{4}-\d{2}$/);
const decimalStringSchema = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/);

type VaultJson = null | boolean | number | string | VaultJson[] | { [key: string]: VaultJson };
const vaultJsonSchema: z.ZodType<VaultJson> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(vaultJsonSchema),
    z.record(vaultJsonSchema),
  ]),
);

const portfolioRowSchema = z
  .object({
    userId: uuidSchema,
    name: z.string(),
    visibility: portfolioVisibilitySchema,
    sortOrder: z.number().int(),
    defaultPayFromCash: z.boolean(),
    archivedAt: timestampSchema.nullable(),
  })
  .strict();

const transactionRowSchema = z
  .object({
    portfolioId: uuidSchema,
    assetId: uuidSchema,
    side: transactionSideSchema,
    quantity: decimalStringSchema,
    price: decimalStringSchema,
    fee: decimalStringSchema,
    executedAt: timestampSchema,
    note: z.string().nullable(),
    taxMode: taxModeSchema.nullable(),
    taxCountry: taxCountrySchema.nullable(),
    taxAmountEur: decimalStringSchema.nullable(),
    taxParams: vaultJsonSchema.nullable(),
    allowUncovered: z.boolean(),
    uncoveredEntryPrice: decimalStringSchema.nullable(),
    source: z.string(),
  })
  .strict();

const dividendRowSchema = z
  .object({
    portfolioId: uuidSchema,
    assetId: uuidSchema,
    cashSourceId: uuidSchema,
    grossAmountEur: decimalStringSchema,
    executedAt: timestampSchema,
    note: z.string().nullable(),
    taxMode: taxModeSchema,
    taxCountry: taxCountrySchema.nullable(),
    taxAmountEur: decimalStringSchema.nullable(),
    taxParams: vaultJsonSchema.nullable(),
    source: z.string(),
    createdAt: timestampSchema,
  })
  .strict();

const cashSourceRowSchema = z
  .object({
    portfolioId: uuidSchema,
    name: z.string(),
    type: cashSourceTypeSchema,
    isMain: z.boolean(),
    archivedAt: timestampSchema.nullable(),
    createdAt: timestampSchema,
  })
  .strict();

const cashMovementRowSchema = z
  .object({
    portfolioId: uuidSchema,
    sourceId: uuidSchema,
    kind: cashMovementKindSchema,
    amountEur: decimalStringSchema,
    transactionId: uuidSchema.nullable(),
    transferId: uuidSchema.nullable(),
    counterpartSourceId: uuidSchema.nullable(),
    dividendId: uuidSchema.nullable(),
    taxYear: z.number().int().nullable(),
    executedAt: timestampSchema,
    note: z.string().nullable(),
    source: z.string(),
    createdAt: timestampSchema,
  })
  .strict();

const portfolioSettingRowSchema = z
  .object({
    portfolioId: uuidSchema,
    key: z.string(),
    value: vaultJsonSchema,
    updatedAt: timestampSchema,
  })
  .strict();

const taxSettingRowSchema = z
  .object({
    userId: uuidSchema,
    mode: taxModeSchema,
    country: taxCountrySchema.nullable(),
    manualDefaultAmountEur: decimalStringSchema.nullable(),
    manualDefaultRatePct: decimalStringSchema.nullable(),
    customParams: vaultJsonSchema.nullable(),
    updatedAt: timestampSchema,
  })
  .strict();

const customAssetRowSchema = z
  .object({
    providerId: z.string(),
    providerRef: z.string(),
    ownerId: uuidSchema.nullable(),
    type: z.enum(['stock', 'etf', 'index', 'fx', 'commodity', 'crypto', 'custom']),
    symbol: z.string(),
    name: z.string(),
    exchange: z.string().nullable(),
    currency: currencyCodeSchema,
    meta: vaultJsonSchema.nullable(),
    searchText: z.string().nullable(),
  })
  .strict();

const customAssetValueRowSchema = z
  .object({
    assetId: uuidSchema,
    date: daySchema,
    close: decimalStringSchema,
  })
  .strict();

const standingOrderRowSchema = z
  .object({
    userId: uuidSchema,
    portfolioId: uuidSchema,
    kind: standingOrderKindSchema,
    assetId: uuidSchema.nullable(),
    amount: decimalStringSchema,
    currency: currencyCodeSchema,
    label: z.string().nullable(),
    cadence: standingOrderCadenceSchema,
    anchorDay: z.number().int().nullable(),
    startDate: daySchema,
    endDate: daySchema.nullable(),
    status: standingOrderStatusSchema,
    lastRunAt: timestampSchema.nullable(),
    lastPeriodKey: daySchema.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

const standingOrderRunRowSchema = z
  .object({
    standingOrderId: uuidSchema,
    periodKey: daySchema,
    bookedAt: timestampSchema,
  })
  .strict();

const importBatchRowSchema = z
  .object({
    ownerId: uuidSchema,
    portfolioId: uuidSchema,
    brokerId: z.string(),
    filename: z.string(),
    status: importBatchStatusSchema,
    cashSourceId: uuidSchema.nullable(),
    createdAt: timestampSchema,
    appliedAt: timestampSchema.nullable(),
  })
  .strict();

const importRowRowSchema = z
  .object({
    batchId: uuidSchema,
    rowIndex: z.number().int(),
    raw: z.string(),
    kind: importRowKindSchema.nullable(),
    flag: importRowFlagSchema,
    message: z.string().nullable(),
    executedAt: timestampSchema.nullable(),
    isin: z.string().nullable(),
    symbol: z.string().nullable(),
    name: z.string().nullable(),
    quantity: decimalStringSchema.nullable(),
    price: decimalStringSchema.nullable(),
    fee: decimalStringSchema.nullable(),
    amountEur: decimalStringSchema.nullable(),
    currency: currencyCodeSchema.nullable(),
    note: z.string().nullable(),
    assetId: uuidSchema.nullable(),
    contentHash: z.string().nullable(),
    result: importRowResultSchema.nullable(),
    resultMessage: z.string().nullable(),
  })
  .strict();

const portfolioDailySnapshotRowSchema = z
  .object({
    portfolioId: uuidSchema,
    date: daySchema,
    valueEur: decimalStringSchema,
    costBasisEur: decimalStringSchema,
    plEur: decimalStringSchema,
    flowEur: decimalStringSchema,
    cashBySource: vaultJsonSchema,
    assetValues: vaultJsonSchema,
    computedAt: timestampSchema,
  })
  .strict();

const portfolioSnapshotStateRowSchema = z
  .object({
    portfolioId: uuidSchema,
    computedThrough: daySchema,
    dirtyFrom: daySchema.nullable(),
    updatedAt: timestampSchema,
  })
  .strict();

const expenseCategoryRowSchema = z
  .object({
    userId: uuidSchema,
    name: z.string(),
    direction: expenseDirectionSchema,
    color: z.string(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

const expenseTransactionRowSchema = z
  .object({
    userId: uuidSchema,
    categoryId: uuidSchema.nullable(),
    direction: expenseDirectionSchema,
    amount: decimalStringSchema,
    currency: currencyCodeSchema,
    bookedOn: daySchema,
    description: z.string(),
    source: z.string(),
    dedupHash: z.string().nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

const expenseRuleRowSchema = z
  .object({
    userId: uuidSchema,
    categoryId: uuidSchema,
    matchType: expenseRuleMatchTypeSchema,
    pattern: z.string(),
    priority: z.number().int(),
    enabled: z.boolean(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

const expenseBudgetRowSchema = z
  .object({
    userId: uuidSchema,
    categoryId: uuidSchema,
    amount: decimalStringSchema,
    currency: currencyCodeSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

const expenseBudgetFireRowSchema = z
  .object({
    budgetId: uuidSchema,
    periodKey: monthSchema,
    firedAt: timestampSchema,
  })
  .strict();

/** Exact Drizzle property names carried by each strict entity's `data` row. */
export const VAULT_ENTITY_ROW_SCHEMAS = {
  portfolio: portfolioRowSchema,
  transaction: transactionRowSchema,
  dividend: dividendRowSchema,
  cashSource: cashSourceRowSchema,
  cashMovement: cashMovementRowSchema,
  portfolioSetting: portfolioSettingRowSchema,
  taxSetting: taxSettingRowSchema,
  customAsset: customAssetRowSchema,
  customAssetValue: customAssetValueRowSchema,
  standingOrder: standingOrderRowSchema,
  standingOrderRun: standingOrderRunRowSchema,
  importBatch: importBatchRowSchema,
  importRow: importRowRowSchema,
  portfolioDailySnapshot: portfolioDailySnapshotRowSchema,
  portfolioSnapshotState: portfolioSnapshotStateRowSchema,
  expenseCategory: expenseCategoryRowSchema,
  expenseTransaction: expenseTransactionRowSchema,
  expenseRule: expenseRuleRowSchema,
  expenseBudget: expenseBudgetRowSchema,
  expenseBudgetFire: expenseBudgetFireRowSchema,
} as const;

/**
 * Binding table-to-kind enrollment. The API completeness test compares this map
 * with `PARANOID_TABLE_CLASSIFICATION` and each table's Drizzle columns.
 */
export const VAULT_TABLE_ENTITY_KINDS = {
  portfolios: 'portfolio',
  transactions: 'transaction',
  dividends: 'dividend',
  portfolio_cash_sources: 'cashSource',
  portfolio_cash_movements: 'cashMovement',
  portfolio_settings: 'portfolioSetting',
  user_tax_settings: 'taxSetting',
  assets: 'customAsset',
  price_history: 'customAssetValue',
  standing_orders: 'standingOrder',
  standing_order_runs: 'standingOrderRun',
  import_batches: 'importBatch',
  import_rows: 'importRow',
  portfolio_daily_snapshots: 'portfolioDailySnapshot',
  portfolio_snapshot_state: 'portfolioSnapshotState',
  expense_categories: 'expenseCategory',
  expense_transactions: 'expenseTransaction',
  expense_rules: 'expenseRule',
  expense_budgets: 'expenseBudget',
  expense_budget_fires: 'expenseBudgetFire',
} as const satisfies Record<string, VaultEntityKind>;

const strictEntity = <Kind extends VaultEntityKind, Row extends z.AnyZodObject>(
  kind: Kind,
  data: Row,
) => vaultEntityMetaSchema.extend({ kind: z.literal(kind), data }).strict();

/** Strict per-kind entities used by restore validation and completeness tests. */
export const VAULT_ENTITY_SCHEMAS = {
  portfolio: strictEntity('portfolio', portfolioRowSchema),
  transaction: strictEntity('transaction', transactionRowSchema),
  dividend: strictEntity('dividend', dividendRowSchema),
  cashSource: strictEntity('cashSource', cashSourceRowSchema),
  cashMovement: strictEntity('cashMovement', cashMovementRowSchema),
  portfolioSetting: strictEntity('portfolioSetting', portfolioSettingRowSchema),
  taxSetting: strictEntity('taxSetting', taxSettingRowSchema),
  customAsset: strictEntity('customAsset', customAssetRowSchema),
  customAssetValue: strictEntity('customAssetValue', customAssetValueRowSchema),
  standingOrder: strictEntity('standingOrder', standingOrderRowSchema),
  standingOrderRun: strictEntity('standingOrderRun', standingOrderRunRowSchema),
  importBatch: strictEntity('importBatch', importBatchRowSchema),
  importRow: strictEntity('importRow', importRowRowSchema),
  portfolioDailySnapshot: strictEntity('portfolioDailySnapshot', portfolioDailySnapshotRowSchema),
  portfolioSnapshotState: strictEntity('portfolioSnapshotState', portfolioSnapshotStateRowSchema),
  expenseCategory: strictEntity('expenseCategory', expenseCategoryRowSchema),
  expenseTransaction: strictEntity('expenseTransaction', expenseTransactionRowSchema),
  expenseRule: strictEntity('expenseRule', expenseRuleRowSchema),
  expenseBudget: strictEntity('expenseBudget', expenseBudgetRowSchema),
  expenseBudgetFire: strictEntity('expenseBudgetFire', expenseBudgetFireRowSchema),
} as const;

export const vaultStrictEntitySchema = z.discriminatedUnion('kind', [
  VAULT_ENTITY_SCHEMAS.portfolio,
  VAULT_ENTITY_SCHEMAS.transaction,
  VAULT_ENTITY_SCHEMAS.dividend,
  VAULT_ENTITY_SCHEMAS.cashSource,
  VAULT_ENTITY_SCHEMAS.cashMovement,
  VAULT_ENTITY_SCHEMAS.portfolioSetting,
  VAULT_ENTITY_SCHEMAS.taxSetting,
  VAULT_ENTITY_SCHEMAS.customAsset,
  VAULT_ENTITY_SCHEMAS.customAssetValue,
  VAULT_ENTITY_SCHEMAS.standingOrder,
  VAULT_ENTITY_SCHEMAS.standingOrderRun,
  VAULT_ENTITY_SCHEMAS.importBatch,
  VAULT_ENTITY_SCHEMAS.importRow,
  VAULT_ENTITY_SCHEMAS.portfolioDailySnapshot,
  VAULT_ENTITY_SCHEMAS.portfolioSnapshotState,
  VAULT_ENTITY_SCHEMAS.expenseCategory,
  VAULT_ENTITY_SCHEMAS.expenseTransaction,
  VAULT_ENTITY_SCHEMAS.expenseRule,
  VAULT_ENTITY_SCHEMAS.expenseBudget,
  VAULT_ENTITY_SCHEMAS.expenseBudgetFire,
]);
export type VaultStrictEntity = z.infer<typeof vaultStrictEntitySchema>;

/** A merge diagnostic record (`§4`); the payload keeps the last 20. */
export const vaultMergeRecordSchema = z.object({
  mergedAt: z.string().datetime(),
  parents: z.array(vaultVersionSchema).min(1),
  into: vaultVersionSchema,
  deviceId: z.string().uuid(),
});
export type VaultMergeRecord = z.infer<typeof vaultMergeRecordSchema>;

/** Strict v1 restore payload; newer versions are rejected without coercion. */
export const vaultStrictDocumentV1Schema = z
  .object({
    schemaVersion: z.literal(VAULT_DOCUMENT_VERSION),
    entities: z.array(vaultStrictEntitySchema),
    mergeLog: z.array(vaultMergeRecordSchema).max(20).default([]),
  })
  .strict();
export type VaultStrictDocumentV1 = z.infer<typeof vaultStrictDocumentV1Schema>;

/**
 * The decrypted vault document, version 1 (`§2`). A per-kind map of sync-tracked
 * entities plus a bounded merge log. Clients migrate older documents forward
 * with pure `v(n)→v(n+1)` functions and write back at the current version; a
 * client meeting a newer version than it knows goes read-only, never destructive.
 */
export const vaultDocumentV1Schema = z.object({
  schemaVersion: z.literal(VAULT_DOCUMENT_VERSION),
  entities: z.record(vaultEntityKindSchema, z.array(vaultEntitySchema)),
  mergeLog: z.array(vaultMergeRecordSchema).max(20).default([]),
});
export type VaultDocumentV1 = z.infer<typeof vaultDocumentV1Schema>;

// ── Internal disable / rehydration DTOs ──────────────────────────────────────

/** Deterministic, repeat-safe post-commit work. It must never run in the transaction. */
export const PARANOID_REHYDRATION_INVALIDATIONS = [
  'account',
  'portfolio',
  'expenses',
  'standingOrders',
  'tax',
] as const;
export const paranoidRehydrationPostCommitPlanSchema = z
  .object({
    invalidate: z.array(z.enum(PARANOID_REHYDRATION_INVALIDATIONS)),
  })
  .strict();
export type ParanoidRehydrationPostCommitPlan = z.infer<
  typeof paranoidRehydrationPostCommitPlanSchema
>;

/** Internal request supplied only after the client has decrypted its strict restore graph. */
export const paranoidDisableRehydrationRequestSchema = z
  .object({
    rehydrationId: z.string().uuid(),
    document: vaultStrictDocumentV1Schema,
  })
  .strict();
export type ParanoidDisableRehydrationRequest = z.infer<
  typeof paranoidDisableRehydrationRequestSchema
>;

/** Non-sensitive receipt: no row counts, hashes, keys, or cleartext metadata. */
export const paranoidDisableRehydrationResultSchema = z
  .object({
    rehydrationId: z.string().uuid(),
    completedAt: z.string().datetime(),
    idempotent: z.boolean(),
    postCommit: paranoidRehydrationPostCommitPlanSchema,
  })
  .strict();
export type ParanoidDisableRehydrationResult = z.infer<
  typeof paranoidDisableRehydrationResultSchema
>;

// ── Endpoint DTOs + metadata ─────────────────────────────────────────────────

/**
 * Vault metadata the server MAY expose without ever reading the payload (`§11`
 * `DataHome.info()`, `§12` admin): the CAS version, the format version, the
 * ciphertext size and when it last changed. No portfolio numbers — that IS the
 * feature.
 */
export const vaultMetadataSchema = z.object({
  version: vaultVersionSchema,
  formatVersion: z.number().int().positive(),
  sizeBytes: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
});
export type VaultMetadata = z.infer<typeof vaultMetadataSchema>;

/**
 * Typed error codes the vault store raises in the standard `{ error }` envelope
 * (§8):
 *  - `VAULT_NOT_FOUND` (404): no blob exists yet for this account/medium.
 *  - `VAULT_PRECONDITION_REQUIRED` (428): a `PUT` carried neither `If-Match`
 *    (replace) nor `If-None-Match: *` (create) — CAS is mandatory.
 *  - `VAULT_PRECONDITION_FAILED` (412): the supplied precondition lost the CAS
 *    race — a stale/missing version. Newer ciphertext is NEVER overwritten.
 *  - `VAULT_TOO_LARGE` (413): the payload exceeds the configured size cap.
 *  - `VAULT_MALFORMED` (400): the bytes are not a well-formed envelope (bad
 *    magic/length prefix/header, or a non-advancing version).
 */
export const VAULT_ERROR_CODES = {
  notFound: 'VAULT_NOT_FOUND',
  modeRequired: 'VAULT_PARANOID_MODE_REQUIRED',
  preconditionRequired: 'VAULT_PRECONDITION_REQUIRED',
  preconditionFailed: 'VAULT_PRECONDITION_FAILED',
  tooLarge: 'VAULT_TOO_LARGE',
  malformed: 'VAULT_MALFORMED',
} as const;
export type VaultErrorCode = (typeof VAULT_ERROR_CODES)[keyof typeof VAULT_ERROR_CODES];

/** The opaque `application/octet-stream` content type the vault blob rides on. */
export const VAULT_CONTENT_TYPE = 'application/octet-stream';
/** Safe metadata headers accompanying one raw historical ciphertext response. */
export const VAULT_HISTORY_CREATED_AT_HEADER = 'X-BetterTrack-Vault-Created-At';
export const VAULT_HISTORY_MEDIUM_HEADER = 'X-BetterTrack-Vault-Medium';
export const VAULT_HISTORY_SIZE_BYTES_HEADER = 'X-BetterTrack-Vault-Size-Bytes';

/** Format a strong ETag over a vault version (`ETag: "<version>"`). */
export function vaultEtag(version: number): string {
  return `"${version}"`;
}

/**
 * Parse a vault version out of an `ETag` / `If-Match` value. Accepts an optional
 * weak marker and quotes; returns the integer version, or `null` when the value
 * is absent or not a bare non-negative integer (so `*` and lists are rejected —
 * the vault CAS is only ever against one concrete version).
 */
export function parseVaultEtag(value: string | undefined | null): number | null {
  if (value == null) return null;
  const bare = value
    .trim()
    .replace(/^W\//i, '')
    .replace(/^"(.*)"$/, '$1');
  if (!/^\d+$/.test(bare)) return null;
  const n = Number(bare);
  return Number.isSafeInteger(n) ? n : null;
}

// ── Envelope codec (isomorphic) ──────────────────────────────────────────────

/** Thrown when raw bytes are not a well-formed vault envelope. */
export class VaultEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultEnvelopeError';
  }
}

const MAGIC_BYTES = new Uint8Array(VAULT_MAGIC.length);
for (let i = 0; i < VAULT_MAGIC.length; i += 1) MAGIC_BYTES[i] = VAULT_MAGIC.charCodeAt(i);
const ENVELOPE_PREFIX_BYTES = VAULT_MAGIC.length + VAULT_HEADER_LENGTH_PREFIX_BYTES;

/**
 * Encode a header + ciphertext into the wire envelope: magic · 4-byte big-endian
 * header length · UTF-8 JSON header · ciphertext (`§2`). Pure and isomorphic.
 */
export function encodeVaultEnvelope(
  header: VaultEnvelopeHeader | Record<string, unknown>,
  ciphertext: Uint8Array,
): Uint8Array {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(ENVELOPE_PREFIX_BYTES + headerBytes.length + ciphertext.length);
  out.set(MAGIC_BYTES, 0);
  new DataView(out.buffer).setUint32(VAULT_MAGIC.length, headerBytes.length, false);
  out.set(headerBytes, ENVELOPE_PREFIX_BYTES);
  out.set(ciphertext, ENVELOPE_PREFIX_BYTES + headerBytes.length);
  return out;
}

/**
 * Split a wire envelope into its parts WITHOUT decrypting: the parsed JSON header
 * (still `unknown` — callers validate with the schema they are entitled to) and
 * the ciphertext slice. Throws {@link VaultEnvelopeError} on any malformation.
 * This is the only read the server performs on a blob.
 */
export function decodeVaultEnvelope(bytes: Uint8Array): {
  header: unknown;
  headerBytes: Uint8Array;
  ciphertext: Uint8Array;
} {
  if (bytes.length < ENVELOPE_PREFIX_BYTES) {
    throw new VaultEnvelopeError('vault envelope shorter than its fixed prefix');
  }
  for (let i = 0; i < MAGIC_BYTES.length; i += 1) {
    if (bytes[i] !== MAGIC_BYTES[i]) throw new VaultEnvelopeError('bad vault envelope magic');
  }
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    VAULT_MAGIC.length,
    false,
  );
  const headerStart = ENVELOPE_PREFIX_BYTES;
  const headerEnd = headerStart + headerLength;
  if (headerEnd > bytes.length) {
    throw new VaultEnvelopeError('vault envelope header length exceeds the blob');
  }
  const headerBytes = bytes.subarray(headerStart, headerEnd);
  let header: unknown;
  try {
    header = JSON.parse(new TextDecoder().decode(headerBytes));
  } catch {
    throw new VaultEnvelopeError('vault envelope header is not valid JSON');
  }
  return { header, headerBytes, ciphertext: bytes.subarray(headerEnd) };
}

/**
 * Server-side header read: decode the envelope prefix and validate ONLY the two
 * fields the blind store is entitled to ({@link vaultServerHeaderSchema}). Throws
 * {@link VaultEnvelopeError} on a malformed envelope or an invalid header.
 */
export function readVaultServerHeader(bytes: Uint8Array): VaultServerHeader {
  const { header } = decodeVaultEnvelope(bytes);
  const parsed = vaultServerHeaderSchema.safeParse(header);
  if (!parsed.success) {
    throw new VaultEnvelopeError('vault envelope header missing formatVersion/vaultVersion');
  }
  return parsed.data;
}
