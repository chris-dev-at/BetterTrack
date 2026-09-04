import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

import { z } from 'zod';

import { USAGE_ANALYTICS_WINDOW_DAYS } from '@bettertrack/contracts';

import {
  createSecretBoxKeyring,
  type SecretBoxKey,
  type SecretBoxKeyring,
} from '../services/crypto/secretBox';
import { isKnownSecretPlaceholder } from '../services/password/knownPlaceholders';
import type { ProgressiveSchedule } from '../services/security/progressiveLimiter';
import { API_SERVICE_NAME, API_VERSION } from '../version';

/**
 * Environment schema (PROJECTPLAN.md §11). Validated once at boot so a
 * misconfigured deployment fails fast and loudly instead of at first request.
 */
// An optional URL that also tolerates an empty string as "unset". `.optional()`
// alone only accepts `undefined`, but docker-compose materializes an unset
// `${VAR:-}` into an empty string, which would fall straight into `.url()` and
// crash config validation at boot (#632). Coerce blank ⇒ undefined first so the
// var is robust regardless of how it arrives.
const optionalUrl = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().url().optional(),
);
const optionalNonEmpty = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().optional(),
);
const optionalPositiveInt = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.coerce.number().int().positive().optional(),
);
const retentionDays = (defaultDays: number) =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.coerce.number().int().nonnegative().default(defaultDays),
  );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  // 64 random bytes recommended; comma-separated to support key rotation.
  SESSION_SECRET: z.string().min(16, 'SESSION_SECRET must be at least 16 characters'),

  // ── Deployment topology (PROJECTPLAN.md §4.6, §10, §11) ────────────────────
  // One global scheme that drives every public origin. `subdomains` (default)
  // fronts each service on its own subdomain of BT_DOMAIN with TLS at the proxy;
  // `ports` puts each service on its own port of a single host. The five origins
  // (api/web/admin + the static product/mobile landing pages) are DERIVED from
  // these (see deriveOrigins); CORS, cookies and link generation consume the
  // derived values so no origin is ever hand-maintained. Explicit BT_*_ORIGIN
  // overrides win over derivation. NOTE: the product landing lives at the APEX
  // (`{domain}`, no subdomain) in subdomains mode; `mobile.` is its own subdomain.
  BT_MODE: z.enum(['subdomains', 'ports']).default('subdomains'),
  BT_DOMAIN: z.string().min(1).default('localhost'),
  // Front-proxy TLS. Defaults per mode (subdomains → https, ports → http) when
  // unset; an explicit value forces the scheme of every derived origin.
  BT_TLS: z.string().optional(),
  BT_SUB_API: z.string().min(1).default('api'),
  BT_SUB_WEB: z.string().min(1).default('web'),
  BT_SUB_ADMIN: z.string().min(1).default('admin'),
  // Product landing has no subdomain label — it is served from BT_DOMAIN's apex.
  BT_SUB_MOBILE: z.string().min(1).default('mobile'),
  BT_PORT_API: z.coerce.number().int().positive().default(3000),
  BT_PORT_WEB: z.coerce.number().int().positive().default(8080),
  BT_PORT_ADMIN: z.coerce.number().int().positive().default(8081),
  BT_PORT_PRODUCT: z.coerce.number().int().positive().default(8082),
  BT_PORT_MOBILE: z.coerce.number().int().positive().default(8083),
  // Explicit origin overrides (win over derivation). Useful for split hosting or
  // a legacy single-origin setup. APP_ORIGIN is a legacy alias for BT_WEB_ORIGIN.
  BT_API_ORIGIN: optionalUrl,
  BT_WEB_ORIGIN: optionalUrl,
  BT_ADMIN_ORIGIN: optionalUrl,
  BT_PRODUCT_ORIGIN: optionalUrl,
  BT_MOBILE_ORIGIN: optionalUrl,
  APP_ORIGIN: optionalUrl,

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: optionalPositiveInt,
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().optional(),
  // Admin session policy (§13.5 V5-P13c): the ABSOLUTE lifetime of an admin
  // session, clamped to the plan's 6–24 h window (default 12 h). This is the
  // env fallback only — an admin can override it at runtime (audit-logged),
  // which takes effect on the next request with no redeploy.
  ADMIN_SESSION_LIFETIME_HOURS: z.coerce.number().int().min(6).max(24).default(12),
  // Per-provider request budget (§5.3): bounded concurrency + minimum spacing
  // between upstream call starts. Defaults match PROJECTPLAN §5.2/§5.3.
  // NOTE: the budget is per *process* — the API and the BullMQ worker each run
  // their own queue with an independent spacing clock, so the effective
  // upstream budget is N × these values for N running processes (§5.3 only
  // mandates the Redis lock for cross-process coalescing). Set lower values in
  // each service's env if a tighter combined budget is needed.
  PROVIDER_MAX_CONCURRENCY: z.coerce.number().int().positive().default(4),
  PROVIDER_MIN_SPACING_MS: z.coerce.number().int().nonnegative().default(250),
  // Provider failover chain (§13.5 V5-P1c): opt into the keyless Stooq secondary
  // with health-based failover + recovery. Default OFF so the shipped behaviour
  // is byte-identical to a single-provider (Yahoo-only) setup; set to enable —
  // no keys or accounts required. Which-provider-served-what shows in admin health.
  MARKET_FAILOVER_ENABLED: z.string().optional(),
  // Interactive catalog-enrichment budget (§6.2, #1709). `GET /search` answers
  // from Postgres, but a thin result set ALSO starts a background provider
  // search that upserts into the SHARED global `assets` table and enqueues a
  // history backfill per new row. Coalescing is per normalised query, so
  // *distinct* queries never coalesce and the only ceiling used to be the
  // request limiter (`rateLimits.search`, 300/min): 300 distinct junk queries a
  // minute meant 300 provider fan-outs and 300 rows of unbounded global-catalog
  // growth from ONE account.
  //
  // The import path already made this exact decision — `IMPORT_ENRICHMENT_QUERY_BUDGET`
  // = 16 admissions per import (`services/imports/importService.ts`) — so the
  // interactive path's lack of a budget was an asymmetry, not a choice. These
  // two knobs are the interactive half of that one decision: a per-user window
  // admitting BT_SEARCH_ENRICHMENT_BUDGET *distinct* enrichment queries; a
  // re-poll of an already-admitted query is free within that window, so the
  // client's "Searching providers…" refetch loop never spends the budget twice
  // (a poll that crosses the window boundary opens a new accounting period and
  // is charged once more — the fixed window's normal behaviour).
  //
  // 30 / 60 s models the client honestly: `useAssetSearch` fires one request per
  // debounced PREFIX (min 1 char), so ONE slowly-typed word can produce ~5-6
  // distinct misses. 30 covers ~5 such searches a minute — well past normal use
  // — while cutting the worst-case fan-out 10× below the 300/min request
  // ceiling. Over budget the response degrades to `enriching: false`: the
  // catalog read still answers in full (local-first, §6.2), only the background
  // provider work stops.
  BT_SEARCH_ENRICHMENT_BUDGET: z.coerce.number().int().positive().default(30),
  BT_SEARCH_ENRICHMENT_WINDOW_SEC: z.coerce.number().int().positive().default(60),
  // Short-window burst dimension of the general limiter (§10, owner report #202):
  // the 15-min steady-state allowance is generous enough that a rapid page-reload
  // flood never reaches it, so a second, short window catches the flood without
  // touching the steady-state bar. Over-limit feeds the SAME escalation ladder as
  // the steady-state limiter.
  //
  // 30 s / 600 (owner directive 2026-09-02). The window WIDENED and the allowance
  // grew 10×: at 10 s / 60 the app's own cold load (10 + 2N requests, ~50 for a
  // widget board) spent most of the budget in two seconds, so a second tab, a
  // reconnect refetch or an asset search on top of it tripped a 429 during
  // ordinary use — the "every other day" the owner reported. Widening the window
  // at a higher rate raises SPIKE tolerance without raising the sustained rate as
  // far, which is the shape of the real traffic: bursty on navigation, ~4 req/min
  // idle. It still trips a genuine flood — 12 reloads inside 30 s.
  RATE_LIMIT_BURST_WINDOW_SEC: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_BURST_LIMIT: z.coerce.number().int().positive().default(600),
  /**
   * Per-IP login attempts per minute. The DEFAULT IS THE PRODUCTION CONTROL and
   * is not to be raised there — 25/min per IP is what blunts single-IP
   * credential stuffing (§6.1).
   *
   * It is settable only so the e2e suite can stop poisoning itself: one shard
   * funnels 40-60 logins a minute from a single address, trips the limiter, and
   * the escalating cooldown then fails every later spec for a reason that has
   * nothing to do with the product. Raised in playwright.config.ts against a
   * throwaway database, nowhere else (owner decision, 2026-07-30).
   */
  RATE_LIMIT_LOGIN_IP_WINDOW_SEC: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_LOGIN_IP_LIMIT: z.coerce.number().int().positive().default(25),

  // ── Realtime gateway (§4.5, §13.3 V3-P7a) ──────────────────────────────────
  // Feature flag for the Socket.IO gateway at /ws. Default on; off means the
  // socket server is never attached and the API behaves exactly as before —
  // the SPA's poll/refetch fallback carries every feature (flagged rollout).
  REALTIME_ENABLED: z.string().optional(),

  // ── Push channels (#368 Notifications v2) ───────────────────────────────────
  // Phone push (FCM HTTP v1): absolute in-container path to the mounted Firebase
  // service-account JSON (SERVER SECRET — mounted, never in a repo). Unset var
  // or missing/unreadable file ⇒ the push channel is cleanly DISABLED with one
  // warn log at boot; api/worker must never crash over it (#421: the key may
  // land on live before or after this deploys, in any order).
  BT_FCM_SERVICE_ACCOUNT_FILE: z.string().optional(),
  // Browser push (web-push/VAPID): both keys set ⇒ channel on. The subject is
  // the VAPID contact (mailto:/https:); derived from BT_DOMAIN when unset.
  BT_VAPID_PUBLIC_KEY: z.string().optional(),
  BT_VAPID_PRIVATE_KEY: z.string().optional(),
  BT_VAPID_SUBJECT: z.string().optional(),
  // ── Error tracking (Sentry, §13.4 V4-P5a) ──────────────────────────────────
  // Env-gated: with BT_SENTRY_DSN unset the SDK never initializes and boot is
  // byte-identical. The two sample rates are 0..1 fractions (errors default to
  // full capture, tracing off) so an operator can dial cost without a redeploy.
  BT_SENTRY_DSN: z.string().optional(),
  BT_SENTRY_ERROR_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(1),
  BT_SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
  // Optional environment tag on every event (e.g. `production`, `staging`).
  // Falls back to NODE_ENV when unset.
  BT_SENTRY_ENVIRONMENT: z.string().optional(),

  // ── Stored-record encryption (#879) ────────────────────────────────────────
  // TOTP secrets + Discord webhook URLs use one long-lived keyring that is
  // independent of cookie signing. The active id is public envelope metadata;
  // key material is a server secret. Previous entries are ordered
  // `id=material,id=material` and exist only while records are being re-encrypted.
  // Production requires both active fields; development/test use a fixed,
  // session-independent local fallback so rotating SESSION_SECRET can never
  // rotate stored-record encryption accidentally.
  BT_DATA_ENCRYPTION_KEY_ID: optionalNonEmpty,
  BT_DATA_ENCRYPTION_KEY: optionalNonEmpty,
  BT_DATA_ENCRYPTION_DECRYPT_KEYS: optionalNonEmpty,

  // ── Two-factor auth (§6.1, §13.2 V2-P5) ────────────────────────────────────
  // Issuer label baked into the `otpauth://` URI so the code shows up as
  // "BetterTrack (user@…)" in an authenticator app. TOTP_ENCRYPTION_KEY is the
  // deprecated pre-#879 key input: it remains a legacy-v1 decrypt candidate so
  // existing records survive the move to BT_DATA_ENCRYPTION_*.
  TOTP_ISSUER: z.string().min(1).default('BetterTrack'),
  TOTP_ENCRYPTION_KEY: z.string().min(1).optional(),

  // ── Google sign-in (§13.4 V4-P4b) ──────────────────────────────────────────
  // OAuth 2.0 authorization-code client for "Continue with Google". BOTH set ⇒
  // the feature is on; either unset ⇒ it is fully OFF (the `/auth/google/*`
  // routes 404 and no button renders on any auth surface). Owner-provided and
  // env-gated — it never blocks launch (§13.4 preamble).
  BT_GOOGLE_CLIENT_ID: z.string().optional(),
  BT_GOOGLE_CLIENT_SECRET: z.string().optional(),
  // Test-only endpoint overrides (§13.4 V4-P11, #520): point the three Google
  // OAuth URLs at the e2e fake IdP so the redirect chain + jose verification run
  // network-free against a per-run signing key. Unset in every real deployment —
  // when absent the flow uses the exact production Google constants. Never set
  // these in production. Validated as URLs so a typo fails fast at boot.
  BT_GOOGLE_AUTHORIZE_ENDPOINT: z.string().url().optional(),
  BT_GOOGLE_TOKEN_ENDPOINT: z.string().url().optional(),
  BT_GOOGLE_JWKS_URI: z.string().url().optional(),

  // ── Account data export (§13.4 V4-P6a, #494) ───────────────────────────────
  // Directory the export job writes the assembled zips into (and the cleanup job
  // prunes). Must be writable by BOTH the api and worker processes and survive a
  // restart (a mounted volume in production). Unset ⇒ a per-OS temp subdirectory,
  // so a stock deploy works without configuration; set an explicit durable path
  // in production so a mid-download restart never loses a ready file.
  BT_EXPORT_DIR: z.string().optional(),

  // ── Backup readiness surface (#1406 W1) ────────────────────────────────────
  // Path to the backup scheduler's machine-readable status file, mounted
  // READ-ONLY into the api container. Unset ⇒ the admin Overview's readiness
  // tile reads "not configured"; the API never writes here and never runs a
  // backup, so the worst case of a wrong path is a blank tile.
  BT_BACKUP_STATUS_FILE: optionalNonEmpty,

  // ── Data retention (§13.5 V5-P14, PL-01) ─────────────────────────────────
  // Owner-adjustable retention windows for identifying operational trails.
  // Unset (or blank) uses the conservative defaults below; explicit `0` keeps
  // that table forever and disables its branch of the scheduled purge.
  BT_AUDIT_RETENTION_DAYS: retentionDays(400),
  BT_EMAIL_LOG_RETENTION_DAYS: retentionDays(180),
  // Captured problems age out on `last_seen_at`: a quarter without a single
  // recurrence is the point at which a row is history, not an operational
  // signal — and the admin Problems page is only useful while it is bounded.
  BT_PROBLEM_RETENTION_DAYS: retentionDays(90),
  // Raw usage events are a per-user viewing history. DAU/WAU/MAU and top assets
  // are read from them over the last USAGE_ANALYTICS_WINDOW_DAYS days, so the
  // retention window may never be SHORTER than that reporting window — a shorter
  // one silently collapses MAU onto WAU onto DAU while the page still labels
  // them 30-day figures. The refine below rejects that at boot (#1680). The
  // remaining analytics reads are already retention-proof: the feature counters
  // and activity series come from the `usage_daily` rollup and the funnel's
  // activated stage from the durable `usage_activations` marker, neither of
  // which the sweep touches.
  BT_USAGE_EVENT_RETENTION_DAYS: retentionDays(180).superRefine((days, ctx) => {
    // `0` is the documented "retain forever" value shared by every retention
    // var (it disables that branch of the purge entirely), so it is the SAFEST
    // possible setting for the analytics window, not a violation of it. Let it
    // through explicitly rather than by accident.
    if (days === 0) return;
    if (days < USAGE_ANALYTICS_WINDOW_DAYS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `BT_USAGE_EVENT_RETENTION_DAYS=${days} is shorter than the ${USAGE_ANALYTICS_WINDOW_DAYS}-day ` +
          `admin analytics window: DAU/WAU/MAU and top assets read raw usage events, so they would ` +
          `report a traffic collapse that is only the retention setting. Use ${USAGE_ANALYTICS_WINDOW_DAYS} ` +
          `or more, or 0 to retain forever.`,
      });
    }
  }),

  // ── Telegram notification channel (§13.4 V4-P10) ───────────────────────────
  // Owner-provided bot token that lets the API deliver notifications through
  // Telegram. Unset ⇒ the channel is entirely INVISIBLE: no Telegram column in
  // the settings matrix, `/settings/telegram/*` responds `available: false` (or
  // 404 on the writes), and nothing crashes at boot (per §13.4 preamble — owner
  // items never block launch). Never logged (secret). Discord is per-user by
  // webhook URL, so no server env is required.
  BT_TELEGRAM_BOT_TOKEN: z.string().optional(),
  // ── Telegram + Discord kill-switch (§13.5 V5-P0b, owner directive) ─────────
  // Global on/off for BOTH V4-P10 additive channels. Default OFF: the matrix
  // columns hide everywhere, `/settings/telegram/*` + `/settings/discord/*`
  // reply 404, the dispatcher skips deliveries even for a user with a linked
  // row, and the schema + existing rows remain intact — flipping this env back
  // ON restores every behavior unchanged. Neither channel is deleted; the
  // owner explicitly asked for "deactivate, not delete".
  BT_TELEGRAM_DISCORD_ENABLED: z.string().optional(),

  // ── Prometheus metrics endpoint (§13.5 V5-P2 arc (a), §16 2026-07-17) ───────
  // A dedicated scrape listener, bound localhost/LAN-only and kept OFF the
  // public `/api/v1` surface. Enabled by default (zero owner setup); the bind
  // host defaults to loopback and can be widened to a LAN interface, and the
  // port defaults to 9464 (the OpenMetrics-registered exporter port).
  BT_METRICS_ENABLED: z.string().optional(),
  BT_METRICS_HOST: z.string().min(1).default('127.0.0.1'),
  BT_METRICS_PORT: z.coerce.number().int().positive().default(9464),

  // ── Observability external access (§13.5 V5-P2 arc (a), owner 2026-07-19) ───
  // The owner asked to reach Grafana from OUTSIDE the LAN too — but only through
  // an authenticated path, never a raw-public endpoint. These drive the admin-
  // proxied Grafana reverse proxy (`/api/v1/admin/monitoring/grafana`) and the
  // admin Diagnostics status probe. Prometheus is NEVER proxied. Defaults are
  // SAFE: external access is off and the surfaces stay localhost/LAN-only.
  //
  // The api reaches Grafana/Prometheus over the internal docker network by
  // service name for the reachability probe (both) and the proxy upstream (Grafana).
  BT_GRAFANA_INTERNAL_URL: z.string().url().default('http://grafana:3000'),
  BT_PROMETHEUS_INTERNAL_URL: z.string().url().default('http://prometheus:9090'),
  // Deploy-level external-access toggle. OFF (default) ⇒ the proxy refuses and
  // the surfaces stay localhost/LAN-only exactly as before this arc.
  BT_OBS_EXTERNAL_ACCESS: z.string().optional(),
  // The Grafana admin password. The api reads it ONLY to gate external exposure
  // (never retained on the resolved config, never logged, never sent to a
  // client): exposure is refused while it is unset or left at a known
  // placeholder, so the app never puts `admin/admin` on a public door. Unset is
  // a supported steady state — the compose bootstrap then generates Grafana's
  // local credential itself (docs/monitoring.md) and only external access is
  // withheld.
  BT_GRAFANA_ADMIN_PASSWORD: z.string().optional(),
  // Optional explicit public Grafana URL for the auth-gated-subdomain path
  // (e.g. https://grafana.bettertrack.at). When set the Diagnostics panel embeds
  // it; when unset (the admin-proxy path) the client embeds the proxy path.
  BT_GRAFANA_PUBLIC_URL: optionalUrl,

  // ── Market intelligence (§13.5 V5-P5) ──────────────────────────────────────
  // Global kill-switch for the dividend/earnings/news/splits intel surfaces.
  // Default ON (Yahoo is keyless, so a stock deploy has the data): OFF ⇒ every
  // capability reports unavailable and the per-asset intel endpoints return the
  // "unconfigured" shape (`available: false`, empty), so the P5 UI stays
  // invisible. Flips without touching provider wiring.
  MARKET_INTEL_ENABLED: z.string().optional(),

  // ── Local AI provider (§13.5 V5-P12, §16 2026-07-22 — LOCAL OLLAMA ONLY) ────
  // The owner's LAN Ollama endpoint + default model. Both are OPTIONAL env
  // DEFAULTS only — an admin overrides them at runtime (stored in app_settings,
  // no redeploy). Unset ⇒ the AI layer is simply DISABLED: the capability
  // endpoint reports `available: false` and nothing AI-related renders. NEVER a
  // boot failure (owner-provided item, §13.4 preamble). No cloud provider and no
  // API token exists anywhere — the endpoint is a plain URL, never a secret.
  BT_OLLAMA_ENDPOINT: optionalUrl,
  BT_OLLAMA_MODEL: z.string().optional(),
  // Per-user per-UTC-day completion budget (admin-configurable at runtime; this
  // is only the fallback default). Kept generous but finite.
  BT_AI_DAILY_CAP: z.coerce.number().int().min(1).max(100_000).default(20),
  // MIRRORCHAIN active-member cap per chain (§13.5 V5-P7, design §4 — bounded
  // fan-out). Env-tunable; defaults to the contract's MIRROR_MAX_MEMBERS (16).
  MIRROR_MAX_MEMBERS: z.coerce.number().int().min(2).max(256).default(16),
  // Paranoid vault (§13.5 V5-P13 arc b, design §2/§4) — ops knobs, not product
  // surface. Ciphertext (envelope) size cap: 16 MiB default (personal-finance
  // scale keeps real vaults far below it). Bounded ciphertext history window:
  // last N versions / M days.
  BT_VAULT_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(16 * 1024 * 1024),
  // Per-portfolio vaults (docs/paranoid-design.md §3, E0 #1410): per-doc-kind
  // envelope size caps for the per-vault doc set (header / common / one doc per
  // member portfolio). Same ops-knob family as BT_VAULT_MAX_BYTES, which keeps
  // capping the v1 account-singleton blob until E9 retires it. The per-doc
  // history reuses the BT_VAULT_HISTORY_* window below (same semantics, one
  // knob family — deliberately no second pair of history knobs).
  BT_VAULT_MAX_BYTES_HEADER: z.coerce
    .number()
    .int()
    .min(1024)
    .default(1 * 1024 * 1024),
  BT_VAULT_MAX_BYTES_COMMON: z.coerce
    .number()
    .int()
    .min(1024)
    .default(4 * 1024 * 1024),
  BT_VAULT_MAX_BYTES_PORTFOLIO: z.coerce
    .number()
    .int()
    .min(1024)
    .default(8 * 1024 * 1024),
  BT_VAULT_HISTORY_MAX_VERSIONS: z.coerce.number().int().min(1).max(1000).default(10),
  BT_VAULT_HISTORY_MAX_AGE_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  // Dedicated modest write limiter for vault PUTs (like every other write
  // family). Per user; a generous steady-state so multi-device sync never trips.
  BT_VAULT_RATE_WINDOW_SEC: z.coerce.number().int().positive().default(60),
  BT_VAULT_RATE_LIMIT: z.coerce.number().int().positive().default(60),
  // Vault reads have a separate, larger budget so normal sync polling cannot
  // exhaust (or inherit a cooldown from) the mutation budget. The window stays
  // shared with the write family; only the allowance and Redis namespace split.
  BT_VAULT_READ_RATE_LIMIT: z.coerce.number().int().positive().default(600),
});

