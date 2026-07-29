import { createHash, randomBytes } from 'node:crypto';

import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OAUTH_ACCESS_TOKEN_PREFIX,
  OAUTH_CLIENT_ID_PREFIX,
  OAUTH_CLIENT_SECRET_PREFIX,
  OAUTH_REFRESH_TOKEN_PREFIX,
  createOAuthClientResponseSchema,
  oauthAuthorizationDetailsResponseSchema,
  oauthClientSummarySchema,
  oauthGrantListResponseSchema,
  oauthTokenResponseSchema,
  type OAuthClientSummary,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import {
  createOAuthRepository,
  type OAuthAuthorizationCodeExchange,
  type OAuthRepository,
} from '../data/repositories/oauthRepository';
import { createAuditRepository } from '../data/repositories/auditRepository';
import { createAuditService } from '../services/audit/auditService';
import { hashToken } from '../services/crypto/tokens';
import {
  OAUTH_LOGO_MAX_BYTES,
  createOAuthLogoFetcher,
  type OAuthLogoFetcher,
  type OAuthLogoTransport,
} from '../services/oauth/oauthLogo';
import { createOAuthService } from '../services/oauth/oauthService';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const HTTPS_REDIRECT = 'https://app.example/callback';
const NATIVE_REDIRECT = 'myapp://callback';
const PNG_LOGO = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

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

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

interface RegisteredClient {
  agent: Agent;
  clientId: string;
  clientSecret: string | null;
  logoPath: string | null;
}

async function registerClient(opts: {
  scopes?: string[];
  redirectUris?: string[];
  public?: boolean;
  logoUrl?: string;
}): Promise<RegisteredClient> {
  const user = await harness.seedUser({
    email: `owner-${randomBytes(4).toString('hex')}@bettertrack.test`,
    username: `owner${randomBytes(4).toString('hex')}`,
  });
  const agent = await loginAgent(harness.app, user.email, user.password);
  const res = await agent
    .post('/api/v1/settings/oauth-clients')
    .set(...XRW)
    .send({
      name: 'Partner App',
      redirectUris: opts.redirectUris ?? [HTTPS_REDIRECT],
      scopes: opts.scopes ?? ['portfolio:read'],
      public: opts.public ?? false,
      logoUrl: opts.logoUrl,
    });
  expect(res.status).toBe(201);
  const parsed = createOAuthClientResponseSchema.parse(res.body);
  return {
    agent,
    clientId: parsed.client.clientId,
    clientSecret: parsed.clientSecret,
    logoPath: parsed.client.logoPath,
  };
}

/** Register a first-party (admin-managed) client via the admin endpoint. */
async function registerFirstPartyClient(
  opts: { scopes?: string[]; public?: boolean } = {},
): Promise<{ clientId: string; clientSecret: string | null }> {
  const admin = await harness.seedAdmin({
    email: `fp-admin-${randomBytes(4).toString('hex')}@bettertrack.test`,
    username: `fpadmin${randomBytes(4).toString('hex')}`,
  });
  const agent = await harness.loginAdmin(admin);
  const res = await agent
    .post('/api/v1/admin/oauth-clients')
    .set(...XRW)
    .send({
      name: 'BetterTrack Mobile',
      redirectUris: [HTTPS_REDIRECT],
      scopes: opts.scopes ?? ['portfolio:read'],
      public: opts.public ?? true,
    });
  expect(res.status).toBe(201);
  const parsed = createOAuthClientResponseSchema.parse(res.body);
  expect(parsed.client.firstParty).toBe(true);
  return { clientId: parsed.client.clientId, clientSecret: parsed.clientSecret };
}

/**
 * Register a first-party client AND keep the logged-in admin agent + the full
 * client summary (incl. the internal id the edit route addresses) — the setup for
 * the #341 edit / consent-safety tests.
 */
async function adminAndFirstPartyClient(
  opts: { scopes?: string[]; redirectUris?: string[]; public?: boolean } = {},
): Promise<{ adminAgent: Agent; client: OAuthClientSummary }> {
  const admin = await harness.seedAdmin({
    email: `fp-admin-${randomBytes(4).toString('hex')}@bettertrack.test`,
    username: `fpadmin${randomBytes(4).toString('hex')}`,
  });
  const adminAgent = await harness.loginAdmin(admin);
  const res = await adminAgent
    .post('/api/v1/admin/oauth-clients')
    .set(...XRW)
    .send({
      name: 'BetterTrack Mobile',
      redirectUris: opts.redirectUris ?? [HTTPS_REDIRECT],
      scopes: opts.scopes ?? ['portfolio:read'],
      public: opts.public ?? true,
    });
  expect(res.status).toBe(201);
  return { adminAgent, client: createOAuthClientResponseSchema.parse(res.body).client };
}

/** PATCH a first-party client through the admin edit route (#341). */
function editFirstPartyClient(
  adminAgent: Agent,
  id: string,
  body: { name: string; redirectUris: string[]; scopes: string[] },
) {
  return adminAgent
    .patch(`/api/v1/admin/oauth-clients/${id}`)
    .set(...XRW)
    .send(body);
}

/** Full public-client consent → token exchange, returning the issued tokens. */
async function consentAndToken(
  agent: Agent,
  clientId: string,
  scope: string,
  redirectUri = HTTPS_REDIRECT,
): Promise<{ access: string; refresh: string }> {
  const { verifier, challenge } = pkce();
  const { code } = await approveAndGetCode(agent, {
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  const tokenRes = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });
  expect(tokenRes.status).toBe(200);
  const tokens = oauthTokenResponseSchema.parse(tokenRes.body);
  return { access: tokens.access_token, refresh: tokens.refresh_token };
}

