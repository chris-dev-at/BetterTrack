import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import postgres from 'postgres';
import request from 'supertest';

import {
  twoFactorChallengeResponseSchema,
  twoFactorEnrollResponseSchema,
} from '@bettertrack/contracts';

import { createApp } from '../app';
import { loadConfig } from '../config/env';
import type { Database } from '../data/db';
import { createUserRepository } from '../data/repositories/userRepository';
import { generateTotpCode } from '../services/auth/totp';
import * as schema from '../data/schema';
import { buildContext, type AppContext } from '../http/context';
import type { BackfillScheduler } from '../jobs';
import { createLogger } from '../logger';
import type { MarketDataService } from '../providers';
import type { MailTransport } from '../services/email/transport';
import type { LiveModeServiceOptions } from '../services/liveMode';
import type { GoogleTokenVerifier } from '../services/auth/googleVerifier';
import type { PasskeyWebAuthnEngine } from '../services/auth/passkeyService';
import type { OAuthLogoFetcher } from '../services/oauth/oauthLogo';
import type { DispatchableEvent } from '../services/notifications/notificationDispatcher';
import type { OutboundUrlResolver } from '../services/security/outboundUrlGuard';
import type { WebhookTransport } from '../services/webhooks';
import { createPasswordHasher, type PasswordHasher } from '../services/password/passwordHasher';

/**
 * Offline DNS for the webhook outbound guard: every hostname resolves to one
 * public address. Keeps the suite's `https://receiver.test/hook` subscriptions
 * working without a network round trip; IP-literal destinations never reach it.
 */
export const publicTestResolver: OutboundUrlResolver = async () => [
  { address: '93.184.216.34', family: 4 },
];

/**
 * In-process integration harness. Default mode: PGlite (WASM) + ioredis-mock —
 * fast, no Docker, runs migrations from the generated SQL files.
 *
 * Integration mode: when TEST_DATABASE_URL / TEST_REDIS_URL env vars are set,
 * the harness switches to a real postgres:17 + redis:7 connection. The module-
 * level singletons below ensure migrations run only once per worker process
 * (each call to createTestApp truncates all tables for a clean test slate).
 * Run with vitest.config.integration.ts which sets pool: forks + singleFork to
 * keep those singletons alive across test files.
 */
const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

// Env vars for integration mode. Both must point at the service containers.
const realDbUrl = process.env.TEST_DATABASE_URL;
const realRedisUrl = process.env.TEST_REDIS_URL;

/**
 * Connection ceiling of the integration-mode pool (see `acquireRealDb`). Tests
 * that fan requests out concurrently must size the burst against this: a
 * transaction blocked on a lock holds its pooled connection for the whole wait,
 * so anything launched past the ceiling measures connection hand-off order
 * rather than whatever it meant to measure (auth.test.ts's reset-timing
 * distribution learned this the expensive way).
 */
export const INTEGRATION_DB_POOL_MAX = 3;

// ---- real-service singletons (module scope, shared across tests in one worker) ----
let pgClient: ReturnType<typeof postgres> | undefined;
let pgDb: Database | undefined;
let pgMigrated = false;
let realRedisClient: Redis | undefined;

