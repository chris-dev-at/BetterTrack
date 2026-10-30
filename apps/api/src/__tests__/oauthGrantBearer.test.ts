import { createHash, randomBytes } from 'node:crypto';

import type { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import type { Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  API_KEY_SCOPES,
  createApiKeyResponseSchema,
  createOAuthClientResponseSchema,
  oauthGrantListResponseSchema,
  oauthTokenResponseSchema,
  twoFactorEnrollResponseSchema,
  withoutOAuthFirstPartyOnlyScopes,
  type ApiKeyScope,
} from '@bettertrack/contracts';

import type { Database } from '../data/db';
import { createAuditRepository } from '../data/repositories/auditRepository';
import { createOAuthRepository } from '../data/repositories/oauthRepository';
import * as schema from '../data/schema';
import { openApiPathTemplateAcceptsBearer, pathAcceptsBearer } from '../http/middleware/bearerAuth';
import { requireCookieSessionOrFirstPartyOAuthGrant } from '../http/routes/settingsRoutes';
import { AuditAction, createAuditService } from '../services/audit/auditService';
import { generateTotpCode } from '../services/auth/totp';
import { hashToken } from '../services/crypto/tokens';
import type { MailTransport, OutgoingMail } from '../services/email/transport';
import {
  BETTERTRACK_MOBILE_GOOGLE_LINK_REDIRECT_URI,
  FIRST_PARTY_CLIENTS,
  seedFirstPartyClients,
} from '../services/oauth/firstPartyClients';
import { createOAuthService } from '../services/oauth/oauthService';
import { createTestApp, type TestHarness } from '../testing/createTestApp';
import {
  simulateThirdPartyCeilingRegression,
  storeAsPreRuleThirdPartyApp,
} from './thirdPartyCeilingRegression';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const THIRD_PARTY_REDIRECT = 'https://third-party.example/callback';
const OFFICIAL_REDIRECT = 'https://official.example/callback';
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
  'feedback:read',
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
}): Promise<{ token: string; refreshToken: string; grantId: string; firstParty: boolean }> {
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
  const pair = oauthTokenResponseSchema.parse(exchanged.body);
  const token = pair.access_token;

  const grants = await createOAuthRepository(harness.db).listGrantsForUser(input.userId);
  const row = grants.find(({ client }) => client.clientId === input.clientId);
  expect(row).toBeDefined();
  return {
    token,
    refreshToken: pair.refresh_token,
    grantId: row!.grant.id,
    firstParty: row!.client.isFirstParty,
  };
}

async function mintFirstPartyToken(
  scopes: readonly ApiKeyScope[],
  existing?: { user: TestUser; agent: Agent },
): Promise<{
  token: string;
  refreshToken: string;
  grantId: string;
  user: TestUser;
  agent: Agent;
}> {
  const user = existing?.user ?? (await seedFreshUser());
  const agent = existing?.agent ?? (await login(user));
  const issued = await issuePublicClientToken({
    agent,
    userId: user.id,
    clientId: MOBILE.clientId,
    redirectUri: MOBILE.redirectUris[0]!,
    scopes,
  });
  expect(issued.firstParty).toBe(true);
  return {
    token: issued.token,
    refreshToken: issued.refreshToken,
    grantId: issued.grantId,
    user,
    agent,
  };
}

/**
 * A grant on an app the user registered — genuinely third-party. A third-party
 * app can no longer hold `account:security`, so a request for it
 * builds the only state that still could: an app and grant stored before the
 * rule, plus a simulated regression of the ceiling for this one grant. That
 * keeps the grant routes' own first-party-only rail pinned BEHIND the ceiling.
 */
