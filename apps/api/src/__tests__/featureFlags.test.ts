import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FEATURE_FLAG_KEYS, featureFlagsResponseSchema } from '@bettertrack/contracts';

import { createAlertRepository } from '../data/repositories/alertRepository';
import * as schema from '../data/schema';
import { createAlertsEvaluateJob, createDeadLetter, runJobDefinition } from '../jobs';
import type { JobContext } from '../jobs';
import type { Logger } from '../logger';
import { alertFireLockKey, alertFireWindowStart } from '../services/alerts/alertEvaluator';
import {
  FEATURE_FLAG_CACHE_KEY,
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
};

/**
 * Break exactly the snapshot key's `del` (and optionally its `set`), leaving
 * every other Redis call — sessions, rate limits — working. Returns nothing:
 * `vi.restoreAllMocks()` in `afterEach` puts the client back.
 */
function breakSnapshotWrites(options: { set: boolean }): void {
  const redis = harness.ctx.redis as unknown as SpyableRedis;
  const realDel = redis.del.bind(redis);
  const realSet = redis.set.bind(redis);
  vi.spyOn(redis, 'del').mockImplementation(async (...args: unknown[]) => {
    if (args[0] === FEATURE_FLAG_CACHE_KEY) throw new Error('redis unavailable (del)');
    return realDel(...args);
  });
  if (!options.set) return;
  vi.spyOn(redis, 'set').mockImplementation(async (...args: unknown[]) => {
    if (args[0] === FEATURE_FLAG_CACHE_KEY) throw new Error('redis unavailable (set)');
    return realSet(...args);
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
  it('falls back to rewriting the snapshot when the DEL fails — still 200, still effective at once', async () => {
    const user = await loginUser();
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);

    expect((await user.get('/api/v1/chat/conversations')).status).toBe(200);
    breakSnapshotWrites({ set: false });

    const flip = await adminAgent
      .patch('/api/v1/admin/feature-flags/chat')
      .set(...XRW)
      .send({ enabled: false });
    expect(flip.status).toBe(200);
    expect(flip.body.flags.find((f: { key: string }) => f.key === 'chat').enabled).toBe(false);

    // The rewrite propagated exactly like the DEL would have: next request refuses.
    const refused = await user.get('/api/v1/chat/conversations');
    expect(refused.status).toBe(404);
    expect(refused.body.error?.code).toBe('FEATURE_DISABLED');
  });

  it('surfaces 503 when neither the DEL nor the rewrite lands — and still persists the value', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    breakSnapshotWrites({ set: true });

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
      // flags exactly the way the API context does.
      isFeatureEnabled: (key) => harness.ctx.featureFlags.isEnabled(key),
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
