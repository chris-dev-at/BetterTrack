import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';

import { createApp } from '../app';
import { loadConfig } from '../config/env';
import type { Database } from '../data/db';
import { createUserRepository } from '../data/repositories/userRepository';
import * as schema from '../data/schema';
import { buildContext, type AppContext } from '../http/context';
import { createLogger } from '../logger';
import type { MailTransport } from '../services/email/transport';
import { createPasswordHasher } from '../services/password/passwordHasher';

/**
 * In-process integration harness: real Postgres via PGlite (WASM) + in-memory
 * Redis via ioredis-mock. Runs the actual generated migrations, so tests
 * exercise the same SQL and the same app the server boots — no Docker required.
 * (Deviation from PROJECTPLAN.md §12's testcontainers, noted in the PR.)
 */
const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

const TEST_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://test',
  REDIS_URL: 'redis://test',
  SESSION_SECRET: 'test-session-secret-please-change-0123456789',
  APP_ORIGIN: 'http://localhost:5173',
} satisfies NodeJS.ProcessEnv;

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
}

export async function createTestApp(options: CreateTestAppOptions = {}): Promise<TestHarness> {
  const client = new PGlite();
  const rawDb = drizzle(client, { schema });
  await migrate(rawDb, { migrationsFolder });
  const db = rawDb as unknown as Database;

  const redis = new RedisMock() as unknown as Redis;
  const config = loadConfig({ ...TEST_ENV, ...options.env });
  const logger = createLogger(config);
  const ctx = buildContext({ config, db, redis, logger, emailTransport: options.emailTransport });
  const app = createApp(ctx);

  const userRepo = createUserRepository(db);
  const hasher = createPasswordHasher();

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