async function mintThirdPartyToken(
  scopes: readonly ApiKeyScope[],
  existing?: { user: TestUser; agent: Agent },
): Promise<{
  token: string;
  grantId: string;
  user: TestUser;
  agent: Agent;
}> {
  const user = existing?.user ?? (await seedFreshUser());
  const agent = existing?.agent ?? (await login(user));
  const ordinary = withoutOAuthFirstPartyOnlyScopes(scopes);
  const registrable: readonly ApiKeyScope[] = ordinary.length > 0 ? ordinary : ['market:read'];
  const registered = await agent
    .post('/api/v1/settings/oauth-clients')
    .set(...XRW)
    .send({
      name: 'Throwaway third party',
      redirectUris: [THIRD_PARTY_REDIRECT],
      scopes: registrable,
      public: true,
    });
  expect(registered.status, JSON.stringify(registered.body)).toBe(201);
  const client = createOAuthClientResponseSchema.parse(registered.body).client;
  const issued = await issuePublicClientToken({
    agent,
    userId: user.id,
    clientId: client.clientId,
    redirectUri: THIRD_PARTY_REDIRECT,
    scopes: registrable,
  });
  // This is the real row created by the public registration flow, not a mocked flag.
  expect(issued.firstParty).toBe(false);
  if (ordinary.length !== scopes.length) {
    await storeAsPreRuleThirdPartyApp(harness, {
      clientId: client.clientId,
      grantId: issued.grantId,
      scopes,
    });
    simulateThirdPartyCeilingRegression(harness, { grantId: issued.grantId, scopes });
  }
  return { token: issued.token, grantId: issued.grantId, user, agent };
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
  it('annotates the current first-party grant and lets it revoke itself at logout', async () => {
    const { token, grantId, user, agent } = await mintFirstPartyToken(['account:security']);
    const sibling = await mintThirdPartyToken(['market:read'], { user, agent });
    expect((await harness.ctx.oauth.authenticateToken(token))?.firstParty).toBe(true);

    const listed = await request(harness.app)
      .get('/api/v1/settings/oauth-grants')
      .set(bearer(token));
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const grants = oauthGrantListResponseSchema.parse(listed.body).grants;
    expect(grants).toHaveLength(2);
    expect(grants.find((grant) => grant.id === grantId)).toMatchObject({
      firstParty: true,
      current: true,
    });
    expect(grants.find((grant) => grant.id === sibling.grantId)).toMatchObject({
      firstParty: false,
      current: false,
    });
    expect(grants.filter((grant) => grant.id !== grantId).every((grant) => !grant.current)).toBe(
      true,
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

  it('keeps DELETE /settings/oauth-grants/:id GRANT-WIDE across installs (unlike bearer logout)', async () => {
    // Two installs of the first-party app for one user: two token families on
    // the one reused grant (§16 2026-10-29).
    const first = await mintFirstPartyToken(['account:security']);
    const second = await mintFirstPartyToken(['account:security'], {
      user: first.user,
      agent: first.agent,
    });
    expect(second.grantId).toBe(first.grantId);
    const families = await harness.db
      .select()
      .from(schema.oauthTokenFamilies)
      .where(eq(schema.oauthTokenFamilies.grantId, first.grantId));
    expect(families).toHaveLength(2);

    // Install 2 revokes the APP from its settings screen: every install goes.
    await request(harness.app)
      .delete(`/api/v1/settings/oauth-grants/${first.grantId}`)
      .set(bearer(second.token))
      .expect(204);
    for (const token of [first.token, second.token]) {
      const after = await request(harness.app).get('/api/v1/auth/me').set(bearer(token));
      expect(after.status).toBe(401);
    }
    const [stored] = await harness.db
      .select({ revokedAt: schema.oauthGrants.revokedAt })
      .from(schema.oauthGrants)
      .where(eq(schema.oauthGrants.id, first.grantId));
    expect(stored?.revokedAt).toBeInstanceOf(Date);
  });

  it('marks every grant non-current for a cookie caller and keeps browser revocation enabled', async () => {
    const { token, grantId, agent } = await mintFirstPartyToken(['account:security']);

    const listed = await agent.get('/api/v1/settings/oauth-grants');
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(oauthGrantListResponseSchema.parse(listed.body).grants).toEqual([
      expect.objectContaining({ id: grantId, firstParty: true, current: false }),
    ]);

    await agent
      .delete(`/api/v1/settings/oauth-grants/${grantId}`)
      .set(...XRW)
      .expect(204);
    await request(harness.app).get('/api/v1/auth/me').set(bearer(token)).expect(401);
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
    // The refused grant HOLDS `account:security`: without the discriminator the
    // rows would be indistinguishable from a genuine missing-scope denial, and
    // "third-party app probed another app's grants" would not be greppable.
    expect(denials.map(({ meta }) => meta)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requiredScope: 'account:security',
          reason: 'first-party-only',
          method: 'GET',
          path: '/settings/oauth-grants',
        }),
        expect.objectContaining({
          requiredScope: 'account:security',
          reason: 'first-party-only',
          method: 'DELETE',
          path: `/settings/oauth-grants/${grantId}`,
        }),
      ]),
    );
    await request(harness.app).get('/api/v1/auth/me').set(bearer(token)).expect(200);
  });

  it('separates a first-party-only refusal from a genuine missing scope in the audit meta', async () => {
    const unscoped = await mintThirdPartyToken(['market:read']);

    const denied = await request(harness.app)
      .get('/api/v1/settings/oauth-grants')
      .set(bearer(unscoped.token));
    // Scope is evaluated BEFORE the trust boundary: an unscoped third party is
    // told what it lacks, and the audit row says so. Pinning this locks the
    // deliberate ordering against a future reshuffle.
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(denied.body.error.code).toBe('INSUFFICIENT_SCOPE');
    expect(denied.body.error.message).toContain('account:security');

    const [row] = await harness.db
      .select({ meta: schema.auditLog.meta })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.actorId, unscoped.user.id),
          eq(schema.auditLog.action, 'api_key.scope_denied'),
        ),
      );
    expect(row?.meta).toMatchObject({
      requiredScope: 'account:security',
      reason: 'insufficient-scope',
      method: 'GET',
      path: '/settings/oauth-grants',
    });
  });

  it('redacts the sibling OAuth denial path for a paranoid account', async () => {
    const { token, grantId, user } = await mintThirdPartyToken(['account:security']);
    await harness.db
      .update(schema.users)
      .set({
        privacyMode: 'paranoid',
        paranoidMediaSet: ['drive'],
        paranoidDriveAttestedVersion: 1,
      })
      .where(eq(schema.users.id, user.id));

    const response = await request(harness.app)
      .delete(`/api/v1/settings/oauth-grants/${grantId}`)
      .set(bearer(token));
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('API_KEY_FORBIDDEN');

    const [denial] = await harness.db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.actorId, user.id),
          eq(schema.auditLog.action, 'api_key.scope_denied'),
        ),
      );
    expect(denial?.meta).toMatchObject({
      kind: 'oauth',
      path: '[redacted-resource-path]',
    });
    expect(JSON.stringify(denial?.meta)).not.toContain(grantId);
  });

  it('refuses a personal key holding account:security on list and revoke', async () => {
    const { token, id } = await mintPersonalKey(['account:security']);
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

    // Same discriminator for the personal-key principal, on its own audit rail.
    const denials = await harness.db
      .select({ meta: schema.auditLog.meta })
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.targetId, id), eq(schema.auditLog.action, 'api_key.scope_denied')),
      );
    expect(denials).toHaveLength(2);
    for (const { meta } of denials) {
      expect(meta).toMatchObject({
        requiredScope: 'account:security',
        reason: 'first-party-only',
      });
    }
  });

  it('lets a first-party bearer revoke the same user’s third-party grant', async () => {
    const trusted = await mintFirstPartyToken(['account:security']);
    const thirdParty = await mintThirdPartyToken(['market:read'], {
      user: trusted.user,
      agent: trusted.agent,
    });
    await request(harness.app).get('/api/v1/auth/me').set(bearer(thirdParty.token)).expect(200);

    await request(harness.app)
      .delete(`/api/v1/settings/oauth-grants/${thirdParty.grantId}`)
      .set(bearer(trusted.token))
      .expect(204);

    // The revoked app's live token dies with its grant; the revoking first-party
    // token is untouched — this is the use case the carve-out exists for.
    const orphaned = await request(harness.app)
      .get('/api/v1/auth/me')
      .set(bearer(thirdParty.token));
    expect(orphaned.status, JSON.stringify(orphaned.body)).toBe(401);
    expect(orphaned.body.error.code).toBe('API_KEY_INVALID');
    await request(harness.app).get('/api/v1/auth/me').set(bearer(trusted.token)).expect(200);

    const [stored] = await harness.db
      .select({ revokedAt: schema.oauthGrants.revokedAt })
      .from(schema.oauthGrants)
      .where(eq(schema.oauthGrants.id, thirdParty.grantId));
    expect(stored?.revokedAt).toBeInstanceOf(Date);
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

  it('keeps the router-local guard route-, scope-, kind- and first-party-aware', async () => {
    // A real account: the twin now writes an `api_key.scope_denied` row, and
    // `audit_log.actor_id` is a foreign key onto `users`.
    const user = await seedFreshUser();
    const guard = requireCookieSessionOrFirstPartyOAuthGrant(harness.ctx);
    // ORDER BY is not optional here (the #514 lesson in this same file):
    // Postgres never guarantees SELECT order, and these assertions read the rows
    // as a sequence. `id` is a UUIDv7, so ascending id IS write order.
    const auditRows = () =>
      harness.db
        .select()
        .from(schema.auditLog)
        .where(
          and(
            eq(schema.auditLog.actorId, user.id),
            eq(schema.auditLog.action, 'api_key.scope_denied'),
          ),
        )
        .orderBy(schema.auditLog.id);
    const call = async (input: {
      apiKey?: Request['apiKey'];
      sessionId?: string;
      method: string;
      path: string;
    }) => {
      const next = vi.fn();
      guard({ ...input, authUser: { id: user.id } } as unknown as Request, {} as Response, next);
      // The audited branches reach `next` only after the audit write resolves.
      await vi.waitFor(() => expect(next).toHaveBeenCalled());
      return next;
    };
    const trusted: NonNullable<Request['apiKey']> = {
      id: '11111111-1111-4111-8111-111111111111',
      scopes: ['account:security'],
      kind: 'oauth',
      firstParty: true,
      securityGeneration: 0,
    };

    expect(
      await call({ sessionId: 'session', method: 'GET', path: '/oauth-grants' }),
    ).toHaveBeenCalledWith();
    expect(
      await call({ apiKey: trusted, method: 'DELETE', path: `/oauth-grants/${MISSING_ID}` }),
    ).toHaveBeenCalledWith();
    // Nothing admitted is ever audited.
    expect(await auditRows()).toHaveLength(0);

    // Trust-boundary refusals: the credential is NOT a trusted first-party
    // client, so the first-party-only message is the accurate one.
    for (const apiKey of [
      { ...trusted, firstParty: false },
      { ...trusted, kind: 'personal' as const, firstParty: false },
    ]) {
      expect(
        (await call({ apiKey, method: 'GET', path: '/oauth-grants' })).mock.calls[0]?.[0],
      ).toMatchObject({
        statusCode: 403,
        code: 'API_KEY_FORBIDDEN',
        message: expect.stringContaining('first-party OAuth clients only'),
      });
    }
    // #1951 §2: both HELD `account:security` and were refused for being
    // untrusted — the one refusal shape the discriminator exists to name.
    expect((await auditRows()).map((row) => (row.meta as { reason?: string }).reason)).toEqual([
      'first-party-only',
      'first-party-only',
    ]);

    // A trusted client on an allowlisted route that merely lacks the scope is a
    // scope problem, not a trust problem — the twin must not misdescribe it if
    // the global table ever regresses and this fallback answers first.
    expect(
      (
        await call({
          apiKey: { ...trusted, scopes: ['market:read'] },
          method: 'GET',
          path: '/oauth-grants',
        })
      ).mock.calls[0]?.[0],
    ).toMatchObject({
      statusCode: 403,
      code: 'INSUFFICIENT_SCOPE',
      message: expect.stringContaining('account:security'),
    });
    expect((await auditRows()).at(-1)?.meta).toMatchObject({
      reason: 'insufficient-scope',
      requiredScope: 'account:security',
      method: 'GET',
      path: '/settings/oauth-grants',
      kind: 'oauth',
    });

    // Off-allowlist route: still the first-party-only refusal, scope or not.
    for (const apiKey of [trusted, { ...trusted, scopes: ['market:read'] }]) {
      expect(
        (await call({ apiKey, method: 'GET', path: '/oauth-grants/future-admin' })).mock
          .calls[0]?.[0],
      ).toMatchObject({ statusCode: 403, code: 'API_KEY_FORBIDDEN' });
    }
    // …and NOT audited as a scope denial: an off-allowlist path is not a bearer
    // surface at all, which is exactly how the global rail classifies it.
    expect(await auditRows()).toHaveLength(3);
  });

  it('audits an untrusted-but-unscoped refusal by the cause, not by the answer', async () => {
    // The compound case: a personal key that is neither trusted NOR scoped. The
    // ANSWER stays `API_KEY_FORBIDDEN` — telling an untrusted caller "you are
    // only missing a scope" would hand it an actionable hint about a route
    // reserved for first-party clients. The ROW says `insufficient-scope`,
    // because that is what the credential's defect actually is and what the
    // global rail records for the identical request; the owner reading their own
    // audit log is entitled to the finer fact.
    const user = await seedFreshUser();
    const guard = requireCookieSessionOrFirstPartyOAuthGrant(harness.ctx);
    const next = vi.fn();
    guard(
      {
        authUser: { id: user.id },
        apiKey: {
          id: '22222222-2222-4222-8222-222222222222',
          scopes: ['market:read'],
          kind: 'personal',
          securityGeneration: 0,
        },
        method: 'GET',
        path: '/oauth-grants',
      } as unknown as Request,
      {} as Response,
      next,
    );
    await vi.waitFor(() => expect(next).toHaveBeenCalled());

    expect(next.mock.calls[0]?.[0]).toMatchObject({
      statusCode: 403,
      code: 'API_KEY_FORBIDDEN',
    });
    const rows = await harness.db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.actorId, user.id),
          eq(schema.auditLog.action, 'api_key.scope_denied'),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.meta).toMatchObject({ reason: 'insufficient-scope' });
    expect(rows[0]!.targetType).toBe('api_key');
    expect(rows[0]!.targetId).toBe('22222222-2222-4222-8222-222222222222');
  });

  it('writes exactly one scope-denied row per live refusal — the rail, not the rail plus the twin', async () => {
    // End-to-end through the real app: the global guard answers before routing,
    // so the twin never runs. One refusal, one row — the property that would
    // break if a twin double-wrote.
    const { token, user } = await mintThirdPartyToken(['account:security']);

    const refused = await request(harness.app)
      .get('/api/v1/settings/oauth-grants')
      .set(bearer(token));
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body.error.code).toBe('API_KEY_FORBIDDEN');

    const rows = await harness.db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.actorId, user.id),
          eq(schema.auditLog.action, 'api_key.scope_denied'),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.meta).toMatchObject({
      reason: 'first-party-only',
      requiredScope: 'account:security',
      method: 'GET',
      kind: 'oauth',
    });
    // §10: the row names the grant, never the credential that was presented.
    expect(JSON.stringify(rows[0])).not.toContain(token);
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
        // #1328 additively registers the native Google-LINK return target beside
        // the ordinary authorization-code callback. It grants nothing: what this
        // test pins as unwidened is the scope ceiling below, and the roster stays
        // one client. A redirect URI is only a return address the server selects.
        redirectUris: ['bettertrack://oauth/callback', BETTERTRACK_MOBILE_GOOGLE_LINK_REDIRECT_URI],
        public: true,
        scopeCeiling: EXPECTED_SCOPES,
      },
    ]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * §16 2026-10-29 — first-party persistence: `first_used_at` and the
 * credential events that end OAuth grants.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** A second official app (admin-registered, `is_first_party`) for the same user. */
