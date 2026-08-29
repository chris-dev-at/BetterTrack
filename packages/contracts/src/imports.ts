import { z } from 'zod';

import { CASH_TAGS_PER_ITEM_MAX } from './cash';
import { assetTypeSchema, currencyCodeSchema } from './market';

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
 * One near-match suggestion for an UNRESOLVED row (§13.4): a ranked hit the
 * local-catalog search already returned during exact-identity resolution that
 * did NOT match exactly. Purely informational — the row stays `unmapped`,
 * excluded from apply; nothing is ever auto-applied or auto-matched. At most
 * five per row, de-duplicated by symbol, INTERLEAVED across the lookup attempts
 * (best hit of each, then second of each, …) so the symbol attempt cannot
 * starve the ISIN and name attempts out of the list. Order is the searches'
 * own — no score is computed anywhere, because nothing was measured.
 */
export const IMPORT_ROW_CANDIDATE_LIMIT = 5;

/**
 * Length ceilings for the three PROVIDER-FED strings on a candidate.
 *
 * `SearchResultItem` bounds exactly the provider strings it already had a
 * reason to (`providerId` .max(64), `providerRef` .max(128)) and leaves
 * symbol/name/exchange open, which is tolerable for a transient search
 * response. A candidate is not transient: it is PERSISTED, once per staged row
 * referencing that identity, so an unbounded provider `name` is stored as many
 * times as the file mentions the instrument. These follow that same
 * provider-fed-string convention, sized to each field's realistic content —
 * tickers and MICs are short, instrument names are not.
 *
 * The API truncates to these at capture time rather than letting the schema
 * reject: an over-long name is cosmetic, and refusing the candidate would take
 * the row's whole suggestion list with it.
 */
export const IMPORT_ROW_CANDIDATE_SYMBOL_MAX = 32;
export const IMPORT_ROW_CANDIDATE_NAME_MAX = 256;
export const IMPORT_ROW_CANDIDATE_EXCHANGE_MAX = 64;

/**
 * How a row's instrument came to be resolved (#964, §16 2026-07-31).
 *
 * ABSENT means the staging pipeline resolved it by EXACT identity, which is
 * every row unless a human intervened. `'user'` marks a row a person pinned in
 * the wizard through `PATCH /imports/:batchId/rows/:rowId` — the provenance the
 * preview badges so a reviewer can tell a machine's exact match from a human's
 * choice at a glance.
 *
 * There is deliberately no `'ai'` member. A model never mints an asset id
 * anywhere in this subsystem: candidates are search hits, the wizard offers
 * them, and a person picks. If that ever changes it must change here, visibly,
 * rather than by widening what `'user'` quietly covers.
 *
 * Optional and additive, on the `candidates` precedent above.
 */
export const IMPORT_ROW_RESOLVED_BY = ['user'] as const;
export const importRowResolvedBySchema = z.enum(IMPORT_ROW_RESOLVED_BY);
export type ImportRowResolvedBy = z.infer<typeof importRowResolvedBySchema>;

/** A suggested candidate instrument: what a human needs to choose, no more. */
export const importRowCandidateSchema = z
  .object({
    id: z.string().uuid(),
    symbol: z.string().max(IMPORT_ROW_CANDIDATE_SYMBOL_MAX),
    name: z.string().max(IMPORT_ROW_CANDIDATE_NAME_MAX),
    currency: currencyCodeSchema,
    exchange: z.string().max(IMPORT_ROW_CANDIDATE_EXCHANGE_MAX).nullable(),
    type: assetTypeSchema,
  })
  .strict();
export type ImportRowCandidate = z.infer<typeof importRowCandidateSchema>;

/**
 * One staged (normalized) CSV row. Trade rows carry `quantity`/`price`/`fee` in
 * the file's stated `currency`; dividend and cash rows carry the EUR magnitude
 * in `amountEur` (the cash ledger is EUR-only, §14). `raw` is the original CSV
 * line for the preview's expandable detail; `message` explains an `error` /
 * `unmapped` flag. `result`/`resultMessage` are null until the batch is applied.
 *
 * `candidates` is OPTIONAL and additive (shipped mobile builds parse this
 * payload with zod): present only on rows whose instrument did NOT resolve,
 * carrying the near-matches the search already returned — never auto-applied.
 *
 * `ruleTagIds` is OPTIONAL and additive for the same reason: present only on a
 * cash row (`deposit` / `withdrawal`) whose memo one of the caller's own cash
 * rules matched at staging time, carrying the tag ids that rule assigns. It is
 * a PRE-COMPUTED SUGGESTION the user confirms with the rest of the preview, and
 * apply REPLAYS exactly these ids rather than re-running the rules — so a rule
 * edited or deleted between preview and apply can never make a confirmed tag
 * silently vanish. Ids only, no names: the client already holds the tag list,
 * and a 5000-row preview must not carry 5000 copies of the same labels.
 *
 * The ONE exception is the TAG ITSELF being deleted in that window: the id then
 * names nothing, so the movement books without it — silently, and the row still
 * reports `applied`, because failing a row whose cash is already in the ledger
 * would be the worse lie. `replayRuleTags` (API `importService`) states that
 * cell and the added-rule one in full.
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
    candidates: z.array(importRowCandidateSchema).max(IMPORT_ROW_CANDIDATE_LIMIT).optional(),
    ruleTagIds: z.array(z.string().uuid()).max(CASH_TAGS_PER_ITEM_MAX).optional(),
    resolvedBy: importRowResolvedBySchema.optional(),
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
 * Distinct market instruments per broker file. A normal statement repeats a
 * small holding set across many rows; 150 leaves ample headroom while bounding
 * the catalog/provider resolution work far below {@link IMPORT_MAX_ROWS}.
 */
