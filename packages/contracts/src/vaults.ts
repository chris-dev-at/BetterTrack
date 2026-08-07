import { z } from 'zod';

import { VAULT_DOCUMENT_V1_VERSION, vaultStrictEntitySchema } from './vault';

/**
 * Vaults v2 (`docs/VAULTS_V2_DESIGN.md`) — named, user-owned containers holding
 * one or more PARANOID portfolios. The account-level `vault.ts` contract stays
 * the crypto substrate and keeps serving the legacy account-singleton routes;
 * this module is the multi-vault surface layered beside it.
 *
 * The server is BLIND here in exactly the same sense as the account vault: it
 * stores ciphertext, caps its size, and versions it for compare-and-swap. The
 * only cleartext a vault carries is its user-chosen `name` and its `backends`
 * selection, both of which are deliberately non-secret (§1).
 */

// ── Cleartext vault metadata ────────────────────────────────────────────────

/** A vault name is a user-facing label ("Drive vault"), never secret data. */
export const VAULT_NAME_MAX_LENGTH = 64;

/**
 * Storage backend selection (§1, extensible). `both` means the client mirrors
 * the same documents to the server AND to Drive; `drive` means the server holds
 * no ciphertext for this vault at all and its `vault_docs` rows stay absent.
 */
export const VAULT_BACKENDS = ['server', 'drive', 'both'] as const;
export const vaultBackendsSchema = z.enum(VAULT_BACKENDS);
export type VaultBackends = z.infer<typeof vaultBackendsSchema>;

/** Whether a backend selection keeps ciphertext on the server. */
export function vaultBackendsUseServer(backends: VaultBackends): boolean {
  return backends === 'server' || backends === 'both';
}

/**
 * Which document a `vault_docs` row carries. Three kinds per vault (r2 §8):
 * one `header` (kdfSalt + keySlots[] + the portfolio index), one `common`
 * (every account/vault-scoped entity kind, namespaced per vault), and one
 * `portfolio` per member portfolio. All three are CAS-versioned independently,
 * which is what makes r2's single-blob mutation rule expressible.
 */
export const VAULT_DOC_KINDS = ['header', 'common', 'portfolio'] as const;
export const vaultDocKindSchema = z.enum(VAULT_DOC_KINDS);
export type VaultDocKind = z.infer<typeof vaultDocKindSchema>;

// ── Size caps ───────────────────────────────────────────────────────────────

/**
 * Per-kind size caps (r2 §8). The header carries `kdfSalt`, `keySlots[]` and the
 * portfolio index — bounded by construction, so a small cap is a real integrity
 * check rather than a courtesy limit. `common` carries the account/vault-scoped
 * entity kinds; a portfolio blob carries one portfolio's whole ledger.
 */
export const VAULT_HEADER_MAX_BYTES = 1024 * 1024;
export const VAULT_COMMON_DOC_MAX_BYTES = 4 * 1024 * 1024;
export const VAULT_PORTFOLIO_DOC_MAX_BYTES = 8 * 1024 * 1024;

export const VAULT_DOC_MAX_BYTES: Readonly<Record<VaultDocKind, number>> = {
  header: VAULT_HEADER_MAX_BYTES,
  common: VAULT_COMMON_DOC_MAX_BYTES,
  portfolio: VAULT_PORTFOLIO_DOC_MAX_BYTES,
};

export function vaultDocMaxBytes(kind: VaultDocKind): number {
  return VAULT_DOC_MAX_BYTES[kind];
}

// ── Error codes ─────────────────────────────────────────────────────────────

/**
 * The wire error codes (r2 §15). The first ten are the contract's canonical set
 * and ship with EN + DE strings in the platform i18n catalog; the four below
 * them cover join/leave outcomes the canonical ten cannot express and are
 * flagged as a contract gap rather than silently folded into a neighbouring
 * code.
 */