async function mintAdminFirstPartyToken(
  scopes: readonly ApiKeyScope[],
  existing: { user: TestUser; agent: Agent },
): Promise<{ token: string; grantId: string; clientId: string }> {
  const tag = randomBytes(4).toString('hex');
  const admin = await harness.seedAdmin({
    email: `fp-admin-${tag}@bettertrack.test`,
    username: `fpadmin${tag}`,
  });
  const adminAgent = await harness.loginAdmin(admin);
  const created = await adminAgent
    .post('/api/v1/admin/oauth-clients')
    .set(...XRW)
    .send({ name: 'Official Desktop', redirectUris: [OFFICIAL_REDIRECT], scopes, public: true });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const client = createOAuthClientResponseSchema.parse(created.body).client;
  const issued = await issuePublicClientToken({
    agent: existing.agent,
    userId: existing.user.id,
    clientId: client.clientId,
    redirectUri: OFFICIAL_REDIRECT,
    scopes,
  });
  expect(issued.firstParty).toBe(true);
  return { token: issued.token, grantId: issued.grantId, clientId: client.clientId };
}

async function grantRevokedAt(grantId: string): Promise<Date | null> {
  const [row] = await harness.db
    .select({ revokedAt: schema.oauthGrants.revokedAt })
    .from(schema.oauthGrants)
    .where(eq(schema.oauthGrants.id, grantId));
  return row!.revokedAt;
}

/** Every `oauth.grant_revoked` row of a user, as `{ grantId, meta }`. */
async function grantRevocations(userId: string) {
  const rows = await harness.db
    .select({ targetId: schema.auditLog.targetId, meta: schema.auditLog.meta })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.actorId, userId),
        eq(schema.auditLog.action, AuditAction.OAuthGrantRevoked),
      ),
    );
  return rows
    .map((row) => ({ grantId: row.targetId, meta: row.meta }))
    .sort((a, b) => String(a.grantId).localeCompare(String(b.grantId)));
}

