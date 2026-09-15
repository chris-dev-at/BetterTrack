import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { createUsageAnalyticsRepository } from '../../../data/repositories/usageAnalyticsRepository';
import * as schema from '../../../data/schema';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';

/**
 * The durable activation marker (#1680, §13.5 V5-P2 arc (b)).
 *
 * The registration funnel's `activated` stage is a LIFETIME figure, but it used
 * to be `count(distinct user_id)` over `usage_events` — a table #1614/#1664 gave
 * a retention window. Once an instance outlives `BT_USAGE_EVENT_RETENTION_DAYS`,
 * every dormant account silently dropped out of the count, so registered→
 * activated decayed month over month and read as an activation collapse that
 * never happened. These cases pin the fix: activation now lives in
 * `usage_activations`, written at the same admitted write boundary and never
 * swept — and the windowed metrics, which legitimately read raw events, are
 * pinned unchanged alongside it.
 */

const DAY_MS = 86_400_000;
/** Well past the 180-day default retention window. */
const ANCIENT = new Date(Date.now() - 400 * DAY_MS);
const RETENTION_CUTOFF = new Date(Date.now() - 180 * DAY_MS);

describe('durable activation marker', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestApp();
  });

  /** The repository under its real constructor shape (lock pool = db in tests). */
  const repo = () => createUsageAnalyticsRepository(harness.db, harness.db);

  const activationRows = (userId: string) =>
    harness.db
      .select()
      .from(schema.usageActivations)
      .where(eq(schema.usageActivations.userId, userId));

  const eventRows = (userId: string) =>
    harness.db.select().from(schema.usageEvents).where(eq(schema.usageEvents.userId, userId));

  it('keeps a user activated after the retention sweep removed every one of their events', async () => {
    const dormant = await harness.seedUser({ email: 'dormant@test.dev', username: 'dormant' });
    harness.ctx.usageAnalytics.capture({
      userId: dormant.id,
      feature: 'portfolio',
      occurredAt: ANCIENT,
    });
    await harness.ctx.usageAnalytics.flush();
    expect(await eventRows(dormant.id)).toHaveLength(1);
    expect(await repo().activatedUsers()).toBe(1);

    // The retention sweep's real entry point, with the default window.
    expect(await repo().deleteEventsOlderThan(RETENTION_CUTOFF, 500)).toBe(1);

    expect(await eventRows(dormant.id)).toEqual([]);
    expect(await activationRows(dormant.id)).toHaveLength(1);
    expect(await repo().activatedUsers()).toBe(1);
  });

  it('holds the funnel registered→activated figure steady across a retention sweep', async () => {
    const dormant = await harness.seedUser({ email: 'gone@test.dev', username: 'gone' });
    const current = await harness.seedUser({ email: 'here@test.dev', username: 'here' });
    harness.ctx.usageAnalytics.capture({
      userId: dormant.id,
      feature: 'assets',
      assetId: 'AAPL',
      occurredAt: ANCIENT,
    });
    harness.ctx.usageAnalytics.capture({ userId: current.id, feature: 'portfolio' });
    await harness.ctx.usageAnalytics.flush();

    const funnelOf = async () => {
      const overview = await harness.ctx.usageAnalytics.overview();
      return Object.fromEntries(overview.funnel.map((stage) => [stage.stage, stage.count]));
    };

    const before = await funnelOf();
    expect(before.activated).toBe(2);
    expect(before.registered).toBeGreaterThanOrEqual(2);

    await repo().deleteEventsOlderThan(RETENTION_CUTOFF, 500);

    const after = await funnelOf();
    expect(after.activated).toBe(before.activated);
    expect(after.registered).toBe(before.registered);
  });

  it('marks first counted activity once and never moves or duplicates the marker', async () => {
    const user = await harness.seedUser({ email: 'first@test.dev', username: 'first' });
    const firstHit = new Date(Date.now() - 3 * DAY_MS);
    harness.ctx.usageAnalytics.capture({
      userId: user.id,
      feature: 'portfolio',
      occurredAt: firstHit,
    });
    await harness.ctx.usageAnalytics.flush();

    const [initial] = await activationRows(user.id);
    expect(initial).toBeDefined();
    expect(initial?.firstActiveAt.getTime()).toBe(firstHit.getTime());

    // More activity, on a later day and on a different feature: idempotent.
    harness.ctx.usageAnalytics.capture({ userId: user.id, feature: 'workboard' });
    harness.ctx.usageAnalytics.capture({ userId: user.id, feature: 'portfolio' });
    await harness.ctx.usageAnalytics.flush();
    // …and a second flush of the same shape, the retry case.
    harness.ctx.usageAnalytics.capture({ userId: user.id, feature: 'workboard' });
    await harness.ctx.usageAnalytics.flush();

    const rows = await activationRows(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.firstActiveAt.getTime()).toBe(firstHit.getTime());
    expect(await repo().activatedUsers()).toBe(1);
  });

  /**
   * §6.12: "first-party only; vaulted/paranoid data never counted". The marker
   * is written from the ADMITTED set inside the same held lock, so every
   * suppression that keeps a row out of `usage_events` keeps the user out of the
   * activated count too — before this change (no marker at all) and after it.
   */
  describe('never counts vaulted or paranoid activity', () => {
    it('writes no marker for a paranoid account', async () => {
      const user = await harness.seedUser({ email: 'para@test.dev', username: 'para' });
      await harness.db
        .update(schema.users)
        .set({ privacyMode: 'paranoid', paranoidMediaSet: ['server'] })
        .where(eq(schema.users.id, user.id));

      // Straight at the write boundary — the middleware drops these earlier, so
      // this is the second line of defence being tested, not the first.
      harness.ctx.usageAnalytics.capture({ userId: user.id, feature: 'assets', assetId: 'AAPL' });
      harness.ctx.usageAnalytics.capture({ userId: user.id, feature: 'portfolio' });
      await harness.ctx.usageAnalytics.flush();

      expect(await eventRows(user.id)).toEqual([]);
      expect(await activationRows(user.id)).toEqual([]);
      expect(await repo().activatedUsers()).toBe(0);
    });

    it('writes no marker for activity attributed to a vaulted portfolio', async () => {
      const user = await harness.seedUser({ email: 'vaulted@test.dev', username: 'vaulted' });
      const [vault] = await harness.db
        .insert(schema.vaults)
        .values({
          userId: user.id,
          name: 'Locked',
          headerDocId: '018f6a3e-bbbb-7000-8000-000000000001',
          commonDocId: '018f6a3e-bbbb-7000-8000-000000000002',
          media: ['server'],
          // Deterministic TEST VECTORS, not secrets (mirrors accountDeletion).
          retirementProofPublicKey: 'MCowBQYDK2VwAyEA' + 'A'.repeat(27) + '=',
          keyFingerprint: 'Abcdef0123456789',
        })
        .returning();
      const [portfolio] = await harness.db
        .insert(schema.portfolios)
        .values({ userId: user.id, name: 'Vaulted', vaultId: vault?.id, vaultAlias: 'Locked' })
        .returning();

      harness.ctx.usageAnalytics.capture({
        userId: user.id,
        feature: 'portfolio',
        targetPortfolioId: portfolio?.id,
      });
      // The quote read with no portfolio attribution, from an account that owns
      // a vaulted portfolio — the holdings-roster leak's own suppression.
      harness.ctx.usageAnalytics.capture({
        userId: user.id,
        feature: 'assets',
        assetId: 'AAPL',
        suppressIfAnyVault: true,
      });
      await harness.ctx.usageAnalytics.flush();

      expect(await eventRows(user.id)).toEqual([]);
      expect(await activationRows(user.id)).toEqual([]);
      expect(await repo().activatedUsers()).toBe(0);
    });
  });

  /**
   * The other half of the contract: this issue must not move numbers that were
   * already right. Same fixture as the arc's main integration case, asserted
   * through the service.
   */
  it('leaves DAU/WAU/MAU, feature counters and top assets unchanged inside the window', async () => {
    const alice = await harness.seedUser({ email: 'alice2@test.dev', username: 'alice2' });
    const bob = await harness.seedUser({ email: 'bob2@test.dev', username: 'bob2' });
    harness.ctx.usageAnalytics.capture({ userId: alice.id, feature: 'portfolio' });
    harness.ctx.usageAnalytics.capture({ userId: alice.id, feature: 'assets', assetId: 'AAPL' });
    harness.ctx.usageAnalytics.capture({ userId: alice.id, feature: 'assets', assetId: 'AAPL' });
    harness.ctx.usageAnalytics.capture({ userId: bob.id, feature: 'workboard' });
    harness.ctx.usageAnalytics.capture({ userId: bob.id, feature: 'assets', assetId: 'MSFT' });
    // Inside the 30-day reporting window but not today, so WAU/MAU differ from DAU.
    harness.ctx.usageAnalytics.capture({
      userId: bob.id,
      feature: 'social',
      occurredAt: new Date(Date.now() - 10 * DAY_MS),
    });
    await harness.ctx.usageAnalytics.flush();
    await harness.ctx.usageAnalytics.rollupRecent(30);

    const overview = await harness.ctx.usageAnalytics.overview();
    expect(overview.activeUsers).toEqual({ daily: 2, weekly: 2, monthly: 2 });
    expect(Object.fromEntries(overview.features.map((f) => [f.feature, f.events]))).toEqual({
      assets: 3,
      portfolio: 1,
      workboard: 1,
      social: 1,
    });
    expect(overview.topAssets).toEqual([
      { assetId: 'AAPL', views: 2 },
      { assetId: 'MSFT', views: 1 },
    ]);
    expect(overview.windowDays).toBe(30);
  });
});
