import { z } from 'zod';

import { MAX_PASSWORD_LENGTH } from './auth';
import {
  VAULT_CONTENT_CIPHER,
  VAULT_VERSION_MAX,
  VaultEnvelopeError,
  decodeVaultEnvelope,
  encodeVaultEnvelope,
  vaultClientSecuritySchema,
  vaultEntityKindSchema,
  vaultEntitySchema,
  vaultJsonSchema,
  vaultMergeRecordSchema,
  vaultMirrorProvenanceSchema,
  vaultRetirementProofPublicKeySchema,
  type VaultEntityKind,
} from './vault';

/**
 * PARANOID VAULTS — the per-portfolio model (`docs/paranoid-design.md`,
 * ACKED & RULED 2026-08-20; PROJECTPLAN §13.5 V5-P13 arc b; epic E0 #1410).
 *
 * This module is the contract keystone for the redefined paranoid mode: an
 * account owns N vaults; a vault is a storage CONFIG (server / a separately
 * authenticated Google Drive connection / both); each vault opens only with its
 * own 12-word BIP39 seed phrase; portfolios move INTO a vault. It pins:
 *
 *  - the vault config + `drive_connections` DTOs (§3, §8),
 *  - the ENVELOPE V2 header + codec for the per-vault doc set (§5),
 *  - the doc-set payload schemas (`header` / `common` / `portfolio` docs, §5),
 *  - the per-(vaultId, docId) CAS transport shapes (§6),
 *  - the per-portfolio revision-token / move-in / move-out bodies (§9 step 2),
 *  - the `key_fingerprint` type + the `btvault1:` QR scheme constant (§4, §13).
 *
 * It deliberately COEXISTS with `./vault` (the v1 account-level surface, alive
 * for the live paranoid accounts until the §17 transition retires it in E9) and
 * reuses v1's proven pieces verbatim where the design says "kept": the wire
 * framing, the entity sync metadata, the merge log, the mirror provenance and
 * the client security (retirement proof) shapes. Like `./vault`, everything
 * here is isomorphic (browser + Node) and free of platform imports.
 */

// ── Format constants (§4, §5) ────────────────────────────────────────────────

/**
 * Envelope layout version of the per-vault doc set. The wire framing (magic
 * `BTVAULT1` + 4-byte header length + cleartext JSON header + ciphertext) is
 * kept VERBATIM from v1 — the format version lives in the header, never in the
 * magic. Envelopes with a NEWER `formatVersion` are refused with the
 * "update the app" outcome and never best-effort parsed (§5).
 */
export const VAULT_DOC_FORMAT_VERSION = 2;
/** First payload schema version of the v2 doc set (each doc kind carries it). */
export const VAULT_DOC_SCHEMA_VERSION = 1;
/**
 * The one key-slot kind envelope v2 ships with: K_c wrapped by
 * K_wrap = HKDF-SHA256(BIP39 seed, {@link VAULT_WRAP_HKDF_INFO_PREFIX} + vaultId).
 * The slot indirection is what keeps §4 rotation and any far-future sharing
 * possible without re-issuing words — additional slot kinds arrive behind a
 * format-version bump, never by loosening this literal.
 */
export const VAULT_KEY_SLOT_SEED_V1 = 'seed-v1';

/** HKDF info prefix deriving the per-vault wrap key from the BIP39 seed (§4). */
export const VAULT_WRAP_HKDF_INFO_PREFIX = 'bettertrack-vault-wrap-v1:';
/** HKDF info deriving the non-secret verification tag of K_c (§4). */
export const VAULT_KEY_FINGERPRINT_HKDF_INFO = 'bettertrack-vault-fingerprint-v1';
/** `key_fingerprint` = base64url(HKDF-SHA256(K_c, info))[0..16] — 16 chars. */
export const VAULT_KEY_FINGERPRINT_CHARS = 16;
/**
 * Digest domain prefix of the envelope's `accountBinding` header field:
 * base64url(sha256(prefix + accountId)). Bound as AAD, it is one third of the
 * §8 anti-swap guarantee (a doc copied between accounts fails decryption).
 */
export const VAULT_ACCOUNT_BINDING_INFO_PREFIX = 'bettertrack-vault-owner-v1:';

/**
 * The QR seed-phrase transfer scheme prefix (§13). E0 pins only this constant —
 * the payload grammar (`btvault1:m=<words>&v=<vaultId>[&n=<name>][&f=<fp>]`)
 * is implemented by the E7 renderer/parser against the §13 spec verbatim. An
 * unknown prefix is REJECTED with an "update the app" notice, never guessed at.
 */