/** The OAuth grant ids a `realtime.principal.invalidated` spy was called with. */
function invalidatedGrants(publish: { mock: { calls: unknown[][] } }): string[] {
  return publish.mock.calls
    .map(([event]) => event as { type: string; kind?: string; credentialId?: string | null })
    .filter((event) => event.type === 'realtime.principal.invalidated' && event.kind === 'oauth')
    .map((event) => String(event.credentialId))
    .sort();
}

/** Every `oauth.token_family_revoked` row of a user, as meta (familyId-sorted). */
async function familyRevocations(userId: string) {
  const rows = await harness.db
    .select({ meta: schema.auditLog.meta })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.actorId, userId),
        eq(schema.auditLog.action, AuditAction.OAuthTokenFamilyRevoked),
      ),
    );
  return rows
    .map((row) => row.meta as { familyId: string })
    .sort((a, b) => a.familyId.localeCompare(b.familyId));
}

/** The token family an access token was minted into (§16 2026-10-29). */
async function familyIdOf(token: string): Promise<string | null> {
  const [row] = await harness.db
    .select({ familyId: schema.oauthAccessTokens.familyId })
    .from(schema.oauthAccessTokens)
    .where(eq(schema.oauthAccessTokens.tokenHash, hashToken(token)));
  return row!.familyId;
}

/** The access-token row id of a bearer token. */
async function accessIdOf(token: string): Promise<string> {
  const [row] = await harness.db
    .select({ id: schema.oauthAccessTokens.id })
    .from(schema.oauthAccessTokens)
    .where(eq(schema.oauthAccessTokens.tokenHash, hashToken(token)));
  return row!.id;
}

/** A refresh of the official mobile app (public client: `client_id` alone). */
function refreshMobile(refreshToken: string) {
  return request(harness.app).post('/api/v1/oauth/token').send({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: MOBILE.clientId,
  });
}

/**
 * Put `other`'s rows into `into`'s family and drop `other`'s family row: the
 * exact state 0119's backfill left behind for two pre-PR-B installs of one
 * grant (one legacy family per grant, every token attached to it).
 */
async function shareFamily(into: string, other: string): Promise<string> {
  const shared = (await familyIdOf(into))!;
  const own = (await familyIdOf(other))!;
  await harness.db
    .update(schema.oauthAccessTokens)
    .set({ familyId: shared })
    .where(eq(schema.oauthAccessTokens.familyId, own));
  await harness.db
    .update(schema.oauthRefreshTokens)
    .set({ familyId: shared })
    .where(eq(schema.oauthRefreshTokens.familyId, own));
  await harness.db.delete(schema.oauthTokenFamilies).where(eq(schema.oauthTokenFamilies.id, own));
  expect(await familyIdOf(other)).toBe(shared);
  return shared;
}

/** Strip a token's chain back to `family_id IS NULL` (what the pre-family code minted). */
async function stripFamily(token: string): Promise<void> {
  const own = (await familyIdOf(token))!;
  await harness.db
    .update(schema.oauthAccessTokens)
    .set({ familyId: null })
    .where(eq(schema.oauthAccessTokens.familyId, own));
  await harness.db
    .update(schema.oauthRefreshTokens)
    .set({ familyId: null })
    .where(eq(schema.oauthRefreshTokens.familyId, own));
  await harness.db.delete(schema.oauthTokenFamilies).where(eq(schema.oauthTokenFamilies.id, own));
  expect(await familyIdOf(token)).toBeNull();
}

async function meStatus(token: string): Promise<number> {
  return (await request(harness.app).get('/api/v1/auth/me').set(bearer(token))).status;
}

/** Every token family on a grant, keyed by id. */
async function familiesOf(grantId: string) {
  const rows = await harness.db
    .select()
    .from(schema.oauthTokenFamilies)
    .where(eq(schema.oauthTokenFamilies.grantId, grantId));
  return new Map(rows.map((row) => [row.id, row]));
}

/** The family ids a `realtime.principal.invalidated` spy was narrowed to. */
function invalidatedFamilies(publish: { mock: { calls: unknown[][] } }): string[] {
  return publish.mock.calls
    .map(([event]) => event as { type: string; kind?: string; familyId?: string | null })
    .filter((event) => event.type === 'realtime.principal.invalidated' && event.familyId)
    .map((event) => String(event.familyId))
    .sort();
}

async function accessFirstUsedAt(token: string): Promise<Date | null> {
  const [row] = await harness.db
    .select({ firstUsedAt: schema.oauthAccessTokens.firstUsedAt })
    .from(schema.oauthAccessTokens)
    .where(eq(schema.oauthAccessTokens.tokenHash, hashToken(token)));
  return row!.firstUsedAt;
}

describe('§16 2026-10-29 first_used_at — stamped once per access token, in authenticateToken only', () => {
  it('writes ONE UPDATE for the first authentication and none for later ones (query count)', async () => {
    const { token } = await mintFirstPartyToken(['portfolio:read']);
    expect(await accessFirstUsedAt(token)).toBeNull();

    // A second drizzle handle over the SAME database, logging every statement
    // the OAuth repository sends.
    const statements: string[] = [];
    const pglite = (harness.db as unknown as { $client: PGlite }).$client;
    const logged = drizzlePglite(pglite, {
      schema,
      logger: { logQuery: (query: string) => statements.push(query) },
    }) as unknown as Database;
    const service = createOAuthService({
      repo: createOAuthRepository(logged),
      audit: createAuditService(createAuditRepository(harness.db)),
      redis: harness.ctx.redis,
      recordEncryption: harness.ctx.config.recordEncryption,
    });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(await service.authenticateToken(token)).not.toBeNull();
    }
    const lookups = statements.filter((query) =>
      /^select .* from "oauth_access_tokens"/i.test(query),
    );
    const stamps = statements.filter((query) => /^update "oauth_access_tokens"/i.test(query));
    expect(lookups).toHaveLength(4);
    expect(stamps).toHaveLength(1);
    expect(stamps[0]).toMatch(/set "first_used_at" = \$1/i);
    expect(stamps[0]).toMatch(/"first_used_at" is null/i);

    const stampedAt = await accessFirstUsedAt(token);
    expect(stampedAt).toBeInstanceOf(Date);
    // Later requests over HTTP never move it.
    await request(harness.app).get('/api/v1/auth/me').set(bearer(token)).expect(200);
    await request(harness.app).get('/api/v1/auth/me').set(bearer(token)).expect(200);
    expect(await accessFirstUsedAt(token)).toEqual(stampedAt);
  });

  it('stamps on the first HTTP bearer request, not at issue time', async () => {
    const { token } = await mintFirstPartyToken(['portfolio:read']);
    expect(await accessFirstUsedAt(token)).toBeNull();
    await request(harness.app).get('/api/v1/auth/me').set(bearer(token)).expect(200);
    expect(await accessFirstUsedAt(token)).toBeInstanceOf(Date);
  });

  it('fails closed: an authentication whose stamp cannot be written is rejected', async () => {
    const { token } = await mintFirstPartyToken(['portfolio:read']);
    const markAccessTokenFirstUsed = vi.fn(async () => {
      throw new Error('first-use write unavailable');
    });
    const service = createOAuthService({
      repo: { ...createOAuthRepository(harness.db), markAccessTokenFirstUsed },
      audit: createAuditService(createAuditRepository(harness.db)),
      redis: harness.ctx.redis,
      recordEncryption: harness.ctx.config.recordEncryption,
    });

    await expect(service.authenticateToken(token)).rejects.toThrow('first-use write unavailable');
    expect(await accessFirstUsedAt(token)).toBeNull();

    // Once the real writer has stamped it, the writer is never called again.
    expect(await harness.ctx.oauth.authenticateToken(token)).not.toBeNull();
    markAccessTokenFirstUsed.mockClear();
    expect(await service.authenticateToken(token)).not.toBeNull();
    expect(markAccessTokenFirstUsed).not.toHaveBeenCalled();
  });
});

