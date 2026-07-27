import { eq } from 'drizzle-orm';
import type { Application } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PARANOID_TRANSITION_ERROR_CODES } from '@bettertrack/contracts';

import { createParanoidEnforcementRepository } from '../../../data/repositories/paranoidEnforcementRepository';
import {
  conglomerates,
  friendGroupMembers,
  friendGroups,
  friendships,
  portfolios,
  shareAudiences,
  users,
} from '../../../data/schema';
import type { DomainEvent } from '../../../events';
import {
  ALL_QUEUE_NAMES,
  assertParanoidJobBindings,
  bindParanoidJob,
  createParanoidUserJobFilter,
  type JobDefinition,
} from '../../../jobs';
import { buildRouteTable } from '../../../scripts/checkOpenapiCoverage';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import {
  isParanoidKilledScope,
  isParanoidKilledWebhookEvent,
  isParanoidOwnedSubjectBlocked,
  paranoidWebhookSubjectIds,
  ParanoidModeError,
  paranoidClassificationsForRoute,
  paranoidCapabilityForRoute,
  PARANOID_JOB_POLICIES,
  PARANOID_KILL_REGISTRY,
  PARANOID_SERVICE_BINDINGS,
  PARANOID_SERVICE_EXEMPTIONS,
  PARANOID_WEBHOOK_SUBJECT_POLICIES,
  registeredServiceMethods,
  serviceMethodNames,
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
  it('classifies every mounted route exactly once and resolves every killed route rule', () => {
    const capabilities = PARANOID_KILL_REGISTRY.map((entry) => entry.capability);
    expect(new Set(capabilities).size).toBe(capabilities.length);
    const mounted = buildRouteTable()
      .filter((route) => route.path.startsWith('/api/v1'))
      .map((route) => ({
        method: route.method,
        path: route.path.slice('/api/v1'.length) || '/',
      }));
    for (const route of mounted) {
      expect(
        paranoidClassificationsForRoute(route.method, route.path),
        `${route.method} ${route.path} must be explicitly kept or killed exactly once`,
      ).toHaveLength(1);
    }

    for (const entry of PARANOID_KILL_REGISTRY) {
      const railCount =
        entry.routes.length +
        entry.services.length +
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

  it('resolves and invokes every registered service binding on the real context', async () => {
    const { user } = await paranoidAccount();
    const context = harness.ctx as unknown as Record<string, object>;
    for (const binding of PARANOID_SERVICE_BINDINGS) {
      const service = context[binding.service];
      expect(service, `ctx.${binding.service} is registered`).toBeTruthy();
      for (const method of registeredServiceMethods(service!, binding)) {
        const executable = (service as Record<string, (...args: unknown[]) => unknown>)[method];
        expect(typeof executable, `${binding.service}.${method} resolves`).toBe('function');
        const args: unknown[] =
          binding.subject === 'intrinsic'
            ? method === 'getByPublicLink'
              ? ['missing-public-link-token']
              : method === 'getPublicProfile'
                ? [user.username]
                : [user.username, 'portfolio', '018f0000-0000-7000-8000-000000000099']
            : binding.subject === 'userIdField'
              ? [{ userId: user.id }]
              : binding.subject === 'paranoidWebhookSubjects'
                ? [{ type: 'portfolio.changed', userId: user.id }]
                : binding.subject === 'portfolioIdFirst' || binding.subject === 'assetIdFirst'
                  ? ['018f0000-0000-7000-8000-000000000099']
                  : [user.id];
        const call = Promise.resolve().then(() => Reflect.apply(executable!, service, args));
        if (binding.subject === 'intrinsic') {
          await expect(call, `${binding.service}.${method}`).rejects.toMatchObject({
            statusCode: 404,
          });
        } else if (binding.action === 'skip') {
          await expect(call, `${binding.service}.${method}`).resolves.toBeUndefined();
        } else {
          await expect(call, `${binding.service}.${method}`).rejects.toMatchObject({
            code: PARANOID_TRANSITION_ERROR_CODES.mode,
          });
        }
      }
    }

    const services = new Set([
      ...PARANOID_SERVICE_BINDINGS.map((binding) => binding.service),
      ...PARANOID_SERVICE_EXEMPTIONS.map((binding) => binding.service),
    ]);
    for (const serviceName of services) {
      const service = context[serviceName]!;
      const classified = new Set([
        ...PARANOID_SERVICE_BINDINGS.filter((binding) => binding.service === serviceName).flatMap(
          (binding) => registeredServiceMethods(service, binding),
        ),
        ...PARANOID_SERVICE_EXEMPTIONS.filter((binding) => binding.service === serviceName).flatMap(
          (binding) => registeredServiceMethods(service, binding),
        ),
      ]);
      expect(
        [...classified].sort(),
        `${serviceName} must classify every real service method`,
      ).toEqual(serviceMethodNames(service).sort());
    }

    for (const scope of PARANOID_KILL_REGISTRY.flatMap((entry) => entry.scopes)) {
      expect(isParanoidKilledScope(scope), scope).toBe(true);
    }
    expect(isParanoidKilledScope('market:read')).toBe(false);

    const killedWebhookEvents = [
      ...new Set(PARANOID_KILL_REGISTRY.flatMap((entry) => entry.webhookEventTypes)),
    ];
    expect(Object.keys(PARANOID_WEBHOOK_SUBJECT_POLICIES).sort()).toEqual(
      [...killedWebhookEvents].sort(),
    );
    for (const type of killedWebhookEvents) {
      expect(isParanoidKilledWebhookEvent({ type } as DomainEvent), type).toBe(true);
    }
    expect(
      isParanoidKilledWebhookEvent({
        type: 'friend.activity',
        itemKind: 'portfolio',
      } as DomainEvent),
    ).toBe(true);
    expect(
      isParanoidKilledWebhookEvent({
        type: 'friend.activity',
        itemKind: 'watchlist',
      } as DomainEvent),
    ).toBe(true);
    expect(
      paranoidWebhookSubjectIds({
        type: 'watchlist.shared',
        userId: 'recipient',
        actorId: 'owner',
      } as DomainEvent),
    ).toEqual(['recipient', 'owner']);
    expect(
      paranoidWebhookSubjectIds({
        type: 'dividend.event',
        userId: 'owner',
      } as DomainEvent),
    ).toEqual(['owner']);
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

  it('classifies every queue and requires an executable binding for every killed job', async () => {
    expect(Object.keys(PARANOID_JOB_POLICIES).sort()).toEqual([...ALL_QUEUE_NAMES].sort());

    const alwaysParanoid = {
      isParanoid: vi.fn(async () => true),
      runAllowed: vi.fn(
        async (
          _userId: string,
          capability: ConstructorParameters<typeof ParanoidModeError>[0],
          _action: () => Promise<unknown>,
        ) => {
          throw new ParanoidModeError(capability);
        },
      ),
    };
    const handlers = new Map<string, ReturnType<typeof vi.fn>>();
    const definitions: JobDefinition[] = [];
    for (const [name, policy] of Object.entries(PARANOID_JOB_POLICIES)) {
      const handler = vi.fn(async () => {});
      handlers.set(name, handler);
      const definition = {
        name,
        handler,
      } as unknown as JobDefinition;
      if (!policy.capability) {
        definitions.push(definition);
      } else if (policy.mode === 'portfolio') {
        definitions.push(
          bindParanoidJob(definition, {
            mode: 'portfolio',
            runIfAllowed: async () => false,
          }),
        );
      } else if (policy.mode === 'event') {
        definitions.push(
          bindParanoidJob(definition, {
            mode: 'event',
            runIfAllowed: async () => false,
          }),
        );
      } else if (policy.mode === 'perUser') {
        const filter = createParanoidUserJobFilter(name, alwaysParanoid);
        expect(await filter('user-id')).toBe(true);
        definitions.push(bindParanoidJob(definition, { mode: 'perUser', filter }));
      } else if (policy.mode === 'serviceFiltered' || policy.mode === 'transitionPrecondition') {
        definitions.push(bindParanoidJob(definition, { mode: policy.mode }));
      } else {
        throw new Error(`unexpected killed-job policy ${name}:${policy.mode}`);
      }
    }
    expect(() => assertParanoidJobBindings(definitions, ALL_QUEUE_NAMES)).not.toThrow();
    expect(() =>
      assertParanoidJobBindings(
        definitions.filter((definition) => definition.name !== 'snapshots.recompute'),
        ALL_QUEUE_NAMES,
      ),
    ).toThrow(/snapshots\.recompute/);
    expect(() =>
      assertParanoidJobBindings(definitions, [...ALL_QUEUE_NAMES, 'future.unclassified']),
    ).toThrow(/registry drift/);

    const jobContext = { logger: { info: vi.fn() } } as never;
    await definitions
      .find((definition) => definition.name === 'snapshots.recompute')!
      .handler({ data: { portfolioId: 'stale-id' } } as never, jobContext);
    expect(handlers.get('snapshots.recompute')).not.toHaveBeenCalled();
    await definitions
      .find((definition) => definition.name === 'webhooks.deliver')!
      .handler(
        {
          data: { event: { type: 'portfolio.changed', userId: 'user-id' } },
        } as never,
        jobContext,
      );
    expect(handlers.get('webhooks.deliver')).not.toHaveBeenCalled();
  });

  it('drops queued sharing webhooks when either recipient or item owner is paranoid', async () => {
    const recipient = await harness.seedUser({
      email: 'webhook-recipient@bettertrack.test',
      username: 'webhook_recipient',
    });
    const owner = await harness.seedUser({
      email: 'webhook-owner@bettertrack.test',
      username: 'webhook_owner',
    });
    const handler = vi.fn(async () => {});
    const definition = bindParanoidJob(
      { name: 'webhooks.deliver', handler } as unknown as JobDefinition<'webhooks.deliver'>,
      {
        mode: 'event',
        runIfAllowed: async (userIds, action) => {
          try {
            await harness.ctx.paranoidGuard.runAllowedMany(userIds, 'portfolioWebhooks', action);
            return true;
          } catch (error) {
            if (error instanceof ParanoidModeError) return false;
            throw error;
          }
        },
      },
    );
    const jobContext = { logger: { info: vi.fn() } } as never;

    await harness.db
      .update(users)
      .set({
        privacyMode: 'paranoid',
        paranoidMediaSet: ['drive'],
        paranoidDriveAttestedVersion: 1,
      })
      .where(eq(users.id, owner.id));
    await definition.handler(
      {
        data: {
          event: {
            type: 'portfolio.shared',
            userId: recipient.id,
            actorId: owner.id,
            actorUsername: owner.username,
            portfolioId: '018f0000-0000-7000-8000-000000000091',
            occurredAt: '2026-07-27T00:00:00.000Z',
          },
        },
      } as never,
      jobContext,
    );

    await harness.db
      .update(users)
      .set({
        privacyMode: 'normal',
        paranoidMediaSet: null,
        paranoidDriveAttestedVersion: null,
      })
      .where(eq(users.id, owner.id));
    await harness.db
      .update(users)
      .set({
        privacyMode: 'paranoid',
        paranoidMediaSet: ['drive'],
        paranoidDriveAttestedVersion: 1,
      })
      .where(eq(users.id, recipient.id));
    await definition.handler(
      {
        data: {
          event: {
            type: 'watchlist.shared',
            userId: recipient.id,
            actorId: owner.id,
            actorUsername: owner.username,
            watchlistId: '018f0000-0000-7000-8000-000000000092',
            occurredAt: '2026-07-27T00:00:00.000Z',
          },
        },
      } as never,
      jobContext,
    );

    expect(handler).not.toHaveBeenCalled();
  });

  it('fails closed for a stale snapshot id after its paranoid portfolio was purged', async () => {
    const { user } = await paranoidAccount();
    const [portfolio] = await harness.db
      .insert(portfolios)
      .values({ userId: user.id, name: 'Soon purged' })
      .returning();
    await harness.db.delete(portfolios).where(eq(portfolios.id, portfolio!.id));

    const subjects = createParanoidEnforcementRepository(harness.db);
    expect(
      await isParanoidOwnedSubjectBlocked(
        await subjects.portfolioOwner(portfolio!.id),
        harness.ctx.paranoidGuard,
      ),
    ).toBe(true);
    await expect(harness.ctx.snapshots.recompute(portfolio!.id)).rejects.toMatchObject({
      code: PARANOID_TRANSITION_ERROR_CODES.mode,
    });
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
    await expect(harness.ctx.workboard.itemsForSharedView(watchlist.id)).rejects.toMatchObject({
      code: PARANOID_TRANSITION_ERROR_CODES.mode,
    });
  });

  it('rejects group and all-friends targeting of paranoid accounts before any write', async () => {
    const { user: paranoid } = await paranoidAccount();
    const normal = await harness.seedUser({
      email: 'social-owner@bettertrack.test',
      username: 'social_owner',
    });
    const [userA, userB] = [normal.id, paranoid.id].sort();
    await harness.db.insert(friendships).values({ userA: userA!, userB: userB! });
    const [group] = await harness.db
      .insert(friendGroups)
      .values({ ownerId: normal.id, name: 'Private circle' })
      .returning();

    await expect(
      harness.ctx.social.addGroupMember(normal.id, group!.id, paranoid.id),
    ).rejects.toMatchObject({ code: PARANOID_TRANSITION_ERROR_CODES.mode });
    expect(
      await harness.db
        .select()
        .from(friendGroupMembers)
        .where(eq(friendGroupMembers.groupId, group!.id)),
    ).toEqual([]);

    const [conglomerate] = await harness.db
      .insert(conglomerates)
      .values({ ownerId: normal.id, name: 'Normal basket', status: 'draft' })
      .returning();
    await expect(
      harness.ctx.conglomerate.updateWithVisibility(normal.id, conglomerate!.id, {
        visibility: 'friends',
      }),
    ).rejects.toMatchObject({ code: PARANOID_TRANSITION_ERROR_CODES.mode });
    expect(
      (
        await harness.db
          .select({ visibility: conglomerates.visibility })
          .from(conglomerates)
          .where(eq(conglomerates.id, conglomerate!.id))
      )[0]?.visibility,
    ).toBe('private');
    expect(
      await harness.db
        .select()
        .from(shareAudiences)
        .where(eq(shareAudiences.subjectId, conglomerate!.id)),
    ).toEqual([]);
  });

  it('rejects a paranoid conglomerate visibility patch before changing either model', async () => {
    const { user, agent } = await paranoidAccount();
    const [conglomerate] = await harness.db
      .insert(conglomerates)
      .values({ ownerId: user.id, name: 'Private basket', status: 'draft' })
      .returning();

    const response = await agent
      .patch(`/api/v1/conglomerates/${conglomerate!.id}`)
      .set(...XRW)
      .send({ name: 'Must stay private', visibility: 'friends' });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe(PARANOID_TRANSITION_ERROR_CODES.mode);
    await expect(
      harness.ctx.conglomerate.update(user.id, conglomerate!.id, {
        name: 'Direct bypass',
        visibility: 'friends',
      } as Parameters<typeof harness.ctx.conglomerate.update>[2]),
    ).rejects.toMatchObject({ code: 'CONGLOMERATE_VISIBILITY_GUARD_REQUIRED' });
    expect(
      (
        await harness.db
          .select({ name: conglomerates.name, visibility: conglomerates.visibility })
          .from(conglomerates)
          .where(eq(conglomerates.id, conglomerate!.id))
      )[0],
    ).toEqual({ name: 'Private basket', visibility: 'private' });
    expect(
      await harness.db
        .select()
        .from(shareAudiences)
        .where(eq(shareAudiences.subjectId, conglomerate!.id)),
    ).toEqual([]);
  });
});