async function acquireRealDb(): Promise<Database> {
  if (!pgClient) {
    // Keep independent sessions plus one spare available: admin.test.ts proves
    // the active-administrator row lock with genuinely overlapping transactions,
    // while mirrorReplication.test.ts pauses one writer and queues another.
    // The spare keeps an incidental pooled read from turning either lock
    // regression into connection-pool starvation.
    pgClient = postgres(realDbUrl!, { max: INTEGRATION_DB_POOL_MAX });
    pgDb = drizzlePostgres(pgClient, { schema });
  }
  if (!pgMigrated) {
    await migratePostgres(pgDb!, { migrationsFolder });
    pgMigrated = true;
  }
  // Derive the table list from the DB so new migrations are picked up automatically.
  const tableRows = await pgClient!<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      AND table_name <> '__drizzle_migrations'
    ORDER BY table_name
  `;
  if (tableRows.length > 0) {
    const tableList = tableRows.map((r) => `"${r.table_name}"`).join(', ');
    await pgClient!.unsafe(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
  }
  return pgDb!;
}

async function acquireRealRedis(): Promise<Redis> {
  if (!realRedisClient) {
    realRedisClient = new Redis(realRedisUrl!, { maxRetriesPerRequest: null });
  }
  await realRedisClient.flushdb();
  return realRedisClient;
}

// ---- PGlite singleton (one per worker process) ----
// Booting WASM Postgres and replaying every migration used to happen on EACH
// createTestApp call and dominated the unit suite's runtime. Instead the PGlite
// branch now follows the exact lifecycle contract of the real-Postgres branch
// above (and of the shared RedisMock store): one migrated instance per worker,
// truncated to a clean slate on every createTestApp call. The integration mode
// already runs the whole suite under that contract, so no test depends on two
// harnesses being live at once. The instance lives on globalThis because vitest
// resets the module registry per test file but reuses the worker process.
const gt = globalThis as typeof globalThis & { __btPglite?: Promise<PGlite> };

async function bootMigratedPglite(): Promise<PGlite> {
  // pg_trgm must be loadable: the 0003 migration CREATEs it for the catalog's
  // trigram search indexes (§5.5, §6.2).
  const client = new PGlite({ extensions: { pg_trgm } });
  await migratePglite(drizzlePglite(client, { schema }), { migrationsFolder });
  return client;
}

async function acquirePgliteDb(): Promise<Database> {
  gt.__btPglite ??= bootMigratedPglite();
  const client = await gt.__btPglite;
  // Derive the table list from the DB so new migrations are picked up
  // automatically (mirrors acquireRealDb above).
  const tableRows = await client.query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      AND table_name <> '__drizzle_migrations'
    ORDER BY table_name
  `);
  if (tableRows.rows.length > 0) {
    const tableList = tableRows.rows.map((r) => `"${r.table_name}"`).join(', ');
    await client.exec(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
  }
  return drizzlePglite(client, { schema }) as unknown as Database;
}

// §10's argon2id parameters are deliberately slow — that is the security
// property in production and pure overhead here, where seeds and login flows
// mint hashes constantly. Same code path at minimum cost; password.test.ts
// still exercises the real parameters, and because the parameters travel
// inside each hash the two costs coexist freely.
const testPasswordHasher = createPasswordHasher({ memoryCost: 4096, timeCost: 1 });

// Base env used for loadConfig. URLs reflect whichever backend is active.
const BASE_TEST_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: realDbUrl ?? 'postgres://test',
  REDIS_URL: realRedisUrl ?? 'redis://test',
  SESSION_SECRET: 'test-session-secret-please-change-0123456789',
  // Explicit origin overrides mirror the local dev topology (ports mode); the
  // web origin doubles as appOrigin for generated links.
  BT_WEB_ORIGIN: 'http://localhost:5173',
  BT_ADMIN_ORIGIN: 'http://localhost:5174',
  BT_API_ORIGIN: 'http://localhost:3000',
};

export interface SeededAdmin {
  id: string;
  email: string;
  username: string;
  password: string;
}

export interface SeededUser {
  id: string;
  email: string;
  username: string;
  password: string;
}

export interface TestHarness {
  app: ReturnType<typeof createApp>;
  ctx: AppContext;
  db: Database;
  /**
   * Releases only resources owned by this harness. The real-service Redis
   * client is process-shared, so disposal is deliberately a no-op in that
   * mode.
   */
  dispose(): Promise<void>;
  seedAdmin(input?: Partial<Omit<SeededAdmin, 'id'>>): Promise<SeededAdmin>;
  seedUser(input?: Partial<Omit<SeededUser, 'id'>>): Promise<SeededUser>;
  /**
   * Log a freshly-seeded admin in AND satisfy the mandatory admin-login 2FA gate
   * (§6.12, #400) by enrolling TOTP, then performing the mandatory fresh login
   * after that security transition. Returns the authenticated post-2FA agent.
   * Use this wherever a test needs an admin that can call ordinary admin routes.
   */
  loginAdmin(admin: SeededAdmin): Promise<ReturnType<typeof request.agent>>;
}

