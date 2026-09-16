import { createHash, randomBytes } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import type { Response } from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import { oauthTokenResponseSchema } from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { AuditAction } from '../services/audit/auditService';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * #1985 — a token exchange whose EFFECTIVE scope set clamps to empty.
 *
 * The effective set is `consented ∩ current client ceiling` ({@link
 * clampToAllowed}); it empties when an admin narrows the app to nothing, or
 * narrows it to a set disjoint from what this user consented to. The code
 * exchange has always refused that with `INVALID_SCOPE`; the refresh exchange
 * minted a 200 carrying a zero-scope token — a credential that satisfies
 * nothing — and left the grant in place to repeat the dance forever.
 *
 * What is pinned here:
 *  - BOTH exchanges answer an empty effective set identically (code, status and
 *    message), asserted through one shared helper over both grant types;
 *  - the refused refresh mints NO token row and does NOT consume the presented
 *    refresh token;
 *  - the grant is retired on the spot with an `oauth.grant_revoked` audit row,
 *    so the next refresh answers the terminal `INVALID_GRANT` instead;
 *  - retiring it destroys no live capability: the access token issued before the
 *    narrowing already authorized nothing (403 on every scoped route) and is
 *    merely 401 afterwards;
 *  - revocation is idempotent — a second refusal adds no second audit row;
 *  - a ceiling narrowed to a NON-EMPTY subset is untouched: it still refreshes,
 *    with the subset, and the grant survives (`oauthScopeCeilingAtToken.test.ts`
 *    owns that rule; this file only guards against over-revoking).
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
    email: `z-${randomBytes(5).toString('hex')}@bettertrack.test`,
    username: `z${randomBytes(5).toString('hex')}`,
  });
}

async function freshUserAgent(): Promise<Agent> {
  const user = await freshUser();
  return loginAgent(harness.app, user.email, user.password);
}

async function freshAdminAgent(): Promise<Agent> {
  const admin = await harness.seedAdmin({
    email: `za-${randomBytes(5).toString('hex')}@bettertrack.test`,
    username: `za${randomBytes(5).toString('hex')}`,
  });
  return harness.loginAdmin(admin);
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

const bearer = (token: string) => ['Authorization', `Bearer ${token}`] as const;

async function registerThirdPartyClient(agent: Agent, scopes: string[]) {
  const res = await agent
    .post('/api/v1/settings/oauth-clients')
    .set(...XRW)
    .send({ name: 'Partner App', redirectUris: [HTTPS_REDIRECT], scopes, public: true });
  expect(res.status).toBe(201);
  return res.body.client as { id: string; clientId: string };
}

async function registerFirstPartyClient(adminAgent: Agent, scopes: string[]) {
  const res = await adminAgent
    .post('/api/v1/admin/oauth-clients')
    .set(...XRW)
    .send({ name: 'Official App', redirectUris: [HTTPS_REDIRECT], scopes, public: true });
  expect(res.status).toBe(201);
  return res.body.client as { id: string; clientId: string };
}

/** Consent and take the single-use code WITHOUT redeeming it. */
async function approveForCode(
  agent: Agent,
  clientId: string,
  scope: string,
): Promise<{ code: string; verifier: string }> {
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
  return { code, verifier };
}

const redeemCode = (clientId: string, code: string, verifier: string) =>
  request(harness.app).post('/api/v1/oauth/token').send({
    grant_type: 'authorization_code',
    code,
    redirect_uri: HTTPS_REDIRECT,
    client_id: clientId,
    code_verifier: verifier,
  });

const redeemRefresh = (clientId: string, refreshToken: string) =>
  request(harness.app).post('/api/v1/oauth/token').send({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });

/** Full PKCE authorize → token for a public client. */
async function consentAndToken(agent: Agent, clientId: string, scope: string) {
  const { code, verifier } = await approveForCode(agent, clientId, scope);
  const token = await redeemCode(clientId, code, verifier);
  expect(token.status).toBe(200);
  return oauthTokenResponseSchema.parse(token.body);
}

/** Rewrite a client's ceiling straight on the row — the admin PATCH enforces min(1). */
async function setCeiling(clientId: string, scopes: string[]) {
  await harness.db
    .update(schema.oauthClients)
    .set({ scopes })
    .where(eq(schema.oauthClients.clientId, clientId));
}

async function grantRow(userId: string) {
  const [row] = await harness.db
    .select()
    .from(schema.oauthGrants)
    .where(eq(schema.oauthGrants.userId, userId));
  return row!;
}

async function tokenCounts(grantId: string) {
  const access = await harness.db
    .select({ id: schema.oauthAccessTokens.id })
    .from(schema.oauthAccessTokens)
    .where(eq(schema.oauthAccessTokens.grantId, grantId));
  const refresh = await harness.db
    .select({ id: schema.oauthRefreshTokens.id, consumedAt: schema.oauthRefreshTokens.consumedAt })
    .from(schema.oauthRefreshTokens)
    .where(eq(schema.oauthRefreshTokens.grantId, grantId));
  return { access: access.length, refresh: refresh.length, refreshRows: refresh };
}

async function revocationAudits(grantId: string) {
  return harness.db
    .select({ meta: schema.auditLog.meta })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.action, AuditAction.OAuthGrantRevoked),
        eq(schema.auditLog.targetId, grantId),
      ),
    );
}

