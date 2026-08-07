import { z } from 'zod';

import {
  VAULT_ENTITY_KINDS,
  vaultEntityKindSchema,
  vaultEntitySchema,
  vaultKdfParamsSchema,
  vaultClientSecuritySchema,
  vaultMergeRecordSchema,
  vaultMirrorProvenanceSchema,
  vaultVersionSchema,
  type VaultEntityKind,
} from './vault';

/**
 * Vaults v2 — per-portfolio paranoid as multi-vault wallets
 * (`docs/VAULTS_V2_DESIGN.md`). This module is the **single source of truth**
 * for the v2 on-disk/on-wire formats across every client, exactly as
 * `./vault.ts` is for v1.
 *
 * v1 stored ONE account-level encrypted document. v2 splits that into
 *  - one **vault header doc** per vault: cleartext crypto parameters, the key
 *    slots that wrap the content key `K_c`, the portfolio index and the backend
 *    echo, plus a `seal` that authenticates all of it under `K_c`; and
 *  - one **content blob per portfolio**, individually CAS-versioned, encrypted
 *    under `K_c`.
 *
 * The server never parses any of it (§3): it stores blind bytes with
 * compare-and-swap. These shapes live here so the web client (P3) and the
 * mobile client (P4) pin the same bytes and can share conformance vectors — §5
 * requires exactly that for the v2 header and the per-portfolio doc split.
 */

/** Header-doc layout version. v1 vaults carry no header doc at all. */
export const VAULT2_HEADER_FORMAT_VERSION = 2;
/** Content-blob envelope layout version (shares the `BTVAULT1` magic). */
export const VAULT2_BLOB_FORMAT_VERSION = 2;
/** Per-portfolio / per-account payload document version. */
export const VAULT2_DOCUMENT_VERSION = 1;

/** Longest user-chosen vault name and portfolio alias. Both are cleartext. */
export const VAULT2_NAME_MAX_LENGTH = 60;

// ── Backends ─────────────────────────────────────────────────────────────────

/**
 * A vault's storage backend. The enum is the documented extension point for
 * WebDAV/iCloud/file (§6); adding one is a value here plus a `DataHome`.
 */
export const VAULT2_BACKENDS = ['server', 'drive'] as const;
export const vaultBackendSchema = z.enum(VAULT2_BACKENDS);
export type VaultBackend = z.infer<typeof vaultBackendSchema>;

/** `server` | `drive` | `both`, expressed as a non-empty duplicate-free set. */
export const vaultBackendSetSchema = z
  .array(vaultBackendSchema)
  .min(1, 'a vault must keep at least one backend')
  .refine((backends) => new Set(backends).size === backends.length, {
    message: 'a backend set must not repeat a backend',
  });
export type VaultBackendSet = z.infer<typeof vaultBackendSetSchema>;

// ── Key slots ────────────────────────────────────────────────────────────────

/**
 * One wrapped copy of the vault content key `K_c`.
 *
 * Today exactly one slot exists per vault and its `kind` is `passphrase`: the
 * 12 words derive a KEK through Argon2id over the vault-level `kdfSalt`, and
 * that KEK AES-GCM-wraps `K_c`. The array (and the discriminating `kind`) is
 * the §2 future-sharing hook — a shared vault adds slots that wrap the SAME
 * `K_c` to other members' public keys, with no format change.
 */
export const vaultKeySlotSchema = z
  .object({
    slotId: z.string().uuid(),
    kind: z.literal('passphrase'),
    /**
     * `iv ‖ AES-GCM(KEK, K_c)`. r2 §9 fixes the additional authenticated data
     * as `formatVersion`, `vaultId` and the slot's INDEX — binding the index,
     * not just the id, is what stops a blob store from reordering `keySlots[]`
     * and re-attributing a wrapped key once shared vaults add member slots.
     */
    wrappedKey: z.string().min(1),
  })
  .strict();
export type VaultKeySlot = z.infer<typeof vaultKeySlotSchema>;

// ── Portfolio index ──────────────────────────────────────────────────────────

/**
 * One entry of the vault's portfolio index.
 *
 * `alias` is rendered on locked money surfaces (§4) — which is only possible
 * while the vault is LOCKED if it is readable without `K_c`, so the index is
 * part of the cleartext header. It is display-only and never trusted for key
 * material; the header `seal` still authenticates it once `K_c` is available,
 * so a blob store cannot silently add, drop or relabel a portfolio.
 */
