import { z } from 'zod';

import { vaultBackendsSchema, VAULT_NAME_MAX_LENGTH, type VaultBackends } from './vaults';
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
 *
 * **Scope split with `./vaults.ts`.** That module is the SERVER surface — the
 * wire DTOs, error codes, size caps and backend selection the API validates
 * against — and it is authoritative wherever the two overlap. This module
 * carries only what the server never sees: the document formats inside the
 * ciphertext, and the client-side scoping rules that decide which entity goes
 * into which document.
 */

/** Header-doc layout version. v1 vaults carry no header doc at all. */
export const VAULT2_HEADER_FORMAT_VERSION = 2;
/** Content-blob envelope layout version (shares the `BTVAULT1` magic). */
export const VAULT2_BLOB_FORMAT_VERSION = 2;
/** Per-portfolio / per-account payload document version. */
export const VAULT2_DOCUMENT_VERSION = 1;

/**
 * Longest user-chosen vault name and portfolio alias. Both are cleartext.
 * Re-exported from the server surface so the wizard's field cap, the header
 * schema and the API validator cannot drift apart.
 */
export const VAULT2_NAME_MAX_LENGTH = VAULT_NAME_MAX_LENGTH;

// ── Backends ───────────────────────────────────────────────

/**
 * Storage backend selection. The shipped server models this as ONE scalar
 * (`server` | `drive` | `both`, see `vaultBackendsSchema` in `./vaults.ts`)
 * rather than as a set, so the header's backend echo uses the same value and
 * the two can never disagree about what "both" means.
 */
export const vaultBackendEchoSchema = vaultBackendsSchema;
export type VaultBackendEcho = VaultBackends;

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
 * material; the r3 §21 header `mac` authenticates it once `K_c` is available,
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
 * The r3 §21 header integrity tag.
 *
 * `tag = base64(HMAC-SHA256(K_mac, canonicalHeaderBytes))` with
 * `K_mac = HKDF-SHA256(salt = empty, IKM = K_c, info = "btv2-header-mac-v1")`
 * and `canonicalHeaderBytes` = the canonical JSON (sorted keys at every level,
 * no whitespace) of the header WITHOUT the `mac` member — unknown members
 * included: what a client preserves, it authenticates.
 *
 * HMAC rather than the withdrawn GMAC seal because HMAC is deterministic and
 * safe under key reuse — rewriting the header on every index change is exactly
 * the pattern that made a fixed-nonce GMAC leak its authentication subkey.
 * Versioned (`v: 1`) so a future construction can coexist during a rollover.
 */
export const vaultHeaderMacSchema = z
  .object({
    v: z.literal(1),
    tag: z.string().min(1),
  })
  .strict();
export type VaultHeaderMac = z.infer<typeof vaultHeaderMacSchema>;

/** HKDF info string for the header-MAC key (r3 §21). */
export const VAULT2_HEADER_MAC_INFO = 'btv2-header-mac-v1';

/**
 * The cleartext vault header doc (§2). It carries crypto parameters, the key
 * slots, the portfolio index and the backend echo — never money data.
 *
 * **Not `.strict()` on purpose.** Unknown members are preserved rather than
 * rejected or dropped, so a later revision can add a field without this client
 * refusing to open the vault or silently deleting the new field when it
 * rewrites the header. Preserved members are covered by the `mac`, so carrying
 * them is safe rather than a laundering channel.
 *
 * **Integrity (r3 §21).** `mac` is REQUIRED on every header written from r3
 * onward and verified whenever `K_c` is available: present-and-valid opens as
 * `verified`, absent opens as `unsealed` (tolerated this arc; the next header
 * write attaches it), present-and-INVALID fails closed. The r2 draft's
 * fixed-nonce GMAC seal stays withdrawn — see {@link vaultHeaderMacSchema} for
 * why HMAC replaces it.
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
    backends: vaultBackendsSchema,
    /** Monotonic CAS token for the header doc itself. */
    headerVersion: vaultVersionSchema,
    deviceId: z.string().uuid(),
    writeId: z.string().uuid(),
    writtenAt: z.string().datetime(),
    /** r3 §21 integrity tag; absent only on pre-r3 headers (read as `unsealed`). */
    mac: vaultHeaderMacSchema.optional(),
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

// ── Content documents ────────────────────────────────────────────

const entitiesSchema = z.record(vaultEntityKindSchema, z.array(vaultEntitySchema));