export type EnvSchemaKey = keyof z.infer<typeof envSchema>;

/**
 * Machine-readable production environment contract.
 *
 * New schema keys enter the supported set automatically, which makes the
 * deployment-contract test fail until Compose and the production example carry
 * them. The small exclusion map is deliberately explicit: each entry is either
 * a test-only input or a retired compatibility input that the shipped
 * production topology must not expose.
 */
export const ENV_SCHEMA_KEYS = Object.freeze(Object.keys(envSchema.shape) as EnvSchemaKey[]);

export const INTENTIONALLY_NOT_PROPAGATED_ENV_KEYS = Object.freeze({
  APP_ORIGIN:
    'Legacy alias superseded by BT_WEB_ORIGIN; the production topology exposes one canonical web-origin override.',
  TOTP_ENCRYPTION_KEY:
    'Deprecated pre-keyring compatibility input; production uses the required BT_DATA_ENCRYPTION_* keyring.',
  BT_GOOGLE_AUTHORIZE_ENDPOINT:
    'End-to-end-test fake identity-provider override; production uses the built-in Google endpoint.',
  BT_GOOGLE_TOKEN_ENDPOINT:
    'End-to-end-test fake identity-provider override; production uses the built-in Google endpoint.',
  BT_GOOGLE_JWKS_URI:
    'End-to-end-test fake identity-provider override; production uses the built-in Google endpoint.',
  BT_SENTRY_DSN:
    'External Sentry is retired for the shipped stack; the zero-setup admin Problems system is the production error surface.',
  BT_SENTRY_ERROR_SAMPLE_RATE:
    'Only configures the retired external Sentry integration and has no shipped production consumer.',
  BT_SENTRY_TRACES_SAMPLE_RATE:
    'Only configures the retired external Sentry integration and has no shipped production consumer.',
  BT_SENTRY_ENVIRONMENT:
    'Only configures the retired external Sentry integration and has no shipped production consumer.',
} satisfies Partial<Record<EnvSchemaKey, string>>);

