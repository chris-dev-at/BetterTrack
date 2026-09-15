import { randomUUID } from 'node:crypto';

import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FEATURE_FLAG_KEYS, featureFlagsResponseSchema } from '@bettertrack/contracts';

import { createAlertRepository } from '../data/repositories/alertRepository';
import { createAppSettingsRepository } from '../data/repositories/appSettingsRepository';
import * as schema from '../data/schema';
import { createAlertsEvaluateJob, createDeadLetter, runJobDefinition } from '../jobs';
import type { JobContext } from '../jobs';
import type { Logger } from '../logger';
import { alertFireLockKey, alertFireWindowStart } from '../services/alerts/alertEvaluator';
import {
  createFeatureFlagService,
  FEATURE_FLAG_CACHE_KEY,
  FEATURE_FLAG_CONFIG_UNREADABLE,
  FEATURE_FLAG_GENERATION_KEY,
  FEATURE_FLAG_PROPAGATION_UNCONFIRMED,
} from '../services/featureFlags/featureFlagService';
import type { DispatchableEvent } from '../services/notifications/notificationDispatcher';
import type { NotificationCenter } from '../services/notifications/notificationCenter';
import { createTestApp, type TestHarness } from '../testing/createTestApp';
import { createStubMarketData } from '../testing/marketDataStubs';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

afterEach(() => {
  // ioredis-mock/PGlite are torn down by the harness lifecycle.
  vi.restoreAllMocks();
});

/** Loosely-typed handle on the harness Redis, so a single key can be broken. */
type SpyableRedis = {
  del: (...args: unknown[]) => Promise<unknown>;
  set: (...args: unknown[]) => Promise<unknown>;
  incr: (...args: unknown[]) => Promise<unknown>;
};

/**
 * Break exactly the snapshot key's `del` (and optionally the generation key's
 * `incr`), leaving every other Redis call — sessions, rate limits — working.
 * Returns nothing: `vi.restoreAllMocks()` in `afterEach` puts the client back.
 *
 * The generation bump IS the propagation since #1847, which is why it is the
 * knob the 503 case turns: a failed DEL leaves a snapshot that no reader will
 * serve, while a failed bump is the one outcome after which running instances
 * really may keep the old value.
 */
function breakSnapshotWrites(options: { generation: boolean }): void {
  const redis = harness.ctx.redis as unknown as SpyableRedis;
  const realDel = redis.del.bind(redis);
  const realIncr = redis.incr.bind(redis);
  vi.spyOn(redis, 'del').mockImplementation(async (...args: unknown[]) => {
    if (args[0] === FEATURE_FLAG_CACHE_KEY) throw new Error('redis unavailable (del)');
    return realDel(...args);
  });
  if (!options.generation) return;
  vi.spyOn(redis, 'incr').mockImplementation(async (...args: unknown[]) => {
    if (args[0] === FEATURE_FLAG_GENERATION_KEY) throw new Error('redis unavailable (incr)');
    return realIncr(...args);
  });
}

type Agent = ReturnType<typeof request.agent>;

async function loginUser(): Promise<Agent> {
  const seeded = await harness.seedUser({ email: 'flags-user@bt.test', username: 'flagsuser' });
  const agent = request.agent(harness.app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier: seeded.email, password: seeded.password });
  expect(res.status).toBe(200);
  return agent;
}

describe('feature-flag advertisement (§13.5 V5-P2 arc (c))', () => {
  it('defaults every flag ON with no stored rows', async () => {
    const res = await request(harness.app).get('/api/v1/feature-flags');
    expect(res.status).toBe(200);
    for (const key of FEATURE_FLAG_KEYS) {
      expect(res.body.flags[key]).toBe(true);
    }
  });

  it('advertises the effective flags — a killed feature reads false', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    await adminAgent
      .patch('/api/v1/admin/feature-flags/chat')
      .set(...XRW)
      .send({ enabled: false })
      .expect(200);

    const res = await request(harness.app).get('/api/v1/feature-flags');
    expect(res.body.flags.chat).toBe(false);
    expect(res.body.flags.alerts).toBe(true);
  });

  it('advertises the deploy-time market-intel capability so the SPA can hide its destinations', async () => {
    // Configured (the default): the News tab + palette entry are offered.
    const on = await request(harness.app).get('/api/v1/feature-flags');
    expect(on.status).toBe(200);
    expect(featureFlagsResponseSchema.safeParse(on.body).success).toBe(true);
    expect(on.body.capabilities).toEqual({ marketIntel: true });

    // Unconfigured: the same read reports it OFF — the client's only way to
    // learn a deploy-level gate it can never toggle.
    const off = await createTestApp({ env: { MARKET_INTEL_ENABLED: 'false' } });
    const res = await request(off.app).get('/api/v1/feature-flags');
    expect(res.status).toBe(200);
    expect(res.body.capabilities.marketIntel).toBe(false);
    // …and it is NOT an admin runtime kill-switch: the registry is untouched.
    expect(Object.keys(res.body.flags).sort()).toEqual([...FEATURE_FLAG_KEYS].sort());
  });
});

