import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  createApiKeyResponseSchema,
  sessionListResponseSchema,
  type SessionSummary,
} from '@bettertrack/contracts';

import { createTestApp, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0.0.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0';

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

type Agent = ReturnType<typeof request.agent>;

/** Log in `email` and return an agent whose cookie jar carries the session. */
async function loginAgent(app: Application, email: string, password: string, ua = CHROME) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .set('User-Agent', ua)
    .send({ identifier: email, password });
  expect(res.status).toBe(200);
  return agent;
}

async function listSessions(agent: Agent, ua = CHROME): Promise<SessionSummary[]> {
  const res = await agent.get('/api/v1/auth/sessions').set('User-Agent', ua);
  expect(res.status).toBe(200);
  return sessionListResponseSchema.parse(res.body).sessions;
}

describe('Session manager (PROJECTPLAN.md §6.1, §6.11, V3-P11a)', () => {
  it('lists active sessions with device label, timestamps and a current marker', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password, CHROME);

    // The list request stamps this session's UA, so it resolves to a device.
    const sessions = await listSessions(agent, CHROME);
    expect(sessions).toHaveLength(1);
    const only = sessions[0]!;
    expect(only.current).toBe(true);
    expect(only.device).toBe('Chrome on macOS');
    expect(Number.isNaN(Date.parse(only.createdAt))).toBe(false);
    expect(Number.isNaN(Date.parse(only.lastSeenAt))).toBe(false);
    // The handle is opaque, not the raw session cookie value.
    expect(only.id.length).toBeGreaterThan(0);
  });

  it('shows every device the user is signed in on, each once', async () => {
    const user = await harness.seedUser();
    const chrome = await loginAgent(harness.app, user.email, user.password, CHROME);
    const firefox = await loginAgent(harness.app, user.email, user.password, FIREFOX);

    // Both make a request so each stamps its own UA.
    await listSessions(firefox, FIREFOX);
    const fromChrome = await listSessions(chrome, CHROME);

    expect(fromChrome).toHaveLength(2);
    const devices = fromChrome.map((s) => s.device).sort();
    expect(devices).toEqual(['Chrome on macOS', 'Firefox on Windows']);
    // Exactly one is the caller's current session.
    expect(fromChrome.filter((s) => s.current)).toHaveLength(1);
    expect(fromChrome.find((s) => s.device === 'Chrome on macOS')!.current).toBe(true);
  });

  it('revoking one session logs that device out on its very next request (two-session)', async () => {
    const user = await harness.seedUser();
    const agentA = await loginAgent(harness.app, user.email, user.password, CHROME);
    const agentB = await loginAgent(harness.app, user.email, user.password, FIREFOX);

    // B is alive before revocation.
    expect((await agentB.get('/api/v1/auth/me')).status).toBe(200);

    // A sees both, revokes the other (B).
    const listed = await listSessions(agentA, CHROME);
    const other = listed.find((s) => !s.current)!;
    const del = await agentA.delete(`/api/v1/auth/sessions/${other.id}`).set(...XRW);
    expect(del.status).toBe(200);

    // B's next request is rejected as unauthenticated; A stays signed in.
    expect((await agentB.get('/api/v1/auth/me')).status).toBe(401);
    expect((await agentA.get('/api/v1/auth/me')).status).toBe(200);
    expect(await listSessions(agentA, CHROME)).toHaveLength(1);
  });

  it('revoke-others kills every other session and keeps the caller signed in', async () => {
    const user = await harness.seedUser();
    const keeper = await loginAgent(harness.app, user.email, user.password, CHROME);
    const b = await loginAgent(harness.app, user.email, user.password, FIREFOX);
    const c = await loginAgent(harness.app, user.email, user.password, FIREFOX);

    const res = await keeper.post('/api/v1/auth/sessions/revoke-others').set(...XRW);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ revoked: 2 });

    expect((await keeper.get('/api/v1/auth/me')).status).toBe(200);
    expect((await b.get('/api/v1/auth/me')).status).toBe(401);
    expect((await c.get('/api/v1/auth/me')).status).toBe(401);
    expect(await listSessions(keeper, CHROME)).toHaveLength(1);
  });

  it('revoking your own current session is a clean logout — cookie cleared, no error', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password, CHROME);

    const current = (await listSessions(agent, CHROME))[0]!;
    expect(current.current).toBe(true);

    const del = await agent.delete(`/api/v1/auth/sessions/${current.id}`).set(...XRW);
    expect(del.status).toBe(200);
    // The cookie was cleared and the session destroyed: the next call is anonymous.
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('a user only ever sees and revokes their OWN sessions', async () => {
    const alice = await harness.seedUser({ email: 'alice@bettertrack.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bettertrack.test', username: 'bob' });
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password, CHROME);
    const bobAgent = await loginAgent(harness.app, bob.email, bob.password, FIREFOX);

    const aliceSessions = await listSessions(aliceAgent, CHROME);
    expect(aliceSessions).toHaveLength(1);

    // Alice cannot revoke Bob's session even with his handle — she can't see it,
    // and the handle is not in her index, so it's a 404 and Bob stays alive.
    const bobSessions = await listSessions(bobAgent, FIREFOX);
    const bobHandle = bobSessions[0]!.id;
    const del = await aliceAgent.delete(`/api/v1/auth/sessions/${bobHandle}`).set(...XRW);
    expect(del.status).toBe(404);
    expect((await bobAgent.get('/api/v1/auth/me')).status).toBe(200);
  });

  it('rejects API-key and OAuth bearer principals on every session endpoint', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password, CHROME);
    const minted = await agent
      .post('/api/v1/settings/api-keys')
      .set(...XRW)
      .send({ name: 'k', scopes: ['portfolio:read', 'social:read'] });
    expect(minted.status).toBe(201);
    const { token } = createApiKeyResponseSchema.parse(minted.body);
    const auth = ['Authorization', `Bearer ${token}`] as const;

    // Even a broadly-scoped key cannot touch the session surface (§6.13).
    expect(
      (
        await request(harness.app)
          .get('/api/v1/auth/sessions')
          .set(...auth)
      ).status,
    ).toBe(403);
    expect(
      (
        await request(harness.app)
          .delete('/api/v1/auth/sessions/anything')
          .set(...auth)
          .set(...XRW)
      ).status,
    ).toBe(403);
    expect(
      (
        await request(harness.app)
          .post('/api/v1/auth/sessions/revoke-others')
          .set(...auth)
          .set(...XRW)
      ).status,
    ).toBe(403);
  });

  it('a password change kills all sessions and the list reflects it (regression)', async () => {
    const user = await harness.seedUser();
    const agentA = await loginAgent(harness.app, user.email, user.password, CHROME);
    const agentB = await loginAgent(harness.app, user.email, user.password, FIREFOX);

    // A changes the password → destroyAllForUser, then a fresh session for A.
    const res = await agentA
      .post('/api/v1/auth/change-password')
      .set(...XRW)
      .send({ currentPassword: user.password, newPassword: 'Str0ng-New-Passw0rd!' });
    expect(res.status).toBe(200);

    // B's old session is dead; A is on a brand-new session and the list shows
    // only it — the index routed through the same revocation mechanism.
    expect((await agentB.get('/api/v1/auth/me')).status).toBe(401);
    const sessions = await listSessions(agentA, CHROME);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.current).toBe(true);
  });

  it('lists a session with no captured metadata as "Unknown device" and still revocable', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password, CHROME);
    // A second session that never makes a follow-up request: the login POST
    // carries no cookie, so nothing stamps its User-Agent — it has no metadata,
    // exactly like a session created before this feature shipped.
    await loginAgent(harness.app, user.email, user.password, FIREFOX);

    const sessions = await listSessions(agent, CHROME);
    const legacy = sessions.find((s) => !s.current)!;
    expect(legacy).toBeDefined();
    expect(legacy.device).toBe('Unknown device');

    // Still addressable for revocation.
    const del = await agent.delete(`/api/v1/auth/sessions/${legacy.id}`).set(...XRW);
    expect(del.status).toBe(200);
    expect(await listSessions(agent, CHROME)).toHaveLength(1);
  });
});