export const vaultPortfolioIndexEntrySchema = z
  .object({
    portfolioId: z.string().uuid(),
    alias: z.string().trim().min(1).max(VAULT2_NAME_MAX_LENGTH),
  })
  .strict();
export type VaultPortfolioIndexEntry = z.infer<typeof vaultPortfolioIndexEntrySchema>;

// ── Vault header doc ─────────────────────────────────────────────────────────

/**
 * The cleartext vault header doc (§2). It carries crypto parameters, the key
 * slots, the portfolio index and the backend echo — never money data.
 *
 * **Not `.strict()` on purpose.** Unknown members are preserved rather than
 * rejected or dropped, so a later revision can add a field — notably the header
 * integrity tag deferred to the P5 hardening pass — without this client
 * refusing to open the vault or silently deleting the new field when it
 * rewrites the header.
 *
 * There is deliberately **no integrity tag today**. An earlier draft sealed the
 * header with a fixed-nonce GMAC under `K_c`; that is unsafe here, because the
 * header is rewritten whenever the portfolio index changes, and two GMAC tags
 * produced under one key with a reused nonce leak the authentication subkey and
 * become forgeable. Header integrity is a real concern — a blob store can
 * currently relabel or drop a portfolio index entry — and it is tracked as a
 * P5 hardening item with a per-write random IV, or by folding the index into
 * the key-slot AAD.
 */
export const vaultHeaderDocSchema = z
  .object({
    formatVersion: z.literal(VAULT2_HEADER_FORMAT_VERSION),
    vaultId: z.string().uuid(),
    name: z.string().trim().min(1).max(VAULT2_NAME_MAX_LENGTH),
    /** Argon2id salt for THIS vault's passphrase, base64, 16 bytes. */
    kdfSalt: z.string().min(1),
    /** The fixed Argon2id profile the salt is used with. */
    kdf: vaultKdfParamsSchema,
    keySlots: z.array(vaultKeySlotSchema).min(1),
    portfolios: z.array(vaultPortfolioIndexEntrySchema),
    backends: vaultBackendSetSchema,
    /** Monotonic CAS token for the header doc itself. */
    headerVersion: vaultVersionSchema,
    deviceId: z.string().uuid(),
    writeId: z.string().uuid(),
    writtenAt: z.string().datetime(),
  })
  .passthrough()
  .superRefine((header, ctx) => {
    const ids = header.portfolios.map((entry) => entry.portfolioId);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['portfolios'],
        message: 'the portfolio index must not repeat a portfolio',
      });
    }
    const slotIds = header.keySlots.map((slot) => slot.slotId);
    if (new Set(slotIds).size !== slotIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['keySlots'],
        message: 'a vault must not repeat a key slot id',
      });
    }
  });
export type VaultHeaderDoc = z.infer<typeof vaultHeaderDocSchema>;

// ── Entity scoping (r2 §8) ────────────────────────────────────────────

/**
 * Entity kinds a per-portfolio content blob may contain: those that belong to
 * exactly one portfolio, directly or through a parent row.
 */
export const VAULT2_PORTFOLIO_SCOPED_KINDS = [
  'portfolio',
  'transaction',
  'dividend',
  'cashSource',
  'cashMovement',
  'cashMovementTag',
  'portfolioSetting',
  'standingOrder',
  'standingOrderRun',
  'importBatch',
  'importRow',
  'portfolioDailySnapshot',
  'portfolioSnapshotState',
] as const satisfies readonly VaultEntityKind[];

/**
 * Entity kinds the vault's **`common`** doc owns (r2 §8). r2 enumerates:
 * `customAsset`, `customAssetValue`, `cashTag`, `cashRule`, `cashBudget`,
 * `expenseCategory`, `expenseRule`, `expenseBudget`, `taxSetting` — plus the
 * document-level `clientSecurity`, `mirrorProvenance` and `mergeLog`, which are
 * fields rather than entity kinds and live on {@link vaultCommonDocSchema}.
 *
 * The four kinds marked below are NOT in r2's enumeration but have no portfolio
 * linkage at all, so a portfolio doc could never route them — they would become
 * orphans on every migration. r2's governing sentence is "common owns every
 * account/vault-scoped entity kind", so they follow their parents into `common`.
 * FLAGGED for the platform chief: if r2's list is meant to be exhaustive rather
 * than illustrative, these four need an explicit home.
 */
