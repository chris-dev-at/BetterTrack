import { z } from 'zod';

import { MAX_PASSWORD_LENGTH } from './auth';
import { cashRuleMatchTypeSchema } from './cash';
import { expenseDirectionSchema, expenseRuleMatchTypeSchema } from './expenses';
import {
  IMPORT_ROW_CANDIDATE_LIMIT,
  importBatchStatusSchema,
  importRowCandidateSchema,
  importRowFlagSchema,
  importRowKindSchema,
  importRowResultSchema,
} from './imports';
import { currencyCodeSchema } from './market';
import { mirrorRowKindSchema } from './mirrorchain';
import {
  cashMovementKindSchema,
  cashSourceTypeSchema,
  portfolioKindSchema,
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
/** First payload document version, retained for legacy encrypted vaults. */
export const VAULT_DOCUMENT_V1_VERSION = 1;
/** Latest payload document version (`schemaVersion` in the header + document). */
export const VAULT_DOCUMENT_VERSION = 2;
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
/** Browser-visible lifetime of one inactive server-medium staging candidate. */
export const VAULT_SERVER_CANDIDATE_TTL_MS = 10 * 60 * 1000;
/**
 * A retired server copy remains recoverable for at least this long before an
 * explicit client proof may purge it. This delay deliberately cannot be
 * shortened by a PATCH assertion.
 */
export const VAULT_RETIRED_SERVER_MIN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** A server-issued purge challenge is intentionally short lived. */
export const VAULT_RETIRED_PURGE_CHALLENGE_TTL_MS = 5 * 60 * 1000;

/** The monotonic CAS token (`vaultVersion`). The first stored blob is 1. */
export const vaultVersionSchema = z.number().int().min(1).max(VAULT_VERSION_MAX);

// ── Privacy mode + media set ─────────────────────────────────────────────────

/**
 * Account privacy mode (`users.privacy_mode`, `docs/paranoid-design.md` §1). It
 * is account metadata (present even in Drive-only mode) — knowing THAT a user is
 * paranoid is not portfolio data; it is required to enforce the §8 kill list.
 */
export const PRIVACY_MODES = ['normal', 'paranoid'] as const;
export const privacyModeSchema = z.enum(PRIVACY_MODES);
export type PrivacyMode = z.infer<typeof privacyModeSchema>;

/** Stable server capabilities whose cleartext surfaces are absent in paranoid mode. */
export const PARANOID_KILLED_CAPABILITIES = [
  'publicProfile',
  'sharing',
  'mirrorchain',
  'portfolioServer',
  'imports',
  'portfolioApiScope',
  'standingOrderExecution',
  'portfolioJobs',
  'portfolioWebhooks',
] as const;
export type ParanoidKilledCapability = (typeof PARANOID_KILLED_CAPABILITIES)[number];

export interface ParanoidServerRouteReference {
  readonly capability: ParanoidKilledCapability;
  readonly method?: string;
  readonly match: 'exact' | 'prefix' | 'pattern';
  readonly path: string;
  readonly flags?: string;
  readonly source?: {
    readonly file: string;
    readonly symbol: string;
  };
}

export interface ParanoidClientRouteRule {
  readonly match: 'exact' | 'prefix';
  readonly path: string;
  readonly destination: string;
}

export interface ParanoidClientRouteDecision {
  readonly id: string;
  readonly serverRoutes: readonly ParanoidServerRouteReference[];
  readonly clientRoutes: readonly ParanoidClientRouteRule[];
  /** Why these client routes are absent, or why no route-level gate is needed. */
  readonly reason: string;
}

/**
 * The shared server-to-client §8 kill decision matrix. Server route rules are
 * references rather than executable matchers so this stays browser-safe. The
 * API completeness test binds every reference to `PARANOID_KILL_REGISTRY`; the
 * SPA derives its route gate and redirect destination from `clientRoutes`.
 * An empty client list is an explicit decision, never an implicit allow.
 */
export const PARANOID_CLIENT_ROUTE_DECISIONS: readonly ParanoidClientRouteDecision[] = [
  {
    id: 'public-profiles',
    serverRoutes: [{ capability: 'publicProfile', match: 'prefix', path: '/social/profiles/' }],
    clientRoutes: [
      { match: 'prefix', path: '/u', destination: '/portfolio' },
      { match: 'prefix', path: '/people/profile', destination: '/people' },
      // The Control Center is an overlay: land on a neighbouring panel instead
      // of closing the popup by redirecting to `/portfolio`.
      { match: 'prefix', path: '/control/profile', destination: '/control/account' },
      { match: 'prefix', path: '/settings/profile', destination: '/portfolio' },
      { match: 'prefix', path: '/social/profile', destination: '/people' },
    ],
    reason:
      'Public-profile pages depend on server profile data and are absent for paranoid accounts.',
  },
  {
    id: 'sharing-and-mirrorchain',
    serverRoutes: [
      { capability: 'sharing', match: 'prefix', path: '/social/links/' },
      { capability: 'sharing', match: 'exact', path: '/social/groups' },
      { capability: 'sharing', match: 'prefix', path: '/social/groups/' },
      { capability: 'sharing', match: 'exact', path: '/social/follows' },
      { capability: 'sharing', match: 'prefix', path: '/social/follows/' },
      { capability: 'sharing', match: 'exact', path: '/social/followers' },
      { capability: 'sharing', match: 'exact', path: '/social/item-follows' },
      { capability: 'sharing', match: 'prefix', path: '/social/item-follows/' },
      { capability: 'sharing', match: 'exact', path: '/social/shared' },
      { capability: 'sharing', match: 'prefix', path: '/social/shared/' },
      { capability: 'sharing', match: 'exact', path: '/social/my-shared' },
      { capability: 'sharing', match: 'prefix', path: '/social/audience/' },
      { capability: 'sharing', match: 'prefix', path: '/social/items/' },
      { capability: 'sharing', match: 'prefix', path: '/social/comments/' },
      { capability: 'sharing', match: 'exact', path: '/alerts/sharing' },
      { capability: 'sharing', match: 'exact', path: '/workboard/sharing' },
      {
        capability: 'sharing',
        match: 'pattern',
        path: '^/ideas/[^/]+/clone$',
      },
      { capability: 'sharing', match: 'prefix', path: '/backtest/shared/' },
      { capability: 'mirrorchain', match: 'prefix', path: '/mirrorchain/' },
    ],
    clientRoutes: [
      { match: 'prefix', path: '/s', destination: '/portfolio' },
      { match: 'prefix', path: '/people/shared', destination: '/people' },
      { match: 'exact', path: '/people/following', destination: '/people' },
      { match: 'prefix', path: '/portfolio/people', destination: '/portfolio' },
      { match: 'prefix', path: '/social/my-shared', destination: '/people' },
      { match: 'prefix', path: '/social/shared-with-me', destination: '/people' },
    ],
    reason:
      'Sharing, following, public links, and mirror membership require server-side social rows, so their combined SPA surfaces are absent.',
  },
  {
    id: 'client-backed-portfolio',
    serverRoutes: [
      { capability: 'portfolioServer', match: 'exact', path: '/portfolios' },
      { capability: 'portfolioServer', match: 'prefix', path: '/portfolios/' },
      { capability: 'portfolioServer', match: 'exact', path: '/custom-assets' },
      { capability: 'portfolioServer', match: 'prefix', path: '/custom-assets/' },
      { capability: 'portfolioServer', match: 'prefix', path: '/analytics/' },
    ],
    clientRoutes: [],
    reason:
      'Core portfolio, custom-asset, and analytics routes stay mounted because paranoid mode serves their equivalents from the decrypted client vault.',
  },
  /**
   * The expense area (V5-P9). Its `/expenses/*` endpoints are already refused
   * server-side under the `portfolioServer` capability (the PD3b enforcement
   * registry), so these five pages are hidden rather than left to 403 into an
   * empty shell. The DATA is not killed: the expense tables are vault-classified,
   * `migration.ts` carries every category/transaction/rule/budget into the blob,
   * and the whole area returns intact on disable. Re-deriving these pages against
   * the vault store is v6 follow-up work — recorded in PROJECTPLAN §16
   * (2026-07-31, issue #729) and as kill-list item 11 in docs/paranoid-design.md
   * §8, because §8's rule is that an absent surface is a documented one.
   *
   * `/portfolio/cash-flow/accounts` deliberately stays live: cash sources are
   * portfolio rows served by the vault store, not expense rows.
   *
   * The area was renamed `/portfolio/cash` with three tabs plus setup pages
   * (V5 cash fusion phase 2 — the fused ledger's overview/movements/budgets/
   * labels read the SERVER cash endpoints, which the PD3b registry refuses for a
   * paranoid account), so the SAME kill decision covers both vocabularies: the
   * legacy names for deep links and bookmarks, the canonical names for the live
   * router. `/portfolio/cash/accounts` stays live exactly like its legacy alias.
   */
  {
    id: 'expense-and-cash-pages',
    serverRoutes: [
      { capability: 'portfolioServer', match: 'prefix', path: '/expenses/categories' },
      { capability: 'portfolioServer', match: 'prefix', path: '/expenses/transactions' },
      { capability: 'portfolioServer', match: 'prefix', path: '/expenses/rules' },
      { capability: 'portfolioServer', match: 'prefix', path: '/expenses/summary' },
      { capability: 'portfolioServer', match: 'prefix', path: '/expenses/trends' },
      { capability: 'portfolioServer', match: 'prefix', path: '/expenses/budgets' },
      { capability: 'portfolioServer', match: 'prefix', path: '/cash/tags' },
      { capability: 'portfolioServer', match: 'prefix', path: '/cash/movements/' },
      { capability: 'portfolioServer', match: 'prefix', path: '/cash/budgets' },
      { capability: 'portfolioServer', match: 'prefix', path: '/cash/rules' },
      { capability: 'portfolioServer', match: 'prefix', path: '/cash/summary' },
      { capability: 'portfolioServer', match: 'prefix', path: '/cash/trends' },
    ],
    clientRoutes: [
      { match: 'exact', path: '/portfolio/cash-flow', destination: '/portfolio/cash/accounts' },
      {
        match: 'exact',
        path: '/portfolio/cash-flow/transactions',
        destination: '/portfolio/cash/accounts',
      },
      {
        match: 'exact',
        path: '/portfolio/cash-flow/budgets',
        destination: '/portfolio/cash/accounts',
      },
      {
        match: 'exact',
        path: '/portfolio/cash-flow/categories',
        destination: '/portfolio/cash/accounts',
      },
      {
        match: 'exact',
        path: '/portfolio/cash-flow/rules',
        destination: '/portfolio/cash/accounts',
      },
      { match: 'exact', path: '/portfolio/cash', destination: '/portfolio/cash/accounts' },
      {
        match: 'exact',
        path: '/portfolio/cash/movements',
        destination: '/portfolio/cash/accounts',
      },
      {
        match: 'exact',
        path: '/portfolio/cash/transactions',
        destination: '/portfolio/cash/accounts',
      },
      {
        match: 'exact',
        path: '/portfolio/cash/budgets',
        destination: '/portfolio/cash/accounts',
      },
      {
        match: 'exact',
        path: '/portfolio/cash/labels',
        destination: '/portfolio/cash/accounts',
      },
      {
        match: 'exact',
        path: '/portfolio/cash/tags',
        destination: '/portfolio/cash/accounts',
      },
      {
        match: 'exact',
        path: '/portfolio/cash/rules',
        destination: '/portfolio/cash/accounts',
      },
      {
        match: 'exact',
        path: '/portfolio/cash/categories',
        destination: '/portfolio/cash/accounts',
      },
    ],
    reason:
      'Expense and classified-cash pages still read refused server endpoints; only the client-backed cash accounts page remains mounted.',
  },
  {
    id: 'portfolio-dividend-calendar',
    serverRoutes: [
      {
        capability: 'portfolioServer',
        match: 'exact',
        path: '/assets/portfolio/dividend-calendar',
      },
    ],
    clientRoutes: [],
    reason:
      'The calendar has no standalone client route; its Home widget is unreachable because paranoid Home renders the client-backed portfolio substitute.',
  },
  {
    id: 'portfolio-dividend-projection',
    serverRoutes: [
      {
        capability: 'portfolioServer',
        match: 'exact',
        path: '/assets/portfolio/dividend-projection',
      },
    ],
    clientRoutes: [],
    reason:
      'Forecast stays mounted, but its dividend-projection query is disabled after privacy mode resolves paranoid.',
  },
  {
    id: 'portfolio-news-digest',
    serverRoutes: [
      {
        capability: 'portfolioServer',
        match: 'exact',
        path: '/assets/portfolio/news-digest',
      },
    ],
    clientRoutes: [{ match: 'prefix', path: '/assets/news', destination: '/assets' }],
    reason:
      'The portfolio news-digest route depends on cleartext server holdings; per-asset provider news remains available.',
  },
  {
    id: 'ai-insights-panel',
    serverRoutes: [
      {
        capability: 'portfolioServer',
        method: 'POST',
        match: 'exact',
        path: '/ai/insights',
      },
    ],
    clientRoutes: [],
    reason:
      'AI insights are a component-level panel rather than a route and are suppressed inside the client-backed analytics surface.',
  },
  {
    id: 'server-tax-settings-and-print',
    serverRoutes: [
      { capability: 'portfolioServer', match: 'exact', path: '/settings/taxes' },
      { capability: 'portfolioServer', match: 'exact', path: '/settings/taxes/years' },
    ],
    clientRoutes: [
      { match: 'prefix', path: '/portfolio/tax/print', destination: '/portfolio/tax' },
    ],
    reason:
      'Server tax settings and printable reports are absent; the main tax surface stays live through the client tax engine.',
  },
  {
    id: 'client-backed-home',
    serverRoutes: [
      { capability: 'portfolioServer', match: 'exact', path: '/settings/home' },
      { capability: 'portfolioServer', match: 'prefix', path: '/settings/widget-layout/' },
    ],
    clientRoutes: [],
    reason:
      'The root route stays mounted but paranoid Home replaces the server widget board with the client-backed Portfolio page before these endpoints can run.',
  },
  {
    id: 'imports',
    serverRoutes: [
      { capability: 'imports', match: 'exact', path: '/imports' },
      { capability: 'imports', match: 'prefix', path: '/imports/' },
      { capability: 'imports', match: 'prefix', path: '/expenses/import/' },
    ],
    clientRoutes: [
      { match: 'prefix', path: '/portfolio/import', destination: '/portfolio' },
      {
        match: 'prefix',
        path: '/portfolio/cash-flow/import',
        destination: '/portfolio/cash/accounts',
      },
      {
        match: 'prefix',
        path: '/portfolio/cash/import',
        destination: '/portfolio/cash/accounts',
      },
    ],
    reason:
      'Broker and expense imports execute on the server and are absent while the server has no cleartext portfolio data.',
  },
  {
    id: 'client-standing-orders',
    serverRoutes: [
      { capability: 'standingOrderExecution', match: 'exact', path: '/standing-orders' },
      { capability: 'standingOrderExecution', match: 'prefix', path: '/standing-orders/' },
    ],
    clientRoutes: [],
    reason:
      'The Forecast route stays mounted because paranoid standing orders are stored and materialized by the client vault runtime.',
  },
];

/**
 * A storage medium a blob syncs to (`§4`). `server` = the BetterTrack blind
 * store; `drive` = the user's visible BetterTrack Vaults folder. Both are blind
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

/**
 * The durable selection part of a media state. Transition callers submit this
 * small, ciphertext-free shape as their optimistic `expected` value; the server
 * adds the physical server disposition only in a response.
 */
const vaultMediaSelectionObjectSchema = z
  .object({
    mediaSet: vaultMediaSetSchema,
    driveAttestedVersion: vaultVersionSchema.nullable(),
  })
  .strict();

function refineMediaSelection(
  value: { mediaSet: VaultMediaSet; driveAttestedVersion: number | null },
  ctx: z.RefinementCtx,
): void {
  if (value.driveAttestedVersion !== null && !value.mediaSet.includes('drive')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['driveAttestedVersion'],
      message: 'a Drive attestation requires the Drive medium',
    });
  }
}

