import { eq } from 'drizzle-orm';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import express from 'express';
import postgres from 'postgres';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usageAnalyticsResponseSchema } from '@bettertrack/contracts';

import {
  createUsageAnalyticsRepository,
  type UsageAnalyticsRepository,
} from '../data/repositories/usageAnalyticsRepository';
import * as schema from '../data/schema';
import { FEATURE_BY_SEGMENT, createUsageCaptureMiddleware } from '../http/middleware/usageCapture';
import { isVaultSensitiveUnattributedAssetRequest } from '../services/account/vaultedPortfolioEnforcement';
import {
  createUsageAnalyticsService,
  type UsageSignal,
} from '../services/analytics/usageAnalyticsService';
import { flushTelemetryBuffers } from '../shutdown';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const REAL_DATABASE_URL = process.env.TEST_DATABASE_URL;

/**
 * A throwaway app carrying ONE principal through the capture middleware: a
 * cookie session (`null`) or a bearer token of either kind. Everything else —
 * the route, the user, the vault answers — is held identical, so the only
 * variable is the principal (#1847).
 */
function captureApp(bearer: { kind: 'personal' | 'oauth' } | null): {
  app: express.Express;
  captured: UsageSignal[];
} {
  const captured: UsageSignal[] = [];
  const usage = { capture: (signal: UsageSignal) => captured.push(signal) };
  const vaulted = {
    isOwnedPortfolioVaulted: async () => false,
    userOwnsVaultedPortfolio: async () => false,
  };
  const app = express();
  app.use((req, _res, next) => {
    req.authUser = { id: 'user-1', privacyMode: 'normal' } as never;
    if (bearer) {
      req.apiKey = { id: 'principal-1', scopes: [], kind: bearer.kind } as never;
    }
    next();
  });
  app.use(createUsageCaptureMiddleware(usage as never, vaulted as never));
  const router = express.Router();
  router.get('/', (_req, res) => {
    res.json({ portfolios: [] });
  });
  app.use('/api/v1/portfolios', router);
  return { app, captured };
}