export const VAULT2_ERROR_CODES = {
  /** No vault or document with that id belongs to the caller. Also the cross-user answer. */
  notFound: 'VAULT_NOT_FOUND',
  /** Delete refused: portfolios still belong to the vault (§3 "only when empty"). */
  notEmpty: 'VAULT_NOT_EMPTY',
  /** `If-Match` disagreed with the stored version — the CAS answer, 412, with `currentVersion`. */
  versionConflict: 'VAULT_VERSION_CONFLICT',
  /** Ciphertext exceeded {@link vaultDocMaxBytes} for its kind, 413. */
  docTooLarge: 'VAULT_DOC_TOO_LARGE',
  /** A write arrived for a vault the client has not unlocked (client-enforced; server code for completeness). */
  lockedWriteRefused: 'VAULT_LOCKED_WRITE_REFUSED',
  /** Another client holds the live v1→v2 migration claim, 409. */
  migrationClaimed: 'VAULT_MIGRATION_CLAIMED',
  /** A migration flip arrived without a live claim, or the claim expired, 409. */
  migrationIncomplete: 'VAULT_MIGRATION_INCOMPLETE',
  /** One mutation would touch two documents — refused per r2 §8's single-blob rule. */
  crossBlobRefused: 'VAULT_CROSS_BLOB_REFUSED',
  /** The stored `formatVersion` is newer than this client can read. */
  formatUpdateRequired: 'VAULT_FORMAT_UPDATE_REQUIRED',
  /** The requested backend holds no ciphertext for this vault (e.g. drive-only), 409. */
  backendUnavailable: 'VAULT_BACKEND_UNAVAILABLE',

  // ── Beyond r2 §15's ten (contract gap, see the report) ───────────────────
  /** A write arrived without `If-Match` / `If-None-Match: *`, 428. */
  preconditionRequired: 'VAULT_PRECONDITION_REQUIRED',
  /** Two vaults of one account may not share a name, 409. */
  nameTaken: 'VAULT_NAME_TAKEN',
  /** Join refused: the portfolio already belongs to a vault, 409. */
  alreadyVaulted: 'VAULT_PORTFOLIO_ALREADY_VAULTED',
  /** Join refused: a precondition (mirrorchain membership) holds, 409. */
  joinBlocked: 'VAULT_JOIN_BLOCKED',
  /** The leave restore payload did not satisfy the portfolio-scoped invariants, 400. */
  restoreInvalid: 'VAULT_RESTORE_INVALID',
} as const;

/** Exactly the ten codes r2 §15 requires EN + DE strings for. */
export const VAULT2_CANONICAL_ERROR_CODES = [
  'VAULT_NOT_FOUND',
  'VAULT_NOT_EMPTY',
  'VAULT_VERSION_CONFLICT',
  'VAULT_DOC_TOO_LARGE',
  'VAULT_LOCKED_WRITE_REFUSED',
  'VAULT_MIGRATION_CLAIMED',
  'VAULT_MIGRATION_INCOMPLETE',
  'VAULT_CROSS_BLOB_REFUSED',
  'VAULT_FORMAT_UPDATE_REQUIRED',
  'VAULT_BACKEND_UNAVAILABLE',
] as const;

export type Vault2ErrorCode = (typeof VAULT2_ERROR_CODES)[keyof typeof VAULT2_ERROR_CODES];

// ── Vault DTOs ──────────────────────────────────────────────────────────────

const vaultNameSchema = z.string().trim().min(1).max(VAULT_NAME_MAX_LENGTH);

/** Base64 ciphertext as it rides on JSON request/response bodies. */
const ciphertextBase64Schema = z
  .string()
  .min(1)
  // Ceiling in base64 characters for the largest document kind; the exact byte
  // cap is re-checked after decoding, this only bounds the parse itself.
  .max(Math.ceil((VAULT_PORTFOLIO_DOC_MAX_BYTES * 4) / 3) + 4)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'ciphertext must be standard base64');

/**
 * The session-surface vault DTO. `portfolioCount` is cleartext bookkeeping the
 * server already knows (`portfolios.vault_id` is a server column) and is what
 * the delete-only-when-empty affordance renders from.
 */
