import { createHash, randomBytes } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import { oauthTokenResponseSchema, type ApiKeyScope } from '@bettertrack/contracts';

import { createOAuthRepository } from '../data/repositories/oauthRepository';
import * as schema from '../data/schema';
import { seedFirstPartyClients } from '../services/oauth/firstPartyClients';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * The scope CEILING, pinned at the TOKEN rather than at the grants list (#1740,
 * landed from the #1979 review's probe set):
 *
 * - narrowing a client's ceiling after consent drops the removed write AND its
 *   implied read from the live token and from the refreshed one;
 * - widening the ceiling after consent never reaches a live third-party grant,
 *   not even through the refresh normalizer (§16 2026-08-19);
 * - a consented `:read` under a legacy `:write`-only ceiling yields exactly that
 *   read and no write — the one bounded widening the write⇒read rule allows;
 * - the consent payload, the stored code/grant/token set and the audit meta are
 *   the same normalized set;
 * - the first-party seed stays additive and idempotent.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const HTTPS_REDIRECT = 'https://app.example/callback';

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

type Agent = ReturnType<typeof request.agent>;

async function loginAgent(app: Application, identifier: string, password: string): Promise<Agent> {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  return agent;
}

async function freshUser() {
  return harness.seedUser({
    email: `p-${randomBytes(5).toString('hex')}@bettertrack.test`,
    username: `p${randomBytes(5).toString('hex')}`,
  });
}

async function freshUserAgent(): Promise<Agent> {
  const user = await freshUser();
  return loginAgent(harness.app, user.email, user.password);
}

async function freshAdminAgent(): Promise<Agent> {
  const admin = await harness.seedAdmin({
    email: `pa-${randomBytes(5).toString('hex')}@bettertrack.test`,
    username: `pa${randomBytes(5).toString('hex')}`,
  });
  return harness.loginAdmin(admin);
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

const bearer = (token: string) => ['Authorization', `Bearer ${token}`] as const;

async function registerFirstPartyClient(adminAgent: Agent, scopes: string[]) {
  const res = await adminAgent
    .post('/api/v1/admin/oauth-clients')
    .set(...XRW)
    .send({ name: 'Official App', redirectUris: [HTTPS_REDIRECT], scopes, public: true });
  expect(res.status).toBe(201);
  return res.body.client as { id: string; clientId: string };
}

async function registerThirdPartyClient(agent: Agent, scopes: string[]) {
  const res = await agent
    .post('/api/v1/settings/oauth-clients')
    .set(...XRW)
    .send({ name: 'Partner App', redirectUris: [HTTPS_REDIRECT], scopes, public: true });
  expect(res.status).toBe(201);
  return res.body.client as { id: string; clientId: string };
}

async function insertLegacyClientRow(scopes: string[], userId: string | null) {
  const [row] = await harness.db
    .insert(schema.oauthClients)
    .values({
      userId,
      clientId: `btc_legacy${randomBytes(8).toString('base64url')}`,
      name: 'Legacy App',
      clientSecretHash: null,
      redirectUris: [HTTPS_REDIRECT],
      scopes,
      isPublic: true,
      isFirstParty: false,
    })
    .returning();
  return row!;
}

/** Full PKCE authorize → token for a public client. */
async function consentAndToken(agent: Agent, clientId: string, scope: string) {
  const { verifier, challenge } = pkce();
  const approve = await agent
    .post('/api/v1/oauth/authorize')
    .set(...XRW)
    .send({
      client_id: clientId,
      redirect_uri: HTTPS_REDIRECT,
      scope,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
  expect(approve.status).toBe(200);
  const code = new URL(approve.body.redirectTo as string).searchParams.get('code')!;
  const token = await request(harness.app).post('/api/v1/oauth/token').send({
    grant_type: 'authorization_code',
    code,
    redirect_uri: HTTPS_REDIRECT,
    client_id: clientId,
    code_verifier: verifier,
  });
  expect(token.status).toBe(200);
  return oauthTokenResponseSchema.parse(token.body);
}

async function refresh(clientId: string, refreshToken: string) {
  const res = await request(harness.app).post('/api/v1/oauth/token').send({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
  expect(res.status).toBe(200);
  return oauthTokenResponseSchema.parse(res.body);
}

const status = async (method: 'get' | 'post', path: string, token: string, body?: unknown) => {
  const req = request(harness.app)
    [method](path)
    .set(...bearer(token));
  if (method === 'post') {
    void req.set(...XRW);
    return (await req.send(body ?? {})).status;
  }
  return (await req).status;
};

/* ═══════════════════════════════════════════════════════════════════════════
 * P1 — NARROWING a :write away must take BOTH halves off a live token.
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('probe: narrowing removes the write AND its implied read', () => {
  it('a live token and its refresh both lose the removed module entirely', async () => {
    const adminAgent = await freshAdminAgent();
    const client = await registerFirstPartyClient(adminAgent, [
      'portfolio:write',
      'workboard:write',
    ]);
    const user = await freshUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const tok = await consentAndToken(agent, client.clientId, 'portfolio:write workboard:write');
    expect(tok.scope.split(' ').sort()).toEqual([
      'portfolio:read',
      'portfolio:write',
      'workboard:read',
      'workboard:write',
    ]);

    // Baseline: both modules reachable.
    expect(await status('get', '/api/v1/portfolios', tok.access_token)).toBe(200);
    expect(await status('get', '/api/v1/workboard', tok.access_token)).toBe(200);

    // Admin narrows to portfolio:read ONLY.
    const patch = await adminAgent
      .patch(`/api/v1/admin/oauth-clients/${client.id}`)
      .set(...XRW)
      .send({
        name: 'Official App',
        redirectUris: [HTTPS_REDIRECT],
        scopes: ['portfolio:read'],
      });
    expect(patch.status).toBe(200);

    // Live token: workboard gone (read half must NOT survive its write's removal).
    expect(await status('get', '/api/v1/workboard', tok.access_token)).toBe(403);
    expect(await status('get', '/api/v1/portfolios', tok.access_token)).toBe(200);
    // portfolio:write must be gone too.
    const wrote = await status('post', '/api/v1/portfolios', tok.access_token, {
      name: 'x',
      baseCurrency: 'EUR',
    });
    expect(wrote).toBe(403);

    // Refresh must not resurrect anything.
    const next = await refresh(client.clientId, tok.refresh_token);
    expect(next.scope).toBe('portfolio:read');
    expect(await status('get', '/api/v1/workboard', next.access_token)).toBe(403);
    expect(
      await status('post', '/api/v1/portfolios', next.access_token, {
        name: 'x',
        baseCurrency: 'EUR',
      }),
    ).toBe(403);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * P2 — WIDENING never reaches a live third-party grant, at refresh too.
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('probe: widening never auto-widens, including through the refresh normalizer', () => {
  it('a read-only consent stays read-only after the ceiling gains the write', async () => {
    const ownerAgent = await freshUserAgent();
    const client = await registerThirdPartyClient(ownerAgent, ['portfolio:read']);
    const user = await freshUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const tok = await consentAndToken(agent, client.clientId, 'portfolio:read');
    expect(tok.scope).toBe('portfolio:read');

    await harness.db
      .update(schema.oauthClients)
      .set({ scopes: ['portfolio:read', 'portfolio:write', 'workboard:read', 'workboard:write'] })
      .where(eq(schema.oauthClients.clientId, client.clientId));

    const next = await refresh(client.clientId, tok.refresh_token);
    expect(next.scope).toBe('portfolio:read');
    expect(await status('get', '/api/v1/workboard', next.access_token)).toBe(403);
    expect(
      await status('post', '/api/v1/portfolios', next.access_token, {
        name: 'x',
        baseCurrency: 'EUR',
      }),
    ).toBe(403);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * P3 — the stated trade-off is BOUNDED: legacy :write-only ceiling + consented
 *      :read yields the read and ONLY the read.
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('probe: the clampToAllowed/scopeSatisfies trade-off is bounded to the read', () => {
  it('a consented :read under a legacy :write-only ceiling cannot write', async () => {
    const owner = await freshUser();
    const legacy = await insertLegacyClientRow(['portfolio:write'], owner.id);
    const user = await freshUser();
    const agent = await loginAgent(harness.app, user.email, user.password);

    const tok = await consentAndToken(agent, legacy.clientId, 'portfolio:read');
    expect(tok.scope).toBe('portfolio:read');
    expect(await status('get', '/api/v1/portfolios', tok.access_token)).toBe(200);
    expect(
      await status('post', '/api/v1/portfolios', tok.access_token, {
        name: 'x',
        baseCurrency: 'EUR',
      }),
    ).toBe(403);

    // The stored grant is exactly the consented read — no write crept in.
    const [grant] = await harness.db
      .select({ scopes: schema.oauthGrants.scopes })
      .from(schema.oauthGrants)
      .where(eq(schema.oauthGrants.userId, user.id));
    expect(grant!.scopes).toEqual(['portfolio:read']);

    const next = await refresh(legacy.clientId, tok.refresh_token);
    expect(next.scope).toBe('portfolio:read');
  });

  it('a module absent from the ceiling is still refused after the fix', async () => {
    const owner = await freshUser();
    const legacy = await insertLegacyClientRow(['portfolio:write'], owner.id);
    const agent = await freshUserAgent();
    const { challenge } = pkce();
    const res = await agent.get('/api/v1/oauth/authorization-details').query({
      client_id: legacy.clientId,
      redirect_uri: HTTPS_REDIRECT,
      scope: 'portfolio:read cash:read',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_SCOPE');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * P4 — the consent screen shows EXACTLY what is stored.
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('probe: consent payload == stored code/grant/token scope set', () => {
  it('details, grant row and token scope agree for a :write-only request', async () => {
    const ownerAgent = await freshUserAgent();
    const client = await registerThirdPartyClient(ownerAgent, ['chat:write']);
    const user = await freshUser();
    const agent = await loginAgent(harness.app, user.email, user.password);

    const { challenge } = pkce();
    const details = await agent.get('/api/v1/oauth/authorization-details').query({
      client_id: client.clientId,
      redirect_uri: HTTPS_REDIRECT,
      scope: 'chat:write',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    expect(details.status).toBe(200);
    const shown = (details.body.scopes as { scope: string }[]).map((s) => s.scope).sort();
    expect(shown).toEqual(['chat:read', 'chat:write']);

    const tok = await consentAndToken(agent, client.clientId, 'chat:write');
    expect(tok.scope.split(' ').sort()).toEqual(shown);

    const [grant] = await harness.db
      .select({ scopes: schema.oauthGrants.scopes })
      .from(schema.oauthGrants)
      .where(eq(schema.oauthGrants.userId, user.id));
    expect([...grant!.scopes].sort()).toEqual(shown);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * P5 — audit rows carry the stored (normalized) set.
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('probe: audit meta matches storage', () => {
  it('api-key create and oauth-client register audit the normalized set', async () => {
    const user = await freshUser();
    const agent = await loginAgent(harness.app, user.email, user.password);

    const key = await agent
      .post('/api/v1/settings/api-keys')
      .set(...XRW)
      .send({ name: 'probe', scopes: ['cash:write'] });
    expect(key.status).toBe(201);
    const keyId = key.body.key.id as string;

    const [keyAudit] = await harness.db
      .select({ meta: schema.auditLog.meta })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.targetType, 'api_key'), eq(schema.auditLog.targetId, keyId)));
    expect((keyAudit!.meta as { scopes: string[] }).scopes).toEqual(['cash:read', 'cash:write']);

    const client = await registerThirdPartyClient(agent, ['alerts:write']);
    const [clientAudit] = await harness.db
      .select({ meta: schema.auditLog.meta })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.targetType, 'oauth_client'),
          eq(schema.auditLog.targetId, client.id),
        ),
      );
    expect((clientAudit!.meta as { scopes: string[] }).scopes).toEqual([
      'alerts:read',
      'alerts:write',
    ]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * P6 — the boot seed: additive, never-drop, never-reorder, idempotent.
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('probe: first-party seed stays additive and idempotent', () => {
  const CUSTOM = {
    clientId: 'btc_probe_seed_client',
    name: 'Probe App',
    redirectUris: ['https://probe.example/cb'] as const,
    public: true,
    scopeCeiling: ['chat:write', 'market:read'] as readonly ApiKeyScope[],
  };

  async function row() {
    const [r] = await harness.db
      .select()
      .from(schema.oauthClients)
      .where(eq(schema.oauthClients.clientId, CUSTOM.clientId));
    return r ?? null;
  }

  it('creates with the implied read appended, then re-runs byte-identical', async () => {
    const repo = createOAuthRepository(harness.db);
    const first = await seedFirstPartyClients(repo, [CUSTOM]);
    expect(first[0]!.action).toBe('created');
    const created = (await row())!.scopes;
    expect(created).toContain('chat:read');
    expect(created).toContain('chat:write');

    const second = await seedFirstPartyClients(repo, [CUSTOM]);
    expect(second[0]!.action).toBe('unchanged');
    expect((await row())!.scopes).toEqual(created);
  });

  it('heals a legacy half-set without dropping or reordering an admin extra', async () => {
    const repo = createOAuthRepository(harness.db);
    await seedFirstPartyClients(repo, [CUSTOM]);
    // Legacy shape: a :write with no :read, an unknown admin-added scope, and a
    // deliberately non-canonical order.
    const legacy = ['market:read', 'admin:custom-extra', 'chat:write'];
    await harness.db
      .update(schema.oauthClients)
      .set({ scopes: legacy })
      .where(eq(schema.oauthClients.clientId, CUSTOM.clientId));

    const healed = await seedFirstPartyClients(repo, [CUSTOM]);
    expect(healed[0]!.action).toBe('converged');
    const after = (await row())!.scopes;
    // never-drop: every legacy entry survives, in its original relative order.
    expect(after.slice(0, legacy.length)).toEqual(legacy);
    expect(after).toContain('chat:read');

    // idempotent from there.
    const again = await seedFirstPartyClients(repo, [CUSTOM]);
    expect(again[0]!.action).toBe('unchanged');
    expect((await row())!.scopes).toEqual(after);
  });
});