export interface CreateTestAppOptions {
  /** Extra/override env, e.g. SMTP_* to exercise the enabled email channel. */
  env?: Partial<NodeJS.ProcessEnv>;
  /** Fake mail transport injected in place of a real SMTP connection. */
  emailTransport?: MailTransport | null;
  /** Controlled password hasher for deterministic credential-transition races. */
  passwordHasher?: PasswordHasher;
  /** Stubbed market-data service, in place of the live Yahoo/manual providers. */
  marketData?: MarketDataService;
  /** Controlled portfolio-service clock (UTC-window boundaries, archive/restore transitions). */
  portfolioNow?: () => number;
  /** Controlled destructive portfolio-vault transition clock. */
  portfolioVaultTransitionNow?: () => Date;
  /** Backfill scheduler (e.g. a recording fake) to assert first-touch enqueues. */
  backfill?: BackfillScheduler;
  /**
   * Stubbed Google token/ID-token verifier (§13.4 V4-P4b) in place of the real
   * jose-based one, so the whole sign-in flow runs on canned claims with no
   * network. Requires the Google env (BT_GOOGLE_CLIENT_ID/SECRET) to be set too.
   */
  googleVerifier?: GoogleTokenVerifier;
  /**
   * Stubbed passkey WebAuthn engine (§13.4 V4-P4) in place of the real
   * `@simplewebauthn` primitives, so register/login ceremonies run on canned
   * results with no authenticator, browser, or crypto.
   */
  passkeyEngine?: PasskeyWebAuthnEngine;
  /** Fast poll cadence / small ring for Live Mode tests (V3-P7b). */
  liveModeOptions?: LiveModeServiceOptions;
  /** Controlled process-local realtime command-bucket clock. */
  realtimeCommandNow?: () => number;
  /**
   * Notification-center transport override (#368): e.g. a recording queue that
   * nothing consumes, to model a dispatcher outage. Defaults to synchronous
   * direct dispatch under test.
   */
  notificationEnqueue?: (event: DispatchableEvent) => Promise<void>;
  /** Recording data-export build transport for atomic request-gate tests. */
  exportEnqueue?: (jobId: string, opts?: { delayMs?: number }) => Promise<void>;
  /** Pause an export after collection while its account transition lock is held. */
  exportAfterCollect?: (userId: string) => void | Promise<void>;
  /** Shrink the export build ceilings (#1714) so the clean-refusal path is provable. */
  exportLimits?: { maxRows?: number; maxContentBytes?: number };
  /** Shrink the absolute export-download bound (#1714) to a test-sized window. */
  exportDownloadMaxMs?: number;
  /**
   * Controlled clock for the notification service (#437) — makes the
   * auto-archive sweep threshold provable deterministically.
   */
  notificationNow?: () => Date;
  /** Controlled tax-engine clock for deterministic correction timestamps in tests. */
  taxNow?: () => number;
  /**
   * Controlled clock for the expense budget/dashboard engine (§13.5 V5-P9) — the
   * current evaluation period + a dashboard's default month derive from it, so a
   * blown-budget alert and a month's aggregates are provable deterministically.
   */
  budgetNow?: () => Date;
  /**
   * Recording webhook transport (§13.5 V5-P10) in place of the real `fetch`
   * POST, so a delivery's signed payload is assertable without a network
   * receiver. With it set, the webhook delivery seam runs a single synchronous
   * attempt through the dispatcher (no BullMQ under test).
   */
  webhookTransport?: WebhookTransport;
  /**
   * DNS resolver for the webhook outbound (SSRF) guard (§13.5 V5-P10), used at
   * create/update and on every delivery attempt. Defaults to a stub that maps
   * every hostname to one public address, so the suite's `*.test` receivers stay
   * deterministic and offline; a test that exercises the guard injects its own
   * (e.g. one that starts public and later returns `127.0.0.1`).
   */
  webhookUrlResolver?: OutboundUrlResolver;
  /**
   * Canned/recording fetch for the local-AI (Ollama) adapter (§13.5 V5-P12).
   * Lets a test drive the AI feature endpoints with no real network and assert
   * the model only ever reaches the configured local endpoint.
   */
  aiFetch?: typeof fetch;
  /** Save-time OAuth client-logo fetcher; avoids network in logo-flow tests. */
  oauthLogoFetcher?: OAuthLogoFetcher;
  /**
   * Force `rateLimits.enabled` on (default: off under `NODE_ENV=test`). Set on
   * the specific tests that need to exercise the HTTP limiter end-to-end
   * (§13.5 V5-P10 — bearer→apiKey wiring), while leaving every other test on
   * the deterministic no-limiter path.
   */
  rateLimitsEnabled?: boolean;
}

