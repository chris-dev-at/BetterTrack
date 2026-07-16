import { z } from 'zod';

import { currencyCodeSchema } from './market';

/**
 * Broker CSV imports (PROJECTPLAN.md §13.4 V4-P8). Upload a broker's CSV export
 * → autodetect (or manually pick) the broker → the server parses it into a
 * normalized **staging** model (nothing touches the portfolio yet) → the client
 * shows a preview table with per-row flags → confirm applies the valid rows into
 * a chosen portfolio + cash source through the existing portfolio/tax services.
 *
 * Explicit non-goal (§13.4): automatic broker/bank **API** sync — imports are
 * always file-based and user-initiated.
 */

// --- Row taxonomy -----------------------------------------------------------

/**
 * Normalized row kinds a broker CSV can map to (§13.4 V4-P8): trades (`buy` /
 * `sell`, with fees where derivable), `dividend` income, and external cash
 * `deposit` / `withdrawal` movements.
 */
export const IMPORT_ROW_KINDS = ['buy', 'sell', 'dividend', 'deposit', 'withdrawal'] as const;
export const importRowKindSchema = z.enum(IMPORT_ROW_KINDS);
export type ImportRowKind = z.infer<typeof importRowKindSchema>;

/**
 * Per-row preview flag (§13.4 V4-P8): `mapped` = parsed + instrument resolved,
 * will apply; `unmapped` = parsed but its instrument could not be resolved
 * against the local catalog (excluded from apply, never silently matched);
 * `duplicate` = content-hash matches an existing row (or an earlier row of the
 * same file) — skipped on apply; `error` = the row itself is malformed
 * (reported, the rest of the file still lands).
 */
export const IMPORT_ROW_FLAGS = ['mapped', 'unmapped', 'duplicate', 'error'] as const;
export const importRowFlagSchema = z.enum(IMPORT_ROW_FLAGS);
export type ImportRowFlag = z.infer<typeof importRowFlagSchema>;

/**
 * Per-row apply outcome. `applied` landed; the `skipped_*` trio mirrors the
 * row's preview flag (nothing was attempted); `failed` was attempted but
 * rejected by the owning service (e.g. an overdraw) — reported, the remaining
 * rows still apply (per-row error tolerance, never all-or-nothing).
 */
export const IMPORT_ROW_RESULTS = [
  'applied',
  'skipped_duplicate',
  'skipped_unmapped',
  'skipped_error',
  'failed',
] as const;
export const importRowResultSchema = z.enum(IMPORT_ROW_RESULTS);
export type ImportRowResult = z.infer<typeof importRowResultSchema>;

/** Batch lifecycle: staged (`pending`) until confirmed (`applied`). */
export const IMPORT_BATCH_STATUSES = ['pending', 'applied'] as const;
export const importBatchStatusSchema = z.enum(IMPORT_BATCH_STATUSES);
export type ImportBatchStatus = z.infer<typeof importBatchStatusSchema>;

// --- Brokers ----------------------------------------------------------------

/**
 * One supported broker mapper. Ids are plain strings (not an enum) so adding a
 * broker is one API-side mapper module + fixture with **zero contract/framework
 * edits** (§13.4 V4-P8 pluggability criterion); the picker lists whatever
 * `GET /imports/brokers` returns.
 */
export const importBrokerSchema = z
  .object({
    id: z.string(),
    label: z.string(),
  })
  .strict();
export type ImportBroker = z.infer<typeof importBrokerSchema>;

/** `GET /imports/brokers` response — the supported mappers, for the picker. */
export const importBrokerListResponseSchema = z
  .object({ brokers: z.array(importBrokerSchema) })
  .strict();
export type ImportBrokerListResponse = z.infer<typeof importBrokerListResponseSchema>;

// --- Staged rows + batch ----------------------------------------------------

/** The resolved catalog asset a mapped row will book against (display snapshot). */
export const importRowAssetSchema = z
  .object({
    id: z.string().uuid(),
    symbol: z.string(),
    name: z.string(),
    currency: currencyCodeSchema,
  })
  .strict();
export type ImportRowAsset = z.infer<typeof importRowAssetSchema>;

/**
 * One staged (normalized) CSV row. Trade rows carry `quantity`/`price`/`fee` in
 * the file's stated `currency`; dividend and cash rows carry the EUR magnitude
 * in `amountEur` (the cash ledger is EUR-only, §14). `raw` is the original CSV
 * line for the preview's expandable detail; `message` explains an `error` /
 * `unmapped` flag. `result`/`resultMessage` are null until the batch is applied.
 */