export const VAULT_QR_SCHEME_PREFIX = 'btvault1:';

/**
 * Default per-kind ciphertext size caps (§3, env-tunable via the
 * `BT_VAULT_MAX_BYTES` family): header 1 MiB, common 4 MiB, portfolio 8 MiB.
 * Ops knobs, not product surface — the server enforces them at the blind PUT
 * boundary (E1).
 */
export const VAULT_DOC_MAX_BYTES_DEFAULTS = {
  header: 1 * 1024 * 1024,
  common: 4 * 1024 * 1024,
  portfolio: 8 * 1024 * 1024,
} as const;

/** The per-doc monotonic CAS token (`docVersion`). The first stored blob is 1. */
export const vaultDocVersionSchema = z.number().int().min(1).max(VAULT_VERSION_MAX);
export type VaultDocVersion = z.infer<typeof vaultDocVersionSchema>;

// ── Media (§3, §22) ──────────────────────────────────────────────────────────

/**
 * Every medium the CONTRACT knows. `local` (phone-local-only, the owner's
 * "leave that out for now") is RESERVED: clients may know the word exists, but
 * the SERVER REJECTS it everywhere until the future version ships — at the
 * schema CHECK on `vaults.media` and at the service boundary (E1). Keeping the
 * enum value now means the future medium is an additive server change, not a
 * breaking contract change.
 */
export const VAULT_MEDIA_VALUES = ['server', 'drive', 'local'] as const;
export const vaultMediaSchema = z.enum(VAULT_MEDIA_VALUES);
export type VaultMedia = z.infer<typeof vaultMediaSchema>;

/** The media values the server ACCEPTS today (`local` is reserved, §22). */
export const VAULT_SERVER_ACCEPTED_MEDIA = ['server', 'drive'] as const;

/**
 * A vault's media set as carried by config DTOs: non-empty, no duplicates.
 * Deliberately an array (stable client-chosen order), not a set object.
 * Note this ACCEPTS `local` — the reserved-value rejection is a server
 * decision, so a newer client talking about `local` fails with the server's
 * clear "reserved" error instead of a generic contract violation.
 */
export const vaultMediaListSchema = z
  .array(vaultMediaSchema)
  .min(1)
  .max(VAULT_MEDIA_VALUES.length)
  .refine((media) => new Set(media).size === media.length, {
    message: 'media must not repeat a value',
  });
export type VaultMediaList = z.infer<typeof vaultMediaListSchema>;

// ── Vault config DTOs (§3) ───────────────────────────────────────────────────

export const VAULT_NAME_MAX = 120;
/**
 * The user-visible vault label. CLEARTEXT BY DESIGN (§21 Q4 ruling): a vault is
 * account config and the UI needs its name while locked. The TRUE name also
 * travels inside the encrypted header doc; this one is the server-visible copy.
 */
export const vaultNameSchema = z.string().trim().min(1).max(VAULT_NAME_MAX);

export const VAULT_ALIAS_MAX = 120;
/** A locked stub's display label (`portfolios.vault_alias`), cleartext (§3). */
export const vaultAliasSchema = z.string().trim().min(1).max(VAULT_ALIAS_MAX);

/**
 * The non-secret HKDF verification tag of a vault's content key (§4) — lets a
 * client confirm "these words open THIS vault" before destructive steps, and
 * rides the QR payload's optional `f` key (§13). base64url, exactly 16 chars.
 */
export const vaultKeyFingerprintSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, 'must be base64url')
  .length(VAULT_KEY_FINGERPRINT_CHARS);
export type VaultKeyFingerprint = z.infer<typeof vaultKeyFingerprintSchema>;

/** One vault config row as the narrow `GET /vaults` projection returns it. */
export const vaultConfigSchema = z
  .object({
    id: z.string().uuid(),
    name: vaultNameSchema,
    media: vaultMediaListSchema,
    /** Bound Drive connection — non-null exactly when `drive ∈ media` (§3). */
    driveConnectionId: z.string().uuid().nullable(),
    keyFingerprint: vaultKeyFingerprintSchema,
    /** Public verifier of the per-vault retirement proof key (§7). */
    retirementProofPublicKey: vaultRetirementProofPublicKeySchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type VaultConfig = z.infer<typeof vaultConfigSchema>;

const requireDriveBinding = (
  value: { media: VaultMedia[]; driveConnectionId?: string | null },
  ctx: z.RefinementCtx,
): void => {
  const driveSelected = value.media.includes('drive');
  const bound = value.driveConnectionId != null;
  if (driveSelected && !bound) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['driveConnectionId'],
      message: 'the drive medium requires a bound Drive connection',
    });
  }
  if (!driveSelected && bound) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['driveConnectionId'],
      message: 'a Drive connection binding requires the drive medium',
    });
  }
};

