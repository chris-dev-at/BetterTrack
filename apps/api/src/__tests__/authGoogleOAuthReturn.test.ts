import { createHash, randomBytes } from 'node:crypto';

import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { oauthTokenResponseSchema } from '@bettertrack/contracts';

import { createOAuthRepository } from '../data/repositories/oauthRepository';
import { auditLog, users } from '../data/schema';
import { MAX_AUTHORIZE_RETURN_TO_LENGTH } from '../services/auth/authorizeReturnTo';
import type { GoogleClaims } from '../services/auth/googleVerifier';
import { FIRST_PARTY_CLIENTS, seedFirstPartyClients } from '../services/oauth/firstPartyClients';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * Google sign-in started INSIDE the app's OAuth authorize flow (owner directive
 * 2026-10-29). The mobile app opens `/oauth/authorize?…` in a Custom Tab; the
 * login there now offers "Continue with Google", which hands the pending
 * authorize request to `GET /auth/google/start?returnTo=…`. The API binds it to
 * the single-use Google `state` and the callback lands the browser back INSIDE
 * that request — success, brand-new identity and failure alike.
 *
 * Security under test: the return target is validated server-side with the
 * SPA's own rule (same-origin path, exactly `/oauth/authorize`), an unsafe one
 * refuses the flow before Google is ever contacted, and the target is bound to
 * the `state` this browser was issued (a foreign browser cannot redeem it).
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

const MOBILE = FIRST_PARTY_CLIENTS.find(
  (client) => client.clientId === 'btc_IbT1mzw_7kBiPHPkGfaE0Q',
)!;
const MOBILE_REDIRECT = 'bettertrack://oauth/callback';

const GOOGLE_ENV = {
  BT_GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com',
  BT_GOOGLE_CLIENT_SECRET: 'client-secret-value',
} satisfies Partial<NodeJS.ProcessEnv>;

type Agent = ReturnType<typeof request.agent>;

interface Harness {
  harness: TestHarness;
  adminAgent: Agent;
  web: string;
  setClaims(claims: GoogleClaims | Error): void;
  verifierCalls(): number;
}

async function makeHarness(): Promise<Harness> {
  let claims: GoogleClaims | Error = new Error('verifier not primed');
  let calls = 0;
  const harness = await createTestApp({
    env: GOOGLE_ENV,
    googleVerifier: {
      exchangeAndVerify: async () => {
        calls += 1;
        if (claims instanceof Error) throw claims;
        return claims;
      },
    },
  });
  await seedFirstPartyClients(createOAuthRepository(harness.db));
  const admin = await harness.seedAdmin();
  const adminAgent = await harness.loginAdmin(admin);
  return {
    harness,
    adminAgent,
    web: harness.ctx.config.appOrigin,
    setClaims: (c) => {
      claims = c;
    },
    verifierCalls: () => calls,
  };
}