describe('gated routers refuse a killed feature at request time', () => {
  it('chat/alerts/imports are reachable by default', async () => {
    const user = await loginUser();
    expect((await user.get('/api/v1/chat/conversations')).status).toBe(200);
    expect((await user.get('/api/v1/alerts')).status).toBe(200);
    expect((await user.get('/api/v1/imports/brokers')).status).toBe(200);
  });

  it('flipping chat OFF makes the chat routes 404 on the very next request — no redeploy', async () => {
    const user = await loginUser();
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);

    expect((await user.get('/api/v1/chat/conversations')).status).toBe(200);

    const flip = await adminAgent
      .patch('/api/v1/admin/feature-flags/chat')
      .set(...XRW)
      .send({ enabled: false });
    expect(flip.status).toBe(200);
    expect(flip.body.flags.find((f: { key: string }) => f.key === 'chat').enabled).toBe(false);

    // Immediately — same process, no restart — the guard refuses.
    const refused = await user.get('/api/v1/chat/conversations');
    expect(refused.status).toBe(404);
    expect(refused.body.error?.code).toBe('FEATURE_DISABLED');

    // A non-gated router is untouched.
    expect((await user.get('/api/v1/alerts')).status).toBe(200);
  });

  it('re-enabling a feature restores it on the next request (cache invalidation)', async () => {
    const user = await loginUser();
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);

    await adminAgent
      .patch('/api/v1/admin/feature-flags/imports')
      .set(...XRW)
      .send({ enabled: false })
      .expect(200);
    expect((await user.get('/api/v1/imports/brokers')).status).toBe(404);

    await adminAgent
      .patch('/api/v1/admin/feature-flags/imports')
      .set(...XRW)
      .send({ enabled: true })
      .expect(200);
    expect((await user.get('/api/v1/imports/brokers')).status).toBe(200);
  });
});

describe('admin toggle surface', () => {
  it('lists every flag with metadata (enabled by default)', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    const res = await adminAgent.get('/api/v1/admin/feature-flags');
    expect(res.status).toBe(200);
    const keys = res.body.flags.map((f: { key: string }) => f.key);
    expect(keys).toEqual([...FEATURE_FLAG_KEYS]);
    for (const flag of res.body.flags) {
      expect(flag.enabled).toBe(true);
      expect(flag.updatedAt).toBeNull();
    }
  });

  it('a toggle is audit-logged and stamps updatedAt/updatedBy', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);

    await adminAgent
      .patch('/api/v1/admin/feature-flags/alerts')
      .set(...XRW)
      .send({ enabled: false })
      .expect(200);

    const list = await adminAgent.get('/api/v1/admin/feature-flags');
    const alerts = list.body.flags.find((f: { key: string }) => f.key === 'alerts');
    expect(alerts.enabled).toBe(false);
    expect(alerts.updatedAt).not.toBeNull();
    expect(alerts.updatedBy).toBe(admin.id);

    const audit = await adminAgent.get('/api/v1/admin/audit');
    const actions = audit.body.entries.map((e: { action: string }) => e.action);
    expect(actions).toContain('feature_flag.changed');
  });

  it('rejects an unknown flag key', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    const res = await adminAgent
      .patch('/api/v1/admin/feature-flags/not-a-flag')
      .set(...XRW)
      .send({ enabled: false });
    expect(res.status).toBe(400);
  });

  it('is fenced to admins — a non-admin 404s (no leak)', async () => {
    const user = await loginUser();
    expect((await user.get('/api/v1/admin/feature-flags')).status).toBe(404);
    const patch = await user
      .patch('/api/v1/admin/feature-flags/chat')
      .set(...XRW)
      .send({ enabled: false });
    expect(patch.status).toBe(404);

    // And an anonymous caller gets the same 404 — requireAdmin discloses nothing.
    expect((await request(harness.app).get('/api/v1/admin/feature-flags')).status).toBe(404);
  });
});

/**
 * A kill switch is pulled to stop something already in progress, so a flip whose
 * propagation could not be confirmed must not be reported as a clean flip
 * (#1744). The snapshot has a TTL backstop, but "it may or may not have taken
 * effect, and we won't tell you" is the wrong answer to give an admin.
 */
