import { createHash, randomBytes } from 'node:crypto';

import request from 'supertest';
import type { Application, Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SOURCE_TAG_SYNC_MIRRORCHAIN,
  createApiKeyResponseSchema,
  mirrorAcceptInviteResponseSchema,
  mirrorActivityResponseSchema,
  mirrorChainListResponseSchema,
  mirrorInviteListResponseSchema,
  mirrorMemberListResponseSchema,
  oauthAuthorizationDetailsResponseSchema,
  oauthTokenResponseSchema,
  type ApiKeyScope,
} from '@bettertrack/contracts';

import { createOAuthRepository } from '../data/repositories/oauthRepository';
import * as schema from '../data/schema';
import {
  MIRRORCHAIN_BEARER_ROUTE_ALLOWLIST,
  MIRRORCHAIN_SESSION_ONLY_ROUTE_ALLOWLIST,
  enforceMirrorchainBearerAllowlist,
  mirrorchainRouteAcceptsBearer,
  pathAcceptsBearer,
} from '../http/middleware/bearerAuth';
import { buildRouteTable } from '../scripts/checkOpenapiCoverage';
import { FIRST_PARTY_CLIENTS, seedFirstPartyClients } from '../services/oauth/firstPartyClients';
import { createTestApp, type SeededUser, type TestHarness } from '../testing/createTestApp';