/**
 * `POST /vaults` (route is E1). The client mints the vault id? No — the server
 * assigns the uuidv7 id; the client supplies everything derived from its OWN
 * key material: the fingerprint of the K_c it generated and the public half of
 * the retirement proof keypair whose private half lives inside the encrypted
 * common doc (§7). Both are required from birth — a fresh table has no legacy
 * rows, so there is no nullable-verifier grace like v1's.
 */
export const createVaultRequestSchema = z
  .object({
    name: vaultNameSchema,
    media: vaultMediaListSchema,
    driveConnectionId: z.string().uuid().nullable().default(null),
    keyFingerprint: vaultKeyFingerprintSchema,
    retirementProofPublicKey: vaultRetirementProofPublicKeySchema,
  })
  .strict()
  .superRefine(requireDriveBinding);
export type CreateVaultRequest = z.infer<typeof createVaultRequestSchema>;

export const createVaultResponseSchema = z.object({ vault: vaultConfigSchema }).strict();
export type CreateVaultResponse = z.infer<typeof createVaultResponseSchema>;

/**
 * `PATCH /vaults/:vaultId` — config-only edits (today: the cleartext label).
 * Media and Drive-binding CHANGES are deliberately absent: they are §7 media
 * transitions (verified round trip, staged candidates, retirement) and ride
 * the re-keyed `/vaults/:vaultId/media` family in E1 — never a plain PATCH.
 */
export const patchVaultRequestSchema = z
  .object({
    name: vaultNameSchema.optional(),
  })
  .strict()
  .refine((body) => body.name !== undefined, {
    message: 'nothing to update',
  });
export type PatchVaultRequest = z.infer<typeof patchVaultRequestSchema>;

export const patchVaultResponseSchema = createVaultResponseSchema;
export type PatchVaultResponse = z.infer<typeof patchVaultResponseSchema>;

export const vaultListResponseSchema = z.object({ vaults: z.array(vaultConfigSchema) }).strict();
export type VaultListResponse = z.infer<typeof vaultListResponseSchema>;

export const vaultIdParamSchema = z.object({ vaultId: z.string().uuid() }).strict();
export type VaultIdParam = z.infer<typeof vaultIdParamSchema>;

/**
 * In-body step-up re-auth for destructive vault operations (§15, the #1326
 * carry-over): the current password, a fresh TOTP `code`, or an unused
 * `recoveryCode` — at least one, verified inside the same account lock as the
 * transition. The in-body credential is what replaces CSRF + same-origin on
 * the bearer path, mirroring `deleteAccountRequestSchema`.
 */
export const vaultStepUpCredentialSchema = z
  .object({
    password: z.string().min(1).max(MAX_PASSWORD_LENGTH).optional(),
    /** A fresh 6-digit authenticator (TOTP) code — 2FA-enrolled accounts only. */
    code: z.string().trim().min(4).max(16).optional(),
    /** An unused recovery code — consumed on success AND on a failed match. */
    recoveryCode: z.string().trim().min(4).max(64).optional(),
  })
  .strict()
  .refine((b) => b.password !== undefined || b.code !== undefined || b.recoveryCode !== undefined, {
    message: 'Re-authentication is required: send your password or a two-factor code.',
  });
export type VaultStepUpCredential = z.infer<typeof vaultStepUpCredentialSchema>;

/**
 * `DELETE /vaults/:vaultId` (E1) — step-up-gated (§15). The route refuses while
 * any portfolio references the vault (§3); the schema-level `NO ACTION` FK on
 * `portfolios.vault_id` backs the same rule at the deepest boundary.
 */
export const deleteVaultRequestSchema = z.object({ stepUp: vaultStepUpCredentialSchema }).strict();
export type DeleteVaultRequest = z.infer<typeof deleteVaultRequestSchema>;

export const deleteVaultResponseSchema = z.object({ ok: z.literal(true) }).strict();
export type DeleteVaultResponse = z.infer<typeof deleteVaultResponseSchema>;

// ── Drive connections (§8) ───────────────────────────────────────────────────

/** OIDC `sub` is ASCII and ≤ 255 chars; Google's are opaque digit strings. */
export const googleSubSchema = z.string().trim().min(1).max(255);