const intentionallyNotPropagated = new Set<EnvSchemaKey>(
  Object.keys(INTENTIONALLY_NOT_PROPAGATED_ENV_KEYS) as EnvSchemaKey[],
);

export const PRODUCTION_SUPPORTED_ENV_KEYS = Object.freeze(
  ENV_SCHEMA_KEYS.filter((key) => !intentionallyNotPropagated.has(key)),
);

/**
 * Supported keys whose in-container values are deployment invariants rather
 * than host knobs. They still live in the one API/worker environment anchor and
 * are documented in the production example.
 */
export const COMPOSE_MANAGED_ENV_KEYS = Object.freeze({
  NODE_ENV: 'The production stack always boots the API image in production mode.',
  PORT: 'The internal API port is coupled to the proxy upstream and healthcheck.',
  BT_EXPORT_DIR:
    'The durable export path is coupled to the shared named-volume mount in both containers.',
  BT_BACKUP_STATUS_FILE:
    'The readiness status path is coupled to the read-only backupstatus volume mounted into the api container.',
} satisfies Partial<Record<EnvSchemaKey, string>>);

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
// Ephemeral session bounds (V4-P2b, owner spec #399 §A). An "unticked stay
// signed in" login gets a browser-session cookie (no Max-Age) backed by a
// server session that is NOT immortal: a sliding 45-minute idle window, hard-
// capped at 6 hours from creation. See PROJECTPLAN.md §16.
const FORTY_FIVE_MINUTES_MS = 45 * 60 * 1000;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

// Default account-export directory (§13.4 V4-P6a): a per-OS temp subdirectory so
// a stock deploy exports without configuration. Production sets BT_EXPORT_DIR to
// a durable, shared (api+worker) volume.
const DEFAULT_EXPORT_DIR = joinPath(tmpdir(), 'bettertrack-exports');

export type DeploymentMode = 'subdomains' | 'ports';

/** The public origins the app fronts, derived from the topology scheme. */
export interface Topology {
  mode: DeploymentMode;
  domain: string;
  /** `true` when the derived origins use https (front-proxy TLS). */
  tls: boolean;
  /** Origin the SPA/admin call for the JSON API. */
  apiOrigin: string;
  /** Origin serving the user SPA (also the base for generated links). */
  webOrigin: string;
  /** Origin serving the admin SPA. */
  adminOrigin: string;
  /**
   * Origin serving the static product landing page — the APEX (`{domain}`, no
   * subdomain) in subdomains mode. Static, credential-free, so it is NEVER in
   * the credentialed CORS allowlist (§4.6).
   */
  productOrigin: string;
  /** Origin serving the static `mobile.` placeholder page — same rules as product. */
  mobileOrigin: string;
}

