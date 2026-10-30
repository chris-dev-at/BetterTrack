import { createHash, randomBytes } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import type { Application } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  apiErrorSchema,
  auditQuerySchema,
  createOAuthClientResponseSchema,
  oauthGrantListResponseSchema,
  oauthTokenResponseSchema,
  type OAuthTokenResponse,
} from '@bettertrack/contracts';

import { createAuditRepository } from '../data/repositories/auditRepository';
import { createOAuthRepository, type OAuthRepository } from '../data/repositories/oauthRepository';
import * as schema from '../data/schema';
import { AuditAction, createAuditService } from '../services/audit/auditService';
import { hashToken } from '../services/crypto/tokens';
import { createOAuthService } from '../services/oauth/oauthService';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * Per-install OAuth TOKEN FAMILIES (§16 2026-10-29, migration 0119; RFC 9700
 * §4.14.2) and RFC 7009 `POST /oauth/revoke`, end to end over HTTP.
 *
 * The scenario every case starts from is the owner's P0: ONE user, ONE app,
 * TWO installs. Both installs share the single (client, user) grant, so before
 * families a logout, a lost refresh answer or a re-login on one install signed
 * the other out. Every case below pins that one install's event now reaches
 * only its own family — and that the grant-wide paths (Settings revoke) stay
 * grant-wide. Clocks are injected (`oauthNow`); nothing sleeps.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const REDIRECT = 'https://families.example/callback';

let harness: TestHarness;
let clockMs = 0;
const advance = (seconds: number) => {
  clockMs += seconds * 1000;
};

beforeEach(async () => {
  clockMs = Date.now();
  harness = await createTestApp({ oauthNow: () => new Date(clockMs) });
});

type Agent = ReturnType<typeof request.agent>;

