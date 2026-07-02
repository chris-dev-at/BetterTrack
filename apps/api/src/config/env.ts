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
    /** Provider search budget, per user — tighter than the general API (§6.2). */
    search: ProgressiveSchedule;
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
    // Progressive schedules (§10, owner directive #79). Normal users stay far
    // under the steady-state `limit`; the first over-limit is a short cooldown
    // and only sustained abuse climbs the ladder. `decaySec` (~15 min) returns a
    // reformed caller to level 0. These stay the single source of truth — the
    // middleware and auth service read them from here; never inline the numbers.
    rateLimits: {
      enabled: !isTest,
      // ~300 req/min sustained per user so rapid multi-tab TanStack refetch
      // bursts never trip; over-limit → 20 s, then 1 m → 3 m → 10 m (cap).
      general: {
        windowSec: 15 * 60,
        limit: 4500,
        cooldownsSec: [20, 60, 180, 600],
        decaySec: 15 * 60,
      },
      // Provider search is tighter (§6.2): 60/min/user (client debounces at
      // 300 ms + min 2 chars, so legitimate typing stays well under this).
      search: {
        windowSec: 60,
        limit: 60,
        cooldownsSec: [20, 60, 180, 600],
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
