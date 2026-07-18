import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usageAnalyticsResponseSchema } from '@bettertrack/contracts';

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