/**
 * One separately authenticated Google Drive connection — account CONFIG (§8).
 * The registry stores the IDENTITY the client captured at consent time via
 * Drive `about.get(fields=user)`: the stable subject id + email + display name.
 * **No tokens, no refresh tokens, no file ids — ever**: tokens are minted in
 * the browser per connection and stay memory-only, which is what makes the
 * Drive-only "zero server capability" guarantee true (§8, §22). Two BetterTrack
 * users MAY hold connections to the same `google_sub` (the shared-physical-
 * Drive case); uniqueness is per user only.
 */
export const driveConnectionSchema = z
  .object({
    id: z.string().uuid(),
    googleSub: googleSubSchema,
    email: z.string().trim().min(3).max(320),
    displayName: z.string().trim().min(1).max(200).nullable(),
    createdAt: z.string().datetime(),
    lastVerifiedAt: z.string().datetime(),
  })
  .strict();
export type DriveConnection = z.infer<typeof driveConnectionSchema>;

/** `POST /drive-connections` (route is E5) — the captured consent identity. */
export const createDriveConnectionRequestSchema = z
  .object({
    googleSub: googleSubSchema,
    email: z.string().trim().min(3).max(320),
    displayName: z.string().trim().min(1).max(200).nullable().default(null),
  })
  .strict();
export type CreateDriveConnectionRequest = z.infer<typeof createDriveConnectionRequestSchema>;

export const createDriveConnectionResponseSchema = z
  .object({ connection: driveConnectionSchema })
  .strict();
export type CreateDriveConnectionResponse = z.infer<typeof createDriveConnectionResponseSchema>;

export const driveConnectionListResponseSchema = z
  .object({ connections: z.array(driveConnectionSchema) })
  .strict();
export type DriveConnectionListResponse = z.infer<typeof driveConnectionListResponseSchema>;

export const driveConnectionIdParamSchema = z.object({ connectionId: z.string().uuid() }).strict();
export type DriveConnectionIdParam = z.infer<typeof driveConnectionIdParamSchema>;

// ── Envelope v2 header (§5) ──────────────────────────────────────────────────

/** The three doc kinds of a vault's document set (§5). */
export const VAULT_DOC_KINDS = ['header', 'common', 'portfolio'] as const;
export const vaultDocKindSchema = z.enum(VAULT_DOC_KINDS);
export type VaultDocKind = z.infer<typeof vaultDocKindSchema>;

/**
 * base64url(sha256(...)) — 43 chars unpadded. Used by `accountBinding`.
 */
export const vaultAccountBindingSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, 'must be an unpadded base64url sha256 digest');
export type VaultAccountBinding = z.infer<typeof vaultAccountBindingSchema>;

/**
 * One wrapped copy of the random content key K_c. v2's evolution of v1's
 * `wrappedKeys`: no per-slot KDF parameters — the §4 derivation chain is fixed
 * by the slot kind (`seed-v1` ⇒ BIP39-standard PBKDF2 + HKDF with the vaultId
 * in the info string), so there is nothing tunable for an attacker to weaken.
 */
export const vaultKeySlotSchema = z
  .object({
    keyId: z.string().uuid(),
    slot: z.literal(VAULT_KEY_SLOT_SEED_V1),
    /** base64url AES-256-GCM wrap of K_c under K_wrap. */
    wrappedKc: z.string().min(1),
  })
  .strict();
export type VaultKeySlot = z.infer<typeof vaultKeySlotSchema>;

/**
 * The full cleartext envelope v2 header (§5). Counters, ids and crypto
 * parameters ONLY — never portfolio information. The FULL SERIALIZED HEADER is
 * bound as AES-GCM additional authenticated data, so ANY header tamper —
 * including a `formatVersion` rollback and the §8 swap attacks (`vaultId`,
 * `docId`, `accountBinding`) — fails decryption on the client before any
 * payload byte is interpreted.
 */
export const vaultDocEnvelopeHeaderSchema = z
  .object({
    formatVersion: z.literal(VAULT_DOC_FORMAT_VERSION),
    cipher: z.literal(VAULT_CONTENT_CIPHER),
    iv: z.string().min(1),
    /** The active content key id — matches one `keySlots[].keyId`. */
    keyId: z.string().uuid(),
    keySlots: z.array(vaultKeySlotSchema).min(1),
    vaultId: z.string().uuid(),
    docId: z.string().uuid(),
    docKind: vaultDocKindSchema,
    /** base64url sha256({@link VAULT_ACCOUNT_BINDING_INFO_PREFIX} + accountId). */
    accountBinding: vaultAccountBindingSchema,
    /** The per-doc monotonic CAS token (§6). */
    docVersion: vaultDocVersionSchema,
    /** Payload schema version of the doc kind ({@link VAULT_DOC_SCHEMA_VERSION}). */
    schemaVersion: z.number().int().positive(),
    deviceId: z.string().uuid(),
    writeId: z.string().uuid(),
    writtenAt: z.string().datetime(),
  })
  .strict();