/** Capture runs on `finish`, one microtask behind the response. */
async function settleCapture(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Admin usage analytics (PROJECTPLAN.md §13.5 V5-P2 arc (b)) — first-party
 * DAU/WAU/MAU, feature counters, top assets and the registration funnel,
 * captured from our own request stream and served behind an admin-only route
 * (404 to everyone else).
 */
describe('admin usage analytics', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const eventsFor = (userId: string) =>
    harness.db.select().from(schema.usageEvents).where(eq(schema.usageEvents.userId, userId));

  const activationsFor = (userId: string) =>
    harness.db
      .select()
      .from(schema.usageActivations)
      .where(eq(schema.usageActivations.userId, userId));

  it('computes DAU/WAU/MAU, feature counters, top assets and the funnel', async () => {
    const alice = await harness.seedUser({ email: 'alice@test.dev', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@test.dev', username: 'bob' });

    // Seed first-party usage signals directly (the middleware path is covered
    // by its own case below).
    harness.ctx.usageAnalytics.capture({ userId: alice.id, feature: 'portfolio' });
    harness.ctx.usageAnalytics.capture({ userId: alice.id, feature: 'assets', assetId: 'AAPL' });
    harness.ctx.usageAnalytics.capture({ userId: alice.id, feature: 'assets', assetId: 'AAPL' });
    harness.ctx.usageAnalytics.capture({ userId: bob.id, feature: 'workboard' });
    harness.ctx.usageAnalytics.capture({ userId: bob.id, feature: 'assets', assetId: 'MSFT' });
    await harness.ctx.usageAnalytics.flush();

    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);

    const res = await agent.get('/api/v1/admin/usage-analytics');
    expect(res.status).toBe(200);
    const body = usageAnalyticsResponseSchema.parse(res.body);

    // Two distinct users active today → DAU/WAU/MAU all 2.
    expect(body.activeUsers.daily).toBe(2);
    expect(body.activeUsers.weekly).toBe(2);
    expect(body.activeUsers.monthly).toBe(2);

    // Feature counters (from the rollup the read materialized).
    const byFeature = Object.fromEntries(body.features.map((f) => [f.feature, f.events]));
    expect(byFeature.assets).toBe(3); // 2× AAPL + 1× MSFT
    expect(byFeature.portfolio).toBe(1);
    expect(byFeature.workboard).toBe(1);

    // Top assets — AAPL viewed twice, MSFT once; no sentinel `*` leaks in.
    const topByAsset = Object.fromEntries(body.topAssets.map((a) => [a.assetId, a.views]));
    expect(topByAsset.AAPL).toBe(2);
    expect(topByAsset.MSFT).toBe(1);
    expect(body.features.some((f) => f.feature === '*')).toBe(false);

    // Funnel: nested subsets, monotonic non-increasing.
    const funnel = Object.fromEntries(body.funnel.map((p) => [p.stage, p.count]));
    expect(funnel.registered).toBeGreaterThanOrEqual(2);
    expect(funnel.activated).toBe(2);
    expect(funnel.weeklyActive).toBe(2);
    expect(funnel.dailyActive).toBe(2);
    expect(funnel.registered ?? 0).toBeGreaterThanOrEqual(funnel.activated ?? 0);

    expect(body.windowDays).toBe(30);
  });

  it('materializes daily aggregates via the rollup and serves them', async () => {
    const alice = await harness.seedUser({ email: 'a2@test.dev', username: 'a2' });
    // A signal from three days ago — only in the window once its day is rolled up.
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
    harness.ctx.usageAnalytics.capture({
      userId: alice.id,
      feature: 'social',
      occurredAt: threeDaysAgo,
    });
    await harness.ctx.usageAnalytics.flush();
    // The rollup job body: re-materialize the trailing window.
    await harness.ctx.usageAnalytics.rollupRecent(7);

    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    const res = await agent.get('/api/v1/admin/usage-analytics');
    const body = usageAnalyticsResponseSchema.parse(res.body);

    expect(body.features.some((f) => f.feature === 'social' && f.events === 1)).toBe(true);
    // The activity series carries that day with a distinct active user.
    const day = threeDaysAgo.toISOString().slice(0, 10);
    expect(body.series.some((p) => p.day === day && p.activeUsers === 1)).toBe(true);
    // Active in the last 7 days but NOT the last 1 → WAU 1, DAU 0.
    expect(body.activeUsers.weekly).toBe(1);
    expect(body.activeUsers.daily).toBe(0);
  });

  it('captures first-party usage from real authenticated request traffic', async () => {
    const user = await harness.seedUser({ email: 'traffic@test.dev', username: 'traffic' });
    const userAgent = request.agent(harness.app);
    const login = await userAgent
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: user.email, password: user.password });
    expect(login.status).toBe(200);

    // Drive a couple of authenticated reads — the capture middleware folds them.
    await userAgent.get('/api/v1/portfolios');
    await userAgent.get('/api/v1/notifications');
    await harness.ctx.usageAnalytics.flush();

    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    const res = await agent.get('/api/v1/admin/usage-analytics');
    const body = usageAnalyticsResponseSchema.parse(res.body);

    expect(body.activeUsers.daily).toBeGreaterThanOrEqual(1);
    expect(body.features.length).toBeGreaterThan(0);
  });

  it('flushes buffered usage events at shutdown instead of discarding them', async () => {
    // The buffer only reaches the DB on a flush, and the API is the sole
    // producer — every restart used to drop up to a flush interval of DAU /
    // feature-counter signal (§13.5 V5-P2).
    const alice = await harness.seedUser({ email: 'shutdown@test.dev', username: 'shutdown_u' });
    harness.ctx.usageAnalytics.capture({ userId: alice.id, feature: 'portfolio' });
    harness.ctx.usageAnalytics.capture({ userId: alice.id, feature: 'assets', assetId: 'AAPL' });

    // No explicit flush: the shutdown drain is what has to persist these.
    await flushTelemetryBuffers({
      problems: harness.ctx.problems,
      usageAnalytics: harness.ctx.usageAnalytics,
    });

    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    const res = await agent.get('/api/v1/admin/usage-analytics');
    const body = usageAnalyticsResponseSchema.parse(res.body);

    expect(body.activeUsers.daily).toBe(1);
    const byFeature = Object.fromEntries(body.features.map((f) => [f.feature, f.events]));
    expect(byFeature.portfolio).toBe(1);
    expect(byFeature.assets).toBe(1);
  });

  it('counts a cookie session but never a personal API key’s traffic', async () => {
    // "First-party" means a human on our own client (§6.12/§6.13). A program
    // holding a token used to pin its owner into DAU/WAU/MAU, drive the feature
    // counters at its poll rate, and write the LIFETIME activation marker for
    // an account no human had ever used (#1847).
    const user = await harness.seedUser({ email: 'bot-owner@test.dev', username: 'botowner' });
    const { token } = await harness.ctx.apiKeys.create({
      userId: user.id,
      name: 'polling bot',
      scopes: ['portfolio:read'] as never,
    });

    const bot = await request(harness.app)
      .get('/api/v1/portfolios')
      .set('Authorization', `Bearer ${token}`);
    expect(bot.status).toBe(200);
    await harness.ctx.usageAnalytics.flush();

    expect(await eventsFor(user.id)).toHaveLength(0);
    expect(await activationsFor(user.id)).toHaveLength(0);

    // The IDENTICAL request on a cookie session produces all three: the event
    // row, its feature counter, and the durable activation marker.
    const agent = request.agent(harness.app);
    await agent
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: user.email, password: user.password });
    const human = await agent.get('/api/v1/portfolios');
    expect(human.status).toBe(200);
    await harness.ctx.usageAnalytics.flush();

    const events = await eventsFor(user.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.feature).toBe('portfolio');
    expect(events[0]!.hits).toBe(1);
    expect(await activationsFor(user.id)).toHaveLength(1);
  });

  it('skips both bearer principal kinds at the capture seam, and only those', async () => {
    // An OAuth grant is the other `req.apiKey` kind (§6.13) and is skipped for
    // the same reason; the middleware is driven directly so both kinds — and
    // the cookie principal that must still count — are asserted side by side.
    const kinds = ['personal', 'oauth'] as const;
    for (const kind of kinds) {
      const { captured, app } = captureApp({ kind });
      await request(app).get('/api/v1/portfolios').expect(200);
      await settleCapture();
      expect(captured, `${kind} bearer traffic must not be captured`).toHaveLength(0);
    }

    const { captured, app } = captureApp(null);
    await request(app).get('/api/v1/portfolios').expect(200);
    await settleCapture();
    expect(captured).toEqual([expect.objectContaining({ userId: 'user-1', feature: 'portfolio' })]);
  });

  it('404s the usage-analytics surface for anonymous and user-kind callers', async () => {
    const anon = await request(harness.app).get('/api/v1/admin/usage-analytics');
    expect(anon.status).toBe(404);

    const user = await harness.seedUser({ email: 'plain@test.dev', username: 'plain_user' });
    const userAgent = request.agent(harness.app);
    await userAgent
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: user.email, password: user.password });
    const res = await userAgent.get('/api/v1/admin/usage-analytics');
    expect(res.status).toBe(404);
  });
});

