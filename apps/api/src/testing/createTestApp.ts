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

import { createApp } from '../app';
import { loadConfig } from '../config/env';
import type { Database } from '../data/db';
import { createUserRepository } from '../data/repositories/userRepository';
import * as schema from '../data/schema';
import { buildContext, type AppContext } from '../http/context';
import type { BackfillScheduler } from '../jobs';
import { createLogger } from '../logger';
import type { MarketDataService } from '../providers';
import type { MailTransport } from '../services/email/transport';
import type { LiveModeServiceOptions } from '../services/liveMode';
import { createPasswordHasher } from '../services/password/passwordHasher';

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

// ---- real-service singletons (module scope, shared across tests in one worker) ----
let pgClient: ReturnType<typeof postgres> | undefined;
let pgDb: Database | undefined;
let pgMigrated = false;
let realRedisClient: Redis | undefined;

async function acquireRealDb(): Promise<Database> {
  if (!pgClient) {
    pgClient = postgres(realDbUrl!, { max: 1 });
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
  seedAdmin(input?: Partial<Omit<SeededAdmin, 'id'>>): Promise<SeededAdmin>;
  seedUser(input?: Partial<Omit<SeededUser, 'id'>>): Promise<SeededUser>;
}

export interface CreateTestAppOptions {
  /** Extra/override env, e.g. SMTP_* to exercise the enabled email channel. */
  env?: Partial<NodeJS.ProcessEnv>;
  /** Fake mail transport injected in place of a real SMTP connection. */
  emailTransport?: MailTransport | null;
  /** Stubbed market-data service, in place of the live Yahoo/manual providers. */
  marketData?: MarketDataService;
  /** Backfill scheduler (e.g. a recording fake) to assert first-touch enqueues. */
  backfill?: BackfillScheduler;
  /** Fast poll cadence / small ring for Live Mode tests (V3-P7b). */
  liveModeOptions?: LiveModeServiceOptions;
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

  const config = loadConfig({ ...BASE_TEST_ENV, ...options.env });
  const logger = createLogger(config);
  const ctx = buildContext({
    config,
    db,
    redis,
    logger,
    emailTransport: options.emailTransport,
    marketData: options.marketData,
    backfill: options.backfill,
    passwordHasher: testPasswordHasher,
    liveModeOptions: options.liveModeOptions,
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

  return { app, ctx, db, seedAdmin, seedUser };
}
