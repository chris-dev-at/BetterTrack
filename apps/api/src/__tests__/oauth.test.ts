import { createHash, randomBytes } from 'node:crypto';

import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OAUTH_ACCESS_TOKEN_PREFIX,
  OAUTH_ACCESS_TOKEN_TTL_SECONDS,
  OAUTH_CLIENT_ID_PREFIX,
  OAUTH_CLIENT_SECRET_PREFIX,
  OAUTH_REFRESH_TOKEN_GRACE_SECONDS,
  OAUTH_REFRESH_TOKEN_PREFIX,
  apiErrorSchema,
  auditQuerySchema,
  createOAuthClientResponseSchema,
  createFeedbackResponseSchema,
  oauthAuthorizationDetailsResponseSchema,
  oauthClientSummarySchema,
  oauthDenyResponseSchema,
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
import { AuditAction, createAuditService } from '../services/audit/auditService';
import { createSecretBoxKeyring, encryptSecret } from '../services/crypto/secretBox';
import { hashToken } from '../services/crypto/tokens';
import {
  OAUTH_LOGO_MAX_BYTES,
  createOAuthLogoFetcher,
  type OAuthLogoFetcher,
  type OAuthLogoTransport,
} from '../services/oauth/oauthLogo';
import {
  BETTERTRACK_MOBILE_CLIENT_ID,
  FIRST_PARTY_CLIENTS,
  seedFirstPartyClients,
} from '../services/oauth/firstPartyClients';
import {
  POST_ROTATION_ENVELOPE_SWEEP_BATCH,
  createOAuthService,
} from '../services/oauth/oauthService';
import { createTestApp, type TestHarness } from '../testing/createTestApp';
import { flushMacrotasks } from '../test/waitFor';

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
    expect(bearerRow!.client).toEqual({ scopes: ['portfolio:read'], isFirstParty: false });
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

describe('OAuth authorization denial', () => {
  it('returns access_denied with the original state, issues no code, and leaves approval unchanged', async () => {
    const redirectUri = `${HTTPS_REDIRECT}?channel=web`;
    const { agent, clientId } = await registerClient({
      scopes: ['portfolio:read'],
      redirectUris: [redirectUri],
    });
    const authorizeParams = {
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: 'portfolio:read',
      state: 'original-state',
    };

    const denied = await agent
      .post('/api/v1/oauth/deny')
      .set(...XRW)
      .send(authorizeParams);
    expect(denied.status).toBe(200);
    const deniedUrl = new URL(oauthDenyResponseSchema.parse(denied.body).redirectTo);
    expect(deniedUrl.origin + deniedUrl.pathname).toBe(HTTPS_REDIRECT);
    expect(deniedUrl.searchParams.get('channel')).toBe('web');
    expect(deniedUrl.searchParams.get('error')).toBe('access_denied');
    expect(deniedUrl.searchParams.get('state')).toBe('original-state');
    expect(deniedUrl.searchParams.has('code')).toBe(false);
    expect(await harness.db.select().from(schema.oauthAuthCodes)).toHaveLength(0);

    const { code, redirectTo } = await approveAndGetCode(agent, authorizeParams);
    const approvedUrl = new URL(redirectTo);
    expect(approvedUrl.searchParams.get('code')).toBe(code);
    expect(approvedUrl.searchParams.get('state')).toBe('original-state');
    expect(approvedUrl.searchParams.has('error')).toBe(false);
  });

  it('rejects an unknown client without returning a redirect target', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const denied = await agent
      .post('/api/v1/oauth/deny')
      .set(...XRW)
      .send({
        client_id: 'btc_unknown',
        redirect_uri: HTTPS_REDIRECT,
        scope: 'portfolio:read',
        state: 'untrusted-state',
      });

    expect(denied.status).toBe(400);
    expect(denied.body.error.code).toBe('INVALID_CLIENT');
    expect(denied.body.redirectTo).toBeUndefined();
  });

  it('rejects a mismatched redirect URI without reflecting it', async () => {
    const { agent, clientId } = await registerClient({ scopes: ['portfolio:read'] });
    const unregistered = 'https://evil.example/callback';
    const denied = await agent
      .post('/api/v1/oauth/deny')
      .set(...XRW)
      .send({
        client_id: clientId,
        redirect_uri: unregistered,
        scope: 'portfolio:read',
        state: 'untrusted-state',
      });

    expect(denied.status).toBe(400);
    expect(denied.body.error.code).toBe('INVALID_REDIRECT_URI');
    expect(JSON.stringify(denied.body)).not.toContain(unregistered);
  });

  it('returns a first-party denial to its registered approval callback', async () => {
    const { clientId } = await registerFirstPartyClient({
      scopes: ['portfolio:read'],
      public: false,
    });
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const denied = await agent
      .post('/api/v1/oauth/deny')
      .set(...XRW)
      .send({
        client_id: clientId,
        redirect_uri: HTTPS_REDIRECT,
        scope: 'portfolio:read',
        state: 'first-party-state',
      });

    expect(denied.status).toBe(200);
    const deniedUrl = new URL(oauthDenyResponseSchema.parse(denied.body).redirectTo);
    expect(deniedUrl.origin + deniedUrl.pathname).toBe(HTTPS_REDIRECT);
    expect(deniedUrl.searchParams.get('error')).toBe('access_denied');
    expect(deniedUrl.searchParams.get('state')).toBe('first-party-state');
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
      .send({ status: 'disabled', reason: 'Suspended pending review.' });
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
      .send({ status: 'active', reason: 'Review closed, account restored.' });
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
      recordEncryption: harness.ctx.config.recordEncryption,
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
      .updateUser(
        userId,
        { status: 'disabled', reason: 'Suspended pending review.' },
        { id: admin.id },
      )
      .then(() => {
        disableFinished = true;
      });
    // Let the suspend operation reach its status write. It must wait on the
    // exchange's user-row lock rather than completing its cleanup early. One
    // event-loop turn, not a window: the lock is held by THIS test and released
    // two lines down (#1622).
    await flushMacrotasks();
    expect(disableFinished).toBe(false);

    releaseGrantStep.resolve();
    const tokens = await exchange;
    await disable;
    await harness.ctx.admin.updateUser(
      userId,
      { status: 'active', reason: 'Review closed, account restored.' },
      { id: admin.id },
    );

    // The suspension observes the completed grant before re-enable, so this
    // pre-suspension exchange cannot leave a live bearer credential behind.
    expect(await harness.ctx.oauth.authenticateToken(tokens.access_token)).toBeNull();
  });
});