export const vaultSchema = z
  .object({
    id: z.string().uuid(),
    name: vaultNameSchema,
    backends: vaultBackendsSchema,
    /** Which portfolios belong to this vault (r2 §15's membership exposure). */
    portfolioIds: z.array(z.string().uuid()),
    portfolioCount: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type Vault = z.infer<typeof vaultSchema>;

export const vaultListResponseSchema = z.object({ vaults: z.array(vaultSchema) }).strict();
export type VaultListResponse = z.infer<typeof vaultListResponseSchema>;

/**
 * The bearer (`vault:sync`) list projection. r2 §15 makes vault MEMBERSHIP
 * (vaultIds + names + which portfolios) available to the owning account's
 * authenticated clients, which a sync client needs in order to know which
 * portfolio documents to fetch; it stays narrower than {@link vaultSchema} in
 * that it carries no timestamps. All of it is metadata the server already holds
 * in cleartext (r2 §14 states that plainly), never document content.
 */
export const vaultSyncSummarySchema = z
  .object({
    id: z.string().uuid(),
    name: vaultNameSchema,
    backends: vaultBackendsSchema,
    portfolioIds: z.array(z.string().uuid()),
  })
  .strict();
export type VaultSyncSummary = z.infer<typeof vaultSyncSummarySchema>;

export const vaultSyncListResponseSchema = z
  .object({ vaults: z.array(vaultSyncSummarySchema) })
  .strict();
export type VaultSyncListResponse = z.infer<typeof vaultSyncListResponseSchema>;

/**
 * Create takes the CLIENT-BUILT header (§3 "server stores blindly"). The server
 * never parses it: it checks the size cap, stores the bytes at version 1, and
 * returns the vault plus that version. A `drive`-only vault omits the header —
 * there is no server ciphertext for it by definition.
 */
export const createVaultRequestSchema = z
  .object({
    name: vaultNameSchema,
    backends: vaultBackendsSchema,
    header: ciphertextBase64Schema.optional(),
  })
  .strict()
  .refine((value) => vaultBackendsUseServer(value.backends) === (value.header !== undefined), {
    message: 'a server-backed vault must supply its header; a drive-only vault must not',
    path: ['header'],
  });
export type CreateVaultRequest = z.infer<typeof createVaultRequestSchema>;

/** Name and backend selection are the only mutable cleartext fields (§3). */
export const updateVaultRequestSchema = z
  .object({
    name: vaultNameSchema.optional(),
    backends: vaultBackendsSchema.optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.backends !== undefined, {
    message: 'supply at least one of name or backends',
  });
export type UpdateVaultRequest = z.infer<typeof updateVaultRequestSchema>;

/** Non-secret CAS metadata for one stored document. */
export const vaultDocMetadataSchema = z
  .object({
    vaultId: z.string().uuid(),
    docKind: vaultDocKindSchema,
    portfolioId: z.string().uuid().nullable(),
    version: z.number().int().positive(),
    sizeBytes: z.number().int().nonnegative(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type VaultDocMetadata = z.infer<typeof vaultDocMetadataSchema>;

export const vaultCreateResponseSchema = z
  .object({
    vault: vaultSchema,
    header: vaultDocMetadataSchema.nullable(),
  })
  .strict();
export type VaultCreateResponse = z.infer<typeof vaultCreateResponseSchema>;

/**
 * The 412 body every CAS surface returns (r2 §15). `currentVersion` is the
 * server's stored version for the addressed document, so a client that lost the
 * race can re-fetch and merge without a second round trip. It is `null` only
 * when the document does not exist at all (an `If-Match` against nothing).
 */
export const vaultVersionConflictResponseSchema = z
  .object({
    error: z.object({
      code: z.literal(VAULT2_ERROR_CODES.versionConflict),
      message: z.string(),
      details: z.unknown().optional(),
    }),
    currentVersion: z.number().int().positive().nullable(),
  })
  .strict();
export type VaultVersionConflictResponse = z.infer<typeof vaultVersionConflictResponseSchema>;

// ── v1 → v2 migration protocol (r2 §11) ─────────────────────────────────────

/** How long a migration claim survives without a renew. */
export const VAULT_MIGRATION_CLAIM_TTL_MS = 15 * 60 * 1000;

const clientNonceSchema = z
  .string()
  .trim()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

/**
 * Server-coordinated v1 → v2 migration state, stored on the LEGACY account
 * vault row. Exactly one client at a time holds the claim; after the flip the
 * legacy vault is a read-only tombstone and `migratedTo` names its successor.
 */
export const vaultMigrationStateSchema = z
  .object({
    /** False when the account has no legacy vault at all — nothing to migrate. */
    legacyPresent: z.boolean(),
    migratingBy: clientNonceSchema.nullable(),
    claimExpiresAt: z.string().datetime().nullable(),
    migratedTo: z.string().uuid().nullable(),
  })
  .strict();
export type VaultMigrationState = z.infer<typeof vaultMigrationStateSchema>;

export const vaultMigrationClaimRequestSchema = z
  .object({ clientNonce: clientNonceSchema })
  .strict();
export type VaultMigrationClaimRequest = z.infer<typeof vaultMigrationClaimRequestSchema>;

export const vaultMigrationFlipRequestSchema = z
  .object({ clientNonce: clientNonceSchema, vaultId: z.string().uuid() })
  .strict();
export type VaultMigrationFlipRequest = z.infer<typeof vaultMigrationFlipRequestSchema>;

// ── Join / leave ────────────────────────────────────────────────────────────

/**
 * Join (`POST /portfolios/{id}/vault`): the client has already encrypted the
 * portfolio into `blob`. One server transaction stores it, purges that
 * portfolio's cleartext rows and sets `portfolios.vault_id` (§3).
 */
export const vaultJoinRequestSchema = z
  .object({
    vaultId: z.string().uuid(),
    blob: ciphertextBase64Schema,
  })
  .strict();
export type VaultJoinRequest = z.infer<typeof vaultJoinRequestSchema>;

/**
 * The portfolio-scoped restore graph posted back on leave. It reuses the
 * account-level strict entity union verbatim — same kinds, same per-column
 * strictness — narrowed to the kinds that are scoped to ONE portfolio.
 *
 * User-scoped kinds are deliberately absent: custom assets, cash tags/rules,
 * expenses and tax settings survive a join untouched because other, normal
 * portfolios of the same account still reference them. That is the design's
 * acknowledged "ticker-visibility caveat" (§4), not an omission.
 *
 * `purge-only` kinds are absent for the same reason as in the account-level
 * document: import batches/rows and the derived snapshot tables are destroyed
 * on join and re-derived (or simply gone) on leave, exactly as
 * `PARANOID_TABLE_CLASSIFICATION` already decides for the whole account.
 */
export const VAULT_PORTFOLIO_ENTITY_KINDS = [
  'cashSource',
  'transaction',
  'dividend',
  'cashMovement',
  'cashMovementTag',
  'portfolioSetting',
  'standingOrder',
  'standingOrderRun',
  'cashBudget',
] as const;
export type VaultPortfolioEntityKind = (typeof VAULT_PORTFOLIO_ENTITY_KINDS)[number];

const PORTFOLIO_ENTITY_KIND_SET: ReadonlySet<string> = new Set(VAULT_PORTFOLIO_ENTITY_KINDS);

export const vaultPortfolioEntitySchema = vaultStrictEntitySchema.refine(
  (entity) => PORTFOLIO_ENTITY_KIND_SET.has(entity.kind),
  { message: 'entity kind is not portfolio-scoped' },
);
export type VaultPortfolioEntity = z.infer<typeof vaultPortfolioEntitySchema>;

export const vaultPortfolioRestoreDocumentSchema = z
  .object({
    schemaVersion: z.literal(VAULT_DOCUMENT_V1_VERSION),
    entities: z.array(vaultPortfolioEntitySchema),
  })
  .strict();
export type VaultPortfolioRestoreDocument = z.infer<typeof vaultPortfolioRestoreDocumentSchema>;

/**
 * Leave (`DELETE /portfolios/{id}/vault`): the client posts the decrypted rows
 * back, the server repopulates them, clears `vault_id` and retires the blob —
 * all three in one transaction, exactly like the account-level disable (§3).
 *
 * `restoreId` is the idempotency key: a crashed leave can be re-sent with the
 * same id and the server answers the original receipt instead of re-inserting.
 */
export const vaultLeaveRequestSchema = z
  .object({
    restoreId: z.string().uuid(),
    document: vaultPortfolioRestoreDocumentSchema,
  })
  .strict();
export type VaultLeaveRequest = z.infer<typeof vaultLeaveRequestSchema>;

/** Per-portfolio vault membership, as portfolio surfaces render it. */
export const portfolioVaultStateSchema = z
  .object({
    portfolioId: z.string().uuid(),
    vaultId: z.string().uuid().nullable(),
    vaultName: z.string().nullable(),
    backends: vaultBackendsSchema.nullable(),
  })
  .strict();
export type PortfolioVaultState = z.infer<typeof portfolioVaultStateSchema>;

export const vaultJoinResponseSchema = z
  .object({
    state: portfolioVaultStateSchema,
    blob: vaultDocMetadataSchema,
  })
  .strict();
export type VaultJoinResponse = z.infer<typeof vaultJoinResponseSchema>;

export const vaultLeaveResponseSchema = z
  .object({
    state: portfolioVaultStateSchema,
    restoreId: z.string().uuid(),
    idempotent: z.boolean(),
  })
  .strict();
export type VaultLeaveResponse = z.infer<typeof vaultLeaveResponseSchema>;
