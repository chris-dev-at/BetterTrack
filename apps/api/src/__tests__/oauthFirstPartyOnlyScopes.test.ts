import { createHash, randomBytes } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createApiKeyResponseSchema,
  createOAuthClientResponseSchema,
  oauthClientListResponseSchema,
  oauthGrantListResponseSchema,
  oauthTokenResponseSchema,
  type ApiKeyScope,
} from '@bettertrack/contracts';

import { createOAuthRepository } from '../data/repositories/oauthRepository';
import * as schema from '../data/schema';
import { resolveBearerPolicyClassification } from '../http/middleware/bearerAuth';
import { buildRouteTable } from '../scripts/checkOpenapiCoverage';
import { FIRST_PARTY_CLIENTS, seedFirstPartyClients } from '../services/oauth/firstPartyClients';
import { createTestApp, type TestHarness } from '../testing/createTestApp';
import {
  simulateThirdPartyCeilingRegression,
  storeAsPreRuleThirdPartyApp,
} from './thirdPartyCeilingRegression';

/**
 * A THIRD-party OAuth app can never hold `account:security` or `vault:sync`.
 *
 * `account:security` reaches the account-lifecycle routes (full data export and
 * account deletion) and every sign-in factor; `vault:sync` reaches the
 * client-encrypted vault. Both exist for the official first-party app (and, for
 * now, the owner's own personal API keys). The rule is enforced in three places,
 * each pinned here:
 *
 *  1. registration — a user-registered app cannot list either scope;
 *  2. the effective ceiling — an app registered BEFORE this rule keeps its stored
 *     row, but authorize, both token exchanges and every bearer request clamp it
 *     to the third-party ceiling, so neither scope is grantable or usable;
 *  3. the route layer — a third-party principal that somehow still HOLDS one of
 *     them (a ceiling regression) is refused as first-party-only.
 *
 * Plus the negative space: the first-party mobile app and personal keys keep
 * exactly the reach they had.
 *
 * The list is pinned literally, not imported: deleting a scope from the
 * first-party-only set must FAIL this file, not shrink it.
 */
const FIRST_PARTY_ONLY = ['account:security', 'vault:sync'] as const;

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const THIRD_PARTY_REDIRECT = 'https://third-party.example/callback';
const MOBILE = FIRST_PARTY_CLIENTS.find(
  (client) => client.clientId === 'btc_IbT1mzw_7kBiPHPkGfaE0Q',
)!;
/** What a third-party app registered before this rule could carry. */
const LEGACY_THIRD_PARTY_SCOPES: ApiKeyScope[] = [
  'portfolio:read',
  'account:security',
  'vault:sync',
];

type Agent = ReturnType<TestHarness['agent']>;
type TestUser = Awaited<ReturnType<TestHarness['seedUser']>>;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
  await seedFirstPartyClients(createOAuthRepository(harness.db));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await harness.dispose();
});

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function seedFreshUser(): Promise<TestUser> {
  const tag = randomBytes(5).toString('hex');
  return harness.seedUser({
    email: `fpo-${tag}@bettertrack.test`,
    username: `fpo${tag}`,
  });
}

async function login(user: TestUser): Promise<Agent> {
  const agent = harness.agent();
  const response = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier: user.email, password: user.password });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return agent;
}

async function signedIn(): Promise<{ user: TestUser; agent: Agent }> {
  const user = await seedFreshUser();
  return { user, agent: await login(user) };
}