describe('first-party grant scope healing (#1393)', () => {
  it('widens the live grant, keeps the old access snapshot narrow, and heals on refresh', async () => {
    const repo = createOAuthRepository(harness.db);
    await seedFirstPartyClients(repo);
    const mobile = FIRST_PARTY_CLIENTS.find(
      (client) => client.clientId === BETTERTRACK_MOBILE_CLIENT_ID,
    )!;
    const user = await harness.seedUser({
      email: 'first-party-feedback-heal@bt.test',
      username: 'fpfeedbackheal',
    });
    const agent = await loginAgent(harness.app, user.email, user.password);
    const original = await consentAndToken(
      agent,
      mobile.clientId,
      'portfolio:read',
      mobile.redirectUris[0],
    );

    const [beforeGrant] = await harness.db
      .select()
      .from(schema.oauthGrants)
      .where(eq(schema.oauthGrants.userId, user.id));
    expect(beforeGrant?.scopes).toEqual(['portfolio:read']);

    const beforeWidening = await request(harness.app)
      .post('/api/v1/feedback')
      .set(...bearer(original.access))
      .send({ category: 'other', message: 'Before first-party reconcile' });
    expect(beforeWidening.status).toBe(403);
    expect(apiErrorSchema.parse(beforeWidening.body).error.code).toBe('INSUFFICIENT_SCOPE');

    const [seeded] = await seedFirstPartyClients(repo);
    expect(seeded?.action).toBe('unchanged');
    const [widenedGrant] = await harness.db
      .select()
      .from(schema.oauthGrants)
      .where(eq(schema.oauthGrants.userId, user.id));
    expect(widenedGrant?.scopes).toContain('feedback:write');

    const oldSnapshot = await request(harness.app)
      .post('/api/v1/feedback')
      .set(...bearer(original.access))
      .send({ category: 'other', message: 'Old access token stays immutable' });
    expect(oldSnapshot.status).toBe(403);
    expect(apiErrorSchema.parse(oldSnapshot.body).error.code).toBe('INSUFFICIENT_SCOPE');

    const refreshResponse = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: original.refresh,
      client_id: mobile.clientId,
    });
    expect(refreshResponse.status).toBe(200);
    const refreshed = oauthTokenResponseSchema.parse(refreshResponse.body);
    expect(refreshed.scope.split(' ')).toContain('feedback:write');

    const healed = await request(harness.app)
      .post('/api/v1/feedback')
      .set(...bearer(refreshed.access_token))
      .send({ category: 'other', message: 'No re-login and no re-consent' });
    expect(healed.status).toBe(201);
    createFeedbackResponseSchema.parse(healed.body);
  });

  it('keeps a third-party bearer narrow and names feedback:write in the refusal', async () => {
    const { agent, clientId } = await registerClient({
      public: true,
      scopes: ['portfolio:read', 'feedback:write'],
    });
    const tokens = await consentAndToken(agent, clientId, 'portfolio:read');

    await seedFirstPartyClients(createOAuthRepository(harness.db));

    const denied = await request(harness.app)
      .post('/api/v1/feedback')
      .set(...bearer(tokens.access))
      .send({ category: 'other', message: 'Third-party consent stays narrow' });
    expect(denied.status).toBe(403);
    const error = apiErrorSchema.parse(denied.body).error;
    expect(error.code).toBe('INSUFFICIENT_SCOPE');
    expect(error.message).toContain('feedback:write');
  });
});

