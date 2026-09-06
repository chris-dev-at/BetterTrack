import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../schema';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import {
  createPortfolioSnapshotRepository,
  type NewSnapshotRow,
  type PortfolioSnapshotRepository,
} from '../portfolioSnapshotRepository';

/**
 * The snapshot writer's compare-and-set (issue #1729).
 *
 * `saveComputation` may only commit rows — and only clear `dirty_from` — when
 * the state row it is writing over is EXACTLY the one the computation read its
 * inputs against. Two ways that used to fail silently are pinned here: a state
 * row that appears after the CAS on a portfolio that had none (where
 * `SELECT … FOR UPDATE` locks nothing), and two distinct state writes landing
 * inside one millisecond (where a `Date`-precision comparison reads them as the
 * same write). Both end with the same damage: a persisted computation that
 * never saw the invalidation it just cleared, on rows the 35-day nightly heal
 * window will never revisit.
 */

const ROW: NewSnapshotRow = {
  date: '2026-01-02',
  valueEur: 1000,
  costBasisEur: 800,
  plEur: 200,
  flowEur: 0,
  cashBySource: {},
  assetValues: {},
};

describe('portfolio snapshot repository — saveComputation compare-and-set (#1729)', () => {
  let h: TestHarness;
  let repo: PortfolioSnapshotRepository;
  let portfolioId: string;

  beforeEach(async () => {
    h = await createTestApp();
    repo = createPortfolioSnapshotRepository(h.db);
    const user = await h.seedUser();
    const [portfolio] = await h.db
      .insert(schema.portfolios)
      .values({ userId: user.id, name: 'Snapshots', sortOrder: 0 })
      .returning({ id: schema.portfolios.id });
    portfolioId = portfolio!.id;
  });

  it('commits and clears the marker when the state row is exactly the one it read', async () => {
    await repo.markDirty(portfolioId, '2026-01-02');
    const seen = await repo.getState(portfolioId);
    expect(seen?.dirtyFrom).toBe('2026-01-02');

    const result = await repo.saveComputation({
      portfolioId,
      rows: [ROW],
      computedThrough: '2026-01-02',
      seenVersion: seen!.version,
      seenDirtyFrom: seen!.dirtyFrom,
    });

    expect(result.applied).toBe(true);
    expect((await repo.listForPortfolio(portfolioId)).map((r) => r.date)).toEqual(['2026-01-02']);
    const after = await repo.getState(portfolioId);
    expect(after?.dirtyFrom ?? null).toBeNull();
    expect(after?.computedThrough).toBe('2026-01-02');
    // A write happened, so the fencing token moved.
    expect(after?.version).not.toBe(seen!.version);
  });

  it('rolls back a computation whose state row was created after the compare-and-set', async () => {
    expect(await repo.getState(portfolioId)).toBeNull();

    // The window this covers: with no state row, `SELECT … FOR UPDATE` locks
    // NOTHING, and `markDirty` is a plain INSERT that blocks on nothing — so an
    // invalidation can land between the CAS and the state upsert. A trigger is
    // the only way to hit that exact instant deterministically. The marker it
    // writes rolls back with the transaction (a real concurrent markDirty, in
    // its own transaction, would survive); what is asserted is what the
    // COMPUTATION committed, which is the half the race can corrupt.
    await h.db.execute(sql`
      CREATE FUNCTION "bt_race_mark_dirty"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO "portfolio_snapshot_state" ("portfolio_id", "computed_through", "dirty_from")
        VALUES (NEW."portfolio_id", NEW."date", NEW."date")
        ON CONFLICT DO NOTHING;
        RETURN NULL;
      END;
      $$
    `);
    await h.db.execute(sql`
      CREATE TRIGGER "bt_race_mark_dirty_tr" AFTER INSERT ON "portfolio_daily_snapshots"
      FOR EACH ROW EXECUTE FUNCTION "bt_race_mark_dirty"()
    `);

    try {
      const result = await repo.saveComputation({
        portfolioId,
        rows: [ROW],
        computedThrough: '2026-01-02',
        seenVersion: null,
        seenDirtyFrom: null,
      });
      expect(result.applied).toBe(false);
    } finally {
      await h.db.execute(sql`DROP TRIGGER "bt_race_mark_dirty_tr" ON "portfolio_daily_snapshots"`);
      await h.db.execute(sql`DROP FUNCTION "bt_race_mark_dirty"()`);
    }

    // Nothing survived: no rows, and no state row claiming they are clean.
    expect(await repo.listForPortfolio(portfolioId)).toEqual([]);
    expect(await repo.getState(portfolioId)).toBeNull();
  });

  it('rejects a computation whose state row was rewritten inside the same millisecond', async () => {
    // `timestamptz` stores microseconds; a JS Date keeps milliseconds. These two
    // writes are 100 µs apart — distinct rows to the database, indistinguishable
    // to `updatedAt.getTime()`.
    await h.db.execute(sql`
      INSERT INTO "portfolio_snapshot_state" ("portfolio_id", "computed_through", "dirty_from", "updated_at")
      VALUES (${portfolioId}, '2026-01-01', NULL, '2026-01-01T00:00:00.000100Z'::timestamptz)
    `);
    const seen = await repo.getState(portfolioId);
    expect(seen?.version).toBe('2026-01-01T00:00:00.000100Z');
    expect(seen?.updatedAt.getTime()).toBe(Date.parse('2026-01-01T00:00:00.000Z'));

    // The invalidation this computation must not clear.
    await h.db.execute(sql`
      UPDATE "portfolio_snapshot_state"
      SET "dirty_from" = '2026-01-01', "updated_at" = '2026-01-01T00:00:00.000200Z'::timestamptz
      WHERE "portfolio_id" = ${portfolioId}
    `);

    const result = await repo.saveComputation({
      portfolioId,
      rows: [ROW],
      computedThrough: '2026-01-02',
      seenVersion: seen!.version,
      seenDirtyFrom: null,
    });

    expect(result.applied).toBe(false);
    expect(await repo.listForPortfolio(portfolioId)).toEqual([]);
    const after = await repo.getState(portfolioId);
    expect(after?.dirtyFrom).toBe('2026-01-01');
  });
});
