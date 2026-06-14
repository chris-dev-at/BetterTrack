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
  rateLimits: {
    /** Disabled under test to keep API tests deterministic. */
    enabled: boolean;
    loginPerMinutePerIp: number;
    generalPer15MinPerUser: number;
    adminPer15Min: number;
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
    rateLimits: {
      enabled: !isTest,
      loginPerMinutePerIp: 5,
      generalPer15MinPerUser: 600,
      adminPer15Min: 120,
      accountFailuresPerHour: 10,
      lockoutThreshold: 10,
      lockoutSeconds: 15 * 60,
    },
  };
}