describe('§16 2026-10-29 credential events end OAuth grants', () => {
  it('a password change revokes EVERY grant — first- and third-party — audited and invalidated per grant', async () => {
    const mobile = await mintFirstPartyToken(['portfolio:read']);
    const partner = await mintThirdPartyToken(['market:read'], mobile);
    const publish = vi.spyOn(harness.ctx.events, 'publish');

    const changed = await mobile.agent
      .post('/api/v1/auth/change-password')
      .set(...XRW)
      .send({ currentPassword: mobile.user.password, newPassword: 'Str0ng-New-Passw0rd!' });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);

    expect(await grantRevokedAt(mobile.grantId)).toBeInstanceOf(Date);
    expect(await grantRevokedAt(partner.grantId)).toBeInstanceOf(Date);
    expect(
      (await request(harness.app).get('/api/v1/auth/me').set(bearer(mobile.token))).status,
    ).toBe(401);
    expect(await harness.ctx.oauth.authenticateToken(partner.token)).toBeNull();
    expect(invalidatedGrants(publish)).toEqual([mobile.grantId, partner.grantId].sort());
    expect(await grantRevocations(mobile.user.id)).toEqual(
      [
        { grantId: mobile.grantId, meta: { clientId: MOBILE.clientId, reason: 'password_change' } },
        {
          grantId: partner.grantId,
          meta: { clientId: expect.stringMatching(/^btc_/), reason: 'password_change' },
        },
      ].sort((a, b) => a.grantId.localeCompare(b.grantId)),
    );
  });

  it('sign out everywhere from a browser revokes every FIRST-PARTY grant and leaves third-party grants alone', async () => {
    const mobile = await mintFirstPartyToken(['portfolio:read']);
    const desktop = await mintAdminFirstPartyToken(['portfolio:read'], mobile);
    const partner = await mintThirdPartyToken(['market:read'], mobile);
    const publish = vi.spyOn(harness.ctx.events, 'publish');

    const out = await mobile.agent.post('/api/v1/auth/sessions/revoke-others').set(...XRW);
    expect(out.status, JSON.stringify(out.body)).toBe(200);

    // The browser stays signed in; both official apps are signed out.
    expect((await mobile.agent.get('/api/v1/auth/me')).status).toBe(200);
    expect(await grantRevokedAt(mobile.grantId)).toBeInstanceOf(Date);
    expect(await grantRevokedAt(desktop.grantId)).toBeInstanceOf(Date);
    expect(await grantRevokedAt(partner.grantId)).toBeNull();
    expect(await harness.ctx.oauth.authenticateToken(partner.token)).not.toBeNull();
    expect(invalidatedGrants(publish)).toEqual([mobile.grantId, desktop.grantId].sort());
    expect(await grantRevocations(mobile.user.id)).toEqual(
      [
        {
          grantId: mobile.grantId,
          meta: { clientId: MOBILE.clientId, reason: 'sign_out_everywhere' },
        },
        {
          grantId: desktop.grantId,
          meta: { clientId: desktop.clientId, reason: 'sign_out_everywhere' },
        },
      ].sort((a, b) => a.grantId.localeCompare(b.grantId)),
    );

    // Idempotent: a second sign-out-everywhere revokes and audits nothing more.
    await mobile.agent
      .post('/api/v1/auth/sessions/revoke-others')
      .set(...XRW)
      .expect(200);
    expect(await grantRevocations(mobile.user.id)).toHaveLength(2);
  });

  // Review B1: grant revocation stays first-party-OAuth-only (bearerAuth's
  // grant-management carve-out). A personal key or a third-party app holding
  // `account:security` may sign the user's SESSIONS out, never a grant.
  it('sign out everywhere from a PERSONAL KEY revokes sessions only — never a grant', async () => {
    const mobile = await mintFirstPartyToken(['portfolio:read']);
    const minted = await mobile.agent
      .post('/api/v1/settings/api-keys')
      .set(...XRW)
      .send({ name: 'Automation', scopes: ['account:security'] });
    expect(minted.status, JSON.stringify(minted.body)).toBe(201);
    const key = createApiKeyResponseSchema.parse(minted.body).token;

    // The same key is refused direct grant revocation…
    const direct = await request(harness.app)
      .delete(`/api/v1/settings/oauth-grants/${mobile.grantId}`)
      .set(bearer(key));
    expect(direct.status).toBe(403);

    // …and cannot reach the grant through sign-out-everywhere either.
    const out = await request(harness.app)
      .post('/api/v1/auth/sessions/revoke-others')
      .set(bearer(key));
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(out.body).toEqual({ revoked: 1 });
    expect((await mobile.agent.get('/api/v1/auth/me')).status).toBe(401);
    expect(await grantRevokedAt(mobile.grantId)).toBeNull();
    await request(harness.app).get('/api/v1/auth/me').set(bearer(mobile.token)).expect(200);
    expect(await grantRevocations(mobile.user.id)).toEqual([]);
    // …nor any install of it: no token family is touched either.
    expect([...(await familiesOf(mobile.grantId)).values()].every((f) => !f.revokedAt)).toBe(true);
    expect(await familyRevocations(mobile.user.id)).toEqual([]);
  });

  it('sign out everywhere is refused for a third-party app; no session or first-party grant is touched', async () => {
    const mobile = await mintFirstPartyToken(['portfolio:read']);
    const partner = await mintThirdPartyToken(['account:security'], mobile);

    const direct = await request(harness.app)
      .delete(`/api/v1/settings/oauth-grants/${mobile.grantId}`)
      .set(bearer(partner.token));
    expect(direct.status).toBe(403);

    // `account:security` is first-party-only for OAuth apps (§16 2026-10-30): the
    // third-party token is refused with 403 API_KEY_FORBIDDEN (first-party-only).
    const out = await request(harness.app)
      .post('/api/v1/auth/sessions/revoke-others')
      .set(bearer(partner.token));
    expect(out.status, JSON.stringify(out.body)).toBe(403);
    expect(out.body.error.code).toBe('API_KEY_FORBIDDEN');
    expect(out.body.error.message).toContain('first-party OAuth clients only');
    expect((await mobile.agent.get('/api/v1/auth/me')).status).toBe(200);
    expect(await grantRevokedAt(mobile.grantId)).toBeNull();
    expect(await grantRevokedAt(partner.grantId)).toBeNull();
    await request(harness.app).get('/api/v1/auth/me').set(bearer(mobile.token)).expect(200);
    expect(await grantRevocations(mobile.user.id)).toEqual([]);
    // No install of either app is signed out: the family leg is first-party-only too.
    for (const grantId of [mobile.grantId, partner.grantId]) {
      expect([...(await familiesOf(grantId)).values()].every((f) => !f.revokedAt)).toBe(true);
    }
    expect(await familyRevocations(mobile.user.id)).toEqual([]);
  });

  // §16 2026-10-29 (PR-C on PR-B, review item e): one grant serves EVERY install
  // of an app, so keeping the caller's grant whole kept every other phone signed
  // in. Called from an official app's bearer, sign-out-everywhere now also
  // revokes every OTHER token family on that grant: exactly the calling install
  // stays signed in.
  it('sign out everywhere FROM an official app also signs out that app’s OTHER installs, keeping only the caller', async () => {
    const phone = await mintFirstPartyToken(['account:security', 'portfolio:read']);
    const tablet = await mintFirstPartyToken(['portfolio:read'], phone);
    const watch = await mintFirstPartyToken(['portfolio:read'], phone);
    expect(new Set([phone.grantId, tablet.grantId, watch.grantId]).size).toBe(1);
    const phoneFamily = (await familyIdOf(phone.token))!;
    const siblings = [(await familyIdOf(tablet.token))!, (await familyIdOf(watch.token))!].sort();
    // A sealed pair at rest on a sibling: it must go with its family (review S3).
    await harness.db
      .update(schema.oauthRefreshTokens)
      .set({ successorEnvelope: 'v2.sealed-sibling-pair' })
      .where(eq(schema.oauthRefreshTokens.familyId, siblings[0]!));
    const publish = vi.spyOn(harness.ctx.events, 'publish');

    const out = await request(harness.app)
      .post('/api/v1/auth/sessions/revoke-others')
      .set(bearer(phone.token));
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(out.body).toEqual({ revoked: 1 });

    // The calling install keeps working; every other install is signed out.
    await request(harness.app).get('/api/v1/portfolios').set(bearer(phone.token)).expect(200);
    for (const other of [tablet, watch]) {
      expect(
        (await request(harness.app).get('/api/v1/auth/me').set(bearer(other.token))).status,
      ).toBe(401);
    }
    expect(await grantRevokedAt(phone.grantId)).toBeNull();
    // A family of its own is kept as it is — nothing is moved.
    expect(await familyIdOf(phone.token)).toBe(phoneFamily);
    const families = await familiesOf(phone.grantId);
    expect(families.get(phoneFamily)!.revokedAt).toBeNull();
    for (const id of siblings) {
      expect(families.get(id)!.revokedAt).toBeInstanceOf(Date);
      expect(families.get(id)!.revokedReason).toBe('sign_out_everywhere');
    }
    const envelopes = await harness.db
      .select({ envelope: schema.oauthRefreshTokens.successorEnvelope })
      .from(schema.oauthRefreshTokens)
      .where(eq(schema.oauthRefreshTokens.familyId, siblings[0]!));
    expect(envelopes.length).toBeGreaterThan(0);
    expect(envelopes.every((row) => row.envelope === null)).toBe(true);

    // Each sibling: its sockets dropped and ONE audit row; the grant has none.
    expect(invalidatedFamilies(publish)).toEqual(siblings);
    expect(await familyRevocations(phone.user.id)).toEqual(
      siblings.map((familyId) => ({
        clientId: MOBILE.clientId,
        familyId,
        reason: 'sign_out_everywhere',
      })),
    );
    expect(await grantRevocations(phone.user.id)).toEqual([]);

    // Idempotent: a second call revokes and audits nothing more.
    await request(harness.app)
      .post('/api/v1/auth/sessions/revoke-others')
      .set(bearer(phone.token))
      .expect(200);
    expect(await familyRevocations(phone.user.id)).toHaveLength(2);
    await request(harness.app).get('/api/v1/portfolios').set(bearer(phone.token)).expect(200);
  });

  it('sign out everywhere FROM a legacy pre-family token keeps its chain (moved into a family of its own) and ends every family on the grant', async () => {
    const phone = await mintFirstPartyToken(['account:security', 'portfolio:read']);
    const tablet = await mintFirstPartyToken(['portfolio:read'], phone);
    const phoneFamily = (await familyIdOf(phone.token))!;
    const tabletFamily = (await familyIdOf(tablet.token))!;
    // The phone's rows back to what the pre-family code inserted: no family.
    await harness.db
      .update(schema.oauthAccessTokens)
      .set({ familyId: null })
      .where(eq(schema.oauthAccessTokens.familyId, phoneFamily));
    await harness.db
      .update(schema.oauthRefreshTokens)
      .set({ familyId: null })
      .where(eq(schema.oauthRefreshTokens.familyId, phoneFamily));

    await request(harness.app)
      .post('/api/v1/auth/sessions/revoke-others')
      .set(bearer(phone.token))
      .expect(200);

    await request(harness.app).get('/api/v1/portfolios').set(bearer(phone.token)).expect(200);
    expect(
      (await request(harness.app).get('/api/v1/auth/me').set(bearer(tablet.token))).status,
    ).toBe(401);
    expect(await grantRevokedAt(phone.grantId)).toBeNull();
    expect((await familiesOf(phone.grantId)).get(tabletFamily)!.revokedReason).toBe(
      'sign_out_everywhere',
    );
    // The legacy chain left the NULL family for a live family of its own.
    const moved = await familyIdOf(phone.token);
    expect(moved).toEqual(expect.any(String));
    expect((await familiesOf(phone.grantId)).get(moved!)!.revokedAt).toBeNull();
    expect((await refreshMobile(phone.refreshToken)).status).toBe(200);
  });

  // Review round 2, B1: a FAMILY is not always one install. 0119 backfilled one
  // legacy family per pre-existing grant, so every pre-PR-B install of the app
  // shares it — and with the 90-day sliding refresh they rarely sign in again.
  it('sign out everywhere FROM an app signs out an install SHARING the caller’s 0119-backfilled family', async () => {
    const phone = await mintFirstPartyToken(['account:security', 'portfolio:read']);
    const tablet = await mintFirstPartyToken(['portfolio:read'], phone);
    const shared = await shareFamily(phone.token, tablet.token);
    expect(await meStatus(tablet.token)).toBe(200);

    await request(harness.app)
      .post('/api/v1/auth/sessions/revoke-others')
      .set(bearer(phone.token))
      .expect(200);

    // The sibling: its next call and its next refresh are refused.
    expect(await meStatus(tablet.token)).toBe(401);
    const tabletRefresh = await refreshMobile(tablet.refreshToken);
    expect(tabletRefresh.status).toBe(400);
    expect(tabletRefresh.body.error.code).toBe('INVALID_GRANT');
    // The caller: moved into a fresh family, still calling and refreshing.
    const moved = (await familyIdOf(phone.token))!;
    expect(moved).not.toBe(shared);
    await request(harness.app).get('/api/v1/portfolios').set(bearer(phone.token)).expect(200);
    const next = await refreshMobile(phone.refreshToken);
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    expect(await familyIdOf(oauthTokenResponseSchema.parse(next.body).access_token)).toBe(moved);
    expect(await grantRevokedAt(phone.grantId)).toBeNull();
    const families = await familiesOf(phone.grantId);
    expect(families.get(shared)!.revokedReason).toBe('sign_out_everywhere');
    expect(families.get(moved)!.revokedAt).toBeNull();
    expect(await familyRevocations(phone.user.id)).toEqual([
      { clientId: MOBILE.clientId, familyId: shared, reason: 'sign_out_everywhere' },
    ]);
  });

  // …and a chain the pre-family code minted during PR-B's rollout has no
  // family row at all (rotation inherits `family_id IS NULL`).
  it('sign out everywhere FROM an app signs out a NO-FAMILY chain on the same grant', async () => {
    const phone = await mintFirstPartyToken(['account:security', 'portfolio:read']);
    const tablet = await mintFirstPartyToken(['portfolio:read'], phone);
    const phoneFamily = (await familyIdOf(phone.token))!;
    await stripFamily(tablet.token);
    expect(await meStatus(tablet.token)).toBe(200);
    const publish = vi.spyOn(harness.ctx.events, 'publish');

    await request(harness.app)
      .post('/api/v1/auth/sessions/revoke-others')
      .set(bearer(phone.token))
      .expect(200);

    expect(await meStatus(tablet.token)).toBe(401);
    expect((await refreshMobile(tablet.refreshToken)).status).toBe(400);
    // The caller's own family is untouched (it held no one else).
    expect(await familyIdOf(phone.token)).toBe(phoneFamily);
    await request(harness.app).get('/api/v1/portfolios').set(bearer(phone.token)).expect(200);
    expect((await refreshMobile(phone.refreshToken)).status).toBe(200);
    // The orphan chain was swept into one family, revoked and audited like the rest.
    const swept = (await familyIdOf(tablet.token))!;
    expect(swept).not.toBe(phoneFamily);
    expect((await familiesOf(phone.grantId)).get(swept)!.revokedReason).toBe('sign_out_everywhere');
    expect(await familyRevocations(phone.user.id)).toEqual([
      { clientId: MOBILE.clientId, familyId: swept, reason: 'sign_out_everywhere' },
    ]);
    expect(invalidatedFamilies(publish)).toEqual([swept]);
    // Its sockets carry no family: a grant-wide invalidation drops them at once.
    const grantWide = publish.mock.calls
      .map(([event]) => event as { type: string; credentialId?: string; familyId?: string })
      .filter(
        (event) =>
          event.type === 'realtime.principal.invalidated' &&
          event.credentialId === phone.grantId &&
          !event.familyId,
      );
    expect(grantWide).toHaveLength(1);
  });

  it('the caller’s MOVED chain keeps its 60 s grace replay and its reuse detection', async () => {
    const phone = await mintFirstPartyToken(['account:security', 'portfolio:read']);
    const tablet = await mintFirstPartyToken(['portfolio:read'], phone);
    const shared = await shareFamily(phone.token, tablet.token);
    // The phone rotates once, then signs everyone else out with the NEW pair.
    const rotated = await refreshMobile(phone.refreshToken);
    expect(rotated.status).toBe(200);
    const second = oauthTokenResponseSchema.parse(rotated.body);
    await request(harness.app)
      .post('/api/v1/auth/sessions/revoke-others')
      .set(bearer(second.access_token))
      .expect(200);
    const moved = (await familyIdOf(second.access_token))!;
    expect(moved).not.toBe(shared);
    expect(await meStatus(tablet.token)).toBe(401);

    // A lost answer re-sent inside 60 s is still re-served the identical pair.
    const replay = await refreshMobile(phone.refreshToken);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(oauthTokenResponseSchema.parse(replay.body).refresh_token).toBe(second.refresh_token);

    // The moved chain rotates on; a GRANDPARENT replay is still theft — of the
    // moved family, which ends with refresh_reuse.
    const third = oauthTokenResponseSchema.parse((await refreshMobile(second.refresh_token)).body);
    expect(await familyIdOf(third.access_token)).toBe(moved);
    expect((await refreshMobile(phone.refreshToken)).status).toBe(400);
    expect((await familiesOf(phone.grantId)).get(moved)!.revokedReason).toBe('refresh_reuse');
    expect(await meStatus(third.access_token)).toBe(401);
    expect(await grantRevokedAt(phone.grantId)).toBeNull();
  });

  it('fails safe: a caller whose chain cannot be isolated is signed out WITH its siblings', async () => {
    const phone = await mintFirstPartyToken(['account:security', 'portfolio:read']);
    const tablet = await mintFirstPartyToken(['portfolio:read'], phone);
    await shareFamily(phone.token, tablet.token);
    // Break the pairing between the phone's access row and its refresh row.
    await harness.db
      .update(schema.oauthRefreshTokens)
      .set({ createdAt: new Date(Date.now() - 3_600_000) })
      .where(eq(schema.oauthRefreshTokens.tokenHash, hashToken(phone.refreshToken)));

    await request(harness.app)
      .post('/api/v1/auth/sessions/revoke-others')
      .set(bearer(phone.token))
      .expect(200);

    expect(await meStatus(tablet.token)).toBe(401);
    expect(await meStatus(phone.token)).toBe(401);
    expect(await grantRevokedAt(phone.grantId)).toBeNull();
  });

  it('keeps sibling-family revocation repository-scoped to the caller’s own live first-party grant', async () => {
    const victim = await mintFirstPartyToken(['portfolio:read']);
    await mintFirstPartyToken(['portfolio:read'], victim);
    const partner = await mintThirdPartyToken(['market:read'], victim);
    const attacker = await seedFreshUser();
    const repo = createOAuthRepository(harness.db);

    // Another user naming the victim's grant reaches nothing.
    expect(
      await repo.revokeGrantsForCredentialEvent({
        userId: attacker.id,
        firstPartyOnly: true,
        exceptGrantId: victim.grantId,
        siblingFamilies: { callerAccessTokenId: await accessIdOf(victim.token) },
        revokedAt: new Date(),
      }),
    ).toEqual({
      grants: [],
      families: [],
      keptClientId: null,
      keptFamilyId: null,
      orphansSwept: false,
    });
    const victimFamilies = [...(await familiesOf(victim.grantId)).values()];
    expect(victimFamilies).toHaveLength(2);
    expect(victimFamilies.every((f) => !f.revokedAt)).toBe(true);
    // The owner naming a THIRD-PARTY grant as "kept" reaches none of its
    // families (the first-party filter applies to the kept grant too).
    const result = await repo.revokeGrantsForCredentialEvent({
      userId: victim.user.id,
      firstPartyOnly: true,
      exceptGrantId: partner.grantId,
      siblingFamilies: { callerAccessTokenId: await accessIdOf(partner.token) },
      revokedAt: new Date(),
    });
    expect(result.families).toEqual([]);
    expect(result.keptFamilyId).toBeNull();
    expect([...(await familiesOf(partner.grantId)).values()].every((f) => !f.revokedAt)).toBe(true);
    // (The victim's first-party grant itself was a legitimate target of that call.)
    expect(result.grants.map((grant) => grant.grantId)).toEqual([victim.grantId]);
  });

  // Review S2: the revoke is fail-closed, its audit trail is not. An audit
  // write that fails after the revoke committed must not turn the credential
  // change into a 500, nor skip the remaining grants' rows.
  it('an audit write failing after the revoke committed is logged and the rest continues', async () => {
    const mobile = await mintFirstPartyToken(['portfolio:read']);
    const partner = await mintThirdPartyToken(['market:read'], mobile);
    const record = vi.fn(async (input: { action: string; targetId?: string | null }) => {
      if (input.action === AuditAction.OAuthGrantRevoked && record.mock.calls.length === 1) {
        throw new Error('audit store unavailable');
      }
    });
    const warn = vi.fn();
    const service = createOAuthService({
      repo: createOAuthRepository(harness.db),
      audit: { record } as unknown as Parameters<typeof createOAuthService>[0]['audit'],
      redis: harness.ctx.redis,
      recordEncryption: harness.ctx.config.recordEncryption,
      logger: { warn },
    });

    await expect(
      service.revokeGrantsForCredentialEvent({
        userId: mobile.user.id,
        reason: 'password_change',
        firstPartyOnly: false,
        exceptGrantId: null,
      }),
    ).resolves.toBe(2);

    // Both grants are revoked; the second row was still attempted after the
    // first failed, and the gap is logged loudly.
    expect(await grantRevokedAt(mobile.grantId)).toBeInstanceOf(Date);
    expect(await grantRevokedAt(partner.grantId)).toBeInstanceOf(Date);
    expect(record).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), userId: mobile.user.id }),
      'oauth credential-event grant revocation AUDIT GAP: grant revoked but audit write failed',
    );
  });

  it('sign out everywhere also consumes pending first-party authorization codes', async () => {
    const user = await seedFreshUser();
    const agent = await login(user);
    const { verifier, challenge } = pkce();
    const approved = await agent
      .post('/api/v1/oauth/authorize')
      .set(...XRW)
      .send({
        client_id: MOBILE.clientId,
        redirect_uri: MOBILE.redirectUris[0],
        scope: 'portfolio:read',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
    expect(approved.status).toBe(200);
    const code = new URL(approved.body.redirectTo as string).searchParams.get('code');

    await agent
      .post('/api/v1/auth/sessions/revoke-others')
      .set(...XRW)
      .expect(200);

    const exchanged = await request(harness.app).post('/api/v1/oauth/token').send({
      grant_type: 'authorization_code',
      code,
      redirect_uri: MOBILE.redirectUris[0],
      client_id: MOBILE.clientId,
      code_verifier: verifier,
    });
    expect(exchanged.status).toBe(400);
    expect(exchanged.body.error.code).toBe('INVALID_GRANT');
  });

  it('2FA enrollment and PIN changes stay sessions-only: OAuth grants survive', async () => {
    const mobile = await mintFirstPartyToken(['portfolio:read']);

    const pin = await mobile.agent
      .put('/api/v1/auth/pin')
      .set(...XRW)
      .send({ pin: '4826' });
    expect(pin.status, JSON.stringify(pin.body)).toBe(200);
    const pinOff = await mobile.agent.delete('/api/v1/auth/pin').set(...XRW);
    expect(pinOff.status, JSON.stringify(pinOff.body)).toBe(200);

    const stepUp = { password: mobile.user.password };
    const enroll = await mobile.agent
      .post('/api/v1/auth/2fa/enroll')
      .set(...XRW)
      .send({ stepUp });
    expect(enroll.status, JSON.stringify(enroll.body)).toBe(200);
    const { secret } = twoFactorEnrollResponseSchema.parse(enroll.body);
    const confirm = await mobile.agent
      .post('/api/v1/auth/2fa/confirm')
      .set(...XRW)
      .send({ code: generateTotpCode(secret), stepUp });
    expect(confirm.status, JSON.stringify(confirm.body)).toBe(200);

    expect(await grantRevokedAt(mobile.grantId)).toBeNull();
    await request(harness.app).get('/api/v1/auth/me').set(bearer(mobile.token)).expect(200);
    expect(await grantRevocations(mobile.user.id)).toEqual([]);
  });
});