export const vaultMediaSelectionSchema =
  vaultMediaSelectionObjectSchema.superRefine(refineMediaSelection);
export type VaultMediaSelection = z.infer<typeof vaultMediaSelectionSchema>;

/**
 * Backward-compatible public media-state shape. Physical server disposition is
 * exposed by {@link paranoidVaultMediaStateSchema} only on the owner-scoped
 * media endpoint.
 */
export const vaultMediaStateSchema = vaultMediaSelectionSchema;
export type VaultMediaState = z.infer<typeof vaultMediaStateSchema>;

/** Canonical DER prefix of an Ed25519 SubjectPublicKeyInfo value. */
const ED25519_SPKI_DER_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);
const ED25519_SPKI_DER_BYTES = 44;
const ED25519_SPKI_BASE64URL_CHARS = 59;
const ED25519_PKCS8_DER_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);
const ED25519_PKCS8_DER_BYTES = 48;
const ED25519_PKCS8_BASE64URL_CHARS = 64;

/**
 * Decode unpadded base64url without relying on Node's Buffer so this contract
 * remains isomorphic. The caller performs its own character-set validation.
 */
function decodeBase64url(value: string): Uint8Array | null {
  const bytes = new Uint8Array(Math.floor((value.length * 6) / 8));
  let byteIndex = 0;
  let bufferedBits = 0;
  let buffer = 0;

  for (let index = 0; index < value.length; index += 1) {
    const charCode = value.charCodeAt(index);
    const digit =
      charCode >= 65 && charCode <= 90
        ? charCode - 65
        : charCode >= 97 && charCode <= 122
          ? charCode - 97 + 26
          : charCode >= 48 && charCode <= 57
            ? charCode - 48 + 52
            : charCode === 45
              ? 62
              : charCode === 95
                ? 63
                : -1;
    if (digit < 0) return null;

    buffer = (buffer << 6) | digit;
    bufferedBits += 6;
    if (bufferedBits >= 8) {
      bufferedBits -= 8;
      bytes[byteIndex] = (buffer >> bufferedBits) & 0xff;
      byteIndex += 1;
      buffer &= (1 << bufferedBits) - 1;
    }
  }

  // Base64url's unused trailing bits must be zero, otherwise multiple strings
  // could represent the same DER value.
  if (buffer !== 0 || byteIndex !== bytes.length) return null;
  return bytes;
}

