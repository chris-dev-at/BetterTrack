import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import { sessionListResponseSchema } from '@bettertrack/contracts';

import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * Session lifetime — "stay signed in", ephemeral sessions and the OAuth-flow
 * persistence rules (V4-P2b, owner spec #399 §A; PROJECTPLAN.md §16).
 *
 * The server is authoritative: it selects the cookie flavour (Max-Age for a
 * persistent session, a browser-session cookie for an ephemeral one) and forces
 * a PIN-less OAuth login ephemeral regardless of what the client asked for. The
 * server-side idle/cap TTL is unit-tested with an injected clock in
 * sessionService.test.ts; here we exercise the HTTP surface end to end.
 */
const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0.0.0 Safari/537.36';

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

/** The full `bt_sid=…` Set-Cookie header from a response (last one wins). */
function sidSetCookie(res: request.Response): string {
  const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
  const header = (setCookie ?? []).filter((c) => c.startsWith('bt_sid=')).at(-1);
  if (!header) throw new Error('no session cookie set');
  return header;
}

/** A persisted cookie carries Max-Age/Expires; a browser-session cookie carries neither. */
const isPersistentCookie = (header: string): boolean =>
  /max-age=/i.test(header) || /expires=/i.test(header);

function loginRequest(app: Application, body: Record<string, unknown>, ua = CHROME) {
  return request(app)
    .post('/api/v1/auth/login')
    .set(...XRW)
    .set('User-Agent', ua)
    .send(body);
}

describe('session lifetime — stay signed in (V4-P2b, §399 §A)', () => {
  it('defaults to a persistent session (Max-Age cookie) when staySignedIn is omitted', async () => {
    const user = await harness.seedUser();
    const res = await loginRequest(harness.app, {
      identifier: user.email,
      password: user.password,
    });
    expect(res.status).toBe(200);
    expect(isPersistentCookie(sidSetCookie(res))).toBe(true);
  });

  it('staySignedIn:false → a browser-session cookie (no Max-Age/Expires)', async () => {
    const user = await harness.seedUser();
    const res = await loginRequest(harness.app, {
      identifier: user.email,
      password: user.password,
      staySignedIn: false,
    });
    expect(res.status).toBe(200);
    const cookie = sidSetCookie(res);
    expect(/max-age=/i.test(cookie)).toBe(false);
    expect(/expires=/i.test(cookie)).toBe(false);
    // The ephemeral session is nonetheless a live, usable session.
    const sid = cookie.split(';')[0]!;
    expect((await request(harness.app).get('/api/v1/auth/me').set('Cookie', sid)).status).toBe(200);
  });

  it('the rolling cookie refresh keeps an ephemeral session ephemeral (no silent upgrade)', async () => {
    const user = await harness.seedUser();
    const agent = request.agent(harness.app);
    await agent
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: user.email, password: user.password, staySignedIn: false });

    // loadSession re-issues the cookie on every request — it must stay a
    // browser-session cookie, not silently gain a Max-Age.
    const me = await agent.get('/api/v1/auth/me').set('User-Agent', CHROME);
    expect(me.status).toBe(200);
    expect(isPersistentCookie(sidSetCookie(me))).toBe(false);
  });

  it('the session manager marks each session persistent vs ephemeral, and ephemeral is revocable', async () => {
    const user = await harness.seedUser();

    const persistentAgent = request.agent(harness.app);
    await persistentAgent
      .post('/api/v1/auth/login')
      .set(...XRW)
      .set('User-Agent', CHROME)
      .send({ identifier: user.email, password: user.password, staySignedIn: true });

    const ephemeralAgent = request.agent(harness.app);
    await ephemeralAgent
      .post('/api/v1/auth/login')
      .set(...XRW)
      .set('User-Agent', CHROME)
      .send({ identifier: user.email, password: user.password, staySignedIn: false });

    // The persistent device sees both sessions with the right markers.
    const listRes = await persistentAgent.get('/api/v1/auth/sessions').set('User-Agent', CHROME);
    const { sessions } = sessionListResponseSchema.parse(listRes.body);
    expect(sessions).toHaveLength(2);
    expect(sessions.find((s) => s.current)?.persistent).toBe(true);
    const ephemeral = sessions.find((s) => !s.current)!;
    expect(ephemeral.persistent).toBe(false);

    // Revoking the ephemeral session works like any other — its next request 401s.
    const del = await persistentAgent.delete(`/api/v1/auth/sessions/${ephemeral.id}`).set(...XRW);
    expect(del.status).toBe(200);
    expect((await ephemeralAgent.get('/api/v1/auth/me')).status).toBe(401);
  });
});