export type VaultDocEnvelopeHeader = z.infer<typeof vaultDocEnvelopeHeaderSchema>;

/**
 * The ONLY view of a v2 header the server is allowed to read — the format
 * version and the per-doc CAS token. Non-strict, so it strips every other
 * field on parse: the blind store literally cannot inspect the crypto
 * parameters or key slots, exactly like v1's `vaultServerHeaderSchema`.
 */
export const vaultDocServerHeaderSchema = z.object({
  formatVersion: z.number().int().positive(),
  docVersion: vaultDocVersionSchema,
});
export type VaultDocServerHeader = z.infer<typeof vaultDocServerHeaderSchema>;

// ── Envelope v2 codec (isomorphic) ───────────────────────────────────────────

/**
 * Canonically serialize a v2 header. THE EXACT RETURNED BYTES are the AES-GCM
 * additional authenticated data — encrypting and decrypting sides must both
 * authenticate the serialized header verbatim (readers authenticate the wire
 * bytes they decoded, never a re-serialization; see the v1 envelope note on
 * JSON member order).
 */
export function serializeVaultDocHeader(header: VaultDocEnvelopeHeader): Uint8Array {
  const parsed = vaultDocEnvelopeHeaderSchema.safeParse(header);
  if (!parsed.success) {
    throw new VaultEnvelopeError('vault doc header does not match the envelope v2 contract');
  }
  return new TextEncoder().encode(JSON.stringify(parsed.data));
}

/**
 * Encode a v2 header + ciphertext into the wire envelope. The framing (magic ·
 * 4-byte big-endian header length · UTF-8 JSON header · ciphertext) is v1's,
 * kept verbatim (§5).
 */
export function encodeVaultDocEnvelope(
  header: VaultDocEnvelopeHeader,
  ciphertext: Uint8Array,
): Uint8Array {
  const parsed = vaultDocEnvelopeHeaderSchema.safeParse(header);
  if (!parsed.success) {
    throw new VaultEnvelopeError('vault doc header does not match the envelope v2 contract');
  }
  return encodeVaultEnvelope(parsed.data, ciphertext);
}

export type VaultDocEnvelopeInspection =
  | {
      status: 'supported';
      header: VaultDocEnvelopeHeader;
      /** The exact wire header bytes — the AES-GCM AAD. */
      headerBytes: Uint8Array;
      ciphertext: Uint8Array;
    }
  | {
      /**
       * Written by a NEWER app version: surfaced read-only with an
       * "update the app" notice. The header was version-peeked but NEVER
       * best-effort parsed, and nothing may write over the doc (§5).
       */
      status: 'update-required';
      formatVersion: number;
      schemaVersion: number | null;
    };

function peekVersions(header: unknown): { formatVersion: number; schemaVersion: number | null } {
  if (typeof header !== 'object' || header === null) {
    throw new VaultEnvelopeError('vault doc envelope header is not an object');
  }
  const candidate = header as Record<string, unknown>;
  if (!Number.isInteger(candidate.formatVersion)) {
    throw new VaultEnvelopeError('vault doc envelope header has no integer formatVersion');
  }
  return {
    formatVersion: candidate.formatVersion as number,
    schemaVersion: Number.isInteger(candidate.schemaVersion)
      ? (candidate.schemaVersion as number)
      : null,
  };
}

/**
 * Split a v2 wire envelope WITHOUT decrypting, with strict fail-closed
 * versioning (§5):
 *
 *  - a NEWER `formatVersion` (or a v2 envelope carrying a newer payload
 *    `schemaVersion`) returns `update-required` — the header is never parsed
 *    beyond the version peek, so unknown future fields cannot be misread;
 *  - a v1 ACCOUNT-vault envelope (`formatVersion: 1`) is NOT a doc envelope
 *    and is rejected as malformed rather than silently downgraded;
 *  - anything else must strict-parse as the v2 header or the envelope is
 *    rejected.
 *
 * Throws {@link VaultEnvelopeError} on malformation.
 */