export async function createTestApp(options: CreateTestAppOptions = {}): Promise<TestHarness> {
  let db: Database;
  let redis: Redis;

  if (realDbUrl) {
    db = await acquireRealDb();
  } else {
    db = await acquirePgliteDb();
  }

  if (realRedisUrl) {
    redis = await acquireRealRedis();
  } else {
    redis = new RedisMock() as unknown as Redis;
    // ioredis-mock instances share one store per worker — flush for a clean
    // slate, mirroring the real-Redis branch above.
    await redis.flushall();
  }

  // The real Redis client belongs to the worker-level integration harness and
  // must outlive every individual createTestApp() call. RedisMock, by contrast,
  // is constructed above for this harness alone and is safe to close here.
  const releaseOwnedRedis: () => Promise<void> = realRedisUrl
    ? async () => undefined
    : async () => {
        await redis.quit();
      };
  let disposed = false;

  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    await releaseOwnedRedis();
  }

  const config = loadConfig({ ...BASE_TEST_ENV, ...options.env });
  if (options.rateLimitsEnabled) {
    config.rateLimits.enabled = true;
  }
  const logger = createLogger(config);
  const ctx = buildContext({
    config,
    db,
    redis,
    logger,
    emailTransport: options.emailTransport,
    marketData: options.marketData,
    portfolioNow: options.portfolioNow,
    portfolioVaultTransitionNow: options.portfolioVaultTransitionNow,
    backfill: options.backfill,
    googleVerifier: options.googleVerifier,
    passwordHasher: options.passwordHasher ?? testPasswordHasher,
    passkeyEngine: options.passkeyEngine,
    liveModeOptions: options.liveModeOptions,
    realtimeCommandNow: options.realtimeCommandNow,
    notificationEnqueue: options.notificationEnqueue,
    exportEnqueue: options.exportEnqueue,
    exportAfterCollect: options.exportAfterCollect,
    exportLimits: options.exportLimits,
    exportDownloadMaxMs: options.exportDownloadMaxMs,
    notificationNow: options.notificationNow,
    taxNow: options.taxNow,
    budgetNow: options.budgetNow,
    webhookTransport: options.webhookTransport,
    webhookUrlResolver: options.webhookUrlResolver ?? publicTestResolver,
    aiFetch: options.aiFetch,
    oauthLogoFetcher: options.oauthLogoFetcher,
  });
  const app = createApp(ctx);

  const userRepo = createUserRepository(db);
  const hasher = testPasswordHasher;

  async function seedAdmin(input: Partial<Omit<SeededAdmin, 'id'>> = {}): Promise<SeededAdmin> {
    const email = input.email ?? 'admin@bettertrack.test';
    const username = input.username ?? 'admin';
    const password = input.password ?? 'admin-strong-password-1';
    const passwordHash = await hasher.hash(password);
    const user = await userRepo.create({
      email,
      username,
      passwordHash,
      role: 'admin',
      status: 'active',
      mustChangePassword: false,
    });
    return { id: user.id, email: user.email, username: user.username, password };
  }

  async function seedUser(input: Partial<Omit<SeededUser, 'id'>> = {}): Promise<SeededUser> {
    const email = input.email ?? 'user@bettertrack.test';
    const username = input.username ?? 'testuser';
    const password = input.password ?? 'user-strong-password-1';
    const passwordHash = await hasher.hash(password);
    const user = await userRepo.create({
      email,
      username,
      passwordHash,
      role: 'user',
      status: 'active',
      mustChangePassword: false,
    });
    return { id: user.id, email: user.email, username: user.username, password };
  }

  async function loginAdmin(admin: SeededAdmin): Promise<ReturnType<typeof request.agent>> {
    const agent = request.agent(app);
    const res = await agent
      .post('/api/v1/auth/login')
      .set('X-Requested-With', 'BetterTrack')
      .send({ identifier: admin.email, password: admin.password });
    // A freshly-seeded admin has no 2FA yet, so password login mints a session in
    // the setup-required state (never a challenge). Enroll TOTP on that session;
    // confirmation invalidates every cookie under the security-transition policy.
    if (res.body?.twoFactorRequired) {
      throw new Error('loginAdmin expects a fresh (un-enrolled) admin');
    }
    const { secret } = twoFactorEnrollResponseSchema.parse(
      (
        await agent
          .post('/api/v1/admin/security/2fa/totp/enroll')
          .set('X-Requested-With', 'BetterTrack')
      ).body,
    );
    await agent
      .post('/api/v1/admin/security/2fa/totp/confirm')
      .set('X-Requested-With', 'BetterTrack')
      .send({ code: generateTotpCode(secret) });

    // The acting device must now perform a fresh explicit password + factor
    // login before it can reach ordinary administrator routes.
    const challenge = twoFactorChallengeResponseSchema.parse(
      (
        await agent
          .post('/api/v1/auth/login')
          .set('X-Requested-With', 'BetterTrack')
          .send({ identifier: admin.email, password: admin.password })
      ).body,
    );
    const verified = await agent
      .post('/api/v1/auth/2fa/verify')
      .set('X-Requested-With', 'BetterTrack')
      .send({ pendingToken: challenge.pendingToken, code: generateTotpCode(secret) });
    if (verified.status !== 200) {
      throw new Error(`loginAdmin failed fresh factor login (${verified.status})`);
    }
    return agent;
  }

  return { app, ctx, db, dispose, seedAdmin, seedUser, loginAdmin };
}