/**
 * The bounds the capture/read sides claim (#1744). Driven against a recording
 * fake repository so the ceilings and the throttle can be observed directly —
 * the DB-backed behaviour is covered by the cases above.
 */
describe('usage-analytics bounds', () => {
  interface FakeRepo extends UsageAnalyticsRepository {
    /** One entry per `upsertEvents` call: how many folded rows it carried. */
    batches: number[];
    rollupDays: string[];
    /** Gate that holds every `upsertEvents` open until released. */
    release: () => void;
  }

  function createFakeRepo(): FakeRepo {
    let unblock: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const repo: FakeRepo = {
      batches: [],
      rollupDays: [],
      release: () => unblock?.(),
      async upsertEvents(rows) {
        repo.batches.push(rows.length);
        await gate;
      },
      async rollupDay(day) {
        repo.rollupDays.push(day);
      },
      async distinctActiveUsers() {
        return 0;
      },
      async activatedUsers() {
        return 0;
      },
      async totalUsers() {
        return 0;
      },
      async featureCounters() {
        return [];
      },
      async dailySeries() {
        return [];
      },
      async topAssets() {
        return [];
      },
      async deleteEventsOlderThan() {
        return 0;
      },
    };
    return repo;
  }

  it('caps buffer residency: an early drain first, then counted drops — never silent, never unbounded', async () => {
    const repo = createFakeRepo();
    const service = createUsageAnalyticsService({ repo, maxBufferedRows: 10 });

    // 10 distinct keys fit; the 11th is at the ceiling with no flush in flight,
    // so capture drains early (nothing lost) and the row still lands.
    for (let i = 0; i < 11; i += 1) {
      service.capture({ userId: `u${i}`, feature: 'assets' });
    }
    expect(repo.batches).toEqual([10]);
    expect(service.bufferedRows()).toBe(1);
    expect(service.droppedCaptures()).toBe(0);

    // That flush is still in flight (the fake holds it open). Fill the buffer
    // again: from the ceiling on, further NEW keys are dropped and counted
    // rather than growing the buffer without bound.
    for (let i = 100; i < 200; i += 1) {
      service.capture({ userId: `u${i}`, feature: 'assets' });
    }
    expect(service.bufferedRows()).toBe(10);
    expect(service.droppedCaptures()).toBe(91);
    // No second concurrent flush was started while one was in flight.
    expect(repo.batches).toEqual([10]);

    // Folding is unaffected: a repeat of a buffered key never counts as new.
    const before = service.droppedCaptures();
    service.capture({ userId: 'u100', feature: 'assets' });
    expect(service.droppedCaptures()).toBe(before);
    expect(service.bufferedRows()).toBe(10);

    repo.release();
    await service.flush();
    expect(repo.batches).toEqual([10, 10]);
    expect(service.bufferedRows()).toBe(0);
    // The drop total is cumulative and survives the flush that reports it.
    expect(service.droppedCaptures()).toBe(91);
  });

  it('throttles and dedupes the on-read rollup while keeping today fresh', async () => {
    const repo = createFakeRepo();
    let clock = Date.parse('2026-09-04T10:00:00.000Z');
    const service = createUsageAnalyticsService({
      repo,
      now: () => clock,
      readRollupMinIntervalMs: 30_000,
    });

    // First read materializes today.
    await service.overview();
    expect(repo.rollupDays).toEqual(['2026-09-04']);

    // A refresh loop inside the window re-scans nothing…
    clock += 1_000;
    await service.overview();
    clock += 5_000;
    await service.overview();
    expect(repo.rollupDays).toEqual(['2026-09-04']);

    // …concurrent reads share one scan…
    clock += 40_000;
    await Promise.all([service.overview(), service.overview(), service.overview()]);
    expect(repo.rollupDays).toEqual(['2026-09-04', '2026-09-04']);

    // …and the day still gets refreshed once the window has passed, plus
    // immediately at a day boundary, so "today" is never missing from a read.
    clock += 31_000;
    await service.overview();
    clock = Date.parse('2026-09-05T00:00:01.000Z');
    await service.overview();
    expect(repo.rollupDays).toEqual(['2026-09-04', '2026-09-04', '2026-09-04', '2026-09-05']);
  });

  it('still reports the current day through the throttled read', async () => {
    const repo = createFakeRepo();
    const clock = Date.parse('2026-09-04T10:00:00.000Z');
    const service = createUsageAnalyticsService({ repo, now: () => clock });
    const first = await service.overview();
    const second = await service.overview();
    expect(first.generatedAt).toBe('2026-09-04T10:00:00.000Z');
    expect(second.generatedAt).toBe('2026-09-04T10:00:00.000Z');
    // Only the first read paid for the rollup; both report the same fresh day.
    expect(repo.rollupDays).toEqual(['2026-09-04']);
  });

  it('serves the rollup it has when today’s refresh fails, and says it is stale', async () => {
    // The freshness optimisation used to take the whole read down with it: one
    // rejected `rollupDay` — the concurrent-rollup collision below produced
    // exactly that — rendered "Could not load usage analytics" over a payload
    // whose every other number was readable (#1896).
    const repo = createFakeRepo();
    const clock = Date.parse('2026-09-04T10:00:00.000Z');
    let warnings = 0;
    const service = createUsageAnalyticsService({
      repo,
      now: () => clock,
      logger: { warn: () => (warnings += 1) } as never,
    });
    const failing = vi
      .spyOn(repo, 'rollupDay')
      .mockRejectedValueOnce(new Error('rollup transaction failed'));

    const stale = await service.overview();
    expect(stale.todayRollupStale).toBe(true);
    expect(stale.windowDays).toBe(30);
    expect(stale.generatedAt).toBe('2026-09-04T10:00:00.000Z');
    // Not swallowed: it reaches the payload the admin reads AND the log.
    expect(warnings).toBe(1);
    failing.mockRestore();

    // The throttle was not armed, so the next read retries and is fresh again.
    const fresh = await service.overview();
    expect(fresh.todayRollupStale).toBe(false);
    expect(repo.rollupDays).toEqual(['2026-09-04']);
  });
});