/**
 * #1042 — participation-over-administration bearer access for MIRRORCHAIN.
 * The tests pin the exact route allowlist independently of routing order, run
 * every admitted route through real HTTP with its scope, and prove the existing
 * session DTOs and portfolio-content replication seam remain the only shapes and
 * write path involved.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const MOBILE_CLIENT_ID = 'btc_IbT1mzw_7kBiPHPkGfaE0Q';
const MISSING_ID = '00000000-0000-0000-0000-000000000000';

let harness: TestHarness;
let sequence = 0;

beforeEach(async () => {
  harness = await createTestApp();
});

type Agent = ReturnType<typeof request.agent>;
type RouteCase = {
  name: string;
  method: 'get' | 'post' | 'patch' | 'delete';
  path: string;
  body?: Record<string, unknown>;
};

function bearer(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

async function seedUser(prefix: string): Promise<SeededUser> {
  sequence += 1;
  return harness.seedUser({
    email: `${prefix}-${sequence}@bettertrack.test`,
    username: `${prefix}${sequence}`,
  });
}

async function loginAgent(
  app: Application,
  user: Pick<SeededUser, 'email' | 'password'>,
): Promise<Agent> {
  const agent = request.agent(app);
  const response = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier: user.email, password: user.password });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return agent;
}

async function mintKey(user: SeededUser, scopes: ApiKeyScope[]): Promise<string> {
  const agent = await loginAgent(harness.app, user);
  const response = await agent
    .post('/api/v1/settings/api-keys')
    .set(...XRW)
    .send({ name: `mirror-${sequence}`, scopes });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return createApiKeyResponseSchema.parse(response.body).token;
}

async function makeFriends(a: string, b: string): Promise<void> {
  const [userA, userB] = a < b ? [a, b] : [b, a];
  await harness.db.insert(schema.friendships).values({ userA, userB });
}

async function createOwnerChain(prefix: string): Promise<{
  owner: SeededUser;
  chainId: string;
  portfolioId: string;
}> {
  const owner = await seedUser(`${prefix}owner`);
  const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(owner.id);
  const summary = await harness.ctx.mirror.convertChain(owner.id, portfolioId, {
    name: `${prefix} group`,
  });
  return { owner, chainId: summary.chainId, portfolioId };
}

async function inviteUser(prefix: string): Promise<{
  owner: SeededUser;
  invitee: SeededUser;
  chainId: string;
  inviteId: string;
}> {
  const { owner, chainId } = await createOwnerChain(prefix);
  const invitee = await seedUser(`${prefix}invitee`);
  await makeFriends(owner.id, invitee.id);
  await harness.ctx.mirror.inviteMember(owner.id, chainId, invitee.id);
  const invite = (await harness.ctx.mirror.listInvites(invitee.id)).incoming[0]!;
  return { owner, invitee, chainId, inviteId: invite.id };
}

function callRoute(token: string, row: RouteCase) {
  const api = request(harness.app);
  const started =
    row.method === 'get'
      ? api.get(`/api/v1${row.path}`)
      : row.method === 'post'
        ? api.post(`/api/v1${row.path}`)
        : row.method === 'patch'
          ? api.patch(`/api/v1${row.path}`)
          : api.delete(`/api/v1${row.path}`);
  const authenticated = started.set(bearer(token));
  return row.body ? authenticated.send(row.body) : authenticated;
}

describe('#1042 MIRRORCHAIN bearer route allowlist', () => {
  const EXPECTED_ALLOWLIST = [
    { method: 'GET', path: '/mirrorchain/chains' },
    { method: 'GET', path: '/mirrorchain/chains/{chainId}/members' },
    { method: 'GET', path: '/mirrorchain/chains/{chainId}/activity' },
    { method: 'GET', path: '/mirrorchain/invites' },
    { method: 'POST', path: '/mirrorchain/invites/{inviteId}/accept' },
    { method: 'POST', path: '/mirrorchain/invites/{inviteId}/decline' },
    { method: 'POST', path: '/mirrorchain/chains/{chainId}/leave' },
  ] as const;

  it('pins the seven exact method + path templates and defaults every other route closed', () => {
    expect(MIRRORCHAIN_BEARER_ROUTE_ALLOWLIST).toEqual(EXPECTED_ALLOWLIST);
    for (const route of EXPECTED_ALLOWLIST) {
      expect(mirrorchainRouteAcceptsBearer(route.method, route.path)).toBe(true);
      expect(pathAcceptsBearer(route.path, route.method)).toBe(true);
    }
    for (const route of MIRRORCHAIN_SESSION_ONLY_ROUTE_ALLOWLIST) {
      expect(mirrorchainRouteAcceptsBearer(route.method, route.path)).toBe(false);
      expect(pathAcceptsBearer(route.path, route.method)).toBe(false);
    }

    // Canary for future routes: the coarse /mirrorchain MODULE_POLICIES row
    // must never make an unlisted method/path bearer-reachable by default.
    expect(pathAcceptsBearer('/mirrorchain/chains/future-admin', 'POST')).toBe(false);
    expect(pathAcceptsBearer('/mirrorchain/future-read', 'GET')).toBe(false);
    expect(pathAcceptsBearer('/mirrorchain/chains/settings/members', 'GET')).toBe(false);
  });

  it('classifies every real mounted route as participation or session-only administration', () => {
    const mounted = buildRouteTable().flatMap((route) =>
      route.kind === 'route' && route.path.startsWith('/api/v1/mirrorchain')
        ? [{ method: route.method, path: route.path.slice('/api/v1'.length) }]
        : [],
    );
    const classified = [
      ...MIRRORCHAIN_BEARER_ROUTE_ALLOWLIST,
      ...MIRRORCHAIN_SESSION_ONLY_ROUTE_ALLOWLIST,
    ].map(({ method, path }) => ({ method, path }));
    const sortRoutes = (routes: Array<{ method: string; path: string }>) =>
      routes.sort(
        (left, right) =>
          left.path.localeCompare(right.path) || left.method.localeCompare(right.method),
      );

    expect(new Set(classified.map((route) => `${route.method} ${route.path}`)).size).toBe(
      classified.length,
    );
    expect(sortRoutes(mounted)).toEqual(sortRoutes(classified));
  });

  it('keeps the router-local guard default-deny independently of the global policy table', () => {
    const rejected = vi.fn();
    enforceMirrorchainBearerAllowlist(
      {
        apiKey: { id: 'key' },
        method: 'POST',
        path: '/chains/future-admin',
      } as unknown as Request,
      {} as Response,
      rejected,
    );
    expect(rejected).toHaveBeenCalledOnce();
    expect(rejected.mock.calls[0]![0]).toMatchObject({
      statusCode: 403,
      code: 'API_KEY_FORBIDDEN',
    });

    const admitted = vi.fn();
    enforceMirrorchainBearerAllowlist(
      {
        apiKey: { id: 'key' },
        method: 'GET',
        path: '/chains',
      } as unknown as Request,
      {} as Response,
      admitted,
    );
    expect(admitted).toHaveBeenCalledWith();
  });
});

describe('#1042 bearer participation reads reuse the session DTOs', () => {
  it('serves chains, members, activity and invites with mirrorchain:read', async () => {
    const { owner, chainId } = await createOwnerChain('read');
    const invitee = await seedUser('readinvitee');
    await makeFriends(owner.id, invitee.id);
    await harness.ctx.mirror.inviteMember(owner.id, chainId, invitee.id);

    const ownerToken = await mintKey(owner, ['mirrorchain:read']);
    const inviteeToken = await mintKey(invitee, ['mirrorchain:read']);
    const ownerSession = await loginAgent(harness.app, owner);
    const inviteeSession = await loginAgent(harness.app, invitee);

    const sessionChains = mirrorChainListResponseSchema.parse(
      (await ownerSession.get('/api/v1/mirrorchain/chains')).body,
    );
    const bearerChains = await request(harness.app)
      .get('/api/v1/mirrorchain/chains')
      .set(bearer(ownerToken));
    expect(bearerChains.status, JSON.stringify(bearerChains.body)).toBe(200);
    expect(mirrorChainListResponseSchema.parse(bearerChains.body)).toEqual(sessionChains);

    const membersPath = `/api/v1/mirrorchain/chains/${chainId}/members`;
    const sessionMembers = mirrorMemberListResponseSchema.parse(
      (await ownerSession.get(membersPath)).body,
    );
    const bearerMembers = await request(harness.app).get(membersPath).set(bearer(ownerToken));
    expect(bearerMembers.status, JSON.stringify(bearerMembers.body)).toBe(200);
    expect(mirrorMemberListResponseSchema.parse(bearerMembers.body)).toEqual(sessionMembers);

    const activityPath = `/api/v1/mirrorchain/chains/${chainId}/activity`;
    const sessionActivity = mirrorActivityResponseSchema.parse(
      (await ownerSession.get(activityPath)).body,
    );
    const bearerActivity = await request(harness.app).get(activityPath).set(bearer(ownerToken));
    expect(bearerActivity.status, JSON.stringify(bearerActivity.body)).toBe(200);
    expect(mirrorActivityResponseSchema.parse(bearerActivity.body)).toEqual(sessionActivity);

    const sessionInvites = mirrorInviteListResponseSchema.parse(
      (await inviteeSession.get('/api/v1/mirrorchain/invites')).body,
    );
    const bearerInvites = await request(harness.app)
      .get('/api/v1/mirrorchain/invites')
      .set(bearer(inviteeToken));
    expect(bearerInvites.status, JSON.stringify(bearerInvites.body)).toBe(200);
    expect(mirrorInviteListResponseSchema.parse(bearerInvites.body)).toEqual(sessionInvites);
  });
});

describe('#1042 bearer participation writes', () => {
  it('accepts an invitation with mirrorchain:write', async () => {
    const { invitee, chainId, inviteId } = await inviteUser('accept');
    const token = await mintKey(invitee, ['mirrorchain:write']);

    const response = await request(harness.app)
      .post(`/api/v1/mirrorchain/invites/${inviteId}/accept`)
      .set(bearer(token));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const accepted = mirrorAcceptInviteResponseSchema.parse(response.body);
    expect(accepted.chainId).toBe(chainId);
    expect(await harness.ctx.mirror.syncedMembership(accepted.portfolioId)).toBeTruthy();
  });

  it('declines an invitation with mirrorchain:write', async () => {
    const { invitee, inviteId } = await inviteUser('decline');
    const token = await mintKey(invitee, ['mirrorchain:write']);

    const response = await request(harness.app)
      .post(`/api/v1/mirrorchain/invites/${inviteId}/decline`)
      .set(bearer(token));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect((await harness.ctx.mirror.listInvites(invitee.id)).incoming).toHaveLength(0);
  });

  it('leaves a chain with mirrorchain:write and keeps the detached copy', async () => {
    const { chainId } = await createOwnerChain('leave');
    const member = await seedUser('leavemember');
    const { portfolioId } = await harness.ctx.mirror.attachMemberCopy(chainId, member.id, {
      role: 'member',
    });
    const token = await mintKey(member, ['mirrorchain:write']);

    const response = await request(harness.app)
      .post(`/api/v1/mirrorchain/chains/${chainId}/leave`)
      .set(bearer(token));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(await harness.ctx.mirror.syncedMembership(portfolioId)).toBeNull();
    expect(await harness.ctx.portfolio.listCashSources(member.id, portfolioId)).toBeTruthy();
  });

  const WRITE_ROUTES: RouteCase[] = [
    {
      name: 'accept invite',
      method: 'post',
      path: `/mirrorchain/invites/${MISSING_ID}/accept`,
    },
    {
      name: 'decline invite',
      method: 'post',
      path: `/mirrorchain/invites/${MISSING_ID}/decline`,
    },
    {
      name: 'leave chain',
      method: 'post',
      path: `/mirrorchain/chains/${MISSING_ID}/leave`,
    },
  ];

  it.each(WRITE_ROUTES)('rejects mirrorchain:read on $name', async (row) => {
    const user = await seedUser('readonly');
    const token = await mintKey(user, ['mirrorchain:read']);
    const response = await callRoute(token, row);
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.error.code).toBe('INSUFFICIENT_SCOPE');
    expect(response.body.error.message).toContain('mirrorchain:write');
  });
});

describe('#1042 mirrorchain administration remains session-only', () => {
  const ADMIN_ROUTES: RouteCase[] = [
    {
      name: 'create chain',
      method: 'post',
      path: '/mirrorchain/chains',
      body: { name: 'Not by bearer' },
    },
    {
      name: 'convert portfolio',
      method: 'post',
      path: '/mirrorchain/chains/convert',
      body: { portfolioId: MISSING_ID },
    },
    {
      name: 'revoke invite',
      method: 'post',
      path: `/mirrorchain/invites/${MISSING_ID}/revoke`,
    },
    {
      name: 'create invite',
      method: 'post',
      path: `/mirrorchain/chains/${MISSING_ID}/invites`,
      body: { userId: MISSING_ID },
    },
    {
      name: 'rename chain',
      method: 'patch',
      path: `/mirrorchain/chains/${MISSING_ID}`,
      body: { name: 'Not by bearer' },
    },
    {
      name: 'transfer ownership',
      method: 'post',
      path: `/mirrorchain/chains/${MISSING_ID}/transfer`,
      body: { toUserId: MISSING_ID },
    },
    {
      name: 'dissolve chain',
      method: 'delete',
      path: `/mirrorchain/chains/${MISSING_ID}`,
    },
    {
      name: 'change member role',
      method: 'patch',
      path: `/mirrorchain/chains/${MISSING_ID}/members/${MISSING_ID}/role`,
      body: { role: 'manager' },
    },
    {
      name: 'kick member',
      method: 'delete',
      path: `/mirrorchain/chains/${MISSING_ID}/members/${MISSING_ID}`,
    },
  ];

  it.each(ADMIN_ROUTES)(
    'rejects a fully-scoped bearer with explicit API_KEY_FORBIDDEN: $name',
    async (row) => {
      const user = await seedUser('adminattempt');
      const token = await mintKey(user, ['mirrorchain:write']);
      const response = await callRoute(token, row);
      expect(response.status, JSON.stringify(response.body)).toBe(403);
      expect(response.body.error.code).toBe('API_KEY_FORBIDDEN');
    },
  );
});

describe('#1042 first-party mobile grant', () => {
  it('authorizes both mirrorchain scopes and uses the resulting OAuth bearer', async () => {
    const mobile = FIRST_PARTY_CLIENTS.find((client) => client.clientId === MOBILE_CLIENT_ID)!;
    expect(mobile.scopeCeiling).toEqual(
      expect.arrayContaining(['mirrorchain:read', 'mirrorchain:write']),
    );
    await seedFirstPartyClients(createOAuthRepository(harness.db));

    const user = await seedUser('mobile');
    const agent = await loginAgent(harness.app, user);
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorize = {
      client_id: mobile.clientId,
      redirect_uri: mobile.redirectUris[0],
      scope: 'mirrorchain:read mirrorchain:write',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    };

    const detailsResponse = await agent.get('/api/v1/oauth/authorization-details').query(authorize);
    expect(detailsResponse.status, JSON.stringify(detailsResponse.body)).toBe(200);
    const details = oauthAuthorizationDetailsResponseSchema.parse(detailsResponse.body);
    expect(details.client.firstParty).toBe(true);
    expect(details.scopes.map((scope) => scope.scope)).toEqual([
      'mirrorchain:read',
      'mirrorchain:write',
    ]);

    const approval = await agent
      .post('/api/v1/oauth/authorize')
      .set(...XRW)
      .send(authorize);
    expect(approval.status, JSON.stringify(approval.body)).toBe(200);
    const code = new URL(approval.body.redirectTo as string).searchParams.get('code');
    expect(code).toBeTruthy();

    const tokenResponse = await request(harness.app).post('/api/v1/oauth/token').send({
      grant_type: 'authorization_code',
      code,
      redirect_uri: mobile.redirectUris[0],
      client_id: mobile.clientId,
      code_verifier: verifier,
    });
    expect(tokenResponse.status, JSON.stringify(tokenResponse.body)).toBe(200);
    const token = oauthTokenResponseSchema.parse(tokenResponse.body).access_token;
    const chains = await request(harness.app).get('/api/v1/mirrorchain/chains').set(bearer(token));
    expect(chains.status, JSON.stringify(chains.body)).toBe(200);
    mirrorChainListResponseSchema.parse(chains.body);
  });
});

describe('#1042 portfolio bearer writes keep the mirror seam transparent', () => {
  it('replicates a bearer cash write on a synced copy to every member copy', async () => {
    const { owner, chainId, portfolioId: ownerPortfolioId } = await createOwnerChain('seam');
    const member = await seedUser('seammember');
    const { portfolioId: memberPortfolioId } = await harness.ctx.mirror.attachMemberCopy(
      chainId,
      member.id,
      { role: 'member' },
    );
    await harness.ctx.mirror.replicateChain(chainId);
    const token = await mintKey(owner, ['portfolio:write']);

    const response = await request(harness.app)
      .post(`/api/v1/portfolios/${ownerPortfolioId}/cash/deposit`)
      .set(bearer(token))
      .send({ amountEur: 42 });
    expect(response.status, JSON.stringify(response.body)).toBe(201);

    await harness.ctx.mirror.replicateChain(chainId);
    const ownerCash = await harness.ctx.portfolio.getCashMovements(owner.id, ownerPortfolioId);
    const memberCash = await harness.ctx.portfolio.getCashMovements(member.id, memberPortfolioId);
    expect(ownerCash.movements).toHaveLength(1);
    expect(ownerCash.movements[0]!.amountEur).toBe(42);
    expect(memberCash.movements).toHaveLength(1);
    expect(memberCash.movements[0]!.amountEur).toBe(42);
    expect(memberCash.movements[0]!.source).toBe(SOURCE_TAG_SYNC_MIRRORCHAIN);
  });
});