describe('a flip whose propagation cannot be confirmed is not reported as clean', () => {
  it('still propagates when the snapshot DEL fails — still 200, still effective at once', async () => {
    // #1847: the DEL is housekeeping now, not the invalidation. The generation
    // bump landed, so the snapshot left behind is one no reader will serve.
    const user = await loginUser();
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);

    expect((await user.get('/api/v1/chat/conversations')).status).toBe(200);
    breakSnapshotWrites({ generation: false });

    const flip = await adminAgent
      .patch('/api/v1/admin/feature-flags/chat')
      .set(...XRW)
      .send({ enabled: false });
    expect(flip.status).toBe(200);
    expect(flip.body.flags.find((f: { key: string }) => f.key === 'chat').enabled).toBe(false);

    // The bump propagated exactly like the DEL would have: next request refuses.
    const refused = await user.get('/api/v1/chat/conversations');
    expect(refused.status).toBe(404);
    expect(refused.body.error?.code).toBe('FEATURE_DISABLED');
  });

  it('surfaces 503 when the generation bump does not land — and still persists the value', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    breakSnapshotWrites({ generation: true });

    const flip = await adminAgent
      .patch('/api/v1/admin/feature-flags/imports')
      .set(...XRW)
      .send({ enabled: false });
    expect(flip.status).toBe(503);
    expect(flip.body.error?.code).toBe(FEATURE_FLAG_PROPAGATION_UNCONFIRMED);
    // The admin is told what IS true: saved, propagation unconfirmed.
    expect(flip.body.error?.message).toMatch(/saved/i);

    // The persisted row is correct regardless — the failure was propagation only.
    vi.restoreAllMocks();
    const list = await adminAgent.get('/api/v1/admin/feature-flags');
    const imports = list.body.flags.find((f: { key: string }) => f.key === 'imports');
    expect(imports.enabled).toBe(false);
    expect(imports.updatedBy).toBe(admin.id);

    // And the unconfirmed flip is in the audit log, marked as such.
    const audit = await adminAgent.get('/api/v1/admin/audit');
    const entry = audit.body.entries.find(
      (e: { action: string; meta?: { key?: string; propagated?: boolean } }) =>
        e.action === 'feature_flag.changed' && e.meta?.key === 'imports',
    );
    expect(entry?.meta?.propagated).toBe(false);
  });

  it('cannot be reverted by a cache-aside read that began before the flip', async () => {
    // The kill switch's whole point is stopping something in progress, and the
    // window is widest right after an invalidation, when many requests miss the
    // cache at once. One of those reads used to load `chat: true` from the
    // store, sit through the admin's flip, and then publish its stale snapshot
    // under a 60 s TTL — so `requireFeature('chat')` kept serving the killed
    // feature for a full minute while the flip was audited as propagated
    // (#1847).
    const admin = await harness.seedAdmin();
    const store = createAppSettingsRepository(harness.db);
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let readPreFlip: (() => void) | undefined;
    const storeRead = new Promise<void>((resolve) => {
      readPreFlip = resolve;
    });
    let holdNextRead = true;
    const reader = createFeatureFlagService({
      repo: {
        ...store,
        async getAll() {
          const rows = await store.getAll();
          if (holdNextRead) {
            holdNextRead = false;
            readPreFlip!(); // the rows in hand are the PRE-flip ones …
            await held; // … and the flip lands before this read resolves
          }
          return rows;
        },
      },
      redis: harness.ctx.redis,
      // This instance only ever READS; the flip below goes through the wired
      // service, exactly as a second process would see it.
      audit: { record: async () => {} } as never,
      logger: harness.ctx.logger,
    });

    // Cold cache, then a read that stalls mid-store-load. `isEnabledGlobally`
    // reads the base switch, which is exactly what this race is about.
    await harness.ctx.redis.del(FEATURE_FLAG_CACHE_KEY);
    const inflight = reader.isEnabledGlobally('chat');
    await storeRead;

    await harness.ctx.featureFlags.setFlag('chat', { enabled: false }, { id: admin.id });
    release!();
    // The in-flight read legitimately answers what it read: it started first.
    expect(await inflight).toBe(true);

    // The very next read must see the kill — whatever the stalled one cached.
    expect(await reader.isEnabledGlobally('chat')).toBe(false);
    expect(await harness.ctx.featureFlags.isEnabledGlobally('chat')).toBe(false);
  });

  it('marks a confirmed flip as propagated in the audit log', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);

    await adminAgent
      .patch('/api/v1/admin/feature-flags/alerts')
      .set(...XRW)
      .send({ enabled: false })
      .expect(200);

    const audit = await adminAgent.get('/api/v1/admin/audit');
    const entry = audit.body.entries.find(
      (e: { action: string; meta?: { key?: string; propagated?: boolean } }) =>
        e.action === 'feature_flag.changed' && e.meta?.key === 'alerts',
    );
    expect(entry?.meta?.propagated).toBe(true);
  });
});