/** Optional boolean env parse: unset/empty → fall back to `dflt`. */
function boolFrom(value: string | undefined, dflt: boolean): boolean {
  if (value === undefined || value.trim() === '') return dflt;
  const v = value.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

const DATA_ENCRYPTION_KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DEVELOPMENT_DATA_ENCRYPTION_KEY_ID = 'development-v1';
const DEVELOPMENT_DATA_ENCRYPTION_KEY =
  'bettertrack-fixed-local-record-encryption-key-v1-not-for-production';

function dataEncryptionKey(material: string): Buffer {
  return createHash('sha256').update('bettertrack:data-encryption:v1\0').update(material).digest();
}

function legacyTwoFactorKey(material: string): Buffer {
  return createHash('sha256').update(material).digest();
}

function legacySessionEncryptionKeys(rawSessionSecret: string): Buffer[] {
  const rawSegments = rawSessionSecret.split(',');
  const orderedSuffixes = rawSegments
    .map((_, index) => rawSegments.slice(index).join(','))
    .filter((suffix) => suffix.trim().length > 0);
  const individualSecrets = rawSegments
    .map((secret) => secret.trim())
    .filter((secret) => secret.length > 0);

  return [...orderedSuffixes, ...individualSecrets].map((material) =>
    legacyTwoFactorKey(`bt-2fa:${material}`),
  );
}

function parsePreviousDataEncryptionKeys(value: string | undefined): SecretBoxKey[] {
  if (!value) return [];

  return value.split(',').map((rawEntry) => {
    const entry = rawEntry.trim();
    const separator = entry.indexOf('=');
    const id = separator > 0 ? entry.slice(0, separator).trim() : '';
    const material = separator > 0 ? entry.slice(separator + 1).trim() : '';
    if (!DATA_ENCRYPTION_KEY_ID.test(id) || material.length < 32) {
      throw new Error(
        'Invalid environment configuration:\n' +
          '  - BT_DATA_ENCRYPTION_DECRYPT_KEYS: expected comma-separated id=key entries ' +
          '(ids use letters, digits, _ or -; keys are at least 32 characters)',
      );
    }
    return { id, key: dataEncryptionKey(material) };
  });
}

/**
 * Known-unsafe Grafana admin passwords that must NEVER count as "set": the image
 * default and the `.env.*.example` placeholder. Treating these as unset keeps
 * `admin/admin` (and an un-edited placeholder) off any public door (owner
 * directive 2026-07-19).
 *
 * The same list is the invariant the Grafana credential bootstrap in
 * `infra/docker-compose.yml` enforces on the LOCAL door: an unsafe (or absent)
 * `BT_GRAFANA_ADMIN_PASSWORD` is not seeded into Grafana at all — a random
 * password is generated into the grafanadata volume instead — so no interface
 * Grafana binds to, loopback or LAN, ever answers to one of these. Exported so
 * `checkProductionCompose` can assert the compose render against it.
 */
export const UNSAFE_GRAFANA_PASSWORDS: ReadonlySet<string> = new Set([
  'admin',
  'change_me_before_first_boot',
]);

function isUsableGrafanaPassword(value: string | undefined): boolean {
  if (value === undefined) return false;
  const trimmed = value.trim();
  if (trimmed === '') return false;
  return !UNSAFE_GRAFANA_PASSWORDS.has(trimmed.toLowerCase());
}

function stripTrailingSlash(origin: string): string {
  return origin.endsWith('/') ? origin.slice(0, -1) : origin;
}

type Service = 'api' | 'web' | 'admin';

/**
 * Derive the public origins from the topology scheme (§11). Explicit
 * BT_*_ORIGIN overrides win; otherwise:
 *   subdomains → `{scheme}://{sub}.{domain}`
 *   ports      → `{scheme}://{domain}:{port}`
 * The scheme comes from BT_TLS, defaulting to https for subdomains and http for
 * ports (typical self-hosted layouts). Cookies/CORS read these, never raw env.
 *
 * The static product/mobile landing origins are derived here too so the same
 * single source of truth feeds nginx templating and the SPA runtime config — but
 * product lives at the APEX (`{domain}`, no subdomain) in subdomains mode, and
 * neither ever joins the credentialed CORS allowlist (they carry no cookies).
 */
export function deriveOrigins(e: {
  BT_MODE: DeploymentMode;
  BT_DOMAIN: string;
  BT_TLS?: string;
  BT_SUB_API: string;
  BT_SUB_WEB: string;
  BT_SUB_ADMIN: string;
  BT_SUB_MOBILE: string;
  BT_PORT_API: number;
  BT_PORT_WEB: number;
  BT_PORT_ADMIN: number;
  BT_PORT_PRODUCT: number;
  BT_PORT_MOBILE: number;
  BT_API_ORIGIN?: string;
  BT_WEB_ORIGIN?: string;
  BT_ADMIN_ORIGIN?: string;
  BT_PRODUCT_ORIGIN?: string;
  BT_MOBILE_ORIGIN?: string;
  APP_ORIGIN?: string;
}): Topology {
  const mode = e.BT_MODE;
  const tls = boolFrom(e.BT_TLS, mode === 'subdomains');
  const scheme = tls ? 'https' : 'http';
  const subs: Record<Service, string> = {
    api: e.BT_SUB_API,
    web: e.BT_SUB_WEB,
    admin: e.BT_SUB_ADMIN,
  };
  const ports: Record<Service, number> = {
    api: e.BT_PORT_API,
    web: e.BT_PORT_WEB,
    admin: e.BT_PORT_ADMIN,
  };
  // APP_ORIGIN is a legacy alias for the web origin override only.
  const overrides: Record<Service, string | undefined> = {
    api: e.BT_API_ORIGIN,
    web: e.BT_WEB_ORIGIN ?? e.APP_ORIGIN,
    admin: e.BT_ADMIN_ORIGIN,
  };

  const derive = (service: Service): string => {
    const override = overrides[service];
    if (override) return stripTrailingSlash(override);
    return mode === 'subdomains'
      ? `${scheme}://${subs[service]}.${e.BT_DOMAIN}`
      : `${scheme}://${e.BT_DOMAIN}:${ports[service]}`;
  };

  // Product landing: apex (no subdomain) in subdomains mode, own port otherwise.
  const productOrigin = e.BT_PRODUCT_ORIGIN
    ? stripTrailingSlash(e.BT_PRODUCT_ORIGIN)
    : mode === 'subdomains'
      ? `${scheme}://${e.BT_DOMAIN}`
      : `${scheme}://${e.BT_DOMAIN}:${e.BT_PORT_PRODUCT}`;
  // Mobile placeholder: its own subdomain / own port.
  const mobileOrigin = e.BT_MOBILE_ORIGIN
    ? stripTrailingSlash(e.BT_MOBILE_ORIGIN)
    : mode === 'subdomains'
      ? `${scheme}://${e.BT_SUB_MOBILE}.${e.BT_DOMAIN}`
      : `${scheme}://${e.BT_DOMAIN}:${e.BT_PORT_MOBILE}`;

  return {
    mode,
    domain: e.BT_DOMAIN,
    tls,
    apiOrigin: derive('api'),
    webOrigin: derive('web'),
    adminOrigin: derive('admin'),
    productOrigin,
    mobileOrigin,
  };
}

/**
 * The endpoints metered by COST rather than by request count (§10 cost table,
 * #1643). Each key names one route whose per-request work is either unbounded
 * or scales with user-controlled input, so `general`'s request counter cannot
 * describe what it spends. The weights live in `rateLimits.requestCosts` below;
 * the routes reference the KEY only, never a number.
 */
export const REQUEST_COST_KEYS = [
  'socialShared',
  'backtestPreview',
  'analyticsSeries',
  'importCreate',
  'importRowResolve',
] as const;
export type RequestCostKey = (typeof REQUEST_COST_KEYS)[number];

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  isTest: boolean;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  /** Base origin for generated links (invites, emails) — the user web origin. */
  appOrigin: string;
  /** Derived deployment topology (§4.6, §11). */
  topology: Topology;
  /**
   * CORS allowlist (§10): the web + admin origins, the only cross-origin callers
   * of the API. Credentialed and derived from {@link Topology} — never hardcoded.
   * The static product/mobile landing origins are deliberately excluded: they
   * carry no cookies and never call the API, so admitting them would only widen
   * the credentialed surface (§4.6).
   */
  corsOrigins: string[];
  /** First secret signs new cookies; all are accepted for verification (rotation). */
  sessionSecrets: string[];
  /**
   * Long-lived server-side record encryption, independent of cookie signing.
   * TOTP and Discord use the active key for writes and the full ring for reads.
   */
  recordEncryption: SecretBoxKeyring;
  cookie: {
    name: string;
    /** Derived from the API origin scheme (https → Secure), not NODE_ENV. */
    secure: boolean;
    /**
     * SameSite=Lax works in BOTH modes: `web`/`admin` and `api` share a
     * registrable domain (subdomains) or a host (ports), so credentialed XHR is
     * same-site and Lax cookies flow. The cookie stays host-only (no Domain
     * attribute) — only the API reads it, so scoping it wider would be needless
     * exposure. `domain` is derived but left undefined for that reason.
     */
    sameSite: 'lax';
    domain?: string;
    /** Persistent-session cookie/window length: the fixed 30-day window (§6.1). */
    maxAgeMs: number;
    /**
     * Ephemeral-session sliding idle window, in ms (V4-P2b, §399 §A). An
     * ephemeral session's server TTL is refreshed to this on each activity but
     * never past {@link ephemeralCapMs} from creation. The cookie itself is
     * browser-session-scoped (no Max-Age), so both the browser and the server
     * bound the session. See PROJECTPLAN.md §16.
     */
    ephemeralIdleMs: number;
    /** Hard cap on an ephemeral session's lifetime from creation, in ms (§399 §A). */
    ephemeralCapMs: number;
  };
  email: {
    enabled: boolean;
    host?: string;
    port?: number;
    user?: string;
    pass?: string;
    from?: string;
  };
  admin: {
    email?: string;
    password?: string;
    /**
     * Env fallback for the admin session's absolute lifetime, in hours (§13.5
     * V5-P13c). Clamped to 6–24 h; the runtime setting overrides it per request.
     */
    sessionLifetimeHours: number;
  };
  /** Per-provider upstream request budget (§5.3), enforced by the request queue. */
  providers: {
    maxConcurrency: number;
    minSpacingMs: number;
    /** Provider failover chain (§13.5 V5-P1c): opt-in keyless Stooq secondary. */
    failover: {
      /** When true, register Stooq and apply the failover chains; default false. */
      enabled: boolean;
    };
  };
  /** Local-first catalog search (§6.2). */
  search: {
    /** Distinct interactive enrichment queries one user may start per window (#1709). */
    enrichmentBudget: number;
    /** Length of that window, in seconds. */
    enrichmentWindowSec: number;
  };
  /** Realtime gateway (§4.5, V3-P7a). */
  realtime: {
    /** When false the Socket.IO server is never attached — zero behavior change. */
    enabled: boolean;
  };
  /** Prometheus scrape listener (§13.5 V5-P2). localhost/LAN-only, never public. */
  metrics: {
    /** Default true — enabled with zero owner setup; false binds no metrics port. */
    enabled: boolean;
    /** Bind host; defaults to `127.0.0.1`, configurable to a LAN interface. */
    host: string;
    /** Dedicated port for the `/metrics` listener (default 9464). */
    port: number;
  };
  /**
   * Observability external access (§13.5 V5-P2 arc (a), owner 2026-07-19). The
   * self-provisioned Prometheus/Grafana stack stays localhost/LAN-only by
   * default; these gate the admin-authenticated path that lets the owner reach
   * Grafana from OUTSIDE the LAN — never a raw-public endpoint. Prometheus is
   * never exposed.
   */
  observability: {
    /** Internal URL the api reaches Grafana at (reachability probe + proxy upstream). */
    grafanaInternalUrl: string;
    /** Internal URL the api reaches Prometheus at (probe only — never proxied). */
    prometheusInternalUrl: string;
    /** Deploy-level external-access toggle; default false (safe, localhost/LAN-only). */
    externalAccessEnabled: boolean;
    /**
     * Whether a USABLE Grafana admin password is set. Derived from
     * `BT_GRAFANA_ADMIN_PASSWORD` presence (blank + the known placeholders count
     * as unset); the raw value is intentionally NOT retained on the config.
     */
    grafanaPasswordSet: boolean;
    /** Explicit public Grafana URL (auth-gated-subdomain path), else undefined. */
    grafanaPublicUrl?: string;
  };
  /**
   * Market-intelligence surfaces (§13.5 V5-P5). `enabled` defaults to true;
   * when false every intel capability reports unavailable and the per-asset
   * endpoints return the "unconfigured" shape, hiding the whole arc.
   */
  marketIntel: {
    enabled: boolean;
  };
  /** MIRRORCHAIN group portfolios (§13.5 V5-P7): the env-tunable member cap (§4). */
  mirror: {
    maxMembers: number;
  };
  /**
   * Paranoid vault (§13.5 V5-P13 arc b, design §2/§4) — the blind-store ops
   * knobs. `maxBytes` is the server-enforced ciphertext (envelope) size cap;
   * `history` bounds the ciphertext safety-net (keep at most `maxVersions`
   * archived versions and drop anything older than `maxAgeMs`).
   */
  vault: {
    maxBytes: number;
    /**
     * Per-doc-kind envelope caps of the PER-PORTFOLIO vault doc set
     * (docs/paranoid-design.md §3, E0 #1410); the E1 blind store enforces them
     * at its PUT boundary. The per-doc history shares `history` below.
     */
    docMaxBytes: {
      header: number;
      common: number;
      portfolio: number;
    };
    history: {
      maxVersions: number;
      maxAgeMs: number;
    };
  };
  /**
   * Local AI provider (§13.5 V5-P12, §16 2026-07-22 — LOCAL OLLAMA ONLY). These
   * are env DEFAULTS only; the admin's stored app_settings override them at
   * request time. When neither the env nor a stored override yields an endpoint
   * AND a model, the whole AI layer is disabled (capability reports unavailable).
   */
  ai: {
    /** Env-default Ollama base URL; undefined ⇒ no default (admin may still set one). */
    endpoint?: string;
    /** Env-default model name; undefined ⇒ no default. */
    model?: string;
    /** Fallback per-user daily completion cap when none is stored. */
    dailyCap: number;
  };
  /** Error tracking via Sentry (§13.4 V4-P5a). Off (no SDK init) iff `dsn` unset. */
  sentry: {
    enabled: boolean;
    dsn?: string;
    /** 0..1 fraction of errors captured. */
    errorSampleRate: number;
    /** 0..1 fraction of transactions traced. */
    tracesSampleRate: number;
    /** Environment tag on every event; defaults to NODE_ENV. */
    environment: string;
    /** Release tag stamped on every event (the deployed API version). */
    release: string;
  };
  /** Phone push via FCM HTTP v1 (#368). Channel exists iff the file is set AND loads. */
  push: {
    /** Path to the mounted Firebase service-account JSON; unset ⇒ channel off. */
    fcmServiceAccountFile?: string;
  };
  /** Browser push via web-push/VAPID (#368/#350). Channel on iff both keys set. */
  webPush: {
    enabled: boolean;
    publicKey?: string;
    privateKey?: string;
    /** VAPID contact (`mailto:`/`https:`), required by push services. */
    subject: string;
  };
  /** Two-factor auth (§6.1, §13.2 V2-P5). */
  twoFactor: {
    /** Issuer label embedded in the `otpauth://` provisioning URI. */
    issuer: string;
    /**
     * Compatibility key for older, out-of-scope secretBox consumers. TOTP and
     * Discord use {@link AppConfig.recordEncryption}.
     */
    encryptionKey: Buffer;
  };
  /**
   * Passkeys / WebAuthn relying-party identity (§13.4 V4-P4). All three fields are
   * DERIVED from the user web origin (the browser runs the ceremony there), never
   * hand-configured: `rpId` is that origin's host (the credential is bound to it),
   * `origin` is the full web origin a ceremony must have occurred on, and `rpName`
   * reuses the product/issuer label. No dedicated env var is needed — the deploy
   * already pins its origins via the topology scheme (§11).
   */
  webauthn: {
    /** Relying-party id — the web origin's hostname (no scheme/port). */
    rpId: string;
    /** Human-friendly relying-party name shown by some authenticators. */
    rpName: string;
    /** The full web origin a register/login ceremony must have been performed on. */
    origin: string;
  };
  /**
   * Google sign-in (§13.4 V4-P4b). `enabled` is true iff BOTH the client id and
   * secret are set; everything else keys off it — the routes 404 and the auth
   * surfaces render no button when it is false.
   */
  google: {
    enabled: boolean;
    clientId?: string;
    clientSecret?: string;
    /** Test-only OAuth endpoint overrides (§13.4 V4-P11, #520); unset in production. */
    authorizeEndpoint?: string;
    tokenEndpoint?: string;
    jwksUri?: string;
  };
  /**
   * Account data export (§13.4 V4-P6a, #494). `dir` is the directory the export
   * job assembles zips into and the cleanup job prunes; defaults to a per-OS
   * temp subdirectory when BT_EXPORT_DIR is unset.
   */
  dataExport: {
    dir: string;
  };
  /**
   * Backup readiness (#1406 W1). `statusFile` is the read-only path to the
   * scheduler's machine-readable status file; `undefined` on a deployment
   * without the backup sidecar, which the admin surface reports as "not
   * configured" rather than as a failure.
   */
  backup: {
    statusFile?: string;
  };
  /**
   * Operational data retention (§13.5 V5-P14, PL-01). Values are whole days;
   * `0` means retain forever, while an unset env uses the documented defaults.
   */
  retention: {
    auditDays: number;
    emailLogDays: number;
    /** Age since the LAST occurrence at which a captured problem is pruned. */
    problemDays: number;
    /** Age at which raw usage events are pruned (the rollup is kept). */
    usageEventDays: number;
  };
  /**
   * Telegram notification channel (§13.4 V4-P10). `enabled` is true iff the
   * global kill-switch is ON AND the bot token is set; when false the channel
   * is invisible everywhere (matrix column hidden, link routes 404, dispatcher
   * skips delivery). The token itself is a secret and never logged.
   */
  telegram: {
    enabled: boolean;
    botToken?: string;
  };
  /**
   * Discord notification channel (§13.4 V4-P10). Deployment-scoped `enabled`
   * mirrors the shared kill-switch — per-user webhook state is orthogonal.
   * When false the channel is invisible everywhere (matrix column hidden,
   * webhook routes 404, dispatcher skips delivery even for a user with a
   * saved webhook row — the row is preserved).
   */
  discord: {
    enabled: boolean;
  };
  /**
   * Progressive rate limiting (PROJECTPLAN.md §10). Each schedule pairs a
   * generous steady-state allowance with an escalating cooldown ladder; the
   * middleware and the auth service read them from here and never inline the
   * numbers. `general` also backs the admin endpoints (§10 — admin uses the
   * general schedule).
   */
  rateLimits: {
    /** Disabled under test to keep the HTTP limiter deterministic. */
    enabled: boolean;
    /** General API request rate, per user (falls back to IP when anonymous). */
    general: ProgressiveSchedule;
    /**
     * COST budget for the expensive reads, per user — a second dimension in
     * WORK UNITS rather than in requests (§10 cost table, #1643). Only the
     * routes that declare a {@link RequestCostKey} weight meter against it;
     * everything else never touches its counter.
     */
    expensive: ProgressiveSchedule;
    /** Per-request weight of each cost-metered endpoint, in units (§10 cost table). */
    requestCosts: Record<RequestCostKey, number>;
    /**
     * Short-window burst dimension layered on the general limiter: same key,
     * same escalation ladder, a tighter window that trips a reload flood the
     * generous steady-state allowance can't (§10, owner report #202).
     */
    generalBurst: ProgressiveSchedule;
    /** Provider search budget, per user — tighter than the general API (§6.2). */
    search: ProgressiveSchedule;
    /** Friend-request creation, per user — blunts bulk email→username probing (§6.9). */
    social: ProgressiveSchedule;
    /** Authenticated feedback submissions, per user — five per hour (#1315). */
    feedback: ProgressiveSchedule;
    /** Support-thread replies, per author — a conversation budget, not the capture guard (#1339). */
    feedbackThread: ProgressiveSchedule;
    /** Paranoid vault writes, per user — a modest dedicated write budget (§13.5 V5-P13, design §4). */
    vault: ProgressiveSchedule;
    /** Paranoid vault reads, per user — independent from the write budget and cooldown state. */
    vaultRead: ProgressiveSchedule;
    /** Personal API key request rate, per key id (bearer requests, §6.13). */
    apiKey: ProgressiveSchedule;
    /** Login/PIN request rate, per IP. */
    loginIp: ProgressiveSchedule;
    /** Failed-login tracking, per account — independent of the per-IP counter. */
    loginAccount: ProgressiveSchedule;
  };
}

