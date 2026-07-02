import { z } from 'zod';

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
  APP_ORIGIN: z.string().url(),
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
});

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  isTest: boolean;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  appOrigin: string;
  /** First secret signs new cookies; all are accepted for verification (rotation). */
  sessionSecrets: string[];
  cookie: {
    name: string;
    secure: boolean;
    sameSite: 'lax';
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
  rateLimits: {
    /** Disabled under test to keep API tests deterministic. */
    enabled: boolean;
    loginPerMinutePerIp: number;
    generalPer15MinPerUser: number;
    adminPer15Min: number;
    /** Provider search is rate-limited tighter than the general API (§6.2, §10). */
    searchPerMinutePerUser: number;
    /** Per-account failed-login controls (PROJECTPLAN.md §6.1). */
    accountFailuresPerHour: number;
    lockoutThreshold: number;
    lockoutSeconds: number;
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

  return {
    nodeEnv: e.NODE_ENV,
    isProduction,
    isTest,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    appOrigin: e.APP_ORIGIN,
    sessionSecrets: e.SESSION_SECRET.split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    cookie: {
      name: 'bt_sid',
      secure: isProduction,
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
    // Relaxed per the owner-authorized 2026-06-16 deviation from §6.1/§10
    // (PROJECTPLAN.md §16 Decision Log): the original numbers tripped 429s
    // during normal logged-in use (rapid tab switching / multi-tab TanStack
    // refetches). These stay the single source of truth — the middleware and
    // auth service read them from here; never inline the magic numbers.
    rateLimits: {
      enabled: !isTest,
      // §16 (2026-06-16): 5 → 25/min/IP. Still blunts single-IP credential
      // stuffing but tolerates shared-NAT and quick legitimate retries.
      loginPerMinutePerIp: 25,
      // §16 (2026-06-16): 600 → 4500/15min/user (~300 req/min sustained), so
      // rapid multi-tab navigation never trips the general limiter — the
      // primary fix for the "request spam" complaint.
      generalPer15MinPerUser: 4500,
      // §16 (2026-06-16): 120 → 600/15min, so the admin UI's polling and
      // navigation aren't throttled.
      adminPer15Min: 600,
      // §6.2/§10: provider search is capped at 60/min/user (client debounces at
      // 300 ms + min 2 chars, so legitimate typing stays well under this).
      searchPerMinutePerUser: 60,
      // §16 (2026-06-16): 10 → 20 failures/hour/account — more forgiving but
      // still a real per-account brute-force guard.
      accountFailuresPerHour: 20,
      // §16 (2026-06-16): 10 → 20 consecutive failures before lockout, and
      // lockout shortened 15 min → 5 min. Lenient but protection intact.
      lockoutThreshold: 20,
      lockoutSeconds: 5 * 60,
    },
  };
}