describe('a killed feature stops its background producer, not only its router', () => {
  /** Recording stand-in for the durable dispatch boundary (#368). */
  function recordingCenter(): NotificationCenter & { emitted: DispatchableEvent[] } {
    const emitted: DispatchableEvent[] = [];
    return {
      emitted,
      async emit(event) {
        emitted.push(event);
        return true;
      },
    };
  }

  function jobCtx(): JobContext {
    return {
      events: harness.ctx.events,
      deadLetter: createDeadLetter(harness.ctx.redis),
      redis: harness.ctx.redis,
      logger: pino({ level: 'silent' }) as unknown as Logger,
      // The REAL service the admin flip writes through — the worker resolves
      // flags exactly the way the API context does: the BASE switch, because a
      // scheduled producer has no principal to bucket (#1910).
      isFeatureEnabledGlobally: (key) => harness.ctx.featureFlags.isEnabledGlobally(key),
    };
  }

  function scheduledRun(processedOn: number): Job<Record<string, never>> {
    return {
      id: 'alerts-run',
      name: 'alerts.evaluate',
      data: {},
      processedOn,
    } as unknown as Job<Record<string, never>>;
  }

  it('flipping alerts OFF stops alerts.evaluate firing — and flipping it back ON resumes on the next run', async () => {
    const user = await harness.seedUser({ email: 'alert-owner@bt.test', username: 'alertowner' });
    const [asset] = await harness.db
      .insert(schema.assets)
      .values({
        providerId: 'yahoo',
        providerRef: 'AAPL',
        type: 'stock',
        symbol: 'AAPL',
        name: 'Apple Inc.',
        currency: 'USD',
      })
      .returning({ id: schema.assets.id });
    const alert = await createAlertRepository(harness.db).create({
      userId: user.id,
      assetId: asset!.id,
      kind: 'price_above',
      threshold: 100,
      refPrice: null,
      repeat: false,
    });

    const notify = recordingCenter();
    const quoted: string[] = [];
    const job = createAlertsEvaluateJob({
      db: harness.db,
      marketData: createStubMarketData({
        quote: (ref) => {
          quoted.push(ref.providerRef);
          return {
            value: {
              price: 150,
              currency: 'USD',
              dayChangePct: null,
              asOf: '2026-07-07T00:00:00.000Z',
            },
            stale: false,
            asOf: 0,
          };
        },
      }),
      notify,
      paranoid: harness.ctx.paranoidGuard,
    });
    const ctx = jobCtx();

    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    await adminAgent
      .patch('/api/v1/admin/feature-flags/alerts')
      .set(...XRW)
      .send({ enabled: false })
      .expect(200);

    // Both halves of the switch, from the same flip: the router refuses…
    const userAgent = request.agent(harness.app);
    await userAgent
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: user.email, password: user.password })
      .expect(200);
    const refused = await userAgent.get('/api/v1/alerts');
    expect(refused.status).toBe(404);
    expect(refused.body.error?.code).toBe('FEATURE_DISABLED');

    // …and the scheduled producer sheds its run.
    const offAt = Date.parse('2026-07-07T15:00:00.000Z');
    await runJobDefinition(job, scheduledRun(offAt), ctx);

    expect(quoted).toEqual([]);
    expect(notify.emitted).toEqual([]);
    const [offRow] = await harness.db
      .select()
      .from(schema.alerts)
      .where(eq(schema.alerts.id, alert.id));
    expect(offRow!.status).toBe('active');
    // No (alert, window) bucket was consumed while the switch was off.
    expect(
      await harness.ctx.redis.get(alertFireLockKey(alert.id, alertFireWindowStart(offAt))),
    ).toBeNull();

    // Flip back ON: same worker process, same definition and context — the flag
    // is read per run, so the next run fires.
    await adminAgent
      .patch('/api/v1/admin/feature-flags/alerts')
      .set(...XRW)
      .send({ enabled: true })
      .expect(200);
    expect((await userAgent.get('/api/v1/alerts')).status).toBe(200);

    await runJobDefinition(job, scheduledRun(Date.parse('2026-07-07T15:01:00.000Z')), ctx);

    expect(quoted).toEqual(['AAPL']);
    expect(notify.emitted).toEqual([
      expect.objectContaining({ type: 'alert.triggered', userId: user.id, alertId: alert.id }),
    ]);
  });
});

/**
 * Rollout targeting (#1910): percentage + allow/deny lists, resolved against the
 * calling principal at every seam. The pure precedence rules are unit-tested in
 * `src/services/featureFlags/__tests__/featureFlagResolution.test.ts`; what this
 * block proves is that the HTTP stack, the store and the cache carry them.
 */