/** The real authorize → code → token flow for a public (PKCE) client. */
async function issueToken(input: {
  agent: Agent;
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
}): Promise<{ accessToken: string; refreshToken: string; scope: string }> {
  const { verifier, challenge } = pkce();
  const approved = await input.agent
    .post('/api/v1/oauth/authorize')
    .set(...XRW)
    .send({
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      scope: input.scopes.join(' '),
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  const code = new URL(approved.body.redirectTo as string).searchParams.get('code');
  expect(code).toBeTruthy();
  const exchanged = await harness.request().post('/api/v1/oauth/token').send({
    grant_type: 'authorization_code',
    code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    code_verifier: verifier,
  });
  expect(exchanged.status, JSON.stringify(exchanged.body)).toBe(200);
  const parsed = oauthTokenResponseSchema.parse(exchanged.body);
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    scope: parsed.scope,
  };
}

async function registerThirdParty(agent: Agent, scopes: readonly string[]) {
  return agent
    .post('/api/v1/settings/oauth-clients')
    .set(...XRW)
    .send({
      name: 'Throwaway third party',
      redirectUris: [THIRD_PARTY_REDIRECT],
      scopes,
      public: true,
    });
}

/**
 * A third-party app registered, and consented to, BEFORE this rule existed: its
 * stored ceiling, its grant and its live access token all carry both
 * first-party-only scopes. Built through today's public flow on an ordinary
 * scope, then widened in the rows exactly as the old code would have stored them.
 */
async function legacyThirdPartyApp(user: TestUser, agent: Agent) {
  const registered = await registerThirdParty(agent, ['portfolio:read']);
  expect(registered.status, JSON.stringify(registered.body)).toBe(201);
  const client = createOAuthClientResponseSchema.parse(registered.body).client;

  const issued = await issueToken({
    agent,
    clientId: client.clientId,
    redirectUri: THIRD_PARTY_REDIRECT,
    scopes: ['portfolio:read'],
  });
  const [grant] = await harness.db
    .select({ id: schema.oauthGrants.id })
    .from(schema.oauthGrants)
    .where(eq(schema.oauthGrants.userId, user.id));
  expect(grant).toBeDefined();
  await storeAsPreRuleThirdPartyApp(harness, {
    clientId: client.clientId,
    grantId: grant!.id,
    scopes: LEGACY_THIRD_PARTY_SCOPES,
  });
  return { clientId: client.clientId, grantId: grant!.id, ...issued };
}

async function accountStillExists(userId: string): Promise<boolean> {
  const rows = await harness.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  return rows.length === 1;
}

async function exportJobCount(userId: string): Promise<number> {
  const rows = await harness.db
    .select({ id: schema.exportJobs.id })
    .from(schema.exportJobs)
    .where(eq(schema.exportJobs.userId, userId));
  return rows.length;
}

/** The access-token row an issued grant holds (one per issuance here). */
async function accessTokenRow(grantId: string) {
  const [row] = await harness.db
    .select()
    .from(schema.oauthAccessTokens)
    .where(eq(schema.oauthAccessTokens.grantId, grantId));
  expect(row).toBeDefined();
  return row!;
}

/** Any live id: the route matchers accept a UUID, a small integer or a year. */
const PATH_FILLS = ['0190a6f4-1b2c-7d3e-8f40-123456789abc', '1', '2025'];

/**
 * Every mounted (method, concrete path) whose LIVE bearer policy requires a
 * first-party-only scope: module-prefix rows and `/auth` prefix rules included,
 * not just the allowlists.
 */
function firstPartyOnlyRoutes(): { method: string; template: string; path: string }[] {
  const required = new Set<string>(FIRST_PARTY_ONLY);
  const out: { method: string; template: string; path: string }[] = [];
  for (const surface of buildRouteTable()) {
    if (surface.kind === 'opaque-mount' || !surface.path.startsWith('/api/v1/')) continue;
    const template = surface.path.slice('/api/v1'.length);
    const methods = surface.kind === 'route' ? [surface.method.toUpperCase()] : ['GET', 'POST'];
    for (const method of methods) {
      if (method === 'OPTIONS' || method === 'HEAD') continue;
      for (const fill of PATH_FILLS) {
        const path = template.replace(/\{[^}]+\}/g, fill);
        const policy = resolveBearerPolicyClassification(path, method);
        if (policy.kind !== 'scope') continue;
        if (required.has(method === 'GET' ? policy.read : policy.write)) {
          out.push({ method, template, path });
          break;
        }
      }
    }
  }
  return out;
}

