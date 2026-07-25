import { z } from 'zod';

import { currencyCodeSchema } from './market';
import {
  cashMovementKindSchema,
  cashSourceTypeSchema,
  customTaxParamsSchema,
  portfolioVisibilitySchema,
  sourceTagSchema,
  taxCountrySchema,
  taxModeSchema,
  transactionSideSchema,
} from './portfolio';
import { EXPENSE_AMOUNT_MAX, expenseDirectionSchema, expenseRuleMatchTypeSchema } from './expenses';
import {
  STANDING_ORDER_AMOUNT_MAX,
  standingOrderCadenceSchema,
  standingOrderKindSchema,
  standingOrderStatusSchema,
} from './standingOrders';

/**
 * Paranoid mode — the client-encrypted vault (PROJECTPLAN.md §13.5 V5-P13 arc b;
 * `docs/paranoid-design.md` §1, §2, §4). This module is the **single source of
 * truth** for the on-disk/on-wire vault format across every storage medium
 * (BetterTrack server, the user's Google Drive, or both). It is deliberately
 * isomorphic (browser + Node) so the web/PWA client and the API derive the exact
 * same shapes.
 *
 * The server is a blind blob store with compare-and-swap: it never decrypts,
 * parses past the header it needs for CAS, logs, or indexes the payload. The key
 * never leaves the user's devices. The disable seam validates the decrypted
 * document with these strict contracts before any database write.
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

// ── Privacy mode + media set ─────────────────────────────────────────────────

/**
 * Account privacy mode (`users.privacy_mode`, `docs/paranoid-design.md` §1). It
 * is account metadata (present even in Drive-only mode) — knowing THAT a user is
 * paranoid is not portfolio data; it is required to enforce the §8 kill list.
 */
export const PRIVACY_MODES = ['normal', 'paranoid'] as const;
export const privacyModeSchema = z.enum(PRIVACY_MODES);
export type PrivacyMode = z.infer<typeof privacyModeSchema>;

/** A storage medium a blob syncs to (`§4`). */
export const VAULT_MEDIA = ['server', 'drive'] as const;
export const vaultMediumSchema = z.enum(VAULT_MEDIA);
export type VaultMedium = z.infer<typeof vaultMediumSchema>;

/**
 * The user's chosen media (`§4` mediaSet): a non-empty subset with no repeats.
 * `{server}` = server, `{drive}` = Drive-only, `{server, drive}` = both.
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
    /** Last version the Drive adapter attested, or null until it has one. */
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
export const vaultVersionSchema = z.number().int().min(1);

/** Argon2id parameters that wrap the vault key (cleartext, no portfolio data). */
export const vaultKdfParamsSchema = z
  .object({
    alg: z.literal(VAULT_KDF_ALG),
    m: z.number().int().positive(),
    t: z.number().int().positive(),
    p: z.number().int().positive(),
    salt: z.string().min(1),
  })
  .strict();
export type VaultKdfParams = z.infer<typeof vaultKdfParamsSchema>;

/** A passphrase-wrapped copy of the vault key. Multiple allow passphrase change. */
export const vaultWrappedKeySchema = z
  .object({
    keyId: z.string().uuid(),
    kdf: vaultKdfParamsSchema,
    wrappedVk: z.string().min(1),
  })
  .strict();
export type VaultWrappedKey = z.infer<typeof vaultWrappedKeySchema>;

/** The full cleartext envelope header (`§2`), with no portfolio information. */
export const vaultEnvelopeHeaderSchema = z
  .object({
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
  })
  .strict();
export type VaultEnvelopeHeader = z.infer<typeof vaultEnvelopeHeaderSchema>;

/** The only envelope-header fields a blind server store may read. */
export const vaultServerHeaderSchema = z.object({
  formatVersion: z.number().int().positive(),
  vaultVersion: vaultVersionSchema,
});
export type VaultServerHeader = z.infer<typeof vaultServerHeaderSchema>;

// ── Vault document v1 ────────────────────────────────────────────────────────

/** Every restore-source table has one corresponding discriminated entity kind. */
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
  'expenseCategory',
  'expenseTransaction',
  'expenseRule',
  'expenseBudget',
] as const;
export const vaultEntityKindSchema = z.enum(VAULT_ENTITY_KINDS);
export type VaultEntityKind = z.infer<typeof vaultEntityKindSchema>;