export function inspectVaultDocEnvelope(bytes: Uint8Array): VaultDocEnvelopeInspection {
  const { header, headerBytes, ciphertext } = decodeVaultEnvelope(bytes);
  const versions = peekVersions(header);
  if (versions.formatVersion > VAULT_DOC_FORMAT_VERSION) {
    return { status: 'update-required', ...versions };
  }
  if (
    versions.formatVersion === VAULT_DOC_FORMAT_VERSION &&
    versions.schemaVersion !== null &&
    versions.schemaVersion > VAULT_DOC_SCHEMA_VERSION
  ) {
    return { status: 'update-required', ...versions };
  }
  const parsed = vaultDocEnvelopeHeaderSchema.safeParse(header);
  if (!parsed.success) {
    throw new VaultEnvelopeError('vault doc envelope header does not match the v2 contract');
  }
  return { status: 'supported', header: parsed.data, headerBytes, ciphertext };
}

/**
 * Server-side header read for the per-doc blind store (E1): decode the wire
 * prefix and validate ONLY the two fields the store is entitled to. Never
 * gates on version — the server stores newer formats verbatim; versioning is a
 * CLIENT decision (§5).
 */
export function readVaultDocServerHeader(bytes: Uint8Array): VaultDocServerHeader {
  const { header } = decodeVaultEnvelope(bytes);
  const parsed = vaultDocServerHeaderSchema.safeParse(header);
  if (!parsed.success) {
    throw new VaultEnvelopeError('vault doc envelope header missing formatVersion/docVersion');
  }
  return parsed.data;
}

// ── Doc buckets: which doc carries which entity kind (§5) ────────────────────

export const VAULT_DOC_BUCKETS = ['portfolio', 'common'] as const;
export type VaultDocBucket = (typeof VAULT_DOC_BUCKETS)[number];

/**
 * The binding doc bucket per entity kind, decided MECHANICALLY by the row's
 * actual scoping column (issue #1410): portfolio-scoped (a `portfolio_id`
 * anywhere on its ownership chain) ⇒ the member portfolio's own doc;
 * account-scoped-but-vault-referenced ⇒ the vault's `common` doc.
 *
 * The API's `PARANOID_VAULT_DOC_BUCKETS` (manifest.ts) derives its table-keyed
 * map from this record through `VAULT_TABLE_ENTITY_KINDS`, and the typed
 * `Record` over the full kind enum makes the axis exhaustive at compile time —
 * a new entity kind cannot ship without choosing its doc.
 *
 * NOTE (design-note nuance, recorded): the note's §5 wording says "expense
 * rows scoped to it" ride the portfolio doc, but the V5-P9 expense tables are
 * ACCOUNT-scoped in the live schema (`user_id`, no portfolio column) — so the
 * mechanical rule lands them in the `common` doc. If a portfolio-scoped
 * expense area ever ships, its tables classify `portfolio` by the same rule.
 */
export const VAULT_ENTITY_DOC_BUCKETS: Record<VaultEntityKind, VaultDocBucket> = {
  // portfolio-scoped → the portfolio doc (§5)
  portfolio: 'portfolio',
  transaction: 'portfolio',
  dividend: 'portfolio',
  cashSource: 'portfolio',
  cashMovement: 'portfolio',
  portfolioSetting: 'portfolio',
  standingOrder: 'portfolio',
  standingOrderRun: 'portfolio',
  importBatch: 'portfolio',
  importRow: 'portfolio',
  portfolioDailySnapshot: 'portfolio',
  portfolioSnapshotState: 'portfolio',
  // movement-scoped link rows and portfolio-keyed budgets follow the movement
  cashMovementTag: 'portfolio',
  cashBudget: 'portfolio',
  cashBudgetFire: 'portfolio',
  // account-scoped, vault-referenced → the common doc (§5)
  taxSetting: 'common',
  customAsset: 'common',
  customAssetValue: 'common',
  expenseCategory: 'common',
  expenseTransaction: 'common',
  expenseRule: 'common',
  expenseBudget: 'common',
  expenseBudgetFire: 'common',
  cashTag: 'common',
  cashRule: 'common',
  cashRuleTag: 'common',
};

const bucketKinds = (bucket: VaultDocBucket): VaultEntityKind[] =>
  (Object.entries(VAULT_ENTITY_DOC_BUCKETS) as [VaultEntityKind, VaultDocBucket][])
    .filter(([, b]) => b === bucket)
    .map(([kind]) => kind)
    .sort();

