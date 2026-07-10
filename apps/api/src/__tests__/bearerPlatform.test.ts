import { createHash, randomBytes } from 'node:crypto';

import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  chatConversationListResponseSchema,
  conversationResponseSchema,
  createApiKeyResponseSchema,
  createOAuthClientResponseSchema,
  meResponseSchema,
  oauthTokenResponseSchema,
  pinStatusResponseSchema,
  sendChatMessageResponseSchema,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * Issue #361 — unified web+mobile bearer surface. Exercises the four narrow gaps
 * built on top of the already-working bearer parity: bearer-callable identity,
 * self-revocation on logout, the new granular scopes (route × scope matrix), and
 * the bearer PIN status/verify that reuses the one web login PIN.
 *
 * Scope enforcement is identical for a personal API key and a delegated OAuth
 * token (the same `enforceApiKeyScope` rail), so the matrix runs over personal
 * keys — cheap to mint — while identity + self-revocation are asserted for BOTH
 * token kinds since those are the paths the mobile client actually walks.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const REDIRECT = 'https://app.example/callback';
const MISSING_ID = '00000000-0000-0000-0000-000000000000';

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

type Agent = ReturnType<typeof request.agent>;

const uniq = () => randomBytes(5).toString('hex');

async function seedFreshUser(overrides: Record<string, string> = {}) {
  const tag = uniq();
  return harness.seedUser({
    email: `u-${tag}@bettertrack.test`,
    username: `user${tag}`,
    ...overrides,
  });
}

async function loginAgent(app: Application, identifier: string, password: string): Promise<Agent> {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  return agent;
}