const bearer = (token: string) => ['Authorization', `Bearer ${token}`] as const;

/** Approve consent as the session user and return the delivered authorization code. */
async function approveAndGetCode(
  agent: Agent,
  params: Record<string, string>,
): Promise<{ code: string; redirectTo: string }> {
  const res = await agent
    .post('/api/v1/oauth/authorize')
    .set(...XRW)
    .send(params);
  expect(res.status).toBe(200);
  const redirectTo = res.body.redirectTo as string;
  const url = new URL(redirectTo);
  const code = url.searchParams.get('code');
  expect(code).toBeTruthy();
  return { code: code!, redirectTo };
}

function tokenRequest(body: Record<string, unknown>) {
  return request(harness.app).post('/api/v1/oauth/token').send(body);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function auditActions(): Promise<string[]> {
  const rows = await harness.db.select({ action: schema.auditLog.action }).from(schema.auditLog);
  return rows.map((r) => r.action);
}

describe('OAuth logo fetch hardening', () => {
  const resolved = (sourceUrl: string) =>
    Promise.resolve({
      url: new URL(sourceUrl),
      addresses: [{ address: '93.184.216.34', family: 4 }],
    });

  it('runs the shared outbound-URL guard before transport and blocks private destinations', async () => {
    const transport: OAuthLogoTransport = vi.fn(async () => ({
      statusCode: 200,
      contentType: 'image/png',
      contentLength: String(PNG_LOGO.length),
      body: PNG_LOGO,
    }));
    const fetcher = createOAuthLogoFetcher({ transport });

    await expect(fetcher.fetch('https://127.0.0.1/logo.png')).resolves.toBeNull();
    expect(transport).not.toHaveBeenCalled();
  });

  it('accepts allowlisted raster bytes at the cap and rejects SVG or oversized bodies', async () => {
    const atCap = Buffer.alloc(OAUTH_LOGO_MAX_BYTES);
    PNG_LOGO.copy(atCap);
    const transport = vi.fn<OAuthLogoTransport>();
    const fetcher = createOAuthLogoFetcher({ resolveUrl: resolved, transport });

    transport.mockResolvedValueOnce({
      statusCode: 200,
      contentType: 'image/png; charset=binary',
      contentLength: String(atCap.length),
      body: atCap,
    });
    await expect(fetcher.fetch('https://logos.example/valid.png')).resolves.toEqual({
      contentType: 'image/png',
      bytes: atCap,
    });

    transport.mockResolvedValueOnce({
      statusCode: 200,
      contentType: 'image/svg+xml',
      contentLength: '11',
      body: Buffer.from('<svg></svg>'),
    });
    await expect(fetcher.fetch('https://logos.example/vector.svg')).resolves.toBeNull();

    transport.mockResolvedValueOnce({
      statusCode: 200,
      contentType: 'image/png',
      contentLength: String(OAUTH_LOGO_MAX_BYTES + 1),
      body: Buffer.concat([atCap, Buffer.from([0])]),
    });
    await expect(fetcher.fetch('https://logos.example/oversized.png')).resolves.toBeNull();
  });
});

describe('OAuth client registration', () => {
  it('mints a client_id + one-time client_secret and stores only the hash', async () => {
    const { clientId, clientSecret, logoPath } = await registerClient({});
    expect(clientId.startsWith(OAUTH_CLIENT_ID_PREFIX)).toBe(true);
    expect(clientSecret).toBeTruthy();
    expect(clientSecret!.startsWith(OAUTH_CLIENT_SECRET_PREFIX)).toBe(true);
    expect(logoPath).toBeNull();

    const [row] = await harness.db
      .select()
      .from(schema.oauthClients)
      .where(eq(schema.oauthClients.clientId, clientId));
    expect(row!.clientSecretHash).toBe(hashToken(clientSecret!));
    expect(row!.clientSecretHash).not.toBe(clientSecret);
    expect(row!.logoBytes).toBeNull();
    expect(row!.logoContentType).toBeNull();
    expect(await auditActions()).toContain('oauth.client_registered');
  });

  it('registers a public client with no secret', async () => {
    const { clientSecret } = await registerClient({ public: true });
    expect(clientSecret).toBeNull();
  });

  it('rejects a plain-http (non-loopback) redirect URI', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const res = await agent
      .post('/api/v1/settings/oauth-clients')
      .set(...XRW)
      .send({ name: 'x', redirectUris: ['http://evil.example/cb'], scopes: ['portfolio:read'] });
    expect(res.status).toBe(400);
  });

  it('fetches a valid logo once at save time and serves only cached first-party bytes', async () => {
    const logoFetcher: OAuthLogoFetcher = {
      fetch: vi.fn(async () => ({ bytes: PNG_LOGO, contentType: 'image/png' as const })),
    };
    harness = await createTestApp({ oauthLogoFetcher: logoFetcher });
    const sourceUrl = 'https://logos.example/partner.png';
    const { agent, clientId, logoPath } = await registerClient({
      logoUrl: sourceUrl,
      public: true,
    });

    expect(logoFetcher.fetch).toHaveBeenCalledOnce();
    expect(logoFetcher.fetch).toHaveBeenCalledWith(sourceUrl);
    expect(logoPath).toBe(`/oauth/client-logos/${clientId}`);

    const { challenge } = pkce();
    const detailsRes = await agent.get('/api/v1/oauth/authorization-details').query({
      client_id: clientId,
      redirect_uri: HTTPS_REDIRECT,
      scope: 'portfolio:read',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    expect(detailsRes.status).toBe(200);
    const details = oauthAuthorizationDetailsResponseSchema.parse(detailsRes.body);
    expect(details.client.logoPath).toBe(`/oauth/client-logos/${clientId}`);
    expect(JSON.stringify(detailsRes.body)).not.toContain(sourceUrl);

    const logoRes = await request(harness.app).get(`/api/v1/oauth/client-logos/${clientId}`);
    expect(logoRes.status).toBe(200);
    expect(logoRes.headers['content-type']).toMatch(/^image\/png/);
    expect(logoRes.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(logoRes.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(logoRes.body).toEqual(PNG_LOGO);

    // Metadata, authorize/token, grant-list and bearer-auth reads must never
    // deserialize the cached blob. Only the dedicated logo lookup selects it.
    const repo = createOAuthRepository(harness.db);
    const [stored] = await harness.db
      .select()
      .from(schema.oauthClients)
      .where(eq(schema.oauthClients.clientId, clientId));
    const listed = await repo.listClientsForUser(stored!.userId!);
    expect(listed.find((client) => client.clientId === clientId)).toMatchObject({
      hasLogo: true,
    });
    expect(listed.find((client) => client.clientId === clientId)).not.toHaveProperty('logoBytes');

    const lookup = await repo.findClientByClientId(clientId);
    expect(lookup).toMatchObject({ hasLogo: true });
    expect(lookup).not.toHaveProperty('logoBytes');

    const { access } = await consentAndToken(agent, clientId, 'portfolio:read');
    const grants = await repo.listGrantsForUser(stored!.userId!);
    expect(grants[0]!.client).not.toHaveProperty('logoBytes');
    const bearerRow = await repo.findAccessTokenByHash(hashToken(access));
    expect(bearerRow!.client).toEqual({ scopes: ['portfolio:read'] });
  });

  it('keeps registration working, retains the server-only source and returns the placeholder state when logo fetch fails', async () => {
    const logoFetcher: OAuthLogoFetcher = {
      fetch: vi.fn(async () => null),
    };
    harness = await createTestApp({ oauthLogoFetcher: logoFetcher });
    const sourceUrl = 'https://blocked.example/logo.png';
    const { agent, clientId, logoPath } = await registerClient({ logoUrl: sourceUrl });

    expect(logoPath).toBeNull();
    const [row] = await harness.db
      .select()
      .from(schema.oauthClients)
      .where(eq(schema.oauthClients.clientId, clientId));
    expect(row!.logoUrl).toBe(sourceUrl);
    expect(row!.logoBytes).toBeNull();

    const detailsRes = await agent.get('/api/v1/oauth/authorization-details').query({
      client_id: clientId,
      redirect_uri: HTTPS_REDIRECT,
      scope: 'portfolio:read',
    });
    expect(detailsRes.status).toBe(200);
    expect(
      oauthAuthorizationDetailsResponseSchema.parse(detailsRes.body).client.logoPath,
    ).toBeNull();
    expect((await request(harness.app).get(`/api/v1/oauth/client-logos/${clientId}`)).status).toBe(
      404,
    );
  });
});

describe('first-party (admin-managed) OAuth apps', () => {
  it('admin registers one; authorize-details flags firstParty and the flow round-trips', async () => {
    const { clientId } = await registerFirstPartyClient({
      scopes: ['portfolio:read'],
      public: true,
    });

    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const { verifier, challenge } = pkce();
    const detailsRes = await agent.get('/api/v1/oauth/authorization-details').query({
      client_id: clientId,
      redirect_uri: HTTPS_REDIRECT,
      scope: 'portfolio:read',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    expect(detailsRes.status).toBe(200);
    const details = oauthAuthorizationDetailsResponseSchema.parse(detailsRes.body);
    expect(details.client.firstParty).toBe(true);
    expect(details.client.logoPath).toBeNull();

    const { code } = await approveAndGetCode(agent, {
      client_id: clientId,
      redirect_uri: HTTPS_REDIRECT,
      scope: 'portfolio:read',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const tokenRes = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: HTTPS_REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    });
    expect(tokenRes.status).toBe(200);
    const tokens = oauthTokenResponseSchema.parse(tokenRes.body);
    const ok = await request(harness.app)
      .get('/api/v1/portfolios')
      .set('Authorization', `Bearer ${tokens.access_token}`);
    expect(ok.status).toBe(200);
  });

  it('is not in any user’s own app list, and a non-admin cannot register one', async () => {
    const { clientId } = await registerFirstPartyClient({});
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);

    const mine = await agent.get('/api/v1/settings/oauth-clients');
    expect(mine.status).toBe(200);
    expect((mine.body.clients as { clientId: string }[]).some((c) => c.clientId === clientId)).toBe(
      false,
    );

    // Account-kind separation: the admin route is invisible to a user (404, not 403).
    const forbidden = await agent
      .post('/api/v1/admin/oauth-clients')
      .set(...XRW)
      .send({
        name: 'Sneaky',
        redirectUris: [HTTPS_REDIRECT],
        scopes: ['portfolio:read'],
        public: true,
      });
    expect(forbidden.status).toBe(404);
  });
});

describe('OAuth authorization-code + PKCE round-trip', () => {
  it('register → consent → exchange → scoped bearer call succeeds, out-of-scope 403s', async () => {
    const { agent, clientId, clientSecret } = await registerClient({ scopes: ['portfolio:read'] });
    const { code } = await approveAndGetCode(agent, {
      client_id: clientId,
      redirect_uri: HTTPS_REDIRECT,
      scope: 'portfolio:read',
      state: 'st-123',
    });

    const tokenRes = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: HTTPS_REDIRECT,
      client_id: clientId,
      client_secret: clientSecret,
    });
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.headers['cache-control']).toBe('no-store');
    const tokens = oauthTokenResponseSchema.parse(tokenRes.body);
    expect(tokens.access_token.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)).toBe(true);
    expect(tokens.refresh_token.startsWith(OAUTH_REFRESH_TOKEN_PREFIX)).toBe(true);
    expect(tokens.scope).toBe('portfolio:read');

    const auth = `Bearer ${tokens.access_token}`;
    const ok = await request(harness.app).get('/api/v1/portfolios').set('Authorization', auth);
    expect(ok.status).toBe(200);

    // portfolio:write is outside the grant → audited 403.
    const denied = await request(harness.app)
      .post('/api/v1/portfolios')
      .set('Authorization', auth)
      .send({ name: 'From OAuth' });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('INSUFFICIENT_SCOPE');

    // Module the grant has no scope for at all.
    const other = await request(harness.app).get('/api/v1/workboard').set('Authorization', auth);
    expect(other.status).toBe(403);

    const actions = await auditActions();
    expect(actions).toContain('oauth.grant_authorized');
    expect(actions).toContain('oauth.token_issued');
  });

  it('mobile-style: unauthenticated authorize-details 401s, public client + PKCE + custom scheme works', async () => {
    const { agent, clientId } = await registerClient({
      public: true,
      scopes: ['portfolio:read', 'workboard:read'],
      redirectUris: [NATIVE_REDIRECT],
    });
    const { verifier, challenge } = pkce();
    const authorizeParams = {
      response_type: 'code',
      client_id: clientId,
      redirect_uri: NATIVE_REDIRECT,
      scope: 'portfolio:read workboard:read',
      state: 'mobile-state',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    };

    // Before login the consent data is unauthenticated → 401 (SPA sends to login).
    const anon = await request(harness.app)
      .get('/api/v1/oauth/authorization-details')
      .query(authorizeParams);
    expect(anon.status).toBe(401);

    // After sign-in the original request (incl. state) drives the consent screen.
    const details = await agent.get('/api/v1/oauth/authorization-details').query(authorizeParams);
    expect(details.status).toBe(200);
    const parsed = oauthAuthorizationDetailsResponseSchema.parse(details.body);
    expect(parsed.state).toBe('mobile-state');
    expect(parsed.client.clientId).toBe(clientId);
    expect(parsed.client.logoPath).toBeNull();
    expect(parsed.scopes.map((s) => s.scope)).toEqual(['portfolio:read', 'workboard:read']);
    expect(parsed.scopes[0]!.label.length).toBeGreaterThan(0);

    const { code, redirectTo } = await approveAndGetCode(agent, authorizeParams);
    expect(redirectTo.startsWith('myapp://callback?')).toBe(true);
    expect(redirectTo).toContain('state=mobile-state');

    // Public client: no secret, PKCE verifier proves possession.
    const tokenRes = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: NATIVE_REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    });
    expect(tokenRes.status).toBe(200);
    oauthTokenResponseSchema.parse(tokenRes.body);
  });
});