/** Entity kinds carried by each member portfolio's own doc (derived). */
export const VAULT_PORTFOLIO_DOC_ENTITY_KINDS: readonly VaultEntityKind[] =
  bucketKinds('portfolio');
/** Entity kinds carried by the vault-wide common doc (derived). */
export const VAULT_COMMON_DOC_ENTITY_KINDS: readonly VaultEntityKind[] = bucketKinds('common');

// ── The doc set: header / common / portfolio payloads (§5) ──────────────────
//
// Payload rules carried VERBATIM from v1 §2/§4: uuidv7 entity ids; per-entity
// monotonic `rev` + `editedAt` + writing `deviceId` (vaultEntityMetaSchema);
// tombstones kept ≥ 180 days; pure v(n)→v(n+1) schema migrations on load;
// NEWER-version docs go read-only with an "update the app" notice.

/** Tombstone retention floor (§5) — merge correctness for long-offline devices. */
export const VAULT_TOMBSTONE_RETENTION_DAYS = 180;

const vaultEntityKindSubset = (kinds: readonly VaultEntityKind[]) =>
  vaultEntityKindSchema.refine((kind) => kinds.includes(kind), {
    message: 'entity kind belongs to the other doc bucket',
  });

/**
 * The `header` doc — vault metadata under encryption: the TRUE vault name, the
 * member-portfolio roster (ids + display names), the keySlots echo (a device
 * with only the words + any one medium can rebuild everything, §8 autonomy),
 * the §8 Drive-connection identity echo, and the creation record. Small,
 * rewritten rarely.
 */
export const vaultHeaderDocSchema = z
  .object({
    schemaVersion: z.literal(VAULT_DOC_SCHEMA_VERSION),
    name: vaultNameSchema,
    portfolios: z
      .array(z.object({ id: z.string().uuid(), name: z.string().min(1) }).strict())
      .default([]),
    keySlots: z.array(vaultKeySlotSchema).min(1),
    /**
     * §8: the bound Drive connection's identity, echoed under encryption so the
     * server registry stays convenience — never a discovery prerequisite.
     * `null` for a vault with no Drive medium.
     */
    driveConnection: z
      .object({ googleSub: googleSubSchema, email: z.string().trim().min(3).max(320) })
      .strict()
      .nullable(),
    created: z.object({ at: z.string().datetime(), deviceId: z.string().uuid() }).strict(),
  })
  .strict();
export type VaultHeaderDoc = z.infer<typeof vaultHeaderDocSchema>;

/**
 * The `common` doc — account-scoped material the vault's member portfolios
 * reference (§5): the custom-asset bucket (same snapshot/tombstone/claim-seam
 * semantics as v1, including `asset_identities`), severed-fork MIRRORCHAIN
 * provenance for member portfolios (v1 §7.1 discipline unchanged), the
 * retirement-proof Ed25519 PRIVATE key (§7 — the purge gate proves possession
 * of the vault, not of a session), and the merge log.
 */
export const vaultCommonDocSchema = z
  .object({
    schemaVersion: z.literal(VAULT_DOC_SCHEMA_VERSION),
    entities: z.record(
      vaultEntityKindSubset(VAULT_COMMON_DOC_ENTITY_KINDS),
      z.array(vaultEntitySchema),
    ),
    mergeLog: z.array(vaultMergeRecordSchema).default([]),
    mirrorProvenance: z.array(vaultMirrorProvenanceSchema).default([]),
    /** Reused v1 shape: `{ retirementProof: { publicKey, privateKey } }`. */
    clientSecurity: vaultClientSecuritySchema,
  })
  .strict();
export type VaultCommonDoc = z.infer<typeof vaultCommonDocSchema>;

/**
 * One `portfolio` doc per member portfolio — every `vault`-classified,
 * portfolio-bucketed row of that portfolio (§5): transactions, dividends, cash
 * sources + movements, per-portfolio settings, standing-order definitions +
 * the `standing_order_runs` exactly-once ledger, import batches/rows.
 * Snapshots stay derived-and-purged, never carried by a WRITER — the kinds
 * remain admissible so a reader can fail a stray doc gracefully instead of
 * corrupting on it.
 */
export const vaultPortfolioDocSchema = z
  .object({
    schemaVersion: z.literal(VAULT_DOC_SCHEMA_VERSION),
    /** Self-check anchor: must equal the stub row + the blob's `portfolio_id`. */
    portfolioId: z.string().uuid(),
    entities: z.record(
      vaultEntityKindSubset(VAULT_PORTFOLIO_DOC_ENTITY_KINDS),
      z.array(vaultEntitySchema),
    ),
    mergeLog: z.array(vaultMergeRecordSchema).default([]),
  })
  .strict();
