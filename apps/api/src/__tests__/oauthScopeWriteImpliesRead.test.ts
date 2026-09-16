import { createHash, randomBytes } from 'node:crypto';

import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  API_KEY_SCOPES,
  IMPLIED_READ_SCOPE,
  apiErrorSchema,
  apiKeyListResponseSchema,
  createApiKeyResponseSchema,
  createOAuthClientResponseSchema,
  oauthClientListResponseSchema,
  oauthClientSummarySchema,
  oauthGrantListResponseSchema,
  oauthTokenResponseSchema,
  withImpliedReadScopes,
  type ApiKeyScope,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { hashToken } from '../services/crypto/tokens';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * V5-P0b — write⇒read applied at the SERVER's scope write paths (#1740).
 *
 * The rule ("a `:write` scope always confers its `:read`", PROJECTPLAN §6.13)
 * held in the four browser pickers and at enforcement time (`scopeSatisfies`),
 * but no server write path applied it: a non-UI API client could store a scope
 * set carrying a `:write` without its `:read`, which produced a spurious
 * `INVALID_SCOPE` refusal on authorize and an understated grant display.
 *
 * These tests pin the invariant at every path that STORES a scope set — API key
 * create, OAuth client register (user + admin first-party), first-party client
 * update, the authorization code, the grant and the access token — plus the two
 * ceiling comparisons that read one back, and the negative space (a `:read`-only
 * set is never upgraded to `:write`).
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const HTTPS_REDIRECT = 'https://app.example/callback';

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

type Agent = ReturnType<typeof request.agent>;

/** Every `:write` scope that has an implied `:read` partner in the taxonomy. */
const WRITE_SCOPES_WITH_IMPLIED_READ = Object.entries(IMPLIED_READ_SCOPE) as [
  ApiKeyScope,
  ApiKeyScope,
][];

async function loginAgent(app: Application, identifier: string, password: string): Promise<Agent> {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  return agent;
}

async function freshUserAgent(): Promise<Agent> {
  const user = await harness.seedUser({
    email: `scope-${randomBytes(5).toString('hex')}@bettertrack.test`,
    username: `scope${randomBytes(5).toString('hex')}`,
  });
  return loginAgent(harness.app, user.email, user.password);
}

async function freshAdminAgent(): Promise<Agent> {
  const admin = await harness.seedAdmin({
    email: `scope-admin-${randomBytes(5).toString('hex')}@bettertrack.test`,
    username: `scopeadmin${randomBytes(5).toString('hex')}`,
  });
  return harness.loginAdmin(admin);
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** The scope column as it is actually persisted — the whole point of this suite. */
async function storedClientScopes(clientId: string): Promise<string[]> {
  const [row] = await harness.db
    .select()
    .from(schema.oauthClients)
    .where(eq(schema.oauthClients.clientId, clientId));
  expect(row).toBeDefined();
  return row!.scopes;
}

async function storedKeyScopes(id: string): Promise<string[]> {
  const [row] = await harness.db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id));
  expect(row).toBeDefined();
  return row!.scopes;
}

async function createKey(agent: Agent, scopes: string[]) {
  const res = await agent
    .post('/api/v1/settings/api-keys')
    .set(...XRW)
    .send({ name: `key ${randomBytes(3).toString('hex')}`, scopes });
  expect(res.status).toBe(201);
  return createApiKeyResponseSchema.parse(res.body);
}

async function registerClient(agent: Agent, scopes: string[], isPublic = true) {
  const res = await agent
    .post('/api/v1/settings/oauth-clients')
    .set(...XRW)
    .send({
      name: 'Partner App',
      redirectUris: [HTTPS_REDIRECT],
      scopes,
      public: isPublic,
    });
  expect(res.status).toBe(201);
  return createOAuthClientResponseSchema.parse(res.body);
}

async function registerFirstPartyClient(adminAgent: Agent, scopes: string[]) {
  const res = await adminAgent
    .post('/api/v1/admin/oauth-clients')
    .set(...XRW)
    .send({ name: 'Official App', redirectUris: [HTTPS_REDIRECT], scopes, public: true });
  expect(res.status).toBe(201);
  return createOAuthClientResponseSchema.parse(res.body).client;
}