export const VAULT2_COMMON_SCOPED_KINDS = [
  'taxSetting',
  'customAsset',
  'customAssetValue',
  'cashTag',
  'cashRule',
  'cashBudget',
  'expenseCategory',
  'expenseRule',
  'expenseBudget',
  // Derived placements — the parent lives in `common`, so the child must too.
  'expenseTransaction', // → expenseCategory (userId-scoped, no portfolioId)
  'expenseBudgetFire', // → expenseBudget
  'cashBudgetFire', // → cashBudget
  'cashRuleTag', // → cashRule × cashTag, both common
] as const satisfies readonly VaultEntityKind[];

export type VaultPortfolioScopedKind = (typeof VAULT2_PORTFOLIO_SCOPED_KINDS)[number];
export type VaultCommonScopedKind = (typeof VAULT2_COMMON_SCOPED_KINDS)[number];

const PORTFOLIO_SCOPED_SET: ReadonlySet<string> = new Set(VAULT2_PORTFOLIO_SCOPED_KINDS);
const COMMON_SCOPED_SET: ReadonlySet<string> = new Set(VAULT2_COMMON_SCOPED_KINDS);

export function isPortfolioScopedKind(kind: VaultEntityKind): kind is VaultPortfolioScopedKind {
  return PORTFOLIO_SCOPED_SET.has(kind);
}

export function isCommonScopedKind(kind: VaultEntityKind): kind is VaultCommonScopedKind {
  return COMMON_SCOPED_SET.has(kind);
}

/**
 * The two scopes must partition every entity kind exactly. A new kind added to
 * `VAULT_ENTITY_KINDS` without a scope would otherwise be dropped silently by
 * the v1→v2 split; this list is asserted in `upgrade.test.ts` and is why the
 * split can guarantee it never loses a row.
 */
export const VAULT2_UNSCOPED_KINDS: readonly VaultEntityKind[] = VAULT_ENTITY_KINDS.filter(
  (kind) => !PORTFOLIO_SCOPED_SET.has(kind) && !COMMON_SCOPED_SET.has(kind),
);

// ── Size caps (r2 §8) ────────────────────────────────────────────────

/** Per-doc-kind ciphertext caps the server enforces and the client checks first. */
export const VAULT2_DOC_SIZE_CAPS = {
  header: 1 * 1024 * 1024,
  common: 4 * 1024 * 1024,
  portfolio: 8 * 1024 * 1024,
} as const;

// ── Content documents ────────────────────────────────────────────

const entitiesSchema = z.record(vaultEntityKindSchema, z.array(vaultEntitySchema));

/** One portfolio's decrypted content (§2 "portfolio doc"). */
export const vaultPortfolioDocSchema = z
  .object({
    schemaVersion: z.literal(VAULT2_DOCUMENT_VERSION),
    docKind: z.literal('portfolio'),
    vaultId: z.string().uuid(),
    portfolioId: z.string().uuid(),
    entities: entitiesSchema,
    mergeLog: z.array(vaultMergeRecordSchema).max(20).default([]),
  })
  .strict();
export type VaultPortfolioDoc = z.infer<typeof vaultPortfolioDocSchema>;

/**
 * The vault's `common` doc (r2 §8): every account/vault-scoped entity kind for
 * THIS vault, plus the three document-level carriers r2 assigns to it.
 *
 * Ids are namespaced per vault by design — the same conceptual custom asset in
 * two vaults is two independent lineages, and there is no cross-vault dedup.
 */
export const vaultCommonDocSchema = z
  .object({
    schemaVersion: z.literal(VAULT2_DOCUMENT_VERSION),
    docKind: z.literal('common'),
    vaultId: z.string().uuid(),
    entities: entitiesSchema,
    mergeLog: z.array(vaultMergeRecordSchema).max(20).default([]),
    /** Per-vault severed-fork identity map; divergence rules apply within one vault. */
    mirrorProvenance: z.array(vaultMirrorProvenanceSchema).optional(),
    /** Per-vault retirement-proof material. Never part of a server DTO. */
    clientSecurity: vaultClientSecuritySchema.optional(),
  })
  .strict();
export type VaultCommonDoc = z.infer<typeof vaultCommonDocSchema>;

export const vaultContentDocSchema = z.discriminatedUnion('docKind', [
  vaultPortfolioDocSchema,
  vaultCommonDocSchema,
]);
export type VaultContentDoc = z.infer<typeof vaultContentDocSchema>;

// ── Content-blob envelope header ─────────────────────────────────────────────