async function setMode(agent: Agent, mode: 'closed' | 'invite_token' | 'approval' | 'open') {
  const res = await agent
    .patch('/api/v1/admin/settings')
    .set(...XRW)
    .send({ registrationMode: mode });
  expect(res.status).toBe(200);
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** The authorize request exactly as the mobile app builds it (first-party PKCE client). */
function authorizeRequest(challenge: string, state = 'app-state-xyz') {
  const params = {
    response_type: 'code',
    client_id: MOBILE.clientId,
    redirect_uri: MOBILE_REDIRECT,
    scope: 'portfolio:read',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  };
  return { params, path: `/oauth/authorize?${new URLSearchParams(params).toString()}` };
}

function claims(overrides: Partial<GoogleClaims> = {}): GoogleClaims {
  return {
    sub: overrides.sub ?? 'google-sub-authz',
    email: overrides.email ?? 'phone-user@example.com',
    emailVerified: overrides.emailVerified ?? true,
    name: overrides.name,
  };
}

function setCookies(res: request.Response): string[] {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

/** The last `bt_sid` Set-Cookie carrying a value, if any. */
function sessionCookie(res: request.Response): string | undefined {
  return setCookies(res)
    .filter((c) => /^bt_sid=[^;]+/.test(c) && !/^bt_sid=;/.test(c))
    .at(-1);
}

/** A persisted cookie carries Max-Age/Expires; a browser-session cookie carries neither. */
const isPersistentCookie = (header: string): boolean =>
  /max-age=/i.test(header) || /expires=/i.test(header);

const startUrl = (returnTo?: string) =>
  returnTo === undefined
    ? '/api/v1/auth/google/start'
    : `/api/v1/auth/google/start?returnTo=${encodeURIComponent(returnTo)}`;

/** `start` (optionally with a return target) → the `state` Google would echo back. */
async function start(agent: Agent, returnTo?: string): Promise<string> {
  const res = await agent.get(startUrl(returnTo));
  expect(res.status).toBe(302);
  expect(String(res.headers.location)).toContain('accounts.google.com');
  const state = new URL(String(res.headers.location)).searchParams.get('state');
  expect(state).toBeTruthy();
  return state!;
}

const callback = (agent: Agent, state: string) =>
  agent.get(`/api/v1/auth/google/callback?state=${encodeURIComponent(state)}&code=authcode`);

/** Seed a password account and link the Google identity to it (verified-email path). */
async function seedLinkedUser(h: Harness, profile: GoogleClaims) {
  const user = await h.harness.seedUser({
    email: profile.email,
    username: 'phoneuser',
    password: 'phone-user-pass-1',
  });
  h.setClaims(profile);
  const linkAgent = request.agent(h.harness.app);
  const linked = await callback(linkAgent, await start(linkAgent));
  expect(String(linked.headers.location)).toContain('google=signed_in');
  return user;
}

describe('Google sign-in inside the OAuth authorize flow (owner directive 2026-10-29)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
    await setMode(h.adminAgent, 'open');
  });

  it('lands back on the pending authorize request with an ephemeral session, and the app gets its PKCE code', async () => {
    const profile = claims();
    await seedLinkedUser(h, profile);
    const { verifier, challenge } = pkce();
    const authz = authorizeRequest(challenge);

    const agent = request.agent(h.harness.app);
    h.setClaims(profile);
    const res = await callback(agent, await start(agent, authz.path));

    // Back INSIDE the authorize request — byte-identical, on the web origin.
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${h.web}${authz.path}`);

    // The session is set — and EPHEMERAL, the §399 §A rule for a Custom-Tab login.
    const cookie = sessionCookie(res);
    expect(cookie).toBeDefined();
    expect(isPersistentCookie(cookie!)).toBe(false);
    const me = await agent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(profile.email);

    // The audit trail says which flow minted it.
    const audits = await h.harness.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'login.success'));
    expect(
      audits.some((a) => {
        const meta = a.meta as { via?: string; flow?: string } | null;
        return meta?.via === 'google' && meta.flow === 'oauth_authorize';
      }),
    ).toBe(true);

    // …and that session completes the flow: the consent approve answers the
    // app's custom-scheme callback with a code that redeems under PKCE.
    const approved = await agent
      .post('/api/v1/oauth/authorize')
      .set(...XRW)
      .send(authz.params);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const redirectTo = new URL(approved.body.redirectTo as string);
    expect(`${redirectTo.protocol}//${redirectTo.host}${redirectTo.pathname}`).toBe(
      MOBILE_REDIRECT,
    );
    expect(redirectTo.searchParams.get('state')).toBe('app-state-xyz');
    const code = redirectTo.searchParams.get('code');
    expect(code).toBeTruthy();
    const exchanged = await request(h.harness.app).post('/api/v1/oauth/token').send({
      grant_type: 'authorization_code',
      code,
      redirect_uri: MOBILE_REDIRECT,
      client_id: MOBILE.clientId,
      code_verifier: verifier,
    });
    expect(exchanged.status, JSON.stringify(exchanged.body)).toBe(200);
    expect(oauthTokenResponseSchema.parse(exchanged.body).access_token).toBeTruthy();
  });

  it('without a return target the web sign-in is unchanged: home landing, persistent session', async () => {
    const profile = claims({ sub: 'google-sub-web', email: 'web-user@example.com' });
    await seedLinkedUser(h, profile);

    const agent = request.agent(h.harness.app);
    h.setClaims(profile);
    const res = await callback(agent, await start(agent));
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${h.web}/?google=signed_in`);
    const cookie = sessionCookie(res);
    expect(cookie).toBeDefined();
    expect(isPersistentCookie(cookie!)).toBe(true);
  });

  it('a brand-new identity lands on the connected register form carrying the request; the account gets an ephemeral session', async () => {
    const authz = authorizeRequest(pkce().challenge);
    const agent = request.agent(h.harness.app);
    h.setClaims(claims({ sub: 'google-sub-new', email: 'brand-new@example.com' }));

    const res = await callback(agent, await start(agent, authz.path));
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      `${h.web}/register?google=connected&returnTo=${encodeURIComponent(authz.path)}`,
    );
    expect(sessionCookie(res)).toBeUndefined();

    const submit = await agent
      .post('/api/v1/auth/google/register')
      .set(...XRW)
      .send({ username: 'brandnew', password: 'brand-new-pass-1' });
    expect(submit.status, JSON.stringify(submit.body)).toBe(201);
    const cookie = sessionCookie(submit);
    expect(cookie).toBeDefined();
    // Decided by the TICKET (minted inside the authorize flow), not the page.
    expect(isPersistentCookie(cookie!)).toBe(false);
  });

  it('a failure lands on the login page still carrying the pending request', async () => {
    await setMode(h.adminAgent, 'closed');
    const authz = authorizeRequest(pkce().challenge);
    const agent = request.agent(h.harness.app);
    h.setClaims(claims({ sub: 'google-sub-closed', email: 'closed@example.com' }));

    const res = await callback(agent, await start(agent, authz.path));
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      `${h.web}/login?error=google_registration_closed&returnTo=${encodeURIComponent(authz.path)}`,
    );
    expect(sessionCookie(res)).toBeUndefined();
  });

  it('a provider error (consent denied) returns into the request AND spends the state', async () => {
    const authz = authorizeRequest(pkce().challenge);
    const agent = request.agent(h.harness.app);
    const state = await start(agent, authz.path);

    const denied = await agent.get(
      `/api/v1/auth/google/callback?state=${encodeURIComponent(state)}&error=access_denied`,
    );
    expect(denied.status).toBe(302);
    expect(denied.headers.location).toBe(
      `${h.web}/login?error=google_failed&returnTo=${encodeURIComponent(authz.path)}`,
    );
    expect(h.verifierCalls()).toBe(0);

    // Single-use: the same state cannot be replayed into a sign-in afterwards.
    h.setClaims(claims());
    const replay = await agent.get(
      `/api/v1/auth/google/callback?state=${encodeURIComponent(state)}&code=authcode`,
    );
    expect(String(replay.headers.location)).toContain('/login?error=google_state');
    expect(h.verifierCalls()).toBe(0);
  });

  it('the return target is bound to the issuing browser: a foreign browser presenting the state gets nothing', async () => {
    const profile = claims({ sub: 'google-sub-csrf', email: 'csrf@example.com' });
    await seedLinkedUser(h, profile);
    const authz = authorizeRequest(pkce().challenge);
    const victimAgent = request.agent(h.harness.app);
    const state = await start(victimAgent, authz.path);
    const callsBefore = h.verifierCalls(); // seedLinkedUser already verified once

    // Another browser (no `bt_goog_state` cookie) replays the state Google echoed.
    h.setClaims(profile);
    const foreign = await callback(request.agent(h.harness.app), state);
    expect(foreign.status).toBe(302);
    expect(foreign.headers.location).toBe(`${h.web}/login?error=google_state`);
    expect(sessionCookie(foreign)).toBeUndefined();
    expect(h.verifierCalls()).toBe(callsBefore);
  });

  it('a LINK flow (live session) keeps its fixed Settings landing and ignores the return target', async () => {
    const user = await h.harness.seedUser({
      email: 'linker@example.com',
      username: 'linker',
      password: 'link-password-1',
    });
    const agent = request.agent(h.harness.app);
    const login = await agent
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: user.email, password: user.password });
    expect(login.status).toBe(200);

    const authz = authorizeRequest(pkce().challenge);
    h.setClaims(claims({ sub: 'google-sub-linker', email: 'linker@example.com' }));
    const res = await callback(agent, await start(agent, authz.path));
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${h.web}/settings/connections?google=linked`);
  });

  // ── The binding itself: server-side, single-use, 10 minutes, cookie-bound ──
  it('binds the target to the server-side state only: never echoed to Google, 10-minute TTL, same signed HttpOnly cookie', async () => {
    const authz = authorizeRequest(pkce().challenge);
    const res = await request.agent(h.harness.app).get(startUrl(authz.path));
    expect(res.status).toBe(302);

    // Google is told nothing about the pending request: it rides the state only.
    const google = new URL(String(res.headers.location));
    expect(`${google.protocol}//${google.host}`).toBe('https://accounts.google.com');
    expect(google.searchParams.has('returnTo')).toBe(false);
    expect(String(res.headers.location)).not.toContain('oauth%2Fauthorize');
    expect(String(res.headers.location)).not.toContain(MOBILE.clientId);

    // The single-use record holds it verbatim, and expires within 10 minutes.
    const state = google.searchParams.get('state')!;
    const key = `google_oauth_state:${state}`;
    expect(JSON.parse((await h.harness.ctx.redis.get(key))!)).toEqual({ returnTo: authz.path });
    const ttl = await h.harness.ctx.redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(600);

    // The browser binding is the SAME cookie a plain web start sets: signed,
    // HttpOnly, identical attributes — `returnTo` changes nothing about it.
    const attrs = (header: string) =>
      header
        .split(';')
        .slice(1)
        .map((a) => a.trim().toLowerCase())
        .filter((a) => !a.startsWith('expires='))
        .sort();
    const withTarget = setCookies(res).find((c) => c.startsWith('bt_goog_state='))!;
    const plain = setCookies(await request(h.harness.app).get(startUrl())).find((c) =>
      c.startsWith('bt_goog_state='),
    )!;
    expect(withTarget).toMatch(/^bt_goog_state=s%3A/); // cookie-parser signed value
    expect(attrs(withTarget)).toContain('httponly');
    expect(attrs(withTarget).some((a) => a.startsWith('samesite='))).toBe(true);
    expect(attrs(withTarget)).toEqual(attrs(plain));
  });

  it('an expired state lands on the generic state error and carries NOTHING back', async () => {
    const profile = claims({ sub: 'google-sub-expired', email: 'expired@example.com' });
    await seedLinkedUser(h, profile);
    const authz = authorizeRequest(pkce().challenge);
    const agent = request.agent(h.harness.app);
    const state = await start(agent, authz.path);
    // Expiry, as Redis would do it after 10 minutes.
    await h.harness.ctx.redis.del(`google_oauth_state:${state}`);
    const callsBefore = h.verifierCalls();

    h.setClaims(profile);
    const res = await callback(agent, state);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${h.web}/login?error=google_state`);
    expect(sessionCookie(res)).toBeUndefined();
    expect(h.verifierCalls()).toBe(callsBefore);
  });

  it('a stored target is re-validated on the way out: a record that no longer passes is never redirected to', async () => {
    const profile = claims({ sub: 'google-sub-tampered', email: 'tampered@example.com' });
    await seedLinkedUser(h, profile);
    const agent = request.agent(h.harness.app);
    const state = await start(agent, authorizeRequest(pkce().challenge).path);
    // Defence in depth: even a corrupted server-side record cannot steer the redirect.
    await h.harness.ctx.redis.set(
      `google_oauth_state:${state}`,
      JSON.stringify({ returnTo: '//evil.test/oauth/authorize' }),
      'EX',
      600,
    );

    h.setClaims(profile);
    const res = await callback(agent, state);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${h.web}/?google=signed_in`);
    expect(String(res.headers.location)).not.toContain('evil');
  });

  it('a provider error replayed from a foreign browser neither returns into the request nor burns the victim’s state', async () => {
    const profile = claims({ sub: 'google-sub-burn', email: 'burn@example.com' });
    await seedLinkedUser(h, profile);
    const authz = authorizeRequest(pkce().challenge);
    const victim = request.agent(h.harness.app);
    const state = await start(victim, authz.path);

    // A foreign browser (no `bt_goog_state` cookie) presents the state with an error.
    const foreign = await request(h.harness.app).get(
      `/api/v1/auth/google/callback?state=${encodeURIComponent(state)}&error=access_denied`,
    );
    expect(foreign.status).toBe(302);
    expect(foreign.headers.location).toBe(`${h.web}/login?error=google_failed`);

    // The victim's own round trip still completes into the authorize request.
    h.setClaims(profile);
    const res = await callback(victim, state);
    expect(res.headers.location).toBe(`${h.web}${authz.path}`);
  });

  // ── Open-redirect class: every unsafe target REFUSES the flow ─────────────
  it.each([
    ['a bare foreign origin', 'https://evil'],
    ['a bare protocol-relative host', '//evil'],
    ['a dot-segment traversal', '/oauth/authorize/../x'],
    ['an encoded dot-segment traversal', '/oauth/authorize/%2e%2e/x'],
    ['an absolute foreign URL', 'https://evil.test/oauth/authorize?client_id=x'],
    ['a protocol-relative URL', '//evil.test/oauth/authorize'],
    ['a backslash host trick', '/\\evil.test/oauth/authorize'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['another internal route', '/settings/security'],
    ['a look-alike path', '/oauth/authorizeX?client_id=x'],
    ['a traversal off the path', '/oauth/authorize/../admin'],
    ['a fragment', '/oauth/authorize?client_id=x#frag'],
    ['a smuggled newline', '/oauth/authorize?client_id=x\r\nLocation: https://evil.test'],
    ['a relative path', 'oauth/authorize?client_id=x'],
    ['an empty value', ''],
    ['an over-long value', `/oauth/authorize?state=${'a'.repeat(MAX_AUTHORIZE_RETURN_TO_LENGTH)}`],
  ])('refuses %s: no state, no cookie, Google never contacted', async (_label, hostile) => {
    const agent = request.agent(h.harness.app);
    const res = await agent.get(startUrl(hostile));
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${h.web}/login?error=google_return_invalid`);
    expect(setCookies(res).some((c) => c.startsWith('bt_goog_state='))).toBe(false);
  });

  it.each([
    ['the authorize request first, a hostile target second', 'safe-hostile'],
    ['a hostile target first, the authorize request second', 'hostile-safe'],
    ['the same authorize request twice', 'safe-safe'],
  ])(
    'refuses a repeated returnTo parameter (%s): it parses to an array, never a string',
    async (_label, shape) => {
      const safe = encodeURIComponent(authorizeRequest(pkce().challenge).path);
      const hostile = encodeURIComponent('//evil.test');
      const [first, second] =
        shape === 'safe-hostile'
          ? [safe, hostile]
          : shape === 'hostile-safe'
            ? [hostile, safe]
            : [safe, safe];
      const res = await request(h.harness.app).get(
        `/api/v1/auth/google/start?returnTo=${first}&returnTo=${second}`,
      );
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`${h.web}/login?error=google_return_invalid`);
      expect(setCookies(res).some((c) => c.startsWith('bt_goog_state='))).toBe(false);
    },
  );

  it('no account is created and no session minted by any refused start', async () => {
    const before = await h.harness.db.select().from(users);
    const res = await request(h.harness.app).get(startUrl('//evil.test'));
    expect(sessionCookie(res)).toBeUndefined();
    const after = await h.harness.db.select().from(users);
    expect(after).toHaveLength(before.length);
  });
});