/**
 * Insert an OAuth client row DIRECTLY, bypassing the service — the only way to
 * reproduce a pre-#1740 row whose stored ceiling carries a `:write` without its
 * `:read`, which is the "already-stored rows" case this branch handles on the
 * READ side rather than with a migration.
 */
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

describe('#1740 — API key create stores the implied read', () => {
  it('stores BOTH halves when only the :write is requested', async () => {
    const agent = await freshUserAgent();
    const created = await createKey(agent, ['portfolio:write']);

    // RED before #1740: the row stored exactly ['portfolio:write'].
    expect(await storedKeyScopes(created.key.id)).toEqual(['portfolio:read', 'portfolio:write']);
    expect(created.key.scopes).toEqual(['portfolio:read', 'portfolio:write']);

    const list = apiKeyListResponseSchema.parse(
      (await agent.get('/api/v1/settings/api-keys')).body,
    );
    expect(list.keys[0]!.scopes).toEqual(['portfolio:read', 'portfolio:write']);
  });

  it('does NOT upgrade a :read-only set to :write (negative space)', async () => {
    const agent = await freshUserAgent();
    const created = await createKey(agent, ['portfolio:read', 'market:read']);

    expect(await storedKeyScopes(created.key.id)).toEqual(['portfolio:read', 'market:read']);
    expect(created.key.scopes).not.toContain('portfolio:write');
  });

  it('still rejects an unknown scope (nothing new became grantable)', async () => {
    const agent = await freshUserAgent();
    const res = await agent
      .post('/api/v1/settings/api-keys')
      .set(...XRW)
      .send({ name: 'bad', scopes: ['portfolio:admin'] });
    expect(res.status).toBe(400);
    apiErrorSchema.parse(res.body);
  });
});

describe('#1740 — OAuth client registration stores the implied read', () => {
  it('normalizes a user-registered (third-party) client ceiling', async () => {
    const agent = await freshUserAgent();
    const { client } = await registerClient(agent, ['portfolio:write']);

    // RED before #1740: the ceiling stored exactly ['portfolio:write'].
    expect(await storedClientScopes(client.clientId)).toEqual([
      'portfolio:read',
      'portfolio:write',
    ]);
    expect(client.scopes).toEqual(['portfolio:read', 'portfolio:write']);

    const list = oauthClientListResponseSchema.parse(
      (await agent.get('/api/v1/settings/oauth-clients')).body,
    );
    expect(list.clients[0]!.scopes).toEqual(['portfolio:read', 'portfolio:write']);
  });

  it('normalizes an admin-registered first-party client ceiling', async () => {
    const adminAgent = await freshAdminAgent();
    const client = await registerFirstPartyClient(adminAgent, ['workboard:write']);

    expect(await storedClientScopes(client.clientId)).toEqual([
      'workboard:read',
      'workboard:write',
    ]);
    expect(client.scopes).toEqual(['workboard:read', 'workboard:write']);
  });

  it('normalizes a first-party client UPDATE', async () => {
    const adminAgent = await freshAdminAgent();
    const client = await registerFirstPartyClient(adminAgent, ['portfolio:read']);

    const res = await adminAgent
      .patch(`/api/v1/admin/oauth-clients/${client.id}`)
      .set(...XRW)
      .send({
        name: 'Official App',
        redirectUris: [HTTPS_REDIRECT],
        scopes: ['cash:write'],
      });
    expect(res.status).toBe(200);
    const updated = oauthClientSummarySchema.parse(res.body);

    expect(updated.scopes).toEqual(['cash:read', 'cash:write']);
    expect(await storedClientScopes(client.clientId)).toEqual(['cash:read', 'cash:write']);
  });

  it('a :read-only ceiling is never widened to :write on register or update', async () => {
    const adminAgent = await freshAdminAgent();
    const client = await registerFirstPartyClient(adminAgent, ['market:read', 'social:read']);
    expect(await storedClientScopes(client.clientId)).toEqual(['market:read', 'social:read']);

    const res = await adminAgent
      .patch(`/api/v1/admin/oauth-clients/${client.id}`)
      .set(...XRW)
      .send({ name: 'Official App', redirectUris: [HTTPS_REDIRECT], scopes: ['alerts:read'] });
    expect(res.status).toBe(200);
    expect(await storedClientScopes(client.clientId)).toEqual(['alerts:read']);
  });
});