/**
 * Which routers record an asset id, and which of those ids are vault-sensitive
 * (#1896). `custom-assets` shares the `assets` feature bucket, and folding the
 * id decision onto that bucket recorded a vaulted account's own private
 * custom-asset UUIDs — the precise holdings-roster reconstruction the
 * suppression branch exists to prevent, on the asset class where it matters
 * most. The classification is asserted as a whole so a future router added to
 * `FEATURE_BY_SEGMENT` cannot silently reopen it.
 */
describe('usage capture route classification', () => {
  const ID = '018f0000-0000-7000-8000-0000000004f0';

  it('records an asset id only on segments the vault-sensitivity predicate covers', () => {
    const assetsBucket = Object.entries(FEATURE_BY_SEGMENT).filter(
      ([, classification]) => classification.feature === 'assets',
    );
    // Not vacuous: these are the segments that feed the Top-assets panel.
    expect(assetsBucket.map(([segment]) => segment).sort()).toEqual([
      'assets',
      'custom-assets',
      'search',
    ]);

    // Every segment in the table — the assets bucket included — is either not
    // id-recording at all, or covered by the predicate for EVERY method.
    for (const [segment, classification] of Object.entries(FEATURE_BY_SEGMENT)) {
      if (!classification.recordsAssetId) continue;
      for (const path of [`/api/v1/${segment}/${ID}`, `/api/v1/${segment}/${ID}/value-points`]) {
        expect(
          isVaultSensitiveUnattributedAssetRequest(path),
          `${segment} records an asset id that the vault suppression does not cover`,
        ).toBe(true);
      }
    }
  });

  it('leaves the ordinary catalog surfaces and collection roots countable', () => {
    // `search` shares the bucket but has no `:id` route, so there is no id to
    // suppress; the collection roots name no existing asset either. Neither is
    // vault-sensitive, so a vaulted account's traffic on them is still counted
    // — and a non-vaulted account is unaffected everywhere.
    expect(FEATURE_BY_SEGMENT.search?.recordsAssetId).toBeUndefined();
    expect(isVaultSensitiveUnattributedAssetRequest('/api/v1/search?q=apple')).toBe(false);
    expect(isVaultSensitiveUnattributedAssetRequest('/api/v1/custom-assets')).toBe(false);
    expect(isVaultSensitiveUnattributedAssetRequest('/api/v1/portfolios')).toBe(false);
    // …while the per-asset routes stay covered whatever the method.
    expect(isVaultSensitiveUnattributedAssetRequest(`/api/v1/assets/${ID}/quote`)).toBe(true);
    expect(isVaultSensitiveUnattributedAssetRequest('/api/v1/assets/quotes?ids=a,b')).toBe(true);
  });
});

