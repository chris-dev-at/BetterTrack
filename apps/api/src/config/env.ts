import { z } from 'zod';

import type { ProgressiveSchedule } from '../services/security/progressiveLimiter';

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
  // `ports` puts each service on its own port of a single host. The three
  // origins (api/web/admin) are DERIVED from these (see deriveOrigins); CORS,
  // cookies and link generation consume the derived values so no origin is ever
  // hand-maintained. Explicit BT_*_ORIGIN overrides win over derivation.
  BT_MODE: z.enum(['subdomains', 'ports']).default('subdomains'),
  BT_DOMAIN: z.string().min(1).default('localhost'),
  // Front-proxy TLS. Defaults per mode (subdomains → https, ports → http) when
  // unset; an explicit value forces the scheme of every derived origin.
  BT_TLS: z.string().optional(),
  BT_SUB_API: z.string().min(1).default('api'),
  BT_SUB_WEB: z.string().min(1).default('web'),
  BT_SUB_ADMIN: z.string().min(1).default('admin'),
  BT_PORT_API: z.coerce.number().int().positive().default(3000),
  BT_PORT_WEB: z.coerce.number().int().positive().default(8080),
  BT_PORT_ADMIN: z.coerce.number().int().positive().default(8081),
  // Explicit origin overrides (win over derivation). Useful for split hosting or
  // a legacy single-origin setup. APP_ORIGIN is a legacy alias for BT_WEB_ORIGIN.
  BT_API_ORIGIN: z.string().url().optional(),
  BT_WEB_ORIGIN: z.string().url().optional(),
  BT_ADMIN_ORIGIN: z.string().url().optional(),
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
});

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export type DeploymentMode = 'subdomains' | 'ports';

/** The three public origins the app fronts, derived from the topology scheme. */
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
 * Derive the three public origins from the topology scheme (§11). Explicit
 * BT_*_ORIGIN overrides win; otherwise:
 *   subdomains → `{scheme}://{sub}.{domain}`
 *   ports      → `{scheme}://{domain}:{port}`
 * The scheme comes from BT_TLS, defaulting to https for subdomains and http for
 * ports (typical self-hosted layouts). Cookies/CORS read these, never raw env.
 */
export function deriveOrigins(e: {
  BT_MODE: DeploymentMode;
  BT_DOMAIN: string;
  BT_TLS?: string;
  BT_SUB_API: string;
  BT_SUB_WEB: string;
  BT_SUB_ADMIN: string;
  BT_PORT_API: number;
  BT_PORT_WEB: number;
  BT_PORT_ADMIN: number;
  BT_API_ORIGIN?: string;
  BT_WEB_ORIGIN?: string;
  BT_ADMIN_ORIGIN?: string;
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

  return {
    mode,
    domain: e.BT_DOMAIN,
    tls,
    apiOrigin: derive('api'),
    webOrigin: derive('web'),
    adminOrigin: derive('admin'),
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
    maxAgeMs: number;
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
