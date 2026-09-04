import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usageAnalyticsResponseSchema } from '@bettertrack/contracts';

import type { UsageAnalyticsRepository } from '../data/repositories/usageAnalyticsRepository';
import { createUsageAnalyticsService } from '../services/analytics/usageAnalyticsService';
import { flushTelemetryBuffers } from '../shutdown';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

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

  it('does not arm the throttle when the rollup fails — the next read retries', async () => {
    const repo = createFakeRepo();
    const clock = Date.parse('2026-09-04T10:00:00.000Z');
    const service = createUsageAnalyticsService({ repo, now: () => clock });
    const failing = vi
      .spyOn(repo, 'rollupDay')
      .mockRejectedValueOnce(new Error('rollup transaction failed'));

    await expect(service.overview()).rejects.toThrow(/rollup transaction failed/);
    failing.mockRestore();

    await service.overview();
    expect(repo.rollupDays).toEqual(['2026-09-04']);
  });
});