/**
 * Two re-materializations of the SAME day used to collide on the
 * `(day, feature)` primary key — an API read refreshing today while the 03:10
 * cron rolls it, or two API replicas doing it at once. Needs real Postgres:
 * PGlite is one connection, so it cannot hold two transactions open at once,
 * which is precisely the interleaving under test.
 */
describe('concurrent usage rollup', () => {
  it.skipIf(!REAL_DATABASE_URL)(
    're-materializes one day from two connections without colliding',
    async () => {
      const harness = await createTestApp();
      const user = await harness.seedUser({ email: 'rollup@test.dev', username: 'rollup_race' });
      harness.ctx.usageAnalytics.capture({ userId: user.id, feature: 'portfolio' });
      harness.ctx.usageAnalytics.capture({ userId: user.id, feature: 'assets', assetId: 'AAPL' });
      await harness.ctx.usageAnalytics.flush();
      const day = new Date().toISOString().slice(0, 10);

      const clientA = postgres(REAL_DATABASE_URL!, { max: 1 });
      const clientB = postgres(REAL_DATABASE_URL!, { max: 1 });
      try {
        const dbA = drizzlePostgres(clientA, { schema });
        const dbB = drizzlePostgres(clientB, { schema });
        // Each connection doubles as its own `lockDb` ONLY because this test
        // calls nothing but `rollupDay`, which never touches that pool. Do not
        // copy the pattern: the privacy-lock pool must stay dedicated (a
        // `max: 1` request pool self-deadlocks inside `upsertEvents`).
        const repoA = createUsageAnalyticsRepository(dbA, dbA);
        const repoB = createUsageAnalyticsRepository(dbB, dbB);

        // Repeated, because the losing interleaving is a race: the old
        // DELETE + INSERT raised 23505 whenever the second transaction's DELETE
        // ran before the first's INSERT committed.
        for (let round = 0; round < 3; round += 1) {
          await Promise.all([repoA.rollupDay(day), repoB.rollupDay(day)]);
        }

        const rows = await harness.db
          .select()
          .from(schema.usageDaily)
          .where(eq(schema.usageDaily.day, day));
        const features = rows.map((row) => row.feature).sort();
        // Exactly one row per (day, feature) — no duplicates, nothing lost.
        expect(features).toEqual(['*', 'assets', 'portfolio']);
        expect(rows.find((row) => row.feature === 'assets')?.events).toBe(1);
        expect(rows.find((row) => row.feature === '*')?.events).toBe(2);
      } finally {
        await clientA.end();
        await clientB.end();
      }
    },
  );
});