/** Seed a fresh user and mint a personal key with the given scopes. */
async function mintKey(
  scopes: string[],
): Promise<{ token: string; id: string; userId: string; email: string; username: string }> {
  const user = await seedFreshUser();
  const agent = await loginAgent(harness.app, user.email, user.password);
  const res = await agent
    .post('/api/v1/settings/api-keys')
    .set(...XRW)
    .send({ name: 'mobile', scopes });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const parsed = createApiKeyResponseSchema.parse(res.body);
  return {
    token: parsed.token,
    id: parsed.key.id,
    userId: user.id,
    email: user.email,
    username: user.username,
  };
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** Seed a fresh user, register a public PKCE client they own, and mint a delegated token. */
async function mintOAuthToken(
  scopes: string[],
): Promise<{ token: string; userId: string; grantId: string; email: string }> {
  const user = await seedFreshUser();
  const agent = await loginAgent(harness.app, user.email, user.password);
  const reg = await agent
    .post('/api/v1/settings/oauth-clients')
    .set(...XRW)
    .send({ name: 'MobileTest', redirectUris: [REDIRECT], scopes, public: true });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  const clientId = createOAuthClientResponseSchema.parse(reg.body).client.clientId;

  const { verifier, challenge } = pkce();
  const approve = await agent
    .post('/api/v1/oauth/authorize')
    .set(...XRW)
    .send({
      client_id: clientId,
      redirect_uri: REDIRECT,
      scope: scopes.join(' '),
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
  expect(approve.status, JSON.stringify(approve.body)).toBe(200);
  const code = new URL(approve.body.redirectTo as string).searchParams.get('code');
  expect(code).toBeTruthy();

  const tokenRes = await request(harness.app).post('/api/v1/oauth/token').send({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: verifier,
  });
  expect(tokenRes.status, JSON.stringify(tokenRes.body)).toBe(200);
  const token = oauthTokenResponseSchema.parse(tokenRes.body).access_token;

  const [grant] = await harness.db
    .select()
    .from(schema.oauthGrants)
    .where(eq(schema.oauthGrants.userId, user.id));
  return { token, userId: user.id, grantId: grant!.id, email: user.email };
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('#361 bearer-callable identity — GET /auth/me', () => {
  it('returns the caller’s own identity under a personal key', async () => {
    const { token, email, username } = await mintKey(['portfolio:read']);
    const res = await request(harness.app).get('/api/v1/auth/me').set(bearer(token));
    expect(res.status).toBe(200);
    const me = meResponseSchema.parse(res.body);
    expect(me.email).toBe(email);
    expect(me.username).toBe(username);
    expect(me.baseCurrency).toBe('EUR');
    // No secrets/hashes leak into the identity payload.
    expect(JSON.stringify(res.body)).not.toMatch(/hash|passwordHash|pinHash/i);
  });

  it('returns identity under a delegated OAuth token (minimal scope)', async () => {
    const { token, email } = await mintOAuthToken(['portfolio:read']);
    const res = await request(harness.app).get('/api/v1/auth/me').set(bearer(token));
    expect(res.status).toBe(200);
    expect(meResponseSchema.parse(res.body).email).toBe(email);
  });

  it('401s with no/invalid bearer', async () => {
    await request(harness.app).get('/api/v1/auth/me').expect(401);
    await request(harness.app).get('/api/v1/auth/me').set(bearer('btk_nope')).expect(401);
  });
});

describe('#361 route × scope matrix', () => {
  // Each row: the route, the scope it now requires, and a body for mutations.
  // A key WITHOUT the scope must 403 INSUFFICIENT_SCOPE; a key WITH it must get
  // past the scope guard (any non-403 — 200/400 — proves enforcement, not shape).
  const rows: {
    name: string;
    method: 'get' | 'post' | 'patch';
    path: string;
    scope: string;
    body?: Record<string, unknown>;
  }[] = [
    {
      name: 'notifications inbox',
      method: 'get',
      path: '/notifications',
      scope: 'notifications:read',
    },
    {
      name: 'notifications mark-read',
      method: 'post',
      path: '/notifications/mark-read',
      scope: 'notifications:write',
      body: { all: true },
    },
    {
      name: 'notification prefs read',
      method: 'get',
      path: '/settings/notifications',
      scope: 'notifications:read',
    },
    {
      name: 'notification prefs write',
      method: 'patch',
      path: '/settings/notifications',
      scope: 'notifications:write',
      body: { email: { friendRequest: false } },
    },
    { name: 'friends list', method: 'get', path: '/social/friends', scope: 'social:read' },
    {
      name: 'friend request (mutate graph)',
      method: 'post',
      path: '/social/requests',
      scope: 'social:write',
      body: { username: 'someone-else' },
    },
    // #396: /chat was missing from MODULE_POLICIES, so both rows used to hit the
    // session-only default (403 API_KEY_FORBIDDEN) even WITH the chat scopes.
    {
      name: 'chat conversations list',
      method: 'get',
      path: '/chat/conversations',
      scope: 'chat:read',
    },
    {
      name: 'chat open conversation (mutate)',
      method: 'post',
      path: '/chat/conversations',
      scope: 'chat:write',
      body: { userId: MISSING_ID },
    },
    { name: '2fa status', method: 'get', path: '/auth/2fa/status', scope: 'account:security' },
    { name: 'sessions list', method: 'get', path: '/auth/sessions', scope: 'account:security' },
    {
      name: 'change password',
      method: 'post',
      path: '/auth/change-password',
      scope: 'account:security',
      body: {},
    },
    { name: 'pin status', method: 'get', path: '/auth/pin/status', scope: 'account:security' },
    {
      name: 'pin verify',
      method: 'post',
      path: '/auth/pin/verify',
      scope: 'account:security',
      body: { pin: '0000' },
    },
  ];

  const send = (token: string, row: (typeof rows)[number]) => {
    const url = `/api/v1${row.path}`;
    const base = request(harness.app);
    const started =
      row.method === 'get'
        ? base.get(url)
        : row.method === 'post'
          ? base.post(url)
          : base.patch(url);
    const withAuth = started.set(bearer(token));
    return row.body ? withAuth.send(row.body) : withAuth;
  };

  it.each(rows)('403 INSUFFICIENT_SCOPE without $scope: $name', async (row) => {
    // A valid token that authenticates but lacks the row's scope (holds an
    // unrelated one) must be rejected on scope, not on auth.
    const { token } = await mintKey(['market:read']);
    const res = await send(token, row);
    expect(res.status, `${row.method} ${row.path}`).toBe(403);
    expect(res.body.error.code).toBe('INSUFFICIENT_SCOPE');
  });

  it.each(rows)('passes the scope guard with $scope: $name', async (row) => {
    const { token } = await mintKey([row.scope]);
    const res = await send(token, row);
    expect(res.status, `${row.method} ${row.path} → ${JSON.stringify(res.body)}`).not.toBe(403);
  });

  it('a personal key can never reach admin, regardless of the new scopes', async () => {
    const { token } = await mintKey(['account:security', 'social:write', 'notifications:read']);
    await request(harness.app).get('/api/v1/admin/users').set(bearer(token)).expect(404);
  });

  it('key management stays cookie-only even with account:security', async () => {
    const { token } = await mintKey(['account:security']);
    const res = await request(harness.app).get('/api/v1/settings/api-keys').set(bearer(token));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('API_KEY_FORBIDDEN');
  });
});

describe('#361 bearer PIN status + verify (reuses the web login PIN)', () => {
  it('reports pinSet and verifies the SAME web PIN, rejecting a wrong one', async () => {
    const { token, userId } = await mintKey(['account:security']);
    // The PIN is set through the very same service the web login uses.
    await harness.ctx.auth.setPin(userId, '1357');

    const status = await request(harness.app).get('/api/v1/auth/pin/status').set(bearer(token));
    expect(status.status).toBe(200);
    expect(pinStatusResponseSchema.parse(status.body)).toEqual({ pinSet: true });

    const ok = await request(harness.app)
      .post('/api/v1/auth/pin/verify')
      .set(bearer(token))
      .send({ pin: '1357' });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true });

    const wrong = await request(harness.app)
      .post('/api/v1/auth/pin/verify')
      .set(bearer(token))
      .send({ pin: '2468' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_PIN');
    // The PIN never appears in the response envelope.
    expect(JSON.stringify(wrong.body)).not.toContain('2468');
  });

  it('pinSet is false and verify is PIN_NOT_ENABLED when no web PIN exists', async () => {
    const { token } = await mintKey(['account:security']);
    const status = await request(harness.app).get('/api/v1/auth/pin/status').set(bearer(token));
    expect(pinStatusResponseSchema.parse(status.body)).toEqual({ pinSet: false });

    const verify = await request(harness.app)
      .post('/api/v1/auth/pin/verify')
      .set(bearer(token))
      .send({ pin: '1357' });
    expect(verify.status).toBe(400);
    expect(verify.body.error.code).toBe('PIN_NOT_ENABLED');
  });

  it('rate-limits brute-forcing — sustained wrong PINs eventually 429', async () => {
    const { token, userId } = await mintKey(['account:security']);
    await harness.ctx.auth.setPin(userId, '1357');

    let sawTooMany = false;
    for (let i = 0; i < 14 && !sawTooMany; i += 1) {
      const res = await request(harness.app)
        .post('/api/v1/auth/pin/verify')
        .set(bearer(token))
        .send({ pin: '0001' });
      if (res.status === 429) sawTooMany = true;
      else expect(res.status).toBe(401);
    }
    expect(sawTooMany).toBe(true);

    // While cooling down, even the CORRECT PIN is turned away (429, not 200).
    const correct = await request(harness.app)
      .post('/api/v1/auth/pin/verify')
      .set(bearer(token))
      .send({ pin: '1357' });
    expect(correct.status).toBe(429);
  });
});

describe('#361 self-revocation on logout', () => {
  it('a personal key revokes ITSELF via POST /auth/logout', async () => {
    const { token, id } = await mintKey(['portfolio:read']);
    await request(harness.app).get('/api/v1/portfolios').set(bearer(token)).expect(200);

    const out = await request(harness.app).post('/api/v1/auth/logout').set(bearer(token));
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true });

    // The presented token is dead; the key row is revoked.
    const after = await request(harness.app).get('/api/v1/portfolios').set(bearer(token));
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('API_KEY_INVALID');
    const [row] = await harness.db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id));
    expect(row!.revokedAt).not.toBeNull();
  });

  it('a delegated OAuth token revokes its OWN grant via POST /auth/logout', async () => {
    const { token, grantId } = await mintOAuthToken(['portfolio:read']);
    await request(harness.app).get('/api/v1/portfolios').set(bearer(token)).expect(200);

    const out = await request(harness.app).post('/api/v1/auth/logout').set(bearer(token));
    expect(out.status).toBe(200);

    // Revoking the grant instantly kills the access token it minted.
    const after = await request(harness.app).get('/api/v1/portfolios').set(bearer(token));
    expect(after.status).toBe(401);
    const [grant] = await harness.db
      .select()
      .from(schema.oauthGrants)
      .where(eq(schema.oauthGrants.id, grantId));
    expect(grant!.revokedAt).not.toBeNull();
  });
});

