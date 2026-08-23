import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as schema from '../data/schema';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * Constraint coverage for the V5 cash-fusion tables (migration 0075), driven
 * through the DRIZZLE definitions against the MIGRATED database — so it also
 * proves `data/schema.ts` and the hand-written `0076_cash_fusion.sql` agree: a
 * column or index that exists in only one of them fails here.
 *
 * `cashFusionMigration.test.ts` covers the data conversion; this file covers the
 * invariants the new shape has to hold forever.
 */
describe('cash fusion schema (migration 0075)', () => {
  let h: TestHarness;
  let userId: string;
  let otherUserId: string;
  let portfolioId: string;
  let sourceId: string;

  const insertMovement = async (
    values: Partial<typeof schema.portfolioCashMovements.$inferInsert> = {},
  ): Promise<string> => {
    const [row] = await h.db
      .insert(schema.portfolioCashMovements)
      .values({
        portfolioId,
        sourceId,
        kind: 'withdrawal',
        amountEur: '-10.00',
        executedAt: new Date('2026-05-01T00:00:00Z'),
        ...values,
      })
      .returning();
    return row!.id;
  };

  const insertTag = async (
    values: Partial<typeof schema.cashTags.$inferInsert> = {},
  ): Promise<string> => {
    const [row] = await h.db
      .insert(schema.cashTags)
      .values({ userId, name: 'Food', ...values })
      .returning();
    return row!.id;
  };

  beforeAll(async () => {
    h = await createTestApp();
    const admin = await h.seedAdmin({
      email: 'cashfusion@bettertrack.test',
      username: 'cashfusion',
    });
    userId = admin.id;
    const other = await h.seedUser({
      email: 'cashfusion-other@bettertrack.test',
      username: 'cashfusionother',
    });
    otherUserId = other.id;

    const [portfolio] = await h.db
      .insert(schema.portfolios)
      .values({ userId, name: 'Spending' })
      .returning();
    portfolioId = portfolio!.id;
    const [source] = await h.db
      .insert(schema.portfolioCashSources)
      .values({ portfolioId, name: 'Main', type: 'cash', isMain: true })
      .returning();
    sourceId = source!.id;
  });

  afterAll(async () => {
    await h.dispose();
  });

  describe('tags', () => {
    it('is case-insensitively unique per owner, and scoped to that owner', async () => {
      await insertTag({ name: 'Groceries' });
      await expect(insertTag({ name: 'groceries' })).rejects.toThrow(
        /cash_tags_user_name_lower_unique/,
      );
      // The SAME name for a different account is fine — tags are per user.
      await expect(
        h.db.insert(schema.cashTags).values({ userId: otherUserId, name: 'Groceries' }),
      ).resolves.toBeDefined();
    });

    it('ties `system` and `system_key` together in both directions', async () => {
      await expect(insertTag({ name: 'Half system', system: true })).rejects.toThrow(
        /cash_tags_system_key_iff_system/,
      );
      await expect(
        insertTag({ name: 'Half key', system: false, systemKey: 'dividend' }),
      ).rejects.toThrow(/cash_tags_system_key_iff_system/);
      await expect(
        insertTag({ name: 'Proper system', system: true, systemKey: 'dividend' }),
      ).resolves.toBeDefined();
    });

    it('allows one row per (owner, system key) and unlimited user tags', async () => {
      await expect(
        insertTag({ name: 'Second dividend', system: true, systemKey: 'dividend' }),
      ).rejects.toThrow(/cash_tags_user_system_key_unique/);
    });
  });

  describe('movement tags', () => {
    it('accepts many tags per movement but never the same tag twice', async () => {
      const movementId = await insertMovement();
      const food = await insertTag({ name: 'Multi food' });
      const drink = await insertTag({ name: 'Multi drink' });
      await h.db.insert(schema.cashMovementTags).values([
        { movementId, tagId: food },
        { movementId, tagId: drink },
      ]);
      await expect(
        h.db.insert(schema.cashMovementTags).values({ movementId, tagId: food }),
      ).rejects.toThrow(/cash_movement_tags_movement_tag_unique/);

      const rows = await h.db
        .select()
        .from(schema.cashMovementTags)
        .where(eq(schema.cashMovementTags.movementId, movementId));
      expect(rows).toHaveLength(2);
    });

    it('dies with its movement and with its tag, leaving the money untouched', async () => {
      const movementId = await insertMovement();
      const doomedTag = await insertTag({ name: 'Doomed tag' });
      await h.db.insert(schema.cashMovementTags).values({ movementId, tagId: doomedTag });

      // Deleting the TAG unlabels the row; the movement (and its amount) stays.
      await h.db.delete(schema.cashTags).where(eq(schema.cashTags.id, doomedTag));
      expect(
        await h.db
          .select()
          .from(schema.cashMovementTags)
          .where(eq(schema.cashMovementTags.movementId, movementId)),
      ).toHaveLength(0);
      expect(
        await h.db
          .select()
          .from(schema.portfolioCashMovements)
          .where(eq(schema.portfolioCashMovements.id, movementId)),
      ).toHaveLength(1);

      // Deleting the MOVEMENT drops its links.
      const tagId = await insertTag({ name: 'Surviving tag' });
      await h.db.insert(schema.cashMovementTags).values({ movementId, tagId });
      await h.db
        .delete(schema.portfolioCashMovements)
        .where(eq(schema.portfolioCashMovements.id, movementId));
      expect(
        await h.db
          .select()
          .from(schema.cashMovementTags)
          .where(eq(schema.cashMovementTags.tagId, tagId)),
      ).toHaveLength(0);
      expect(
        await h.db.select().from(schema.cashTags).where(eq(schema.cashTags.id, tagId)),
      ).toHaveLength(1);
    });
  });

  describe('budgets', () => {
    it('allows one recurring target per (portfolio, tag) — the partial index', async () => {
      const tagId = await insertTag({ name: 'Budgeted' });
      await h.db.insert(schema.cashBudgets).values({ portfolioId, tagId, amount: '300.00' });
      await expect(
        h.db.insert(schema.cashBudgets).values({ portfolioId, tagId, amount: '250.00' }),
      ).rejects.toThrow(/cash_budgets_portfolio_tag_recurring_unique/);
      // A month-specific override alongside the recurring one is legal…
      await expect(
        h.db
          .insert(schema.cashBudgets)
          .values({ portfolioId, tagId, periodKey: '2026-12', amount: '400.00' }),
      ).resolves.toBeDefined();
      // …but only once per month.
      await expect(
        h.db
          .insert(schema.cashBudgets)
          .values({ portfolioId, tagId, periodKey: '2026-12', amount: '410.00' }),
      ).rejects.toThrow(/cash_budgets_portfolio_tag_period_unique/);
    });

    it('rejects a non-positive amount and a malformed period', async () => {
      const tagId = await insertTag({ name: 'Guarded budget' });
      await expect(
        h.db.insert(schema.cashBudgets).values({ portfolioId, tagId, amount: '0.00' }),
      ).rejects.toThrow(/cash_budgets_amount_positive/);
      await expect(
        h.db
          .insert(schema.cashBudgets)
          .values({ portfolioId, tagId, periodKey: '2026-13', amount: '10.00' }),
      ).rejects.toThrow(/cash_budgets_period_key_format/);
      await expect(
        h.db
          .insert(schema.cashBudgets)
          .values({ portfolioId, tagId, periodKey: '2026-1', amount: '10.00' }),
      ).rejects.toThrow(/cash_budgets_period_key_format/);
    });

    it('claims a fired period exactly once — the alert idempotency key', async () => {
      const tagId = await insertTag({ name: 'Firing budget' });
      const [budget] = await h.db
        .insert(schema.cashBudgets)
        .values({ portfolioId, tagId, amount: '100.00' })
        .returning();
      const claim = h.db
        .insert(schema.cashBudgetFires)
        .values({ budgetId: budget!.id, periodKey: '2026-05' });
      await expect(claim).resolves.toBeDefined();
      await expect(
        h.db.insert(schema.cashBudgetFires).values({ budgetId: budget!.id, periodKey: '2026-05' }),
      ).rejects.toThrow(/cash_budget_fires_period_unique/);
      // A different month may fire.
      await expect(
        h.db.insert(schema.cashBudgetFires).values({ budgetId: budget!.id, periodKey: '2026-06' }),
      ).resolves.toBeDefined();

      // The budget's markers die with it.
      await h.db.delete(schema.cashBudgets).where(eq(schema.cashBudgets.id, budget!.id));
      expect(
        await h.db
          .select()
          .from(schema.cashBudgetFires)
          .where(eq(schema.cashBudgetFires.budgetId, budget!.id)),
      ).toHaveLength(0);
    });

    it('dies with its tag (the semantics expense_budgets already had)', async () => {
      const tagId = await insertTag({ name: 'Cascading budget tag' });
      await h.db.insert(schema.cashBudgets).values({ portfolioId, tagId, amount: '50.00' });
      await h.db.delete(schema.cashTags).where(eq(schema.cashTags.id, tagId));
      expect(
        await h.db.select().from(schema.cashBudgets).where(eq(schema.cashBudgets.tagId, tagId)),
      ).toHaveLength(0);
    });
  });

  describe('rules', () => {
    it('carries many tags, each at most once, and cascades both ways', async () => {
      const [rule] = await h.db
        .insert(schema.cashRules)
        .values({ userId, matchType: 'contains', pattern: 'REWE', priority: 5 })
        .returning();
      const a = await insertTag({ name: 'Rule tag A' });
      const b = await insertTag({ name: 'Rule tag B' });
      await h.db.insert(schema.cashRuleTags).values([
        { ruleId: rule!.id, tagId: a },
        { ruleId: rule!.id, tagId: b },
      ]);
      await expect(
        h.db.insert(schema.cashRuleTags).values({ ruleId: rule!.id, tagId: a }),
      ).rejects.toThrow(/cash_rule_tags_rule_tag_unique/);

      await h.db.delete(schema.cashTags).where(eq(schema.cashTags.id, a));
      expect(
        await h.db
          .select()
          .from(schema.cashRuleTags)
          .where(eq(schema.cashRuleTags.ruleId, rule!.id)),
      ).toHaveLength(1);

      await h.db.delete(schema.cashRules).where(eq(schema.cashRules.id, rule!.id));
      expect(
        await h.db
          .select()
          .from(schema.cashRuleTags)
          .where(eq(schema.cashRuleTags.ruleId, rule!.id)),
      ).toHaveLength(0);
    });
  });

  describe('the two new movement columns', () => {
    it('dedupes an import per portfolio while leaving hand entries alone', async () => {
      await insertMovement({ dedupHash: 'statement-row-1' });
      await expect(insertMovement({ dedupHash: 'statement-row-1' })).rejects.toThrow(
        /portfolio_cash_movements_dedup_unique/,
      );
      // NULL hashes are distinct — any number of manual rows coexist.
      await expect(insertMovement()).resolves.toBeDefined();
      await expect(insertMovement()).resolves.toBeDefined();

      // A second portfolio is a second ledger: the same statement may land there.
      const [second] = await h.db
        .insert(schema.portfolios)
        .values({ userId, name: 'Second ledger' })
        .returning();
      const [secondSource] = await h.db
        .insert(schema.portfolioCashSources)
        .values({ portfolioId: second!.id, name: 'Main', type: 'cash', isMain: true })
        .returning();
      await expect(
        h.db.insert(schema.portfolioCashMovements).values({
          portfolioId: second!.id,
          sourceId: secondSource!.id,
          kind: 'withdrawal',
          amountEur: '-10.00',
          executedAt: new Date('2026-05-01T00:00:00Z'),
          dedupHash: 'statement-row-1',
        }),
      ).resolves.toBeDefined();
    });

    it('keeps "NULL means EUR" a true invariant', async () => {
      await expect(insertMovement({ originalCurrency: 'EUR' })).rejects.toThrow(
        /portfolio_cash_movements_original_currency_not_eur/,
      );
      const id = await insertMovement({ originalCurrency: 'USD' });
      const [row] = await h.db
        .select()
        .from(schema.portfolioCashMovements)
        .where(eq(schema.portfolioCashMovements.id, id));
      expect(row?.originalCurrency).toBe('USD');
      expect(row?.amountEur).toBe('-10.000000');
    });
  });

  it('cascades every cash-flow table away with the account', async () => {
    const victim = await h.seedUser({
      email: 'cashfusion-victim@bettertrack.test',
      username: 'cashfusionvictim',
    });
    const [portfolio] = await h.db
      .insert(schema.portfolios)
      .values({ userId: victim.id, name: 'Spending' })
      .returning();
    const [source] = await h.db
      .insert(schema.portfolioCashSources)
      .values({ portfolioId: portfolio!.id, name: 'Main', type: 'cash', isMain: true })
      .returning();
    const [movement] = await h.db
      .insert(schema.portfolioCashMovements)
      .values({
        portfolioId: portfolio!.id,
        sourceId: source!.id,
        kind: 'withdrawal',
        amountEur: '-25.00',
        executedAt: new Date('2026-05-02T00:00:00Z'),
      })
      .returning();
    const [tag] = await h.db
      .insert(schema.cashTags)
      .values({ userId: victim.id, name: 'Victim food' })
      .returning();
    await h.db.insert(schema.cashMovementTags).values({ movementId: movement!.id, tagId: tag!.id });
    const [budget] = await h.db
      .insert(schema.cashBudgets)
      .values({ portfolioId: portfolio!.id, tagId: tag!.id, amount: '99.00' })
      .returning();
    await h.db
      .insert(schema.cashBudgetFires)
      .values({ budgetId: budget!.id, periodKey: '2026-05' });
    const [rule] = await h.db
      .insert(schema.cashRules)
      .values({ userId: victim.id, pattern: 'VICTIM' })
      .returning();
    await h.db.insert(schema.cashRuleTags).values({ ruleId: rule!.id, tagId: tag!.id });

    await h.db.delete(schema.users).where(eq(schema.users.id, victim.id));

    expect(
      await h.db.select().from(schema.cashTags).where(eq(schema.cashTags.userId, victim.id)),
    ).toHaveLength(0);
    expect(
      await h.db.select().from(schema.cashRules).where(eq(schema.cashRules.userId, victim.id)),
    ).toHaveLength(0);
    expect(
      await h.db
        .select()
        .from(schema.cashMovementTags)
        .where(eq(schema.cashMovementTags.tagId, tag!.id)),
    ).toHaveLength(0);
    expect(
      await h.db.select().from(schema.cashRuleTags).where(eq(schema.cashRuleTags.ruleId, rule!.id)),
    ).toHaveLength(0);
    expect(
      await h.db.select().from(schema.cashBudgets).where(eq(schema.cashBudgets.id, budget!.id)),
    ).toHaveLength(0);
    expect(
      await h.db
        .select()
        .from(schema.cashBudgetFires)
        .where(eq(schema.cashBudgetFires.budgetId, budget!.id)),
    ).toHaveLength(0);
    // …and the cascade is OWNER-SCOPED: the other account's identically named tag
    // is untouched (no cross-account deletion).
    expect(
      await h.db
        .select()
        .from(schema.cashTags)
        .where(and(eq(schema.cashTags.userId, otherUserId), eq(schema.cashTags.name, 'Groceries'))),
    ).toHaveLength(1);
  });
});
