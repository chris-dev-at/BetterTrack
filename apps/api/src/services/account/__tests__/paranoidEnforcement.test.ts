import { eq } from 'drizzle-orm';
import type { Application } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PARANOID_TRANSITION_ERROR_CODES } from '@bettertrack/contracts';

import { users } from '../../../data/schema';
import type { DomainEvent } from '../../../events';
import { buildRouteTable } from '../../../scripts/checkOpenapiCoverage';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import {
  guardUserService,
  isParanoidKilledScope,
  isPortfolioContentWebhookEvent,
  paranoidCapabilityForRoute,
  PARANOID_KILL_REGISTRY,
  ParanoidModeError,
} from '../paranoidEnforcement';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

type Agent = ReturnType<typeof request.agent>;

async function loginAgent(app: Application, identifier: string, password: string): Promise<Agent> {
  const agent = request.agent(app);
  const result = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(result.status).toBe(200);
  return agent;
}

async function paranoidAccount() {
  const user = await harness.seedUser({
    email: 'matrix@bettertrack.test',
    username: 'matrix_user',
  });
  await harness.db
    .update(users)
    .set({
      privacyMode: 'paranoid',
      paranoidMediaSet: ['drive'],
      paranoidDriveAttestedVersion: 1,
      profilePublic: false,
    })
    .where(eq(users.id, user.id));
  return { user, agent: await loginAgent(harness.app, user.email, user.password) };
}

function representativePath(rule: (typeof PARANOID_KILL_REGISTRY)[number]['routes'][number]) {
  if ('exact' in rule && rule.exact) return rule.exact;
  if ('prefix' in rule && rule.prefix) return `${rule.prefix}probe`;
  return '/ideas/018f0000-0000-7000-8000-000000000001/clone';
}

