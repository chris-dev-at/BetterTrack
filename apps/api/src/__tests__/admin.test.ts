import { eq } from 'drizzle-orm';
import express from 'express';
import postgres from 'postgres';
import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  adminStatsSchema,
  adminUserListResponseSchema,
  createUserResponseSchema,
  twoFactorChallengeResponseSchema,
  twoFactorEnrollResponseSchema,
} from '@bettertrack/contracts';

import { createUserRepository } from '../data/repositories/userRepository';
import * as schema from '../data/schema';
import {
  BULL_BOARD_BASE_PATH,
  BULL_BOARD_REDACTED_VALUE,
  createBullBoardRouter,
} from '../http/bullBoard';
import { ALL_QUEUE_NAMES, type QueueRegistry } from '../jobs';
import { generateTotpCode } from '../services/auth/totp';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const REAL_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ADMIN_MUTATION_TEST_LOCK = 949967;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

async function loginAgent(app: Application, identifier: string, password: string) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  return agent;
}

async function failLogin(app: Application, identifier: string, times: number) {
  for (let i = 0; i < times; i += 1) {
    await request(app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier, password: 'definitely-the-wrong-password' });
  }
}

async function sessionKeyFor(harness: TestHarness, userId: string): Promise<string> {
  for (const key of await harness.ctx.redis.keys('sess:*')) {
    const raw = await harness.ctx.redis.get(key);
    if (raw && (JSON.parse(raw) as { userId?: string }).userId === userId) return key;
  }
  throw new Error(`No session found for ${userId}`);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface DatabaseLockWait {
  pid: number;
  query: string;
  waitEvent: string | null;
}

async function waitForDatabaseLock(
  observer: ReturnType<typeof postgres>,
  predicate: (row: DatabaseLockWait) => boolean,
  description: string,
): Promise<DatabaseLockWait> {
  const deadline = Date.now() + 4_000;
  let observed: DatabaseLockWait[] = [];

  while (Date.now() < deadline) {
    observed = await observer<DatabaseLockWait[]>`
      SELECT pid, query, wait_event AS "waitEvent"
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
    `;
    const match = observed.find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(
    `Timed out waiting for ${description}; observed ${JSON.stringify(
      observed.map(({ pid, query, waitEvent }) => ({ pid, query, waitEvent })),
    )}`,
  );
}

/**
 * Hold the first admin mutation inside its status/role write, then prove the
 * second transaction is already waiting on the active-admin FOR UPDATE query
 * on another backend. This deliberately runs only in the real-Postgres slice:
 * PGlite has one connection and cannot exercise the row-lock contract.
 */
async function runOverlappingAdminMutations(
  firstMutation: () => Promise<unknown>,
  secondMutation: () => Promise<unknown>,
): Promise<PromiseSettledResult<unknown>[]> {
  if (!REAL_DATABASE_URL) {
    throw new Error('Real Postgres is required for the concurrent admin-mutation regression');
  }

  const controller = postgres(REAL_DATABASE_URL, { max: 1 });
  const observer = postgres(REAL_DATABASE_URL, { max: 1 });
  const lockReady = deferred();
  const releaseLock = deferred();
  let first: Promise<unknown> | undefined;
  let second: Promise<unknown> | undefined;

  await observer.unsafe(`
    CREATE OR REPLACE FUNCTION bt_test_pause_admin_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock(${ADMIN_MUTATION_TEST_LOCK});
      RETURN NEW;
    END;
    $$
  `);
  await observer.unsafe('DROP TRIGGER IF EXISTS bt_test_pause_admin_mutation ON users');
  await observer.unsafe(`
    CREATE TRIGGER bt_test_pause_admin_mutation
    BEFORE UPDATE OF status, role ON users
    FOR EACH ROW
    EXECUTE FUNCTION bt_test_pause_admin_mutation()
  `);

  const lockOwner = controller.begin(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(${ADMIN_MUTATION_TEST_LOCK})`;
    lockReady.resolve();
    await releaseLock.promise;
  });

  try {
    await Promise.race([
      lockReady.promise,
      lockOwner.then(() => {
        throw new Error('Advisory-lock owner exited before acquiring the test lock');
      }),
    ]);

    first = firstMutation();
    const firstWait = await waitForDatabaseLock(
      observer,
      (row) => row.waitEvent === 'advisory' && /update\s+"?users"?/iu.test(row.query),
      'the first admin mutation to pause in its write',
    );

    second = secondMutation();
    const secondWait = await waitForDatabaseLock(
      observer,
      (row) =>
        row.waitEvent !== 'advisory' &&
        /from\s+"?users"?/iu.test(row.query) &&
        /for update/iu.test(row.query),
      'the second admin mutation to wait on the active-admin row lock',
    );
    expect(secondWait.pid).not.toBe(firstWait.pid);

    releaseLock.resolve();
    await lockOwner;
    return await Promise.allSettled([first, second]);
  } finally {
    releaseLock.resolve();
    await lockOwner.catch(() => {});
    await first?.catch(() => {});
    await second?.catch(() => {});
    await observer.unsafe('DROP TRIGGER IF EXISTS bt_test_pause_admin_mutation ON users');
    await observer.unsafe('DROP FUNCTION IF EXISTS bt_test_pause_admin_mutation()');
    await controller.end();
    await observer.end();
  }
}

function bullBoardFixture(): {
  registry: QueueRegistry;
  activeQueue: string;
  pause: ReturnType<typeof vi.fn>;
} {
  const activeQueue = ALL_QUEUE_NAMES[0]!;
  const pause = vi.fn();
  const queues = new Map(
    ALL_QUEUE_NAMES.map((name) => [
      name,
      {
        metaValues: { version: 'bullmq:test' },
        name,
        getJobCounts: async () => ({
          active: 0,
          waiting: name === activeQueue ? 1 : 0,
          'waiting-children': 0,
          prioritized: 0,
          completed: 0,
          failed: 0,
          delayed: 0,
          paused: 0,
        }),
        isPaused: async () => false,
        getGlobalConcurrency: async () => null,
        getJobs: async () =>
          name === activeQueue
            ? [
                {
                  toJSON: () => ({
                    id: 'job-1',
                    name: 'sensitive-job',
                    progress: 0,
                    attemptsMade: 0,
                    timestamp: Date.now(),
                    failedReason: '',
                    stacktrace: [],
                    opts: {},
                    data: { accessToken: 'payload-secret' },
                    returnvalue: { downloadUrl: 'result-secret' },
                  }),
                },
              ]
            : [],
        pause,
      },
    ]),
  );
  return {
    activeQueue,
    pause,
    registry: {
      get: ((name: (typeof ALL_QUEUE_NAMES)[number]) =>
        queues.get(name)!) as unknown as QueueRegistry['get'],
      enqueue: vi.fn() as QueueRegistry['enqueue'],
      close: vi.fn(),
    },
  };
}

/**
 * Number of failed attempts that arms the per-account progressive cooldown: the
 * allowance (`limit`) worth of failures, plus the one that overflows it (§10).
 */
const failsToLock = (harness: TestHarness) => harness.ctx.config.rateLimits.loginAccount.limit + 1;

describe('admin route guard (PROJECTPLAN.md §6.12)', () => {
  it('returns 404 for normal users and anonymous requests — no route disclosure', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);

    const created = await adminAgent
      .post('/api/v1/admin/users')
      .set(...XRW)
      .send({ email: 'normal@test.dev', username: 'normal_user' });
    expect(created.status).toBe(201);

    const userAgent = await loginAgent(harness.app, 'normal@test.dev', created.body.tempPassword);
    // Clear the forced-change flag first; otherwise the global guard 403s
    // before requireAdmin's 404 disguise (covered separately below).
    await userAgent
      .post('/api/v1/auth/change-password')
      .set(...XRW)
      .send({ currentPassword: created.body.tempPassword, newPassword: 'normal-strong-pass-7' });

    const authenticatedUser = await loginAgent(
      harness.app,
      'normal@test.dev',
      'normal-strong-pass-7',
    );
    const asUser = await authenticatedUser.get('/api/v1/admin/users');
    expect(asUser.status).toBe(404);

    const anon = await request(harness.app).get('/api/v1/admin/users');
    expect(anon.status).toBe(404);
  });
});

describe('paranoid account administration (#730)', () => {
  it('keeps normal-account admin serialization byte-for-byte compatible', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    const target = await harness.seedUser({
      email: 'normal-admin-view@bt.test',
      username: 'normal_admin_view',
    });

    const response = await adminAgent.get('/api/v1/admin/users');
    expect(response.status).toBe(200);
    const user = (response.body.users as Array<Record<string, unknown>>).find(
      (candidate) => candidate.id === target.id,
    );
    expect(user).toBeDefined();
    expect(user).not.toHaveProperty('privacyMode');
    expect(user).not.toHaveProperty('paranoid');
  });

  it('returns operational metadata without ciphertext, Drive credentials, or key material', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    const target = await harness.seedUser({
      email: 'paranoid-admin-view@bt.test',
      username: 'paranoid_admin_view',
    });
    const currentBlob = Buffer.from('current-ciphertext-secret');
    const historicalBlob = Buffer.from('historical-ciphertext-secret');
    await harness.db
      .update(schema.users)
      .set({
        privacyMode: 'paranoid',
        paranoidMediaSet: ['server'],
        paranoidDriveAttestedVersion: null,
      })
      .where(eq(schema.users.id, target.id));
    await harness.db.insert(schema.paranoidVaults).values({
      userId: target.id,
      version: 2,
      formatVersion: 1,
      sizeBytes: currentBlob.byteLength,
      blob: currentBlob,
    });
    await harness.db.insert(schema.paranoidVaultHistory).values({
      userId: target.id,
      version: 1,
      formatVersion: 1,
      sizeBytes: historicalBlob.byteLength,
      blob: historicalBlob,
    });

    const response = await adminAgent.get('/api/v1/admin/users');
    expect(response.status).toBe(200);
    const body = adminUserListResponseSchema.parse(response.body);
    const user = body.users.find((candidate) => candidate.id === target.id);
    expect(user).toMatchObject({
      privacyMode: 'paranoid',
      paranoid: {
        mediaSet: ['server'],
        vault: {
          version: 2,
          sizeBytes: currentBlob.byteLength,
        },
        historyCount: 1,
      },
    });
    expect(user?.paranoid?.vault?.updatedAt).toMatch(/Z$/);
    const serialized = JSON.stringify(user);
    expect(serialized).not.toContain('current-ciphertext-secret');
    expect(serialized).not.toContain('historical-ciphertext-secret');
    expect(serialized).not.toMatch(/blob|ciphertext|passphrase|driveToken|recoveryKey/i);

    for (const forbiddenMutation of [
      { privacyMode: 'normal' },
      { passphrase: 'admin-cannot-reset-this' },
      { wipeVault: true },
    ]) {
      const mutation = await adminAgent
        .patch(`/api/v1/admin/users/${target.id}`)
        .set(...XRW)
        .send(forbiddenMutation);
      expect(mutation.status).toBe(400);
    }
    expect(
      await harness.db
        .select({ privacyMode: schema.users.privacyMode })
        .from(schema.users)
        .where(eq(schema.users.id, target.id)),
    ).toEqual([{ privacyMode: 'paranoid' }]);
    expect(
      await harness.db
        .select({ version: schema.paranoidVaults.version })
        .from(schema.paranoidVaults)
        .where(eq(schema.paranoidVaults.userId, target.id)),
    ).toEqual([{ version: 2 }]);
  });
});

describe('Bull Board administrator boundary (#878)', () => {
  it('is read-only and redacts job payloads and results from list/detail data', async () => {
    const { registry, activeQueue, pause } = bullBoardFixture();
    const app = express();
    app.use(BULL_BOARD_BASE_PATH, createBullBoardRouter(registry));

    const listed = await request(app)
      .get(`${BULL_BOARD_BASE_PATH}/api/queues`)
      .query({ activeQueue, status: 'waiting' });
    expect(listed.status).toBe(200);
    const queue = (
      listed.body.queues as Array<{
        name: string;
        readOnlyMode: boolean;
        allowRetries: boolean;
        jobs: Array<{ data: unknown; returnValue: unknown }>;
      }>
    ).find((entry) => entry.name === activeQueue);
    expect(queue).toMatchObject({
      readOnlyMode: true,
      allowRetries: false,
      jobs: [
        {
          data: BULL_BOARD_REDACTED_VALUE,
          returnValue: BULL_BOARD_REDACTED_VALUE,
        },
      ],
    });
    expect(JSON.stringify(listed.body)).not.toContain('payload-secret');
    expect(JSON.stringify(listed.body)).not.toContain('result-secret');

    const mutation = await request(app).put(
      `${BULL_BOARD_BASE_PATH}/api/queues/${encodeURIComponent(activeQueue)}/pause`,
    );
    expect(mutation.status).toBe(405);
    expect(pause).not.toHaveBeenCalled();
  });

  it('applies the admin limiter, role check, and exact-session MFA gate', async () => {
    const local = await createTestApp({ rateLimitsEnabled: true });
    const admin = await local.seedAdmin();
    const bootstrap = await loginAgent(local.app, admin.email, admin.password);

    const setupDenied = await bootstrap.get(BULL_BOARD_BASE_PATH);
    expect(setupDenied.status).toBe(403);
    expect(setupDenied.body.error.code).toBe('ADMIN_2FA_SETUP_REQUIRED');
    expect(await local.ctx.redis.get(`rl:admin:${admin.id}:n`)).toBe('1');

    const assured = await local.loginAdmin(admin);
    expect((await assured.get(BULL_BOARD_BASE_PATH)).status).toBe(503);

    // Removing assurance from this exact current-generation session cannot be
    // rescued by the account's enrolled factor or another session's proof.
    const key = await sessionKeyFor(local, admin.id);
    const raw = await local.ctx.redis.get(key);
    const data = JSON.parse(raw!) as Record<string, unknown>;
    delete data.mfaAssurance;
    const pttl = await local.ctx.redis.pttl(key);
    await local.ctx.redis.set(key, JSON.stringify(data), 'PX', pttl);
    expect((await assured.get(BULL_BOARD_BASE_PATH)).status).toBe(401);

    const user = await local.seedUser();
    const userAgent = await loginAgent(local.app, user.email, user.password);
    expect((await userAgent.get(BULL_BOARD_BASE_PATH)).status).toBe(404);
    expect((await request(local.app).get(BULL_BOARD_BASE_PATH)).status).toBe(404);
  });
});

describe('administrator role-transition generation (#888)', () => {
  it('rejects a pre-promotion session even when eager Redis cleanup fails', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    const target = await harness.seedUser({
      email: 'promoted@test.dev',
      username: 'promoted_user',
    });
    const stale = await loginAgent(harness.app, target.email, target.password);

    const cleanup = vi
      .spyOn(harness.ctx.redis, 'smembers')
      .mockRejectedValueOnce(new Error('simulated Redis cleanup failure'));
    const promoted = await adminAgent
      .patch(`/api/v1/admin/users/${target.id}`)
      .set(...XRW)
      .send({ role: 'admin' });
    cleanup.mockRestore();

    expect(promoted.status).toBe(200);
    const [row] = await harness.db
      .select({ role: schema.users.role, generation: schema.users.securityGeneration })
      .from(schema.users)
      .where(eq(schema.users.id, target.id));
    expect(row).toEqual({ role: 'admin', generation: 1 });

    // The cookie still exists because cleanup failed, but it cannot inherit the
    // newly committed administrator role.
    expect((await stale.get('/api/v1/admin/security/2fa/status')).status).toBe(404);

    // A fresh password proves only the first factor. Promotion never upgrades
    // the pre-existing user session or bypasses explicit administrator MFA.
    const bootstrap = await loginAgent(harness.app, target.email, target.password);
    const setupRequired = await bootstrap.get('/api/v1/admin/users');
    expect(setupRequired.status).toBe(403);
    expect(setupRequired.body.error.code).toBe('ADMIN_2FA_SETUP_REQUIRED');
    const { secret } = twoFactorEnrollResponseSchema.parse(
      (await bootstrap.post('/api/v1/admin/security/2fa/totp/enroll').set(...XRW)).body,
    );
    const confirmed = await bootstrap
      .post('/api/v1/admin/security/2fa/totp/confirm')
      .set(...XRW)
      .send({ code: generateTotpCode(secret) });
    expect(confirmed.status).toBe(200);

    // Enrollment is itself a security transition: it logs the acting device out
    // rather than handing it an assured replacement session. Administrator
    // access returns only after an explicit fresh password + factor login.
    expect((await bootstrap.get('/api/v1/admin/users')).status).toBe(404);

    const assured = request.agent(harness.app);
    const challenge = twoFactorChallengeResponseSchema.parse(
      (
        await assured
          .post('/api/v1/auth/login')
          .set(...XRW)
          .send({ identifier: target.email, password: target.password })
      ).body,
    );
    const verified = await assured
      .post('/api/v1/auth/2fa/verify')
      .set(...XRW)
      .send({ pendingToken: challenge.pendingToken, code: generateTotpCode(secret) });
    expect(verified.status).toBe(200);
    expect((await assured.get('/api/v1/admin/users')).status).toBe(200);
  });

  it('fails closed when promotion commits after the session read but before the user read', async () => {
    const target = await harness.seedUser({
      email: 'interleaved@test.dev',
      username: 'interleaved_user',
    });
    await loginAgent(harness.app, target.email, target.password);
    const sessionKey = await sessionKeyFor(harness, target.id);
    const sessionId = sessionKey.slice('sess:'.length);
    const repo = createUserRepository(harness.db);
    const redisGet = harness.ctx.redis.get.bind(harness.ctx.redis);
    let transitioned = false;

    const get = vi.spyOn(harness.ctx.redis, 'get').mockImplementation(async (...args) => {
      const raw = await redisGet(...args);
      if (!transitioned && args[0] === sessionKey) {
        transitioned = true;
        await repo.setRole(target.id, 'admin');
      }
      return raw;
    });

    expect(await harness.ctx.auth.resolveSession(sessionId)).toBeNull();
    get.mockRestore();
    expect(transitioned).toBe(true);
  });
});

describe('admin creates user → forced password change (PROJECTPLAN.md §6.1)', () => {
  it('issues a temp password and forces a change before normal use', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);

    const created = await adminAgent
      .post('/api/v1/admin/users')
      .set(...XRW)
      .send({ email: 'fresh@test.dev', username: 'fresh_user' });
    const body = createUserResponseSchema.parse(created.body);
    expect(body.user.mustChangePassword).toBe(true);

    const userAgent = await loginAgent(harness.app, 'fresh@test.dev', body.tempPassword);

    // Every call except change-password/logout is blocked.
    const blocked = await userAgent.get('/api/v1/auth/me');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    const changed = await userAgent
      .post('/api/v1/auth/change-password')
      .set(...XRW)
      .send({ currentPassword: body.tempPassword, newPassword: 'fresh-strong-secret-99' });
    expect(changed.status).toBe(200);
    expect(changed.body.mustChangePassword).toBe(false);

    expect((await userAgent.get('/api/v1/auth/me')).status).toBe(401);
    const fresh = await loginAgent(harness.app, 'fresh@test.dev', 'fresh-strong-secret-99');
    const me = await fresh.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
  });

  it('rejects a common/weak new password', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    const created = await adminAgent
      .post('/api/v1/admin/users')
      .set(...XRW)
      .send({ email: 'weak@test.dev', username: 'weak_user' });
    const userAgent = await loginAgent(harness.app, 'weak@test.dev', created.body.tempPassword);

    const res = await userAgent
      .post('/api/v1/auth/change-password')
      .set(...XRW)
      .send({ currentPassword: created.body.tempPassword, newPassword: 'password123' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WEAK_PASSWORD');
  });
});

describe('disable user (PROJECTPLAN.md §6.1, §13)', () => {
  it('kills live sessions instantly and blocks re-login', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);

    const created = await adminAgent
      .post('/api/v1/admin/users')
      .set(...XRW)
      .send({ email: 'doomed@test.dev', username: 'doomed_user' });
    const userId = created.body.user.id as string;
    const tempPassword = created.body.tempPassword as string;

    const userAgent = await loginAgent(harness.app, 'doomed@test.dev', tempPassword);

    const patched = await adminAgent
      .patch(`/api/v1/admin/users/${userId}`)
      .set(...XRW)
      .send({ status: 'disabled' });
    expect(patched.status).toBe(200);

    // Existing session is dead.
    const me = await userAgent.get('/api/v1/auth/me');
    expect(me.status).toBe(401);

    // Re-login with the correct password is rejected with the distinct
    // account-disabled error (revealed only post-verification, §6.1/§16).
    const relogin = await request(harness.app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: 'doomed@test.dev', password: tempPassword });
    expect(relogin.status).toBe(403);
    expect(relogin.body.error.code).toBe('ACCOUNT_DISABLED');
  });

  it('fails closed when credential cleanup fails, then invalidates before re-enable', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    const user = await harness.seedUser({
      email: 'suspend-failure@test.dev',
      username: 'suspend_failure',
    });
    const userAgent = await loginAgent(harness.app, user.email, user.password);
    const createdKey = await userAgent
      .post('/api/v1/settings/api-keys')
      .set(...XRW)
      .send({ name: 'suspend test key', scopes: ['portfolio:read'] });
    expect(createdKey.status).toBe(201);
    const token = createdKey.body.token as string;
    const keyId = createdKey.body.key.id as string;

    const revoke = vi
      .spyOn(harness.ctx.apiKeys, 'revokeAllForUser')
      .mockRejectedValueOnce(new Error('simulated revocation failure'));
    const failed = await adminAgent
      .patch(`/api/v1/admin/users/${user.id}`)
      .set(...XRW)
      .send({ status: 'disabled' });
    expect(failed.status).toBe(500);

    const [suspended] = await harness.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, user.id));
    expect(suspended!.status).toBe('disabled');
    expect(
      (await request(harness.app).get('/api/v1/portfolios').set('Authorization', `Bearer ${token}`))
        .status,
    ).toBe(401);

    revoke.mockRestore();
    const enabled = await adminAgent
      .patch(`/api/v1/admin/users/${user.id}`)
      .set(...XRW)
      .send({ status: 'active' });
    expect(enabled.status).toBe(200);

    const [revokedKey] = await harness.db
      .select()
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.id, keyId));
    expect(revokedKey!.revokedAt).not.toBeNull();
    expect(
      (await request(harness.app).get('/api/v1/portfolios').set('Authorization', `Bearer ${token}`))
        .status,
    ).toBe(401);
  });
});

describe('invite lifecycle (PROJECTPLAN.md §6.1, §6.12)', () => {
  it('creates, validates, accepts, and one-shot-consumes an invite', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);

    const invite = await adminAgent
      .post('/api/v1/admin/invites')
      .set(...XRW)
      .send({ email: 'invitee@test.dev' });
    expect(invite.status).toBe(201);
    const token = (invite.body.inviteUrl as string).split('/invite/')[1];

    const validate = await request(harness.app).get(`/api/v1/auth/invite/${token}`);
    expect(validate.status).toBe(200);
    expect(validate.body).toEqual({ valid: true, email: 'invitee@test.dev' });

    const agent = request.agent(harness.app);
    const accept = await agent
      .post('/api/v1/auth/accept-invite')
      .set(...XRW)
      .send({ token, username: 'invitee', password: 'invitee-strong-pass-1' });
    expect(accept.status).toBe(201);
    expect(accept.body.email).toBe('invitee@test.dev');
    expect(accept.body.status).toBe('active');

    const me = await agent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);

    // Token is single-use.
    const reuse = await request(harness.app).get(`/api/v1/auth/invite/${token}`);
    expect(reuse.body.valid).toBe(false);
  });
});

describe('audit log (PROJECTPLAN.md §5.5, §10)', () => {
  it('records login.success, admin.login and user.created', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    await adminAgent
      .post('/api/v1/admin/users')
      .set(...XRW)
      .send({ email: 'audited@test.dev', username: 'audited_user' });

    const audit = await adminAgent.get('/api/v1/admin/audit');
    expect(audit.status).toBe(200);
    const actions = (audit.body.entries as Array<{ action: string }>).map((e) => e.action);
    expect(actions).toContain('login.success');
    expect(actions).toContain('admin.login');
    expect(actions).toContain('user.created');
  });

  it('exposes overview stats', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    const stats = await adminAgent.get('/api/v1/admin/stats');
    expect(stats.status).toBe(200);
    const parsed = adminStatsSchema.parse(stats.body);
    expect(parsed.userCount).toBeGreaterThanOrEqual(1);
  });
});

describe('forced-password-change guard is global (PROJECTPLAN.md §6.1)', () => {
  it('403s a mustChange user on every protected route, including admin routes', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    // Make the new account an admin so requireAdmin would otherwise let it in —
    // proving the password-change guard fires first.
    const created = await adminAgent
      .post('/api/v1/admin/users')
      .set(...XRW)
      .send({ email: 'pending@test.dev', username: 'pending_admin', role: 'admin' });
    const { tempPassword } = createUserResponseSchema.parse(created.body);

    const userAgent = await loginAgent(harness.app, 'pending@test.dev', tempPassword);

    for (const path of ['/api/v1/auth/me', '/api/v1/admin/users', '/api/v1/admin/stats']) {
      const res = await userAgent.get(path);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    }

    // change-password and logout stay reachable.
    const logout = await userAgent.post('/api/v1/auth/logout').set(...XRW);
    expect(logout.status).toBe(200);
  });
});

describe('admin recovery clears login throttle (PROJECTPLAN.md §6.1, §6.12)', () => {
  it('password reset clears lockout so the new temp password works immediately', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    const created = await adminAgent
      .post('/api/v1/admin/users')
      .set(...XRW)
      .send({ email: 'locked@test.dev', username: 'locked_user' });
    const userId = created.body.user.id as string;

    // Enough consecutive bad passwords → the account is cooling down.
    await failLogin(harness.app, 'locked@test.dev', failsToLock(harness));
    const whileLocked = await request(harness.app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: 'locked@test.dev', password: created.body.tempPassword });
    expect(whileLocked.status).toBe(401);

    const reset = await adminAgent.post(`/api/v1/admin/users/${userId}/reset-password`).set(...XRW);
    expect(reset.status).toBe(200);

    const afterReset = await request(harness.app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: 'locked@test.dev', password: reset.body.tempPassword });
    expect(afterReset.status).toBe(200);
  });

  it('re-enabling a disabled user clears lockout state', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    const created = await adminAgent
      .post('/api/v1/admin/users')
      .set(...XRW)
      .send({ email: 'reenable@test.dev', username: 'reenable_user' });
    const userId = created.body.user.id as string;
    const tempPassword = created.body.tempPassword as string;

    await failLogin(harness.app, 'reenable@test.dev', failsToLock(harness));

    await adminAgent
      .patch(`/api/v1/admin/users/${userId}`)
      .set(...XRW)
      .send({ status: 'disabled' });
    const reenabled = await adminAgent
      .patch(`/api/v1/admin/users/${userId}`)
      .set(...XRW)
      .send({ status: 'active' });
    expect(reenabled.status).toBe(200);

    // Lockout was cleared by the re-enable, so the temp password works now.
    const login = await request(harness.app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: 'reenable@test.dev', password: tempPassword });
    expect(login.status).toBe(200);
  });
});

describe('throttled login failures are audited (PROJECTPLAN.md §10)', () => {
  it('records a login.fail with reason locked once the account cools down', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    const created = await adminAgent
      .post('/api/v1/admin/users')
      .set(...XRW)
      .send({ email: 'throttled@test.dev', username: 'throttled_user' });

    // Enough failures to arm the progressive cooldown, then one more attempt —
    // even with the correct password — is rejected while the account is cooling.
    await failLogin(harness.app, 'throttled@test.dev', failsToLock(harness));
    const res = await request(harness.app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: 'throttled@test.dev', password: created.body.tempPassword });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');

    const audit = await adminAgent.get('/api/v1/admin/audit');
    const locked = (
      audit.body.entries as Array<{ action: string; meta: { reason?: string } | null }>
    ).filter((e) => e.action === 'login.fail' && e.meta?.reason === 'locked');
    expect(locked.length).toBeGreaterThanOrEqual(1);
  });
});

describe('admin self-action and last-admin guards (PROJECTPLAN.md §6.12)', () => {
  it('blocks an admin from disabling, demoting, or deleting their own account', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);

    const disableSelf = await adminAgent
      .patch(`/api/v1/admin/users/${admin.id}`)
      .set(...XRW)
      .send({ status: 'disabled' });
    expect(disableSelf.status).toBe(400);
    expect(disableSelf.body.error.code).toBe('SELF_ACTION');

    const demoteSelf = await adminAgent
      .patch(`/api/v1/admin/users/${admin.id}`)
      .set(...XRW)
      .send({ role: 'user' });
    expect(demoteSelf.status).toBe(400);
    expect(demoteSelf.body.error.code).toBe('SELF_ACTION');

    const deleteSelf = await adminAgent
      .delete(`/api/v1/admin/users/${admin.id}`)
      .set(...XRW)
      .send({ confirmUsername: admin.username });
    expect(deleteSelf.status).toBe(400);
    expect(deleteSelf.body.error.code).toBe('SELF_ACTION');
  });

  it('allows demoting a second admin once more than one exists', async () => {
    const admin = await harness.seedAdmin();
    const second = await harness.seedAdmin({
      email: 'second-admin@test.dev',
      username: 'second_admin',
      password: 'second-admin-strong-1',
    });
    const adminAgent = await harness.loginAdmin(admin);

    const demote = await adminAgent
      .patch(`/api/v1/admin/users/${second.id}`)
      .set(...XRW)
      .send({ role: 'user' });
    expect(demote.status).toBe(200);
    expect(demote.body.role).toBe('user');
  });

  it.skipIf(!REAL_DATABASE_URL).each(['disable', 'demote', 'delete'] as const)(
    'serializes concurrent %s requests so one active administrator remains',
    async (operation) => {
      const first = await harness.seedAdmin();
      const second = await harness.seedAdmin({
        email: 'concurrent-admin@test.dev',
        username: 'concurrent_admin',
        password: 'concurrent-admin-strong-1',
      });

      const mutate = (target: typeof first, actor: typeof second): Promise<unknown> => {
        switch (operation) {
          case 'disable':
            return harness.ctx.admin.updateUser(
              target.id,
              { status: 'disabled' },
              { id: actor.id },
            );
          case 'demote':
            return harness.ctx.admin.updateUser(target.id, { role: 'user' }, { id: actor.id });
          case 'delete':
            return harness.ctx.admin.deleteUser(target.id, target.username, { id: actor.id });
        }
      };

      const results = await runOverlappingAdminMutations(
        () => mutate(first, second),
        () => mutate(second, first),
      );
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected');
      expect(rejected).toBeDefined();
      if (!rejected || rejected.status !== 'rejected') {
        throw new Error('Expected one concurrent administrator mutation to fail');
      }
      expect(rejected.reason).toMatchObject({
        statusCode: 400,
        code: 'LAST_ADMIN',
        message: 'Cannot remove the last active administrator.',
      });

      const users = createUserRepository(harness.db);
      expect(await users.countActiveAdmins()).toBe(1);
    },
  );
});

describe('edit username/email (PROJECTPLAN.md §6.12, §13.2)', () => {
  async function seedUser(
    adminAgent: ReturnType<typeof request.agent>,
    email: string,
    username: string,
  ) {
    const created = await adminAgent
      .post('/api/v1/admin/users')
      .set(...XRW)
      .send({ email, username });
    return created.body.user.id as string;
  }

  it('persists a username change and writes an audit entry', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    const userId = await seedUser(adminAgent, 'rename@test.dev', 'rename_me');

    const patched = await adminAgent
      .patch(`/api/v1/admin/users/${userId}`)
      .set(...XRW)
      .send({ username: 'renamed_user' });
    expect(patched.status).toBe(200);
    expect(patched.body.username).toBe('renamed_user');

    const audit = await adminAgent.get(`/api/v1/admin/users/${userId}/audit`);
    expect(audit.status).toBe(200);
    const actions = (audit.body.entries as Array<{ action: string }>).map((e) => e.action);
    expect(actions).toContain('user.username_changed');
  });

  it('persists an email change (normalised) and writes an audit entry', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    const userId = await seedUser(adminAgent, 'oldmail@test.dev', 'mail_user');

    const patched = await adminAgent
      .patch(`/api/v1/admin/users/${userId}`)
      .set(...XRW)
      .send({ email: 'NewMail@Test.dev' });
    expect(patched.status).toBe(200);
    expect(patched.body.email).toBe('newmail@test.dev');

    const audit = await adminAgent.get(`/api/v1/admin/users/${userId}/audit`);
    const actions = (audit.body.entries as Array<{ action: string }>).map((e) => e.action);
    expect(actions).toContain('user.email_changed');
  });

  it('rejects a duplicate username or email cleanly (409)', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    await seedUser(adminAgent, 'first@test.dev', 'first_user');
    const secondId = await seedUser(adminAgent, 'second@test.dev', 'second_user');

    const dupUsername = await adminAgent
      .patch(`/api/v1/admin/users/${secondId}`)
      .set(...XRW)
      .send({ username: 'first_user' });
    expect(dupUsername.status).toBe(409);
    expect(dupUsername.body.error.code).toBe('USERNAME_TAKEN');

    const dupEmail = await adminAgent
      .patch(`/api/v1/admin/users/${secondId}`)
      .set(...XRW)
      .send({ email: 'first@test.dev' });
    expect(dupEmail.status).toBe(409);
    expect(dupEmail.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('rolls back an earlier role change when later email validation fails', async () => {
    const admin = await harness.seedAdmin();
    const target = await harness.seedAdmin({
      email: 'atomic-admin@test.dev',
      username: 'atomic_admin',
      password: 'atomic-admin-strong-1',
    });
    const existing = await harness.seedUser({
      email: 'existing-email@test.dev',
      username: 'existing_email',
    });
    const adminAgent = await harness.loginAdmin(admin);
    const users = createUserRepository(harness.db);
    const before = await users.findById(target.id);

    const patched = await adminAgent
      .patch(`/api/v1/admin/users/${target.id}`)
      .set(...XRW)
      .send({ role: 'user', email: existing.email });
    expect(patched.status).toBe(409);
    expect(patched.body.error.code).toBe('EMAIL_TAKEN');

    const after = await users.findById(target.id);
    expect(after?.role).toBe('admin');
    expect(after?.email).toBe(target.email);
    expect(after?.securityGeneration).toBe(before?.securityGeneration);

    const audit = await adminAgent.get(`/api/v1/admin/users/${target.id}/audit`);
    const actions = (audit.body.entries as Array<{ action: string }>).map((entry) => entry.action);
    expect(actions).not.toContain('user.role_changed');
  });
});

describe('bulk user actions (PROJECTPLAN.md §6.12, §13.2)', () => {
  it('bulk-disables a set of users and kills their sessions', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);

    const a = await adminAgent
      .post('/api/v1/admin/users')
      .set(...XRW)
      .send({ email: 'bulk-a@test.dev', username: 'bulk_a' });
    const b = await adminAgent
      .post('/api/v1/admin/users')
      .set(...XRW)
      .send({ email: 'bulk-b@test.dev', username: 'bulk_b' });
    const idA = a.body.user.id as string;
    const idB = b.body.user.id as string;

    const bulk = await adminAgent
      .post('/api/v1/admin/users/bulk')
      .set(...XRW)
      .send({ action: 'disable', userIds: [idA, idB] });
    expect(bulk.status).toBe(200);
    expect(bulk.body).toEqual({ action: 'disable', disabled: 2, skipped: 0 });

    const users = await adminAgent.get('/api/v1/admin/users');
    const byId = new Map(
      (users.body.users as Array<{ id: string; status: string }>).map((u) => [u.id, u.status]),
    );
    expect(byId.get(idA)).toBe('disabled');
    expect(byId.get(idB)).toBe('disabled');
  });

  it('skips the actor and already-disabled users instead of failing the batch', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    const created = await adminAgent
      .post('/api/v1/admin/users')
      .set(...XRW)
      .send({ email: 'skip@test.dev', username: 'skip_user' });
    const userId = created.body.user.id as string;

    const bulk = await adminAgent
      .post('/api/v1/admin/users/bulk')
      .set(...XRW)
      .send({ action: 'disable', userIds: [userId, admin.id, userId] });
    expect(bulk.status).toBe(200);
    // The user disabled once; the actor and the duplicate id skipped.
    expect(bulk.body.disabled).toBe(1);
    expect(bulk.body.skipped).toBe(1);
  });

  it('uses the last-admin guard when a stale actor is outside the batch', async () => {
    const first = await harness.seedAdmin();
    const second = await harness.seedAdmin({
      email: 'bulk-admin@test.dev',
      username: 'bulk_admin',
      password: 'bulk-admin-strong-1',
    });
    const staleActor = await harness.seedAdmin({
      email: 'stale-bulk-actor@test.dev',
      username: 'stale_bulk_actor',
      password: 'stale-bulk-actor-strong-1',
    });
    const users = createUserRepository(harness.db);
    await users.setStatus(staleActor.id, 'disabled');

    // Calling the service boundary with a persisted but no-longer-active actor
    // removes the HTTP route's self-skip from the equation. The batch itself
    // must disable one target and skip the last active administrator.
    const bulk = await harness.ctx.admin.bulkUserAction(
      { action: 'disable', userIds: [first.id, second.id] },
      { id: staleActor.id },
    );
    expect(bulk).toEqual({ action: 'disable', disabled: 1, skipped: 1 });

    expect(await users.countActiveAdmins()).toBe(1);
    const statuses = await Promise.all([
      users.findById(first.id).then((user) => user?.status),
      users.findById(second.id).then((user) => user?.status),
    ]);
    expect(statuses.sort()).toEqual(['active', 'disabled']);
  });
});

describe('per-user chat ban (PROJECTPLAN.md §13.4 V4-P0d)', () => {
  it('bans and unbans a user and audits both, without touching sessions', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    const created = await adminAgent
      .post('/api/v1/admin/users')
      .set(...XRW)
      .send({ email: 'chatty@test.dev', username: 'chatty_user' });
    const userId = created.body.user.id as string;
    expect(created.body.user.chatBanned).toBe(false);

    const banned = await adminAgent
      .patch(`/api/v1/admin/users/${userId}`)
      .set(...XRW)
      .send({ chatBanned: true });
    expect(banned.status).toBe(200);
    expect(banned.body.chatBanned).toBe(true);

    const unbanned = await adminAgent
      .patch(`/api/v1/admin/users/${userId}`)
      .set(...XRW)
      .send({ chatBanned: false });
    expect(unbanned.status).toBe(200);
    expect(unbanned.body.chatBanned).toBe(false);

    const audit = await adminAgent.get(`/api/v1/admin/users/${userId}/audit`);
    const actions = (audit.body.entries as Array<{ action: string }>).map((e) => e.action);
    expect(actions).toContain('user.chat_banned');
    expect(actions).toContain('user.chat_unbanned');
  });
});

describe('account defaults panel (PROJECTPLAN.md §13.4 V4-P0d)', () => {
  it('returns the lean defaults, persists a change, and audits it', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);

    const initial = await adminAgent.get('/api/v1/admin/account-defaults');
    expect(initial.status).toBe(200);
    expect(initial.body.chatEnabled).toBe(true);
    expect(initial.body.defaultPortfolioVisibility).toBe('private');
    expect(initial.body.developerStatus).toBe(false);
    // Pre-seeded with the V4-P0c lean email default: email off for a non-account type…
    expect(initial.body.notificationMatrix['friend.request'].email).toBe(false);
    // …and on for the account/security category.
    expect(initial.body.notificationMatrix['account.temp_password'].email).toBe(true);

    const patched = await adminAgent
      .patch('/api/v1/admin/account-defaults')
      .set(...XRW)
      .send({ chatEnabled: false, developerStatus: true, defaultPortfolioVisibility: 'friends' });
    expect(patched.status).toBe(200);
    expect(patched.body.chatEnabled).toBe(false);
    expect(patched.body.developerStatus).toBe(true);
    expect(patched.body.defaultPortfolioVisibility).toBe('friends');

    // Persisted across reads.
    const reread = await adminAgent.get('/api/v1/admin/account-defaults');
    expect(reread.body.chatEnabled).toBe(false);
    expect(reread.body.developerStatus).toBe(true);

    const audit = await adminAgent.get('/api/v1/admin/audit');
    const actions = (audit.body.entries as Array<{ action: string }>).map((e) => e.action);
    expect(actions).toContain('account_defaults.updated');
  });
});