/**
 * The cleartext header of one v2 content blob. It deliberately carries NO
 * wrapped keys: rotating a vault passphrase rewrites the header doc's key slots
 * only, never every portfolio blob.
 *
 * `formatVersion: 2` under the shared `BTVAULT1` magic means a v1 reader hits
 * its existing "written by a newer app version" branch instead of reporting
 * corruption.
 */
export const vaultBlobHeaderSchema = z
  .object({
    formatVersion: z.literal(VAULT2_BLOB_FORMAT_VERSION),
    cipher: z.literal('A256GCM'),
    iv: z.string().min(1),
    vaultId: z.string().uuid(),
    docKind: z.enum(['portfolio', 'common']),
    /** Present exactly for `docKind: 'portfolio'`. */
    portfolioId: z.string().uuid().nullable(),
    schemaVersion: z.literal(VAULT2_DOCUMENT_VERSION),
    /** Monotonic CAS token for THIS blob. */
    blobVersion: vaultVersionSchema,
    deviceId: z.string().uuid(),
    writeId: z.string().uuid(),
    writtenAt: z.string().datetime(),
  })
  .strict()
  .superRefine((header, ctx) => {
    if ((header.docKind === 'portfolio') !== (header.portfolioId !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['portfolioId'],
        message: 'a portfolio blob carries a portfolioId and a common blob does not',
      });
    }
  });
export type VaultBlobHeader = z.infer<typeof vaultBlobHeaderSchema>;

/** Field order this client serializes a blob header in; the bytes are AAD. */
export const VAULT2_BLOB_HEADER_FIELDS = [
  'formatVersion',
  'cipher',
  'iv',
  'vaultId',
  'docKind',
  'portfolioId',
  'schemaVersion',
  'blobVersion',
  'deviceId',
  'writeId',
  'writtenAt',
] as const;

// ── QR handoff payload (r2 §10) ──────────────────────────────────────

/**
 * The QR scheme prefix. It stays `btvault1` — that names the crypto substrate,
 * not the document version, and the contract pins the literal.
 */
export const VAULT2_QR_PREFIX = 'btvault1:';
/** r2 §10: the whole two-screen handoff lives at most 120 seconds. */
export const VAULT2_QR_TTL_MS = 120_000;
/** Digits in the one-time PIN that unwraps `w`. */
export const VAULT2_QR_PIN_LENGTH = 6;

/**
 * `btvault1:{"qr":1,"vaultId":…,"name":…,"w":…}` (r2 §10).
 *
 * `w` is **not** the passphrase. It is `iv ‖ AES-GCM(KDF(pin), P)` under a
 * 6-digit one-time PIN that is shown on a SEPARATE screen and never encoded
 * into the image — so a photograph of the code, a shoulder-surfer, or a
 * screen-recording captures nothing usable. The receiver needs the code AND the
 * PIN within the 120 s window.
 *
 * The member name is `qr` rather than `v` (r2 §9) so it cannot be confused with
 * `VAULT_DOCUMENT_VERSION`.
 */
export const vaultQrPayloadSchema = z
  .object({
    qr: z.literal(1),
    vaultId: z.string().uuid(),
    name: z.string().trim().min(1).max(VAULT2_NAME_MAX_LENGTH),
    /** Base64 of `iv ‖ AES-GCM(KDF(pin), P)`, with the vault id as AAD. */
    w: z.string().min(1),
  })
  .strict();
export type VaultQrPayload = z.infer<typeof vaultQrPayloadSchema>;

/**
 * Serialize a payload. The member order is written out literally rather than
 * left to object-key insertion order, so the emitted string matches the
 * contract character for character on every engine (vector family 6).
 */
export function serializeVaultQrPayload(payload: VaultQrPayload): string {
  const parsed = vaultQrPayloadSchema.parse(payload);
  return `${VAULT2_QR_PREFIX}{"qr":${parsed.qr},"vaultId":${JSON.stringify(parsed.vaultId)},"name":${JSON.stringify(parsed.name)},"w":${JSON.stringify(parsed.w)}}`;
}

export type VaultQrParseFailure = 'prefix' | 'json' | 'shape';

/**
 * Structural parse only — it never throws, because a camera feeds it arbitrary
 * strings. Unwrapping `w` needs the PIN and happens in the client crypto layer.
 */
export function parseVaultQrPayloadStructure(
  value: string,
): { ok: true; payload: VaultQrPayload } | { ok: false; reason: VaultQrParseFailure } {
  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith(VAULT2_QR_PREFIX)) return { ok: false, reason: 'prefix' };
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed.slice(VAULT2_QR_PREFIX.length));
  } catch {
    return { ok: false, reason: 'json' };
  }
  const parsed = vaultQrPayloadSchema.safeParse(raw);
  return parsed.success ? { ok: true, payload: parsed.data } : { ok: false, reason: 'shape' };
}