function isEd25519SpkiBase64url(value: string): boolean {
  if (value.length !== ED25519_SPKI_BASE64URL_CHARS) return false;
  const der = decodeBase64url(value);
  if (!der || der.length !== ED25519_SPKI_DER_BYTES) return false;
  return ED25519_SPKI_DER_PREFIX.every((byte, index) => der[index] === byte);
}

function isEd25519Pkcs8Base64url(value: string): boolean {
  if (value.length !== ED25519_PKCS8_BASE64URL_CHARS) return false;
  const der = decodeBase64url(value);
  if (!der || der.length !== ED25519_PKCS8_DER_BYTES) return false;
  return ED25519_PKCS8_DER_PREFIX.every((byte, index) => der[index] === byte);
}

/**
 * Public verifier for an Ed25519 key whose private half remains only inside the
 * client-decrypted vault. It is canonical DER SPKI encoded as base64url; it is
 * not a Drive credential, vault key, token, file id, or portfolio datum.
 */
export const vaultRetirementProofPublicKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, 'must be base64url')
  .length(ED25519_SPKI_BASE64URL_CHARS, 'must encode a 44-byte DER SPKI key')
  .refine(isEd25519SpkiBase64url, 'must be a DER SPKI encoded Ed25519 public key');
export type VaultRetirementProofPublicKey = z.infer<typeof vaultRetirementProofPublicKeySchema>;

/**
 * The matching Ed25519 private key, encoded as canonical PKCS#8 and held only
 * inside the encrypted client document. It is never part of a server DTO.
 */
export const vaultRetirementProofPrivateKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, 'must be base64url')
  .length(ED25519_PKCS8_BASE64URL_CHARS, 'must encode a 48-byte DER PKCS#8 key')
  .refine(isEd25519Pkcs8Base64url, 'must be a DER PKCS#8 encoded Ed25519 private key');
export type VaultRetirementProofPrivateKey = z.infer<typeof vaultRetirementProofPrivateKeySchema>;

/**
 * Client-only security material encrypted with the rest of the vault. The
 * server may receive the public verifier header, but never this object or its
 * private key.
 */
export const vaultClientSecuritySchema = z
  .object({
    retirementProof: z
      .object({
        publicKey: vaultRetirementProofPublicKeySchema,
        privateKey: vaultRetirementProofPrivateKeySchema,
      })
      .strict(),
  })
  .strict();
export type VaultClientSecurity = z.infer<typeof vaultClientSecuritySchema>;