describe('session lifetime — OAuth-flow persistence rules (V4-P2b, §399 §A)', () => {
  it('a PIN-less OAuth login is FORCED ephemeral even when staySignedIn is true', async () => {
    const user = await harness.seedUser();
    const res = await loginRequest(harness.app, {
      identifier: user.email,
      password: user.password,
      oauthLogin: true,
      staySignedIn: true, // asked to persist — the server overrides for a PIN-less OAuth login
    });
    expect(res.status).toBe(200);
    expect(isPersistentCookie(sidSetCookie(res))).toBe(false);

    // And the session manager reflects it as ephemeral.
    const sid = sidSetCookie(res).split(';')[0]!;
    const list = await request(harness.app)
      .get('/api/v1/auth/sessions')
      .set('Cookie', sid)
      .set('User-Agent', CHROME);
    const { sessions } = sessionListResponseSchema.parse(list.body);
    expect(sessions.find((s) => s.current)?.persistent).toBe(false);
  });

  it('a PIN-less account cannot promote its OAuth session — persist is 400 PIN_NOT_ENABLED', async () => {
    const user = await harness.seedUser();
    const agent = request.agent(harness.app);
    await agent
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: user.email, password: user.password, oauthLogin: true });

    const persist = await agent.post('/api/v1/auth/session/persist').set(...XRW);
    expect(persist.status).toBe(400);
    expect(persist.body.error.code).toBe('PIN_NOT_ENABLED');
    // Still ephemeral — the security property "OAuth + no PIN never persists" holds.
    const list = await agent.get('/api/v1/auth/sessions').set('User-Agent', CHROME);
    const { sessions } = sessionListResponseSchema.parse(list.body);
    expect(sessions.find((s) => s.current)?.persistent).toBe(false);
  });

  it('an account WITH a PIN can promote its OAuth session to persistent via persist', async () => {
    const user = await harness.seedUser();

    // Enable a PIN on the account (via a normal session).
    const setup = request.agent(harness.app);
    await setup
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: user.email, password: user.password });
    expect(
      (
        await setup
          .put('/api/v1/auth/pin')
          .set(...XRW)
          .send({ pin: '1357' })
      ).status,
    ).toBe(200);

    // A fresh OAuth login on that PIN account mints an ephemeral session…
    const agent = request.agent(harness.app);
    const loginRes = await agent
      .post('/api/v1/auth/login')
      .set(...XRW)
      .set('User-Agent', CHROME)
      .send({
        identifier: user.email,
        password: user.password,
        oauthLogin: true,
        staySignedIn: false,
      });
    expect(isPersistentCookie(sidSetCookie(loginRes))).toBe(false);

    // …which the "stay signed in — your PIN protects this" choice promotes.
    const persist = await agent.post('/api/v1/auth/session/persist').set(...XRW);
    expect(persist.status).toBe(200);
    expect(isPersistentCookie(sidSetCookie(persist))).toBe(true);

    const list = await agent.get('/api/v1/auth/sessions').set('User-Agent', CHROME);
    const { sessions } = sessionListResponseSchema.parse(list.body);
    expect(sessions.find((s) => s.current)?.persistent).toBe(true);
  });

  it('the persist endpoint is cookie-session only — a bearer token is 403', async () => {
    const user = await harness.seedUser();
    const agent = request.agent(harness.app);
    await agent
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: user.email, password: user.password });
    const minted = await agent
      .post('/api/v1/settings/api-keys')
      .set(...XRW)
      .send({ name: 'k', scopes: ['account:security'] });
    expect(minted.status).toBe(201);
    const token = minted.body.token as string;

    const res = await request(harness.app)
      .post('/api/v1/auth/session/persist')
      .set('Authorization', `Bearer ${token}`)
      .set(...XRW);
    expect(res.status).toBe(403);
  });
});