/** The one refusal shape an empty effective scope set must produce. */
function emptyScopeRefusal(res: Response, label: string): { code: string; message: string } {
  expect(res.status, label).toBe(400);
  const error = res.body.error as { code: string; message: string };
  expect(error.code, label).toBe('INVALID_SCOPE');
  return error;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * A — the two exchanges must answer an empty effective set IDENTICALLY.
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('both token exchanges refuse an empty effective scope set the same way', () => {
  it.each([
    { label: 'ceiling emptied outright', ceiling: [] as string[] },
    { label: 'ceiling narrowed to a disjoint set', ceiling: ['feedback:write'] },
  ])('$label — authorization_code and refresh_token give one answer', async ({ ceiling }) => {
    const ownerAgent = await freshUserAgent();

    // Arm the code path: consent under a wide ceiling, narrow before redeeming.
    const codeClient = await registerThirdPartyClient(ownerAgent, ['portfolio:read']);
    const codeUser = await freshUser();
    const codeAgent = await loginAgent(harness.app, codeUser.email, codeUser.password);
    const armed = await approveForCode(codeAgent, codeClient.clientId, 'portfolio:read');
    await setCeiling(codeClient.clientId, ceiling);

    // Arm the refresh path: consent + token, then narrow.
    const refreshClient = await registerThirdPartyClient(ownerAgent, ['portfolio:read']);
    const refreshUser = await freshUser();
    const refreshAgent = await loginAgent(harness.app, refreshUser.email, refreshUser.password);
    const tok = await consentAndToken(refreshAgent, refreshClient.clientId, 'portfolio:read');
    await setCeiling(refreshClient.clientId, ceiling);

    const fromCode = emptyScopeRefusal(
      await redeemCode(codeClient.clientId, armed.code, armed.verifier),
      'authorization_code',
    );
    const fromRefresh = emptyScopeRefusal(
      await redeemRefresh(refreshClient.clientId, tok.refresh_token),
      'refresh_token',
    );
    expect(fromRefresh).toEqual(fromCode);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * B — the refused refresh mints nothing and retires the grant.
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('a refresh under an emptied ceiling mints nothing and retires the grant', () => {
  it('refuses, leaves the token rows untouched, revokes with an audit row', async () => {
    const ownerAgent = await freshUserAgent();
    const client = await registerThirdPartyClient(ownerAgent, ['portfolio:read']);
    const user = await freshUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const tok = await consentAndToken(agent, client.clientId, 'portfolio:read');
    const grant = await grantRow(user.id);
    const before = await tokenCounts(grant.id);
    expect(before).toMatchObject({ access: 1, refresh: 1 });

    // The admin removes every scope from the app.
    await setCeiling(client.clientId, []);

    // The live access token already authorizes nothing: 403, not 200.
    const scoped = await request(harness.app)
      .get('/api/v1/portfolios')
      .set(...bearer(tok.access_token));
    expect(scoped.status).toBe(403);

    const refused = await redeemRefresh(client.clientId, tok.refresh_token);
    emptyScopeRefusal(refused, 'refresh under an emptied ceiling');
    expect(refused.body.access_token).toBeUndefined();
    expect(refused.body.refresh_token).toBeUndefined();

    // No token row minted, and the presented refresh token was NOT consumed.
    const after = await tokenCounts(grant.id);
    expect(after.access).toBe(before.access);
    expect(after.refresh).toBe(before.refresh);
    expect(after.refreshRows.every((r) => r.consumedAt === null)).toBe(true);

    // The grant is retired, with exactly one audit row naming why.
    const retired = await grantRow(user.id);
    expect(retired.revokedAt).not.toBeNull();
    const audits = await revocationAudits(grant.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.meta).toMatchObject({ clientId: client.clientId });

    // Nothing was destroyed that still worked: the token was already powerless.
    const dead = await request(harness.app)
      .get('/api/v1/portfolios')
      .set(...bearer(tok.access_token));
    expect(dead.status).toBe(401);
  });

  it('the next refresh is terminal (INVALID_GRANT) and adds no second audit row', async () => {
    const ownerAgent = await freshUserAgent();
    const client = await registerThirdPartyClient(ownerAgent, ['portfolio:read']);
    const user = await freshUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const tok = await consentAndToken(agent, client.clientId, 'portfolio:read');
    const grant = await grantRow(user.id);
    await setCeiling(client.clientId, []);

    emptyScopeRefusal(await redeemRefresh(client.clientId, tok.refresh_token), 'first refresh');

    const again = await redeemRefresh(client.clientId, tok.refresh_token);
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('INVALID_GRANT');
    expect(await revocationAudits(grant.id)).toHaveLength(1);
    expect((await tokenCounts(grant.id)).access).toBe(1);
  });

  it('retires a FIRST-PARTY grant the same way when the ceiling goes disjoint', async () => {
    const adminAgent = await freshAdminAgent();
    const client = await registerFirstPartyClient(adminAgent, ['portfolio:write']);
    const user = await freshUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const tok = await consentAndToken(agent, client.clientId, 'portfolio:write');
    const grant = await grantRow(user.id);

    // A real admin edit, through the admin route (min(1) scopes), to a set the
    // user never consented to.
    const patch = await adminAgent
      .patch(`/api/v1/admin/oauth-clients/${client.id}`)
      .set(...XRW)
      .send({ name: 'Official App', redirectUris: [HTTPS_REDIRECT], scopes: ['feedback:write'] });
    expect(patch.status).toBe(200);

    emptyScopeRefusal(await redeemRefresh(client.clientId, tok.refresh_token), 'first-party');
    expect((await grantRow(user.id)).revokedAt).not.toBeNull();
    expect(await revocationAudits(grant.id)).toHaveLength(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * C — a NON-EMPTY narrowing is untouched (no over-revoking).
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('a ceiling narrowed to a non-empty subset still refreshes', () => {
  it('mints the subset and leaves the grant active', async () => {
    const adminAgent = await freshAdminAgent();
    const client = await registerFirstPartyClient(adminAgent, [
      'portfolio:write',
      'workboard:write',
    ]);
    const user = await freshUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const tok = await consentAndToken(agent, client.clientId, 'portfolio:write workboard:write');
    const grant = await grantRow(user.id);

    const patch = await adminAgent
      .patch(`/api/v1/admin/oauth-clients/${client.id}`)
      .set(...XRW)
      .send({ name: 'Official App', redirectUris: [HTTPS_REDIRECT], scopes: ['portfolio:read'] });
    expect(patch.status).toBe(200);

    const next = await redeemRefresh(client.clientId, tok.refresh_token);
    expect(next.status).toBe(200);
    expect(oauthTokenResponseSchema.parse(next.body).scope).toBe('portfolio:read');
    expect((await grantRow(user.id)).revokedAt).toBeNull();
    expect(await revocationAudits(grant.id)).toHaveLength(0);
  });
});
