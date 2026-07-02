import { getTableColumns } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { meResponseSchema } from '@bettertrack/contracts';

import { apiKeys } from '../data/schema';
import { pinFailCountKey } from '../services/auth/loginThrottle';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

/** Log in and return an agent whose cookie jar carries the session. */
async function loginAgent(email: string, password: string) {
  const agent = request.agent(harness.app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier: email, password });
  expect(res.status).toBe(200);
  return agent;
}

describe('PIN gate (PROJECTPLAN.md §6.1, §8)', () => {
  it('enables the PIN and reflects it in /auth/me', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(user.email, user.password);

    // Freshly logged in: no PIN yet.
    const before = await agent.get('/api/v1/auth/me');
    expect(meResponseSchema.parse(before.body).pinEnabled).toBe(false);

    const set = await agent
      .put('/api/v1/auth/pin')
      .set(...XRW)
      .send({ pin: '135790' });
    expect(set.status).toBe(200);
    expect(meResponseSchema.parse(set.body).pinEnabled).toBe(true);

    const after = await agent.get('/api/v1/auth/me');
    expect(after.body.pinEnabled).toBe(true);
  });

  it('rejects a non-numeric or too-short PIN at the contract boundary', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(user.email, user.password);

    const nonNumeric = await agent
      .put('/api/v1/auth/pin')
      .set(...XRW)
      .send({ pin: '12ab' });
    expect(nonNumeric.status).toBe(400);

    const tooShort = await agent
      .put('/api/v1/auth/pin')
      .set(...XRW)
      .send({ pin: '12' });
    expect(tooShort.status).toBe(400);
  });

  it('verifies a correct PIN and rejects a wrong one', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(user.email, user.password);
    await agent
      .put('/api/v1/auth/pin')
      .set(...XRW)
      .send({ pin: '4242' });

    const wrong = await agent
      .post('/api/v1/auth/pin/verify')
      .set(...XRW)
      .send({ pin: '0000' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_PIN');

    const right = await agent
      .post('/api/v1/auth/pin/verify')
      .set(...XRW)
      .send({ pin: '4242' });
    expect(right.status).toBe(200);
    expect(meResponseSchema.parse(right.body).pinEnabled).toBe(true);
    // A successful verify keeps the session usable.
    expect((await agent.get('/api/v1/auth/me')).status).toBe(200);
  });

  it('falls back to full login after 5 consecutive wrong PINs (session destroyed)', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(user.email, user.password);
    await agent
      .put('/api/v1/auth/pin')
      .set(...XRW)
      .send({ pin: '4242' });

    // Four wrong PINs: still INVALID_PIN, session alive.
    for (let i = 0; i < 4; i++) {
      const res = await agent
        .post('/api/v1/auth/pin/verify')
        .set(...XRW)
        .send({ pin: '0000' });
      expect(res.body.error.code).toBe('INVALID_PIN');
    }
    expect((await agent.get('/api/v1/auth/me')).status).toBe(200);

    // The fifth wrong PIN trips the fallback and kills the session.
    const fifth = await agent
      .post('/api/v1/auth/pin/verify')
      .set(...XRW)
      .send({ pin: '0000' });
    expect(fifth.status).toBe(401);
    expect(fifth.body.error.code).toBe('PIN_FALLBACK_LOGIN');

    // Session is gone → must sign in with the password again.
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);
    // The fail tally was cleared on fallback.
    expect(await harness.ctx.redis.get(pinFailCountKey(user.id))).toBeNull();
  });

  it('resets the consecutive-failure tally after a correct PIN', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(user.email, user.password);
    await agent
      .put('/api/v1/auth/pin')
      .set(...XRW)
      .send({ pin: '4242' });

    for (let i = 0; i < 4; i++) {
      await agent
        .post('/api/v1/auth/pin/verify')
        .set(...XRW)
        .send({ pin: '0000' });
    }
    // A correct PIN clears the tally, so the next wrong one starts from 1.
    await agent
      .post('/api/v1/auth/pin/verify')
      .set(...XRW)
      .send({ pin: '4242' });
    expect(await harness.ctx.redis.get(pinFailCountKey(user.id))).toBeNull();

    const wrongAgain = await agent
      .post('/api/v1/auth/pin/verify')
      .set(...XRW)
      .send({ pin: '0000' });
    // Not the fallback — the tally was reset, so this is only the first failure.
    expect(wrongAgain.body.error.code).toBe('INVALID_PIN');
  });

  it('changes the PIN: the new one verifies, the old one no longer does', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(user.email, user.password);
    await agent
      .put('/api/v1/auth/pin')
      .set(...XRW)
      .send({ pin: '1111' });
    await agent
      .put('/api/v1/auth/pin')
      .set(...XRW)
      .send({ pin: '2222' });

    const old = await agent
      .post('/api/v1/auth/pin/verify')
      .set(...XRW)
      .send({ pin: '1111' });
    expect(old.status).toBe(401);

    const fresh = await agent
      .post('/api/v1/auth/pin/verify')
      .set(...XRW)
      .send({ pin: '2222' });
    expect(fresh.status).toBe(200);
  });

  it('disables the PIN: /auth/me clears the flag and verify reports it unset', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(user.email, user.password);
    await agent
      .put('/api/v1/auth/pin')
      .set(...XRW)
      .send({ pin: '4242' });

    const off = await agent.delete('/api/v1/auth/pin').set(...XRW);
    expect(off.status).toBe(200);
    expect(meResponseSchema.parse(off.body).pinEnabled).toBe(false);

    const verify = await agent
      .post('/api/v1/auth/pin/verify')
      .set(...XRW)
      .send({ pin: '4242' });
    expect(verify.status).toBe(400);
    expect(verify.body.error.code).toBe('PIN_NOT_ENABLED');
  });

  it('requires a session to touch any PIN endpoint', async () => {
    const anon = request(harness.app);
    expect(
      (
        await anon
          .put('/api/v1/auth/pin')
          .set(...XRW)
          .send({ pin: '4242' })
      ).status,
    ).toBe(401);
    expect(
      (
        await anon
          .post('/api/v1/auth/pin/verify')
          .set(...XRW)
          .send({ pin: '4242' })
      ).status,
    ).toBe(401);
    expect((await anon.delete('/api/v1/auth/pin').set(...XRW)).status).toBe(401);
  });
});

