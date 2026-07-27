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
  });
});