describe('registration: a user-registered app cannot list a first-party-only scope', () => {
  for (const scope of FIRST_PARTY_ONLY) {
    it(`refuses ${scope}, alone and next to an ordinary scope, and stores nothing`, async () => {
      const { agent } = await signedIn();

      for (const scopes of [[scope], ['portfolio:read', scope]]) {
        const response = await registerThirdParty(agent, scopes);
        expect(response.status, `${scopes.join(',')}: ${JSON.stringify(response.body)}`).toBe(400);
      }

      const listed = oauthClientListResponseSchema.parse(
        (await agent.get('/api/v1/settings/oauth-clients')).body,
      );
      expect(listed.clients).toEqual([]);
      expect(
        await harness.db
          .select()
          .from(schema.oauthClients)
          .where(eq(schema.oauthClients.isFirstParty, false)),
      ).toEqual([]);
    });
  }

  it('the service refuses them too when the HTTP schema is bypassed', async () => {
    const { user } = await signedIn();
    for (const scope of FIRST_PARTY_ONLY) {
      await expect(
        harness.ctx.oauth.registerClient({
          userId: user.id,
          name: 'Direct caller',
          redirectUris: [THIRD_PARTY_REDIRECT],
          scopes: ['portfolio:read', scope],
          public: true,
          logoUrl: null,
          ip: null,
        }),
        scope,
      ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_SCOPE' });
    }
    expect(
      await harness.db
        .select()
        .from(schema.oauthClients)
        .where(eq(schema.oauthClients.isFirstParty, false)),
    ).toEqual([]);
  });

  it('still registers an app with every other scope (negative space)', async () => {
    const { agent } = await signedIn();
    const ordinary = [
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
      'alerts:read',
      'alerts:write',
      'cash:read',
      'cash:write',
      'mirrorchain:read',
      'mirrorchain:write',
      'feedback:write',
      'feedback:read',
    ];
    const response = await registerThirdParty(agent, ordinary);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(createOAuthClientResponseSchema.parse(response.body).client.scopes).toEqual(ordinary);
  });
});

describe('effective ceiling: an app registered before the rule loses both scopes', () => {
  it('authorize no longer grants either scope to it', async () => {
    const { user, agent } = await signedIn();
    const legacy = await legacyThirdPartyApp(user, agent);
    const { challenge } = pkce();

    for (const scope of FIRST_PARTY_ONLY) {
      const params = {
        client_id: legacy.clientId,
        redirect_uri: THIRD_PARTY_REDIRECT,
        scope: `portfolio:read ${scope}`,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      };
      const details = await agent.get('/api/v1/oauth/authorization-details').query(params);
      expect(details.status, `${scope}: ${JSON.stringify(details.body)}`).toBe(400);
      expect(details.body.error.code).toBe('INVALID_SCOPE');

      const approve = await agent
        .post('/api/v1/oauth/authorize')
        .set(...XRW)
        .send(params);
      expect(approve.status, `${scope}: ${JSON.stringify(approve.body)}`).toBe(400);
      expect(approve.body.error.code).toBe('INVALID_SCOPE');
    }

    // The ordinary scope of the same app is untouched.
    const ordinary = await agent.get('/api/v1/oauth/authorization-details').query({
      client_id: legacy.clientId,
      redirect_uri: THIRD_PARTY_REDIRECT,
      scope: 'portfolio:read',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    expect(ordinary.status, JSON.stringify(ordinary.body)).toBe(200);
  });

  it('its live token can no longer export the data or delete the account', async () => {
    const { user, agent } = await signedIn();
    const legacy = await legacyThirdPartyApp(user, agent);
    const auth = bearer(legacy.accessToken);

    const status = await harness.request().get('/api/v1/account/export').set(auth);
    expect(status.status, JSON.stringify(status.body)).toBe(403);
    expect(status.body.error.code).toBe('INSUFFICIENT_SCOPE');

    const requested = await harness
      .request()
      .post('/api/v1/account/export')
      .set(auth)
      .send({ password: user.password });
    expect(requested.status, JSON.stringify(requested.body)).toBe(403);
    expect(requested.body.error.code).toBe('INSUFFICIENT_SCOPE');
    expect(await exportJobCount(user.id)).toBe(0);

    const download = await harness
      .request()
      .post('/api/v1/account/export/download')
      .set(auth)
      .send({ token: 'not-a-real-token' });
    expect(download.status, JSON.stringify(download.body)).toBe(403);
    expect(download.body.error.code).toBe('INSUFFICIENT_SCOPE');

    const deleted = await harness
      .request()
      .delete('/api/v1/account')
      .set(auth)
      .send({ confirmUsername: user.username, password: user.password });
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(403);
    expect(deleted.body.error.code).toBe('INSUFFICIENT_SCOPE');
    expect(await accountStillExists(user.id)).toBe(true);
  });

  it('its live token can no longer mint a factor or read the vault', async () => {
    const { user, agent } = await signedIn();
    const legacy = await legacyThirdPartyApp(user, agent);
    const auth = bearer(legacy.accessToken);

    const codes = await harness
      .request()
      .post('/api/v1/auth/2fa/recovery-codes')
      .set(auth)
      .send({});
    expect(codes.status, JSON.stringify(codes.body)).toBe(403);
    expect(codes.body.error.code).toBe('INSUFFICIENT_SCOPE');

    const vault = await harness.request().get('/api/v1/vaults').set(auth);
    expect(vault.status, JSON.stringify(vault.body)).toBe(403);
    expect(vault.body.error.code).toBe('INSUFFICIENT_SCOPE');

    // The scope the app legitimately holds keeps working on the same token.
    const portfolios = await harness.request().get('/api/v1/portfolios').set(auth);
    expect(portfolios.status, JSON.stringify(portfolios.body)).toBe(200);
  });

  it('refresh, the grant list and the app list all show the narrowed set', async () => {
    const { user, agent } = await signedIn();
    const legacy = await legacyThirdPartyApp(user, agent);

    const refreshed = await harness.request().post('/api/v1/oauth/token').send({
      grant_type: 'refresh_token',
      refresh_token: legacy.refreshToken,
      client_id: legacy.clientId,
    });
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
    const scope = oauthTokenResponseSchema.parse(refreshed.body).scope.split(' ');
    expect(scope).toEqual(['portfolio:read']);

    const grants = oauthGrantListResponseSchema.parse(
      (await agent.get('/api/v1/settings/oauth-grants')).body,
    ).grants;
    const grant = grants.find(({ id }) => id === legacy.grantId);
    expect(grant?.scopes).toEqual(['portfolio:read']);

    const clients = oauthClientListResponseSchema.parse(
      (await agent.get('/api/v1/settings/oauth-clients')).body,
    ).clients;
    expect(clients.map(({ clientId, scopes }) => ({ clientId, scopes }))).toEqual([
      { clientId: legacy.clientId, scopes: ['portfolio:read'] },
    ]);
  });

  it('a legacy grant holding nothing else is not refreshed into a scopeless token', async () => {
    const { user, agent } = await signedIn();
    const legacy = await legacyThirdPartyApp(user, agent);
    await harness.db
      .update(schema.oauthGrants)
      .set({ scopes: ['account:security'] })
      .where(eq(schema.oauthGrants.id, legacy.grantId));

    const refreshed = await harness.request().post('/api/v1/oauth/token').send({
      grant_type: 'refresh_token',
      refresh_token: legacy.refreshToken,
      client_id: legacy.clientId,
    });
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(400);
    expect(refreshed.body.error.code).toBe('INVALID_SCOPE');
  });

  it('its live token is refused on every mounted route a first-party-only scope opens', async () => {
    const { user, agent } = await signedIn();
    const legacy = await legacyThirdPartyApp(user, agent);
    const auth = bearer(legacy.accessToken);
    // Positive control: the token is live and its ordinary scope works.
    const ok = await harness.request().get('/api/v1/portfolios').set(auth);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);

    const routes = firstPartyOnlyRoutes();
    const keys = new Set(routes.map((route) => `${route.method} ${route.template}`));
    // Non-vacuity: the walk reaches the lifecycle, factor and vault-sync surfaces.
    for (const key of [
      'DELETE /account',
      'POST /account/export',
      'GET /account/export',
      'POST /account/export/download',
      'POST /auth/2fa/recovery-codes',
      'GET /vaults',
    ]) {
      expect(keys, key).toContain(key);
    }
    expect(routes.length).toBeGreaterThanOrEqual(30);

    const admitted: string[] = [];
    for (const route of routes) {
      const verb = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
      const pending = harness.request()[verb](`/api/v1${route.path}`).set(auth);
      const res = route.method === 'GET' ? await pending : await pending.send({});
      const code = res.body?.error?.code;
      if (!(res.status === 403 && ['INSUFFICIENT_SCOPE', 'API_KEY_FORBIDDEN'].includes(code))) {
        admitted.push(`${route.method} ${route.path} -> ${res.status} ${code ?? ''}`);
      }
    }
    expect(admitted, `walked ${routes.length} routes`).toEqual([]);
    expect(await accountStillExists(user.id)).toBe(true);
    expect(await exportJobCount(user.id)).toBe(0);
  });

  it('a realtime revalidation narrows its live token to the ceiling as well', async () => {
    const { user, agent } = await signedIn();
    const legacy = await legacyThirdPartyApp(user, agent);
    const access = await accessTokenRow(legacy.grantId);
    // Precondition: the stored row still carries both scopes.
    expect([...access.scopes].sort()).toEqual([...LEGACY_THIRD_PARTY_SCOPES].sort());

    const principal = await harness.ctx.oauth.revalidatePrincipal({
      userId: user.id,
      grantId: legacy.grantId,
      accessTokenId: access.id,
      expiresAt: access.expiresAt,
      scopes: LEGACY_THIRD_PARTY_SCOPES,
    });
    expect(principal).not.toBeNull();
    expect(principal!.firstParty).toBe(false);
    expect(principal!.scopes).toEqual(['portfolio:read']);
  });
});

/**
 * Simulates a regression of the ceiling above: the token resolver hands the
 * middleware a THIRD-party principal that carries both scopes anyway. The route
 * layer must refuse it on its own, as first-party-only, and audit it.
 */
describe('route layer: a third-party principal that still holds the scope is refused', () => {
  it('refuses export, download and deletion as first-party-only and audits each', async () => {
    const { user, agent } = await signedIn();
    const legacy = await legacyThirdPartyApp(user, agent);
    simulateThirdPartyCeilingRegression(harness, {
      grantId: legacy.grantId,
      scopes: LEGACY_THIRD_PARTY_SCOPES,
    });
    const auth = bearer(legacy.accessToken);

    const calls = [
      { method: 'GET', path: '/account/export', send: undefined },
      { method: 'POST', path: '/account/export', send: { password: user.password } },
      { method: 'POST', path: '/account/export/download', send: { token: 'not-a-real-token' } },
      {
        method: 'DELETE',
        path: '/account',
        send: { confirmUsername: user.username, password: user.password },
      },
    ] as const;
    for (const call of calls) {
      const base = harness.request();
      const pending =
        call.method === 'GET'
          ? base.get(`/api/v1${call.path}`)
          : call.method === 'POST'
            ? base.post(`/api/v1${call.path}`)
            : base.delete(`/api/v1${call.path}`);
      const response = await pending.set(auth).send(call.send ?? {});
      const label = `${call.method} ${call.path}: ${JSON.stringify(response.body)}`;
      expect(response.status, label).toBe(403);
      expect(response.body.error.code, label).toBe('API_KEY_FORBIDDEN');
      expect(response.body.error.message, label).toContain('first-party');
    }
    expect(await accountStillExists(user.id)).toBe(true);
    expect(await exportJobCount(user.id)).toBe(0);

    const denials = await harness.db
      .select({ meta: schema.auditLog.meta })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.actorId, user.id),
          eq(schema.auditLog.action, 'api_key.scope_denied'),
        ),
      );
    expect(denials).toHaveLength(calls.length);
    expect(denials.map(({ meta }) => meta)).toEqual(
      expect.arrayContaining(
        calls.map((call) =>
          expect.objectContaining({
            requiredScope: 'account:security',
            reason: 'first-party-only',
            method: call.method,
            path: call.path,
          }),
        ),
      ),
    );
  });

  it('refuses the vault-sync surface as first-party-only', async () => {
    const { user, agent } = await signedIn();
    const legacy = await legacyThirdPartyApp(user, agent);
    simulateThirdPartyCeilingRegression(harness, {
      grantId: legacy.grantId,
      scopes: LEGACY_THIRD_PARTY_SCOPES,
    });

    const response = await harness.request().get('/api/v1/vaults').set(bearer(legacy.accessToken));
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.error.code).toBe('API_KEY_FORBIDDEN');
    expect(response.body.error.message).toContain('first-party');
  });
});