describe('#1740 — the ceiling comparisons honour write⇒read', () => {
  it('authorize for scope=portfolio:read against a :write-only ceiling no longer returns INVALID_SCOPE', async () => {
    // A pre-#1740 row: the ceiling holds the write but not its read. Registering
    // through the API can no longer produce this shape, so insert it directly.
    const owner = await harness.seedUser({
      email: `legacy-owner-${randomBytes(4).toString('hex')}@bettertrack.test`,
      username: `legacyowner${randomBytes(4).toString('hex')}`,
    });
    const legacy = await insertLegacyClientRow(['portfolio:write'], owner.id);
    const agent = await freshUserAgent();
    const { challenge } = pkce();

    const res = await agent.get('/api/v1/oauth/authorization-details').query({
      client_id: legacy.clientId,
      redirect_uri: HTTPS_REDIRECT,
      scope: 'portfolio:read',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });

    // RED before #1740: 400 INVALID_SCOPE ("Scope … is not permitted for this
    // app") even though a token from this client already reaches every
    // portfolio:read route through `scopeSatisfies`.
    expect(res.status).toBe(200);
  });

  it('a genuinely un-permitted scope is still refused with INVALID_SCOPE', async () => {
    const agent = await freshUserAgent();
    const { client } = await registerClient(agent, ['portfolio:write']);
    const { challenge } = pkce();

    const res = await agent.get('/api/v1/oauth/authorization-details').query({
      client_id: client.clientId,
      redirect_uri: HTTPS_REDIRECT,
      scope: 'workboard:read',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });

    expect(res.status).toBe(400);
    expect(apiErrorSchema.parse(res.body).error.code).toBe('INVALID_SCOPE');
  });

  it('a :read never satisfies the ceiling for its :write (no reverse implication)', async () => {
    const agent = await freshUserAgent();
    const { client } = await registerClient(agent, ['portfolio:read']);
    const { challenge } = pkce();

    const res = await agent.get('/api/v1/oauth/authorization-details').query({
      client_id: client.clientId,
      redirect_uri: HTTPS_REDIRECT,
      scope: 'portfolio:write',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });

    expect(res.status).toBe(400);
    expect(apiErrorSchema.parse(res.body).error.code).toBe('INVALID_SCOPE');
  });

  it('the grants list keeps a consented :read whose ceiling only holds the :write', async () => {
    const user = await harness.seedUser({
      email: `grantread-${randomBytes(4).toString('hex')}@bettertrack.test`,
      username: `grantread${randomBytes(4).toString('hex')}`,
    });
    const legacy = await insertLegacyClientRow(['portfolio:write'], user.id);
    await harness.db
      .insert(schema.oauthGrants)
      .values({ clientId: legacy.id, userId: user.id, scopes: ['portfolio:read'] });

    const agent = await loginAgent(harness.app, user.email, user.password);
    const res = await agent.get('/api/v1/settings/oauth-grants');
    expect(res.status).toBe(200);
    const grants = oauthGrantListResponseSchema.parse(res.body).grants;

    // RED before #1740: `clampToAllowed` filtered the consented read out with raw
    // set membership, leaving an EMPTY scope list on a live, usable grant.
    expect(grants).toHaveLength(1);
    expect(grants[0]!.scopes).toContain('portfolio:read');
  });
});