export const importRowSchema = z
  .object({
    id: z.string().uuid(),
    /** 1-based line number in the uploaded file (header = line 1). */
    rowIndex: z.number().int(),
    raw: z.string(),
    kind: importRowKindSchema.nullable(),
    flag: importRowFlagSchema,
    message: z.string().nullable(),
    executedAt: z.string().datetime().nullable(),
    isin: z.string().nullable(),
    symbol: z.string().nullable(),
    name: z.string().nullable(),
    quantity: z.number().nullable(),
    price: z.number().nullable(),
    fee: z.number().nullable(),
    amountEur: z.number().nullable(),
    currency: z.string().nullable(),
    note: z.string().nullable(),
    asset: importRowAssetSchema.nullable(),
    result: importRowResultSchema.nullable(),
    resultMessage: z.string().nullable(),
  })
  .strict();
export type ImportRow = z.infer<typeof importRowSchema>;

/** Per-flag row counts for the batch header ("12 mapped · 1 duplicate · …"). */
export const importBatchCountsSchema = z
  .object({
    total: z.number().int(),
    mapped: z.number().int(),
    unmapped: z.number().int(),
    duplicate: z.number().int(),
    error: z.number().int(),
  })
  .strict();
export type ImportBatchCounts = z.infer<typeof importBatchCountsSchema>;

/** One staged import batch (an uploaded file), owner-scoped. */
export const importBatchSchema = z
  .object({
    id: z.string().uuid(),
    portfolioId: z.string().uuid(),
    brokerId: z.string(),
    brokerLabel: z.string(),
    filename: z.string(),
    status: importBatchStatusSchema,
    createdAt: z.string().datetime(),
    appliedAt: z.string().datetime().nullable(),
    counts: importBatchCountsSchema,
  })
  .strict();
export type ImportBatch = z.infer<typeof importBatchSchema>;

// --- Requests / responses ---------------------------------------------------

/** Upload size guard, shared by the API's multipart middleware and the client. */
export const IMPORT_MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Row-count guard per file — a staging table is a preview, not a data lake. */
export const IMPORT_MAX_ROWS = 5000;

/**
 * The non-file multipart fields of `POST /imports` (the CSV itself travels as
 * the `file` part). `brokerId` overrides autodetection; omitted → the server
 * detects the broker (400 `IMPORT_BROKER_UNRECOGNIZED` when it cannot).
 */
export const createImportBatchFieldsSchema = z
  .object({
    portfolioId: z.string().uuid(),
    brokerId: z.string().min(1).max(64).optional(),
  })
  .strict();
export type CreateImportBatchFields = z.infer<typeof createImportBatchFieldsSchema>;

/** Route params for `/imports/:batchId` operations. */
export const importBatchIdParamSchema = z.object({ batchId: z.string().uuid() }).strict();

/**
 * `POST /imports/:batchId/apply` body. `cashSourceId` picks the cash source
 * dividends and cash movements book against (the portfolio's Main when
 * omitted); `linkCashOnTrades` additionally funds buys from / credits sell
 * proceeds to that source (off by default — a partial CSV would otherwise
 * overdraw a ledger that never saw the broker's deposits).
 */
export const applyImportRequestSchema = z
  .object({
    cashSourceId: z.string().uuid().optional(),
    linkCashOnTrades: z.boolean().optional(),
  })
  .strict();
export type ApplyImportRequest = z.infer<typeof applyImportRequestSchema>;

/** `POST /imports` + `GET /imports/:batchId` response — the staged preview. */
export const importPreviewResponseSchema = z
  .object({
    batch: importBatchSchema,
    rows: z.array(importRowSchema),
  })
  .strict();
export type ImportPreviewResponse = z.infer<typeof importPreviewResponseSchema>;

/** One row's apply outcome inside the result report. */
export const importRowOutcomeSchema = z
  .object({
    id: z.string().uuid(),
    rowIndex: z.number().int(),
    kind: importRowKindSchema.nullable(),
    result: importRowResultSchema,
    message: z.string().nullable(),
  })
  .strict();
export type ImportRowOutcome = z.infer<typeof importRowOutcomeSchema>;

/** `POST /imports/:batchId/apply` response — the per-row result report. */
export const applyImportResponseSchema = z
  .object({
    batch: importBatchSchema,
    applied: z.number().int(),
    skipped: z.number().int(),
    failed: z.number().int(),
    rows: z.array(importRowOutcomeSchema),
  })
  .strict();
export type ApplyImportResponse = z.infer<typeof applyImportResponseSchema>;