/** Portfolio-free receipt for an inactive server candidate. */
export const paranoidServerCandidateMetadataSchema = z
  .object({
    candidateId: z.string().uuid(),
    version: vaultVersionSchema,
    formatVersion: z.number().int().positive(),
    sizeBytes: z.number().int().positive(),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type ParanoidServerCandidateMetadata = z.infer<typeof paranoidServerCandidateMetadataSchema>;

/** Route parameter for one owner-scoped inactive candidate. */
export const paranoidServerCandidateParamSchema = z
  .object({ candidateId: z.string().uuid() })
  .strict();
export type ParanoidServerCandidateParam = z.infer<typeof paranoidServerCandidateParamSchema>;

/** Safe summary of the recoverable server-retirement set. */
export const retiredServerMetadataSchema = z
  .object({
    version: vaultVersionSchema,
    retiredAt: z.string().datetime(),
    purgeAfter: z.string().datetime(),
  })
  .strict();
export type RetiredServerMetadata = z.infer<typeof retiredServerMetadataSchema>;

/**
 * The current physical server disposition. It intentionally contains no raw
 * ciphertext: active bytes use `/vault`, inactive candidate bytes use their
 * scoped read-back route, and retired bytes use the bounded history route.
 */
export const vaultServerDispositionSchema = z.enum([
  'active',
  'inactive-candidate',
  'retired',
  'empty',
]);
export type VaultServerDisposition = z.infer<typeof vaultServerDispositionSchema>;

export const vaultServerStorageStateSchema = z
  .object({
    disposition: vaultServerDispositionSchema,
    candidate: paranoidServerCandidateMetadataSchema.nullable(),
    retired: retiredServerMetadataSchema.nullable(),
  })
  .strict();
export type VaultServerStorageState = z.infer<typeof vaultServerStorageStateSchema>;

/** Durable, portfolio-free media metadata plus the server-byte disposition. */
export const paranoidVaultMediaStateSchema = vaultMediaSelectionObjectSchema
  .extend({ server: vaultServerStorageStateSchema })
  .strict()
  .superRefine(refineMediaSelection);
export type ParanoidVaultMediaState = z.infer<typeof paranoidVaultMediaStateSchema>;

/** Owner-scoped media-state response. Normal accounts intentionally have none. */
export const paranoidMediaStateResponseSchema = z
  .object({
    privacyMode: privacyModeSchema,
    mediaState: paranoidVaultMediaStateSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.privacyMode === 'normal') !== (value.mediaState === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mediaState'],
        message: 'only a paranoid account may have vault media state',
      });
    }
  });
export type ParanoidMediaStateResponse = z.infer<typeof paranoidMediaStateResponseSchema>;

/** Server-verifiable read-back receipt emitted only when an inactive candidate is read. */
export const vaultCandidateReadbackSchema = z.string().min(32).max(2048);

/** Client assertion for a freshly read/decrypted Drive copy; no Drive capability crosses this API. */
export const vaultDriveReadbackSchema = z
  .object({ kind: z.literal('drive'), version: vaultVersionSchema })
  .strict();
/** Server-current read-back used when only Drive is removed. */
export const vaultServerReadbackSchema = z
  .object({ kind: z.literal('server'), version: vaultVersionSchema })
  .strict();
/** Candidate promotion is bound to the exact candidate and its read-back receipt. */
export const vaultServerCandidateReadbackSchema = z
  .object({
    kind: z.literal('server-candidate'),
    candidateId: z.string().uuid(),
    readback: vaultCandidateReadbackSchema,
  })
  .strict();
export const vaultMediaTransitionVerificationSchema = z.discriminatedUnion('kind', [
  vaultDriveReadbackSchema,
  vaultServerReadbackSchema,
  vaultServerCandidateReadbackSchema,
]);
export type VaultMediaTransitionVerification = z.infer<
  typeof vaultMediaTransitionVerificationSchema
>;

/**
 * One and only one media edge per request. Drive assertions can never delete
 * ciphertext: removal of `server` moves it into the retired set; purge is a
 * separately challenge-and-signature-gated operation below.
 */
export const paranoidMediaTransitionRequestSchema = z
  .object({
    expected: vaultMediaSelectionSchema,
    nextMediaSet: vaultMediaSetSchema,
    verification: vaultMediaTransitionVerificationSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const added = value.nextMediaSet.filter((medium) => !value.expected.mediaSet.includes(medium));
    const removed = value.expected.mediaSet.filter(
      (medium) => !value.nextMediaSet.includes(medium),
    );
    if (added.length + removed.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nextMediaSet'],
        message: 'a media transition must add or remove exactly one medium',
      });
      return;
    }
    const requiredKind =
      added[0] === 'server' ? 'server-candidate' : removed[0] === 'drive' ? 'server' : 'drive';
    if (value.verification.kind !== requiredKind) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verification', 'kind'],
        message: `this media transition requires a ${requiredKind} read-back`,
      });
    }
  });
export type ParanoidMediaTransitionRequest = z.infer<typeof paranoidMediaTransitionRequestSchema>;

export const paranoidMediaTransitionResponseSchema = paranoidVaultMediaStateSchema;
export type ParanoidMediaTransitionResponse = z.infer<typeof paranoidMediaTransitionResponseSchema>;

/** Request one short-lived, server-issued challenge for an explicit retirement set. */
export const retiredServerPurgeChallengeRequestSchema = z
  .object({ retiredVersion: vaultVersionSchema })
  .strict();
export type RetiredServerPurgeChallengeRequest = z.infer<
  typeof retiredServerPurgeChallengeRequestSchema
>;

export const retiredServerPurgeChallengeResponseSchema = z
  .object({
    retiredVersion: vaultVersionSchema,
    challenge: z.string().min(32).max(2048),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type RetiredServerPurgeChallengeResponse = z.infer<
  typeof retiredServerPurgeChallengeResponseSchema
>;

/**
 * A proof transcript is signed with the private Ed25519 key held in the
 * decrypted vault. `observedVersion` is the freshly read/decrypted external
 * vault version and must be at least the retired server version.
 */
export const retiredServerPurgeRequestSchema = z
  .object({
    retiredVersion: vaultVersionSchema,
    observedVersion: vaultVersionSchema,
    challenge: z.string().min(32).max(2048),
    signature: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/, 'must be base64url')
      .min(80)
      .max(256),
  })
  .strict();
export type RetiredServerPurgeRequest = z.infer<typeof retiredServerPurgeRequestSchema>;

export const retiredServerPurgeResponseSchema = z.object({ purged: z.literal(true) }).strict();
export type RetiredServerPurgeResponse = z.infer<typeof retiredServerPurgeResponseSchema>;

/** Domain-separated canonical bytes signed for a retired-server purge. */
export function serializeRetiredServerPurgeTranscript(input: {
  retiredVersion: number;
  observedVersion: number;
  challenge: string;
}): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify([
      'bettertrack.paranoid-retired-server-purge.v1',
      input.retiredVersion,
      input.observedVersion,
      input.challenge,
    ]),
  );
}