// ── Server surface DTOs (§3) ─────────────────────────────────────────────────

/**
 * The P3 client's reading of the §3 session routes. The server PR (P2) is being
 * built in parallel against the same section; if the shipped server differs,
 * THIS is the reconciliation point — no client call site restates a shape.
 */

export const vaultSummarySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(VAULT2_NAME_MAX_LENGTH),
    backends: vaultBackendSetSchema,
    createdAt: z.string().datetime(),
    /** Portfolio ids the server believes belong to this vault. */
    portfolioIds: z.array(z.string().uuid()).default([]),
  })
  .strip();
export type VaultSummary = z.infer<typeof vaultSummarySchema>;

export const vaultListResponseSchema = z.object({ items: z.array(vaultSummarySchema) }).strip();
export type VaultListResponse = z.infer<typeof vaultListResponseSchema>;

/**
 * `POST /vaults` — "create takes the client-built header; server stores
 * blindly". The client mints the id so the header it just sealed (the seal
 * binds `vaultId`) is exactly the header the server stores.
 */
export const createVaultRequestSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(VAULT2_NAME_MAX_LENGTH),
    backends: vaultBackendSetSchema,
    /** Base64 of the UTF-8 header doc bytes. Opaque to the server. */
    header: z.string().min(1),
  })
  .strict();
export type CreateVaultRequest = z.infer<typeof createVaultRequestSchema>;

export const updateVaultRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(VAULT2_NAME_MAX_LENGTH).optional(),
    backends: vaultBackendSetSchema.optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.backends !== undefined, {
    message: 'a vault update must change the name or the backends',
  });
export type UpdateVaultRequest = z.infer<typeof updateVaultRequestSchema>;

/**
 * `POST /portfolios/{id}/vault` — one transaction: store the blob, purge that
 * portfolio's cleartext rows, set `vaultId`.
 */
export const vaultJoinRequestSchema = z
  .object({
    vaultId: z.string().uuid(),
    /** Base64 of the finished per-portfolio ciphertext blob. */
    blob: z.string().min(1),
  })
  .strict();
export type VaultJoinRequest = z.infer<typeof vaultJoinRequestSchema>;

export const vaultJoinResponseSchema = z
  .object({
    portfolioId: z.string().uuid(),
    vaultId: z.string().uuid(),
    blobVersion: vaultVersionSchema,
  })
  .strip();
export type VaultJoinResponse = z.infer<typeof vaultJoinResponseSchema>;

export const vaultLeaveResponseSchema = z
  .object({ portfolioId: z.string().uuid(), restoredAt: z.string().datetime() })
  .strip();
export type VaultLeaveResponse = z.infer<typeof vaultLeaveResponseSchema>;

/** Typed failures the v2 vault routes raise in the standard `{ error }` envelope. */
export const VAULT2_ERROR_CODES = {
  notFound: 'VAULT_NOT_FOUND',
  notEmpty: 'VAULT_NOT_EMPTY',
  versionConflict: 'VAULT_VERSION_CONFLICT',
  docTooLarge: 'VAULT_DOC_TOO_LARGE',
  lockedWriteRefused: 'VAULT_LOCKED_WRITE_REFUSED',
  migrationClaimed: 'VAULT_MIGRATION_CLAIMED',
  migrationIncomplete: 'VAULT_MIGRATION_INCOMPLETE',
  crossBlobRefused: 'VAULT_CROSS_BLOB_REFUSED',
  formatUpdateRequired: 'VAULT_FORMAT_UPDATE_REQUIRED',
  backendUnavailable: 'VAULT_BACKEND_UNAVAILABLE',
} as const;
export type Vault2ErrorCode = (typeof VAULT2_ERROR_CODES)[keyof typeof VAULT2_ERROR_CODES];

/**
 * r2 §15: every CAS surface returns the current version alongside its 412 so a
 * client can re-apply without a second round trip.
 */
export const vaultConflictResponseSchema = z
  .object({
    error: z.object({ code: z.string(), message: z.string() }).passthrough(),
    currentVersion: vaultVersionSchema.nullable(),
  })
  .passthrough();
export type VaultConflictResponse = z.infer<typeof vaultConflictResponseSchema>;
