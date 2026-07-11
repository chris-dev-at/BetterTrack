import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { sessionInfoResponseSchema } from '@bettertrack/contracts';

import { createTestApp, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

/** Log in and return an agent whose cookie jar carries the session. */
async function loginAgent(email: string, password: string, staySignedIn?: boolean) {
  const agent = request.agent(harness.app);
  const body: Record<string, unknown> = { identifier: email, password };
  if (staySignedIn !== undefined) body.staySignedIn = staySignedIn;
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send(body);
  expect(res.status).toBe(200);
  return agent;
}

describe('GET /auth/session — current-session info (PROJECTPLAN.md §6.11 Security)', () => {
  it("returns the current session's timestamps with expiresAt = renewedAt + 30-day window", async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(user.email, user.password);

    const res = await agent.get('/api/v1/auth/session');
    expect(res.status).toBe(200);
    // .strict() — unknown fields would throw here.
    const info = sessionInfoResponseSchema.parse(res.body);

    const signedInAt = Date.parse(info.signedInAt);
    const renewedAt = Date.parse(info.renewedAt);
    const expiresAt = Date.parse(info.expiresAt);
    expect(Number.isNaN(signedInAt)).toBe(false);

    // Freshly logged in: created and renewed at the same instant.
    expect(renewedAt).toBe(signedInAt);
    // A default login is persistent: the expiry is exactly the fixed 30-day
    // window past the renewal.
    expect(info.persistent).toBe(true);
    expect(expiresAt - renewedAt).toBe(harness.ctx.config.cookie.maxAgeMs);
  });

  it('reports an ephemeral session with persistent:false and a cap-bounded expiry, not 30 days', async () => {
    const user = await harness.seedUser();
    // staySignedIn:false mints an ephemeral session (V4-P2b, §399 §A).
    const agent = await loginAgent(user.email, user.password, false);

    const info = sessionInfoResponseSchema.parse((await agent.get('/api/v1/auth/session')).body);

    expect(info.persistent).toBe(false);
    const signedInAt = Date.parse(info.signedInAt);
    const expiresAt = Date.parse(info.expiresAt);
    // Ephemeral expiry is the hard cap from creation — the honest upper bound,
    // NOT the 30-day window (which would overstate the lifetime by ~60×).
    expect(expiresAt - signedInAt).toBe(harness.ctx.config.cookie.ephemeralCapMs);
    expect(expiresAt - signedInAt).toBeLessThan(harness.ctx.config.cookie.maxAgeMs);
  });

  it('is 401 for an unauthenticated caller (no session cookie)', async () => {
    const anon = request(harness.app);
    const res = await anon.get('/api/v1/auth/session');
    expect(res.status).toBe(401);
  });

  it("reflects the caller's own session, not another user's", async () => {
    const alice = await harness.seedUser({ email: 'alice@bettertrack.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bettertrack.test', username: 'bob' });
    const aliceAgent = await loginAgent(alice.email, alice.password);
    const bobAgent = await loginAgent(bob.email, bob.password);

    const aliceInfo = sessionInfoResponseSchema.parse(
      (await aliceAgent.get('/api/v1/auth/session')).body,
    );
    const bobInfo = sessionInfoResponseSchema.parse(
      (await bobAgent.get('/api/v1/auth/session')).body,
    );

    // Each session id resolves to its own record; the timestamps come from
    // req.sessionId, so the two callers see distinct sign-in instants.
    const aliceSignedIn = Date.parse(aliceInfo.signedInAt);
    const bobSignedIn = Date.parse(bobInfo.signedInAt);
    // Bob logged in after Alice, so his sign-in is at or after hers, never before.
    expect(bobSignedIn).toBeGreaterThanOrEqual(aliceSignedIn);
    // And each session's expiry tracks its own renewal.
    expect(Date.parse(aliceInfo.expiresAt) - Date.parse(aliceInfo.renewedAt)).toBe(
      harness.ctx.config.cookie.maxAgeMs,
    );
    expect(Date.parse(bobInfo.expiresAt) - Date.parse(bobInfo.renewedAt)).toBe(
      harness.ctx.config.cookie.maxAgeMs,
    );
  });
});