// ── Version + envelope header ────────────────────────────────────────────────

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
  // V5 cash fusion — the classification layer on the portfolio cash ledger.
  'cashTag',
  'cashMovementTag',
  'cashBudget',
  'cashBudgetFire',
  'cashRule',
  'cashRuleTag',
] as const;
export const vaultEntityKindSchema = z.enum(VAULT_ENTITY_KINDS);
export type VaultEntityKind = z.infer<typeof vaultEntityKindSchema>;

/**
 * Entity kinds whose normal-account rows survive paranoid enable only through
 * the encrypted document. This is the shared enrollment boundary for the web
 * capture branches and the API rehydration handlers: either side adding a kind
 * without the other must fail its completeness gate before the one-way purge
 * can run in production.
 */
export const PARANOID_REHYDRATION_HANDLERS = [
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
  'expenseCategory',
  'expenseTransaction',
  'expenseRule',
  'expenseBudget',
  'cashTag',
  'cashMovementTag',
  'cashBudget',
  'cashRule',
  'cashRuleTag',
] as const satisfies readonly VaultEntityKind[];

/**
 * Per-entity sync metadata (`§2`/`§4`): a uuidv7 id, a monotonic `rev` bumped on
 * every edit, an `editedAt` instant + the writing `editedBy` deviceId, and a
 * `deletedAt` tombstone (kept ≥ 180 days) so long-offline merges stay correct.
 * The entity-granularity merge rules (`§4`) key off exactly these fields.
 */
