import { createHash, randomBytes } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import type { Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  API_KEY_SCOPES,
  createApiKeyResponseSchema,
  createOAuthClientResponseSchema,
  oauthGrantListResponseSchema,
  oauthTokenResponseSchema,
  type ApiKeyScope,
} from '@bettertrack/contracts';

import { createOAuthRepository } from '../data/repositories/oauthRepository';
import * as schema from '../data/schema';
import { openApiPathTemplateAcceptsBearer, pathAcceptsBearer } from '../http/middleware/bearerAuth';
import { requireCookieSessionOrFirstPartyOAuthGrant } from '../http/routes/settingsRoutes';
import { FIRST_PARTY_CLIENTS, seedFirstPartyClients } from '../services/oauth/firstPartyClients';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const THIRD_PARTY_REDIRECT = 'https://third-party.example/callback';
const MISSING_ID = '00000000-0000-0000-0000-000000000000';
const MOBILE = FIRST_PARTY_CLIENTS.find(
  (client) => client.clientId === 'btc_IbT1mzw_7kBiPHPkGfaE0Q',
)!;

const EXPECTED_SCOPES = [
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
] as const satisfies readonly ApiKeyScope[];

type Agent = ReturnType<typeof request.agent>;
type TestUser = Awaited<ReturnType<TestHarness['seedUser']>>;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
  await seedFirstPartyClients(createOAuthRepository(harness.db));
});

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
  };
}

async function seedFreshUser(): Promise<TestUser> {
  const tag = randomBytes(5).toString('hex');
  return harness.seedUser({
    email: `grant-bearer-${tag}@bettertrack.test`,
    username: `grantbearer${tag}`,
  });
}

async function login(user: TestUser): Promise<Agent> {
  const agent = request.agent(harness.app);
  const response = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier: user.email, password: user.password });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return agent;
}

async function issuePublicClientToken(input: {
  agent: Agent;
  userId: string;
  clientId: string;
  redirectUri: string;
  scopes: readonly ApiKeyScope[];
}): Promise<{ token: string; grantId: string; firstParty: boolean }> {
  const { verifier, challenge } = pkce();
  const authorize = {
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: input.scopes.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
  };
  const approved = await input.agent
    .post('/api/v1/oauth/authorize')
    .set(...XRW)
    .send(authorize);
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  const code = new URL(approved.body.redirectTo as string).searchParams.get('code');
  expect(code).toBeTruthy();

  const exchanged = await request(harness.app).post('/api/v1/oauth/token').send({
    grant_type: 'authorization_code',
    code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    code_verifier: verifier,
  });
  expect(exchanged.status, JSON.stringify(exchanged.body)).toBe(200);
  const token = oauthTokenResponseSchema.parse(exchanged.body).access_token;

  const grants = await createOAuthRepository(harness.db).listGrantsForUser(input.userId);
  const row = grants.find(({ client }) => client.clientId === input.clientId);
  expect(row).toBeDefined();
  return {
    token,
    grantId: row!.grant.id,
    firstParty: row!.client.isFirstParty,
  };
}

async function mintFirstPartyToken(
  scopes: readonly ApiKeyScope[],
  existingUser?: TestUser,
): Promise<{
  token: string;
  grantId: string;
  user: TestUser;
  agent: Agent;
}> {
  const user = existingUser ?? (await seedFreshUser());
  const agent = await login(user);
  const issued = await issuePublicClientToken({
    agent,
    userId: user.id,
    clientId: MOBILE.clientId,
    redirectUri: MOBILE.redirectUris[0]!,
    scopes,
  });
  expect(issued.firstParty).toBe(true);
  return { token: issued.token, grantId: issued.grantId, user, agent };
}

async function mintThirdPartyToken(scopes: readonly ApiKeyScope[]): Promise<{
  token: string;
  grantId: string;
  user: TestUser;
}> {
  const user = await seedFreshUser();
  const agent = await login(user);
  const registered = await agent
    .post('/api/v1/settings/oauth-clients')
    .set(...XRW)
    .send({
      name: 'Throwaway third party',
      redirectUris: [THIRD_PARTY_REDIRECT],
      scopes,
      public: true,
    });
  expect(registered.status, JSON.stringify(registered.body)).toBe(201);
  const client = createOAuthClientResponseSchema.parse(registered.body).client;
  const issued = await issuePublicClientToken({
    agent,
    userId: user.id,
    clientId: client.clientId,
    redirectUri: THIRD_PARTY_REDIRECT,
    scopes,
  });
  // This is the real row created by the public registration flow, not a mocked flag.
  expect(issued.firstParty).toBe(false);
  return { token: issued.token, grantId: issued.grantId, user };
}