describe('§16 2026-10-29 a completed password reset ends every OAuth grant', () => {
  const SMTP_ENV = {
    SMTP_HOST: 'smtp.test.local',
    SMTP_PORT: '587',
    SMTP_USER: 'mailer',
    SMTP_PASS: 'super-secret-smtp-pass',
    SMTP_FROM: 'BetterTrack <no-reply@test.local>',
  } satisfies Partial<NodeJS.ProcessEnv>;
  let sent: OutgoingMail[];

  beforeEach(async () => {
    await harness.dispose();
    sent = [];
    const transport: MailTransport = {
      async send(mail) {
        sent.push(mail);
      },
    };
    harness = await createTestApp({ env: SMTP_ENV, emailTransport: transport });
    await seedFirstPartyClients(createOAuthRepository(harness.db));
  });

  it('revokes first- and third-party grants, audited password_reset', async () => {
    const mobile = await mintFirstPartyToken(['portfolio:read']);
    const partner = await mintThirdPartyToken(['market:read'], mobile);

    const requested = await request(harness.app)
      .post('/api/v1/auth/password-reset/request')
      .set(...XRW)
      .send({ email: mobile.user.email });
    expect(requested.body).toEqual({ ok: true });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const token = sent[0]!.text.split('/reset/')[1]?.split(/\s/)[0];
    expect(token).toBeTruthy();

    const completed = await request(harness.app)
      .post('/api/v1/auth/password-reset/complete')
      .set(...XRW)
      .send({ token, newPassword: 'Reset-Str0ng-Passw0rd!' });
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);

    expect(await grantRevokedAt(mobile.grantId)).toBeInstanceOf(Date);
    expect(await grantRevokedAt(partner.grantId)).toBeInstanceOf(Date);
    expect(await harness.ctx.oauth.authenticateToken(mobile.token)).toBeNull();
    expect((await grantRevocations(mobile.user.id)).map((row) => row.meta)).toEqual([
      expect.objectContaining({ reason: 'password_reset' }),
      expect.objectContaining({ reason: 'password_reset' }),
    ]);
  });
});

