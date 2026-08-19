import { createHash, randomBytes } from 'node:crypto';

import { and, desc, eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application, Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  API_KEY_SCOPES,
  alertListResponseSchema,
  alertSchema,
  cashBudgetResponseSchema,
  cashMonthlySummaryResponseSchema,
  cashRuleApplyResponseSchema,
  cashRulePreviewResponseSchema,
  cashRuleResponseSchema,
  cashTagResponseSchema,
  cashTrendResponseSchema,
  chatConversationListResponseSchema,
  conversationResponseSchema,
  createApiKeyResponseSchema,
  createOAuthClientResponseSchema,
  meResponseSchema,
  oauthAuthorizationDetailsResponseSchema,
  oauthTokenResponseSchema,
  pinStatusResponseSchema,
  sendChatMessageResponseSchema,
} from '@bettertrack/contracts';

import { createOAuthRepository } from '../data/repositories/oauthRepository';
import { createTwoFactorRepository } from '../data/repositories/twoFactorRepository';
import { createUserRepository } from '../data/repositories/userRepository';
import * as schema from '../data/schema';
import {
  ACCOUNT_SECURITY_SCOPE,
  passkeyManagementRouteAcceptsBearer,
  pathAcceptsBearer,
  taxYearLockRouteAcceptsBearer,
} from '../http/middleware/bearerAuth';
import { requireCookieSessionOrTaxYearLockBearer } from '../http/routes/settingsRoutes';
import {
  ACCOUNT_PASSKEY_NAMESPACE,
  ACCOUNT_TAX_YEAR_UNLOCK_NAMESPACE,
} from '../services/auth/loginThrottle';
import { generateTotpCode } from '../services/auth/totp';
import { FIRST_PARTY_CLIENTS, seedFirstPartyClients } from '../services/oauth/firstPartyClients';
import { progressiveKeys } from '../services/security/progressiveLimiter';
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
async function mintKey(scopes: string[]): Promise<{
  token: string;
  id: string;
  userId: string;
  email: string;
  username: string;
  password: string;
}> {
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
    password: user.password,
  };
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** Seed a fresh user, register a public PKCE client they own, and mint a delegated token. */
async function mintOAuthToken(scopes: string[]): Promise<{
  token: string;
  userId: string;
  grantId: string;
  clientRowId: string;
  email: string;
  password: string;
}> {
  const user = await seedFreshUser();
  const agent = await loginAgent(harness.app, user.email, user.password);
  const reg = await agent
    .post('/api/v1/settings/oauth-clients')
    .set(...XRW)
    .send({ name: 'MobileTest', redirectUris: [REDIRECT], scopes, public: true });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  const clientRow = createOAuthClientResponseSchema.parse(reg.body).client;
  const clientId = clientRow.clientId;
  // The internal client UUID lets the grant lookup below scope by (user, client)
  // instead of by user alone — see the block that fetches `grantRows`.
  const clientRowId = clientRow.id;

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

  // #514 root cause: the pre-fix lookup filtered on `userId` alone with no
  // ordering, so on a cold full-suite run — where the PGlite singleton is
  // shared across test files within a worker — any latent grant leak or
  // reordered row scan (Postgres never guarantees SELECT order without ORDER
  // BY) could return a DIFFERENT grant than the one the token in hand points
  // at. The self-revocation test then revoked grant A (via the token) but
  // asserted revocation on grant B → order/timing-dependent failure.
  // The fix is defensive on both axes: narrow the WHERE to (user × client),
  // add deterministic ordering, and fail loudly if the result set isn't
  // exactly the one row a fresh (user, client) pair MUST yield.
  const grantRows = await harness.db
    .select()
    .from(schema.oauthGrants)
    .where(
      and(eq(schema.oauthGrants.userId, user.id), eq(schema.oauthGrants.clientId, clientRowId)),
    )
    .orderBy(desc(schema.oauthGrants.createdAt));
  expect(grantRows).toHaveLength(1);
  const grant = grantRows[0]!;
  return {
    token,
    userId: user.id,
    grantId: grant.id,
    clientRowId,
    email: user.email,
    password: user.password,
  };
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

type AccountSecurityRoute = {
  name: string;
  method: 'get' | 'post' | 'patch' | 'delete';
  path: string;
  body?: Record<string, unknown>;
};

const ACCOUNT_SECURITY_WIDENED_ROUTES: readonly AccountSecurityRoute[] = [
  { name: 'passkey list', method: 'get', path: '/auth/passkeys' },
  {
    name: 'passkey rename',
    method: 'patch',
    path: `/auth/passkeys/${MISSING_ID}`,
    body: { name: 'Phone' },
  },
  {
    name: 'passkey delete',
    method: 'delete',
    path: `/auth/passkeys/${MISSING_ID}`,
    body: { password: 'irrelevant-before-scope-check' },
  },
  { name: 'tax-year lock state', method: 'get', path: '/settings/taxes/years' },
  {
    name: 'tax-year unlock',
    method: 'post',
    path: '/settings/taxes/years/2025/unlock',
    body: { password: 'irrelevant-before-scope-check' },
  },
  {
    name: 'tax-year relock',
    method: 'post',
    path: '/settings/taxes/years/2025/relock',
  },
  { name: 'first-run completion', method: 'post', path: '/auth/first-run/complete' },
] as const;

function callAccountSecurityRoute(token: string, row: AccountSecurityRoute) {
  const url = `/api/v1${row.path}`;
  const base = request(harness.app);
  const started =
    row.method === 'get'
      ? base.get(url)
      : row.method === 'post'
        ? base.post(url)
        : row.method === 'delete'
          ? base.delete(url)
          : base.patch(url);
  const withAuth = started.set(bearer(token));
  return row.body ? withAuth.send(row.body) : withAuth;
}

async function seedManagedPasskeys(userId: string) {
  const suffix = uniq();
  return harness.db
    .insert(schema.passkeys)
    .values([
      {
        userId,
        name: 'Rename me',
        credentialId: `credential-rename-${suffix}`,
        publicKey: 'AQID',
        counter: 0,
        transports: null,
      },
      {
        userId,
        name: 'Delete me',
        credentialId: `credential-delete-${suffix}`,
        publicKey: 'AQID',
        counter: 0,
        transports: null,
      },
    ])
    .returning();
}

async function exerciseWidenedAccountSecuritySurface(input: {
  token: string;
  userId: string;
  password: string;
}) {
  const [renameTarget, deleteTarget] = await seedManagedPasskeys(input.userId);
  const responses: request.Response[] = [];

  const listed = await request(harness.app).get('/api/v1/auth/passkeys').set(bearer(input.token));
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  expect(listed.body.passkeys).toHaveLength(2);
  responses.push(listed);

  const renamed = await request(harness.app)
    .patch(`/api/v1/auth/passkeys/${renameTarget!.id}`)
    .set(bearer(input.token))
    .send({ name: 'Native phone' });
  expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
  expect(renamed.body.name).toBe('Native phone');
  responses.push(renamed);

  const deleted = await request(harness.app)
    .delete(`/api/v1/auth/passkeys/${deleteTarget!.id}`)
    .set(bearer(input.token))
    .send({ password: input.password });
  expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
  expect(deleted.body).toEqual({ ok: true });
  responses.push(deleted);

  const lockState = await request(harness.app)
    .get('/api/v1/settings/taxes/years')
    .set(bearer(input.token));
  expect(lockState.status, JSON.stringify(lockState.body)).toBe(200);
  const elapsedYear = (lockState.body.currentYear as number) - 1;
  responses.push(lockState);

  const unlocked = await request(harness.app)
    .post(`/api/v1/settings/taxes/years/${elapsedYear}/unlock`)
    .set(bearer(input.token))
    .send({ password: input.password });
  expect(unlocked.status, JSON.stringify(unlocked.body)).toBe(200);
  expect(unlocked.body.unlockedYears).toContain(elapsedYear);
  responses.push(unlocked);

  const relocked = await request(harness.app)
    .post(`/api/v1/settings/taxes/years/${elapsedYear}/relock`)
    .set(bearer(input.token));
  expect(relocked.status, JSON.stringify(relocked.body)).toBe(200);
  expect(relocked.body.unlockedYears).not.toContain(elapsedYear);
  responses.push(relocked);

  const completed = await request(harness.app)
    .post('/api/v1/auth/first-run/complete')
    .set(bearer(input.token));
  expect(completed.status, JSON.stringify(completed.body)).toBe(200);
  expect(meResponseSchema.parse(completed.body).firstRunCompletedAt).not.toBeNull();
  responses.push(completed);

  // Bearer management never mints or refreshes a browser session.
  for (const response of responses) expect(response.headers['set-cookie']).toBeUndefined();
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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
    method: 'get' | 'post' | 'patch' | 'delete';
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
    // #437: archive state + deletion are writes on the same module scope.
    {
      name: 'notification archive (mutate)',
      method: 'post',
      path: `/notifications/${MISSING_ID}/archive`,
      scope: 'notifications:write',
    },
    {
      name: 'notifications bulk delete',
      method: 'delete',
      path: '/notifications?scope=archived',
      scope: 'notifications:write',
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
    // #405: /alerts was missing from MODULE_POLICIES, so both rows used to hit
    // the session-only default (403 API_KEY_FORBIDDEN) even WITH the alerts
    // scopes — the mobile 403 this fix closes.
    {
      name: 'alerts list',
      method: 'get',
      path: '/alerts',
      scope: 'alerts:read',
    },
    {
      name: 'alerts create (mutate)',
      method: 'post',
      path: '/alerts',
      scope: 'alerts:write',
      body: { assetId: MISSING_ID, kind: 'price_above', threshold: 100 },
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
          : row.method === 'delete'
            ? base.delete(url)
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

  it('changes a password with account:security without minting a cookie session', async () => {
    const { token, email, password } = await mintKey(['account:security']);
    const sibling = await loginAgent(harness.app, email, password);
    const newPassword = 'Bearer-New-Str0ng-Pass!';

    const changed = await request(harness.app)
      .post('/api/v1/auth/change-password')
      .set(bearer(token))
      .send({ currentPassword: password, newPassword });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(meResponseSchema.parse(changed.body).email).toBe(email);
    expect(changed.headers['set-cookie']).toBeUndefined();

    // The durable generation invalidates existing cookie sessions, while the
    // bearer caller receives no replacement cookie.
    expect((await sibling.get('/api/v1/auth/me')).status).toBe(401);
    const oldLogin = await request(harness.app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: email, password });
    expect(oldLogin.status).toBe(401);

    const fresh = await request(harness.app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: email, password: newPassword });
    expect(fresh.status).toBe(200);
    expect(meResponseSchema.safeParse(fresh.body).success).toBe(true);
  });
});