describe('paranoid kill registry', () => {
  it('has one entry per capability and every declared route has executable coverage', () => {
    const capabilities = PARANOID_KILL_REGISTRY.map((entry) => entry.capability);
    expect(new Set(capabilities).size).toBe(capabilities.length);
    const mounted = buildRouteTable()
      .filter((route) => route.path.startsWith('/api/v1'))
      .map((route) => ({
        method: route.method,
        path: route.path.slice('/api/v1'.length) || '/',
      }));

    for (const entry of PARANOID_KILL_REGISTRY) {
      const railCount =
        entry.routes.length +
        entry.serviceEntryPoints.length +
        entry.scopes.length +
        entry.jobs.length +
        entry.webhookEventTypes.length;
      expect(railCount, `${entry.capability} has no executable rail`).toBeGreaterThan(0);
      for (const rule of entry.routes) {
        const method = 'method' in rule && rule.method ? rule.method : 'GET';
        expect(
          paranoidCapabilityForRoute(method, representativePath(rule)),
          `${entry.capability} route is not recognized`,
        ).toBe(entry.capability);
        const actual = mounted.filter(
          (route) =>
            (!('method' in rule) || !rule.method || route.method === rule.method) &&
            (('exact' in rule && rule.exact !== undefined && route.path === rule.exact) ||
              ('prefix' in rule &&
                rule.prefix !== undefined &&
                route.path.startsWith(rule.prefix)) ||
              ('pattern' in rule && rule.pattern !== undefined && rule.pattern.test(route.path))),
        );
        expect(actual.length, `${entry.capability} rule has no mounted route`).toBeGreaterThan(0);
        for (const route of actual) {
          expect(paranoidCapabilityForRoute(route.method, route.path)).toBe(entry.capability);
        }
      }
    }
  });

  it('drives the service, scope, job and webhook rails without a second policy', async () => {
    const guardedCall = vi.fn(async (_userId: string) => 'leak');
    const service = guardUserService(
      { killed: guardedCall },
      {
        async isParanoid() {
          return true;
        },
        async assertAllowed(_userId, capability) {
          throw new ParanoidModeError(capability);
        },
      },
      'portfolioServer',
      ['killed'],
    );
    await expect(service.killed('user-id')).rejects.toMatchObject({
      code: PARANOID_TRANSITION_ERROR_CODES.mode,
    });
    expect(guardedCall).not.toHaveBeenCalled();

    for (const scope of PARANOID_KILL_REGISTRY.flatMap((entry) => entry.scopes)) {
      expect(isParanoidKilledScope(scope), scope).toBe(true);
    }
    expect(isParanoidKilledScope('market:read')).toBe(false);

    const portfolioEvents = PARANOID_KILL_REGISTRY.find(
      (entry) => entry.capability === 'portfolioWebhooks',
    )!.webhookEventTypes;
    for (const type of portfolioEvents.filter((value) => value !== 'friend.activity')) {
      expect(isPortfolioContentWebhookEvent({ type } as DomainEvent), type).toBe(true);
    }
    expect(
      isPortfolioContentWebhookEvent({
        type: 'friend.activity',
        itemKind: 'portfolio',
      } as DomainEvent),
    ).toBe(true);
    expect(
      isPortfolioContentWebhookEvent({
        type: 'friend.activity',
        itemKind: 'watchlist',
      } as DomainEvent),
    ).toBe(false);
    expect(PARANOID_KILL_REGISTRY.flatMap((entry) => entry.jobs).sort()).toMatchInlineSnapshot(`
      [
        "marketIntel.dividendScan",
        "mirror.replicate",
        "notifications.earningsRemind",
        "snapshots.backfill",
        "snapshots.recompute",
        "standingOrders.process",
        "webhooks.deliver",
      ]
    `);
  });

  it('returns PARANOID_MODE for every named HTTP family while kept routes work', async () => {
    const { user, agent } = await paranoidAccount();
    const killed: Array<{ method: 'get' | 'post'; path: string }> = [
      { method: 'get', path: '/api/v1/portfolios' },
      {
        method: 'get',
        path: '/api/v1/analytics/portfolios/018f0000-0000-7000-8000-000000000001/series',
      },
      { method: 'get', path: '/api/v1/imports/brokers' },
      { method: 'get', path: '/api/v1/expenses/categories' },
      { method: 'get', path: '/api/v1/mirrorchain/chains' },
      { method: 'get', path: '/api/v1/standing-orders' },
      { method: 'get', path: '/api/v1/settings/taxes' },
      { method: 'post', path: '/api/v1/ai/insights' },
      { method: 'get', path: '/api/v1/social/shared' },
      { method: 'get', path: '/api/v1/social/groups' },
    ];
    for (const route of killed) {
      const response =
        route.method === 'get'
          ? await agent.get(route.path)
          : await agent
              .post(route.path)
              .set(...XRW)
              .send({});
      expect(response.status, route.path).toBe(403);
      expect(response.body.error.code, route.path).toBe(PARANOID_TRANSITION_ERROR_CODES.mode);
    }

    for (const path of [
      '/api/v1/auth/me',
      '/api/v1/social/friends',
      '/api/v1/social/profile',
      '/api/v1/chat/conversations',
      '/api/v1/workboard',
      '/api/v1/workboard/watchlists',
      '/api/v1/conglomerates',
      '/api/v1/ideas',
      '/api/v1/search?q=AAA',
      '/api/v1/assets/intel/earnings-calendar',
      '/api/v1/alerts',
      '/api/v1/notifications',
      '/api/v1/notifications/announcements',
      '/api/v1/account/export',
    ]) {
      expect((await agent.get(path)).status, path).toBe(200);
    }
    const icon = await agent
      .put('/api/v1/social/profile')
      .set(...XRW)
      .send({ isPublic: false, profileIcon: 'fox' });
    expect(icon.status).toBe(200);
    expect(icon.body).toMatchObject({ isPublic: false, profileIcon: 'fox' });
    const republish = await agent
      .put('/api/v1/social/profile')
      .set(...XRW)
      .send({ isPublic: true, acknowledgePublic: true });
    expect(republish.status).toBe(403);
    expect(republish.body.error.code).toBe(PARANOID_TRANSITION_ERROR_CODES.mode);
    const key = await agent
      .post('/api/v1/settings/api-keys')
      .set(...XRW)
      .send({ name: 'paranoid matrix', scopes: ['portfolio:read', 'market:read'] });
    expect(key.status).toBe(201);
    const portfolioBearer = await request(harness.app)
      .get('/api/v1/portfolios')
      .set('Authorization', `Bearer ${key.body.token as string}`);
    expect(portfolioBearer.status).toBe(403);
    expect(portfolioBearer.body.error.code).toBe(PARANOID_TRANSITION_ERROR_CODES.mode);
    expect(
      (
        await request(harness.app)
          .get('/api/v1/search?q=AAA')
          .set('Authorization', `Bearer ${key.body.token as string}`)
      ).status,
    ).toBe(200);
    const publicProfile = await request(harness.app).get(
      `/api/v1/social/profiles/${user.username}`,
    );
    expect(publicProfile.status).toBe(404);
  });

  it('fails closed below HTTP, including inbound follow and Mirrorchain invite targets', async () => {
    const { user } = await paranoidAccount();
    const normal = await harness.seedUser({
      email: 'normal@bettertrack.test',
      username: 'normal_user',
    });

    const killedCalls = [
      () => harness.ctx.portfolio.listPortfolios(user.id),
      () => harness.ctx.customAssets.list(user.id),
      () => harness.ctx.analytics.getSeries(user.id, 'portfolio-id', { mode: 'value' }),
      () => harness.ctx.marketIntel.newsDigest(user.id),
      () => harness.ctx.tax.getSettings(user.id),
      () =>
        harness.ctx.tax.planTransactionTaxes({
          userId: user.id,
          portfolioId: 'portfolio-id',
          inputs: [],
          assetsById: new Map(),
          resolveSourceId: async () => 'source-id',
        }),
      () => harness.ctx.expenses.listCategories(user.id),
      () => harness.ctx.imports.getBatch(user.id, 'batch-id'),
      () => harness.ctx.standingOrders.list(user.id),
      () => harness.ctx.mirror.listChainsForUser(user.id),
      () => harness.ctx.social.listSharedWithMe(user.id),
      () => harness.ctx.comments.getThread(user.id, 'portfolio', 'subject-id'),
      () => harness.ctx.aiFeatures.insights(user.id, { portfolioId: 'portfolio-id' }),
      () => harness.ctx.social.followUser(normal.id, user.id),
      () => harness.ctx.mirror.inviteMember(normal.id, 'chain-id', user.id),
    ];
    for (const call of killedCalls) {
      await expect(call()).rejects.toMatchObject({
        code: PARANOID_TRANSITION_ERROR_CODES.mode,
      });
    }

    await expect(harness.ctx.social.listFriends(user.id)).resolves.toEqual({ friends: [] });
    await expect(harness.ctx.social.getProfileSettings(user.id)).resolves.toMatchObject({
      isPublic: false,
    });
    await expect(
      harness.ctx.social.updateProfileSettings(user.id, {
        isPublic: true,
        acknowledgePublic: true,
      }),
    ).rejects.toMatchObject({ code: PARANOID_TRANSITION_ERROR_CODES.mode });
    await expect(harness.ctx.alerts.list(user.id)).resolves.toEqual([]);
    await expect(harness.ctx.workboard.list(user.id)).resolves.toEqual([]);
    const watchlist = await harness.ctx.workboard.createWatchlist(user.id, 'Private');
    await expect(
      harness.ctx.workboard.renameWatchlist(user.id, watchlist.id, 'Still private'),
    ).resolves.toMatchObject({ name: 'Still private', audience: 'private' });
  });
});