export type VaultPortfolioDoc = z.infer<typeof vaultPortfolioDocSchema>;

// ── Per-doc CAS transport (§6) — re-keyed from the v1 `GET/PUT /vault` ───────
//
// The transport itself is v1's, verbatim per doc: raw envelope bytes, the
// `ETag`/`If-Match` header pair carrying the integer version (`vaultEtag` /
// `parseVaultEtag` in ./vault are reused unchanged), `If-None-Match: *` for
// the first write, 412 on a CAS miss, and the blind history reads
// (`vaultHistoryMetadataSchema` / `vaultHistoryListQuerySchema` /
// `vaultHistoryListResponseSchema` are reused unchanged — their shapes carry
// no account/doc key). What E0 re-keys is the ADDRESS: every route talks about
// one `(vaultId, docId)`.

/** Route params of the per-doc blind store: `/vaults/:vaultId/docs/:docId`. */
export const vaultDocParamsSchema = z
  .object({ vaultId: z.string().uuid(), docId: z.string().uuid() })
  .strict();
export type VaultDocParams = z.infer<typeof vaultDocParamsSchema>;

/** Route params of one per-doc historical blob read. */
export const vaultDocHistoryVersionParamSchema = z
  .object({
    vaultId: z.string().uuid(),
    docId: z.string().uuid(),
    version: z.coerce.number().int().min(1).max(VAULT_VERSION_MAX),
  })
  .strict();
export type VaultDocHistoryVersionParam = z.infer<typeof vaultDocHistoryVersionParamSchema>;

// ── Per-portfolio revision token + move-in / move-out bodies (§9, §10) ───────

/**
 * `GET /portfolios/:id/vault/revision` (route is E1/E4) — an opaque digest
 * over exactly the portfolio's restorable `vault`-classified rows (the
 * `computeNormalDataRevision` machinery re-scoped per portfolio; `purge`-only
 * tables excluded for the same spurious-conflict reason recorded in
 * manifest.ts). It carries no portfolio content, exists only to be handed back
 * to move-in, and changes on ANY write to the portfolio's captured rows.
 */
export const portfolioDataRevisionSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
export type PortfolioDataRevision = z.infer<typeof portfolioDataRevisionSchema>;

export const portfolioVaultRevisionResponseSchema = z
  .object({ portfolioDataRevision: portfolioDataRevisionSchema })
  .strict();
export type PortfolioVaultRevisionResponse = z.infer<typeof portfolioVaultRevisionResponseSchema>;

/**
 * `POST /portfolios/:id/vault/move-in` (route is E4) — the destructive commit
 * (§9 step 4). `docVersion` is the portfolio doc version the client wrote and
 * round-trip-verified on every vault medium; `portfolioDataRevision` binds the
 * capture to this commit (double-read CAS — any write in between refuses the
 * move instead of hard-deleting rows the doc never captured); `stepUp` is the
 * §15 in-body re-auth.
 */
export const portfolioVaultMoveInRequestSchema = z
  .object({
    vaultId: z.string().uuid(),
    docVersion: vaultDocVersionSchema,
    portfolioDataRevision: portfolioDataRevisionSchema,
    stepUp: vaultStepUpCredentialSchema,
  })
  .strict();
export type PortfolioVaultMoveInRequest = z.infer<typeof portfolioVaultMoveInRequestSchema>;

/**
 * `POST /portfolios/:id/vault/move-out` (route is E4) — the designed exit
 * (§10), from an unlocked device only. `moveOutId` is the client-supplied
 * idempotency key (the v1 `rehydrationId` pattern — retry-safe, never
 * double-restores). `document` is the STRICT per-portfolio restore graph;
 * its concrete schema (the per-portfolio `toStrictRestoreDocument` re-scope
 * with solvency + fork-provenance validation) is pinned by E4, which MUST
 * replace this JSON-transport placeholder with it — the field is transport
 * shape only and is never applied without E4's strict fail-closed parse.
 */
export const portfolioVaultMoveOutRequestSchema = z
  .object({
    vaultId: z.string().uuid(),
    moveOutId: z.string().uuid(),
    document: vaultJsonSchema,
    stepUp: vaultStepUpCredentialSchema,
  })
  .strict();
export type PortfolioVaultMoveOutRequest = z.infer<typeof portfolioVaultMoveOutRequestSchema>;