describe('#396 bearer /chat coverage — the mobile chat 403 root cause', () => {
  /**
   * Seed a key owner (personal key with the given scopes) and a second user,
   * friend them via the cookie-session social flow (same as chat.test.ts), and
   * hand back the bearer token plus the friend's id + logged-in agent.
   */
  async function seedChatPair(scopes: string[]): Promise<{
    token: string;
    friendId: string;
    friendAgent: Agent;
  }> {
    const ownerSeed = await seedFreshUser();
    const ownerAgent = await loginAgent(harness.app, ownerSeed.email, ownerSeed.password);
    const keyRes = await ownerAgent
      .post('/api/v1/settings/api-keys')
      .set(...XRW)
      .send({ name: 'mobile-chat', scopes });
    expect(keyRes.status, JSON.stringify(keyRes.body)).toBe(201);
    const token = createApiKeyResponseSchema.parse(keyRes.body).token;

    const friendSeed = await seedFreshUser();
    const friendAgent = await loginAgent(harness.app, friendSeed.email, friendSeed.password);

    const sent = await ownerAgent
      .post('/api/v1/social/requests')
      .set(...XRW)
      .send({ identifier: friendSeed.username });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    const inbox = await friendAgent.get('/api/v1/social/requests');
    const incoming = inbox.body.incoming.find(
      (r: { user: { id: string } }) => r.user.id === ownerSeed.id,
    );
    const accepted = await friendAgent
      .post(`/api/v1/social/requests/${incoming.id}/accept`)
      .set(...XRW)
      .send();
    expect(accepted.status).toBe(200);

    return { token, friendId: friendSeed.id, friendAgent };
  }

  it('a chat-scoped key walks the full flow: list → open → message; the cookie side sees it', async () => {
    const { token, friendId, friendAgent } = await seedChatPair(['chat:read', 'chat:write']);

    // GET /chat/conversations — the exact request the mobile app failed on
    // (#349/#386): pre-fix this was 403 API_KEY_FORBIDDEN despite chat:read.
    const list = await request(harness.app).get('/api/v1/chat/conversations').set(bearer(token));
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(chatConversationListResponseSchema.safeParse(list.body).success).toBe(true);

    const opened = await request(harness.app)
      .post('/api/v1/chat/conversations')
      .set(bearer(token))
      .send({ userId: friendId });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    expect(conversationResponseSchema.safeParse(opened.body).success).toBe(true);
    const conversationId = opened.body.conversation.id as string;

    const sent = await request(harness.app)
      .post(`/api/v1/chat/conversations/${conversationId}/messages`)
      .set(bearer(token))
      .send({ body: 'hello from mobile' });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect(sendChatMessageResponseSchema.safeParse(sent.body).success).toBe(true);

    // The cookie-session path through the SAME conversation is unchanged: the
    // friend reads the thread with their session and sees the bearer's message.
    const thread = await friendAgent.get(`/api/v1/chat/conversations/${conversationId}/messages`);
    expect(thread.status).toBe(200);
    expect(thread.body.messages).toHaveLength(1);
    expect(thread.body.messages[0].body).toBe('hello from mobile');
  });

  it('403 INSUFFICIENT_SCOPE (scope-gated, not API_KEY_FORBIDDEN) without chat scopes', async () => {
    // A broadly-scoped platform token that merely lacks chat:* — the pre-fix
    // failure was a blanket API_KEY_FORBIDDEN regardless of scopes; the module
    // must now deny on the missing scope like every other mapped module.
    const { token, friendId } = await seedChatPair([
      'portfolio:read',
      'social:read',
      'notifications:read',
    ]);

    const list = await request(harness.app).get('/api/v1/chat/conversations').set(bearer(token));
    expect(list.status).toBe(403);
    expect(list.body.error.code).toBe('INSUFFICIENT_SCOPE');
    expect(list.body.error.message).toContain('chat:read');

    const open = await request(harness.app)
      .post('/api/v1/chat/conversations')
      .set(bearer(token))
      .send({ userId: friendId });
    expect(open.status).toBe(403);
    expect(open.body.error.code).toBe('INSUFFICIENT_SCOPE');
    expect(open.body.error.message).toContain('chat:write');

    const send = await request(harness.app)
      .post(`/api/v1/chat/conversations/${MISSING_ID}/messages`)
      .set(bearer(token))
      .send({ body: 'nope' });
    expect(send.status).toBe(403);
    expect(send.body.error.code).toBe('INSUFFICIENT_SCOPE');
  });

  it('chat:read alone lists but cannot open or send (read/write split holds)', async () => {
    const { token, friendId } = await seedChatPair(['chat:read']);
    await request(harness.app).get('/api/v1/chat/conversations').set(bearer(token)).expect(200);

    const open = await request(harness.app)
      .post('/api/v1/chat/conversations')
      .set(bearer(token))
      .send({ userId: friendId });
    expect(open.status).toBe(403);
    expect(open.body.error.code).toBe('INSUFFICIENT_SCOPE');
  });

  it('a delegated OAuth token with chat scopes reaches chat too (the rail the mobile app rides)', async () => {
    const { token } = await mintOAuthToken(['chat:read', 'chat:write']);
    const res = await request(harness.app).get('/api/v1/chat/conversations').set(bearer(token));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(chatConversationListResponseSchema.safeParse(res.body).success).toBe(true);
  });
});
