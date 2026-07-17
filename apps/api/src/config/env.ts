import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

import { z } from 'zod';

import type { ProgressiveSchedule } from '../services/security/progressiveLimiter';
import { API_SERVICE_NAME, API_VERSION } from '../version';

/**
 * Environment schema (PROJECTPLAN.md §11). Validated once at boot so a
 * misconfigured deployment fails fast and loudly instead of at first request.
 */
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
  BT_API_ORIGIN: z.string().url().optional(),
  BT_WEB_ORIGIN: z.string().url().optional(),
  BT_ADMIN_ORIGIN: z.string().url().optional(),
  BT_PRODUCT_ORIGIN: z.string().url().optional(),
  BT_MOBILE_ORIGIN: z.string().url().optional(),
  APP_ORIGIN: z.string().url().optional(),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().optional(),
  // Per-provider request budget (§5.3): bounded concurrency + minimum spacing
  // between upstream call starts. Defaults match PROJECTPLAN §5.2/§5.3.
  // NOTE: the budget is per *process* — the API and the BullMQ worker each run
  // their own queue with an independent spacing clock, so the effective
  // upstream budget is N × these values for N running processes (§5.3 only
  // mandates the Redis lock for cross-process coalescing). Set lower values in
  // each service's env if a tighter combined budget is needed.
  PROVIDER_MAX_CONCURRENCY: z.coerce.number().int().positive().default(4),
  PROVIDER_MIN_SPACING_MS: z.coerce.number().int().nonnegative().default(250),
  // Short-window burst dimension of the general limiter (§10, owner report #202):
  // the 15-min steady-state allowance is generous enough that a rapid page-reload
  // flood never reaches it, so a second, short window catches the flood without
  // touching the steady-state bar. Sized well above a multi-tab TanStack refetch
  // burst so legitimate use never trips; over-limit feeds the SAME escalation
  // ladder as the steady-state limiter.
  RATE_LIMIT_BURST_WINDOW_SEC: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_BURST_LIMIT: z.coerce.number().int().positive().default(60),

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

  // ── Two-factor auth (§6.1, §13.2 V2-P5) ────────────────────────────────────
  // Issuer label baked into the `otpauth://` URI so the code shows up as
  // "BetterTrack (user@…)" in an authenticator app. TOTP_ENCRYPTION_KEY is the
  // secret that encrypts each user's TOTP secret at rest (AES-256-GCM); any
  // length is accepted and folded to a 32-byte key. When unset it is DERIVED
  // from SESSION_SECRET so a stock deploy still encrypts — set a dedicated value
  // to rotate 2FA encryption independently of session signing.
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
});

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
  };
  /** Per-provider upstream request budget (§5.3), enforced by the request queue. */
  providers: {
    maxConcurrency: number;
    minSpacingMs: number;
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
    /** 32-byte AES-256-GCM key encrypting each user's TOTP secret at rest. */
    encryptionKey: Buffer;
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
     * Short-window burst dimension layered on the general limiter: same key,
     * same escalation ladder, a tighter window that trips a reload flood the
     * generous steady-state allowance can't (§10, owner report #202).
     */
    generalBurst: ProgressiveSchedule;
    /** Provider search budget, per user — tighter than the general API (§6.2). */
    search: ProgressiveSchedule;
    /** Friend-request creation, per user — blunts bulk email→username probing (§6.9). */
    social: ProgressiveSchedule;
    /** Personal API key request rate, per key id (bearer requests, §6.13). */
    apiKey: ProgressiveSchedule;
    /** Login/PIN request rate, per IP. */
    loginIp: ProgressiveSchedule;
    /** Failed-login tracking, per account — independent of the per-IP counter. */
    loginAccount: ProgressiveSchedule;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new Error(`Invalid environment configuration:\n${issues.join('\n')}`);
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === 'production';
  const isTest = e.NODE_ENV === 'test';

  // General steady-state schedule, defined up front so the burst dimension can
  // reuse its escalation ladder and decay verbatim (§10 — the burst window feeds
  // the SAME progressive escalation as the steady-state limiter).
  const general: ProgressiveSchedule = {
    windowSec: 15 * 60,
    limit: 4500,
    cooldownsSec: [20, 60, 180, 600],
    decaySec: 15 * 60,
  };

  const topology = deriveOrigins(e);
  // Secure follows the API origin scheme: an https deployment gets Secure cookies
  // regardless of NODE_ENV; a plain-http ports layout stays non-Secure so the
  // cookie is actually accepted by the browser.
  const cookieSecure = topology.apiOrigin.startsWith('https://');

  // Fold the configured key material (or, when unset, the session secret under a
  // domain-separated label) into a fixed 32-byte AES-256-GCM key. Deriving from
  // SESSION_SECRET keeps a stock deploy encrypting without extra config; a
  // dedicated TOTP_ENCRYPTION_KEY rotates 2FA encryption on its own.
  const twoFactorKeyMaterial = e.TOTP_ENCRYPTION_KEY ?? `bt-2fa:${e.SESSION_SECRET}`;
  const twoFactorEncryptionKey = createHash('sha256').update(twoFactorKeyMaterial).digest();

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
    sessionSecrets: e.SESSION_SECRET.split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
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
    },
    providers: {
      maxConcurrency: e.PROVIDER_MAX_CONCURRENCY,
      minSpacingMs: e.PROVIDER_MIN_SPACING_MS,
    },
    realtime: {
      enabled: boolFrom(e.REALTIME_ENABLED, true),
    },
    metrics: {
      enabled: boolFrom(e.BT_METRICS_ENABLED, true),
      host: e.BT_METRICS_HOST,
      port: e.BT_METRICS_PORT,
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
      // ~300 req/min sustained per user so rapid multi-tab TanStack refetch
      // bursts never trip; over-limit → 20 s, then 1 m → 3 m → 10 m (cap).
      general,
      // Short-window burst guard on the SAME key + SAME ladder as `general`. The
      // 15-min/4500 steady-state bar is too high for a page-reload flood to reach
      // (owner report #202), so a ~60-req / 10-s window trips the flood after a
      // handful of reloads while staying far above any multi-tab refetch burst.
      generalBurst: {
        windowSec: e.RATE_LIMIT_BURST_WINDOW_SEC,
        limit: e.RATE_LIMIT_BURST_LIMIT,
        cooldownsSec: general.cooldownsSec,
        decaySec: general.decaySec,
      },
      // Provider search is tighter (§6.2): 60/min/user (client debounces every
      // keystroke at 300 ms, so legitimate typing stays well under this).
      search: {
        windowSec: 60,
        limit: 60,
        cooldownsSec: [20, 60, 180, 600],
        decaySec: 15 * 60,
      },
      // Friend-request creation, per user (§6.9): sending a request creates an
      // outbox row revealing the target's username, so bulk email→username
      // probing must be expensive. 30/hour is far above any legitimate use;
      // over-limit → 1 m, then 5 m → 15 m → 1 h (cap).
      social: {
        windowSec: 60 * 60,
        limit: 30,
        cooldownsSec: [60, 300, 900, 3600],
        decaySec: 15 * 60,
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
      // Login is stricter and per-IP: blunts single-IP credential stuffing while
      // tolerating shared-NAT bursts. Over-limit → 30 s → 5 m → 10 m → 15 m.
      loginIp: {
        windowSec: 60,
        limit: 25,
        cooldownsSec: [30, 300, 600, 900],
        decaySec: 15 * 60,
      },
      // Per-account failed-login tracking, independent of the per-IP counter:
      // ~10 failures → 30 s, next batch → 5 m, escalating to 10–15 min (§6.1).
      loginAccount: {
        windowSec: 15 * 60,
        limit: 10,
        cooldownsSec: [30, 300, 600, 900],
        decaySec: 15 * 60,
      },
    },
  };
}
