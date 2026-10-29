import { randomBytes, randomUUID } from 'node:crypto';

import { OAUTH_REFRESH_TOKEN_PREFIX, type OAuthTokenResponse } from '@bettertrack/contracts';
import { eq } from 'drizzle-orm';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';

import type { Database } from '../data/db';
import { createAuditRepository } from '../data/repositories/auditRepository';
import {
  createOAuthRepository,
  type OAuthRefreshTokenRotation,
  type OAuthRepository,
} from '../data/repositories/oauthRepository';
import * as schema from '../data/schema';
import { AuditAction, createAuditService } from '../services/audit/auditService';
import { hashToken } from '../services/crypto/tokens';
import { createOAuthService } from '../services/oauth/oauthService';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * The refresh grace window's concurrent-loser path, on the engine it depends on.
 *
 * `rotateRefreshToken` relies on READ COMMITTED semantics that PGlite cannot
 * show: it has ONE session, so two "concurrent" transactions run one after the
 * other and the loser's `UPDATE … WHERE consumed_at IS NULL` never waits on a
 * held row lock. On real Postgres the loser's UPDATE blocks on the winner's
 * row lock, re-checks the newest row version after the winner commits
 * (EvalPlanQual), comes back empty, and its NEXT statement — a fresh snapshot —
 * must see the winner's successor link and envelope. If the winner rolls back
 * instead, the loser's UPDATE succeeds and it becomes the rotator.
 *
 * Every client here is a separate `postgres(url, { max: 1 })` session (the
 * `paranoidPrivacyLocks` / `usageAnalytics` pattern) and the lock wait is
 * observed in `pg_stat_activity`, not inferred from timing. Runs only in CI's
 * real-Postgres integration job (`vitest.config.integration.ts`); skips
 * without `TEST_DATABASE_URL`.
 */

const REAL_DATABASE_URL = process.env.TEST_DATABASE_URL;
const DAY_MS = 24 * 60 * 60 * 1000;

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
  input: { blockedByPid: number; waitingPid: number; description: string; queryPattern: RegExp },
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
        row.pid === input.waitingPid &&
        row.blockingPids.map(Number).includes(input.blockedByPid) &&
        input.queryPattern.test(row.query),
    );
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Timed out waiting for ${input.description}; observed ${JSON.stringify(observed)}`,
  );
}

/** A user, a public client and an active grant — the minimum a refresh needs. */
async function seedGrant(harness: TestHarness) {
  const tag = randomBytes(4).toString('hex');
  const user = await harness.seedUser({
    email: `refresh-race-${tag}@test.dev`,
    username: `refreshrace${tag}`,
  });
  const [client] = await harness.db
    .insert(schema.oauthClients)
    .values({
      userId: user.id,
      clientId: `btc_refresh_race_${tag}`,
      name: 'Refresh race',
      redirectUris: ['https://app.example/callback'],
      scopes: ['portfolio:read'],
      isPublic: true,
    })
    .returning();
  const [grant] = await harness.db
    .insert(schema.oauthGrants)
    .values({ clientId: client!.id, userId: user.id, scopes: ['portfolio:read'] })
    .returning();
  return { client: client!, grant: grant! };
}

/** An unconsumed refresh token on `grantId`, returned with its plaintext. */
async function seedRefreshToken(harness: TestHarness, grantId: string) {
  const token = `${OAUTH_REFRESH_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const [row] = await harness.db
    .insert(schema.oauthRefreshTokens)
    .values({ grantId, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + DAY_MS) })
    .returning();
  return { token, id: row!.id };
}

/** A rotation input whose pair is never meant to be observed, only written or not. */
function rotationInput(
  tokenId: string,
  grantId: string,
  rotatedAt: Date,
  sealSuccessor: (ids: { successorId: string }) => string,
) {
  return {
    tokenId,
    grantId,
    rotatedAt,
    accessToken: {
      tokenHash: hashToken(`bto_loser_${randomUUID()}`),
      scopes: ['portfolio:read'],
      expiresAt: new Date(rotatedAt.getTime() + 3_600_000),
    },
    refreshToken: {
      tokenHash: hashToken(`btr_loser_${randomUUID()}`),
      expiresAt: new Date(rotatedAt.getTime() + DAY_MS),
    },
    sealSuccessor,
  };
}

async function grantRevokedAt(harness: TestHarness, grantId: string) {
  const [row] = await harness.db
    .select({ revokedAt: schema.oauthGrants.revokedAt })
    .from(schema.oauthGrants)
    .where(eq(schema.oauthGrants.id, grantId));
  return row!.revokedAt;
}

async function tokenRowCounts(harness: TestHarness, grantId: string) {
  const refresh = await harness.db
    .select({ id: schema.oauthRefreshTokens.id })
    .from(schema.oauthRefreshTokens)
    .where(eq(schema.oauthRefreshTokens.grantId, grantId));
  const access = await harness.db
    .select({ id: schema.oauthAccessTokens.id })
    .from(schema.oauthAccessTokens)
    .where(eq(schema.oauthAccessTokens.grantId, grantId));
  return { refresh: refresh.length, access: access.length };
}