interface App {
  agent: Agent;
  userId: string;
  clientId: string;
  clientSecret: string | null;
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

/** A user who registers their own app (public PKCE by default) and is logged in. */
async function setupApp(opts: { scopes?: string[]; public?: boolean } = {}): Promise<App> {
  const tag = randomBytes(4).toString('hex');
  const user = await harness.seedUser({
    email: `families-${tag}@bettertrack.test`,
    username: `families${tag}`,
  });
  const agent = await loginAgent(harness.app, user.email, user.password);
  const res = await agent
    .post('/api/v1/settings/oauth-clients')
    .set(...XRW)
    .send({
      name: 'Families App',
      redirectUris: [REDIRECT],
      scopes: opts.scopes ?? ['portfolio:read', 'workboard:read'],
      public: opts.public ?? true,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const parsed = createOAuthClientResponseSchema.parse(res.body);
  return {
    agent,
    userId: user.id,
    clientId: parsed.client.clientId,
    clientSecret: parsed.clientSecret,
  };
}

/** One install signing in: consent → code exchange (PKCE), optional instance_id. */
async function signIn(
  app: App,
  opts: { scope?: string; instanceId?: string } = {},
): Promise<OAuthTokenResponse> {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const approved = await app.agent
    .post('/api/v1/oauth/authorize')
    .set(...XRW)
    .send({
      client_id: app.clientId,
      redirect_uri: REDIRECT,
      scope: opts.scope ?? 'portfolio:read',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  const code = new URL(approved.body.redirectTo as string).searchParams.get('code');
  const res = await request(harness.app)
    .post('/api/v1/oauth/token')
    .send({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: app.clientId,
      ...(app.clientSecret ? { client_secret: app.clientSecret } : {}),
      code_verifier: verifier,
      ...(opts.instanceId ? { instance_id: opts.instanceId } : {}),
    });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return oauthTokenResponseSchema.parse(res.body);
}

function refreshRequest(app: App, refreshToken: string) {
  return request(harness.app)
    .post('/api/v1/oauth/token')
    .send({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: app.clientId,
      ...(app.clientSecret ? { client_secret: app.clientSecret } : {}),
    });
}

async function refreshOk(app: App, refreshToken: string): Promise<OAuthTokenResponse> {
  const res = await refreshRequest(app, refreshToken);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return oauthTokenResponseSchema.parse(res.body);
}

function revokeRequest(body: Record<string, unknown>) {
  return request(harness.app).post('/api/v1/oauth/revoke').send(body);
}

const bearer = (token: string) => ['Authorization', `Bearer ${token}`] as const;

async function portfoliosStatus(accessToken: string): Promise<number> {
  return (
    await request(harness.app)
      .get('/api/v1/portfolios')
      .set(...bearer(accessToken))
  ).status;
}

async function accessRow(accessToken: string) {
  const [row] = await harness.db
    .select()
    .from(schema.oauthAccessTokens)
    .where(eq(schema.oauthAccessTokens.tokenHash, hashToken(accessToken)));
  return row!;
}

async function familyRow(id: string) {
  const [row] = await harness.db
    .select()
    .from(schema.oauthTokenFamilies)
    .where(eq(schema.oauthTokenFamilies.id, id));
  return row!;
}

async function grantRow(id: string) {
  const [row] = await harness.db
    .select()
    .from(schema.oauthGrants)
    .where(eq(schema.oauthGrants.id, id));
  return row!;
}

async function auditRows(action: string) {
  return harness.db
    .select({ meta: schema.auditLog.meta, targetId: schema.auditLog.targetId })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.action, action));
}

/** Two installs of one app for one user — the owner's P0 shape. */
async function twoInstalls(opts: { public?: boolean } = {}) {
  const app = await setupApp({ public: opts.public });
  const a = await signIn(app);
  const b = await signIn(app);
  const aRow = await accessRow(a.access_token);
  const bRow = await accessRow(b.access_token);
  return { app, a, b, grantId: aRow.grantId, familyA: aRow.familyId!, familyB: bRow.familyId! };
}

describe('token families — every sign-in is its own install', () => {
  it('starts a NEW family per code exchange on the one reused grant', async () => {
    const { a, b, grantId, familyA, familyB } = await twoInstalls();
    expect((await accessRow(b.access_token)).grantId).toBe(grantId);
    expect(familyA).toEqual(expect.any(String));
    expect(familyB).toEqual(expect.any(String));
    expect(familyA).not.toBe(familyB);
    expect(await portfoliosStatus(a.access_token)).toBe(200);
    expect(await portfoliosStatus(b.access_token)).toBe(200);

    const issued = await auditRows(AuditAction.OAuthTokenIssued);
    expect(issued.map((row) => (row.meta as { familyId: string }).familyId).sort()).toEqual(
      [familyA, familyB].sort(),
    );
  });

  it('keeps the family across rotations and stamps its last_used_at', async () => {
    const { app, a, familyA } = await twoInstalls();
    advance(120);
    const next = await refreshOk(app, a.refresh_token);
    expect((await accessRow(next.access_token)).familyId).toBe(familyA);
    const [successor] = await harness.db
      .select()
      .from(schema.oauthRefreshTokens)
      .where(eq(schema.oauthRefreshTokens.tokenHash, hashToken(next.refresh_token)));
    expect(successor!.familyId).toBe(familyA);
    expect((await familyRow(familyA)).lastUsedAt?.getTime()).toBe(clockMs);
  });
});

describe('bearer POST /auth/logout is per install', () => {
  it("revokes ONLY the presenting install's family; the other install keeps calling and refreshing", async () => {
    const { app, a, b, grantId, familyA, familyB } = await twoInstalls();

    const out = await request(harness.app)
      .post('/api/v1/auth/logout')
      .set(...bearer(a.access_token));
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true });

    // Install A is signed out server-side: access 401, refresh terminal.
    expect(await portfoliosStatus(a.access_token)).toBe(401);
    const aRefresh = await refreshRequest(app, a.refresh_token);
    expect(aRefresh.status).toBe(400);
    expect(apiErrorSchema.parse(aRefresh.body).error.code).toBe('INVALID_GRANT');

    // Install B never noticed.
    expect(await portfoliosStatus(b.access_token)).toBe(200);
    const bNext = await refreshOk(app, b.refresh_token);
    expect(await portfoliosStatus(bNext.access_token)).toBe(200);

    expect((await grantRow(grantId)).revokedAt).toBeNull();
    const familyAfter = await familyRow(familyA);
    expect(familyAfter.revokedAt).toBeInstanceOf(Date);
    expect(familyAfter.revokedReason).toBe('logout');
    expect((await familyRow(familyB)).revokedAt).toBeNull();
    expect((await auditRows(AuditAction.OAuthTokenFamilyRevoked)).map((r) => r.meta)).toEqual([
      { familyId: familyA, reason: 'logout' },
    ]);
    expect(await auditRows(AuditAction.OAuthGrantRevoked)).toHaveLength(0);
  });

  it('is idempotent: a second (racing) logout of the same family writes nothing more', async () => {
    const { app, a, grantId, familyA } = await twoInstalls();
    const logout = () =>
      harness.ctx.oauth.revokeOwnFamily({ userId: app.userId, grantId, familyId: familyA });
    await Promise.all([logout(), logout()]);
    await logout();
    expect(await auditRows(AuditAction.OAuthTokenFamilyRevoked)).toHaveLength(1);
    // The family is gone, so the bearer itself no longer authenticates.
    expect(
      (
        await request(harness.app)
          .post('/api/v1/auth/logout')
          .set(...bearer(a.access_token))
      ).status,
    ).toBe(401);
  });

  it('cannot revoke a family through somebody else’s grant (ownership is in the repository)', async () => {
    const victim = await twoInstalls();
    const other = await setupApp();
    await harness.ctx.oauth.revokeOwnFamily({
      userId: other.userId,
      grantId: victim.grantId,
      familyId: victim.familyA,
    });
    expect((await familyRow(victim.familyA)).revokedAt).toBeNull();
    expect(await portfoliosStatus(victim.a.access_token)).toBe(200);
  });
});

describe('refresh reuse beyond the grace window revokes the FAMILY, not the grant', () => {
  it("signs out the replaying install's chain while the other install keeps refreshing", async () => {
    const { app, a, b, grantId, familyA, familyB } = await twoInstalls();
    const aNext = await refreshOk(app, a.refresh_token);

    advance(61);
    const replay = await refreshRequest(app, a.refresh_token);
    expect(replay.status).toBe(400);
    expect(apiErrorSchema.parse(replay.body).error.code).toBe('INVALID_GRANT');

    // A's whole chain is dead — including the successor it rotated into.
    expect(await portfoliosStatus(aNext.access_token)).toBe(401);
    expect((await refreshRequest(app, aNext.refresh_token)).status).toBe(400);
    expect((await familyRow(familyA)).revokedReason).toBe('refresh_reuse');

    // B and the grant are untouched.
    expect((await grantRow(grantId)).revokedAt).toBeNull();
    expect((await familyRow(familyB)).revokedAt).toBeNull();
    const bNext = await refreshOk(app, b.refresh_token);
    expect(await portfoliosStatus(bNext.access_token)).toBe(200);

    expect((await auditRows(AuditAction.OAuthTokenFamilyRevoked)).map((r) => r.meta)).toEqual([
      { clientId: app.clientId, familyId: familyA, reason: 'refresh_reuse' },
    ]);
  });

  it('drops the revoked family’s sealed grace envelopes at rest', async () => {
    const { app, a, familyA } = await twoInstalls();
    const aNext = await refreshOk(app, a.refresh_token);
    // A second rotation inside the window leaves an envelope on aNext's row.
    advance(5);
    await refreshOk(app, aNext.refresh_token);
    advance(5);
    // Grandparent replay → reuse → family revoked; every envelope of A goes.
    expect((await refreshRequest(app, a.refresh_token)).status).toBe(400);
    const rows = await harness.db
      .select({ envelope: schema.oauthRefreshTokens.successorEnvelope })
      .from(schema.oauthRefreshTokens)
      .where(eq(schema.oauthRefreshTokens.familyId, familyA));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.envelope === null)).toBe(true);
  });
});