async function mintPersonalKey(scopes: readonly ApiKeyScope[]): Promise<{
  token: string;
  id: string;
}> {
  const user = await seedFreshUser();
  const agent = await login(user);
  const response = await agent
    .post('/api/v1/settings/api-keys')
    .set(...XRW)
    .send({ name: 'Grant probe', scopes });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  const parsed = createApiKeyResponseSchema.parse(response.body);
  return { token: parsed.token, id: parsed.key.id };
}

describe('#1325 first-party OAuth grant management', () => {
  it('lists grants and lets the calling first-party grant revoke itself immediately', async () => {
    const { token, grantId } = await mintFirstPartyToken(['account:security']);
    expect((await harness.ctx.oauth.authenticateToken(token))?.firstParty).toBe(true);

    const listed = await request(harness.app)
      .get('/api/v1/settings/oauth-grants')
      .set(bearer(token));
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(oauthGrantListResponseSchema.parse(listed.body).grants.map((grant) => grant.id)).toEqual(
      [grantId],
    );

    await request(harness.app)
      .delete(`/api/v1/settings/oauth-grants/${grantId}`)
      .set(bearer(token))
      .expect(204);

    const after = await request(harness.app).get('/api/v1/auth/me').set(bearer(token));
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('API_KEY_INVALID');
    const [stored] = await harness.db
      .select({ revokedAt: schema.oauthGrants.revokedAt })
      .from(schema.oauthGrants)
      .where(eq(schema.oauthGrants.id, grantId));
    expect(stored?.revokedAt).toBeInstanceOf(Date);
  });

  it('refuses a real third-party client on list and revoke and audits both probes', async () => {
    const { token, grantId, user } = await mintThirdPartyToken(['account:security']);
    expect((await harness.ctx.oauth.authenticateToken(token))?.firstParty).toBe(false);

    const responses = [
      await request(harness.app).get('/api/v1/settings/oauth-grants').set(bearer(token)),
      await request(harness.app)
        .delete(`/api/v1/settings/oauth-grants/${grantId}`)
        .set(bearer(token)),
    ];
    for (const response of responses) {
      expect(response.status, JSON.stringify(response.body)).toBe(403);
      expect(response.body.error.code).toBe('API_KEY_FORBIDDEN');
      expect(response.body.error.message).toContain('first-party OAuth clients only');
    }

    const denials = await harness.db
      .select({ meta: schema.auditLog.meta })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.actorId, user.id),
          eq(schema.auditLog.targetId, grantId),
          eq(schema.auditLog.action, 'api_key.scope_denied'),
        ),
      );
    expect(denials).toHaveLength(2);
    expect(denials.map(({ meta }) => meta)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ requiredScope: 'account:security', method: 'GET' }),
        expect.objectContaining({ requiredScope: 'account:security', method: 'DELETE' }),
      ]),
    );
    await request(harness.app).get('/api/v1/auth/me').set(bearer(token)).expect(200);
  });

  it('refuses a personal key holding account:security on list and revoke', async () => {
    const { token } = await mintPersonalKey(['account:security']);
    for (const response of [
      await request(harness.app).get('/api/v1/settings/oauth-grants').set(bearer(token)),
      await request(harness.app)
        .delete(`/api/v1/settings/oauth-grants/${MISSING_ID}`)
        .set(bearer(token)),
    ]) {
      expect(response.status, JSON.stringify(response.body)).toBe(403);
      expect(response.body.error.code).toBe('API_KEY_FORBIDDEN');
      expect(response.body.error.message).toContain('first-party OAuth clients only');
    }
  });

  it('reports INSUFFICIENT_SCOPE before first-party policy when the mobile token lacks it', async () => {
    const { token, grantId } = await mintFirstPartyToken(['market:read']);
    for (const response of [
      await request(harness.app).get('/api/v1/settings/oauth-grants').set(bearer(token)),
      await request(harness.app)
        .delete(`/api/v1/settings/oauth-grants/${grantId}`)
        .set(bearer(token)),
    ]) {
      expect(response.status, JSON.stringify(response.body)).toBe(403);
      expect(response.body.error.code).toBe('INSUFFICIENT_SCOPE');
      expect(response.body.error.message).toContain('account:security');
    }
    await request(harness.app).get('/api/v1/auth/me').set(bearer(token)).expect(200);
  });

  it('keeps list and revoke repository-scoped to the bearer owner', async () => {
    const caller = await mintFirstPartyToken(['account:security']);
    const other = await mintFirstPartyToken(['account:security']);

    const listed = oauthGrantListResponseSchema.parse(
      (await request(harness.app).get('/api/v1/settings/oauth-grants').set(bearer(caller.token)))
        .body,
    );
    expect(listed.grants.map((grant) => grant.id)).toEqual([caller.grantId]);
    expect(listed.grants.map((grant) => grant.id)).not.toContain(other.grantId);

    const crossed = await request(harness.app)
      .delete(`/api/v1/settings/oauth-grants/${other.grantId}`)
      .set(bearer(caller.token));
    expect(crossed.status, JSON.stringify(crossed.body)).toBe(404);
    expect(crossed.body.error.code).toBe('OAUTH_GRANT_NOT_FOUND');

    // The repository predicate rejected the foreign id; its owner is still live.
    await request(harness.app).get('/api/v1/auth/me').set(bearer(other.token)).expect(200);
    const otherList = await request(harness.app)
      .get('/api/v1/settings/oauth-grants')
      .set(bearer(other.token));
    expect(oauthGrantListResponseSchema.parse(otherList.body).grants[0]?.id).toBe(other.grantId);
  });

  it('keeps the router-local guard route-, scope-, kind- and first-party-aware', () => {
    const call = (input: {
      apiKey?: Request['apiKey'];
      sessionId?: string;
      method: string;
      path: string;
    }) => {
      const next = vi.fn();
      requireCookieSessionOrFirstPartyOAuthGrant(input as unknown as Request, {} as Response, next);
      return next;
    };
    const trusted: NonNullable<Request['apiKey']> = {
      id: 'grant',
      scopes: ['account:security'],
      kind: 'oauth',
      firstParty: true,
      securityGeneration: 0,
    };

    expect(
      call({ sessionId: 'session', method: 'GET', path: '/oauth-grants' }),
    ).toHaveBeenCalledWith();
    expect(
      call({ apiKey: trusted, method: 'DELETE', path: `/oauth-grants/${MISSING_ID}` }),
    ).toHaveBeenCalledWith();

    for (const apiKey of [
      { ...trusted, firstParty: false },
      { ...trusted, kind: 'personal' as const, firstParty: false },
      { ...trusted, scopes: ['market:read'] },
    ]) {
      expect(
        call({ apiKey, method: 'GET', path: '/oauth-grants' }).mock.calls[0]?.[0],
      ).toMatchObject({ statusCode: 403, code: 'API_KEY_FORBIDDEN' });
    }
    expect(
      call({ apiKey: trusted, method: 'GET', path: '/oauth-grants/future-admin' }).mock
        .calls[0]?.[0],
    ).toMatchObject({ statusCode: 403, code: 'API_KEY_FORBIDDEN' });
  });

  it('pins the exact bearer carve-out and leaves sibling credential paths session-only', () => {
    expect(pathAcceptsBearer('/settings/oauth-grants', 'GET')).toBe(true);
    expect(pathAcceptsBearer(`/settings/oauth-grants/${MISSING_ID}`, 'DELETE')).toBe(true);
    expect(openApiPathTemplateAcceptsBearer('/settings/oauth-grants/{id}', 'DELETE')).toBe(true);
    expect(pathAcceptsBearer('/settings/oauth-grants', 'POST')).toBe(false);

    for (const [method, path] of [
      ['GET', '/settings/api-keys'],
      ['POST', '/settings/api-keys'],
      ['DELETE', `/settings/api-keys/${MISSING_ID}`],
      ['GET', '/settings/oauth-clients'],
      ['POST', '/settings/oauth-clients'],
      ['DELETE', `/settings/oauth-clients/${MISSING_ID}`],
      ['GET', '/settings/webhooks'],
      ['POST', '/settings/webhooks'],
      ['DELETE', `/settings/webhooks/${MISSING_ID}`],
    ] as const) {
      expect(pathAcceptsBearer(path, method), `${method} ${path}`).toBe(false);
    }
  });

  it('does not add a scope or widen the seeded first-party client definition', () => {
    expect(API_KEY_SCOPES).toEqual(EXPECTED_SCOPES);
    expect(FIRST_PARTY_CLIENTS).toEqual([
      {
        clientId: 'btc_IbT1mzw_7kBiPHPkGfaE0Q',
        name: 'BetterTrackMobile',
        redirectUris: ['bettertrack://oauth/callback'],
        public: true,
        scopeCeiling: EXPECTED_SCOPES,
      },
    ]);
  });
});