export const vaultEntityMetaSchema = z.object({
  id: z.string().uuid(),
  rev: z.number().int().nonnegative(),
  editedAt: z.string().datetime(),
  editedBy: z.string().uuid(),
  deletedAt: z.string().datetime().nullable(),
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
export const vaultJsonSchema: z.ZodType<VaultJson> = z.lazy(() =>
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
    /**
     * The `portfolios.kind` column (board #69). The ONE `.optional()` field in
     * this strict graph, and for exactly one reason: disable strict-parses the
     * rows a vault ALREADY holds (`paranoidDisable.ts` → `parseStrictEntity`),
     * and every document written before this column existed carries no `kind`
     * key at all. Required here would lock every pre-existing paranoid vault
     * out of disable. Nothing is defaulted or derived by admitting `undefined`
     * — absent and `null` both mean what the nullable column itself means,
     * "unclassified" — and every writer below (enable capture, vault create)
     * emits the field explicitly, so no *new* document is ever missing it.
     */
    kind: portfolioKindSchema.nullable().optional(),
    /**
     * `vaultId` re-gained a server column with the E0 per-portfolio vaults
     * keystone (#1410 — `portfolios.vault_id`, always NULL in any portfolio
     * this ACCOUNT-level document can carry: a per-portfolio-vaulted portfolio
     * is a content-free locked stub with nothing left to capture, and the two
     * paranoid systems are mutually exclusive per account until E9 retires
     * this one). `alias` remains VESTIGIAL: its v2 column was dropped by PR
     * #1392 and its E0 successor is deliberately named `vault_alias` /
     * `vaultAlias` (below) so the retired name stays retired.
     *
     * Both keep `.default(null)` because this object is `.strict()` and
     * describes the CLIENT-ENCRYPTED v1 document: every paranoid document
     * written while v2 existed carries both keys (zod's `.default(null)`
     * filled them in on parse and the client re-serialized what it parsed), so
     * dropping either would make those documents fail validation — a paranoid
     * account whose vault silently stops opening, with no server-side copy to
     * fall back on. Nothing reads them. Do not repurpose `alias`; a future
     * format version can drop it behind a document migration in
     * `migrateVaultDocument`.
     */
    vaultId: uuidSchema.nullable().default(null),
    alias: z.string().nullable().default(null),
    /**
     * The E0 locked-stub label column (`portfolios.vault_alias`, #1410).
     * Always NULL here for the same mutual-exclusion reason as `vaultId`;
     * `.default(null)` keeps every document written before the column existed
     * parseable (the `kind` / `dedupHash` precedent).
     */
    vaultAlias: z.string().nullable().default(null),
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
    // V5 cash fusion: the statement-import idempotency key and the non-EUR
    // provenance marker. Both must round-trip — dropping `dedupHash` on restore
    // would let a re-imported statement duplicate every row.
    //
    // `.default(null)` rather than a bare `.nullable()`: a vault document
    // written BEFORE cash fusion has neither key, and on a `.strict()` schema a
    // required-but-nullable field would fail it as VAULT_CORRUPT — a user's own
    // older vault or backup would stop opening. Defaulting keeps the parsed type
    // `string | null` (no `undefined` leaking into writers) while accepting the
    // older shape, which is exactly what the absent keys mean: no import hash,
    // amount genuinely in EUR.
    dedupHash: z.string().nullable().default(null),
    originalCurrency: currencyCodeSchema.nullable().default(null),
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

/**
 * The `import_rows.candidates` column as it appears inside a vault document.
 *
 * Exported ONLY so the API's OpenAPI builder can reach this exact instance:
 * zod-to-openapi 7.3.x has no `ZodCatch` transformer, and this schema is
 * reachable from the documented `PortfolioVaultMoveOutRequest` body, so the
 * generator needs a temporary `type` hint installed on the very instance the
 * parent object captured (a `.openapi()` clone is never what it walks into).
 * Same generator gap, same escape hatch as `vaultJsonSchema`'s `ZodLazy`.
 * Nothing else should import this — parse through the entity schemas.
 *
 * See the field's documentation in `importRowRowSchema` for why it degrades.
 */
export const vaultImportRowCandidatesSchema = z
  .array(importRowCandidateSchema)
  .max(IMPORT_ROW_CANDIDATE_LIMIT)
  .nullable()
  .optional()
  .catch(null);

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
    /**
     * The `import_rows.candidates` column: display-only near-matches for an
     * unresolved row (§13.4). Enrolled because the export-completeness sweep
     * requires every persisted column to appear in the strict payload.
     *
     * UNBREAKABLE BY CONSTRUCTION. `.nullable().optional()` because
     * restore/disable strict-parses documents written before this column
     * existed and those carry no `candidates` key at all — requiring it would
     * lock every pre-existing vault out, the same reason `portfolios.kind`
     * below is optional. `.catch(null)` because optionality alone is not
     * enough: this field is a "did you mean" list, and no display-only
     * suggestion may ever be the reason a user cannot get their portfolio back.
     * An over-cap array, an unknown inner `type`, an extra key inside a
     * candidate, or any other malformed shape degrades this ONE field to null
     * and the entity still parses. The alternative — a strict parse — throws
     * away a whole portfolio's transactions over a cosmetic suggestion list.
     *
     * NOTE FOR WHOEVER LANDS THE E10 WRITER SEAM: nothing in this repo
     * currently EMITS an `importRow` vault entity. Every `importRow`
     * touchpoint on both sides (`portfolioVaultRestoreRepository`,
     * `paranoidRehydrationService`, the web `portfolioRestoreDocument` /
     * `vaultPortfolioStore`) is a reader. So this field is presently written by
     * nobody, and the tolerance above is the only thing standing between a
     * future malformed value and an unrestorable portfolio. When the writer
     * arrives: it must be a full-row projection, because a HAND-LISTED
     * assembler that forgets `candidates` drops it silently — `.optional()`
     * cannot tell "absent because old document" from "absent because the
     * assembler forgot".
     */
    candidates: vaultImportRowCandidatesSchema,
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

// ── V5 cash fusion (migration 0075) ──
// `systemKey` mirrors the `text` column rather than the `CashSystemTagKey` enum:
// a restore must accept every value the column can already hold, so adding a
// system key later cannot make an existing vault unrestorable.

const cashTagRowSchema = z
  .object({
    userId: uuidSchema,
    name: z.string(),
    color: z.string(),
    system: z.boolean(),
    systemKey: z.string().nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

const cashMovementTagRowSchema = z
  .object({
    movementId: uuidSchema,
    tagId: uuidSchema,
    createdAt: timestampSchema,
  })
  .strict();

const cashBudgetRowSchema = z
  .object({
    portfolioId: uuidSchema,
    tagId: uuidSchema,
    /** NULL = the recurring monthly target; `YYYY-MM` = that month only. */
    periodKey: monthSchema.nullable(),
    amount: decimalStringSchema,
    currency: currencyCodeSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

const cashBudgetFireRowSchema = z
  .object({
    budgetId: uuidSchema,
    periodKey: monthSchema,
    firedAt: timestampSchema,
  })
  .strict();

const cashRuleRowSchema = z
  .object({
    userId: uuidSchema,
    matchType: cashRuleMatchTypeSchema,
    pattern: z.string(),
    priority: z.number().int(),
    enabled: z.boolean(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

const cashRuleTagRowSchema = z
  .object({
    ruleId: uuidSchema,
    tagId: uuidSchema,
    createdAt: timestampSchema,
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
  cashTag: cashTagRowSchema,
  cashMovementTag: cashMovementTagRowSchema,
  cashBudget: cashBudgetRowSchema,
  cashBudgetFire: cashBudgetFireRowSchema,
  cashRule: cashRuleRowSchema,
  cashRuleTag: cashRuleTagRowSchema,
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
  cash_tags: 'cashTag',
  cash_movement_tags: 'cashMovementTag',
  cash_budgets: 'cashBudget',
  cash_budget_fires: 'cashBudgetFire',
  cash_rules: 'cashRule',
  cash_rule_tags: 'cashRuleTag',
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
  cashTag: strictEntity('cashTag', cashTagRowSchema),
  cashMovementTag: strictEntity('cashMovementTag', cashMovementTagRowSchema),
  cashBudget: strictEntity('cashBudget', cashBudgetRowSchema),
  cashBudgetFire: strictEntity('cashBudgetFire', cashBudgetFireRowSchema),
  cashRule: strictEntity('cashRule', cashRuleRowSchema),
  cashRuleTag: strictEntity('cashRuleTag', cashRuleTagRowSchema),
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
  VAULT_ENTITY_SCHEMAS.cashTag,
  VAULT_ENTITY_SCHEMAS.cashMovementTag,
  VAULT_ENTITY_SCHEMAS.cashBudget,
  VAULT_ENTITY_SCHEMAS.cashBudgetFire,
  VAULT_ENTITY_SCHEMAS.cashRule,
  VAULT_ENTITY_SCHEMAS.cashRuleTag,
]);
export type VaultStrictEntity = z.infer<typeof vaultStrictEntitySchema>;

// ── Severed-fork MIRRORCHAIN provenance (additive within v1) ─────────────────

/**
 * One retained logical identity for a row the account keeps after leaving a
 * MIRRORCHAIN with a fork (`docs/paranoid-design.md` §7.1).
 *
 * `mirror_rows` is the server's logical↔local identity map, and it dies with the
 * copy: paranoid enable deletes the portfolio, so the map cascades away while the
 * append-only oplog keeps only the LOGICAL id. A sanctioned financial correction
 * (delete + re-create + repoint, mirrorchain design §2) means the surviving local
 * id is a REPLACEMENT — `localId = mirrorId` is false — so restore-time validation
 * has no sound way to associate a restored row with its origin op unless the map
 * itself is captured while it still exists.
 *
 * It therefore rides the encrypted document: privacy-wise this is the user's own
 * fork, and Drive-only accounts gain no new cleartext server-side alias table.
 * The two attribution columns of `mirror_rows` (`createdBy`,
 * `createdByUsername`) are deliberately NOT carried — they are a co-member's
 * identity, see {@link VAULT_MIRROR_PROVENANCE_DROPPED_COLUMNS}.
 */
export const vaultMirrorProvenanceSchema = z
  .object({
    /** The chain whose append-only oplog authenticates this identity. */
    chainId: uuidSchema,
    /**
     * The caller's OWN ended `mirror_chain_members` row for this copy — the
     * tombstone whose `applied_seq` bounds which ops may authenticate the row.
     * Re-joining a chain is a normal flow and mints a SECOND membership with its
     * own copy and its own (higher) watermark, so a chain id alone cannot select
     * the right one: an earlier retained fork must be proved against ITS
     * membership. It is the user's own membership row, never a co-member's.
     */
    membershipId: uuidSchema,
    /** `mirror_rows.kind` — which local table the logical entity landed in. */
    kind: mirrorRowKindSchema,
    /** The chain-wide logical entity id (stable across every copy). */
    mirrorId: uuidSchema,
    /** The forked copy the retained row belongs to. */
    portfolioId: uuidSchema,
    /** The CURRENT local row id — a replacement id after a correction. */
    localId: uuidSchema,
  })
  .strict();
export type VaultMirrorProvenance = z.infer<typeof vaultMirrorProvenanceSchema>;

/**
 * The `mirror_rows` columns the provenance record deliberately drops, with the
 * binding reason. The API's completeness gate compares
 * `columns(mirror_rows) === (keys(vaultMirrorProvenanceSchema) ∖
 * keys(VAULT_MIRROR_PROVENANCE_PROOF_FIELDS)) ∪ keys(this)`, so a future column
 * cannot silently enter or escape the encrypted carriage.
 */
export const VAULT_MIRROR_PROVENANCE_DROPPED_COLUMNS = {
  createdBy:
    'another member’s user id — restore-time validation never needs it and the vault must not carry a co-member identity',
  createdByUsername:
    'another member’s denormalized display name — attribution is chain-side rendering, not fork provenance',
} as const;

/**
 * Carried fields that are NOT `mirror_rows` columns, with the binding reason.
 * They exist so restore-time validation can select the exact membership the row
 * belongs to; the completeness gate subtracts them before comparing columns.
 */
export const VAULT_MIRROR_PROVENANCE_PROOF_FIELDS = {
  membershipId:
    'the caller’s own ended membership row — a re-joined chain has several, each with its own copy and watermark, so the tombstone identity is the minimum needed to pick the right one',
} as const;

/** Vault entity kind each `mirror_rows.kind` resolves to inside the document. */
export const VAULT_MIRROR_PROVENANCE_ENTITY_KINDS = {
  transaction: 'transaction',
  dividend: 'dividend',
  cash_movement: 'cashMovement',
  cash_source: 'cashSource',
} as const satisfies Record<z.infer<typeof mirrorRowKindSchema>, VaultEntityKind>;

/** A merge diagnostic record (`§4`); the payload keeps the last 20. */
export const vaultMergeRecordSchema = z.object({
  mergedAt: z.string().datetime(),
  parents: z.array(vaultVersionSchema).min(1),
  into: vaultVersionSchema,
  deviceId: z.string().uuid(),
});
export type VaultMergeRecord = z.infer<typeof vaultMergeRecordSchema>;

/**
 * The merge-log bound is a **write-side trim, never a parse-time rejection**
 * (design r3, closing mobile finding A1.2). A writer keeps at most this many
 * records; a reader accepts any length. The distinction is load-bearing: a
 * parse-time `max` turns a merely-oversized diagnostic log into an unreadable
 * document, and in the v2 layout an unreadable `common` doc takes
 * `clientSecurity` and `mirrorProvenance` down with it — the whole vault, lost
 * to a bookkeeping array. Writers trim; parsers tolerate.
 */
export const VAULT_MERGE_LOG_LIMIT = 20;

/** Keep the newest {@link VAULT_MERGE_LOG_LIMIT} records — the write-side trim. */
export function trimVaultMergeLog(mergeLog: readonly VaultMergeRecord[]): VaultMergeRecord[] {
  return mergeLog.length <= VAULT_MERGE_LOG_LIMIT
    ? [...mergeLog]
    : mergeLog.slice(mergeLog.length - VAULT_MERGE_LOG_LIMIT);
}

/**
 * Strict v1 restore payload; newer versions are rejected without coercion.
 *
 * `mirrorProvenance` is ADDITIVE within v1 and `.default([])`: a document written
 * before §7.1 has no such key, and the absent key means exactly what `[]` means —
 * this account kept no severed MIRRORCHAIN fork. Defaulting keeps older supported
 * documents deterministic instead of bumping a schema version that is already
 * encrypted on users' media (the same reasoning as `cashMovement.dedupHash`).
 */
export const vaultStrictDocumentV1Schema = z
  .object({
    schemaVersion: z.literal(VAULT_DOCUMENT_V1_VERSION),
    entities: z.array(vaultStrictEntitySchema),
    mergeLog: z.array(vaultMergeRecordSchema).default([]),
    mirrorProvenance: z.array(vaultMirrorProvenanceSchema).default([]),
  })
  .strict();
export type VaultStrictDocumentV1 = z.infer<typeof vaultStrictDocumentV1Schema>;

/**
 * The original decrypted vault document (`§2`). A per-kind map of sync-tracked
 * entities plus a bounded merge log. It remains readable so a client can
 * provision the v2 retirement proof during its unlocked initialization.
 */
export const vaultDocumentV1Schema = z.object({
  schemaVersion: z.literal(VAULT_DOCUMENT_V1_VERSION),
  entities: z.record(vaultEntityKindSchema, z.array(vaultEntitySchema)),
  mergeLog: z.array(vaultMergeRecordSchema).default([]),
  /**
   * §7.1 severed-fork identity map. OPTIONAL rather than defaulted, unlike its
   * strict-document counterpart: a document written before §7.1 has no such key,
   * and defaulting one in would make re-encrypting it emit `"mirrorProvenance":[]`
   * — changing the plaintext, and therefore the published envelope bytes, of every
   * fork-free vault in existence. Absent and empty mean the same thing (no
   * severed fork), so the carriage helpers normalize with `?? []`.
   */
  mirrorProvenance: z.array(vaultMirrorProvenanceSchema).optional(),
});
export type VaultDocumentV1 = z.infer<typeof vaultDocumentV1Schema>;

/**
 * Version 2 binds the client-held retirement private key to a payload/header
 * version that v1 clients reject before parsing. `clientSecurity` is required:
 * a v2 writer can never silently downgrade a verifier-backed vault to a
 * headerless/keyless document.
 */
export const vaultDocumentV2Schema = z.object({
  schemaVersion: z.literal(VAULT_DOCUMENT_VERSION),
  entities: z.record(vaultEntityKindSchema, z.array(vaultEntitySchema)),
  mergeLog: z.array(vaultMergeRecordSchema).default([]),
  /** §7.1 severed-fork identity map; optional exactly as in v1 above. */
  mirrorProvenance: z.array(vaultMirrorProvenanceSchema).optional(),
  /**
   * Browser-only proof material. The unlocked client provisions it before
   * activating or retiring server media. It is deliberately absent from the
   * rehydration DTO above.
   */
  clientSecurity: vaultClientSecuritySchema,
});
export type VaultDocumentV2 = z.infer<typeof vaultDocumentV2Schema>;

/** Every payload version this client can read without destructive coercion. */
export const vaultDocumentSchema = z.discriminatedUnion('schemaVersion', [
  vaultDocumentV1Schema,
  vaultDocumentV2Schema,
]);
export type VaultDocument = z.infer<typeof vaultDocumentSchema>;

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
    /**
     * The `§3` destruction exit ("lost key ⇒ lost data … the only server-side
     * recovery is destruction"): the caller cannot decrypt its vault and is
     * therefore restoring NOTHING. `document.entities` MUST then be empty — the
     * flag is explicit rather than inferred from an empty graph so that a
     * client bug which loses its rows still fails the ordinary restore
     * invariants instead of silently wiping the account. Retained custom-asset
     * identity claims are all retired, since no document can account for them.
     */
    discard: z.literal(true).optional(),
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

// ── Public enable / disable transition DTOs ──────────────────────────────────

/**
 * `GET /account/paranoid/normal-revision` — an opaque digest over every
 * `vault`-classified table the enable purge destroys, scoped to the caller.
 * It carries no portfolio content (a one-way hash of row bytes), exists only
 * to be handed back to enable, and changes on ANY normal-account write.
 */
const normalDataRevisionSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

export const paranoidNormalRevisionResponseSchema = z
  .object({ revision: normalDataRevisionSchema })
  .strict();
export type ParanoidNormalRevisionResponse = z.infer<typeof paranoidNormalRevisionResponseSchema>;

/**
 * Client proof that the selected Drive medium completed the §5 write/read
 * round-trip immediately before enable. The server deliberately persists only
 * the attested version — never a Drive id, token, path, document hash, or
 * decrypted metadata.
 */
export const paranoidDriveReadinessAttestationSchema = z
  .object({
    verifiedRoundTrip: z.literal(true),
    vaultVersion: vaultVersionSchema,
  })
  .strict();
export type ParanoidDriveReadinessAttestation = z.infer<
  typeof paranoidDriveReadinessAttestationSchema
>;

/**
 * `POST /account/paranoid/enable`. Evidence for every selected medium is tied to
 * one exact supported vault version: the server medium is checked against the
 * blind blob row, while Drive is accepted only with this strict client
 * attestation.
 */
export const paranoidEnableRequestSchema = z
  .object({
    mediaSet: vaultMediaSetSchema,
    vaultVersion: vaultVersionSchema,
    driveAttestation: paranoidDriveReadinessAttestationSchema.nullable().default(null),
    /**
     * The compare-and-swap token that binds the client's CAPTURE to this
     * destructive commit ({@link paranoidNormalRevisionResponseSchema}). It is
     * read before the migration's first row read and re-derived server-side
     * under the account lock immediately before the purge: any normal-account
     * write in between — another session, or a due standing-order worker —
     * changes it, and the enable is refused instead of hard-deleting rows the
     * encrypted document never captured. Required, never optional: an omitted
     * token would simply skip the guard on the one transition that cannot be
     * undone.
     */
    normalDataRevision: normalDataRevisionSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const driveSelected = value.mediaSet.includes('drive');
    if (driveSelected && value.driveAttestation === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['driveAttestation'],
        message: 'the Drive medium requires a verified round-trip attestation',
      });
    }
    if (!driveSelected && value.driveAttestation !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['driveAttestation'],
        message: 'a Drive attestation requires the Drive medium',
      });
    }
    if (
      value.driveAttestation !== null &&
      value.driveAttestation.vaultVersion !== value.vaultVersion
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['driveAttestation', 'vaultVersion'],
        message: 'the Drive attestation must match vaultVersion',
      });
    }
  });
export type ParanoidEnableRequest = z.infer<typeof paranoidEnableRequestSchema>;

/** Auditable, portfolio-free enable receipt. */
export const paranoidEnableResponseSchema = z
  .object({
    mode: z.literal('paranoid'),
    mediaSet: vaultMediaSetSchema,
    vaultVersion: vaultVersionSchema,
    completedAt: z.string().datetime(),
    idempotent: z.boolean(),
  })
  .strict();
export type ParanoidEnableResponse = z.infer<typeof paranoidEnableResponseSchema>;

/**
 * `POST /account/paranoid/disable`. `rehydrationId` is the durable idempotency
 * key from PD3a; the literal confirmation prevents an unlocked document alone
 * from authorizing the destructive mode transition.
 *
 * The ordinary disable RESTORES the vault's rows, so `confirm` plus the
 * decrypted document is the whole gate. `discard: true` does the opposite — it
 * destroys a vault its owner can no longer decrypt — so it carries the SAME two
 * gates as `DELETE /account` ({@link deleteAccountRequestSchema}): the typed
 * `confirmUsername`, and a server-verified credential (current password, or a
 * fresh TOTP `code` / unused `recoveryCode` on a 2FA account). Both are
 * verified server-side; a client-only confirmation would be skipped by anyone
 * POSTing the endpoint directly from a live session.
 */
export const paranoidDisableRequestSchema = paranoidDisableRehydrationRequestSchema
  .extend({
    confirm: z.literal(true),
    /** Required for `discard`: must match the account's username (case-insensitive). */
    confirmUsername: z.string().trim().min(1).max(40).optional(),
    password: z.string().min(1).max(MAX_PASSWORD_LENGTH).optional(),
    /** A fresh 6-digit authenticator (TOTP) code — 2FA-enrolled accounts only. */
    code: z.string().trim().min(4).max(16).optional(),
    /** An unused recovery code — consumed on success AND on a failed match. */
    recoveryCode: z.string().trim().min(4).max(64).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.discard !== true) return;
    if (value.confirmUsername === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['confirmUsername'],
        message: 'Discarding the vault requires the typed username confirmation.',
      });
    }
    if (
      value.password === undefined &&
      value.code === undefined &&
      value.recoveryCode === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['password'],
        message: 'Re-authentication is required: send your password or a two-factor code.',
      });
    }
  });