class WinnerRollback extends Error {}

describe.skipIf(!REAL_DATABASE_URL)('OAuth refresh rotation races (real Postgres)', () => {
  it("a loser that waits on the winner's row lock sees the committed successor and returns 'replayed'", async () => {
    const harness = await createTestApp();
    const { grant } = await seedGrant(harness);
    const presented = await seedRefreshToken(harness, grant.id);
    const winner = postgres(REAL_DATABASE_URL!, { max: 1 });
    const loser = postgres(REAL_DATABASE_URL!, { max: 1 });
    const observer = postgres(REAL_DATABASE_URL!, { max: 1 });
    const loserRepo = createOAuthRepository(drizzlePostgres(loser, { schema }) as Database);
    const claimed = deferred();
    const release = deferred();
    let winnerTx: Promise<unknown> | undefined;
    let loserRotation: Promise<OAuthRefreshTokenRotation> | undefined;

    try {
      const winnerPid = await backendPid(winner);
      const loserPid = await backendPid(loser);
      const rotatedAt = new Date();
      const successorId = randomUUID();

      // The winner performs the real rotation's writes, in the real order, and
      // holds its transaction open right after the atomic claim.
      winnerTx = winner.begin(async (tx) => {
        const rows = await tx`
          UPDATE oauth_refresh_tokens SET consumed_at = ${rotatedAt}
          WHERE id = ${presented.id} AND consumed_at IS NULL
          RETURNING id
        `;
        expect(rows).toHaveLength(1);
        claimed.resolve();
        await release.promise;
        await tx`
          INSERT INTO oauth_access_tokens (id, grant_id, token_hash, expires_at)
          VALUES (${randomUUID()}, ${grant.id}, ${hashToken(`bto_${randomUUID()}`)},
                  ${new Date(rotatedAt.getTime() + 3_600_000)})
        `;
        await tx`
          INSERT INTO oauth_refresh_tokens (id, grant_id, token_hash, expires_at)
          VALUES (${successorId}, ${grant.id}, ${hashToken(`btr_${randomUUID()}`)},
                  ${new Date(rotatedAt.getTime() + DAY_MS)})
        `;
        await tx`
          UPDATE oauth_refresh_tokens
          SET successor_id = ${successorId}, successor_envelope = ${'sealed-by-winner'}
          WHERE id = ${presented.id}
        `;
      });
      await waitForStarted(claimed, winnerTx, 'the winner claim');

      loserRotation = loserRepo.rotateRefreshToken(
        rotationInput(presented.id, grant.id, new Date(), () => {
          throw new Error('the loser must never seal a pair');
        }),
      );
      const wait = await waitForDatabaseLock(observer, {
        blockedByPid: winnerPid,
        waitingPid: loserPid,
        description: "the loser's claim to wait on the winner's row lock",
        queryPattern: /update "oauth_refresh_tokens"/iu,
      });
      expect(wait.waitEventType).toBe('Lock');

      release.resolve();
      await winnerTx;
      const result = await loserRotation;

      expect(result.outcome).toBe('replayed');
      if (result.outcome !== 'replayed') throw new Error('expected the loser to replay');
      expect(result.current?.token.consumedAt).toEqual(rotatedAt);
      expect(result.current?.token.successorId).toBe(successorId);
      expect(result.current?.token.successorEnvelope).toBe('sealed-by-winner');
      expect(result.current?.successor?.id).toBe(successorId);
      expect(result.current?.successor?.consumedAt).toBeNull();
      // Nothing revoked, nothing of the loser's written.
      expect(await grantRevokedAt(harness, grant.id)).toBeNull();
      expect(await tokenRowCounts(harness, grant.id)).toEqual({ refresh: 2, access: 1 });
    } finally {
      release.resolve();
      await Promise.allSettled(
        [winnerTx, loserRotation].filter((p): p is Promise<unknown> => p !== undefined),
      );
      await Promise.all([winner.end(), loser.end(), observer.end()]);
      await harness.dispose();
    }
  }, 20_000);

  it('a loser whose winner rolls back becomes the rotator', async () => {
    const harness = await createTestApp();
    const { grant } = await seedGrant(harness);
    const presented = await seedRefreshToken(harness, grant.id);
    const winner = postgres(REAL_DATABASE_URL!, { max: 1 });
    const loser = postgres(REAL_DATABASE_URL!, { max: 1 });
    const observer = postgres(REAL_DATABASE_URL!, { max: 1 });
    const loserRepo = createOAuthRepository(drizzlePostgres(loser, { schema }) as Database);
    const claimed = deferred();
    const release = deferred();
    let winnerTx: Promise<unknown> | undefined;
    let loserRotation: Promise<OAuthRefreshTokenRotation> | undefined;

    try {
      const winnerPid = await backendPid(winner);
      const loserPid = await backendPid(loser);

      winnerTx = winner.begin(async (tx) => {
        await tx`
          UPDATE oauth_refresh_tokens SET consumed_at = ${new Date()}
          WHERE id = ${presented.id} AND consumed_at IS NULL
        `;
        claimed.resolve();
        await release.promise;
        throw new WinnerRollback('the winner aborts after claiming');
      });
      await waitForStarted(claimed, winnerTx, 'the winner claim');

      const loserRotatedAt = new Date();
      loserRotation = loserRepo.rotateRefreshToken(
        rotationInput(
          presented.id,
          grant.id,
          loserRotatedAt,
          ({ successorId }) => `sealed-by-loser:${successorId}`,
        ),
      );
      await waitForDatabaseLock(observer, {
        blockedByPid: winnerPid,
        waitingPid: loserPid,
        description: "the loser's claim to wait on the winner's row lock",
        queryPattern: /update "oauth_refresh_tokens"/iu,
      });

      release.resolve();
      await expect(winnerTx).rejects.toBeInstanceOf(WinnerRollback);
      expect(await loserRotation).toEqual({ outcome: 'rotated' });

      const [row] = await harness.db
        .select()
        .from(schema.oauthRefreshTokens)
        .where(eq(schema.oauthRefreshTokens.id, presented.id));
      expect(row?.consumedAt).toEqual(loserRotatedAt);
      expect(row?.successorId).toBeTruthy();
      expect(row?.successorEnvelope).toBe(`sealed-by-loser:${row?.successorId}`);
      expect(await grantRevokedAt(harness, grant.id)).toBeNull();
      expect(await tokenRowCounts(harness, grant.id)).toEqual({ refresh: 2, access: 1 });
    } finally {
      release.resolve();
      await Promise.allSettled(
        [winnerTx, loserRotation].filter((p): p is Promise<unknown> => p !== undefined),
      );
      await Promise.all([winner.end(), loser.end(), observer.end()]);
      await harness.dispose();
    }
  }, 20_000);

  it('two services on separate pools racing the same refresh token 20 times always get one pair and never revoke', async () => {
    const harness = await createTestApp();
    const { client, grant } = await seedGrant(harness);
    const presented = await seedRefreshToken(harness, grant.id);
    const poolA = postgres(REAL_DATABASE_URL!, { max: 2 });
    const poolB = postgres(REAL_DATABASE_URL!, { max: 2 });
    const rounds = 20;
    // One shared, injected clock so both answers are byte-identical (the
    // loser's `expires_in` is recomputed at ITS instant); it advances a second
    // per round, which keeps every round well inside the grace window.
    let clockMs = Date.now();
    const now = () => new Date(clockMs);
    // Both callers must read the token while it is still current before either
    // rotates — otherwise the second one is a sequential replay, not a race.
    let arrivals = 0;
    let bothRead = deferred();
    const raceBarrier = (base: OAuthRepository): OAuthRepository => ({
      ...base,
      async findRefreshTokenByHash(tokenHash: string, at: Date) {
        const found = await base.findRefreshTokenByHash(tokenHash, at);
        arrivals += 1;
        if (arrivals === 2) bothRead.resolve();
        await bothRead.promise;
        return found;
      },
    });
    const serviceOn = (db: Database) =>
      createOAuthService({
        repo: raceBarrier(createOAuthRepository(db)),
        audit: createAuditService(createAuditRepository(db)),
        redis: harness.ctx.redis,
        recordEncryption: harness.ctx.config.recordEncryption,
        now,
      });
    const serviceA = serviceOn(drizzlePostgres(poolA, { schema }) as Database);
    const serviceB = serviceOn(drizzlePostgres(poolB, { schema }) as Database);

    try {
      let current = presented.token;
      let last: OAuthTokenResponse | undefined;
      for (let round = 0; round < rounds; round += 1) {
        arrivals = 0;
        bothRead = deferred();
        clockMs += 1_000;
        const body = {
          grant_type: 'refresh_token' as const,
          refresh_token: current,
          client_id: client.clientId,
        };
        const [a, b] = await Promise.all([
          serviceA.exchangeToken({ body }),
          serviceB.exchangeToken({ body }),
        ]);
        expect(b, `round ${round}`).toEqual(a);
        expect(a.refresh_token).not.toBe(current);
        expect(await grantRevokedAt(harness, grant.id), `round ${round}`).toBeNull();
        current = a.refresh_token;
        last = a;
      }

      const audits = await harness.db
        .select({ action: schema.auditLog.action, meta: schema.auditLog.meta })
        .from(schema.auditLog)
        .where(eq(schema.auditLog.targetId, grant.id));
      expect(audits.filter((row) => row.action === AuditAction.OAuthTokenRefreshed)).toHaveLength(
        rounds,
      );
      const replays = audits.filter(
        (row) => row.action === AuditAction.OAuthTokenRefreshReplayedInGrace,
      );
      expect(replays).toHaveLength(rounds);
      expect(replays.every((row) => (row.meta as { via?: string }).via === 'concurrent')).toBe(
        true,
      );
      // One rotation per round was written; every loser's own pair was dropped.
      expect(await tokenRowCounts(harness, grant.id)).toEqual({
        refresh: rounds + 1,
        access: rounds,
      });
      expect(await serviceA.authenticateToken(last!.access_token)).not.toBeNull();
    } finally {
      await Promise.all([poolA.end(), poolB.end()]);
      await harness.dispose();
    }
  }, 30_000);
});