export const IMPORT_MAX_DISTINCT_INSTRUMENTS = 150;

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

// --- What the wizard understood about the file ------------------------------

/**
 * The vocabulary a column can be labelled with (#964, §16 2026-07-31 "a wizard
 * that understands a whole file").
 *
 * This is the WIRE copy of the API's `columnMapping.MAPPABLE_FIELDS`. The two
 * are pinned equal by `genericStaging.test.ts` rather than imported across the
 * boundary, because `packages/contracts` must not depend on `apps/api` and the
 * API's list is also the AI prompt's security boundary — a silent divergence
 * would let a field exist in one half and not the other, so it is asserted
 * instead of assumed.
 */
export const IMPORT_MAPPABLE_FIELDS = [
  'date',
  'symbol',
  'isin',
  'description',
  'quantity',
  'price',
  'amount',
  'fee',
  'tax',
  'currency',
  'kindHint',
  'ignore',
] as const;
export const importMappableFieldSchema = z.enum(IMPORT_MAPPABLE_FIELDS);
export type ImportMappableField = z.infer<typeof importMappableFieldSchema>;

/**
 * Where a column's label came from. ABSENT = the deterministic pipeline (the
 * alias dictionary and/or value-shape evidence), which is every label unless
 * the optional heavy-tier fallback both was configured AND ran.
 *
 * `'ai'` marks a PROPOSAL, and the API guarantees three things about one that
 * this field exists to let the client honour: it is pinned to the review
 * confidence floor, it carries `needsReview: true` unconditionally, and it is
 * NEVER the column a value is read from. A client must therefore render an
 * `'ai'` entry as a suggestion awaiting confirmation — never as a mapping in
 * force, and never auto-applied.
 */
export const IMPORT_COLUMN_SOURCES = ['ai'] as const;
export const importColumnSourceSchema = z.enum(IMPORT_COLUMN_SOURCES);
export type ImportColumnSource = z.infer<typeof importColumnSourceSchema>;

/** A same-field contender, so an ambiguity is SHOWN rather than silently ranked. */
export const importColumnAlternativeSchema = z
  .object({ header: z.string(), confidence: z.number() })
  .strict();

/** One column's label: what it is, how sure, why, and whether a human must look. */
export const importColumnMappingSchema = z
  .object({
    header: z.string(),
    field: importMappableFieldSchema,
    /** [0..1]. AI proposals are pinned to the floor and never rise above it. */
    confidence: z.number(),
    /** The evidence that produced the label, in plain words. */
    reason: z.string(),
    needsReview: z.boolean(),
    /** Set on a contested winner: the close runner-up. */
    alternative: importColumnAlternativeSchema.optional(),
    /** Set when this column LOST a same-field contest: the column that beat it. */
    alternativeOf: importColumnAlternativeSchema.optional(),
    source: importColumnSourceSchema.optional(),
  })
  .strict();
export type ImportColumnMapping = z.infer<typeof importColumnMappingSchema>;

/**
 * What the generic pipeline worked out about an uploaded file — present only
 * for a batch staged through it (a file a broker mapper claimed reports
 * nothing here, because no column labelling happened).
 *
 * `mappings` includes AI PROPOSALS, distinguishable by `source: 'ai'`;
 * `unmappedHeaders` are the columns nothing could name at all. Together they
 * partition the file's header row, so a client counting either bucket still
 * accounts for every column.
 */
export const importUnderstandingSchema = z
  .object({
    mappings: z.array(importColumnMappingSchema),
    unmappedHeaders: z.array(z.string()),
    /** Detected delimiter/encoding/locales, for the "what I understood" panel. */
    delimiter: z.string(),
    encoding: z.string(),
    dateLocale: z.string(),
    numberLocale: z.string(),
    /** True when the date order is a GUESS — the client must force review. */
    dateLocaleAmbiguous: z.boolean(),
  })
  .strict();
export type ImportUnderstanding = z.infer<typeof importUnderstandingSchema>;

/**
 * `POST /imports` + `GET /imports/:batchId` response — the staged preview.
 *
 * `understanding` is OPTIONAL and additive (the `candidates` precedent): absent
 * for every broker-mapper batch and for every preview staged before #964.
 */
export const importPreviewResponseSchema = z
  .object({
    batch: importBatchSchema,
    rows: z.array(importRowSchema),
    understanding: importUnderstandingSchema.optional(),
  })
  .strict();
export type ImportPreviewResponse = z.infer<typeof importPreviewResponseSchema>;

/** Route params for `PATCH /imports/:batchId/rows/:rowId`. */
export const importRowIdParamSchema = z
  .object({ batchId: z.string().uuid(), rowId: z.string().uuid() })
  .strict();

/**
 * `PATCH /imports/:batchId/rows/:rowId` body — pin an unresolved row to an
 * asset (§16 2026-07-31 point 4: "resolvable IN the wizard … never a dead end
 * and never a silent mis-map").
 *
 * `assetId` is validated server-side with the SAME visibility rule as the
 * manual transaction path (a global catalog asset, or the caller's own custom
 * one). The row's `candidates` are UI suggestions, deliberately NOT the
 * validation boundary: the user may pin anything they could legitimately book
 * by hand, including a custom asset they just created. The hazard this
 * subsystem guards against is a MODEL minting an id, and no model reaches here.
 */
export const resolveImportRowRequestSchema = z.object({ assetId: z.string().uuid() }).strict();
export type ResolveImportRowRequest = z.infer<typeof resolveImportRowRequestSchema>;

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