/**
 * `mergeLog` is a document MEMBER of BOTH content-doc kinds — not an entity
 * kind, and PER-DOCUMENT (r3 §20, closing mobile A1.1/A1.2). Merge records name
 * bare document versions, so one shared array across N independently-versioned
 * docs would mix N lineages. The cap is a WRITE-side trim (`VAULT_MERGE_LOG_LIMIT`),
 * NEVER a parse-time rejection: a parse `.max()` would let a bookkeeping array
 * make `common` unreadable and take `clientSecurity` and `mirrorProvenance` —
 * the whole vault — down with it. Readers therefore tolerate any length.
 */
const mergeLogSchema = z.array(vaultMergeRecordSchema).default([]);

/** One portfolio's decrypted content (§2 "portfolio doc"). */
export const vaultPortfolioDocSchema = z
  .object({
    schemaVersion: z.literal(VAULT2_DOCUMENT_VERSION),
    docKind: z.literal('portfolio'),
    vaultId: z.string().uuid(),
    portfolioId: z.string().uuid(),
    entities: entitiesSchema,
    mergeLog: mergeLogSchema,
  })
  .strict();
export type VaultPortfolioDoc = z.infer<typeof vaultPortfolioDocSchema>;

/**
 * The vault's `common` doc (r3 §20): every account/vault-scoped entity KIND for
 * THIS vault (the 13 in {@link VAULT2_COMMON_SCOPED_KINDS}), plus the two
 * document MEMBERS `mirrorProvenance` and `clientSecurity`, and its own
 * per-document `mergeLog`.
 *
 * `clientSecurity`, `mirrorProvenance` and `mergeLog` are MEMBERS, not entity
 * kinds — r2 §8 listed them among what `common` "owns", but a doc carrying them
 * inside `entities` is rejected by both engines' fail-closed parsers (unknown
 * entity keys stay fatal). They live here, on the object.
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
    mergeLog: mergeLogSchema,
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

/**
 * The one-time code that unwraps `w` (r3 §19, superseding r2 §10's 6-digit
 * PIN). Eight characters of Crockford base32 — **exactly 40 bits** — because
 * the code is the ENTIRE security margin of a photographed QR: `w` plus its
 * GCM tag is an offline verification oracle, and a 6-digit sweep at the vault
 * Argon2id profile costs only ≈97 CPU-hours. At 2^40 the same sweep is
 * ≈12,000 CPU-years of memory-hard work.
 *
 * The alphabet omits I, L, O, U; decoding forgives case, separators and the
 * classic confusions (`I`/`L` → `1`, `O` → `0`). The KDF input is the CANONICAL
 * form: 8 uppercase characters, no separators.
 */
export const VAULT2_QR_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const VAULT2_QR_CODE_LENGTH = 8;
export const VAULT2_QR_CODE_BITS = 40;

/**
 * `btvault1:{"qr":1,"vaultId":…,"name":…,"w":…}` (r2 §10, code per r3 §19).
 *
 * `w` is **not** the passphrase. It is
 * `salt(16) ‖ iv(12) ‖ AES-256-GCM(KDF(code), P)` with
 * `KDF = Argon2id, m = 65536 (64 MiB), t = 3, p = 1` — the vault profile,
 * normative — and `AAD = utf8(vaultId)`. The 8-character one-time code is
 * shown on a SEPARATE screen and never encoded into the image, so a
 * photograph of the QR, a shoulder-surfer, or a screen-recording captures
 * nothing usable on its own. The receiver needs the image AND the code within
 * the 120 s window.
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

// ── Server surface ─────────────────────────────────────────

/**
 * The §3 wire DTOs, error codes and size caps live in `./vaults.ts`, which the
 * shipped API validates against. Nothing is redefined here: an earlier draft of
 * this file carried its own `vaultSummarySchema`, `createVaultRequestSchema`,
 * join/leave DTOs and error-code table, all written before the server existed.
 * They were removed rather than kept as aliases, so there is exactly one
 * definition of each shape to reconcile against.
 */
export {
  createVaultRequestSchema,
  setPortfolioAliasRequestSchema,
  updateVaultRequestSchema,
  VAULT2_ERROR_CODES,
  VAULT_DOC_MAX_BYTES,
  vaultDocMaxBytes,
  vaultJoinRequestSchema,
  vaultJoinResponseSchema,
  vaultLeaveRequestSchema,
  vaultLeaveResponseSchema,
  vaultListResponseSchema,
  vaultSchema,
} from './vaults';