describe('rollout targeting reaches the request (§6.12, #1910)', () => {
  /** Log in a freshly-seeded user and hand back both the agent and the id. */
  async function seededAgent(
    email: string,
    username: string,
  ): Promise<{ agent: Agent; id: string }> {
    const seeded = await harness.seedUser({ email, username });
    const agent = request.agent(harness.app);
    await agent
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: seeded.email, password: seeded.password })
      .expect(200);
    return { agent, id: seeded.id };
  }

  async function patchFlag(agent: Agent, key: string, body: unknown): Promise<request.Response> {
    return await agent
      .patch(`/api/v1/admin/feature-flags/${key}`)
      .set(...XRW)
      .send(body as object);
  }

  it('a bare-boolean row still resolves — true AND false (every pre-#1910 row is one)', async () => {
    // No migration rewrote these rows and none should: a jsonb column widens for
    // free, and a data migration over the product's kill switches is risk with no
    // payoff. So the legacy shape has to stay legal on read, forever.
    const store = createAppSettingsRepository(harness.db);
    await store.upsert('feature_flag_chat', false, null);
    await store.upsert('feature_flag_alerts', true, null);
    await harness.ctx.redis.del(FEATURE_FLAG_CACHE_KEY);

    const user = await seededAgent('legacy-row@bt.test', 'legacyrow');
    expect((await user.agent.get('/api/v1/chat/conversations')).status).toBe(404);
    expect((await user.agent.get('/api/v1/alerts')).status).toBe(200);

    // …and the admin list reports the legacy row with the defaulted rollout.
    const adminAgent = await harness.loginAdmin(await harness.seedAdmin());
    const list = await adminAgent.get('/api/v1/admin/feature-flags');
    const chat = list.body.flags.find((f: { key: string }) => f.key === 'chat');
    expect(chat).toMatchObject({
      enabled: false,
      rolloutPercent: 100,
      allowUserIds: [],
      denyUserIds: [],
    });
  });

  it('resolves `requireFeature` per principal: one denied user 404s while another gets 200', async () => {
    const denied = await seededAgent('denied@bt.test', 'denieduser');
    const allowed = await seededAgent('allowed@bt.test', 'alloweduser');
    const adminAgent = await harness.loginAdmin(await harness.seedAdmin());

    expect((await patchFlag(adminAgent, 'chat', { denyUserIds: [denied.id] })).status).toBe(200);

    // Same route, same moment, same deployment — two answers, by design.
    const refused = await denied.agent.get('/api/v1/chat/conversations');
    expect(refused.status).toBe(404);
    expect(refused.body.error?.code).toBe('FEATURE_DISABLED');
    expect((await allowed.agent.get('/api/v1/chat/conversations')).status).toBe(200);
  });

  it('`enabled: false` refuses an ALLOWLISTED user through the real HTTP guard', async () => {
    const user = await seededAgent('killswitch@bt.test', 'killswitch');
    const adminAgent = await harness.loginAdmin(await harness.seedAdmin());

    const patched = await patchFlag(adminAgent, 'imports', {
      enabled: false,
      allowUserIds: [user.id],
    });
    expect(patched.status).toBe(200);
    const flag = patched.body.flags.find((f: { key: string }) => f.key === 'imports');
    expect(flag.enabled).toBe(false);
    expect(flag.allowUserIds).toEqual([user.id]);

    // The allowlist is stored and returned, and it still does not save them.
    expect((await user.agent.get('/api/v1/imports/brokers')).status).toBe(404);
  });

  it('`rolloutPercent: 0` closes the route for an authenticated user; the allowlist reopens it', async () => {
    const user = await seededAgent('rollout@bt.test', 'rolloutuser');
    const adminAgent = await harness.loginAdmin(await harness.seedAdmin());

    expect((await patchFlag(adminAgent, 'alerts', { rolloutPercent: 0 })).status).toBe(200);
    expect((await user.agent.get('/api/v1/alerts')).status).toBe(404);

    // A patch is a MERGE: adding the allowlist must not reset the percentage.
    const merged = await patchFlag(adminAgent, 'alerts', { allowUserIds: [user.id] });
    expect(merged.status).toBe(200);
    const flag = merged.body.flags.find((f: { key: string }) => f.key === 'alerts');
    expect(flag.rolloutPercent).toBe(0);
    expect((await user.agent.get('/api/v1/alerts')).status).toBe(200);
  });

  it('rejects a malformed rollout — out-of-range percent, non-uuid ids, an over-long list, an unknown key', async () => {
    const adminAgent = await harness.loginAdmin(await harness.seedAdmin());
    const tooMany = Array.from({ length: 201 }, () => randomUUID());
    for (const body of [
      { rolloutPercent: 101 },
      { rolloutPercent: -1 },
      { rolloutPercent: 12.5 },
      { allowUserIds: ['not-a-uuid'] },
      { denyUserIds: tooMany },
      { enabled: true, allowUserIDs: [] },
      { privacyMode: 'paranoid' },
    ]) {
      const res = await patchFlag(adminAgent, 'chat', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('the anonymous bootstrap never publishes the rollout (#1910 §3)', () => {
  it('carries no rolloutPercent / allowUserIds / denyUserIds — asserted over the raw body', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    const seeded = await harness.seedUser({ email: 'listed@bt.test', username: 'listeduser' });
    await adminAgent
      .patch('/api/v1/admin/feature-flags/ai')
      .set(...XRW)
      .send({ rolloutPercent: 40, allowUserIds: [seeded.id], denyUserIds: [admin.id] })
      .expect(200);

    const res = await request(harness.app).get('/api/v1/feature-flags');
    expect(res.status).toBe(200);

    // The schema is `.strict()`, but a schema only proves what it was asked to
    // parse. This reads the SERIALIZED body: a user id leaking through any
    // field, at any depth, fails here.
    const raw = res.text;
    expect(raw).not.toContain(seeded.id);
    expect(raw).not.toContain(admin.id);
    expect(raw).not.toContain('rolloutPercent');
    expect(raw).not.toContain('allowUserIds');
    expect(raw).not.toContain('denyUserIds');
    expect(Object.keys(res.body).sort()).toEqual(['capabilities', 'flags']);
    for (const value of Object.values(res.body.flags)) expect(typeof value).toBe('boolean');
  });

  it('reports a partially-rolled flag as OFF pre-login, and the same flag as ON to a user inside the rollout', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    const seeded = await harness.seedUser({ email: 'inside@bt.test', username: 'insideuser' });
    await adminAgent
      .patch('/api/v1/admin/feature-flags/liveMode')
      .set(...XRW)
      .send({ rolloutPercent: 50, allowUserIds: [seeded.id] })
      .expect(200);

    // Anonymous: not fully rolled ⇒ OFF. Advertising it would promise a surface
    // that `requireFeature` then refuses for most accounts.
    const anon = await request(harness.app).get('/api/v1/feature-flags');
    expect(anon.body.flags.liveMode).toBe(false);
    // Unaffected flags still read ON — this is targeting, not a blackout.
    expect(anon.body.flags.chat).toBe(true);

    const agent = request.agent(harness.app);
    await agent
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: seeded.email, password: seeded.password })
      .expect(200);
    const authed = await agent.get('/api/v1/feature-flags');
    expect(authed.body.flags.liveMode).toBe(true);
  });

  it('is `Cache-Control: no-store` — the answer is principal-dependent now', async () => {
    const res = await request(harness.app).get('/api/v1/feature-flags');
    // A shared cache (CDN, proxy, a browser store on a shared machine) keyed on
    // the URL alone would hand one user's resolution to another.
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('serves two principals different answers from ONE warm snapshot', async () => {
    // The cache must hold CONFIGURATION, not a resolved map. Caching the
    // resolved answer is the same bug as a shared HTTP cache: whoever misses
    // first decides for everyone until the TTL expires.
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    const inside = await harness.seedUser({ email: 'warm-in@bt.test', username: 'warmin' });
    const outside = await harness.seedUser({ email: 'warm-out@bt.test', username: 'warmout' });
    await adminAgent
      .patch('/api/v1/admin/feature-flags/chat')
      .set(...XRW)
      .send({ rolloutPercent: 0, allowUserIds: [inside.id] })
      .expect(200);

    const login = async (user: { email: string; password: string }): Promise<Agent> => {
      const agent = request.agent(harness.app);
      await agent
        .post('/api/v1/auth/login')
        .set(...XRW)
        .send({ identifier: user.email, password: user.password })
        .expect(200);
      return agent;
    };
    const insideAgent = await login(inside);
    const outsideAgent = await login(outside);

    // Warm the snapshot with the OUTSIDE user's request first, so a resolved-map
    // cache would have stored `chat: false` for everyone.
    expect((await outsideAgent.get('/api/v1/feature-flags')).body.flags.chat).toBe(false);
    const cached = await harness.ctx.redis.get(FEATURE_FLAG_CACHE_KEY);
    expect(cached, 'the read must have populated the shared snapshot').not.toBeNull();
    expect(JSON.parse(cached!).config.chat).toMatchObject({ enabled: true, rolloutPercent: 0 });

    // Same warm snapshot, different principal, different answer.
    expect((await insideAgent.get('/api/v1/feature-flags')).body.flags.chat).toBe(true);
    expect((await insideAgent.get('/api/v1/chat/conversations')).status).toBe(200);
    expect((await outsideAgent.get('/api/v1/chat/conversations')).status).toBe(404);
  });
});

describe('the audit row records the rollout by SHAPE, never by identity (#1910 §4)', () => {
  it('logs before/after with list LENGTHS, and no seeded user id anywhere in meta', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    const alice = await harness.seedUser({ email: 'audit-a@bt.test', username: 'auditalice' });
    const bob = await harness.seedUser({ email: 'audit-b@bt.test', username: 'auditbob' });

    await adminAgent
      .patch('/api/v1/admin/feature-flags/imports')
      .set(...XRW)
      .send({ rolloutPercent: 25, allowUserIds: [alice.id], denyUserIds: [bob.id] })
      .expect(200);

    const audit = await adminAgent.get('/api/v1/admin/audit');
    const entry = audit.body.entries.find(
      (e: { action: string; meta?: { key?: string } }) =>
        e.action === 'feature_flag.changed' && e.meta?.key === 'imports',
    );
    expect(entry).toBeDefined();
    expect(entry.meta.before).toEqual({
      enabled: true,
      rolloutPercent: 100,
      allowCount: 0,
      denyCount: 0,
    });
    expect(entry.meta.after).toEqual({
      enabled: true,
      rolloutPercent: 25,
      allowCount: 1,
      denyCount: 1,
    });

    // An audit row is retained for BT_AUDIT_RETENTION_DAYS (400 by default).
    // Copying account ids into it every time an operator nudges a rollout would
    // make the security log a second, unmanaged store of exactly the identifiers
    // the public bootstrap is forbidden to publish.
    const serialized = JSON.stringify(entry.meta);
    expect(serialized).not.toContain(alice.id);
    expect(serialized).not.toContain(bob.id);
  });
});

/**
 * A stored row the current schema cannot parse must never READ as "on".
 *
 * The bug this pins: `parseStoredConfig` returned `null` for any schema failure
 * and all three readers fell back to the default — which is `enabled: true`. A
 * row carrying `enabled: false` plus one field `.strict()` refuses therefore
 * advertised the feature as ON, served its routes, showed the operator a healthy
 * `{ enabled: true, rolloutPercent: 100 }`, and let the next PATCH write that
 * invention back as fact. Precedence step 1 says `enabled === false` is absolute;
 * this is that rule being undone one layer below where it is expressed.
 *
 * It is not hypothetical: `.strict()` on the READ path means the FIRST field any
 * future wave adds to `featureFlagConfigSchema` makes every row written by the
 * previous version unreadable — i.e. every kill switch in the estate turns ON
 * during the deploy.
 */
describe('an unparseable stored row can never resurrect a killed feature', () => {
  /** The row an older/newer writer leaves behind: killed, plus a field we refuse. */
  const KILLED_WITH_UNKNOWN_FIELD = {
    enabled: false,
    rolloutPercent: 100,
    allowUserIds: [],
    denyUserIds: [],
    futureField: 'written by a later version',
  };

  async function storeRaw(key: string, value: unknown): Promise<void> {
    await createAppSettingsRepository(harness.db).upsert(`feature_flag_${key}`, value, null);
    await harness.ctx.redis.del(FEATURE_FLAG_CACHE_KEY);
  }

  it('keeps the feature OFF on the bootstrap and at the route guard', async () => {
    await storeRaw('chat', KILLED_WITH_UNKNOWN_FIELD);

    const anon = await request(harness.app).get('/api/v1/feature-flags');
    expect(anon.body.flags.chat).toBe(false);
    // A flag we CAN parse is unaffected — this is a per-row salvage, not a
    // global fail-closed flip that would take the whole product down over one
    // bad row.
    expect(anon.body.flags.alerts).toBe(true);

    const seeded = await harness.seedUser({ email: 'salvage@bt.test', username: 'salvageuser' });
    const agent = request.agent(harness.app);
    await agent
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: seeded.email, password: seeded.password })
      .expect(200);
    const refused = await agent.get('/api/v1/chat/conversations');
    expect(refused.status).toBe(404);
    expect(refused.body.error?.code).toBe('FEATURE_DISABLED');
    // The unaffected flag still serves, so the 404 above is the switch, not a
    // broken harness.
    expect((await agent.get('/api/v1/alerts')).status).toBe(200);
  });

  it('shows the operator the switch is OFF, not an invented healthy row', async () => {
    await storeRaw('chat', KILLED_WITH_UNKNOWN_FIELD);
    const adminAgent = await harness.loginAdmin(await harness.seedAdmin());

    const list = await adminAgent.get('/api/v1/admin/feature-flags');
    const chat = list.body.flags.find((f: { key: string }) => f.key === 'chat');
    expect(chat.enabled).toBe(false);
  });

  it('refuses a partial PATCH onto a row it cannot read, and keeps the kill', async () => {
    await storeRaw('chat', { enabled: false, rolloutPercent: 'fifty' });
    const adminAgent = await harness.loginAdmin(await harness.seedAdmin());

    // Merging onto an unreadable row means inventing the fields the patch omits.
    // For `enabled` that invention is the kill switch itself, so the write is
    // refused rather than guessed.
    const refused = await adminAgent
      .patch('/api/v1/admin/feature-flags/chat')
      .set(...XRW)
      .send({ rolloutPercent: 50 });
    expect(refused.status).toBe(409);
    expect(refused.body.error?.code).toBe(FEATURE_FLAG_CONFIG_UNREADABLE);

    // The kill survives the refusal.
    const anon = await request(harness.app).get('/api/v1/feature-flags');
    expect(anon.body.flags.chat).toBe(false);
  });

  it('accepts a COMPLETE replacement, which invents nothing — the operator escape hatch', async () => {
    await storeRaw('chat', { enabled: false, rolloutPercent: 'fifty' });
    const adminAgent = await harness.loginAdmin(await harness.seedAdmin());

    const repaired = await adminAgent
      .patch('/api/v1/admin/feature-flags/chat')
      .set(...XRW)
      .send({ enabled: true, rolloutPercent: 50, allowUserIds: [], denyUserIds: [] });
    expect(repaired.status).toBe(200);
    const chat = repaired.body.flags.find((f: { key: string }) => f.key === 'chat');
    expect(chat).toMatchObject({ enabled: true, rolloutPercent: 50 });
  });

  it('records a TRUTHFUL audit `before` — never the invented default', async () => {
    await storeRaw('imports', KILLED_WITH_UNKNOWN_FIELD);
    const adminAgent = await harness.loginAdmin(await harness.seedAdmin());

    await adminAgent
      .patch('/api/v1/admin/feature-flags/imports')
      .set(...XRW)
      .send({ rolloutPercent: 50 })
      .expect(200);

    const audit = await adminAgent.get('/api/v1/admin/audit');
    const entry = audit.body.entries.find(
      (e: { action: string; meta?: { key?: string } }) =>
        e.action === 'feature_flag.changed' && e.meta?.key === 'imports',
    );
    // `enabled: false` was readable in the row, so it is what the log says the
    // flip moved away from. Recording `true` here would describe an incident
    // that never happened.
    expect(entry.meta.before.enabled).toBe(false);
    expect(entry.meta.after.enabled).toBe(false);
  });

  it('still degrades to ON when an ENABLED flag has a garbled rollout', async () => {
    // The salvage honours `enabled` and defaults only the targeting fields, so a
    // flag whose rollout is unreadable serves everyone rather than nobody: an
    // unreadable ROLLOUT is not a kill, and failing that one closed would take a
    // working feature down over a cosmetic field.
    await storeRaw('alerts', { enabled: true, rolloutPercent: 'fifty', allowUserIds: 'nope' });

    const anon = await request(harness.app).get('/api/v1/feature-flags');
    expect(anon.body.flags.alerts).toBe(true);

    const adminAgent = await harness.loginAdmin(await harness.seedAdmin());
    const list = await adminAgent.get('/api/v1/admin/feature-flags');
    const alerts = list.body.flags.find((f: { key: string }) => f.key === 'alerts');
    expect(alerts).toMatchObject({ enabled: true, rolloutPercent: 100, allowUserIds: [] });
  });
});