describe('negative space: first-party and personal-key reach is unchanged', () => {
  it('a realtime revalidation of the mobile app keeps both scopes', async () => {
    const { user, agent } = await signedIn();
    await issueToken({
      agent,
      clientId: MOBILE.clientId,
      redirectUri: MOBILE.redirectUris[0]!,
      scopes: MOBILE.scopeCeiling,
    });
    const [grant] = await harness.db
      .select({ id: schema.oauthGrants.id })
      .from(schema.oauthGrants)
      .where(eq(schema.oauthGrants.userId, user.id));
    const access = await accessTokenRow(grant!.id);

    const principal = await harness.ctx.oauth.revalidatePrincipal({
      userId: user.id,
      grantId: grant!.id,
      accessTokenId: access.id,
      expiresAt: access.expiresAt,
      scopes: access.scopes as ApiKeyScope[],
    });
    expect(principal).not.toBeNull();
    expect(principal!.firstParty).toBe(true);
    for (const required of FIRST_PARTY_ONLY) {
      expect(principal!.scopes).toContain(required);
    }
  });

  it('the mobile app is still granted both scopes and keeps every route it uses', async () => {
    const { user, agent } = await signedIn();
    const issued = await issueToken({
      agent,
      clientId: MOBILE.clientId,
      redirectUri: MOBILE.redirectUris[0]!,
      scopes: MOBILE.scopeCeiling,
    });
    const scope = issued.scope.split(' ');
    for (const required of FIRST_PARTY_ONLY) {
      expect(scope).toContain(required);
    }
    const auth = bearer(issued.accessToken);

    for (const path of [
      '/auth/me',
      '/auth/sessions',
      '/auth/2fa/status',
      '/auth/pin/status',
      '/auth/passkeys',
      '/auth/remembered-devices',
      '/auth/google/link-status',
      '/settings/oauth-grants',
      '/settings/taxes/years',
      '/account/export',
      '/vaults',
      '/portfolios',
    ]) {
      const response = await harness.request().get(`/api/v1${path}`).set(auth);
      // Admission is the property under test: the handler may answer anything
      // (Google sign-in is not configured here, so link-status is a 404), but
      // the bearer and scope layers must never refuse the official app.
      expect([401, 403], `GET ${path}: ${JSON.stringify(response.body)}`).not.toContain(
        response.status,
      );
    }

    const requested = await harness
      .request()
      .post('/api/v1/account/export')
      .set(auth)
      .send({ password: user.password });
    expect(requested.status, JSON.stringify(requested.body)).toBe(200);

    const deleted = await harness
      .request()
      .delete('/api/v1/account')
      .set(auth)
      .send({ confirmUsername: user.username, password: user.password });
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(await accountStillExists(user.id)).toBe(false);
  });

  it('a personal API key keeps export and deletion (owner decision pending)', async () => {
    const { user, agent } = await signedIn();
    const created = await agent
      .post('/api/v1/settings/api-keys')
      .set(...XRW)
      .send({ name: 'own automation', scopes: ['account:security'] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const auth = bearer(createApiKeyResponseSchema.parse(created.body).token);

    const requested = await harness
      .request()
      .post('/api/v1/account/export')
      .set(auth)
      .send({ password: user.password });
    expect(requested.status, JSON.stringify(requested.body)).toBe(200);

    const deleted = await harness
      .request()
      .delete('/api/v1/account')
      .set(auth)
      .send({ confirmUsername: user.username, password: user.password });
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(await accountStillExists(user.id)).toBe(false);
  });
});