/** Sync metadata shared by every vault row. */
export const vaultEntityMetaSchema = z
  .object({
    id: z.string().uuid(),
    rev: z.number().int().nonnegative(),
    editedAt: z.string().datetime(),
    editedBy: z.string().uuid(),
    deletedAt: z.string().datetime().nullable(),
  })
  .strict();
export type VaultEntityMeta = z.infer<typeof vaultEntityMetaSchema>;

const uuidSchema = z.string().uuid();
const finiteNumberSchema = z.number().finite();
const MAX_STORAGE_MAGNITUDE = 1_000_000_000_000;

/**
 * Enforce the exact scale of a numeric column before the rehydration transaction
 * begins. The epsilon tolerates IEEE-754 representation of ordinary decimal
 * literals without accepting a real excess digit (for example 1.001 at scale 2).
 */
function decimalSchema(scale: number, min: number, max = MAX_STORAGE_MAGNITUDE) {
  const factor = 10 ** scale;
  return finiteNumberSchema
    .min(min)
    .max(max)
    .refine((value) => Math.abs(value * factor - Math.round(value * factor)) < 1e-7, {
      message: `must have at most ${scale} decimal places`,
    });
}

const quantitySchema = decimalSchema(8, Number.MIN_VALUE);
const storageAmountSchema = decimalSchema(6, 0);
const signedStorageAmountSchema = decimalSchema(6, -MAX_STORAGE_MAGNITUDE);
const positiveStorageAmountSchema = decimalSchema(6, Number.MIN_VALUE);
const signedCashAmountSchema = finiteNumberSchema
  .min(-MAX_STORAGE_MAGNITUDE)
  .max(MAX_STORAGE_MAGNITUDE)
  .refine((value) => value !== 0, 'must not be zero')
  .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-7, {
    message: 'must be a whole-cent EUR amount',
  });
const expenseAmountSchema = decimalSchema(2, Number.MIN_VALUE, EXPENSE_AMOUNT_MAX);
const standingOrderAmountSchema = decimalSchema(8, Number.MIN_VALUE, STANDING_ORDER_AMOUNT_MAX);
const isoDaySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO YYYY-MM-DD date')
  .refine((value) => {
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(Date.UTC(year!, month! - 1, day!));
    return (
      parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month! - 1 &&
      parsed.getUTCDate() === day
    );
  }, 'must be a real calendar date');

/** JSON-safe values for future portfolio-setting values; never permits undefined. */
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

const taxFactsShape = {
  taxMode: taxModeSchema.nullable(),
  taxCountry: taxCountrySchema.nullable(),
  taxAmountEur: signedStorageAmountSchema.nullable(),
  taxParams: customTaxParamsSchema.nullable(),
} as const;

function validateTaxFacts(
  value: {
    taxMode: z.infer<typeof taxModeSchema> | null;
    taxCountry: z.infer<typeof taxCountrySchema> | null;
    taxAmountEur: number | null;
    taxParams: z.infer<typeof customTaxParamsSchema> | null;
  },
  ctx: z.RefinementCtx,
): void {
  if (value.taxMode === null) {
    if (value.taxCountry !== null || value.taxAmountEur !== null || value.taxParams !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'tax details require a tax mode',
      });
    }
    return;
  }
  if ((value.taxMode === 'country_specific') !== (value.taxCountry !== null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['taxCountry'],
      message: 'country is required exactly for country_specific tax mode',
    });
  }
  if ((value.taxMode === 'custom') !== (value.taxParams !== null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['taxParams'],
      message: 'custom parameters are required exactly for custom tax mode',
    });
  }
  if (
    value.taxMode === 'manual_per_trade' &&
    value.taxAmountEur !== null &&
    value.taxAmountEur < 0
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['taxAmountEur'],
      message: 'manual per-trade tax amounts must not be negative',
    });
  }
}

const portfolioDataSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    visibility: portfolioVisibilitySchema,
    sortOrder: z.number().int().nonnegative(),
    defaultPayFromCash: z.boolean(),
    archivedAt: z.string().datetime().nullable(),
  })
  .strict();