describe('§16 2026-10-29 an ADMIN temp-password reset ends every OAuth grant', () => {
  it('revokes first- and third-party grants, audited password_reset with source admin', async () => {
    const mobile = await mintFirstPartyToken(['portfolio:read']);
    const partner = await mintThirdPartyToken(['market:read'], mobile);
    const tag = randomBytes(4).toString('hex');
    const admin = await harness.seedAdmin({
      email: `reset-admin-${tag}@bettertrack.test`,
      username: `resetadmin${tag}`,
    });
    const adminAgent = await harness.loginAdmin(admin);
    const publish = vi.spyOn(harness.ctx.events, 'publish');

    const reset = await adminAgent
      .post(`/api/v1/admin/users/${mobile.user.id}/reset-password`)
      .set(...XRW);
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);

    expect(await grantRevokedAt(mobile.grantId)).toBeInstanceOf(Date);
    expect(await grantRevokedAt(partner.grantId)).toBeInstanceOf(Date);
    expect(await harness.ctx.oauth.authenticateToken(mobile.token)).toBeNull();
    expect(await harness.ctx.oauth.authenticateToken(partner.token)).toBeNull();
    expect(invalidatedGrants(publish)).toEqual([mobile.grantId, partner.grantId].sort());

    // One row per grant; the admin is the actor; the meta names event + source.
    const rows = await harness.db
      .select({
        actorId: schema.auditLog.actorId,
        targetId: schema.auditLog.targetId,
        meta: schema.auditLog.meta,
      })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, AuditAction.OAuthGrantRevoked));
    const byGrant = new Map(rows.map((row) => [row.targetId, row]));
    expect(rows).toHaveLength(2);
    expect(byGrant.get(mobile.grantId)).toMatchObject({
      actorId: admin.id,
      meta: { clientId: MOBILE.clientId, reason: 'password_reset', source: 'admin' },
    });
    expect(byGrant.get(partner.grantId)).toMatchObject({
      actorId: admin.id,
      meta: {
        clientId: expect.stringMatching(/^btc_/),
        reason: 'password_reset',
        source: 'admin',
      },
    });
  });
});