export type ParanoidDisableRequest = z.infer<typeof paranoidDisableRequestSchema>;

/**
 * `GET /account/paranoid/fork-provenance`. The capture read the enable wizard
 * runs while `mirror_rows` still exists (`docs/paranoid-design.md` §7.1): the
 * caller's own severed-fork identity map, and nothing else. Ended memberships
 * only — an ACTIVE membership blocks enable anyway, and exposing it here would
 * leak live chain data. No co-member identity, chain name, or member list.
 */
export const paranoidForkProvenanceResponseSchema = z
  .object({ provenance: z.array(vaultMirrorProvenanceSchema) })
  .strict();
export type ParanoidForkProvenanceResponse = z.infer<typeof paranoidForkProvenanceResponseSchema>;

/** Public disable receipt; still contains no restored-row counts or cleartext metadata. */
export const paranoidDisableResponseSchema = paranoidDisableRehydrationResultSchema
  .extend({ mode: z.literal('normal') })
  .strict();
export type ParanoidDisableResponse = z.infer<typeof paranoidDisableResponseSchema>;

/** Stable typed transition errors surfaced in the standard API error envelope. */
export const PARANOID_TRANSITION_ERROR_CODES = {
  notEnabled: 'PARANOID_NOT_ENABLED',
  mediaNotReady: 'PARANOID_MEDIA_NOT_READY',
  mirrorchainActive: 'PARANOID_MIRRORCHAIN_ACTIVE',
  importInFlight: 'PARANOID_IMPORT_IN_FLIGHT',
  exportInFlight: 'PARANOID_EXPORT_IN_FLIGHT',
  transitionConflict: 'PARANOID_TRANSITION_CONFLICT',
  /**
   * The account was written to between the client's capture and this commit, so
   * the encrypted copy is not a complete snapshot any more. Nothing was
   * deleted; the wizard re-captures and retries.
   */
  normalDataChanged: 'PARANOID_NORMAL_DATA_CHANGED',
  invalidRehydration: 'PARANOID_REHYDRATION_INVALID',
} as const;
export type ParanoidTransitionErrorCode =
  (typeof PARANOID_TRANSITION_ERROR_CODES)[keyof typeof PARANOID_TRANSITION_ERROR_CODES];

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
  mediaStateConflict: 'VAULT_MEDIA_STATE_CONFLICT',
  mediaVerificationFailed: 'VAULT_MEDIA_VERIFICATION_FAILED',
  serverMediumInactive: 'VAULT_SERVER_MEDIUM_INACTIVE',
  retirementConflict: 'VAULT_RETIRED_SERVER_CONFLICT',
  retirementProofRequired: 'VAULT_RETIRED_SERVER_PROOF_REQUIRED',
  retirementProofInvalid: 'VAULT_RETIRED_SERVER_PROOF_INVALID',
  retirementRetention: 'VAULT_RETIRED_SERVER_RETENTION',
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
/** Client-held retirement-proof public key supplied only when first storing server bytes. */
export const VAULT_RETIREMENT_PROOF_PUBLIC_KEY_HEADER =
  'X-BetterTrack-Vault-Retirement-Proof-Public-Key';
/** Safe metadata accompanying an inactive candidate raw read. */
export const VAULT_SERVER_CANDIDATE_ID_HEADER = 'X-BetterTrack-Vault-Candidate-Id';
export const VAULT_SERVER_CANDIDATE_EXPIRES_AT_HEADER = 'X-BetterTrack-Vault-Candidate-Expires-At';
/** Opaque HMAC receipt proving this browser session read the exact candidate. */
export const VAULT_SERVER_CANDIDATE_READBACK_HEADER = 'X-BetterTrack-Vault-Candidate-Readback';

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