/**
 * Refresh rotation and its grace window (OAUTH_REFRESH_TOKEN_GRACE_SECONDS).
 *
 * One grant serves every device a user has signed the app in on, so a refresh
 * that revoked the grant on ANY reuse signed the user out everywhere whenever
 * one HTTP answer was lost, or two refreshes raced. Pinned here:
 *  - a replay of the token that was JUST rotated, inside the window, gets the
 *    IDENTICAL successor tokens (expires_in and scope recomputed) and revokes
 *    nothing;
 *  - past the window, for an older token in the chain, or for a token rotated
 *    before the window existed, reuse is still theft;
 *  - the concurrent loser gets the winner's pair and never revokes;
 *  - the sealed pair is never served past the window, and is dropped at rest
 *    on the successor's rotation, on a read past the window and after the next
 *    rotation anywhere (real-Postgres races: oauthRefreshGraceRace.test.ts);
 *  - nothing is served to the wrong client, and an unreadable envelope refuses
 *    the caller without signing anybody else out.
 * Every timing is an injected, frozen clock — no sleeps.
 */
describe('refresh-token rotation', () => {
  let clockMs = 0;
  const advance = (seconds: number) => {
    clockMs += seconds * 1000;
  };
  const oauthNow = () => new Date(clockMs);

  beforeEach(async () => {
    clockMs = Date.now();
    // Swap the file-level harness for one whose OAuth service reads the frozen
    // clock; every helper above reads `harness`, so they follow the swap.
    await harness.dispose();
    harness = await createTestApp({ oauthNow });
  });

  async function issueFirstPair(scopes: string[] = ['portfolio:read']): Promise<{
    clientId: string;
    clientSecret: string;
    first: ReturnType<typeof oauthTokenResponseSchema.parse>;
  }> {
    const { agent, clientId, clientSecret } = await registerClient({ scopes });
    const { code } = await approveAndGetCode(agent, {
      client_id: clientId,
      redirect_uri: HTTPS_REDIRECT,
      scope: scopes.join(' '),
    });
    const res = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: HTTPS_REDIRECT,
      client_id: clientId,
      client_secret: clientSecret,
    });
    expect(res.status).toBe(200);
    return {
      clientId,
      clientSecret: clientSecret!,
      first: oauthTokenResponseSchema.parse(res.body),
    };
  }

  function refreshWith(clientId: string, clientSecret: string, refreshToken: string) {
    return tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    });
  }

  async function rotate(clientId: string, clientSecret: string, refreshToken: string) {
    const res = await refreshWith(clientId, clientSecret, refreshToken);
    expect(res.status).toBe(200);
    return oauthTokenResponseSchema.parse(res.body);
  }

  async function refreshRow(refreshToken: string) {
    const [row] = await harness.db
      .select()
      .from(schema.oauthRefreshTokens)
      .where(eq(schema.oauthRefreshTokens.tokenHash, hashToken(refreshToken)));
    return row!;
  }

  async function grantFor(refreshToken: string) {
    const [grant] = await harness.db
      .select()
      .from(schema.oauthGrants)
      .where(eq(schema.oauthGrants.id, (await refreshRow(refreshToken)).grantId));
    return grant!;
  }

  async function graceAudits() {
    return harness.db
      .select({ meta: schema.auditLog.meta })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'oauth.token_refresh_replayed_in_grace'));
  }

  async function accessRowCount(grantId: string): Promise<number> {
    const rows = await harness.db
      .select({ id: schema.oauthAccessTokens.id })
      .from(schema.oauthAccessTokens)
      .where(eq(schema.oauthAccessTokens.grantId, grantId));
    return rows.length;
  }

  /** An envelope that is well-formed but sealed under a key this server no longer holds. */
  function envelopeUnderRetiredKey(): string {
    return encryptSecret(
      JSON.stringify({ v: 1 }),
      createSecretBoxKeyring({ active: { id: 'retired-key', key: randomBytes(32) } }),
    );
  }

  it('re-serves the IDENTICAL successor pair for a replay 59 s after rotation, with expires_in shrunk', async () => {
    const { clientId, clientSecret, first } = await issueFirstPair();
    const next = await rotate(clientId, clientSecret, first.refresh_token);
    expect(next.refresh_token).not.toBe(first.refresh_token);
    expect(next.expires_in).toBe(OAUTH_ACCESS_TOKEN_TTL_SECONDS);

    advance(59);
    const replay = await refreshWith(clientId, clientSecret, first.refresh_token);
    expect(replay.status).toBe(200);
    const again = oauthTokenResponseSchema.parse(replay.body);
    expect(again).toEqual({ ...next, expires_in: OAUTH_ACCESS_TOKEN_TTL_SECONDS - 59 });

    // Nothing was minted, nothing was revoked, the re-served pair is live.
    const grant = await grantFor(first.refresh_token);
    expect(grant.revokedAt).toBeNull();
    expect(await accessRowCount(grant.id)).toBe(2);
    expect(await harness.ctx.oauth.authenticateToken(again.access_token)).not.toBeNull();
    expect(
      (await auditActions()).filter((action) => action === 'oauth.token_refreshed'),
    ).toHaveLength(1);
    const audits = await graceAudits();
    expect(audits.map((row) => row.meta)).toEqual([{ clientId, via: 'replay' }]);
    // The audit vocabulary's own filter admits the new action verbatim.
    expect(
      auditQuerySchema.parse({ action: AuditAction.OAuthTokenRefreshReplayedInGrace }).action,
    ).toBe('oauth.token_refresh_replayed_in_grace');

    // …and the re-served refresh token rotates normally afterwards.
    const later = await rotate(clientId, clientSecret, again.refresh_token);
    expect(later.refresh_token).not.toBe(again.refresh_token);
  });

  it('still serves at exactly 60 s — the window is inclusive', async () => {
    const { clientId, clientSecret, first } = await issueFirstPair();
    const next = await rotate(clientId, clientSecret, first.refresh_token);
    advance(OAUTH_REFRESH_TOKEN_GRACE_SECONDS);
    const replay = await refreshWith(clientId, clientSecret, first.refresh_token);
    expect(replay.status).toBe(200);
    expect(oauthTokenResponseSchema.parse(replay.body).refresh_token).toBe(next.refresh_token);
  });

  it('treats a replay 61 s after rotation as theft: INVALID_GRANT, grant revoked, successor pair dead', async () => {
    const { clientId, clientSecret, first } = await issueFirstPair();
    const next = await rotate(clientId, clientSecret, first.refresh_token);

    advance(61);
    const replay = await refreshWith(clientId, clientSecret, first.refresh_token);
    expect(replay.status).toBe(400);
    expect(apiErrorSchema.parse(replay.body).error.code).toBe('INVALID_GRANT');
    expect(replay.body.access_token).toBeUndefined();

    expect((await grantFor(first.refresh_token)).revokedAt).toBeInstanceOf(Date);
    expect(await harness.ctx.oauth.authenticateToken(next.access_token)).toBeNull();
    expect((await refreshWith(clientId, clientSecret, next.refresh_token)).status).toBe(400);
    expect(await graceAudits()).toHaveLength(0);
  });

  it('treats a GRANDPARENT replay as theft even inside the window', async () => {
    const { clientId, clientSecret, first } = await issueFirstPair();
    const second = await rotate(clientId, clientSecret, first.refresh_token);
    advance(10);
    const third = await rotate(clientId, clientSecret, second.refresh_token);

    // `first` was consumed 20 s ago — inside the window — but its successor has
    // itself been rotated, so a holder of `first` is not the current device.
    advance(10);
    const replay = await refreshWith(clientId, clientSecret, first.refresh_token);
    expect(replay.status).toBe(400);
    expect(apiErrorSchema.parse(replay.body).error.code).toBe('INVALID_GRANT');
    expect((await grantFor(first.refresh_token)).revokedAt).toBeInstanceOf(Date);
    expect(await harness.ctx.oauth.authenticateToken(third.access_token)).toBeNull();
    expect(await graceAudits()).toHaveLength(0);
  });

  it('serves nothing to another client, or to the right client with a wrong secret, and revokes nothing', async () => {
    const { clientId, clientSecret, first } = await issueFirstPair();
    const next = await rotate(clientId, clientSecret, first.refresh_token);
    const other = await registerClient({ scopes: ['portfolio:read'] });

    advance(5);
    const foreign = await refreshWith(other.clientId, other.clientSecret!, first.refresh_token);
    expect(foreign.status).toBe(400);
    expect(apiErrorSchema.parse(foreign.body).error.code).toBe('INVALID_GRANT');
    expect(foreign.body.refresh_token).toBeUndefined();

    const badSecret = await refreshWith(clientId, `${clientSecret}x`, first.refresh_token);
    expect(badSecret.status).toBe(400);
    expect(apiErrorSchema.parse(badSecret.body).error.code).toBe('INVALID_CLIENT');
    expect(badSecret.body.refresh_token).toBeUndefined();

    expect((await grantFor(first.refresh_token)).revokedAt).toBeNull();
    expect(await harness.ctx.oauth.authenticateToken(next.access_token)).not.toBeNull();
    expect(await graceAudits()).toHaveLength(0);
  });

  it('seals the successor pair (never plaintext) and drops it once the successor rotates', async () => {
    const { clientId, clientSecret, first } = await issueFirstPair();
    const second = await rotate(clientId, clientSecret, first.refresh_token);

    const sealed = await refreshRow(first.refresh_token);
    expect(sealed.successorId).toBe((await refreshRow(second.refresh_token)).id);
    expect(sealed.successorEnvelope).toMatch(/^v2\./);
    expect(sealed.successorEnvelope).not.toContain(second.refresh_token);
    expect(sealed.successorEnvelope).not.toContain(second.access_token);
    // A token that was never rotated carries neither.
    expect(await refreshRow(second.refresh_token)).toMatchObject({
      successorId: null,
      successorEnvelope: null,
    });

    advance(5);
    await rotate(clientId, clientSecret, second.refresh_token);
    const dropped = await refreshRow(first.refresh_token);
    expect(dropped.successorEnvelope).toBeNull();
    // The lineage link is not a secret and stays.
    expect(dropped.successorId).toBe(sealed.successorId);
  });

  it('drops the sealed pair on any read past the window, and keeps it on a read inside it', async () => {
    const { clientId, clientSecret, first } = await issueFirstPair();
    await rotate(clientId, clientSecret, first.refresh_token);
    const repo = createOAuthRepository(harness.db);
    const hash = hashToken(first.refresh_token);

    const inside = await repo.findRefreshTokenByHash(
      hash,
      new Date(clockMs + OAUTH_REFRESH_TOKEN_GRACE_SECONDS * 1000),
    );
    expect(inside?.token.successorEnvelope).toMatch(/^v2\./);
    expect((await refreshRow(first.refresh_token)).successorEnvelope).toMatch(/^v2\./);

    const past = await repo.findRefreshTokenByHash(
      hash,
      new Date(clockMs + (OAUTH_REFRESH_TOKEN_GRACE_SECONDS + 1) * 1000),
    );
    expect(past?.token.successorEnvelope).toBeNull();
    expect((await refreshRow(first.refresh_token)).successorEnvelope).toBeNull();
    // Reading past the window is not itself a revocation.
    expect((await grantFor(first.refresh_token)).revokedAt).toBeNull();
  });

  it('refuses an envelope it cannot open (key rotated away) with INVALID_GRANT and revokes nothing', async () => {
    const { clientId, clientSecret, first } = await issueFirstPair();
    const next = await rotate(clientId, clientSecret, first.refresh_token);
    await harness.db
      .update(schema.oauthRefreshTokens)
      .set({ successorEnvelope: envelopeUnderRetiredKey() })
      .where(eq(schema.oauthRefreshTokens.tokenHash, hashToken(first.refresh_token)));

    advance(5);
    const replay = await refreshWith(clientId, clientSecret, first.refresh_token);
    expect(replay.status).toBe(400);
    expect(apiErrorSchema.parse(replay.body).error.code).toBe('INVALID_GRANT');
    expect(replay.body.access_token).toBeUndefined();

    // The device that DID receive `next` is not signed out.
    expect((await grantFor(first.refresh_token)).revokedAt).toBeNull();
    expect(await harness.ctx.oauth.authenticateToken(next.access_token)).not.toBeNull();
    await rotate(clientId, clientSecret, next.refresh_token);
    expect(await graceAudits()).toHaveLength(0);
  });

  it('treats a token rotated BEFORE the window existed (no successor recorded) as theft, even inside it', async () => {
    const { clientId, clientSecret, first } = await issueFirstPair();
    const next = await rotate(clientId, clientSecret, first.refresh_token);
    // Exactly the shape of a row consumed by the pre-0118 code: consumed, with
    // neither a successor link nor an envelope.
    await harness.db
      .update(schema.oauthRefreshTokens)
      .set({ successorId: null, successorEnvelope: null })
      .where(eq(schema.oauthRefreshTokens.tokenHash, hashToken(first.refresh_token)));

    advance(5);
    const replay = await refreshWith(clientId, clientSecret, first.refresh_token);
    expect(replay.status).toBe(400);
    expect(apiErrorSchema.parse(replay.body).error.code).toBe('INVALID_GRANT');
    expect((await grantFor(first.refresh_token)).revokedAt).toBeInstanceOf(Date);
    expect(await harness.ctx.oauth.authenticateToken(next.access_token)).toBeNull();
    expect(await graceAudits()).toHaveLength(0);
  });

  it('advertises the CURRENT scope on a replay after the app was partly narrowed inside the window', async () => {
    const { clientId, clientSecret, first } = await issueFirstPair([
      'portfolio:read',
      'feedback:write',
    ]);
    const next = await rotate(clientId, clientSecret, first.refresh_token);
    expect(next.scope.split(' ')).toContain('feedback:write');

    // The admin narrows the app between the lost answer and its replay.
    await harness.db
      .update(schema.oauthClients)
      .set({ scopes: ['portfolio:read'] })
      .where(eq(schema.oauthClients.clientId, clientId));

    advance(5);
    const replay = await refreshWith(clientId, clientSecret, first.refresh_token);
    expect(replay.status).toBe(200);
    const again = oauthTokenResponseSchema.parse(replay.body);
    // The tokens are re-served verbatim; what they are advertised to carry is not.
    expect(again.access_token).toBe(next.access_token);
    expect(again.refresh_token).toBe(next.refresh_token);
    expect(again.expires_in).toBe(OAUTH_ACCESS_TOKEN_TTL_SECONDS - 5);
    expect(again.scope).toBe('portfolio:read');

    // …which is exactly what a fresh refresh at the same instant advertises.
    const fresh = await rotate(clientId, clientSecret, again.refresh_token);
    expect(fresh.scope).toBe(again.scope);
  });

  it('clears expired envelopes anywhere on the instance after a successful rotation', async () => {
    // Pair A rotates once and its device goes quiet: nobody ever reads A0 again
    // and A1 never rotates, so neither the read path nor the successor's
    // rotation would ever drop A0's envelope.
    const a = await issueFirstPair();
    await rotate(a.clientId, a.clientSecret, a.first.refresh_token);
    expect((await refreshRow(a.first.refresh_token)).successorEnvelope).toMatch(/^v2\./);

    advance(OAUTH_REFRESH_TOKEN_GRACE_SECONDS + 1);
    // Any other rotation on the instance now takes A0's envelope with it, and
    // leaves its own (still inside the window) alone.
    const b = await issueFirstPair();
    await rotate(b.clientId, b.clientSecret, b.first.refresh_token);
    expect((await refreshRow(a.first.refresh_token)).successorEnvelope).toBeNull();
    expect((await refreshRow(b.first.refresh_token)).successorEnvelope).toMatch(/^v2\./);
  });

  it('never fails a refresh because the post-rotation sweep failed', async () => {
    const { clientId, clientSecret, first } = await issueFirstPair();
    const clearExpiredSuccessorEnvelopes = vi.fn(async () => {
      throw new Error('sweep unavailable');
    });
    const warn = vi.fn();
    const service = createOAuthService({
      repo: { ...createOAuthRepository(harness.db), clearExpiredSuccessorEnvelopes },
      audit: createAuditService(createAuditRepository(harness.db)),
      redis: harness.ctx.redis,
      recordEncryption: harness.ctx.config.recordEncryption,
      logger: { warn },
      now: oauthNow,
    });

    const next = await service.exchangeToken({
      body: {
        grant_type: 'refresh_token',
        refresh_token: first.refresh_token,
        client_id: clientId,
        client_secret: clientSecret,
      },
    });
    expect(next.refresh_token).not.toBe(first.refresh_token);
    expect(clearExpiredSuccessorEnvelopes).toHaveBeenCalledWith(
      new Date(clockMs - OAUTH_REFRESH_TOKEN_GRACE_SECONDS * 1000),
      POST_ROTATION_ENVELOPE_SWEEP_BATCH,
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'oauth post-rotation grace-envelope sweep failed',
    );
    expect(await service.authenticateToken(next.access_token)).not.toBeNull();
  });

  /**
   * Make both service calls read the same unconsumed row before either enters
   * the real repository transaction. They still race against the same DB; this
   * barrier makes the atomic-consume loser deterministic under PGlite.
   */
  function racingService(override: Partial<OAuthRepository> = {}) {
    const bothLookupsDone = deferred();
    let lookupCount = 0;
    const baseRepo = createOAuthRepository(harness.db);
    const repo: OAuthRepository = {
      ...baseRepo,
      async findRefreshTokenByHash(tokenHash: string, now: Date) {
        const found = await baseRepo.findRefreshTokenByHash(tokenHash, now);
        lookupCount += 1;
        if (lookupCount === 2) bothLookupsDone.resolve();
        await bothLookupsDone.promise;
        return found;
      },
      ...override,
    };
    return createOAuthService({
      repo,
      audit: createAuditService(createAuditRepository(harness.db)),
      redis: harness.ctx.redis,
      recordEncryption: harness.ctx.config.recordEncryption,
      now: oauthNow,
    });
  }

  it('gives BOTH concurrent callers the identical pair and leaves the grant active', async () => {
    const { clientId, clientSecret, first } = await issueFirstPair();
    const service = racingService();
    const refresh = () =>
      service.exchangeToken({
        body: {
          grant_type: 'refresh_token',
          refresh_token: first.refresh_token,
          client_id: clientId,
          client_secret: clientSecret,
        },
      });

    const [a, b] = await Promise.all([refresh(), refresh()]);
    expect(a).toEqual(b);
    expect(a.refresh_token).not.toBe(first.refresh_token);

    const grant = await grantFor(first.refresh_token);
    expect(grant.revokedAt).toBeNull();
    // One rotation happened; the loser's own freshly minted pair was never written.
    expect(await accessRowCount(grant.id)).toBe(2);
    expect(await service.authenticateToken(a.access_token)).not.toBeNull();
    expect(
      (await auditActions()).filter((action) => action === 'oauth.token_refreshed'),
    ).toHaveLength(1);
    expect((await graceAudits()).map((row) => row.meta)).toEqual([{ clientId, via: 'concurrent' }]);

    // The shared pair keeps rotating normally.
    const next = await service.exchangeToken({
      body: {
        grant_type: 'refresh_token',
        refresh_token: a.refresh_token,
        client_id: clientId,
        client_secret: clientSecret,
      },
    });
    expect(next.refresh_token).not.toBe(a.refresh_token);
  });

  it('answers the concurrent loser INVALID_GRANT — without revoking — when the winner pair cannot be opened', async () => {
    const { clientId, clientSecret, first } = await issueFirstPair();
    const baseRepo = createOAuthRepository(harness.db);
    const service = racingService({
      // The winner's envelope is sealed under a key this server does not hold.
      rotateRefreshToken: (input) =>
        baseRepo.rotateRefreshToken({ ...input, sealSuccessor: envelopeUnderRetiredKey }),
    });
    const refresh = () =>
      service.exchangeToken({
        body: {
          grant_type: 'refresh_token',
          refresh_token: first.refresh_token,
          client_id: clientId,
          client_secret: clientSecret,
        },
      });

    const outcomes = await Promise.allSettled([refresh(), refresh()]);
    const winner = outcomes.find((outcome) => outcome.status === 'fulfilled');
    const loser = outcomes.find((outcome) => outcome.status === 'rejected');
    if (!winner || winner.status !== 'fulfilled' || !loser || loser.status !== 'rejected') {
      throw new Error('Expected exactly one refresh exchange to win the atomic rotation');
    }
    expect(loser.reason).toMatchObject({ statusCode: 400, code: 'INVALID_GRANT' });

    expect((await grantFor(first.refresh_token)).revokedAt).toBeNull();
    expect(await service.authenticateToken(winner.value.access_token)).not.toBeNull();
    expect(await graceAudits()).toHaveLength(0);
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

/**
 * #1730 — "Authorized apps" is a credential-review surface: it must show the
 * same effective access the consent screen showed. `scopeSatisfies` lets a
 * granted `:write` satisfy its `:read` at request time, so a grant stored as
 * `['portfolio:write']` really can call the read-only routes.
 *
 * #1740 (V5-P0b) additionally normalizes at the write paths, so a NEW grant
 * stores the pair; the display expansion remains what heals grants stored before
 * that (pinned in `oauthScopeWriteImpliesRead.test.ts`).
 */
describe('#1730 authorized-apps grants report the effective (implied-read) scopes', () => {
  it('shows the implied read the token can actually use, and stores it (since #1740)', async () => {
    const { client } = await adminAndFirstPartyClient({
      scopes: ['portfolio:read', 'portfolio:write'],
    });
    const user = await harness.seedUser();
    const userAgent = await loginAgent(harness.app, user.email, user.password);
    const { access } = await consentAndToken(userAgent, client.clientId, 'portfolio:write');

    // The token really does reach the read-only route (this is what the list
    // must not understate).
    expect(
      (
        await request(harness.app)
          .get('/api/v1/portfolios')
          .set(...bearer(access))
      ).status,
    ).toBe(200);

    const grants = oauthGrantListResponseSchema.parse(
      (await userAgent.get('/api/v1/settings/oauth-grants')).body,
    );
    expect(grants.grants[0]!.scopes).toEqual(['portfolio:read', 'portfolio:write']);

    // #1740 superseded the original "storage unchanged" assertion: the consent
    // path normalizes, so the grant stores exactly the set the consent screen
    // displayed instead of a half-set the list has to expand back.
    const rows = await harness.db
      .select({ scopes: schema.oauthGrants.scopes })
      .from(schema.oauthGrants)
      .where(eq(schema.oauthGrants.userId, user.id));
    expect(rows[0]!.scopes).toEqual(['portfolio:read', 'portfolio:write']);
  });

  it('still clamps to the app’s current ceiling before expanding', async () => {
    const { adminAgent, client } = await adminAndFirstPartyClient({
      scopes: ['portfolio:read', 'portfolio:write', 'workboard:write'],
    });
    const user = await harness.seedUser();
    const userAgent = await loginAgent(harness.app, user.email, user.password);
    await consentAndToken(userAgent, client.clientId, 'portfolio:write workboard:write');

    // An admin narrows the app: the workboard pair must disappear from the
    // review surface entirely — clamp first, expand second.
    const patch = await editFirstPartyClient(adminAgent, client.id, {
      name: client.name,
      redirectUris: client.redirectUris,
      scopes: ['portfolio:read', 'portfolio:write'],
    });
    expect(patch.status).toBe(200);

    const grants = oauthGrantListResponseSchema.parse(
      (await userAgent.get('/api/v1/settings/oauth-grants')).body,
    );
    expect(grants.grants[0]!.scopes).toEqual(['portfolio:read', 'portfolio:write']);
  });
});