const transactionDataSchema = z
  .object({
    portfolioId: uuidSchema,
    assetId: uuidSchema,
    side: transactionSideSchema,
    quantity: quantitySchema,
    price: storageAmountSchema,
    fee: storageAmountSchema,
    executedAt: z.string().datetime(),
    note: z.string().max(1000).nullable(),
    allowUncovered: z.boolean(),
    uncoveredEntryPrice: storageAmountSchema.nullable(),
    source: sourceTagSchema,
    ...taxFactsShape,
  })
  .strict()
  .superRefine((value, ctx) => {
    validateTaxFacts(value, ctx);
    if (value.side === 'buy' && (value.allowUncovered || value.uncoveredEntryPrice !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'uncovered fields apply only to sell transactions',
      });
    }
    if (value.uncoveredEntryPrice !== null && !value.allowUncovered) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['uncoveredEntryPrice'],
        message: 'an uncovered entry price requires allowUncovered',
      });
    }
  });

const cashSourceDataSchema = z
  .object({
    portfolioId: uuidSchema,
    name: z.string().trim().min(1).max(120),
    type: cashSourceTypeSchema,
    isMain: z.boolean(),
    archivedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();

const dividendDataSchema = z
  .object({
    portfolioId: uuidSchema,
    assetId: uuidSchema,
    cashSourceId: uuidSchema,
    grossAmountEur: positiveStorageAmountSchema,
    executedAt: z.string().datetime(),
    note: z.string().max(1000).nullable(),
    source: sourceTagSchema,
    ...taxFactsShape,
    taxMode: taxModeSchema,
  })
  .strict()
  .superRefine((value, ctx) => validateTaxFacts(value, ctx));

const cashMovementDataSchema = z
  .object({
    portfolioId: uuidSchema,
    sourceId: uuidSchema,
    kind: cashMovementKindSchema,
    amountEur: signedCashAmountSchema,
    transactionId: uuidSchema.nullable(),
    transferId: uuidSchema.nullable(),
    counterpartSourceId: uuidSchema.nullable(),
    dividendId: uuidSchema.nullable(),
    taxYear: z.number().int().min(1900).max(9999).nullable(),
    executedAt: z.string().datetime(),
    note: z.string().max(1000).nullable(),
    source: sourceTagSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const positiveKinds = new Set([
      'deposit',
      'sell_proceeds',
      'transfer_in',
      'dividend',
      'tax_refund',
    ]);
    if (
      (positiveKinds.has(value.kind) && value.amountEur <= 0) ||
      (!positiveKinds.has(value.kind) && value.amountEur >= 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['amountEur'],
        message: 'amount sign does not match movement kind',
      });
    }
    const isTransfer = value.kind === 'transfer_in' || value.kind === 'transfer_out';
    if (isTransfer !== (value.transferId !== null && value.counterpartSourceId !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'transfer identifiers are required exactly for transfer movements',
      });
    }
    const isTax = value.kind === 'tax_withholding' || value.kind === 'tax_refund';
    if (isTax !== (value.taxYear !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'tax year is required exactly for tax movements',
      });
    }
    if (value.kind === 'dividend' && value.dividendId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dividendId'],
        message: 'dividend movements require their dividend id',
      });
    }
  });

const portfolioSettingDataSchema = z
  .object({
    portfolioId: uuidSchema,
    key: z.string().trim().min(1).max(120),
    value: vaultJsonSchema,
    updatedAt: z.string().datetime(),
  })
  .strict();

const taxSettingDataSchema = z
  .object({
    mode: taxModeSchema,
    country: taxCountrySchema.nullable(),
    manualDefaultAmountEur: storageAmountSchema.nullable(),
    manualDefaultRatePct: z.number().min(0).max(100).finite().nullable(),
    customParams: customTaxParamsSchema.nullable(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.mode === 'country_specific') !== (value.country !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['country'],
        message: 'country is required exactly for country_specific mode',
      });
    }
    if ((value.mode === 'custom') !== (value.customParams !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['customParams'],
        message: 'custom parameters are required exactly for custom mode',
      });
    }
    if (
      value.mode !== 'manual_per_trade' &&
      (value.manualDefaultAmountEur !== null || value.manualDefaultRatePct !== null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'manual defaults apply only to manual_per_trade mode',
      });
    }
    if (value.manualDefaultAmountEur !== null && value.manualDefaultRatePct !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'only one manual default may be set' });
    }
  });