describe('authorization code — single-use and short-lived', () => {
  async function freshCode(): Promise<{ clientId: string; clientSecret: string; code: string }> {
    const { agent, clientId, clientSecret } = await registerClient({ scopes: ['portfolio:read'] });
    const { code } = await approveAndGetCode(agent, {
      client_id: clientId,
      redirect_uri: HTTPS_REDIRECT,
      scope: 'portfolio:read',
    });
    return { clientId, clientSecret: clientSecret!, code };
  }

  it('rejects a second exchange of the same code', async () => {
    const { clientId, clientSecret, code } = await freshCode();
    const body = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: HTTPS_REDIRECT,
      client_id: clientId,
      client_secret: clientSecret,
    };
    expect((await tokenRequest(body)).status).toBe(200);
    const replay = await tokenRequest(body);
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe('INVALID_GRANT');
  });

  it('rejects an expired code', async () => {
    const { clientId, clientSecret, code } = await freshCode();
    await harness.db
      .update(schema.oauthAuthCodes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.oauthAuthCodes.codeHash, hashToken(code)));
    const res = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: HTTPS_REDIRECT,
      client_id: clientId,
      client_secret: clientSecret,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_GRANT');
  });
});

describe('grant revocation', () => {
  it('immediately invalidates access + refresh tokens', async () => {
    const { agent, clientId, clientSecret } = await registerClient({ scopes: ['portfolio:read'] });
    const { code } = await approveAndGetCode(agent, {
      client_id: clientId,
      redirect_uri: HTTPS_REDIRECT,
      scope: 'portfolio:read',
    });
    const tokens = oauthTokenResponseSchema.parse(
      (
        await tokenRequest({
          grant_type: 'authorization_code',
          code,
          redirect_uri: HTTPS_REDIRECT,
          client_id: clientId,
          client_secret: clientSecret,
        })
      ).body,
    );
    const auth = `Bearer ${tokens.access_token}`;
    expect(
      (await request(harness.app).get('/api/v1/portfolios').set('Authorization', auth)).status,
    ).toBe(200);

    const grants = oauthGrantListResponseSchema.parse(
      (await agent.get('/api/v1/settings/oauth-grants')).body,
    );
    expect(grants.grants).toHaveLength(1);
    const del = await agent
      .delete(`/api/v1/settings/oauth-grants/${grants.grants[0]!.id}`)
      .set(...XRW);
    expect(del.status).toBe(204);

    // Access token now rejected.
    const after = await request(harness.app).get('/api/v1/portfolios').set('Authorization', auth);
    expect(after.status).toBe(401);
    // Refresh token now rejected too.
    const refresh = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
    });
    expect(refresh.status).toBe(400);
    expect(await auditActions()).toContain('oauth.grant_revoked');
  });

  it('invalidates access, refresh, and pending code credentials on suspension permanently', async () => {
    const { agent, clientId, clientSecret } = await registerClient({ scopes: ['portfolio:read'] });
    const { code } = await approveAndGetCode(agent, {
      client_id: clientId,
      redirect_uri: HTTPS_REDIRECT,
      scope: 'portfolio:read',
    });
    const issued = oauthTokenResponseSchema.parse(
      (
        await tokenRequest({
          grant_type: 'authorization_code',
          code,
          redirect_uri: HTTPS_REDIRECT,
          client_id: clientId,
          client_secret: clientSecret,
        })
      ).body,
    );
    const { code: pendingCode } = await approveAndGetCode(agent, {
      client_id: clientId,
      redirect_uri: HTTPS_REDIRECT,
      scope: 'portfolio:read',
    });

    // Existing active-user access remains authorized with its original scope.
    expect(
      (
        await request(harness.app)
          .get('/api/v1/portfolios')
          .set(...bearer(issued.access_token))
      ).status,
    ).toBe(200);

    const [client] = await harness.db
      .select()
      .from(schema.oauthClients)
      .where(eq(schema.oauthClients.clientId, clientId));
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    const disabled = await adminAgent
      .patch(`/api/v1/admin/users/${client!.userId}`)
      .set(...XRW)
      .send({ status: 'disabled' });
    expect(disabled.status).toBe(200);

    const [grant] = await harness.db
      .select()
      .from(schema.oauthGrants)
      .where(eq(schema.oauthGrants.userId, client!.userId!));
    expect(grant!.revokedAt).not.toBeNull();
    const [consumedCode] = await harness.db
      .select()
      .from(schema.oauthAuthCodes)
      .where(eq(schema.oauthAuthCodes.codeHash, hashToken(pendingCode)));
    expect(consumedCode!.consumedAt).not.toBeNull();

    const access = await request(harness.app)
      .get('/api/v1/portfolios')
      .set(...bearer(issued.access_token));
    expect(access.status).toBe(401);
    const refresh = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: issued.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
    });
    expect(refresh.status).toBe(400);
    const codeExchange = await tokenRequest({
      grant_type: 'authorization_code',
      code: pendingCode,
      redirect_uri: HTTPS_REDIRECT,
      client_id: clientId,
      client_secret: clientSecret,
    });
    expect(codeExchange.status).toBe(400);

    const enabled = await adminAgent
      .patch(`/api/v1/admin/users/${client!.userId}`)
      .set(...XRW)
      .send({ status: 'active' });
    expect(enabled.status).toBe(200);

    expect(
      (
        await request(harness.app)
          .get('/api/v1/portfolios')
          .set(...bearer(issued.access_token))
      ).status,
    ).toBe(401);
    expect(
      (
        await tokenRequest({
          grant_type: 'refresh_token',
          refresh_token: issued.refresh_token,
          client_id: clientId,
          client_secret: clientSecret,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await tokenRequest({
          grant_type: 'authorization_code',
          code: pendingCode,
          redirect_uri: HTTPS_REDIRECT,
          client_id: clientId,
          client_secret: clientSecret,
        })
      ).status,
    ).toBe(400);
  });

  it('serializes an in-flight code exchange with suspension before re-enable', async () => {
    const { agent, clientId, clientSecret } = await registerClient({ scopes: ['portfolio:read'] });
    const { code } = await approveAndGetCode(agent, {
      client_id: clientId,
      redirect_uri: HTTPS_REDIRECT,
      scope: 'portfolio:read',
    });
    const [client] = await harness.db
      .select()
      .from(schema.oauthClients)
      .where(eq(schema.oauthClients.clientId, clientId));
    const userId = client?.userId;
    expect(userId).toBeTruthy();
    if (!userId) throw new Error('Registered OAuth client did not have an owner');

    // Pause exactly after the code is consumed but before the exchange can look
    // up/create its grant. The real repository still owns the surrounding
    // transaction and its user-row lock.
    const reachedGrantStep = deferred();
    const releaseGrantStep = deferred();
    const baseRepo = createOAuthRepository(harness.db);
    const repo: OAuthRepository = {
      ...baseRepo,
      async withAuthorizationCodeExchange<T>(
        codeHash: string,
        run: (exchange: OAuthAuthorizationCodeExchange | null) => Promise<T>,
      ): Promise<T> {
        return baseRepo.withAuthorizationCodeExchange(codeHash, async (exchange) => {
          if (!exchange) return run(null);
          return run({
            ...exchange,
            async findActiveGrant(grantClientId: string) {
              reachedGrantStep.resolve();
              await releaseGrantStep.promise;
              return exchange.findActiveGrant(grantClientId);
            },
          });
        });
      },
    };
    const exchangeService = createOAuthService({
      repo,
      audit: createAuditService(createAuditRepository(harness.db)),
      redis: harness.ctx.redis,
    });
    const admin = await harness.seedAdmin();

    const exchange = exchangeService.exchangeToken({
      body: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: HTTPS_REDIRECT,
        client_id: clientId,
        client_secret: clientSecret!,
      },
    });
    await reachedGrantStep.promise;

    let disableFinished = false;
    const disable = harness.ctx.admin
      .updateUser(userId, { status: 'disabled' }, { id: admin.id })
      .then(() => {
        disableFinished = true;
      });
    // Let the suspend operation reach its status write. It must wait on the
    // exchange's user-row lock rather than completing its cleanup early.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(disableFinished).toBe(false);

    releaseGrantStep.resolve();
    const tokens = await exchange;
    await disable;
    await harness.ctx.admin.updateUser(userId, { status: 'active' }, { id: admin.id });

    // The suspension observes the completed grant before re-enable, so this
    // pre-suspension exchange cannot leave a live bearer credential behind.
    expect(await harness.ctx.oauth.authenticateToken(tokens.access_token)).toBeNull();
  });
});