describe('#1740 — consent, grant and token stay closed under write⇒read', () => {
  it('a scope=…:write consent stores both halves on the code, grant and access token', async () => {
    const ownerAgent = await freshUserAgent();
    const { client } = await registerClient(ownerAgent, ['chat:write'], true);
    const agent = await freshUserAgent();
    const { verifier, challenge } = pkce();

    const approve = await agent
      .post('/api/v1/oauth/authorize')
      .set(...XRW)
      .send({
        client_id: client.clientId,
        redirect_uri: HTTPS_REDIRECT,
        scope: 'chat:write',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
    expect(approve.status).toBe(200);
    const code = new URL(approve.body.redirectTo as string).searchParams.get('code')!;

    const [codeRow] = await harness.db
      .select()
      .from(schema.oauthAuthCodes)
      .where(eq(schema.oauthAuthCodes.codeHash, hashToken(code)));
    expect(codeRow!.scopes).toEqual(['chat:read', 'chat:write']);

    const token = await request(harness.app).post('/api/v1/oauth/token').send({
      grant_type: 'authorization_code',
      code,
      redirect_uri: HTTPS_REDIRECT,
      client_id: client.clientId,
      code_verifier: verifier,
    });
    expect(token.status).toBe(200);
    const parsed = oauthTokenResponseSchema.parse(token.body);
    expect(parsed.scope.split(' ').sort()).toEqual(['chat:read', 'chat:write']);

    const [grant] = await harness.db.select().from(schema.oauthGrants);
    expect(grant!.scopes).toEqual(['chat:read', 'chat:write']);
    const [access] = await harness.db.select().from(schema.oauthAccessTokens);
    expect(access!.scopes).toEqual(['chat:read', 'chat:write']);
  });

  it('a refresh re-issues the closed set even from a pre-#1740 grant row', async () => {
    const ownerAgent = await freshUserAgent();
    const { client, clientSecret } = await registerClient(ownerAgent, ['cash:write'], false);
    const agent = await freshUserAgent();
    const approve = await agent
      .post('/api/v1/oauth/authorize')
      .set(...XRW)
      .send({
        client_id: client.clientId,
        redirect_uri: HTTPS_REDIRECT,
        scope: 'cash:write',
      });
    expect(approve.status).toBe(200);
    const code = new URL(approve.body.redirectTo as string).searchParams.get('code')!;
    const first = await request(harness.app).post('/api/v1/oauth/token').send({
      grant_type: 'authorization_code',
      code,
      redirect_uri: HTTPS_REDIRECT,
      client_id: client.clientId,
      client_secret: clientSecret,
    });
    expect(first.status).toBe(200);

    // Rewrite the grant to the pre-#1740 shape (a :write with no :read) and
    // refresh: the newly issued token must carry the closed set anyway.
    await harness.db.update(schema.oauthGrants).set({ scopes: ['cash:write'] });
    const refreshed = await request(harness.app)
      .post('/api/v1/oauth/token')
      .send({
        grant_type: 'refresh_token',
        refresh_token: oauthTokenResponseSchema.parse(first.body).refresh_token,
        client_id: client.clientId,
        client_secret: clientSecret,
      });
    expect(refreshed.status).toBe(200);
    expect(oauthTokenResponseSchema.parse(refreshed.body).scope.split(' ').sort()).toEqual([
      'cash:read',
      'cash:write',
    ]);
  });

  it('narrowing an app still applies immediately (§16 2026-08-19 unchanged)', async () => {
    const adminAgent = await freshAdminAgent();
    const client = await registerFirstPartyClient(adminAgent, ['portfolio:write', 'cash:write']);
    const user = await harness.seedUser({
      email: `narrow-${randomBytes(4).toString('hex')}@bettertrack.test`,
      username: `narrow${randomBytes(4).toString('hex')}`,
    });
    const agent = await loginAgent(harness.app, user.email, user.password);
    const { verifier, challenge } = pkce();
    const approve = await agent
      .post('/api/v1/oauth/authorize')
      .set(...XRW)
      .send({
        client_id: client.clientId,
        redirect_uri: HTTPS_REDIRECT,
        scope: 'portfolio:write cash:write',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
    expect(approve.status).toBe(200);
    const code = new URL(approve.body.redirectTo as string).searchParams.get('code')!;
    const token = await request(harness.app).post('/api/v1/oauth/token').send({
      grant_type: 'authorization_code',
      code,
      redirect_uri: HTTPS_REDIRECT,
      client_id: client.clientId,
      code_verifier: verifier,
    });
    expect(token.status).toBe(200);

    const narrowed = await adminAgent
      .patch(`/api/v1/admin/oauth-clients/${client.id}`)
      .set(...XRW)
      .send({
        name: 'Official App',
        redirectUris: [HTTPS_REDIRECT],
        scopes: ['portfolio:read'],
      });
    expect(narrowed.status).toBe(200);
    expect(await storedClientScopes(client.clientId)).toEqual(['portfolio:read']);

    // The live grant loses cash entirely and keeps only the narrowed read half —
    // narrowing is still immediate; write⇒read never resurrects a removed write.
    const grants = oauthGrantListResponseSchema.parse(
      (await agent.get('/api/v1/settings/oauth-grants')).body,
    ).grants;
    expect(grants).toHaveLength(1);
    expect(grants[0]!.scopes).toEqual(['portfolio:read']);
  });

  it('widening an app still never auto-widens a live third-party grant', async () => {
    const ownerAgent = await freshUserAgent();
    const { client, clientSecret } = await registerClient(ownerAgent, ['portfolio:write'], false);
    const user = await harness.seedUser({
      email: `widen-${randomBytes(4).toString('hex')}@bettertrack.test`,
      username: `widen${randomBytes(4).toString('hex')}`,
    });
    const agent = await loginAgent(harness.app, user.email, user.password);
    const approve = await agent
      .post('/api/v1/oauth/authorize')
      .set(...XRW)
      .send({
        client_id: client.clientId,
        redirect_uri: HTTPS_REDIRECT,
        scope: 'portfolio:write',
      });
    expect(approve.status).toBe(200);
    const code = new URL(approve.body.redirectTo as string).searchParams.get('code')!;
    const token = await request(harness.app).post('/api/v1/oauth/token').send({
      grant_type: 'authorization_code',
      code,
      redirect_uri: HTTPS_REDIRECT,
      client_id: client.clientId,
      client_secret: clientSecret,
    });
    expect(token.status).toBe(200);

    // The owner widens the app's ceiling after the fact.
    await harness.db
      .update(schema.oauthClients)
      .set({ scopes: ['portfolio:read', 'portfolio:write', 'cash:read', 'cash:write'] })
      .where(eq(schema.oauthClients.clientId, client.clientId));

    const grants = oauthGrantListResponseSchema.parse(
      (await agent.get('/api/v1/settings/oauth-grants')).body,
    ).grants;
    expect(grants[0]!.scopes).toEqual(['portfolio:read', 'portfolio:write']);
    expect(grants[0]!.scopes).not.toContain('cash:read');
  });
});

describe('#1740 — the invariant, across every write path', () => {
  it('every stored :write carries its implied :read (api key create + client register/update)', async () => {
    const agent = await freshUserAgent();
    const adminAgent = await freshAdminAgent();

    for (const [write, read] of WRITE_SCOPES_WITH_IMPLIED_READ) {
      // Canonical API_KEY_SCOPES order, which is NOT always read-then-write:
      // `feedback:read` was appended after `feedback:write` shipped (#1338).
      const pair = withImpliedReadScopes([write]);
      expect(pair).toHaveLength(2);
      expect(pair).toContain(read);

      const key = await createKey(agent, [write]);
      expect(await storedKeyScopes(key.key.id), `api key create: ${write}`).toEqual(pair);

      const { client } = await registerClient(agent, [write]);
      expect(await storedClientScopes(client.clientId), `client register: ${write}`).toEqual(pair);

      const firstParty = await registerFirstPartyClient(adminAgent, [write]);
      expect(
        await storedClientScopes(firstParty.clientId),
        `first-party register: ${write}`,
      ).toEqual(pair);

      const patched = await adminAgent
        .patch(`/api/v1/admin/oauth-clients/${firstParty.id}`)
        .set(...XRW)
        .send({ name: 'Official App', redirectUris: [HTTPS_REDIRECT], scopes: [write] });
      expect(patched.status).toBe(200);
      expect(await storedClientScopes(firstParty.clientId), `first-party update: ${write}`).toEqual(
        pair,
      );
    }
  });

  it('the full scope set round-trips unchanged (already closed ⇒ idempotent)', async () => {
    const adminAgent = await freshAdminAgent();
    const all = [...API_KEY_SCOPES];
    const client = await registerFirstPartyClient(adminAgent, all);
    expect(await storedClientScopes(client.clientId)).toEqual(withImpliedReadScopes(all));
    expect(await storedClientScopes(client.clientId)).toEqual(all);
  });
});