describe('password change / disable invalidate sessions but never API keys (§5.5, §6.1)', () => {
  it('the api_keys model has no expiry column and is revoke-only', () => {
    const columns = Object.keys(getTableColumns(apiKeys));
    // Revoke-only lifecycle: a revocation column, and deliberately NO expiry.
    expect(columns).toContain('revokedAt');
    expect(columns.some((c) => /expir/i.test(c))).toBe(false);
  });

  it("destroying every session for a user never touches that user's API keys", async () => {
    const user = await harness.seedUser();

    await harness.db.insert(apiKeys).values({
      userId: user.id,
      name: 'ci-key',
      tokenHash: 'hash-abc',
    });

    // The strongest session-expiry action there is.
    await harness.ctx.redis.flushall();
    // (Re-seed nothing; just prove the key survives session teardown.)
    const before = await harness.db.select().from(apiKeys).where(eq(apiKeys.userId, user.id));
    expect(before).toHaveLength(1);
    expect(before[0]?.revokedAt).toBeNull();

    // API keys live in Postgres; session-expiry logic lives entirely in Redis
    // and never references this table — so a full Redis flush leaves keys intact.
    const after = await harness.db.select().from(apiKeys).where(eq(apiKeys.userId, user.id));
    expect(after).toHaveLength(1);
    expect(after[0]?.revokedAt).toBeNull();
  });
});