const customAssetDataSchema = z
  .object({
    providerId: z.literal('manual'),
    providerRef: uuidSchema,
    type: z.literal('custom'),
    symbol: z.string().trim().min(1).max(120),
    name: z.string().trim().min(1).max(300),
    exchange: z.string().max(120).nullable(),
    currency: currencyCodeSchema,
    category: z.enum(['stock', 'etf', 'crypto', 'commodity', 'cash_like', 'other']),
    smoothing: z.boolean(),
    recategorize: z.boolean(),
  })
  .strict();

// `price_history.close` is an unscaled numeric column, and the normal custom-asset
// value-point API accepts every finite non-negative number. Do not apply the
// transaction-money precision cap here or a valid vault could not be restored.
const customAssetValueCloseSchema = finiteNumberSchema.nonnegative();

const customAssetValueDataSchema = z
  .object({
    assetId: uuidSchema,
    date: isoDaySchema,
    close: customAssetValueCloseSchema,
  })
  .strict();

const standingOrderDataSchema = z
  .object({
    portfolioId: uuidSchema,
    kind: standingOrderKindSchema,
    assetId: uuidSchema.nullable(),
    amount: standingOrderAmountSchema,
    currency: currencyCodeSchema,
    label: z.string().trim().min(1).max(120).nullable(),
    cadence: standingOrderCadenceSchema,
    anchorDay: z.number().int().min(1).max(31).nullable(),
    startDate: isoDaySchema,
    endDate: isoDaySchema.nullable(),
    status: standingOrderStatusSchema,
    lastRunAt: z.string().datetime().nullable(),
    lastPeriodKey: isoDaySchema.nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.kind === 'buy-asset') !== (value.assetId !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assetId'],
        message: 'asset is required exactly for buy orders',
      });
    }
    if ((value.cadence === 'monthly') !== (value.anchorDay !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['anchorDay'],
        message: 'anchor day is required exactly for monthly orders',
      });
    }
    if (value.endDate !== null && value.endDate < value.startDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endDate'],
        message: 'end date cannot precede start date',
      });
    }
  });

const expenseCategoryDataSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    direction: expenseDirectionSchema,
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