/**
 * An empty variable means UNSET, not "the empty value".
 *
 * Docker Compose renders every declared variable it knows about, so an optional
 * setting nobody filled in arrives as `FOO=''` rather than as an absent key —
 * `'${BT_PRODUCT_ORIGIN:-}'` in infra/docker-compose.yml is exactly that. Zod's
 * `.optional()` accepts `undefined`, not `''`, so without this the container
 * refuses to boot with "BT_PRODUCT_ORIGIN: Invalid url" for a setting that is
 * legitimately not configured — a deployment with no product site, no mobile
 * origin or no SMTP server, which every fresh box is.
 *
 * Required variables still fail, just with the honest message ("Required"
 * instead of a format complaint about an empty string).
 */
function dropEmpty(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== '') out[key] = value;
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(dropEmpty(env));
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new Error(`Invalid environment configuration:\n${issues.join('\n')}`);
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === 'production';
  const isTest = e.NODE_ENV === 'test';
  const sessionSecrets = e.SESSION_SECRET.split(',')
    .map((secret) => secret.trim())
    .filter((secret) => secret.length > 0);
  if (sessionSecrets.length === 0) {
    throw new Error(
      'Invalid environment configuration:\n  - SESSION_SECRET: at least one secret is required',
    );
  }
  if (isProduction && sessionSecrets.some(isKnownSecretPlaceholder)) {
    throw new Error(
      'Invalid environment configuration:\n' +
        '  - SESSION_SECRET: replace the example placeholder before production',
    );
  }

  const hasDataEncryptionId = e.BT_DATA_ENCRYPTION_KEY_ID !== undefined;
  const hasDataEncryptionKey = e.BT_DATA_ENCRYPTION_KEY !== undefined;
  if (hasDataEncryptionId !== hasDataEncryptionKey) {
    throw new Error(
      'Invalid environment configuration:\n' +
        '  - BT_DATA_ENCRYPTION_KEY_ID/BT_DATA_ENCRYPTION_KEY: set both fields together',
    );
  }
  if (isProduction && (!hasDataEncryptionId || !hasDataEncryptionKey)) {
    throw new Error(
      'Invalid environment configuration:\n' +
        '  - BT_DATA_ENCRYPTION_KEY: dedicated record-encryption configuration is required in production',
    );
  }

  const activeDataEncryptionId =
    e.BT_DATA_ENCRYPTION_KEY_ID?.trim() ?? DEVELOPMENT_DATA_ENCRYPTION_KEY_ID;
  const activeDataEncryptionMaterial =
    e.BT_DATA_ENCRYPTION_KEY?.trim() ?? DEVELOPMENT_DATA_ENCRYPTION_KEY;
  if (!DATA_ENCRYPTION_KEY_ID.test(activeDataEncryptionId)) {
    throw new Error(
      'Invalid environment configuration:\n' +
        '  - BT_DATA_ENCRYPTION_KEY_ID: use 1-64 letters, digits, underscores, or hyphens',
    );
  }
  if (activeDataEncryptionMaterial.length < 32) {
    throw new Error(
      'Invalid environment configuration:\n' +
        '  - BT_DATA_ENCRYPTION_KEY: must be at least 32 characters',
    );
  }
  if (isProduction && /^change_me/i.test(activeDataEncryptionMaterial)) {
    throw new Error(
      'Invalid environment configuration:\n' +
        '  - BT_DATA_ENCRYPTION_KEY: replace the example placeholder before production',
    );
  }

  // ── §10 LIMITER TABLE — the single source of truth ────────────────────────
  //
  // Every progressive schedule in the app is defined in the `rateLimits` block
  // below and NOWHERE else; the middleware and the auth services read them from
  // here. `apps/api/src/config/__tests__/rateLimitTable.test.ts` pins the whole
  // table, so any future edit to a number shows up as a failing assertion
  // rather than as a silent loosening.
  //
  // | limiter          | key                | window | limit | strict? |
  // |------------------|--------------------|--------|-------|---------|
  // | general          | user id, else IP   | 15 min | 9000  | no      |
  // | generalBurst     | user id, else IP   | 30 s   |  600  | no      |
  // | expensive        | user id, else IP   |  1 min | 3000  | no      | (COST units, not requests)
  // | admin            | user id, else IP   | 15 min | 9000  | no      | (reuses `general`)
  // | search           | user id, else IP   |  1 min |  300  | no      |
  // | vault (writes)   | user id, else IP   |  1 min |   60  | no      |
  // | vaultRead        | user id, else IP   |  1 min |  600  | no      |
  // | apiKey           | api key / grant id |  1 min |  120  | no      |
  // | social           | user id, else IP   |  1 h   |   30  | STRICT  |
  // | feedback         | user id, else IP   |  1 h   |    5  | STRICT  |
  // | feedbackThread   | user id, else IP   |  1 h   |   60  | STRICT  |
  // | loginIp          | IP                 |  1 min |   25  | STRICT  |
  // | loginAccount     | account id         | 15 min |   10  | STRICT  |
  //
  // SIZING RULE (owner directive 2026-09-02, §16): a limiter that normal use can
  // reach must clear the MODELLED NORMAL-USE BAR by at least 3×. The bar is one
  // active user with two tabs open. Its terms are ENGINEERING ESTIMATES derived
  // by reading the client — the widget fan-out, the TanStack polling intervals,
  // the search debounce and its enrichment poll — not a captured browser trace;
  // treat them as a written-down model to argue against and correct, not as
  // measurements:
  //
  //   * cold dashboard load  = 10 + 2N requests (N = portfolios); a 10-widget
  //     board at N=5 is ~50, and two tabs reloading together ~100 in ~2 s
  //   * reconnect refetch (`refetchOnReconnect` defaults to true) ≈ a cold load,
  //     repeatable on every wifi blip
  //   * one deliberate asset search = up to 4 debounced prefixes × ~6 enrichment
  //     polls ≈ 24 requests to /search inside 15 s
  //   * an unkeyed `invalidateQueries()` replays a whole cold load in one tick
  //   * idle is flat and cheap: 4 req/min (8 for a paranoid account)
  //
  //   ⇒ worst realistic 30 s  ≈  188 requests → generalBurst 600  (3.2×)
  //   ⇒ worst realistic 15 min ≈ 1576 requests (a scrolled-back chat thread
  //     polls ~43/min on its own) → general 9000  (5.7×)
  //   ⇒ worst realistic 1 min on /search ≈ 96  → search 300  (3.1×)
  //
  // The exact arithmetic behind those three numbers is pinned, term by term, in
  // `config/__tests__/rateLimitTable.test.ts`.
  //
  // ── §10 COST TABLE — weights for the expensive reads (#1643) ──────────────
  //
  // `general` is a REQUEST-COUNT limiter: it cannot tell a 2 ms `GET /auth/me`
  // apart from a request that fans out N database round trips or blocks on a
  // provider. Raising its ceiling to 600 req/min (above) therefore raised the
  // ceiling on those too. The four endpoints below were the ones for which
  // `general` is the ONLY guard and whose per-request work is unbounded or
  // scales with user-controlled input; they now also spend from a second
  // dimension measured in WORK UNITS (`expensive`, 3000 units / min per user).
  //
  // ONE UNIT ≈ one ordinary cheap read (a couple of indexed queries). The
  // weights are cost ESTIMATES read off the code, in the same spirit as the
  // modelled bar above — argue with them and correct them, don't treat them as
  // measurements:
  //
  // | endpoint                                  | key             | units | why |
  // |-------------------------------------------|-----------------|-------|-----|
  // | GET  /social/shared                       | socialShared    |   10  | unbounded `Promise.all` fan-out over friends × shared items |
  // | POST /backtest/preview                    | backtestPreview |   25  | a weight-perturbed vector is a cache MISS by construction; a miss walks the positions' history sequentially through the provider layer |
  // | GET  /analytics/portfolios/:id/series     | analyticsSeries |   10  | portfolio series + optional compare series + contribution table |
  // | POST /imports                             | importCreate    |  100  | the row classifier drives ≈450 `pg_trgm` scans per batch |
  // | PATCH /imports/:id/rows/:rowId            | importRowResolve|    6  | one call per row in the wizard's bulk sweep; each re-derives a row's instrument, hash and duplicate verdict |
  //
  // A note on `analyticsSeries`, so the next reader does not re-derive it from
  // the wrong bound: its work is sized by the DATA, never by the requested
  // window. `getAssetValueSeries` takes no window at all, and all three compare
  // resolvers fetch a full history and then post-filter it into [from, to]. The
  // `ANALYTICS_MAX_RANGE_DAYS` rejection added alongside this table is a
  // request-sanity/UX guard on an absurd window — it is NOT what makes this
  // weight sound, and shrinking it would not shrink the weight.
  //
  // KNOWN FOLLOW-UP — the enumeration above is the set #1643 scoped, not the
  // exhaustive set. `POST /backtest/compare` runs 2–6 conglomerate previews per
  // request, so it is strictly heavier than the 25-unit `/preview` beside it and
  // is still metered at one request. It wants a weight of its own (≈ `/preview`
  // × the overlay count) in a follow-up.
  //
  // MODELLED NORMAL-USE BAR for the unit budget — the same one active user,
  // pessimistically doing all five things inside the SAME minute (nobody
  // actually does):
  //
  //   * builder weight-tuning, one debounced preview every ~3 s  = 20 × 25 = 500
  //   * analytics range/filter/compare changes, ~12 refetches     = 12 × 10 = 120
  //   * shared-with-me list on focus + reconnect refetch, ~6      =  6 × 10 =  60
  //   * two CSV uploads                                          =  2 × 100 = 200
  //   * a bulk kind sweep over a statement's undecided rows, ~20  = 20 ×  6 = 120
  //
  //   ⇒ worst realistic 1 min ≈ 1000 units → expensive 3000  (3.0×)
  //
  // The sweep is a BURST, not a rate: 20 is the bar for a normal statement's
  // undecided rows, and the budget leaves room for ~500 confirmations inside one
  // minute before the units run out. That ceiling sits just under `general`'s
  // 600 req/min, which is what a sweep over an unusually large batch would meet
  // first anyway — so the weight bounds a caller by the work it asks for without
  // becoming the thing that stops an ordinary human confirming their file.
  //
  // …and, on the other side, every weight is large enough that the COST budget
  // bites BEFORE the request COUNT one would: a caller doing nothing but these
  // is stopped after 120 previews, 30 uploads or 300 shared/analytics reads per
  // minute — all under `general`'s 600 req/min. That is the point of the
  // dimension: a pathological caller is bounded by the WORK it asks for, not by
  // how many requests that work happens to arrive in. Both numbers are pinned
  // in `config/__tests__/rateLimitTable.test.ts`.
  //
  // The REQUEST-COUNT bar above is unchanged by this table: these four are a
  // handful of requests inside the modelled 30 s / 15 min windows (they are
  // expensive, not chatty), and no ceiling set by the 2026-09-02 pass moved.
  //
  // The STRICT rows are abuse controls, not capacity controls, and are NOT
  // sized by this rule: credential stuffing (loginIp/loginAccount, which also
  // backs every re-auth ladder — export, deletion, 2FA disable, PIN, passkey,
  // paranoid discard), username probing (social) and owner-queue spam
  // (feedback). They keep the numbers they had before this pass. If normal use
  // ever trips one of them, the client's behaviour gets fixed, not the ceiling.

  // General steady-state schedule, defined up front so the burst dimension can
  // reuse its escalation ladder and decay verbatim (§10 — the burst window feeds
  // the SAME progressive escalation as the steady-state limiter).
  //
  // 9000 / 15 min = 600 req/min = 10 req/s sustained per user. §10's original
  // "≈ 4500/15 min" was written before the widget dashboard, the chat polls and
  // the per-portfolio `useQueries` fan-out existed; at 4500 a heavy two-tab
  // session sat at 2.9× the modelled bar — under the 3× rule, and close enough
  // that raising only the burst window would have moved the trip point onto
  // this one instead of removing it.
  const general: ProgressiveSchedule = {
    windowSec: 15 * 60,
    limit: 9000,
    cooldownsSec: [20, 60, 180, 600],
    decaySec: 15 * 60,
  };

  const topology = deriveOrigins(e);
  // Secure follows the API origin scheme: an https deployment gets Secure cookies
  // regardless of NODE_ENV; a plain-http ports layout stays non-Secure so the
  // cookie is actually accepted by the browser.
  const cookieSecure = topology.apiOrigin.startsWith('https://');

  const previousDataEncryptionKeys = parsePreviousDataEncryptionKeys(
    e.BT_DATA_ENCRYPTION_DECRYPT_KEYS,
  );
  const historicalLegacyKeys = [
    // Dedicated key used by pre-#879 deployments, when configured.
    ...(e.TOTP_ENCRYPTION_KEY ? [legacyTwoFactorKey(e.TOTP_ENCRYPTION_KEY)] : []),
    // Before #879 the fallback hashed the complete, unsplit SESSION_SECRET.
    // Preserve every ordered raw suffix so prepending `newer` to an existing
    // `new,old` rotation list still admits records written under `new,old`.
    // Individual trimmed values also retain the original `old` -> `new,old`
    // compatibility when operators used whitespace around delimiters.
    ...legacySessionEncryptionKeys(e.SESSION_SECRET),
  ];
  let recordEncryption: SecretBoxKeyring;
  try {
    recordEncryption = createSecretBoxKeyring({
      active: {
        id: activeDataEncryptionId,
        key: dataEncryptionKey(activeDataEncryptionMaterial),
      },
      previous: previousDataEncryptionKeys,
      legacyKeys: historicalLegacyKeys,
    });
  } catch {
    throw new Error(
      'Invalid environment configuration:\n' +
        '  - BT_DATA_ENCRYPTION_DECRYPT_KEYS: key identifiers must be unique',
    );
  }

  // Compatibility for out-of-scope v1 secretBox consumers. Preserve the exact
  // pre-#879 derivation, including a raw comma-separated cookie-rotation list,
  // so their existing envelopes remain readable. TOTP and Discord use
  // `recordEncryption` instead.
  const compatibilityKeyMaterial = e.TOTP_ENCRYPTION_KEY ?? `bt-2fa:${e.SESSION_SECRET}`;
  const twoFactorEncryptionKey = legacyTwoFactorKey(compatibilityKeyMaterial);

  return {
    nodeEnv: e.NODE_ENV,
    isProduction,
    isTest,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    appOrigin: topology.webOrigin,
    topology,
    corsOrigins: [topology.webOrigin, topology.adminOrigin],
    sessionSecrets,
    recordEncryption,
    cookie: {
      name: 'bt_sid',
      secure: cookieSecure,
      sameSite: 'lax',
      maxAgeMs: THIRTY_DAYS_MS,
      ephemeralIdleMs: FORTY_FIVE_MINUTES_MS,
      ephemeralCapMs: SIX_HOURS_MS,
    },
    email: {
      enabled: Boolean(e.SMTP_HOST && e.SMTP_FROM),
      host: e.SMTP_HOST,
      port: e.SMTP_PORT,
      user: e.SMTP_USER,
      pass: e.SMTP_PASS,
      from: e.SMTP_FROM,
    },
    admin: {
      email: e.ADMIN_EMAIL,
      password: e.ADMIN_PASSWORD,
      sessionLifetimeHours: e.ADMIN_SESSION_LIFETIME_HOURS,
    },
    providers: {
      maxConcurrency: e.PROVIDER_MAX_CONCURRENCY,
      minSpacingMs: e.PROVIDER_MIN_SPACING_MS,
      failover: {
        enabled: boolFrom(e.MARKET_FAILOVER_ENABLED, false),
      },
    },
    // Local-first search (§6.2). The budget bounds the INTERACTIVE provider
    // fallback per user per window; see the knob comments above for why it is
    // the same decision as `IMPORT_ENRICHMENT_QUERY_BUDGET`.
    search: {
      enrichmentBudget: e.BT_SEARCH_ENRICHMENT_BUDGET,
      enrichmentWindowSec: e.BT_SEARCH_ENRICHMENT_WINDOW_SEC,
    },
    realtime: {
      enabled: boolFrom(e.REALTIME_ENABLED, true),
    },
    metrics: {
      enabled: boolFrom(e.BT_METRICS_ENABLED, true),
      host: e.BT_METRICS_HOST,
      port: e.BT_METRICS_PORT,
    },
    observability: {
      grafanaInternalUrl: stripTrailingSlash(e.BT_GRAFANA_INTERNAL_URL),
      prometheusInternalUrl: stripTrailingSlash(e.BT_PROMETHEUS_INTERNAL_URL),
      externalAccessEnabled: boolFrom(e.BT_OBS_EXTERNAL_ACCESS, false),
      grafanaPasswordSet: isUsableGrafanaPassword(e.BT_GRAFANA_ADMIN_PASSWORD),
      grafanaPublicUrl: e.BT_GRAFANA_PUBLIC_URL
        ? stripTrailingSlash(e.BT_GRAFANA_PUBLIC_URL)
        : undefined,
    },
    // V5-P5 kill-switch: default ON (Yahoo is keyless). OFF hides every intel
    // surface via the "unconfigured" endpoint shape without any provider change.
    marketIntel: {
      enabled: boolFrom(e.MARKET_INTEL_ENABLED, true),
    },
    mirror: {
      maxMembers: e.MIRROR_MAX_MEMBERS,
    },
    vault: {
      maxBytes: e.BT_VAULT_MAX_BYTES,
      // Per-doc-kind caps of the per-portfolio vault doc set (E0 #1410); the
      // E1 blind store enforces them at its PUT boundary.
      docMaxBytes: {
        header: e.BT_VAULT_MAX_BYTES_HEADER,
        common: e.BT_VAULT_MAX_BYTES_COMMON,
        portfolio: e.BT_VAULT_MAX_BYTES_PORTFOLIO,
      },
      history: {
        maxVersions: e.BT_VAULT_HISTORY_MAX_VERSIONS,
        maxAgeMs: e.BT_VAULT_HISTORY_MAX_AGE_DAYS * 24 * 60 * 60 * 1000,
      },
    },
    // V5-P12 local-AI defaults (LOCAL Ollama ONLY). Blank env ⇒ undefined so the
    // AI layer stays cleanly disabled until an endpoint + model resolve. The
    // endpoint tolerates a compose-materialized empty string (optionalUrl).
    ai: {
      endpoint: e.BT_OLLAMA_ENDPOINT,
      model:
        e.BT_OLLAMA_MODEL && e.BT_OLLAMA_MODEL.trim() !== '' ? e.BT_OLLAMA_MODEL.trim() : undefined,
      dailyCap: e.BT_AI_DAILY_CAP,
    },
    sentry: {
      enabled: Boolean(e.BT_SENTRY_DSN),
      dsn: e.BT_SENTRY_DSN,
      errorSampleRate: e.BT_SENTRY_ERROR_SAMPLE_RATE,
      tracesSampleRate: e.BT_SENTRY_TRACES_SAMPLE_RATE,
      environment: e.BT_SENTRY_ENVIRONMENT ?? e.NODE_ENV,
      release: `${API_SERVICE_NAME}@${API_VERSION}`,
    },
    push: {
      fcmServiceAccountFile: e.BT_FCM_SERVICE_ACCOUNT_FILE,
    },
    webPush: {
      enabled: Boolean(e.BT_VAPID_PUBLIC_KEY && e.BT_VAPID_PRIVATE_KEY),
      publicKey: e.BT_VAPID_PUBLIC_KEY,
      privateKey: e.BT_VAPID_PRIVATE_KEY,
      // `||`, not `??`: compose injects BT_VAPID_SUBJECT='' when the operator
      // leaves it unset, and web-push rejects an empty subject — which would
      // silently disable the channel on the documented keys-only config.
      subject: e.BT_VAPID_SUBJECT || `mailto:admin@${e.BT_DOMAIN}`,
    },
    twoFactor: {
      issuer: e.TOTP_ISSUER,
      encryptionKey: twoFactorEncryptionKey,
    },
    webauthn: {
      // The RP id is the effective domain of the web origin — parse its host so a
      // ports layout (host:port) still yields the bare hostname WebAuthn expects.
      rpId: new URL(topology.webOrigin).hostname,
      rpName: e.TOTP_ISSUER,
      origin: topology.webOrigin,
    },
    google: {
      enabled: Boolean(e.BT_GOOGLE_CLIENT_ID && e.BT_GOOGLE_CLIENT_SECRET),
      clientId: e.BT_GOOGLE_CLIENT_ID,
      clientSecret: e.BT_GOOGLE_CLIENT_SECRET,
      authorizeEndpoint: e.BT_GOOGLE_AUTHORIZE_ENDPOINT,
      tokenEndpoint: e.BT_GOOGLE_TOKEN_ENDPOINT,
      jwksUri: e.BT_GOOGLE_JWKS_URI,
    },
    dataExport: {
      dir: e.BT_EXPORT_DIR && e.BT_EXPORT_DIR.trim() !== '' ? e.BT_EXPORT_DIR : DEFAULT_EXPORT_DIR,
    },
    backup: {
      statusFile: e.BT_BACKUP_STATUS_FILE,
    },
    retention: {
      auditDays: e.BT_AUDIT_RETENTION_DAYS,
      emailLogDays: e.BT_EMAIL_LOG_RETENTION_DAYS,
      problemDays: e.BT_PROBLEM_RETENTION_DAYS,
      usageEventDays: e.BT_USAGE_EVENT_RETENTION_DAYS,
    },
    // V5-P0 kill-switch: the SAME flag controls Telegram AND Discord — either
    // both channels are offered by this build or neither. Default OFF so an
    // upgrade quietly deactivates them without any operator action.
    telegram: {
      enabled:
        boolFrom(e.BT_TELEGRAM_DISCORD_ENABLED, false) &&
        Boolean(e.BT_TELEGRAM_BOT_TOKEN && e.BT_TELEGRAM_BOT_TOKEN.trim() !== ''),
      botToken: e.BT_TELEGRAM_BOT_TOKEN,
    },
    discord: {
      enabled: boolFrom(e.BT_TELEGRAM_DISCORD_ENABLED, false),
    },
    // Progressive schedules (§10, owner directive #79). Normal users stay far
    // under the steady-state `limit`; the first over-limit is a short cooldown
    // and only sustained abuse climbs the ladder. `decaySec` (~15 min) returns a
    // reformed caller to level 0. These stay the single source of truth — the
    // middleware and auth service read them from here; never inline the numbers.
    rateLimits: {
      enabled: !isTest,
      // 600 req/min sustained per user (5.7× the modelled two-tab bar) so an
      // ordinary heavy session never trips; over-limit → 20 s, then 1 m → 3 m →
      // 10 m (cap). See the §10 LIMITER TABLE above for the sizing rule.
      general,
      // Short-window burst guard on the SAME key + SAME ladder as `general`. The
      // 15-min steady-state bar is too high for a page-reload flood to reach
      // (owner report #202), so a 600-req / 30-s window trips the flood after a
      // dozen reloads while clearing a two-tab cold load with 3× headroom.
      generalBurst: {
        windowSec: e.RATE_LIMIT_BURST_WINDOW_SEC,
        limit: e.RATE_LIMIT_BURST_LIMIT,
        cooldownsSec: general.cooldownsSec,
        decaySec: general.decaySec,
      },
      // COST dimension (#1643): 3000 WORK UNITS per minute per user, on the
      // same key and the SAME escalation ladder as `general`, so a caller that
      // overspends work gets the identical short-then-climbing 429 it would get
      // for overspending requests — nothing about the envelope or the client's
      // backoff changes. Only the routes in the §10 COST TABLE above meter
      // against it; every other request leaves this counter untouched.
      expensive: {
        windowSec: 60,
        limit: 3000,
        cooldownsSec: general.cooldownsSec,
        decaySec: general.decaySec,
      },
      // Per-endpoint weights, in units. Rationale for each number — and the
      // modelled bar the budget above clears by 3.0× — is in the §10 COST TABLE.
      requestCosts: {
        socialShared: 10,
        backtestPreview: 25,
        analyticsSeries: 10,
        importCreate: 100,
        importRowResolve: 6,
      },
      // Provider search, per user (§6.2). 300/min — its own generous budget
      // rather than a share of `general`, because the read is cheap and bounded:
      // it answers from Postgres only (local-first catalog; provider enrichment
      // is a background job), so the cost of a spare allowance is a few indexed
      // queries.
      //
      // Raised from 60/min on 2026-09-02: the old ceiling was written for "one
      // debounced request per pause" and the client no longer behaves that way.
      // `useAssetSearch` fires one request per debounced PREFIX (min 1 char) and
      // then polls every 1.5 s for up to 10 s while the server reports
      // `enriching: true` — so ONE deliberate search costs up to ~24 requests in
      // 15 s, and three searches in a minute exceeded 60. Normal typing was
      // reaching a security-shaped ceiling. 300 = 3× that modelled minute.
      search: {
        windowSec: 60,
        limit: 300,
        cooldownsSec: [20, 60, 180, 600],
        decaySec: 15 * 60,
      },
      // STRICT (2026-09-02: deliberately NOT raised). Friend-request creation,
      // per user (§6.9): sending a request creates an outbox row revealing the
      // target's username, so bulk email→username probing must be expensive.
      // 30/hour is far above any legitimate use; over-limit → 1 m, then 5 m →
      // 15 m → 1 h (cap).
      social: {
        windowSec: 60 * 60,
        limit: 30,
        cooldownsSec: [60, 300, 900, 3600],
        decaySec: 15 * 60,
      },
      // STRICT (2026-09-02: deliberately NOT raised).
      // Feedback capture (#1315): enough for a short reporting session while
      // keeping the owner queue resistant to one authenticated account's spam.
      // The route keys this by user id for both cookie and bearer callers, and
      // retains an exhausted counter so a short cooldown cannot reopen the
      // hourly allowance.
      feedback: {
        windowSec: 60 * 60,
        limit: 5,
        cooldownsSec: [60, 300, 900, 3600],
        decaySec: 15 * 60,
        retainCountOnViolation: true,
      },
      // STRICT (2026-09-02: deliberately NOT raised).
      // Support-thread replies (#1339), per author — deliberately NOT the
      // capture budget above. Replying is the workflow the thread exists for:
      // the owner answering a queue of submissions in one sitting, and a
      // submitter answering follow-up questions, are both normal traffic, and
      // neither may be turned away because the other rail's five-per-hour
      // anti-spam allowance is spent. Sized for a conversation (a message every
      // minute, sustained, for an hour) and — again unlike capture — an
      // exhausted counter is NOT retained, so the bounded cooldown genuinely
      // reopens the rail. Admin callers additionally pass the router-level
      // `admin` budget, so this one only has to be conversation-shaped.
      // Scope note (#1472): submitter tombstones (DELETE /feedback/:id) also
      // meter here, for the same reason DELETE must not touch capture. So the
      // independence above is capture-vs-conversation only — inside this
      // namespace, replies and deletes do share a counter and a cooldown.
      feedbackThread: {
        windowSec: 60 * 60,
        limit: 60,
        cooldownsSec: [60, 300, 900, 3600],
        decaySec: 15 * 60,
      },
      // Paranoid vault writes, per user (§13.5 V5-P13, design §4): a modest
      // dedicated write budget like every other write family. Generous enough
      // that legitimate multi-device sync never trips (default 60/min); the
      // window/limit are env-tunable ops knobs. Shares the general escalation
      // ladder + decay.
      vault: {
        windowSec: e.BT_VAULT_RATE_WINDOW_SEC,
        limit: e.BT_VAULT_RATE_LIMIT,
        cooldownsSec: general.cooldownsSec,
        decaySec: general.decaySec,
      },
      // Reads use their own larger allowance and Redis namespace. Reusing the
      // vault window keeps the operator surface small while preventing sync
      // polling from consuming the write family's budget or cooldown ladder.
      // Note (2026-09-02): this 600/min budget was previously UNREACHABLE — the
      // app-wide `general` limiter capped every caller at 300/min first, so the
      // read allowance could never be spent. With `general` at 600/min the two
      // now line up and the dedicated read budget means what it says.
      vaultRead: {
        windowSec: e.BT_VAULT_RATE_WINDOW_SEC,
        limit: e.BT_VAULT_READ_RATE_LIMIT,
        cooldownsSec: general.cooldownsSec,
        decaySec: general.decaySec,
      },
      // Personal API keys, per key id (§6.13): a generous automation budget —
      // 120/min sustained (2 req/s) so scripted polling stays clear — with the
      // general escalation ladder for a runaway client. Bearer requests key this
      // by key id, independent of the per-user general counter.
      apiKey: {
        windowSec: 60,
        limit: 120,
        cooldownsSec: general.cooldownsSec,
        decaySec: general.decaySec,
      },
      // STRICT (2026-09-02: deliberately NOT raised). Login is stricter and
      // per-IP: blunts single-IP credential stuffing while tolerating shared-NAT
      // bursts. Over-limit → 30 s → 5 m → 10 m → 15 m.
      loginIp: {
        windowSec: e.RATE_LIMIT_LOGIN_IP_WINDOW_SEC,
        limit: e.RATE_LIMIT_LOGIN_IP_LIMIT,
        cooldownsSec: [30, 300, 600, 900],
        decaySec: 15 * 60,
      },
      // STRICT (2026-09-02: deliberately NOT raised). Per-account failed-login
      // tracking, independent of the per-IP counter: ~10 failures → 30 s, next
      // batch → 5 m, escalating to 10–15 min (§6.1). This schedule also backs
      // EVERY re-auth ladder — data export, account deletion, 2FA disable, PIN
      // token, passkey re-auth, Google mobile link, paranoid discard/vault
      // delete/portfolio move-in/move-out — so raising it would loosen all of
      // them at once.
      loginAccount: {
        windowSec: 15 * 60,
        limit: 10,
        cooldownsSec: [30, 300, 600, 900],
        decaySec: 15 * 60,
      },
    },
  };
}