describe('refresh-token rotation', () => {
  it('rotates the refresh token and rejects reuse of the old one', async () => {
    const { agent, clientId, clientSecret } = await registerClient({ scopes: ['portfolio:read'] });
    const { code } = await approveAndGetCode(agent, {
      client_id: clientId,
      redirect_uri: HTTPS_REDIRECT,
      scope: 'portfolio:read',
    });
    const first = oauthTokenResponseSchema.parse(
      (
        await tokenRequest({
          grant_type: 'authorization_code',
          code,
          redirect_uri: HTTPS_REDIRECT,
          client_id: clientId,
          client_secret: clientSecret,
        })
      ).body,
    );
    const rotated = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
    });
    expect(rotated.status).toBe(200);
    const next = oauthTokenResponseSchema.parse(rotated.body);
    expect(next.refresh_token).not.toBe(first.refresh_token);

    // Replay of the consumed refresh token is rejected (and revokes the grant).
    const replay = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
    });
    expect(replay.status).toBe(400);
    expect(await auditActions()).toContain('oauth.token_refreshed');
  });
});

describe('OAuth request validation', () => {
  it('rejects an unregistered redirect_uri at consent time', async () => {
    const { agent, clientId } = await registerClient({ scopes: ['portfolio:read'] });
    const res = await agent
      .post('/api/v1/oauth/authorize')
      .set(...XRW)
      .send({
        client_id: clientId,
        redirect_uri: 'https://evil.example/cb',
        scope: 'portfolio:read',
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REDIRECT_URI');
  });

  it('rejects a public client that omits PKCE', async () => {
    const { agent, clientId } = await registerClient({ public: true, scopes: ['portfolio:read'] });
    const res = await agent
      .post('/api/v1/oauth/authorize')
      .set(...XRW)
      .send({ client_id: clientId, redirect_uri: HTTPS_REDIRECT, scope: 'portfolio:read' });
    // Registered redirect defaults to HTTPS_REDIRECT for this client.
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
  });

  it('rejects a token exchange whose client_id does not own the code', async () => {
    const { agent, clientId, clientSecret } = await registerClient({ scopes: ['portfolio:read'] });
    const other = await registerClient({ scopes: ['portfolio:read'] });
    const { code } = await approveAndGetCode(agent, {
      client_id: clientId,
      redirect_uri: HTTPS_REDIRECT,
      scope: 'portfolio:read',
    });
    const res = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: HTTPS_REDIRECT,
      client_id: other.clientId,
      client_secret: other.clientSecret,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_GRANT');
    // Sanity: the original (correct) client still works afterwards is not asserted —
    // the code stays unconsumed, but validation failing first is the point.
    void clientSecret;
  });

  it('rejects a public-client exchange with a wrong PKCE verifier', async () => {
    const { agent, clientId } = await registerClient({
      public: true,
      scopes: ['portfolio:read'],
      redirectUris: [NATIVE_REDIRECT],
    });
    const { challenge } = pkce();
    const { code } = await approveAndGetCode(agent, {
      client_id: clientId,
      redirect_uri: NATIVE_REDIRECT,
      scope: 'portfolio:read',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const res = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: NATIVE_REDIRECT,
      client_id: clientId,
      code_verifier: randomBytes(32).toString('base64url'),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_GRANT');
  });

  it('rejects a confidential-client exchange with a wrong secret', async () => {
    const { agent, clientId } = await registerClient({ scopes: ['portfolio:read'] });
    const { code } = await approveAndGetCode(agent, {
      client_id: clientId,
      redirect_uri: HTTPS_REDIRECT,
      scope: 'portfolio:read',
    });
    const res = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: HTTPS_REDIRECT,
      client_id: clientId,
      client_secret: 'bts_wrong',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CLIENT');
  });
});

describe('OAuth token boundaries', () => {
  async function accessToken(scopes: string[]): Promise<string> {
    const { agent, clientId, clientSecret } = await registerClient({ scopes });
    const { code } = await approveAndGetCode(agent, {
      client_id: clientId,
      redirect_uri: HTTPS_REDIRECT,
      scope: scopes.join(' '),
    });
    const tokens = oauthTokenResponseSchema.parse(
      (
        await tokenRequest({
          grant_type: 'authorization_code',
          code,
          redirect_uri: HTTPS_REDIRECT,
          client_id: clientId,
          client_secret: clientSecret,
        })
      ).body,
    );
    return tokens.access_token;
  }

  it('can never reach an admin endpoint (404)', async () => {
    const token = await accessToken(['portfolio:read']);
    const res = await request(harness.app)
      .get('/api/v1/admin/users')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('cannot register OAuth apps or manage grants with a token (session-only)', async () => {
    const token = await accessToken(['portfolio:read', 'social:read']);
    const auth = `Bearer ${token}`;
    const clients = await request(harness.app)
      .get('/api/v1/settings/oauth-clients')
      .set('Authorization', auth);
    expect(clients.status).toBe(403);
    expect(clients.body.error.code).toBe('API_KEY_FORBIDDEN');

    const consent = await request(harness.app)
      .get('/api/v1/oauth/authorization-details')
      .set('Authorization', auth)
      .query({ client_id: 'btc_x', redirect_uri: HTTPS_REDIRECT, scope: 'portfolio:read' });
    expect(consent.status).toBe(403);
  });

  it('401s an expired access token', async () => {
    const token = await accessToken(['portfolio:read']);
    await harness.db
      .update(schema.oauthAccessTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.oauthAccessTokens.tokenHash, hashToken(token)));
    const res = await request(harness.app)
      .get('/api/v1/portfolios')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });
});

describe('first-party app editing (#341) — consent-safe', () => {
  it('renaming shows on the consent screen and grants list immediately, and is audited', async () => {
    const { adminAgent, client } = await adminAndFirstPartyClient({ scopes: ['portfolio:read'] });
    const user = await harness.seedUser();
    const userAgent = await loginAgent(harness.app, user.email, user.password);
    // Establish a grant so the app appears on the user's authorized-apps list.
    await consentAndToken(userAgent, client.clientId, 'portfolio:read');

    const patch = await editFirstPartyClient(adminAgent, client.id, {
      name: 'BetterTrack Mobile (renamed)',
      redirectUris: client.redirectUris,
      scopes: ['portfolio:read'],
    });
    expect(patch.status).toBe(200);
    expect(oauthClientSummarySchema.parse(patch.body).name).toBe('BetterTrack Mobile (renamed)');

    const { challenge } = pkce();
    const details = oauthAuthorizationDetailsResponseSchema.parse(
      (
        await userAgent.get('/api/v1/oauth/authorization-details').query({
          client_id: client.clientId,
          redirect_uri: HTTPS_REDIRECT,
          scope: 'portfolio:read',
          code_challenge: challenge,
          code_challenge_method: 'S256',
        })
      ).body,
    );
    expect(details.client.name).toBe('BetterTrack Mobile (renamed)');

    const grants = oauthGrantListResponseSchema.parse(
      (await userAgent.get('/api/v1/settings/oauth-grants')).body,
    );
    expect(grants.grants[0]!.appName).toBe('BetterTrack Mobile (renamed)');

    expect(await auditActions()).toContain('oauth.client_updated');
  });

  it('widening an app’s scopes does NOT widen a pre-existing grant/token (fresh consent required)', async () => {
    const { adminAgent, client } = await adminAndFirstPartyClient({ scopes: ['portfolio:read'] });
    const user = await harness.seedUser();
    const userAgent = await loginAgent(harness.app, user.email, user.password);
    const { access } = await consentAndToken(userAgent, client.clientId, 'portfolio:read');

    // Baseline: the grant covers portfolio:read only.
    expect(
      (
        await request(harness.app)
          .get('/api/v1/portfolios')
          .set(...bearer(access))
      ).status,
    ).toBe(200);
    expect(
      (
        await request(harness.app)
          .get('/api/v1/workboard')
          .set(...bearer(access))
      ).status,
    ).toBe(403);

    // Admin WIDENS the app to also allow workboard:read.
    const patch = await editFirstPartyClient(adminAgent, client.id, {
      name: client.name,
      redirectUris: client.redirectUris,
      scopes: ['portfolio:read', 'workboard:read'],
    });
    expect(patch.status).toBe(200);
    expect(oauthClientSummarySchema.parse(patch.body).scopes).toEqual([
      'portfolio:read',
      'workboard:read',
    ]);

    // The pre-existing token STILL cannot use the newly-allowed scope — widening
    // the app never silently widened the live grant (token/resource layer).
    const stillDenied = await request(harness.app)
      .get('/api/v1/workboard')
      .set(...bearer(access));
    expect(stillDenied.status).toBe(403);

    // …and the user's grant still records only the originally-consented scope.
    const grants = oauthGrantListResponseSchema.parse(
      (await userAgent.get('/api/v1/settings/oauth-grants')).body,
    );
    expect(grants.grants[0]!.scopes).toEqual(['portfolio:read']);

    // Only a FRESH consent grants the added scope.
    const { access: access2 } = await consentAndToken(
      userAgent,
      client.clientId,
      'portfolio:read workboard:read',
    );
    expect(
      (
        await request(harness.app)
          .get('/api/v1/workboard')
          .set(...bearer(access2))
      ).status,
    ).toBe(200);
  });

  it('narrowing an app’s scopes strips the removed scope from live tokens/grants immediately', async () => {
    const { adminAgent, client } = await adminAndFirstPartyClient({
      scopes: ['portfolio:read', 'workboard:read'],
    });
    const user = await harness.seedUser();
    const userAgent = await loginAgent(harness.app, user.email, user.password);
    const { access, refresh } = await consentAndToken(
      userAgent,
      client.clientId,
      'portfolio:read workboard:read',
    );

    // Baseline: both scopes work.
    expect(
      (
        await request(harness.app)
          .get('/api/v1/portfolios')
          .set(...bearer(access))
      ).status,
    ).toBe(200);
    expect(
      (
        await request(harness.app)
          .get('/api/v1/workboard')
          .set(...bearer(access))
      ).status,
    ).toBe(200);

    // Admin NARROWS the app: remove workboard:read.
    const patch = await editFirstPartyClient(adminAgent, client.id, {
      name: client.name,
      redirectUris: client.redirectUris,
      scopes: ['portfolio:read'],
    });
    expect(patch.status).toBe(200);

    // Immediately, on the SAME access token: workboard:read is gone, the rest stays.
    expect(
      (
        await request(harness.app)
          .get('/api/v1/workboard')
          .set(...bearer(access))
      ).status,
    ).toBe(403);
    expect(
      (
        await request(harness.app)
          .get('/api/v1/portfolios')
          .set(...bearer(access))
      ).status,
    ).toBe(200);

    // The grants list reflects the reduced effective scope.
    const grants = oauthGrantListResponseSchema.parse(
      (await userAgent.get('/api/v1/settings/oauth-grants')).body,
    );
    expect(grants.grants[0]!.scopes).toEqual(['portfolio:read']);

    // A refresh also yields a token without the removed scope.
    const refreshed = oauthTokenResponseSchema.parse(
      (
        await tokenRequest({
          grant_type: 'refresh_token',
          refresh_token: refresh,
          client_id: client.clientId,
        })
      ).body,
    );
    expect(refreshed.scope).toBe('portfolio:read');
    expect(
      (
        await request(harness.app)
          .get('/api/v1/workboard')
          .set(...bearer(refreshed.access_token))
      ).status,
    ).toBe(403);
  });

  it('a redirect URI removed by an edit is rejected at authorize time (the survivor still works)', async () => {
    const SECOND = 'https://second.example/callback';
    const { adminAgent, client } = await adminAndFirstPartyClient({
      scopes: ['portfolio:read'],
      redirectUris: [HTTPS_REDIRECT, SECOND],
    });
    const user = await harness.seedUser();
    const userAgent = await loginAgent(harness.app, user.email, user.password);
    const { challenge } = pkce();
    const detailsQuery = (redirectUri: string) => ({
      client_id: client.clientId,
      redirect_uri: redirectUri,
      scope: 'portfolio:read',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });

    // Before the edit, the second URI is a valid authorize target.
    expect(
      (await userAgent.get('/api/v1/oauth/authorization-details').query(detailsQuery(SECOND)))
        .status,
    ).toBe(200);

    // Admin removes the second URI.
    const patch = await editFirstPartyClient(adminAgent, client.id, {
      name: client.name,
      redirectUris: [HTTPS_REDIRECT],
      scopes: ['portfolio:read'],
    });
    expect(patch.status).toBe(200);

    // Now the removed URI is rejected — on both the consent read and the approve.
    const rejectedRead = await userAgent
      .get('/api/v1/oauth/authorization-details')
      .query(detailsQuery(SECOND));
    expect(rejectedRead.status).toBe(400);
    expect(rejectedRead.body.error.code).toBe('INVALID_REDIRECT_URI');

    const rejectedApprove = await userAgent
      .post('/api/v1/oauth/authorize')
      .set(...XRW)
      .send(detailsQuery(SECOND));
    expect(rejectedApprove.status).toBe(400);
    expect(rejectedApprove.body.error.code).toBe('INVALID_REDIRECT_URI');

    // The surviving URI still authorizes.
    expect(
      (
        await userAgent
          .get('/api/v1/oauth/authorization-details')
          .query(detailsQuery(HTTPS_REDIRECT))
      ).status,
    ).toBe(200);
  });

  it('scopes the edit to first-party apps: a non-admin 404s and a user-owned client id 404s (and is untouched)', async () => {
    const { client } = await adminAndFirstPartyClient({ scopes: ['portfolio:read'] });

    // A user-owned (third-party) client cannot be edited via the admin route.
    const third = await registerClient({ scopes: ['portfolio:read'] });
    const [thirdRow] = await harness.db
      .select()
      .from(schema.oauthClients)
      .where(eq(schema.oauthClients.clientId, third.clientId));
    const asUser = await editFirstPartyClient(third.agent, thirdRow!.id, {
      name: 'hijacked',
      redirectUris: [HTTPS_REDIRECT],
      scopes: ['portfolio:read', 'portfolio:write'],
    });
    // Account-kind separation: the admin route is invisible to a user (404).
    expect(asUser.status).toBe(404);

    // Even a real admin cannot reach a user-owned app through this first-party route.
    const admin = await harness.seedAdmin({
      email: `edit-admin-${randomBytes(4).toString('hex')}@bettertrack.test`,
      username: `editadmin${randomBytes(4).toString('hex')}`,
    });
    const adminAgent = await harness.loginAdmin(admin);
    const notFoundRes = await editFirstPartyClient(adminAgent, thirdRow!.id, {
      name: 'hijacked',
      redirectUris: [HTTPS_REDIRECT],
      scopes: ['portfolio:read', 'portfolio:write'],
    });
    expect(notFoundRes.status).toBe(404);

    // The third-party app is unchanged in the DB.
    const [afterRow] = await harness.db
      .select()
      .from(schema.oauthClients)
      .where(eq(schema.oauthClients.clientId, third.clientId));
    expect(afterRow!.scopes).toEqual(['portfolio:read']);

    // Sanity: the first-party client we made is a real, editable target.
    expect(client.firstParty).toBe(true);
  });

  it('rejects an invalid redirect URI and an unknown scope on edit (validation mirrors creation)', async () => {
    const { adminAgent, client } = await adminAndFirstPartyClient({ scopes: ['portfolio:read'] });

    const badUri = await editFirstPartyClient(adminAgent, client.id, {
      name: client.name,
      redirectUris: ['http://evil.example/cb'], // plain-http non-loopback
      scopes: ['portfolio:read'],
    });
    expect(badUri.status).toBe(400);

    const badScope = await adminAgent
      .patch(`/api/v1/admin/oauth-clients/${client.id}`)
      .set(...XRW)
      .send({ name: client.name, redirectUris: client.redirectUris, scopes: ['not:a:scope'] });
    expect(badScope.status).toBe(400);
  });
});
