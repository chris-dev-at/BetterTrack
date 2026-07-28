import { eq } from 'drizzle-orm';
import type { Application } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createParanoidEnforcementRepository,
  withExclusiveParanoidTransitionTestLock,
} from '../../../data/repositories/paranoidEnforcementRepository';
import {
  assets,
  alerts,
  portfolioCashMovements,
  conglomerates,
  friendGroupMembers,
  friendGroups,
  friendships,
  mirrorChainInvites,
  mirrorChainMembers,
  mirrorChainOps,
  notifications,
  itemReactions,
  portfolios,
  shareAudiences,
  transactions,
  userFollows,
  users,
  watchlists,
  workboardItems,
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
  cachedIntel,
  createStubMarketData,
  sampleEarningsEvents,
} from '../../../testing/marketDataStubs';
import {
  isParanoidKilledScope,
  isParanoidKilledWebhookEvent,
  isParanoidOwnedSubjectBlocked,
  paranoidClassificationsForRoute,
  paranoidCapabilityForRoute,
  PARANOID_JOB_POLICIES,
  PARANOID_KILL_REGISTRY,
  PARANOID_MODE_ERROR_CODE,
  PARANOID_SERVICE_BINDINGS,
  PARANOID_SERVICE_EXEMPTIONS,
  PARANOID_WEBHOOK_SUBJECT_POLICIES,
  ParanoidModeError,
  paranoidWebhookSubjectIds,
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

async function setParanoid(userId: string): Promise<void> {
  await harness.db
    .update(users)
    .set({
      privacyMode: 'paranoid',
      paranoidMediaSet: ['drive'],
      paranoidDriveAttestedVersion: 1,
      profilePublic: false,
    })
    .where(eq(users.id, userId));
}

async function startWinningParanoidTransition(userId: string): Promise<{
  finish(): Promise<void>;
}> {
  let releaseTransition!: () => void;
  let transitionLocked!: () => void;
  const release = new Promise<void>((resolve) => {
    releaseTransition = resolve;
  });
  const locked = new Promise<void>((resolve) => {
    transitionLocked = resolve;
  });
  const transition = withExclusiveParanoidTransitionTestLock(harness.db, userId, async () => {
    await setParanoid(userId);
    transitionLocked();
    await release;
  });
  await locked;
  return {
    async finish() {
      releaseTransition();
      await transition;
    },
  };
}

async function paranoidAccount() {
  const user = await harness.seedUser({
    email: 'matrix@bettertrack.test',
    username: 'matrix_user',
  });
  await setParanoid(user.id);
  return { user, agent: await loginAgent(harness.app, user.email, user.password) };
}

function representativePath(rule: (typeof PARANOID_KILL_REGISTRY)[number]['routes'][number]) {
  if ('exact' in rule && rule.exact) return rule.exact;
  if ('prefix' in rule && rule.prefix) return `${rule.prefix}probe`;
  return '/ideas/018f0000-0000-7000-8000-000000000001/clone';
}

function expectUnique(values: readonly string[], rail: string): void {
  expect(new Set(values).size, `${rail} contains an overlapping registry entry`).toBe(
    values.length,
  );
}

describe('paranoid kill registry', () => {
  it('classifies each mounted route and every non-route rail exactly once', () => {
    const capabilities = PARANOID_KILL_REGISTRY.map((entry) => entry.capability);
    expectUnique(capabilities, 'capabilities');
    expectUnique(
      PARANOID_KILL_REGISTRY.flatMap((entry) => entry.scopes),
      'OAuth scopes',
    );
    expectUnique(
      PARANOID_KILL_REGISTRY.flatMap((entry) => entry.jobs),
      'jobs',
    );
    expectUnique(
      PARANOID_KILL_REGISTRY.flatMap((entry) => entry.webhookEventTypes),
      'webhook event types',
    );

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
        expect(paranoidCapabilityForRoute(method, representativePath(rule))).toBe(entry.capability);
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

  it('resolves, invokes, and exhaustively classifies every registered service method', async () => {
    const { user } = await paranoidAccount();
    const [portfolio] = await harness.db
      .insert(portfolios)
      .values({ userId: user.id, name: 'Private matrix' })
      .returning();
    const [asset] = await harness.db
      .insert(assets)
      .values({
        providerId: 'manual',
        providerRef: `matrix:${user.id}`,
        ownerId: user.id,
        type: 'custom',
        symbol: 'PRIVATE',
        name: 'Private matrix asset',
        currency: 'EUR',
      })
      .returning();
    const context = harness.ctx as unknown as Record<string, object>;
    const serviceRails: string[] = [];

    for (const binding of PARANOID_SERVICE_BINDINGS) {
      const service = context[binding.service];
      expect(service, `ctx.${binding.service} is registered`).toBeTruthy();
      for (const method of registeredServiceMethods(service!, binding)) {
        serviceRails.push(`${binding.service}.${method}`);
        const executable = (service as Record<string, (...args: unknown[]) => unknown>)[method];
        expect(typeof executable, `${binding.service}.${method} resolves`).toBe('function');
        if (
          binding.subject === 'dynamicPrincipals' ||
          binding.subject === 'userIdFirstAndDynamicPrincipals'
        ) {
          expect(
            binding.coverage,
            `${binding.service}.${method} must declare its semantic principal coverage`,
          ).toContain('dynamicPrincipals');
          continue;
        }
        const args: unknown[] =
          binding.subject === 'intrinsic'
            ? method === 'getByPublicLink'
              ? ['missing-public-link-token']
              : method === 'getPublicProfile'
                ? [user.username]
                : [user.username, 'portfolio', portfolio!.id]
            : binding.subject === 'userIdField'
              ? [{ userId: user.id }]
              : binding.subject === 'paranoidWebhookSubjects'
                ? [{ type: 'portfolio.changed', userId: user.id }]
                : binding.subject === 'portfolioIdFirst' ||
                    binding.subject === 'portfolioIdFirstAllowMissing'
                  ? [portfolio!.id]
                  : binding.subject === 'assetIdFirst'
                    ? [asset!.id]
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
            code: PARANOID_MODE_ERROR_CODE,
          });
        }
      }
    }
    expectUnique(serviceRails, 'service methods');

    const services = new Set([
      ...PARANOID_SERVICE_BINDINGS.map((binding) => binding.service),
      ...PARANOID_SERVICE_EXEMPTIONS.map((binding) => binding.service),
    ]);
    for (const serviceName of services) {
      const service = context[serviceName]!;
      const classified = [
        ...PARANOID_SERVICE_BINDINGS.filter((binding) => binding.service === serviceName).flatMap(
          (binding) => registeredServiceMethods(service, binding),
        ),
        ...PARANOID_SERVICE_EXEMPTIONS.filter((binding) => binding.service === serviceName).flatMap(
          (binding) => registeredServiceMethods(service, binding),
        ),
      ];
      expectUnique(
        classified.map((method) => `${serviceName}.${method}`),
        `${serviceName} methods`,
      );
      expect(classified.sort(), `${serviceName} must classify every real method`).toEqual(
        serviceMethodNames(service).sort(),
      );
    }

    for (const exemption of PARANOID_SERVICE_EXEMPTIONS) {
      if (exemption.handling === 'kept') continue;
      expect(
        exemption.coverage.length,
        `${exemption.service}.${exemption.methods.join(',')} needs semantic coverage`,
      ).toBeGreaterThan(0);
    }

    const semanticCoverageFor = (serviceName: string, method: string) => {
      const binding = PARANOID_SERVICE_BINDINGS.find(
        (candidate) =>
          candidate.service === serviceName &&
          registeredServiceMethods(context[serviceName]!, candidate).includes(method),
      );
      if (binding) return binding.coverage ?? [];
      const exemption = PARANOID_SERVICE_EXEMPTIONS.find(
        (candidate) =>
          candidate.service === serviceName &&
          registeredServiceMethods(context[serviceName]!, candidate).includes(method),
      );
      return exemption?.handling === 'kept' ? [] : (exemption?.coverage ?? []);
    };
    for (const method of [
      'listChainsForUser',
      'getMemberList',
      'getActivity',
      'listInvites',
      'renameChain',
    ]) {
      expect(semanticCoverageFor('mirror', method), `mirror.${method}`).toContain(
        'dynamicPrincipals',
      );
    }
    for (const [serviceName, methods] of [
      ['workboard', ['list', 'listInWatchlist', 'addItem']],
      ['alerts', ['list', 'create', 'update', 'rearm']],
      ['backtest', ['runPreview', 'runComparison']],
    ] as const) {
      for (const method of methods) {
        expect(semanticCoverageFor(serviceName, method), `${serviceName}.${method}`).toContain(
          'ownedAssetProvenance',
        );
      }
    }

    for (const scope of PARANOID_KILL_REGISTRY.flatMap((entry) => entry.scopes)) {
      expect(isParanoidKilledScope(scope), scope).toBe(true);
    }
    expect(isParanoidKilledScope('market:read')).toBe(false);

    const killedWebhookEvents = PARANOID_KILL_REGISTRY.flatMap((entry) => entry.webhookEventTypes);
    expect(Object.keys(PARANOID_WEBHOOK_SUBJECT_POLICIES).sort()).toEqual(
      [...killedWebhookEvents].sort(),
    );
    for (const type of killedWebhookEvents) {
      expect(isParanoidKilledWebhookEvent({ type } as DomainEvent), type).toBe(true);
    }
    expect(
      paranoidWebhookSubjectIds({
        type: 'watchlist.shared',
        userId: 'recipient',
        actorId: 'owner',
      } as DomainEvent),
    ).toEqual(['recipient', 'owner']);
    expect(
      paranoidWebhookSubjectIds({
        type: 'mirror.member_removed',
        userId: 'recipient',
        actorId: 'manager',
        ownerId: 'owner',
        subjectUserIds: ['removed', 'owner'],
      } as DomainEvent),
    ).toEqual(['recipient', 'manager', 'owner', 'removed']);
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
      const definition = { name, handler } as unknown as JobDefinition;
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
      } else if (policy.mode === 'serviceFiltered') {
        definitions.push(bindParanoidJob(definition, { mode: 'serviceFiltered' }));
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

  it('returns PARANOID_MODE over HTTP, bearer scopes, and direct service calls', async () => {
    const { user, agent } = await paranoidAccount();
    const killed: Array<{ method: 'get' | 'post'; path: string }> = [
      { method: 'get', path: '/api/v1/portfolios' },
      { method: 'get', path: '/api/v1/imports/brokers' },
      { method: 'get', path: '/api/v1/expenses/categories' },
      { method: 'get', path: '/api/v1/mirrorchain/chains' },
      { method: 'get', path: '/api/v1/standing-orders' },
      { method: 'get', path: '/api/v1/settings/taxes' },
      { method: 'post', path: '/api/v1/ai/insights' },
      { method: 'get', path: '/api/v1/social/shared' },
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
      expect(response.body.error.code, route.path).toBe(PARANOID_MODE_ERROR_CODE);
    }

    for (const path of [
      '/api/v1/auth/me',
      '/api/v1/social/friends',
      '/api/v1/social/profile',
      '/api/v1/chat/conversations',
      '/api/v1/workboard',
      '/api/v1/conglomerates',
      '/api/v1/ideas',
      '/api/v1/search?q=AAA',
      '/api/v1/assets/intel/earnings-calendar',
      '/api/v1/alerts',
      '/api/v1/notifications',
      '/api/v1/account/export',
    ]) {
      expect((await agent.get(path)).status, path).toBe(200);
    }

    const key = await agent
      .post('/api/v1/settings/api-keys')
      .set(...XRW)
      .send({ name: 'paranoid matrix', scopes: ['portfolio:read', 'market:read'] });
    expect(key.status).toBe(201);
    const portfolioBearer = await request(harness.app)
      .get('/api/v1/portfolios')
      .set('Authorization', `Bearer ${key.body.token as string}`);
    expect(portfolioBearer.status).toBe(403);
    expect(portfolioBearer.body.error.code).toBe(PARANOID_MODE_ERROR_CODE);
    expect(
      (
        await request(harness.app)
          .get('/api/v1/search?q=AAA')
          .set('Authorization', `Bearer ${key.body.token as string}`)
      ).status,
    ).toBe(200);
    expect(
      (await request(harness.app).get(`/api/v1/social/profiles/${user.username}`)).status,
    ).toBe(404);

    const normal = await harness.seedUser({
      email: 'normal@bettertrack.test',
      username: 'normal_user',
    });
    const killedCalls = [
      () => harness.ctx.portfolio.listPortfolios(user.id),
      () => harness.ctx.customAssets.list(user.id),
      () => harness.ctx.tax.getSettings(user.id),
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
      await expect(call()).rejects.toMatchObject({ code: PARANOID_MODE_ERROR_CODE });
    }
  });

  it('denies stale subject ids and targeted sharing without partial writes', async () => {
    const { user: paranoid } = await paranoidAccount();
    const subjects = createParanoidEnforcementRepository(harness.db);
    expect(
      await isParanoidOwnedSubjectBlocked(
        await subjects.portfolioOwner('018f0000-0000-7000-8000-000000000099'),
        harness.ctx.paranoidGuard,
      ),
    ).toBe(true);
    await expect(
      harness.ctx.snapshots.recompute('018f0000-0000-7000-8000-000000000099'),
    ).rejects.toMatchObject({ code: PARANOID_MODE_ERROR_CODE });

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
    ).rejects.toMatchObject({ code: PARANOID_MODE_ERROR_CODE });
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
    ).rejects.toMatchObject({ code: PARANOID_MODE_ERROR_CODE });
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

    const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(normal.id);
    await expect(
      harness.ctx.portfolio.updatePortfolio(normal.id, portfolioId, {
        visibility: 'friends',
      } as never),
    ).rejects.toMatchObject({ code: 'PORTFOLIO_VISIBILITY_GUARD_REQUIRED' });
    await expect(
      harness.ctx.portfolio.updatePortfolioWithVisibility(normal.id, portfolioId, {
        visibility: 'friends',
      }),
    ).rejects.toMatchObject({ code: PARANOID_MODE_ERROR_CODE });
    const ownerAgent = await loginAgent(harness.app, normal.email, normal.password);
    const routeUpdate = await ownerAgent
      .patch(`/api/v1/portfolios/${portfolioId}`)
      .set(...XRW)
      .send({ visibility: 'friends' });
    expect(routeUpdate.status).toBe(403);
    expect(routeUpdate.body.error.code).toBe(PARANOID_MODE_ERROR_CODE);
    expect(
      (
        await harness.db
          .select({ visibility: portfolios.visibility })
          .from(portfolios)
          .where(eq(portfolios.id, portfolioId))
      )[0]?.visibility,
    ).toBe('private');
    expect(
      await harness.db
        .select()
        .from(shareAudiences)
        .where(eq(shareAudiences.subjectId, portfolioId)),
    ).toEqual([]);
    expect(await harness.db.select().from(notifications)).toEqual([]);
  });

  it('uses one locked friend snapshot for portfolio and conglomerate visibility writes', async () => {
    async function mutateAcrossFriendChurn<T>(input: {
      ownerId: string;
      racedFriendId: string;
      sharingCall: number;
      mutate: () => Promise<T>;
    }): Promise<T> {
      const guard = harness.ctx.paranoidGuard;
      const original = guard.runAllowedMany;
      let sharingCalls = 0;
      let injected = false;
      guard.runAllowedMany = async <TResult>(
        userIds: readonly string[],
        capability: Parameters<typeof original>[1],
        action: () => Promise<TResult>,
      ): Promise<TResult> => {
        if (capability === 'sharing' && userIds.includes(input.ownerId)) {
          sharingCalls += 1;
          if (sharingCalls === input.sharingCall) {
            const [userA, userB] =
              input.ownerId < input.racedFriendId
                ? [input.ownerId, input.racedFriendId]
                : [input.racedFriendId, input.ownerId];
            await harness.db.insert(friendships).values({ userA, userB });
            injected = true;
          }
        }
        return original.call(guard, userIds, capability, action) as Promise<TResult>;
      };
      try {
        const result = await input.mutate();
        expect(injected).toBe(true);
        return result;
      } finally {
        guard.runAllowedMany = original;
      }
    }

    const portfolioOwner = await harness.seedUser({
      email: 'portfolio-friend-churn@bettertrack.test',
      username: 'portfolio_friend_churn',
    });
    const portfolioFriend = await harness.seedUser({
      email: 'portfolio-raced-friend@bettertrack.test',
      username: 'portfolio_raced_friend',
    });
    await setParanoid(portfolioFriend.id);
    const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(portfolioOwner.id);
    await mutateAcrossFriendChurn({
      ownerId: portfolioOwner.id,
      racedFriendId: portfolioFriend.id,
      sharingCall: 1,
      mutate: () =>
        harness.ctx.portfolio.updatePortfolioWithVisibility(portfolioOwner.id, portfolioId, {
          visibility: 'friends',
        }),
    });

    const [portfolioRow] = await harness.db
      .select({ visibility: portfolios.visibility })
      .from(portfolios)
      .where(eq(portfolios.id, portfolioId));
    const [portfolioAudience] = await harness.db
      .select({ audience: shareAudiences.audience })
      .from(shareAudiences)
      .where(eq(shareAudiences.subjectId, portfolioId));
    expect(portfolioRow?.visibility).toBe('friends');
    expect(portfolioAudience?.audience).toBe('all_friends');
    expect(
      (
        await harness.db
          .select()
          .from(notifications)
          .where(eq(notifications.userId, portfolioFriend.id))
      ).filter((row) => row.type === 'portfolio.shared'),
    ).toEqual([]);

    const conglomerateOwner = await harness.seedUser({
      email: 'conglomerate-friend-churn@bettertrack.test',
      username: 'conglomerate_friend_churn',
    });
    const conglomerateFriend = await harness.seedUser({
      email: 'conglomerate-raced-friend@bettertrack.test',
      username: 'conglomerate_raced_friend',
    });
    await setParanoid(conglomerateFriend.id);
    const conglomerate = await harness.ctx.conglomerate.create(conglomerateOwner.id, {
      name: 'Stable recipient snapshot',
    });
    await mutateAcrossFriendChurn({
      ownerId: conglomerateOwner.id,
      racedFriendId: conglomerateFriend.id,
      // The registry proxy holds the owner first; the audience service's second
      // sharing guard is the stable recipient snapshot under test.
      sharingCall: 2,
      mutate: () =>
        harness.ctx.conglomerate.updateWithVisibility(conglomerateOwner.id, conglomerate.id, {
          visibility: 'friends',
        }),
    });

    const [conglomerateRow] = await harness.db
      .select({ visibility: conglomerates.visibility })
      .from(conglomerates)
      .where(eq(conglomerates.id, conglomerate.id));
    const [conglomerateAudience] = await harness.db
      .select({ audience: shareAudiences.audience })
      .from(shareAudiences)
      .where(eq(shareAudiences.subjectId, conglomerate.id));
    expect(conglomerateRow?.visibility).toBe('friends');
    expect(conglomerateAudience?.audience).toBe('all_friends');
  });

  it('rejects a stale invite after the chain owner enters paranoid mode without join writes', async () => {
    const owner = await harness.seedUser({
      email: 'mirror-owner-race@bettertrack.test',
      username: 'mirror_owner_race',
    });
    const recipient = await harness.seedUser({
      email: 'mirror-recipient-race@bettertrack.test',
      username: 'mirror_recipient_race',
    });
    const [userA, userB] = [owner.id, recipient.id].sort();
    await harness.db.insert(friendships).values({ userA: userA!, userB: userB! });
    const ownerPortfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(owner.id);
    const { chain } = await harness.ctx.mirror.convertToChain(owner.id, ownerPortfolioId);
    await harness.ctx.mirror.inviteMember(owner.id, chain.id, recipient.id);
    const invite = (await harness.ctx.mirror.listInvites(recipient.id)).incoming[0]!;
    const portfoliosBefore = await harness.db
      .select({ id: portfolios.id })
      .from(portfolios)
      .where(eq(portfolios.userId, recipient.id));

    await withExclusiveParanoidTransitionTestLock(harness.db, owner.id, () =>
      setParanoid(owner.id),
    );
    await expect(harness.ctx.mirror.acceptInvite(recipient.id, invite.id)).rejects.toMatchObject({
      code: PARANOID_MODE_ERROR_CODE,
    });
    expect(
      await harness.db
        .select()
        .from(mirrorChainMembers)
        .where(eq(mirrorChainMembers.userId, recipient.id)),
    ).toEqual([]);
    expect(
      (
        await harness.db
          .select({ status: mirrorChainInvites.status })
          .from(mirrorChainInvites)
          .where(eq(mirrorChainInvites.id, invite.id))
      )[0]?.status,
    ).toBe('pending');
    expect(
      await harness.db
        .select({ id: portfolios.id })
        .from(portfolios)
        .where(eq(portfolios.userId, recipient.id)),
    ).toHaveLength(portfoliosBefore.length);
  });

  it('filters a chain switcher row when the owner transition wins before enrichment', async () => {
    const owner = await harness.seedUser({
      email: 'mirror-read-owner@bettertrack.test',
      username: 'mirror_read_owner',
    });
    const viewer = await harness.seedUser({
      email: 'mirror-read-viewer@bettertrack.test',
      username: 'mirror_read_viewer',
    });
    const ownerPortfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(owner.id);
    const { chain } = await harness.ctx.mirror.convertToChain(owner.id, ownerPortfolioId, {
      name: 'Owner-derived name',
    });
    await harness.ctx.mirror.attachMemberCopy(chain.id, viewer.id);

    const transition = await startWinningParanoidTransition(owner.id);
    const read = harness.ctx.mirror.listChainsForUser(viewer.id);
    let settled = false;
    void read.finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    await transition.finish();
    await expect(read).resolves.toEqual([]);
  });

  it('filters a member sheet row when that member transition wins before profile enrichment', async () => {
    const owner = await harness.seedUser({
      email: 'mirror-roster-owner@bettertrack.test',
      username: 'mirror_roster_owner',
    });
    const member = await harness.seedUser({
      email: 'mirror-roster-member@bettertrack.test',
      username: 'mirror_roster_member',
    });
    const ownerPortfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(owner.id);
    const { chain } = await harness.ctx.mirror.convertToChain(owner.id, ownerPortfolioId);
    await harness.ctx.mirror.attachMemberCopy(chain.id, member.id);

    const transition = await startWinningParanoidTransition(member.id);
    const read = harness.ctx.mirror.getMemberList(owner.id, chain.id);
    let settled = false;
    void read.finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    await transition.finish();
    const result = await read;
    expect(result.members.map((row) => row.userId)).toEqual([owner.id]);
    expect(JSON.stringify(result)).not.toContain(member.username);
  });

  it('filters activity authored by an actor whose transition wins before rendering', async () => {
    const owner = await harness.seedUser({
      email: 'mirror-activity-owner@bettertrack.test',
      username: 'mirror_activity_owner',
    });
    const actor = await harness.seedUser({
      email: 'mirror-activity-actor@bettertrack.test',
      username: 'mirror_activity_actor',
    });
    const ownerPortfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(owner.id);
    const { chain } = await harness.ctx.mirror.convertToChain(owner.id, ownerPortfolioId);
    await harness.ctx.mirror.attachMemberCopy(chain.id, actor.id);

    const transition = await startWinningParanoidTransition(actor.id);
    const read = harness.ctx.mirror.getActivity(owner.id, chain.id, { limit: 50 });
    let settled = false;
    void read.finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    await transition.finish();
    const result = await read;
    expect(result.entries.some((entry) => entry.actorUsername === actor.username)).toBe(false);
    expect(result.entries.some((entry) => entry.actorUsername === owner.username)).toBe(true);
  });

  it('filters an invite when its inviter transition wins before chain/user enrichment', async () => {
    const inviter = await harness.seedUser({
      email: 'mirror-invite-read-owner@bettertrack.test',
      username: 'mirror_invite_read_owner',
    });
    const invitee = await harness.seedUser({
      email: 'mirror-invite-read-viewer@bettertrack.test',
      username: 'mirror_invite_read_viewer',
    });
    const [userA, userB] = [inviter.id, invitee.id].sort();
    await harness.db.insert(friendships).values({ userA: userA!, userB: userB! });
    const ownerPortfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(inviter.id);
    const { chain } = await harness.ctx.mirror.convertToChain(inviter.id, ownerPortfolioId, {
      name: 'Hidden invite chain',
    });
    await harness.ctx.mirror.inviteMember(inviter.id, chain.id, invitee.id);

    const transition = await startWinningParanoidTransition(inviter.id);
    const read = harness.ctx.mirror.listInvites(invitee.id);
    let settled = false;
    void read.finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    await transition.finish();
    await expect(read).resolves.toEqual({ incoming: [], outgoing: [] });
  });

  it('serializes every member lifecycle mutation against a winning affected-account transition', async () => {
    const cases = [
      {
        name: 'setMemberRole target',
        targetRole: 'member' as const,
        mutate: (ownerId: string, chainId: string, targetId: string) =>
          harness.ctx.mirror.setMemberRole(ownerId, chainId, targetId, 'manager'),
      },
      {
        name: 'transferOwnership target',
        targetRole: 'member' as const,
        mutate: (ownerId: string, chainId: string, targetId: string) =>
          harness.ctx.mirror.transferOwnership(ownerId, chainId, targetId),
      },
      {
        name: 'removeMember target',
        targetRole: 'member' as const,
        mutate: (ownerId: string, chainId: string, targetId: string) =>
          harness.ctx.mirror.removeMember(ownerId, chainId, targetId),
      },
      {
        name: 'owner leave successor',
        targetRole: 'manager' as const,
        mutate: (ownerId: string, chainId: string) =>
          harness.ctx.mirror.leaveChain(ownerId, chainId),
      },
      {
        name: 'dissolve affected member',
        targetRole: 'member' as const,
        mutate: (ownerId: string, chainId: string) =>
          harness.ctx.mirror.dissolveChain(ownerId, chainId),
      },
    ];

    for (const [index, lifecycle] of cases.entries()) {
      harness = await createTestApp();
      const owner = await harness.seedUser({
        email: `lifecycle-owner-${index}@bettertrack.test`,
        username: `lifecycle_owner_${index}`,
      });
      const target = await harness.seedUser({
        email: `lifecycle-target-${index}@bettertrack.test`,
        username: `lifecycle_target_${index}`,
      });
      const ownerPortfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(owner.id);
      const { chain } = await harness.ctx.mirror.convertToChain(owner.id, ownerPortfolioId);
      await harness.ctx.mirror.attachMemberCopy(chain.id, target.id, {
        role: lifecycle.targetRole,
      });
      const opCountBefore = (
        await harness.db
          .select({ id: mirrorChainOps.id })
          .from(mirrorChainOps)
          .where(eq(mirrorChainOps.chainId, chain.id))
      ).length;

      const transition = await startWinningParanoidTransition(target.id);
      const mutation = lifecycle.mutate(owner.id, chain.id, target.id);
      let settled = false;
      void mutation
        .finally(() => {
          settled = true;
        })
        .catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(settled, lifecycle.name).toBe(false);

      await transition.finish();
      await expect(mutation).rejects.toMatchObject({ code: PARANOID_MODE_ERROR_CODE });
      const [targetMembership] = await harness.db
        .select()
        .from(mirrorChainMembers)
        .where(eq(mirrorChainMembers.userId, target.id));
      expect(targetMembership?.status, lifecycle.name).toBe('active');
      expect(targetMembership?.role, lifecycle.name).toBe(lifecycle.targetRole);
      expect(targetMembership?.chainId, lifecycle.name).toBe(chain.id);
      expect(
        (
          await harness.db
            .select({ id: mirrorChainOps.id })
            .from(mirrorChainOps)
            .where(eq(mirrorChainOps.chainId, chain.id))
        ).length,
        lifecycle.name,
      ).toBe(opCountBefore);
    }
  });

  it('blocks a manager kick when the chain owner transition wins first', async () => {
    const owner = await harness.seedUser({
      email: 'lifecycle-owner-principal@bettertrack.test',
      username: 'lifecycle_owner_principal',
    });
    const manager = await harness.seedUser({
      email: 'lifecycle-manager-principal@bettertrack.test',
      username: 'lifecycle_manager_principal',
    });
    const target = await harness.seedUser({
      email: 'lifecycle-member-principal@bettertrack.test',
      username: 'lifecycle_member_principal',
    });
    const ownerPortfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(owner.id);
    const { chain } = await harness.ctx.mirror.convertToChain(owner.id, ownerPortfolioId);
    await harness.ctx.mirror.attachMemberCopy(chain.id, manager.id, { role: 'manager' });
    await harness.ctx.mirror.attachMemberCopy(chain.id, target.id, { role: 'member' });
    const opCountBefore = (
      await harness.db
        .select({ id: mirrorChainOps.id })
        .from(mirrorChainOps)
        .where(eq(mirrorChainOps.chainId, chain.id))
    ).length;

    const transition = await startWinningParanoidTransition(owner.id);
    const kick = harness.ctx.mirror.removeMember(manager.id, chain.id, target.id);
    let settled = false;
    void kick
      .finally(() => {
        settled = true;
      })
      .catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    await transition.finish();
    await expect(kick).rejects.toMatchObject({ code: PARANOID_MODE_ERROR_CODE });
    const [targetMembership] = await harness.db
      .select()
      .from(mirrorChainMembers)
      .where(eq(mirrorChainMembers.userId, target.id));
    expect(targetMembership?.status).toBe('active');
    expect(
      (
        await harness.db
          .select({ id: mirrorChainOps.id })
          .from(mirrorChainOps)
          .where(eq(mirrorChainOps.chainId, chain.id))
      ).length,
    ).toBe(opCountBefore);
  });

  it('blocks a synced money submit when any active member transition wins first', async () => {
    const owner = await harness.seedUser({
      email: 'submit-owner-principal@bettertrack.test',
      username: 'submit_owner_principal',
    });
    const member = await harness.seedUser({
      email: 'submit-member-principal@bettertrack.test',
      username: 'submit_member_principal',
    });
    const ownerPortfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(owner.id);
    const { chain } = await harness.ctx.mirror.convertToChain(owner.id, ownerPortfolioId);
    await harness.ctx.mirror.attachMemberCopy(chain.id, member.id, { role: 'member' });
    const opCountBefore = (
      await harness.db
        .select({ id: mirrorChainOps.id })
        .from(mirrorChainOps)
        .where(eq(mirrorChainOps.chainId, chain.id))
    ).length;
    const movementCountBefore = (
      await harness.db
        .select({ id: portfolioCashMovements.id })
        .from(portfolioCashMovements)
        .where(eq(portfolioCashMovements.portfolioId, ownerPortfolioId))
    ).length;

    const transition = await startWinningParanoidTransition(member.id);
    const deposit = harness.ctx.mirror.submitCashDeposit(owner.id, ownerPortfolioId, {
      amountEur: 75,
    });
    let settled = false;
    void deposit
      .finally(() => {
        settled = true;
      })
      .catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    await transition.finish();
    await expect(deposit).rejects.toMatchObject({ code: PARANOID_MODE_ERROR_CODE });
    expect(
      (
        await harness.db
          .select({ id: mirrorChainOps.id })
          .from(mirrorChainOps)
          .where(eq(mirrorChainOps.chainId, chain.id))
      ).length,
    ).toBe(opCountBefore);
    expect(
      (
        await harness.db
          .select({ id: portfolioCashMovements.id })
          .from(portfolioCashMovements)
          .where(eq(portfolioCashMovements.portfolioId, ownerPortfolioId))
      ).length,
    ).toBe(movementCountBefore);
  });

  it('filters both directions of an established follow after the counterpart transition wins', async () => {
    const viewer = await harness.seedUser({
      email: 'follow-viewer-race@bettertrack.test',
      username: 'follow_viewer_race',
    });
    const counterpart = await harness.seedUser({
      email: 'follow-counterpart-race@bettertrack.test',
      username: 'follow_counterpart_race',
    });
    await harness.db.insert(userFollows).values([
      { followerId: viewer.id, followedId: counterpart.id },
      { followerId: counterpart.id, followedId: viewer.id },
    ]);

    let releaseModeChange!: () => void;
    let modeChangeLocked!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseModeChange = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      modeChangeLocked = resolve;
    });
    const modeChange = withExclusiveParanoidTransitionTestLock(
      harness.db,
      counterpart.id,
      async () => {
        await setParanoid(counterpart.id);
        modeChangeLocked();
        await release;
      },
    );
    await locked;

    const followingRead = harness.ctx.social.listFollowing(viewer.id);
    const followersRead = harness.ctx.social.listFollowers(viewer.id);
    let settled = 0;
    void followingRead.finally(() => {
      settled += 1;
    });
    void followersRead.finally(() => {
      settled += 1;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(0);

    releaseModeChange();
    await modeChange;
    await expect(followingRead).resolves.toEqual({
      following: [],
      followingCount: 0,
      followerCount: 0,
    });
    await expect(followersRead).resolves.toEqual({ followers: [] });
  });

  it('guards the follow target through preference updates and unfollow mutations', async () => {
    const follower = await harness.seedUser({
      email: 'follow-mutation-viewer@bettertrack.test',
      username: 'follow_mutation_viewer',
    });
    const alreadyParanoid = await harness.seedUser({
      email: 'follow-mutation-paranoid@bettertrack.test',
      username: 'follow_mutation_paranoid',
    });
    const racingTarget = await harness.seedUser({
      email: 'follow-mutation-racing@bettertrack.test',
      username: 'follow_mutation_racing',
    });
    await harness.db.insert(userFollows).values([
      { followerId: follower.id, followedId: alreadyParanoid.id },
      { followerId: follower.id, followedId: racingTarget.id },
    ]);
    await setParanoid(alreadyParanoid.id);

    await expect(
      harness.ctx.social.updateFollow(follower.id, alreadyParanoid.id, {
        autoFollowItems: true,
      }),
    ).rejects.toMatchObject({ code: PARANOID_MODE_ERROR_CODE });
    await expect(
      harness.ctx.social.unfollowUser(follower.id, alreadyParanoid.id),
    ).rejects.toMatchObject({ code: PARANOID_MODE_ERROR_CODE });

    const transition = await startWinningParanoidTransition(racingTarget.id);
    const update = harness.ctx.social.updateFollow(follower.id, racingTarget.id, {
      notifyOnAlertFire: true,
    });
    const unfollow = harness.ctx.social.unfollowUser(follower.id, racingTarget.id);
    let settled = 0;
    for (const mutation of [update, unfollow]) {
      void mutation
        .finally(() => {
          settled += 1;
        })
        .catch(() => undefined);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(0);

    await transition.finish();
    await expect(update).rejects.toMatchObject({ code: PARANOID_MODE_ERROR_CODE });
    await expect(unfollow).rejects.toMatchObject({ code: PARANOID_MODE_ERROR_CODE });
    const rows = await harness.db
      .select()
      .from(userFollows)
      .where(eq(userFollows.followerId, follower.id));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.autoFollowItems === false)).toBe(true);
    expect(rows.every((row) => row.notifyOnAlertFire === false)).toBe(true);
  });

  it('filters comments and reaction actors after a winning author transition', async () => {
    const owner = await harness.seedUser({
      email: 'thread-owner-race@bettertrack.test',
      username: 'thread_owner_race',
    });
    const viewer = await harness.seedUser({
      email: 'thread-viewer-race@bettertrack.test',
      username: 'thread_viewer_race',
    });
    const author = await harness.seedUser({
      email: 'thread-author-race@bettertrack.test',
      username: 'thread_author_race',
    });
    for (const friendId of [viewer.id, author.id]) {
      const [userA, userB] = owner.id < friendId ? [owner.id, friendId] : [friendId, owner.id];
      await harness.db.insert(friendships).values({ userA, userB });
    }
    const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(owner.id);
    await harness.ctx.social.setAudience(owner.id, 'portfolio', portfolioId, {
      audience: 'all_friends',
    });
    const visibleComment = await harness.ctx.comments.addComment(
      viewer.id,
      'portfolio',
      portfolioId,
      'visible comment',
    );
    await harness.ctx.comments.addComment(
      author.id,
      'portfolio',
      portfolioId,
      'private author comment',
    );
    await harness.ctx.comments.toggleItemReaction(viewer.id, 'portfolio', portfolioId, '🔥');
    await harness.ctx.comments.toggleItemReaction(author.id, 'portfolio', portfolioId, '🔥');
    await harness.ctx.comments.toggleCommentReaction(viewer.id, visibleComment.id, '👍');
    await harness.ctx.comments.toggleCommentReaction(author.id, visibleComment.id, '👍');

    const transition = await startWinningParanoidTransition(author.id);
    const threadRead = harness.ctx.comments.getThread(viewer.id, 'portfolio', portfolioId);
    let settled = false;
    void threadRead
      .finally(() => {
        settled = true;
      })
      .catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    await transition.finish();
    const thread = await threadRead;
    expect(thread.commentCount).toBe(1);
    expect(thread.comments.map((comment) => comment.body)).toEqual(['visible comment']);
    expect(thread.comments[0]?.reactions).toEqual([{ emoji: '👍', count: 1, reacted: true }]);
    expect(thread.reactions).toEqual([{ emoji: '🔥', count: 1, reacted: true }]);
  });

  it('guards comment authors and filters item reaction responses across winning transitions', async () => {
    const owner = await harness.seedUser({
      email: 'reaction-owner-race@bettertrack.test',
      username: 'reaction_owner_race',
    });
    const viewer = await harness.seedUser({
      email: 'reaction-viewer-race@bettertrack.test',
      username: 'reaction_viewer_race',
    });
    const author = await harness.seedUser({
      email: 'reaction-author-race@bettertrack.test',
      username: 'reaction_author_race',
    });
    const reactor = await harness.seedUser({
      email: 'reaction-reactor-race@bettertrack.test',
      username: 'reaction_reactor_race',
    });
    for (const friendId of [viewer.id, author.id, reactor.id]) {
      const [userA, userB] = owner.id < friendId ? [owner.id, friendId] : [friendId, owner.id];
      await harness.db.insert(friendships).values({ userA, userB });
    }
    const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(owner.id);
    await harness.ctx.social.setAudience(owner.id, 'portfolio', portfolioId, {
      audience: 'all_friends',
    });
    const comment = await harness.ctx.comments.addComment(
      author.id,
      'portfolio',
      portfolioId,
      'transition-owned comment',
    );
    await harness.ctx.comments.toggleItemReaction(reactor.id, 'portfolio', portfolioId, '🔥');

    const authorTransition = await startWinningParanoidTransition(author.id);
    const commentReaction = harness.ctx.comments.toggleCommentReaction(viewer.id, comment.id, '👍');
    let commentSettled = false;
    void commentReaction
      .finally(() => {
        commentSettled = true;
      })
      .catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(commentSettled).toBe(false);

    await authorTransition.finish();
    await expect(commentReaction).rejects.toMatchObject({ code: PARANOID_MODE_ERROR_CODE });
    expect(
      (
        await harness.db.select().from(itemReactions).where(eq(itemReactions.userId, viewer.id))
      ).filter((row) => row.commentId === comment.id),
    ).toEqual([]);

    const reactorTransition = await startWinningParanoidTransition(reactor.id);
    const itemReaction = harness.ctx.comments.toggleItemReaction(
      viewer.id,
      'portfolio',
      portfolioId,
      '🔥',
    );
    let itemSettled = false;
    void itemReaction
      .finally(() => {
        itemSettled = true;
      })
      .catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(itemSettled).toBe(false);

    await reactorTransition.finish();
    await expect(itemReaction).resolves.toEqual({
      reactions: [{ emoji: '🔥', count: 1, reacted: true }],
    });
  });

  it('serializes mixed asset/search/earnings reads and keeps only global or watched data', async () => {
    harness = await createTestApp({
      marketData: createStubMarketData({
        search: () => [],
        quote: () => ({
          value: {
            price: 100,
            currency: 'EUR',
            prevClose: 99,
            dayChangePct: 1,
            asOf: '2026-07-27T12:00:00.000Z',
          },
          stale: false,
          asOf: Date.parse('2026-07-27T12:00:00.000Z'),
        }),
        earnings: () => cachedIntel(sampleEarningsEvents()),
      }),
    });
    const user = await harness.seedUser({
      email: 'mixed-reader-race@bettertrack.test',
      username: 'mixed_reader_race',
    });
    const login = await request(harness.app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: user.email, password: user.password });
    expect(login.status).toBe(200);
    const cookies = login.get('Set-Cookie') ?? [];
    const [globalAsset, heldOnlyAsset, watchedAsset, customAsset] = await harness.db
      .insert(assets)
      .values([
        {
          providerId: 'yahoo',
          providerRef: 'RACE-GLOBAL',
          type: 'stock',
          symbol: 'GLOBAL',
          name: 'Race Global',
          currency: 'EUR',
        },
        {
          providerId: 'yahoo',
          providerRef: 'RACE-HELD',
          type: 'stock',
          symbol: 'HELD',
          name: 'Race Held',
          currency: 'EUR',
        },
        {
          providerId: 'yahoo',
          providerRef: 'RACE-WATCHED',
          type: 'stock',
          symbol: 'WATCH',
          name: 'Race Watched',
          currency: 'EUR',
        },
        {
          providerId: 'manual',
          providerRef: `race-house:${user.id}`,
          ownerId: user.id,
          type: 'custom',
          symbol: 'HOUSE',
          name: 'Race House',
          currency: 'EUR',
        },
      ])
      .returning();
    const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(user.id);
    await harness.db.insert(transactions).values([
      {
        portfolioId,
        assetId: heldOnlyAsset!.id,
        side: 'buy',
        quantity: '1',
        price: '10',
        executedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        portfolioId,
        assetId: watchedAsset!.id,
        side: 'buy',
        quantity: '2',
        price: '20',
        executedAt: new Date('2026-01-02T00:00:00.000Z'),
      },
    ]);
    const [watchlist] = await harness.db
      .insert(watchlists)
      .values({ userId: user.id, name: 'General', isDefault: true })
      .returning();
    await harness.db.insert(workboardItems).values({
      userId: user.id,
      watchlistId: watchlist!.id,
      assetId: watchedAsset!.id,
      sortOrder: 0,
    });

    let releaseModeChange!: () => void;
    let modeChangeLocked!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseModeChange = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      modeChangeLocked = resolve;
    });
    const modeChange = withExclusiveParanoidTransitionTestLock(harness.db, user.id, async () => {
      await setParanoid(user.id);
      modeChangeLocked();
      await release;
    });
    await locked;

    // Global market data has no account owner and remains immediately usable
    // even while this account's transition lock is held.
    await expect(harness.ctx.assets.getDetail(user.id, globalAsset!.id)).resolves.toMatchObject({
      asset: { symbol: 'GLOBAL', isCustom: false },
    });

    const directCustom = harness.ctx.assets.getDetail(user.id, customAsset!.id);
    const routeCustom = request(harness.app)
      .get(`/api/v1/assets/${customAsset!.id}`)
      .set('Cookie', cookies)
      .then((response) => response);
    const directCustomIntel = harness.ctx.marketIntel.capabilities(user.id, customAsset!.id);
    const routeCustomIntel = request(harness.app)
      .get(`/api/v1/assets/${customAsset!.id}/intel`)
      .set('Cookie', cookies)
      .then((response) => response);
    const directSearch = harness.ctx.search.search(user.id, 'race');
    const routeSearch = request(harness.app)
      .get('/api/v1/search?q=race')
      .set('Cookie', cookies)
      .then((response) => response);
    const directCalendar = harness.ctx.marketIntel.earningsCalendar(user.id);
    const routeCalendar = request(harness.app)
      .get('/api/v1/assets/intel/earnings-calendar')
      .set('Cookie', cookies)
      .then((response) => response);
    let settled = 0;
    for (const promise of [
      directCustom.catch(() => undefined),
      routeCustom,
      directCustomIntel.catch(() => undefined),
      routeCustomIntel,
      directSearch,
      routeSearch,
      directCalendar,
      routeCalendar,
    ]) {
      void promise.finally(() => {
        settled += 1;
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(0);

    releaseModeChange();
    await modeChange;
    await expect(directCustom).rejects.toMatchObject({
      statusCode: 404,
      code: 'ASSET_NOT_FOUND',
    });
    expect((await routeCustom).status).toBe(404);
    await expect(directCustomIntel).rejects.toMatchObject({
      statusCode: 404,
      code: 'ASSET_NOT_FOUND',
    });
    expect((await routeCustomIntel).status).toBe(404);
    const assertSearch = (result: { results: Array<{ symbol: string; isCustom: boolean }> }) => {
      expect(result.results.map((row) => row.symbol).sort()).toEqual(['GLOBAL', 'HELD', 'WATCH']);
      expect(result.results.every((row) => row.isCustom === false)).toBe(true);
    };
    assertSearch(await directSearch);
    const searchResponse = await routeSearch;
    expect(searchResponse.status).toBe(200);
    assertSearch(searchResponse.body);

    const assertCalendar = (result: {
      entries: Array<{ symbol: string; held: boolean; watched: boolean }>;
    }) => {
      expect(result.entries).toEqual([
        expect.objectContaining({
          symbol: 'WATCH',
          held: false,
          watched: true,
        }),
      ]);
    };
    assertCalendar(await directCalendar);
    const calendarResponse = await routeCalendar;
    expect(calendarResponse.status).toBe(200);
    assertCalendar(calendarResponse.body);
    expect((await harness.ctx.assets.getDetail(user.id, globalAsset!.id)).asset.symbol).toBe(
      'GLOBAL',
    );
  });

  it('keeps mixed workboard, alert, preview, and compare rails global-only across a winning transition', async () => {
    const now = Date.now();
    const marketData = createStubMarketData({
      history: () => ({
        value: [
          { time: new Date(now - 2 * 86_400_000).toISOString(), close: 100 },
          { time: new Date(now - 86_400_000).toISOString(), close: 110 },
        ],
        stale: false,
        asOf: now,
      }),
    });
    harness = await createTestApp({ marketData });
    const user = await harness.seedUser({
      email: 'mixed-provenance-race@bettertrack.test',
      username: 'mixed_provenance_race',
    });
    const agent = await loginAgent(harness.app, user.email, user.password);
    const [globalA, globalB, customExisting, customBlocked] = await harness.db
      .insert(assets)
      .values([
        {
          providerId: 'yahoo',
          providerRef: 'MIXED-GLOBAL-A',
          type: 'stock',
          symbol: 'GLOBAL-A',
          name: 'Global A',
          currency: 'EUR',
        },
        {
          providerId: 'yahoo',
          providerRef: 'MIXED-GLOBAL-B',
          type: 'stock',
          symbol: 'GLOBAL-B',
          name: 'Global B',
          currency: 'EUR',
        },
        {
          providerId: 'manual',
          providerRef: `mixed-existing:${user.id}`,
          ownerId: user.id,
          type: 'custom',
          symbol: 'PRIVATE-EXISTING',
          name: 'Private Existing',
          currency: 'EUR',
        },
        {
          providerId: 'manual',
          providerRef: `mixed-blocked:${user.id}`,
          ownerId: user.id,
          type: 'custom',
          symbol: 'PRIVATE-BLOCKED',
          name: 'Private Blocked',
          currency: 'EUR',
        },
      ])
      .returning();
    const [defaultWatchlist] = await harness.db
      .insert(watchlists)
      .values({ userId: user.id, name: 'General', isDefault: true })
      .returning();
    await harness.db.insert(workboardItems).values([
      {
        userId: user.id,
        watchlistId: defaultWatchlist!.id,
        assetId: globalA!.id,
        sortOrder: 0,
      },
      {
        userId: user.id,
        watchlistId: defaultWatchlist!.id,
        assetId: customExisting!.id,
        sortOrder: 1,
      },
    ]);
    await harness.ctx.social.setAudience(user.id, 'watchlist', defaultWatchlist!.id, {
      audience: 'all_friends',
    });
    const [globalAlert, customAlert] = await harness.db
      .insert(alerts)
      .values([
        {
          userId: user.id,
          assetId: globalA!.id,
          kind: 'price_above',
          threshold: '150',
          refPrice: null,
          repeat: false,
          status: 'active',
        },
        {
          userId: user.id,
          assetId: customExisting!.id,
          kind: 'price_above',
          threshold: '160',
          refPrice: null,
          repeat: false,
          status: 'active',
        },
      ])
      .returning();
    const globalOne = await harness.ctx.conglomerate.create(user.id, { name: 'Global one' });
    const globalTwo = await harness.ctx.conglomerate.create(user.id, { name: 'Global two' });
    const privateOne = await harness.ctx.conglomerate.create(user.id, { name: 'Private one' });
    await harness.ctx.conglomerate.replacePositions(user.id, globalOne.id, [
      { assetId: globalA!.id, weightPct: 100 },
    ]);
    await harness.ctx.conglomerate.replacePositions(user.id, globalTwo.id, [
      { assetId: globalB!.id, weightPct: 100 },
    ]);
    await harness.ctx.conglomerate.replacePositions(user.id, privateOne.id, [
      { assetId: customExisting!.id, weightPct: 100 },
    ]);

    const previewInput = {
      positions: [{ assetId: customExisting!.id, weight: 100 }],
      range: 'MAX' as const,
    };
    const compareInput = {
      conglomerateIds: [privateOne.id, globalOne.id],
      range: 'MAX' as const,
    };
    const expectPending = async (pending: Array<PromiseLike<unknown>>) => {
      let settled = 0;
      for (const promise of pending) {
        void Promise.resolve(promise)
          .finally(() => {
            settled += 1;
          })
          .catch(() => undefined);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(0);
    };
    const resetNormal = async () => {
      await harness.db
        .update(users)
        .set({
          privacyMode: 'normal',
          paranoidMediaSet: null,
          paranoidDriveAttestedVersion: null,
        })
        .where(eq(users.id, user.id));
    };

    const workboardTransition = await startWinningParanoidTransition(user.id);
    const directWorkboard = harness.ctx.workboard.list(user.id);
    const directWatchlist = harness.ctx.workboard.listInWatchlist(user.id, defaultWatchlist!.id);
    const routeWorkboard = agent.get('/api/v1/workboard').then((response) => response);
    const directWatchlists = harness.ctx.workboard.listWatchlists(user.id);
    const routeWatchlists = agent.get('/api/v1/workboard/watchlists').then((response) => response);
    const directWorkboardAdd = harness.ctx.workboard.addItem(user.id, customBlocked!.id);
    const routeWorkboardAdd = agent
      .post('/api/v1/workboard')
      .set(...XRW)
      .send({ assetId: customBlocked!.id })
      .then((response) => response);
    await expectPending([
      directWorkboard,
      directWatchlist,
      routeWorkboard,
      directWatchlists,
      routeWatchlists,
      directWorkboardAdd,
      routeWorkboardAdd,
    ]);
    await workboardTransition.finish();
    for (const result of [await directWorkboard, await directWatchlist]) {
      expect(result.map((item) => item.asset.symbol)).toEqual(['GLOBAL-A']);
    }
    expect((await routeWorkboard).status).toBe(200);
    expect(
      (await routeWorkboard).body.items.map(
        (item: { asset: { symbol: string } }) => item.asset.symbol,
      ),
    ).toEqual(['GLOBAL-A']);
    expect(await directWatchlists).toEqual([
      expect.objectContaining({ id: defaultWatchlist!.id, itemCount: 1, audience: 'private' }),
    ]);
    expect((await routeWatchlists).body).toEqual({
      watchlists: [
        expect.objectContaining({ id: defaultWatchlist!.id, itemCount: 1, audience: 'private' }),
      ],
    });
    await expect(directWorkboardAdd).rejects.toMatchObject({
      statusCode: 404,
      code: 'ASSET_NOT_FOUND',
    });
    expect((await routeWorkboardAdd).status).toBe(404);

    await resetNormal();
    const alertTransition = await startWinningParanoidTransition(user.id);
    const directAlertList = harness.ctx.alerts.list(user.id);
    const routeAlertList = agent.get('/api/v1/alerts').then((response) => response);
    const directAlertCreate = harness.ctx.alerts.create(user.id, {
      assetId: customBlocked!.id,
      kind: 'price_above',
      threshold: 170,
    });
    const routeAlertCreate = agent
      .post('/api/v1/alerts')
      .set(...XRW)
      .send({ assetId: customBlocked!.id, kind: 'price_above', threshold: 170 })
      .then((response) => response);
    const directAlertUpdate = harness.ctx.alerts.update(user.id, customAlert!.id, {
      threshold: 999,
    });
    const routeAlertRearm = agent
      .post(`/api/v1/alerts/${customAlert!.id}/rearm`)
      .set(...XRW)
      .then((response) => response);
    await expectPending([
      directAlertList,
      routeAlertList,
      directAlertCreate,
      routeAlertCreate,
      directAlertUpdate,
      routeAlertRearm,
    ]);
    await alertTransition.finish();
    expect((await directAlertList).map((alert) => alert.id)).toEqual([globalAlert!.id]);
    const alertListResponse = await routeAlertList;
    expect(alertListResponse.status).toBe(200);
    expect(alertListResponse.body.items.map((alert: { id: string }) => alert.id)).toEqual([
      globalAlert!.id,
    ]);
    await expect(directAlertCreate).rejects.toMatchObject({
      statusCode: 404,
      code: 'ASSET_NOT_FOUND',
    });
    expect((await routeAlertCreate).status).toBe(404);
    await expect(directAlertUpdate).rejects.toMatchObject({
      statusCode: 404,
      code: 'ALERT_NOT_FOUND',
    });
    expect((await routeAlertRearm).status).toBe(404);

    await resetNormal();
    const backtestTransition = await startWinningParanoidTransition(user.id);
    const directPreview = harness.ctx.backtest.runPreview(user.id, previewInput);
    const routePreview = agent
      .post('/api/v1/backtest/preview')
      .set(...XRW)
      .send(previewInput)
      .then((response) => response);
    const directCompare = harness.ctx.backtest.runComparison(user.id, compareInput);
    const routeCompare = agent
      .post('/api/v1/backtest/compare')
      .set(...XRW)
      .send(compareInput)
      .then((response) => response);
    await expectPending([directPreview, routePreview, directCompare, routeCompare]);
    await backtestTransition.finish();
    for (const blocked of [directPreview, directCompare]) {
      await expect(blocked).rejects.toMatchObject({
        statusCode: 404,
        code: 'ASSET_NOT_FOUND',
      });
    }
    expect((await routePreview).status).toBe(404);
    expect((await routeCompare).status).toBe(404);
    expect(marketData.calls.history).toBe(0);
    expect(
      (
        await harness.db
          .select()
          .from(workboardItems)
          .where(eq(workboardItems.assetId, customBlocked!.id))
      ).length,
    ).toBe(0);
    expect(
      (await harness.db.select().from(alerts).where(eq(alerts.assetId, customBlocked!.id))).length,
    ).toBe(0);
    expect(
      (await harness.db.select().from(alerts).where(eq(alerts.id, customAlert!.id)))[0]?.threshold,
    ).toBe('160');

    await expect(harness.ctx.workboard.addItem(user.id, globalB!.id)).resolves.toMatchObject({
      asset: { symbol: 'GLOBAL-B' },
    });
    const globalAlertCreate = await agent
      .post('/api/v1/alerts')
      .set(...XRW)
      .send({ assetId: globalB!.id, kind: 'price_above', threshold: 180 });
    expect(globalAlertCreate.status).toBe(201);
    await expect(
      harness.ctx.backtest.runPreview(user.id, {
        positions: [{ assetId: globalA!.id, weight: 100 }],
        range: 'MAX',
      }),
    ).resolves.toMatchObject({ benchmark: null });
    const globalCompare = await agent
      .post('/api/v1/backtest/compare')
      .set(...XRW)
      .send({ conglomerateIds: [globalOne.id, globalTwo.id], range: 'MAX' });
    expect(globalCompare.status).toBe(200);
  });

  it('serializes owner-derived public, shared-sandbox, and followed-item reads', async () => {
    const owner = await harness.seedUser({
      email: 'owner-race@bettertrack.test',
      username: 'owner_race',
    });
    const viewer = await harness.seedUser({
      email: 'viewer-race@bettertrack.test',
      username: 'viewer_race',
    });
    await harness.ctx.social.updateProfileSettings(owner.id, {
      isPublic: true,
      acknowledgePublic: true,
    });
    const [userA, userB] = [owner.id, viewer.id].sort();
    await harness.db.insert(friendships).values({ userA: userA!, userB: userB! });
    const [basket] = await harness.db
      .insert(conglomerates)
      .values({ ownerId: owner.id, name: 'Race basket', status: 'draft' })
      .returning();
    await harness.ctx.social.setAudience(owner.id, 'conglomerate', basket!.id, {
      audience: 'all_friends',
    });
    await harness.ctx.social.followItem(viewer.id, 'conglomerate', basket!.id);
    const [publicBasket] = await harness.db
      .insert(conglomerates)
      .values({ ownerId: owner.id, name: 'Public race basket', status: 'draft' })
      .returning();
    const publicAudience = await harness.ctx.social.setAudience(
      owner.id,
      'conglomerate',
      publicBasket!.id,
      {
        audience: 'public_link',
        acknowledgePublic: true,
      },
    );
    const publicToken = publicAudience.link?.token;
    expect(publicToken).toBeTruthy();
    const { idea } = await harness.ctx.ideas.create(owner.id, {
      name: 'Shared race idea',
      state: {
        source: { kind: 'adhoc', positions: [] },
        range: '3Y',
        benchmark: { preset: '^GSPC' },
        mode: 'cash',
        rebalance: 'quarterly',
      },
    });
    await harness.ctx.social.setAudience(owner.id, 'idea', idea.id, {
      audience: 'all_friends',
    });
    const conversation = await harness.ctx.chat.openConversation(owner.id, viewer.id);
    await harness.ctx.chat.sendMessage(owner.id, conversation.id, {
      chip: { kind: 'idea', subjectId: idea.id },
    });

    let releaseModeChange!: () => void;
    let modeChangeLocked!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseModeChange = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      modeChangeLocked = resolve;
    });
    const modeChange = withExclusiveParanoidTransitionTestLock(harness.db, owner.id, async () => {
      await setParanoid(owner.id);
      modeChangeLocked();
      await release;
    });
    await locked;

    const profileRead = request(harness.app)
      .get(`/api/v1/social/profiles/${owner.username}`)
      .then((response) => response);
    const publicLinkRead = request(harness.app)
      .get(`/api/v1/social/links/${publicToken!}`)
      .then((response) => response);
    const sharedItemRead = harness.ctx.social.getSharedConglomerate(viewer.id, basket!.id);
    const sandboxRead = harness.ctx.backtest.runSharedSandboxPreview(viewer.id, {
      conglomerateId: basket!.id,
      positions: [],
      range: '1Y',
    });
    const followedRead = harness.ctx.social.listItemFollows(viewer.id);
    const cloneRead = harness.ctx.ideas.clone(viewer.id, idea.id);
    const chatRead = harness.ctx.chat.getThread(viewer.id, conversation.id, {});
    let settled = 0;
    void profileRead.finally(() => {
      settled += 1;
    });
    void publicLinkRead.finally(() => {
      settled += 1;
    });
    void sharedItemRead
      .catch(() => undefined)
      .finally(() => {
        settled += 1;
      });
    void sandboxRead
      .catch(() => undefined)
      .finally(() => {
        settled += 1;
      });
    void followedRead.finally(() => {
      settled += 1;
    });
    void cloneRead
      .catch(() => undefined)
      .finally(() => {
        settled += 1;
      });
    void chatRead.finally(() => {
      settled += 1;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(0);

    releaseModeChange();
    await modeChange;
    expect((await profileRead).status).toBe(404);
    expect((await publicLinkRead).status).toBe(404);
    await expect(sharedItemRead).rejects.toMatchObject({ code: PARANOID_MODE_ERROR_CODE });
    await expect(sandboxRead).rejects.toMatchObject({ code: PARANOID_MODE_ERROR_CODE });
    await expect(followedRead).resolves.toEqual({
      items: [
        expect.objectContaining({
          kind: 'conglomerate',
          subjectId: basket!.id,
          viewable: false,
          name: null,
          owner: null,
        }),
      ],
    });
    await expect(cloneRead).rejects.toMatchObject({ code: PARANOID_MODE_ERROR_CODE });
    await expect(harness.ctx.ideas.list(viewer.id)).resolves.toEqual({ ideas: [] });
    await expect(chatRead).resolves.toMatchObject({
      messages: [
        {
          chip: {
            kind: 'idea',
            subjectId: idea.id,
            viewable: false,
            title: null,
            subtitle: null,
          },
        },
      ],
    });
  });
});