const expenseTransactionDataSchema = z
  .object({
    categoryId: uuidSchema.nullable(),
    direction: expenseDirectionSchema,
    amount: expenseAmountSchema,
    currency: currencyCodeSchema,
    bookedOn: isoDaySchema,
    description: z.string().trim().min(1).max(500),
    source: sourceTagSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

const expenseRuleDataSchema = z
  .object({
    categoryId: uuidSchema,
    matchType: expenseRuleMatchTypeSchema,
    pattern: z.string().trim().min(1).max(200),
    priority: z.number().int().min(0).max(10_000),
    enabled: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

const expenseBudgetDataSchema = z
  .object({
    categoryId: uuidSchema,
    amount: expenseAmountSchema,
    currency: currencyCodeSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

const entity = <Kind extends VaultEntityKind, Data extends z.ZodTypeAny>(kind: Kind, data: Data) =>
  vaultEntityMetaSchema.extend({ kind: z.literal(kind), data }).strict();

/** Strict source-payload map, indexed by its discriminated vault entity kind. */
export const VAULT_ENTITY_SCHEMAS = {
  portfolio: entity('portfolio', portfolioDataSchema),
  transaction: entity('transaction', transactionDataSchema),
  dividend: entity('dividend', dividendDataSchema),
  cashSource: entity('cashSource', cashSourceDataSchema),
  cashMovement: entity('cashMovement', cashMovementDataSchema),
  portfolioSetting: entity('portfolioSetting', portfolioSettingDataSchema),
  taxSetting: entity('taxSetting', taxSettingDataSchema),
  customAsset: entity('customAsset', customAssetDataSchema),
  customAssetValue: entity('customAssetValue', customAssetValueDataSchema),
  standingOrder: entity('standingOrder', standingOrderDataSchema),
  expenseCategory: entity('expenseCategory', expenseCategoryDataSchema),
  expenseTransaction: entity('expenseTransaction', expenseTransactionDataSchema),
  expenseRule: entity('expenseRule', expenseRuleDataSchema),
  expenseBudget: entity('expenseBudget', expenseBudgetDataSchema),
} as const;

/** One source entity, strict and discriminated by `kind`. */
export const vaultEntitySchema = z.discriminatedUnion('kind', [
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
  VAULT_ENTITY_SCHEMAS.expenseCategory,
  VAULT_ENTITY_SCHEMAS.expenseTransaction,
  VAULT_ENTITY_SCHEMAS.expenseRule,
  VAULT_ENTITY_SCHEMAS.expenseBudget,
]);
export type VaultEntity = z.infer<typeof vaultEntitySchema>;

/** A merge diagnostic record (`§4`); the payload keeps the last 20. */
export const vaultMergeRecordSchema = z
  .object({
    mergedAt: z.string().datetime(),
    parents: z.array(vaultVersionSchema).min(1),
    into: vaultVersionSchema,
    deviceId: z.string().uuid(),
  })
  .strict();
export type VaultMergeRecord = z.infer<typeof vaultMergeRecordSchema>;

/**
 * Decrypted document version 1. Versions newer than 1 fail closed: an older
 * client cannot accidentally rewrite a document it does not understand.
 */
export const vaultDocumentV1Schema = z
  .object({
    schemaVersion: z.literal(VAULT_DOCUMENT_VERSION),
    entities: z.array(vaultEntitySchema),
    mergeLog: z.array(vaultMergeRecordSchema).max(20).default([]),
  })
  .strict()
  .superRefine((document, ctx) => {
    const ids = new Set<string>();
    for (const [index, entityValue] of document.entities.entries()) {
      if (ids.has(entityValue.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['entities', index, 'id'],
          message: 'vault entity ids must be unique across the document',
        });
      }
      ids.add(entityValue.id);
    }
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

/** Internal request supplied only after the client has decrypted its vault. */
export const paranoidDisableRehydrationRequestSchema = z
  .object({
    rehydrationId: z.string().uuid(),
    document: vaultDocumentV1Schema,
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

/** Vault metadata the server may expose without reading the encrypted payload. */
export const vaultMetadataSchema = z
  .object({
    version: vaultVersionSchema,
    formatVersion: z.number().int().positive(),
    sizeBytes: z.number().int().nonnegative(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type VaultMetadata = z.infer<typeof vaultMetadataSchema>;

/** Typed error codes the vault store raises in the standard `{ error }` envelope. */
export const VAULT_ERROR_CODES = {
  notFound: 'VAULT_NOT_FOUND',
  preconditionRequired: 'VAULT_PRECONDITION_REQUIRED',
  preconditionFailed: 'VAULT_PRECONDITION_FAILED',
  tooLarge: 'VAULT_TOO_LARGE',
  malformed: 'VAULT_MALFORMED',
} as const;
export type VaultErrorCode = (typeof VAULT_ERROR_CODES)[keyof typeof VAULT_ERROR_CODES];

/** The opaque `application/octet-stream` content type the vault blob rides on. */
export const VAULT_CONTENT_TYPE = 'application/octet-stream';

/** Format a strong ETag over a vault version (`ETag: "<version>"`). */
export function vaultEtag(version: number): string {
  return `"${version}"`;
}

/** Parse a vault version out of an `ETag` / `If-Match` value. */
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

/** Encode a header + ciphertext into the wire envelope. */
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

/** Split a wire envelope into its un-decrypted header and ciphertext parts. */
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

/** Read the two blind-store CAS fields from a vault envelope. */
export function readVaultServerHeader(bytes: Uint8Array): VaultServerHeader {
  const { header } = decodeVaultEnvelope(bytes);
  const parsed = vaultServerHeaderSchema.safeParse(header);
  if (!parsed.success) {
    throw new VaultEnvelopeError('vault envelope header missing formatVersion/vaultVersion');
  }
  return parsed.data;
}
