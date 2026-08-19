import { eq } from 'drizzle-orm';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';

import { withLockedPrivacyModes } from '../data/repositories/paranoidEnforcementRepository';
import * as schema from '../data/schema';
import { createTestApp } from '../testing/createTestApp';

const REAL_DATABASE_URL = process.env.TEST_DATABASE_URL;

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

interface DatabaseLockWait {
  pid: number;
  query: string;
  waitEventType: string | null;
  blockingPids: number[];
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function backendPid(client: ReturnType<typeof postgres>): Promise<number> {
  const [row] = await client<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
  if (!row) throw new Error('Postgres did not return a backend pid');
  return Number(row.pid);
}

async function waitForStarted(
  started: Deferred,
  owner: Promise<unknown>,
  description: string,
): Promise<void> {
  await Promise.race([
    started.promise,
    owner.then(() => {
      throw new Error(`${description} finished before reaching its hold point`);
    }),
  ]);
}

async function waitForDatabaseLock(
  observer: ReturnType<typeof postgres>,
  input: {
    blockedByPid: number;
    description: string;
    queryPattern: RegExp;
    waitingPid?: number;
  },
): Promise<DatabaseLockWait> {
  const deadline = Date.now() + 5_000;
  let observed: DatabaseLockWait[] = [];

  while (Date.now() < deadline) {
    observed = await observer<DatabaseLockWait[]>`
      SELECT
        pid,
        query,
        wait_event_type AS "waitEventType",
        pg_blocking_pids(pid) AS "blockingPids"
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
    `;
    const match = observed.find(
      (row) =>
        (input.waitingPid === undefined || row.pid === input.waitingPid) &&
        row.blockingPids.map(Number).includes(input.blockedByPid) &&
        input.queryPattern.test(row.query),
    );
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(
    `Timed out waiting for ${input.description}; observed ${JSON.stringify(
      observed.map(({ pid, query, waitEventType, blockingPids }) => ({
        pid,
        query,
        waitEventType,
        blockingPids,
      })),
    )}`,
  );
}

/**
 * `TEST_DATABASE_URL` selects the real harness but Vitest still sets
 * `NODE_ENV=test`, which deliberately selects the PGlite-compatible lock
 * emulation. Only this integration suite opts into the production branch.
 */
async function withProductionPrivacyLocks<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}

describe.skipIf(!REAL_DATABASE_URL)('privacy row locks (real Postgres)', () => {
  it('makes FOR KEY SHARE and FOR UPDATE block each other through withLockedPrivacyModes', async () => {
    const harness = await createTestApp();
    const user = await harness.seedUser({
      email: 'privacy-locks@test.dev',
      username: 'privacy_locks',
    });
    const sharedClient = postgres(REAL_DATABASE_URL!, { max: 1 });
    const exclusiveClient = postgres(REAL_DATABASE_URL!, { max: 1 });
    const observer = postgres(REAL_DATABASE_URL!, { max: 1 });
    const sharedDb = drizzlePostgres(sharedClient, { schema });
    const releaseShared = deferred();
    const sharedStarted = deferred();
    const releaseExclusive = deferred();
    const exclusiveStarted = deferred();
    let sharedHolder: Promise<unknown> | undefined;
    let exclusiveWaiter: Promise<unknown> | undefined;
    let exclusiveHolder: Promise<unknown> | undefined;
    let sharedWaiter: Promise<unknown> | undefined;

    try {
      await withProductionPrivacyLocks(async () => {
        const sharedPid = await backendPid(sharedClient);
        const exclusivePid = await backendPid(exclusiveClient);

        // Shared first: the transition's FOR UPDATE must wait for the guarded
        // action to release its KEY SHARE transaction.
        sharedHolder = withLockedPrivacyModes(sharedDb, [user.id], async (modes) => {
          expect(modes.get(user.id)).toBe('normal');
          sharedStarted.resolve();
          await releaseShared.promise;
        });
        await waitForStarted(sharedStarted, sharedHolder, 'KEY SHARE holder');

        let exclusiveAcquired = false;
        exclusiveWaiter = exclusiveClient.begin(async (tx) => {
          await tx`SELECT id FROM users WHERE id = ${user.id} FOR UPDATE`;
          exclusiveAcquired = true;
        });
        const updateWait = await waitForDatabaseLock(observer, {
          blockedByPid: sharedPid,
          description: 'FOR UPDATE to wait behind FOR KEY SHARE',
          queryPattern: /for update/iu,
          waitingPid: exclusivePid,
        });
        expect(updateWait.waitEventType).toBe('Lock');
        expect(exclusiveAcquired).toBe(false);

        releaseShared.resolve();
        await Promise.all([sharedHolder, exclusiveWaiter]);
        expect(exclusiveAcquired).toBe(true);

        // Exclusive first: withLockedPrivacyModes itself must now wait before
        // its callback can observe the row.
        exclusiveHolder = exclusiveClient.begin(async (tx) => {
          await tx`SELECT id FROM users WHERE id = ${user.id} FOR UPDATE`;
          exclusiveStarted.resolve();
          await releaseExclusive.promise;
        });
        await waitForStarted(exclusiveStarted, exclusiveHolder, 'FOR UPDATE holder');

        let sharedAcquired = false;
        sharedWaiter = withLockedPrivacyModes(sharedDb, [user.id], async (modes) => {
          sharedAcquired = true;
          expect(modes.get(user.id)).toBe('normal');
        });
        const keyShareWait = await waitForDatabaseLock(observer, {
          blockedByPid: exclusivePid,
          description: 'FOR KEY SHARE to wait behind FOR UPDATE',
          queryPattern: /for key share/iu,
          waitingPid: sharedPid,
        });
        expect(keyShareWait.waitEventType).toBe('Lock');
        expect(sharedAcquired).toBe(false);

        releaseExclusive.resolve();
        await Promise.all([exclusiveHolder, sharedWaiter]);
        expect(sharedAcquired).toBe(true);
      });
    } finally {
      releaseShared.resolve();
      releaseExclusive.resolve();
      await Promise.allSettled(
        [sharedHolder, exclusiveWaiter, exclusiveHolder, sharedWaiter].filter(
          (promise): promise is Promise<unknown> => promise !== undefined,
        ),
      );
      await Promise.all([sharedClient.end(), exclusiveClient.end(), observer.end()]);
    }
  }, 15_000);

  it('holds a guarded usage write until enable commits, then refuses the write', async () => {
    const harness = await createTestApp();
    const user = await harness.seedUser({
      email: 'privacy-write-race@test.dev',
      username: 'privacy_write_race',
    });
    const enableClient = postgres(REAL_DATABASE_URL!, { max: 1 });
    const observer = postgres(REAL_DATABASE_URL!, { max: 1 });
    const releaseEnable = deferred();
    const enableStarted = deferred();
    let enable: Promise<unknown> | undefined;
    let flush: Promise<void> | undefined;

    harness.ctx.usageAnalytics.capture({
      userId: user.id,
      feature: 'assets',
      assetId: 'guarded-asset-id',
    });

    try {
      await withProductionPrivacyLocks(async () => {
        const enablePid = await backendPid(enableClient);
        enable = enableClient.begin(async (tx) => {
          await tx`SELECT id FROM users WHERE id = ${user.id} FOR UPDATE`;
          await tx`
              UPDATE users
              SET privacy_mode = 'paranoid', paranoid_media_set = ARRAY['server']::text[]
              WHERE id = ${user.id}
            `;
          enableStarted.resolve();
          await releaseEnable.promise;
        });
        await waitForStarted(enableStarted, enable, 'paranoid enable transaction');

        let flushFinished = false;
        flush = harness.ctx.usageAnalytics.flush().finally(() => {
          flushFinished = true;
        });
        const lockWait = await waitForDatabaseLock(observer, {
          blockedByPid: enablePid,
          description: 'the guarded usage write to wait on the enable transaction',
          queryPattern: /for key share/iu,
        });
        expect(lockWait.waitEventType).toBe('Lock');
        expect(flushFinished).toBe(false);

        releaseEnable.resolve();
        await enable;
        await flush;

        expect(
          await harness.db
            .select()
            .from(schema.usageEvents)
            .where(eq(schema.usageEvents.userId, user.id)),
        ).toEqual([]);
      });
    } finally {
      releaseEnable.resolve();
      await Promise.allSettled(
        [enable, flush].filter((promise): promise is Promise<unknown> => promise !== undefined),
      );
      await Promise.all([enableClient.end(), observer.end()]);
    }
  }, 15_000);
});