describe('#1324 account:security parity for native account state', () => {
  it.each(['personal', 'oauth'] as const)(
    'serves all seven widened routes to a scoped %s bearer',
    async (kind) => {
      const principal =
        kind === 'personal'
          ? await mintKey([ACCOUNT_SECURITY_SCOPE])
          : await mintOAuthToken([ACCOUNT_SECURITY_SCOPE]);
      expect(principal.token.startsWith(kind === 'personal' ? 'btk_' : 'bto_')).toBe(true);

      await exerciseWidenedAccountSecuritySurface(principal);
    },
  );

  it.each(ACCOUNT_SECURITY_WIDENED_ROUTES)(
    'returns scope-evaluation 403 without account:security: $name',
    async (row) => {
      const { token } = await mintKey(['market:read']);
      const res = await callAccountSecurityRoute(token, row);

      expect(res.status, `${row.method} ${row.path} → ${JSON.stringify(res.body)}`).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_SCOPE');
      expect(res.body.error.message).toContain(ACCOUNT_SECURITY_SCOPE);
    },
  );

  it('keeps passkey bearer admission method-aware and default-closed', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    for (const [method, path] of [
      ['GET', '/auth/passkeys'],
      ['PATCH', `/auth/passkeys/${id}`],
      ['DELETE', `/auth/passkeys/${id}`],
    ] as const) {
      expect(passkeyManagementRouteAcceptsBearer(method, path), `${method} ${path}`).toBe(true);
      expect(pathAcceptsBearer(path, method), `${method} ${path}`).toBe(true);
    }

    for (const path of [
      '/auth/passkeys/register/options',
      '/auth/passkeys/register/verify',
      '/auth/passkeys/login/options',
      '/auth/passkeys/login/verify',
      '/auth/passkeys/export',
    ]) {
      expect(pathAcceptsBearer(path, 'POST'), `POST ${path}`).toBe(false);
    }
    expect(pathAcceptsBearer(`/auth/passkeys/${id}`, 'POST')).toBe(false);
    expect(pathAcceptsBearer('/auth/passkeys/not-a-uuid', 'PATCH')).toBe(false);
    expect(pathAcceptsBearer('/auth/first-run/complete', 'POST')).toBe(true);
    expect(pathAcceptsBearer('/auth/first-run/complete', 'GET')).toBe(false);
  });

  it('keeps the tax-year router guard route- and scope-aware without the global policy', () => {
    const invoke = (scopes: string[], method: string, path: string) => {
      const next = vi.fn();
      requireCookieSessionOrTaxYearLockBearer(
        {
          apiKey: {
            id: 'bypassed-policy-key',
            scopes,
            kind: 'personal',
            securityGeneration: 0,
          },
          method,
          path,
        } as unknown as Request,
        {} as Response,
        next,
      );
      return next;
    };

    const wrongScope = invoke(['market:read'], 'GET', '/taxes/years');
    expect(wrongScope.mock.calls[0]![0]).toMatchObject({
      statusCode: 403,
      code: 'API_KEY_FORBIDDEN',
    });

    const unknownRoute = invoke([ACCOUNT_SECURITY_SCOPE], 'POST', '/taxes/years/2025/export');
    expect(unknownRoute.mock.calls[0]![0]).toMatchObject({
      statusCode: 403,
      code: 'API_KEY_FORBIDDEN',
    });

    expect(invoke([ACCOUNT_SECURITY_SCOPE], 'GET', '/taxes/years')).toHaveBeenCalledWith();
    expect(
      invoke([ACCOUNT_SECURITY_SCOPE], 'POST', '/taxes/years/2025/unlock'),
    ).toHaveBeenCalledWith();
    expect(taxYearLockRouteAcceptsBearer('POST', '/settings/taxes/years/2025/relock')).toBe(true);
  });

  it('keeps bearer passkey deletion on the shared contract, audit and account throttle', async () => {
    const principal = await mintKey([ACCOUNT_SECURITY_SCOPE]);
    const [passkey] = await seedManagedPasskeys(principal.userId);
    const path = `/api/v1/auth/passkeys/${passkey!.id}`;

    const missingReauth = await request(harness.app)
      .delete(path)
      .set(bearer(principal.token))
      .send({});
    expect(missingReauth.status).toBe(400);
    expect(missingReauth.body.error.code).toBe('VALIDATION_ERROR');
    const limiter = progressiveKeys(ACCOUNT_PASSKEY_NAMESPACE, principal.userId);
    expect(await harness.ctx.redis.get(limiter.count)).toBeNull();

    const bearerWrong = await request(harness.app)
      .delete(path)
      .set(bearer(principal.token))
      .send({ password: 'wrong-bearer-password' });
    expect(bearerWrong.status).toBe(401);
    expect(bearerWrong.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(await harness.ctx.redis.get(limiter.count)).toBe('1');

    const cookie = await loginAgent(harness.app, principal.email, principal.password);
    const cookieWrong = await cookie
      .delete(path)
      .set(...XRW)
      .send({ password: 'wrong-cookie-password' });
    expect(cookieWrong.status).toBe(401);
    expect(cookieWrong.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(await harness.ctx.redis.get(limiter.count)).toBe('2');

    const audits = await harness.db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.actorId, principal.userId),
          eq(schema.auditLog.action, 'passkey.manage_reauth_fail'),
        ),
      );
    expect(audits).toHaveLength(2);
    expect(audits.map((row) => (row.meta as { kind?: string }).kind)).toEqual([
      'password',
      'password',
    ]);
  });

  it('keeps bearer tax unlock on the shared audit and account throttle', async () => {
    const principal = await mintKey([ACCOUNT_SECURITY_SCOPE]);
    const lockState = await request(harness.app)
      .get('/api/v1/settings/taxes/years')
      .set(bearer(principal.token));
    const elapsedYear = (lockState.body.currentYear as number) - 1;
    const path = `/api/v1/settings/taxes/years/${elapsedYear}/unlock`;

    const bearerWrong = await request(harness.app)
      .post(path)
      .set(bearer(principal.token))
      .send({ password: 'wrong-bearer-password' });
    expect(bearerWrong.status).toBe(401);
    expect(bearerWrong.body.error.code).toBe('INVALID_CREDENTIALS');
    const limiter = progressiveKeys(ACCOUNT_TAX_YEAR_UNLOCK_NAMESPACE, principal.userId);
    expect(await harness.ctx.redis.get(limiter.count)).toBe('1');

    const cookie = await loginAgent(harness.app, principal.email, principal.password);
    const cookieWrong = await cookie
      .post(path)
      .set(...XRW)
      .send({ password: 'wrong-cookie-password' });
    expect(cookieWrong.status).toBe(401);
    expect(cookieWrong.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(await harness.ctx.redis.get(limiter.count)).toBe('2');

    const audits = await harness.db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.actorId, principal.userId),
          eq(schema.auditLog.action, 'tax_year.unlock_reauth_fail'),
        ),
      );
    expect(audits).toHaveLength(2);
    expect(audits.map((row) => (row.meta as { year?: number }).year)).toEqual([
      elapsedYear,
      elapsedYear,
    ]);
  });

  it('404s an admin-kind bearer on every widened user route', async () => {
    const principal = await mintKey([ACCOUNT_SECURITY_SCOPE]);
    await harness.db
      .update(schema.users)
      .set({ role: 'admin' })
      .where(eq(schema.users.id, principal.userId));

    for (const row of ACCOUNT_SECURITY_WIDENED_ROUTES) {
      const res = await callAccountSecurityRoute(principal.token, row);
      expect(res.status, `${row.method} ${row.path} → ${JSON.stringify(res.body)}`).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    }
  });

  it('reuses the existing account scope without widening scope or first-party registries', () => {
    const preexistingScopes = [
      'portfolio:read',
      'portfolio:write',
      'workboard:read',
      'workboard:write',
      'market:read',
      'social:read',
      'social:write',
      'notifications:read',
      'notifications:write',
      'chat:read',
      'chat:write',
      'account:security',
      'alerts:read',
      'alerts:write',
      'cash:read',
      'cash:write',
      'mirrorchain:read',
      'mirrorchain:write',
      'vault:sync',
      'feedback:write',
    ];
    expect(API_KEY_SCOPES).toEqual(preexistingScopes);
    const mobile = FIRST_PARTY_CLIENTS.find((client) => client.name === 'BetterTrackMobile');
    expect(mobile?.scopeCeiling).toEqual(preexistingScopes);
  });
});