/**
 * Rollback safety (#1910 H1). Pre-#1910 code reads a row with
 * `typeof value === 'boolean'` and falls back to "every flag ON" for anything
 * else — so a deploy that rolled BACK past this change would read every object
 * row as unset and turn every killed feature on.
 *
 * The write path therefore keeps the legacy SHAPE whenever there is no targeting
 * to express: an untargeted flag is still a bare boolean on disk, and only a
 * genuinely targeted one costs the object form.
 */
describe('an untargeted flag is still stored in the pre-#1910 shape', () => {
  async function storedValue(key: string): Promise<unknown> {
    const row = await createAppSettingsRepository(harness.db).get(`feature_flag_${key}`);
    return row?.value;
  }

  it('writes a bare boolean for a plain kill, so a rollback still reads the kill', async () => {
    const adminAgent = await harness.loginAdmin(await harness.seedAdmin());
    await adminAgent
      .patch('/api/v1/admin/feature-flags/chat')
      .set(...XRW)
      .send({ enabled: false })
      .expect(200);

    expect(await storedValue('chat')).toBe(false);
    // …and this instance still reads it correctly, so the legacy shape is not a
    // downgrade in behaviour.
    expect((await request(harness.app).get('/api/v1/feature-flags')).body.flags.chat).toBe(false);
  });

  it('writes the object form only once targeting exists, and drops back when it goes', async () => {
    const adminAgent = await harness.loginAdmin(await harness.seedAdmin());
    const seeded = await harness.seedUser({ email: 'shape@bt.test', username: 'shapeuser' });

    await adminAgent
      .patch('/api/v1/admin/feature-flags/alerts')
      .set(...XRW)
      .send({ rolloutPercent: 25 })
      .expect(200);
    expect(await storedValue('alerts')).toMatchObject({ enabled: true, rolloutPercent: 25 });

    // An allow list alone is targeting too.
    await adminAgent
      .patch('/api/v1/admin/feature-flags/imports')
      .set(...XRW)
      .send({ allowUserIds: [seeded.id] })
      .expect(200);
    expect(await storedValue('imports')).toMatchObject({ allowUserIds: [seeded.id] });

    // Removing the targeting returns the row to the shape a rollback understands.
    await adminAgent
      .patch('/api/v1/admin/feature-flags/alerts')
      .set(...XRW)
      .send({ rolloutPercent: 100 })
      .expect(200);
    expect(await storedValue('alerts')).toBe(true);
  });
});