describe('a rotation never mints into a grant or family revoked after its lookup', () => {
  async function refreshRowOf(refreshToken: string) {
    const [row] = await harness.db
      .select()
      .from(schema.oauthRefreshTokens)
      .where(eq(schema.oauthRefreshTokens.tokenHash, hashToken(refreshToken)));
    return row!;
  }

  function rotationOf(row: { id: string; grantId: string; familyId: string | null }) {
    const at = new Date(clockMs);
    return {
      tokenId: row.id,
      grantId: row.grantId,
      familyId: row.familyId,
      rotatedAt: at,
      accessToken: {
        tokenHash: hashToken(`bto_never_${randomBytes(8).toString('hex')}`),
        scopes: ['portfolio:read'],
        expiresAt: new Date(at.getTime() + 3_600_000),
      },
      refreshToken: {
        tokenHash: hashToken(`btr_never_${randomBytes(8).toString('hex')}`),
        expiresAt: new Date(at.getTime() + 86_400_000),
      },
      sealSuccessor: () => {
        throw new Error('a refused rotation must never seal a pair');
      },
    };
  }

  async function tokenCounts(grantId: string) {
    const refresh = await harness.db
      .select({ id: schema.oauthRefreshTokens.id })
      .from(schema.oauthRefreshTokens)
      .where(eq(schema.oauthRefreshTokens.grantId, grantId));
    const access = await harness.db
      .select({ id: schema.oauthAccessTokens.id })
      .from(schema.oauthAccessTokens)
      .where(eq(schema.oauthAccessTokens.grantId, grantId));
    return { refresh: refresh.length, access: access.length };
  }

  it('refuses under the family lock: outcome revoked, the presented token unconsumed, nothing minted', async () => {
    const { app, a, grantId, familyA } = await twoInstalls();
    const row = await refreshRowOf(a.refresh_token);
    const before = await tokenCounts(grantId);
    await harness.ctx.oauth.revokeOwnFamily({ userId: app.userId, grantId, familyId: familyA });

    const repo = createOAuthRepository(harness.db);
    expect(await repo.rotateRefreshToken(rotationOf(row))).toEqual({ outcome: 'revoked' });
    expect((await refreshRowOf(a.refresh_token)).consumedAt).toBeNull();
    expect(await tokenCounts(grantId)).toEqual(before);
  });

  it('refuses under the grant lock once the grant itself is revoked (legacy chain too)', async () => {
    const { app, a, grantId } = await twoInstalls();
    const row = await refreshRowOf(a.refresh_token);
    const before = await tokenCounts(grantId);
    await harness.ctx.oauth.revokeGrant({ userId: app.userId, id: grantId });

    const repo = createOAuthRepository(harness.db);
    expect(await repo.rotateRefreshToken(rotationOf(row))).toEqual({ outcome: 'revoked' });
    expect(await repo.rotateRefreshToken({ ...rotationOf(row), familyId: null })).toEqual({
      outcome: 'revoked',
    });
    expect((await refreshRowOf(a.refresh_token)).consumedAt).toBeNull();
    expect(await tokenCounts(grantId)).toEqual(before);
  });

  it('answers INVALID_GRANT when a logout lands between the refresh lookup and its rotation', async () => {
    const { app, a, b, grantId, familyA } = await twoInstalls();
    const base = createOAuthRepository(harness.db);
    // The install logs out on another request right after this refresh read
    // its (then still live) family.
    const repo: OAuthRepository = {
      ...base,
      async findRefreshTokenByHash(tokenHash, at) {
        const found = await base.findRefreshTokenByHash(tokenHash, at);
        await base.revokeFamily({
          userId: app.userId,
          grantId,
          familyId: familyA,
          reason: 'logout',
          at,
        });
        return found;
      },
    };
    const service = createOAuthService({
      repo,
      audit: createAuditService(createAuditRepository(harness.db)),
      redis: harness.ctx.redis,
      recordEncryption: harness.ctx.config.recordEncryption,
      now: () => new Date(clockMs),
    });
    const before = await tokenCounts(grantId);
    await expect(
      service.exchangeToken({
        body: { grant_type: 'refresh_token', refresh_token: a.refresh_token, client_id: app.clientId },
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_GRANT' });
    expect(await tokenCounts(grantId)).toEqual(before);
    // The other install is untouched.
    expect((await refreshOk(app, b.refresh_token)).access_token).toEqual(expect.any(String));
  });
});

describe('Settings revoke stays grant-wide', () => {
  it('DELETE /settings/oauth-grants/:id signs out EVERY install of the app', async () => {
    const { app, a, b, grantId } = await twoInstalls();
    const grants = oauthGrantListResponseSchema.parse(
      (await app.agent.get('/api/v1/settings/oauth-grants')).body,
    );
    expect(grants.grants.map((grant) => grant.id)).toEqual([grantId]);
    expect(
      (await app.agent.delete(`/api/v1/settings/oauth-grants/${grantId}`).set(...XRW)).status,
    ).toBe(204);

    expect(await portfoliosStatus(a.access_token)).toBe(401);
    expect(await portfoliosStatus(b.access_token)).toBe(401);
    expect((await refreshRequest(app, a.refresh_token)).status).toBe(400);
    expect((await refreshRequest(app, b.refresh_token)).status).toBe(400);
    expect(await auditRows(AuditAction.OAuthGrantRevoked)).toHaveLength(1);
    expect(await auditRows(AuditAction.OAuthTokenFamilyRevoked)).toHaveLength(0);
  });
});

describe('RFC 7009 POST /oauth/revoke', () => {
  it("revokes the presented refresh token's family only, answers {ok:true} with no-store", async () => {
    const { app, a, b, grantId, familyA } = await twoInstalls();
    const res = await revokeRequest({
      token: a.refresh_token,
      token_type_hint: 'refresh_token',
      client_id: app.clientId,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers['cache-control']).toBe('no-store');

    expect(await portfoliosStatus(a.access_token)).toBe(401);
    expect((await refreshRequest(app, a.refresh_token)).status).toBe(400);
    expect(await portfoliosStatus(b.access_token)).toBe(200);
    expect((await grantRow(grantId)).revokedAt).toBeNull();
    expect((await familyRow(familyA)).revokedReason).toBe('revoke_endpoint');
    expect((await auditRows(AuditAction.OAuthTokenFamilyRevoked)).map((r) => r.meta)).toEqual([
      { clientId: app.clientId, familyId: familyA, reason: 'revoke_endpoint' },
    ]);
  });

  it('classifies by prefix: an ACCESS token with a refresh_token hint still revokes its family', async () => {
    const { app, a, b, familyB } = await twoInstalls();
    const res = await revokeRequest({
      token: b.access_token,
      token_type_hint: 'refresh_token',
      client_id: app.clientId,
    });
    expect(res.status).toBe(200);
    expect(await portfoliosStatus(b.access_token)).toBe(401);
    expect((await refreshRequest(app, b.refresh_token)).status).toBe(400);
    expect((await familyRow(familyB)).revokedReason).toBe('revoke_endpoint');
    expect(await portfoliosStatus(a.access_token)).toBe(200);
  });

  it("answers 200 for another client's token, an unknown token and a non-token — and revokes nothing", async () => {
    const victim = await twoInstalls();
    const attacker = await setupApp();
    for (const token of [
      victim.a.refresh_token,
      victim.a.access_token,
      `btr_${randomBytes(32).toString('base64url')}`,
      `bto_${randomBytes(32).toString('base64url')}`,
      'not-a-token-at-all',
    ]) {
      const res = await revokeRequest({ token, client_id: attacker.clientId });
      expect(res.status, token).toBe(200);
      expect(res.body).toEqual({ ok: true });
    }
    expect(await portfoliosStatus(victim.a.access_token)).toBe(200);
    expect((await familyRow(victim.familyA)).revokedAt).toBeNull();
    expect(await auditRows(AuditAction.OAuthTokenFamilyRevoked)).toHaveLength(0);
    expect(await auditRows(AuditAction.OAuthGrantRevoked)).toHaveLength(0);
  });

  it('refuses a wrong client secret or an unknown client with INVALID_CLIENT and revokes nothing', async () => {
    const { app, a, familyA } = await twoInstalls({ public: false });
    expect(app.clientSecret).toEqual(expect.any(String));

    const wrongSecret = await revokeRequest({
      token: a.refresh_token,
      client_id: app.clientId,
      client_secret: `${app.clientSecret}x`,
    });
    expect(wrongSecret.status).toBe(400);
    expect(apiErrorSchema.parse(wrongSecret.body).error.code).toBe('INVALID_CLIENT');

    const missingSecret = await revokeRequest({ token: a.refresh_token, client_id: app.clientId });
    expect(apiErrorSchema.parse(missingSecret.body).error.code).toBe('INVALID_CLIENT');

    const unknownClient = await revokeRequest({
      token: a.refresh_token,
      client_id: 'btc_doesNotExist',
    });
    expect(apiErrorSchema.parse(unknownClient.body).error.code).toBe('INVALID_CLIENT');

    expect((await familyRow(familyA)).revokedAt).toBeNull();
    expect(await portfoliosStatus(a.access_token)).toBe(200);

    // …and the right secret works.
    const ok = await revokeRequest({
      token: a.refresh_token,
      client_id: app.clientId,
      client_secret: app.clientSecret,
    });
    expect(ok.status).toBe(200);
    expect((await familyRow(familyA)).revokedReason).toBe('revoke_endpoint');
  });

  it('is idempotent: revoking a dead family again is 200 and writes no second audit row', async () => {
    const { app, a } = await twoInstalls();
    for (let i = 0; i < 3; i += 1) {
      const res = await revokeRequest({ token: a.refresh_token, client_id: app.clientId });
      expect(res.status).toBe(200);
    }
    expect(await auditRows(AuditAction.OAuthTokenFamilyRevoked)).toHaveLength(1);
  });

  it('rejects a malformed body with VALIDATION_ERROR (strict schema)', async () => {
    const app = await setupApp();
    const res = await revokeRequest({ token: 'x', client_id: app.clientId, extra: 1 });
    expect(res.status).toBe(400);
    expect(apiErrorSchema.parse(res.body).error.code).toBe('VALIDATION_ERROR');
    const hint = await revokeRequest({
      token: 'x',
      client_id: app.clientId,
      token_type_hint: 'id_token',
    });
    expect(apiErrorSchema.parse(hint.body).error.code).toBe('VALIDATION_ERROR');
  });
});

describe('scope UNION on re-login (§16 2026-10-29)', () => {
  it('narrower-then-wider: the grant gains the scope, the code tokens carry their own consent', async () => {
    const app = await setupApp({ scopes: ['portfolio:read', 'workboard:read'] });
    const a = await signIn(app, { scope: 'portfolio:read' });
    const b = await signIn(app, { scope: 'portfolio:read workboard:read' });
    expect(a.scope).toBe('portfolio:read');
    expect(b.scope).toBe('portfolio:read workboard:read');
    const grantId = (await accessRow(a.access_token)).grantId;
    expect([...(await grantRow(grantId)).scopes].sort()).toEqual([
      'portfolio:read',
      'workboard:read',
    ]);
    // A's own access token is unchanged until it refreshes into the union.
    expect((await accessRow(a.access_token)).scopes).toEqual(['portfolio:read']);
    const aNext = await refreshOk(app, a.refresh_token);
    expect(aNext.scope.split(' ').sort()).toEqual(['portfolio:read', 'workboard:read']);
  });

  it('wider-then-narrower: a narrower re-login never strips the other install', async () => {
    const app = await setupApp({ scopes: ['portfolio:read', 'workboard:read'] });
    const a = await signIn(app, { scope: 'portfolio:read workboard:read' });
    const b = await signIn(app, { scope: 'portfolio:read' });
    expect(b.scope).toBe('portfolio:read');
    const grantId = (await accessRow(a.access_token)).grantId;
    expect([...(await grantRow(grantId)).scopes].sort()).toEqual([
      'portfolio:read',
      'workboard:read',
    ]);
    // A keeps both on refresh; B's refresh mints the (accepted) union.
    const aNext = await refreshOk(app, a.refresh_token);
    expect(aNext.scope.split(' ').sort()).toEqual(['portfolio:read', 'workboard:read']);
    const bNext = await refreshOk(app, b.refresh_token);
    expect(bNext.scope.split(' ').sort()).toEqual(['portfolio:read', 'workboard:read']);
  });
});

describe('instance_id: a re-login retires the same install’s previous family', () => {
  const INSTALL_X = 'install-x-0123456789abcdef';
  const INSTALL_Y = 'install-y-0123456789abcdef';

  it('retires the old family of the SAME instance (reason relogin) and leaves other installs alone', async () => {
    const app = await setupApp();
    const x1 = await signIn(app, { instanceId: INSTALL_X });
    const y = await signIn(app, { instanceId: INSTALL_Y });
    const anonymous = await signIn(app);
    const familyX1 = (await accessRow(x1.access_token)).familyId!;
    expect((await familyRow(familyX1)).instanceId).toBe(INSTALL_X);

    // The forgot-PIN / reinstall path: the same install signs in again.
    const x2 = await signIn(app, { instanceId: INSTALL_X });
    const familyX2 = (await accessRow(x2.access_token)).familyId!;
    expect(familyX2).not.toBe(familyX1);

    const retired = await familyRow(familyX1);
    expect(retired.revokedAt).toBeInstanceOf(Date);
    expect(retired.revokedReason).toBe('relogin');
    expect(await portfoliosStatus(x1.access_token)).toBe(401);
    expect((await refreshRequest(app, x1.refresh_token)).status).toBe(400);

    for (const live of [x2, y, anonymous]) {
      expect(await portfoliosStatus(live.access_token)).toBe(200);
    }
    expect((await auditRows(AuditAction.OAuthTokenFamilyRevoked)).map((r) => r.meta)).toEqual([
      { clientId: app.clientId, familyId: familyX1, reason: 'relogin' },
    ]);
  });

  it('without an instance_id a re-login retires nothing (the old family expires on its own)', async () => {
    const app = await setupApp();
    const first = await signIn(app);
    await signIn(app);
    expect(await portfoliosStatus(first.access_token)).toBe(200);
    expect(await auditRows(AuditAction.OAuthTokenFamilyRevoked)).toHaveLength(0);
  });

  it('refuses a malformed instance_id before anything is consumed', async () => {
    const app = await setupApp();
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const approved = await app.agent
      .post('/api/v1/oauth/authorize')
      .set(...XRW)
      .send({
        client_id: app.clientId,
        redirect_uri: REDIRECT,
        scope: 'portfolio:read',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
    const code = new URL(approved.body.redirectTo as string).searchParams.get('code');
    for (const instanceId of [
      'short',
      'has spaces in it but long',
      'x'.repeat(65),
      'ünïcode-0123456789',
    ]) {
      const res = await request(harness.app).post('/api/v1/oauth/token').send({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: app.clientId,
        code_verifier: verifier,
        instance_id: instanceId,
      });
      expect(res.status, instanceId).toBe(400);
      expect(apiErrorSchema.parse(res.body).error.code).toBe('VALIDATION_ERROR');
    }
    // The code was never consumed by the refused requests.
    const ok = await request(harness.app).post('/api/v1/oauth/token').send({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: app.clientId,
      code_verifier: verifier,
      instance_id: INSTALL_X,
    });
    expect(ok.status).toBe(200);
  });
});

describe('legacy NULL-family tokens (minted by the pre-family code during the rollout)', () => {
  /** Strip install A's rows back to the shape the old code inserts: no family. */
  async function makeLegacy(grantId: string, familyId: string): Promise<void> {
    await harness.db
      .update(schema.oauthAccessTokens)
      .set({ familyId: null })
      .where(
        and(
          eq(schema.oauthAccessTokens.grantId, grantId),
          eq(schema.oauthAccessTokens.familyId, familyId),
        ),
      );
    await harness.db
      .update(schema.oauthRefreshTokens)
      .set({ familyId: null })
      .where(
        and(
          eq(schema.oauthRefreshTokens.grantId, grantId),
          eq(schema.oauthRefreshTokens.familyId, familyId),
        ),
      );
  }

  it('keep authenticating and refreshing; the successor stays legacy', async () => {
    const { app, a, grantId, familyA } = await twoInstalls();
    await makeLegacy(grantId, familyA);
    expect(await portfoliosStatus(a.access_token)).toBe(200);
    const principal = await harness.ctx.oauth.authenticateToken(a.access_token);
    expect(principal?.familyId).toBeNull();

    const next = await refreshOk(app, a.refresh_token);
    expect((await accessRow(next.access_token)).familyId).toBeNull();
    expect(await portfoliosStatus(next.access_token)).toBe(200);
  });

  it('keep the pre-family GRANT-WIDE semantics: a legacy logout signs out every install', async () => {
    const { a, b, grantId, familyA } = await twoInstalls();
    await makeLegacy(grantId, familyA);
    const out = await request(harness.app)
      .post('/api/v1/auth/logout')
      .set(...bearer(a.access_token));
    expect(out.status).toBe(200);
    expect((await grantRow(grantId)).revokedAt).toBeInstanceOf(Date);
    expect(await portfoliosStatus(b.access_token)).toBe(401);
    expect((await auditRows(AuditAction.OAuthGrantRevoked)).map((r) => r.meta)).toEqual([
      { reason: 'logout', legacyFamily: true },
    ]);
  });

  it('keep grant-wide reuse detection for a legacy chain', async () => {
    const { app, a, b, grantId, familyA } = await twoInstalls();
    await makeLegacy(grantId, familyA);
    await refreshOk(app, a.refresh_token);
    advance(61);
    expect((await refreshRequest(app, a.refresh_token)).status).toBe(400);
    expect((await grantRow(grantId)).revokedAt).toBeInstanceOf(Date);
    expect(await portfoliosStatus(b.access_token)).toBe(401);
  });
});

describe('realtime revalidation honours the family', () => {
  it('returns the live family and fails closed once that family is revoked', async () => {
    const { app, a, b, grantId, familyA, familyB } = await twoInstalls();
    const principalA = (await harness.ctx.oauth.authenticateToken(a.access_token))!;
    const principalB = (await harness.ctx.oauth.authenticateToken(b.access_token))!;
    const revalidate = (p: typeof principalA) =>
      harness.ctx.oauth.revalidatePrincipal({
        userId: app.userId,
        grantId,
        accessTokenId: p.accessTokenId,
        expiresAt: p.expiresAt,
        scopes: p.scopes,
      });
    expect((await revalidate(principalA))?.familyId).toBe(familyA);

    await revokeRequest({ token: a.refresh_token, client_id: app.clientId });
    expect(await revalidate(principalA)).toBeNull();
    expect((await revalidate(principalB))?.familyId).toBe(familyB);
  });
});

describe('audit vocabulary', () => {
  it('admits oauth.token_family_revoked through the admin audit filter verbatim', () => {
    expect(auditQuerySchema.parse({ action: AuditAction.OAuthTokenFamilyRevoked }).action).toBe(
      'oauth.token_family_revoked',
    );
  });
});