describe('#1328 bearer-started Google LINK policy', () => {
  it('scope-evaluates the one new bearer route and keeps the legacy start closed', async () => {
    const { token } = await mintKey(['market:read']);
    const denied = await request(harness.app)
      .post('/api/v1/auth/google/link/start')
      .set(bearer(token));

    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('INSUFFICIENT_SCOPE');
    expect(denied.body.error.message).toContain(ACCOUNT_SECURITY_SCOPE);
    expect(pathAcceptsBearer('/auth/google/link/start', 'POST')).toBe(true);
    expect(pathAcceptsBearer('/auth/google/link/start', 'GET')).toBe(false);
    expect(pathAcceptsBearer('/auth/google/start', 'GET')).toBe(false);
    expect(pathAcceptsBearer('/auth/google/callback', 'GET')).toBe(false);
    expect(pathAcceptsBearer('/auth/google/link/callback', 'GET')).toBe(false);
  });
});

describe('#888 bearer 2FA generation interleavings', () => {
  it('rejects a first-factor confirmation admitted before promotion', async () => {
    const { token, userId } = await mintKey(['account:security']);
    const { secret } = await harness.ctx.twoFactor.enrollTotp(userId);
    const admitted = deferred();
    const release = deferred();
    const authenticate = harness.ctx.apiKeys.authenticate.bind(harness.ctx.apiKeys);
    const authSpy = vi
      .spyOn(harness.ctx.apiKeys, 'authenticate')
      .mockImplementation(async (rawToken) => {
        const principal = await authenticate(rawToken);
        if (rawToken === token) {
          admitted.resolve();
          await release.promise;
        }
        return principal;
      });

    const confirmation = request(harness.app)
      .post('/api/v1/auth/2fa/confirm')
      .set(bearer(token))
      .send({ code: generateTotpCode(secret) })
      .then((response) => response);
    await admitted.promise;

    // Bearer authentication observed a user at generation zero. Promotion then
    // advances role + generation before the factor write reaches its CAS.
    const userRepo = createUserRepository(harness.db);
    expect(await userRepo.setRole(userId, 'admin')).toBe(1);
    release.resolve();

    const response = await confirmation;
    authSpy.mockRestore();
    expect(response.status).toBe(401);
    const [state] = await harness.db
      .select({
        role: schema.users.role,
        totpEnabled: schema.users.twoFactorEnabled,
        generation: schema.users.securityGeneration,
      })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    expect(state).toEqual({ role: 'admin', totpEnabled: false, generation: 1 });
    expect(
      await harness.db
        .select({ id: schema.twoFactorRecoveryCodes.id })
        .from(schema.twoFactorRecoveryCodes)
        .where(eq(schema.twoFactorRecoveryCodes.userId, userId)),
    ).toHaveLength(0);
  });

  it('allows only one of two bearer factor mutations admitted at the same generation', async () => {
    const { token, userId } = await mintKey(['account:security']);
    const { secret } = await harness.ctx.twoFactor.enrollTotp(userId);
    const { recoveryCodes } = (
      await harness.ctx.twoFactor.confirmTotp(userId, generateTotpCode(secret))
    ).response;
    expect(recoveryCodes).not.toBeNull();

    const twoFactorRepo = createTwoFactorRepository(harness.db);
    const afterTotp = await twoFactorRepo.getState(userId);
    expect(afterTotp).toBeDefined();
    expect(
      await twoFactorRepo.confirmEmail(userId, undefined, null, afterTotp!.securityGeneration),
    ).toBe(afterTotp!.securityGeneration + 1);

    const admitted = [deferred(), deferred()];
    const releases = [deferred(), deferred()];
    const authenticate = harness.ctx.apiKeys.authenticate.bind(harness.ctx.apiKeys);
    let targetCalls = 0;
    const authSpy = vi
      .spyOn(harness.ctx.apiKeys, 'authenticate')
      .mockImplementation(async (rawToken) => {
        const principal = await authenticate(rawToken);
        if (rawToken === token && targetCalls < admitted.length) {
          const call = targetCalls;
          targetCalls += 1;
          admitted[call]!.resolve();
          await releases[call]!.promise;
        }
        return principal;
      });

    const disableTotp = request(harness.app)
      .post('/api/v1/auth/2fa/disable')
      .set(bearer(token))
      .send({ code: generateTotpCode(secret) })
      .then((response) => response);
    await admitted[0]!.promise;
    const disableEmail = request(harness.app)
      .post('/api/v1/auth/2fa/email/disable')
      .set(bearer(token))
      .then((response) => response);
    await admitted[1]!.promise;

    // Both tokens were authorized at the same generation. The first mutation
    // wins; the second must not adopt the post-transition state and turn off
    // the remaining method or clear its shared recovery set.
    releases[0]!.resolve();
    expect((await disableTotp).status).toBe(200);
    releases[1]!.resolve();
    const staleDisable = await disableEmail;
    authSpy.mockRestore();
    expect(staleDisable.status).toBe(401);

    const [state] = await harness.db
      .select({
        totpEnabled: schema.users.twoFactorEnabled,
        emailEnabled: schema.users.twoFactorEmailEnabled,
        generation: schema.users.securityGeneration,
      })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    expect(state).toEqual({
      totpEnabled: false,
      emailEnabled: true,
      generation: afterTotp!.securityGeneration + 2,
    });
    expect(
      await harness.db
        .select({ id: schema.twoFactorRecoveryCodes.id })
        .from(schema.twoFactorRecoveryCodes)
        .where(eq(schema.twoFactorRecoveryCodes.userId, userId)),
    ).toHaveLength(recoveryCodes!.length);
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
    // `grantId` is scoped to (this test's user × this test's client) inside
    // {@link mintOAuthToken} — it can never resolve to a different test's grant,
    // which was the #514 order/timing failure mode. The assertions below are on
    // that specific grant row (primary-key lookup, no global counts) and on the
    // exact bearer token in hand; none of them depend on wall-clock behavior
    // (the OAuth access-token TTL is 3600 s and the auth-code TTL is only in
    // play inside mintOAuthToken, both well outside any test window).
    const { token, grantId, clientRowId, userId } = await mintOAuthToken(['portfolio:read']);
    await request(harness.app).get('/api/v1/portfolios').set(bearer(token)).expect(200);

    const out = await request(harness.app).post('/api/v1/auth/logout').set(bearer(token));
    expect(out.status).toBe(200);

    // Revoking the grant instantly kills the access token it minted.
    const after = await request(harness.app).get('/api/v1/portfolios').set(bearer(token));
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('API_KEY_INVALID');
    const grantRows = await harness.db
      .select()
      .from(schema.oauthGrants)
      .where(eq(schema.oauthGrants.id, grantId));
    expect(grantRows).toHaveLength(1);
    const grant = grantRows[0]!;
    expect(grant.userId).toBe(userId);
    expect(grant.clientId).toBe(clientRowId);
    expect(grant.revokedAt).not.toBeNull();
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

describe('#371 write-implies-read at the scope-enforcement rail', () => {
  it('a personal key with only portfolio:write reaches the read-only GET too', async () => {
    const { token } = await mintKey(['portfolio:write']);
    // The write scope satisfies the GET's portfolio:read requirement.
    const res = await request(harness.app).get('/api/v1/portfolios').set(bearer(token));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // …and the write endpoint it actually holds is of course reachable.
    const post = await request(harness.app)
      .post('/api/v1/portfolios')
      .set(bearer(token))
      .send({ name: 'W' });
    expect(post.status).not.toBe(403);
  });

  it('a read-only key still cannot reach the write endpoint (implication is one-way)', async () => {
    const { token } = await mintKey(['portfolio:read']);
    const post = await request(harness.app)
      .post('/api/v1/portfolios')
      .set(bearer(token))
      .send({ name: 'R' });
    expect(post.status).toBe(403);
    expect(post.body.error.code).toBe('INSUFFICIENT_SCOPE');
  });

  it('a delegated OAuth token scoped to notifications:write can read the inbox', async () => {
    const { token } = await mintOAuthToken(['notifications:write']);
    const res = await request(harness.app).get('/api/v1/notifications').set(bearer(token));
    expect(res.status, JSON.stringify(res.body)).not.toBe(403);
  });

  it('a read-only OAuth token still cannot reach the write endpoint (one-way holds for delegated tokens too)', async () => {
    const { token } = await mintOAuthToken(['portfolio:read']);
    const post = await request(harness.app)
      .post('/api/v1/portfolios')
      .set(bearer(token))
      .send({ name: 'R' });
    expect(post.status).toBe(403);
    expect(post.body.error.code).toBe('INSUFFICIENT_SCOPE');
  });

  it('the consent screen surfaces the implied read for a write-only request', async () => {
    const user = await seedFreshUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const reg = await agent
      .post('/api/v1/settings/oauth-clients')
      .set(...XRW)
      .send({
        name: 'WriteOnly',
        redirectUris: [REDIRECT],
        scopes: ['portfolio:write'],
        public: true,
      });
    expect(reg.status, JSON.stringify(reg.body)).toBe(201);
    const clientId = createOAuthClientResponseSchema.parse(reg.body).client.clientId;

    const { challenge } = pkce();
    const details = await agent.get('/api/v1/oauth/authorization-details').query({
      client_id: clientId,
      redirect_uri: REDIRECT,
      scope: 'portfolio:write',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    expect(details.status, JSON.stringify(details.body)).toBe(200);
    const parsed = oauthAuthorizationDetailsResponseSchema.parse(details.body);
    const shown = parsed.scopes.map((s) => s.scope);
    expect(shown).toContain('portfolio:write');
    expect(shown).toContain('portfolio:read');
  });
});

describe('#405 bearer /alerts coverage — the mobile alerts 403 root cause', () => {
  /**
   * Seed a global (ownerId-null) tradable asset so an alert can be created
   * against it. `price_above` needs no reference quote, so no market stub is
   * required for the CRUD path.
   */
  async function seedAlertAsset(): Promise<string> {
    const tag = uniq();
    const [asset] = await harness.db
      .insert(schema.assets)
      .values({
        providerId: 'yahoo',
        providerRef: `REF-${tag}`,
        type: 'stock',
        symbol: `SYM${tag.slice(0, 4).toUpperCase()}`,
        name: 'Test Corp',
        currency: 'USD',
        exchange: 'NASDAQ',
      })
      .returning();
    if (!asset) throw new Error('failed to seed asset');
    return asset.id;
  }

  it('an alerts-scoped key walks the full CRUD: create → list → patch → rearm → delete', async () => {
    const { token } = await mintKey(['alerts:read', 'alerts:write']);
    const assetId = await seedAlertAsset();

    // POST /alerts — pre-fix this was 403 API_KEY_FORBIDDEN despite alerts:write.
    const created = await request(harness.app)
      .post('/api/v1/alerts')
      .set(bearer(token))
      .send({ assetId, kind: 'price_above', threshold: 150, repeat: false });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(alertSchema.safeParse(created.body).success).toBe(true);
    const alertId = created.body.id as string;

    // GET /alerts — the exact request the mobile app failed on (#405).
    const list = await request(harness.app).get('/api/v1/alerts').set(bearer(token));
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const parsed = alertListResponseSchema.parse(list.body);
    expect(parsed.items.map((a) => a.id)).toContain(alertId);

    // PATCH /alerts/{id} (write).
    const patched = await request(harness.app)
      .patch(`/api/v1/alerts/${alertId}`)
      .set(bearer(token))
      .send({ threshold: 175 });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.threshold).toBe(175);

    // POST /alerts/{id}/rearm (write).
    const rearmed = await request(harness.app)
      .post(`/api/v1/alerts/${alertId}/rearm`)
      .set(bearer(token));
    expect(rearmed.status, JSON.stringify(rearmed.body)).toBe(200);

    // DELETE /alerts/{id} (write).
    const removed = await request(harness.app)
      .delete(`/api/v1/alerts/${alertId}`)
      .set(bearer(token));
    expect(removed.status).toBe(204);
  });

  it('403 INSUFFICIENT_SCOPE (scope-gated, not API_KEY_FORBIDDEN) without alerts scopes', async () => {
    // A broadly-scoped token that merely lacks alerts:* — pre-fix the failure was
    // a blanket API_KEY_FORBIDDEN regardless of scopes.
    const { token } = await mintKey(['portfolio:read', 'social:read', 'notifications:read']);
    const assetId = await seedAlertAsset();

    const list = await request(harness.app).get('/api/v1/alerts').set(bearer(token));
    expect(list.status).toBe(403);
    expect(list.body.error.code).toBe('INSUFFICIENT_SCOPE');
    expect(list.body.error.message).toContain('alerts:read');

    const create = await request(harness.app)
      .post('/api/v1/alerts')
      .set(bearer(token))
      .send({ assetId, kind: 'price_above', threshold: 150 });
    expect(create.status).toBe(403);
    expect(create.body.error.code).toBe('INSUFFICIENT_SCOPE');
    expect(create.body.error.message).toContain('alerts:write');
  });

  it('alerts:read alone lists but cannot create (read/write split holds)', async () => {
    const { token } = await mintKey(['alerts:read']);
    const assetId = await seedAlertAsset();

    await request(harness.app).get('/api/v1/alerts').set(bearer(token)).expect(200);

    const create = await request(harness.app)
      .post('/api/v1/alerts')
      .set(bearer(token))
      .send({ assetId, kind: 'price_above', threshold: 150 });
    expect(create.status).toBe(403);
    expect(create.body.error.code).toBe('INSUFFICIENT_SCOPE');
  });

  it('alerts:write ALONE reaches the read-only GET too (write-implies-read, #371)', async () => {
    // The mobile grant may hold only the write; #371 (PR #415) means the read GET
    // must still pass with ONLY alerts:write held — asserted explicitly here.
    const { token } = await mintKey(['alerts:write']);
    const assetId = await seedAlertAsset();

    const created = await request(harness.app)
      .post('/api/v1/alerts')
      .set(bearer(token))
      .send({ assetId, kind: 'price_above', threshold: 150 });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const list = await request(harness.app).get('/api/v1/alerts').set(bearer(token));
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.items).toHaveLength(1);
  });

  it('a delegated OAuth token with alerts scopes reaches alerts too (the rail the mobile app rides)', async () => {
    const { token } = await mintOAuthToken(['alerts:read', 'alerts:write']);
    const assetId = await seedAlertAsset();

    const created = await request(harness.app)
      .post('/api/v1/alerts')
      .set(bearer(token))
      .send({ assetId, kind: 'price_above', threshold: 150 });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const list = await request(harness.app).get('/api/v1/alerts').set(bearer(token));
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(alertListResponseSchema.safeParse(list.body).success).toBe(true);
  });
});

describe('#1041 bearer /cash coverage — cash classification for mobile', () => {
  it('an OAuth bearer with cash:write walks tag, budget and rule CRUD plus reporting', async () => {
    // portfolio:read is setup-only: listing lazily creates this fresh account's
    // default portfolio. Movement/source CRUD already has bearer coverage.
    const { token } = await mintOAuthToken(['portfolio:read', 'cash:write']);
    const portfolios = await request(harness.app).get('/api/v1/portfolios').set(bearer(token));
    expect(portfolios.status, JSON.stringify(portfolios.body)).toBe(200);
    const portfolioId = (portfolios.body.portfolios as { id: string; isDefault: boolean }[]).find(
      (portfolio) => portfolio.isDefault,
    )!.id;

    const createdTag = await request(harness.app)
      .post('/api/v1/cash/tags')
      .set(bearer(token))
      .send({ name: 'Mobile dining', color: '#4477aa' });
    expect(createdTag.status, JSON.stringify(createdTag.body)).toBe(201);
    const tag = cashTagResponseSchema.parse(createdTag.body).tag;

    const tags = await request(harness.app).get('/api/v1/cash/tags').set(bearer(token));
    expect(tags.status, JSON.stringify(tags.body)).toBe(200);
    expect((tags.body.tags as { id: string }[]).some((row) => row.id === tag.id)).toBe(true);

    const patchedTag = await request(harness.app)
      .patch(`/api/v1/cash/tags/${tag.id}`)
      .set(bearer(token))
      .send({ name: 'Mobile cafés' });
    expect(cashTagResponseSchema.parse(patchedTag.body).tag.name).toBe('Mobile cafés');

    const createdBudget = await request(harness.app)
      .post('/api/v1/cash/budgets')
      .set(bearer(token))
      .send({ portfolioId, tagId: tag.id, amount: 100 });
    expect(createdBudget.status, JSON.stringify(createdBudget.body)).toBe(201);
    const budget = cashBudgetResponseSchema.parse(createdBudget.body).budget;

    const budgets = await request(harness.app)
      .get('/api/v1/cash/budgets')
      .query({ portfolioId })
      .set(bearer(token));
    expect(budgets.status, JSON.stringify(budgets.body)).toBe(200);
    expect((budgets.body.budgets as { id: string }[]).some((row) => row.id === budget.id)).toBe(
      true,
    );

    const patchedBudget = await request(harness.app)
      .patch(`/api/v1/cash/budgets/${budget.id}`)
      .set(bearer(token))
      .send({ amount: 125 });
    expect(cashBudgetResponseSchema.parse(patchedBudget.body).budget.amount).toBe(125);

    const createdRule = await request(harness.app)
      .post('/api/v1/cash/rules')
      .set(bearer(token))
      .send({ tagIds: [tag.id], matchType: 'contains', pattern: 'MOBILE CAFE' });
    expect(createdRule.status, JSON.stringify(createdRule.body)).toBe(201);
    const rule = cashRuleResponseSchema.parse(createdRule.body).rule;

    const rules = await request(harness.app).get('/api/v1/cash/rules').set(bearer(token));
    expect(rules.status, JSON.stringify(rules.body)).toBe(200);
    expect((rules.body.rules as { id: string }[]).some((row) => row.id === rule.id)).toBe(true);

    const patchedRule = await request(harness.app)
      .patch(`/api/v1/cash/rules/${rule.id}`)
      .set(bearer(token))
      .send({ tagIds: [tag.id], priority: 10 });
    expect(cashRuleResponseSchema.parse(patchedRule.body).rule.priority).toBe(10);

    const preview = await request(harness.app)
      .post('/api/v1/cash/rules/preview')
      .set(bearer(token))
      .send({ note: 'MOBILE CAFE VIENNA' });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(cashRulePreviewResponseSchema.parse(preview.body).tagIds).toEqual([tag.id]);

    const applied = await request(harness.app).post('/api/v1/cash/rules/apply').set(bearer(token));
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(cashRuleApplyResponseSchema.parse(applied.body).movementsTagged).toBe(0);

    const summary = await request(harness.app)
      .get('/api/v1/cash/summary')
      .query({ portfolioId })
      .set(bearer(token));
    expect(summary.status, JSON.stringify(summary.body)).toBe(200);
    expect(cashMonthlySummaryResponseSchema.parse(summary.body).portfolioId).toBe(portfolioId);

    const trends = await request(harness.app)
      .get('/api/v1/cash/trends')
      .query({ portfolioId, months: 2 })
      .set(bearer(token));
    expect(trends.status, JSON.stringify(trends.body)).toBe(200);
    expect(cashTrendResponseSchema.parse(trends.body).portfolioId).toBe(portfolioId);

    await request(harness.app)
      .delete(`/api/v1/cash/rules/${rule.id}`)
      .set(bearer(token))
      .expect(204);
    await request(harness.app)
      .delete(`/api/v1/cash/budgets/${budget.id}`)
      .set(bearer(token))
      .expect(204);
    await request(harness.app).delete(`/api/v1/cash/tags/${tag.id}`).set(bearer(token)).expect(204);
  });

  it('cash:read reaches reads and preview but rejects every mutation class', async () => {
    const { token } = await mintKey(['cash:read']);

    await request(harness.app).get('/api/v1/cash/tags').set(bearer(token)).expect(200);
    await request(harness.app)
      .post('/api/v1/cash/rules/preview')
      .set(bearer(token))
      .send({ note: 'read-only preview' })
      .expect(200);

    const denied = [
      await request(harness.app)
        .post('/api/v1/cash/tags')
        .set(bearer(token))
        .send({ name: 'No write' }),
      await request(harness.app)
        .patch(`/api/v1/cash/budgets/${MISSING_ID}`)
        .set(bearer(token))
        .send({ amount: 10 }),
      await request(harness.app).delete(`/api/v1/cash/rules/${MISSING_ID}`).set(bearer(token)),
      await request(harness.app).post('/api/v1/cash/rules/apply').set(bearer(token)),
    ];
    for (const res of denied) {
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_SCOPE');
      expect(res.body.error.message).toContain('cash:write');
    }
  });

  it('a bearer without cash scopes gets scope-evaluation 403, not API_KEY_FORBIDDEN', async () => {
    const { token } = await mintKey(['market:read']);
    const res = await request(harness.app).get('/api/v1/cash/tags').set(bearer(token));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INSUFFICIENT_SCOPE');
    expect(res.body.error.message).toContain('cash:read');
  });

  it('the seeded first-party mobile client authorizes and uses both cash scopes', async () => {
    const mobile = FIRST_PARTY_CLIENTS.find(
      (client) => client.clientId === 'btc_IbT1mzw_7kBiPHPkGfaE0Q',
    )!;
    expect(mobile.scopeCeiling).toEqual(expect.arrayContaining(['cash:read', 'cash:write']));
    await seedFirstPartyClients(createOAuthRepository(harness.db));

    const user = await seedFreshUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const { verifier, challenge } = pkce();
    const authorize = {
      client_id: mobile.clientId,
      redirect_uri: mobile.redirectUris[0],
      scope: 'cash:read cash:write',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    };

    const detailsRes = await agent.get('/api/v1/oauth/authorization-details').query(authorize);
    expect(detailsRes.status, JSON.stringify(detailsRes.body)).toBe(200);
    const details = oauthAuthorizationDetailsResponseSchema.parse(detailsRes.body);
    expect(details.client.firstParty).toBe(true);
    expect(details.scopes.map((scope) => scope.scope)).toEqual(['cash:read', 'cash:write']);

    const approval = await agent
      .post('/api/v1/oauth/authorize')
      .set(...XRW)
      .send(authorize);
    expect(approval.status, JSON.stringify(approval.body)).toBe(200);
    const code = new URL(approval.body.redirectTo as string).searchParams.get('code');
    expect(code).toBeTruthy();

    const tokenRes = await request(harness.app).post('/api/v1/oauth/token').send({
      grant_type: 'authorization_code',
      code,
      redirect_uri: mobile.redirectUris[0],
      client_id: mobile.clientId,
      code_verifier: verifier,
    });
    expect(tokenRes.status, JSON.stringify(tokenRes.body)).toBe(200);
    const mobileToken = oauthTokenResponseSchema.parse(tokenRes.body).access_token;
    await request(harness.app).get('/api/v1/cash/tags').set(bearer(mobileToken)).expect(200);
  });
});

describe('#730/#1043 paranoid transitions stay session-only beside bearer vault sync', () => {
  // Both directions of the privacy-mode transition and the vault media they act
  // on. Enable hard-deletes every cleartext row and revokes every share with no
  // undo; disable writes a caller-authored document back into the account. The
  // policy table's `/account/` branch classified them as `account:security` —
  // a scope a third-party OAuth app can plausibly hold for a sessions/2FA
  // integration — so both were reachable by a bearer, without CSRF, on nothing
  // but the caller's own Drive attestation.
  const SESSION_ONLY: { name: string; method: 'get' | 'post' | 'put' | 'patch'; path: string }[] = [
    { name: 'paranoid enable', method: 'post', path: '/account/paranoid/enable' },
    { name: 'paranoid disable', method: 'post', path: '/account/paranoid/disable' },
    { name: 'fork provenance', method: 'get', path: '/account/paranoid/fork-provenance' },
    { name: 'normal revision', method: 'get', path: '/account/paranoid/normal-revision' },
    // #1043 admits opaque sync only. Media changes and recovery-media lifecycle
    // still belong exclusively to the owning browser session.
    { name: 'vault media transition', method: 'patch', path: '/vault/media' },
    { name: 'retired vault purge', method: 'post', path: '/vault/media/retired/purge' },
  ];

  const ENABLE_BODY = {
    mediaSet: ['drive'],
    vaultVersion: 1,
    driveAttestation: { verifiedRoundTrip: true, vaultVersion: 1 },
    normalDataRevision: 'capture-token',
  };

  const call = (token: string, row: (typeof SESSION_ONLY)[number]) => {
    const url = `/api/v1${row.path}`;
    const base = request(harness.app);
    const started =
      row.method === 'get'
        ? base.get(url)
        : row.method === 'put'
          ? base.put(url)
          : row.method === 'patch'
            ? base.patch(url)
            : base.post(url);
    return started.set(bearer(token)).send(ENABLE_BODY);
  };

  it.each(SESSION_ONLY)(
    'a personal key holding account:security gets 403 API_KEY_FORBIDDEN: $name',
    async (row) => {
      const { token } = await mintKey(['account:security', 'vault:sync']);
      const res = await call(token, row);
      expect(res.status, `${row.method} ${row.path} → ${JSON.stringify(res.body)}`).toBe(403);
      expect(res.body.error.code).toBe('API_KEY_FORBIDDEN');
    },
  );

  it.each(SESSION_ONLY)(
    'a delegated OAuth token holding account:security gets 403 API_KEY_FORBIDDEN: $name',
    async (row) => {
      const { token } = await mintOAuthToken(['account:security', 'vault:sync']);
      const res = await call(token, row);
      expect(res.status, `${row.method} ${row.path} → ${JSON.stringify(res.body)}`).toBe(403);
      expect(res.body.error.code).toBe('API_KEY_FORBIDDEN');
    },
  );

  it('the refusal survives a variant-cased path, which Express routes to the same handler', async () => {
    // Express matches routes case-insensitively, so `/Account/Paranoid/enable`
    // reaches the identical handler. A policy table that compared the raw path
    // would fall through this carve-out onto the coarse `/account/` scope row and
    // hand the destructive route right back to the bearer.
    const { token } = await mintKey(['account:security', 'vault:sync']);
    for (const path of [
      '/api/v1/Account/Paranoid/enable',
      '/api/v1/account/PARANOID/disable',
      '/api/v1/Vault',
    ]) {
      const res = await request(harness.app).post(path).set(bearer(token)).send(ENABLE_BODY);
      expect(res.status, `POST ${path} → ${JSON.stringify(res.body)}`).toBe(403);
      expect(res.body.error.code, `POST ${path}`).toBe('API_KEY_FORBIDDEN');
    }
  });

  it('the policy TABLE itself refuses them, independently of the router’s local guard', () => {
    // Both layers now say no: the global table (asserted here, and again through
    // the derived OpenAPI `security` in openapi.test.ts) and the per-route
    // `requireOwnerBrowserSession` in accountRoutes. Pinning the table directly
    // means a regression there is still caught even though the local guard would
    // keep the end-to-end 403s above green.
    for (const [method, path] of [
      ['POST', '/account/paranoid/enable'],
      ['POST', '/account/paranoid/disable'],
      ['GET', '/account/paranoid/fork-provenance'],
      ['GET', '/account/paranoid/normal-revision'],
      ['PATCH', '/vault/media'],
      ['POST', '/vault/media/retired/purge'],
    ] as const) {
      expect(pathAcceptsBearer(path, method), `${method} ${path}`).toBe(false);
    }
    // …while the coarse account-security surface and exact sync exception are untouched.
    for (const path of ['/account', '/account/export', '/auth/sessions', '/auth/2fa/status']) {
      expect(pathAcceptsBearer(path), `pathAcceptsBearer(${path})`).toBe(true);
    }
    expect(pathAcceptsBearer('/vault', 'GET')).toBe(true);
    expect(pathAcceptsBearer('/vault', 'PUT')).toBe(true);
    expect(pathAcceptsBearer('/vault/media', 'GET')).toBe(true);
  });

  it('the carve-out is surgical: the rest of the account-security surface stays bearer-callable', async () => {
    const { token } = await mintKey(['account:security']);
    await request(harness.app).get('/api/v1/auth/sessions').set(bearer(token)).expect(200);
    await request(harness.app).get('/api/v1/account/export').set(bearer(token)).expect(200);
  });

  it('CSRF is the live gate for the cookie session that owns these routes', async () => {
    // With the bearer refused, the browser cookie session is the ONLY caller —
    // so its own mutation guard has to be asserted, not assumed.
    const user = await seedFreshUser();
    const agent = await loginAgent(harness.app, user.email, user.password);

    for (const path of ['/api/v1/account/paranoid/enable', '/api/v1/account/paranoid/disable']) {
      const noHeader = await agent.post(path).send(ENABLE_BODY);
      expect(noHeader.status, `${path} without X-Requested-With`).toBe(403);
      expect(noHeader.body.error.code).toBe('CSRF_HEADER_REQUIRED');

      const foreignOrigin = await agent
        .post(path)
        .set(...XRW)
        .set('Origin', 'https://evil.example')
        .send(ENABLE_BODY);
      expect(foreignOrigin.status, `${path} from a foreign origin`).toBe(403);
      expect(foreignOrigin.body.error.code).toBe('CSRF_ORIGIN_REJECTED');
    }

    // And the same session DOES reach the handler once it carries the header:
    // a malformed body is answered by validation (400), not by the policy rail —
    // proof the 403s above are the guard, not an unreachable route.
    const reached = await agent
      .post('/api/v1/account/paranoid/enable')
      .set(...XRW)
      .send({ mediaSet: [] });
    expect(reached.status, JSON.stringify(reached.body)).toBe(400);
  });
});
