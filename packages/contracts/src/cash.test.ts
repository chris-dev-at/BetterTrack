import { describe, expect, it } from 'vitest';

import {
  CASH_RULE_MATCH_TYPES,
  CASH_SYSTEM_TAGS,
  CASH_SYSTEM_TAG_KEYS,
  CASH_TAGS_PER_ITEM_MAX,
  cashBudgetSchema,
  cashMonthSchema,
  cashRuleSchema,
  cashTagSchema,
  createCashBudgetRequestSchema,
  createCashRuleRequestSchema,
  createCashTagRequestSchema,
  setCashMovementTagsRequestSchema,
  updateCashBudgetRequestSchema,
  updateCashRuleRequestSchema,
  updateCashTagRequestSchema,
} from './cash';
import { cashMovementSchema } from './portfolio';

const UUID = '019756a0-0075-7000-8000-000000000001';
const UUID2 = '019756a0-0075-7000-8000-000000000002';
const NOW = '2026-07-30T10:00:00.000Z';

describe('cash-flow contracts (V5 cash fusion)', () => {
  describe('system tags', () => {
    it('names one entry per key, with unique keys, names and #RRGGBB tints', () => {
      expect(CASH_SYSTEM_TAGS.map((t) => t.key)).toEqual([...CASH_SYSTEM_TAG_KEYS]);
      expect(new Set(CASH_SYSTEM_TAGS.map((t) => t.name)).size).toBe(CASH_SYSTEM_TAGS.length);
      // Names must also be unique CASE-INSENSITIVELY — `cash_tags` is uniquely
      // indexed on lower(name), so two seeds differing only in case cannot coexist.
      expect(new Set(CASH_SYSTEM_TAGS.map((t) => t.name.toLowerCase())).size).toBe(
        CASH_SYSTEM_TAGS.length,
      );
      for (const tag of CASH_SYSTEM_TAGS) expect(tag.color).toMatch(/^#[0-9a-f]{6}$/);
    });

    it('covers the ledger kinds an engine has to be able to label', () => {
      // deposit/withdrawal/buy/sell_proceeds/transfer/dividend/tax all need a home;
      // interest + fees exist for bank-statement rows the ledger has no kind for.
      expect(CASH_SYSTEM_TAG_KEYS).toContain('investment');
      expect(CASH_SYSTEM_TAG_KEYS).toContain('sale_proceeds');
      expect(CASH_SYSTEM_TAG_KEYS).toContain('dividend');
      expect(CASH_SYSTEM_TAG_KEYS).toContain('tax');
      expect(CASH_SYSTEM_TAG_KEYS).toContain('transfer');
      expect(CASH_SYSTEM_TAG_KEYS).toContain('deposit');
      expect(CASH_SYSTEM_TAG_KEYS).toContain('withdrawal');
    });
  });

  describe('tags', () => {
    const tag = {
      id: UUID,
      name: 'Food',
      color: '#ff0000',
      system: false,
      systemKey: null,
      createdAt: NOW,
      updatedAt: NOW,
    };

    it('round-trips a user tag and an app-owned one', () => {
      expect(cashTagSchema.parse(tag)).toEqual(tag);
      const system = { ...tag, name: 'Tax', system: true, systemKey: 'tax' as const };
      expect(cashTagSchema.parse(system)).toEqual(system);
    });

    it('rejects an unknown system key and any unknown field', () => {
      expect(cashTagSchema.safeParse({ ...tag, systemKey: 'groceries' }).success).toBe(false);
      expect(cashTagSchema.safeParse({ ...tag, extra: 1 }).success).toBe(false);
    });

    it('takes a trimmed name and an optional colour on create', () => {
      expect(createCashTagRequestSchema.parse({ name: '  Food  ' })).toEqual({ name: 'Food' });
      expect(createCashTagRequestSchema.safeParse({ name: '   ' }).success).toBe(false);
      expect(createCashTagRequestSchema.safeParse({ name: 'Food', color: 'red' }).success).toBe(
        false,
      );
      expect(createCashTagRequestSchema.parse({ name: 'Food', color: '#0A0b0C' })).toEqual({
        name: 'Food',
        color: '#0A0b0C',
      });
    });

    it('never lets a client set `system` or `systemKey`', () => {
      expect(createCashTagRequestSchema.safeParse({ name: 'Fake', system: true }).success).toBe(
        false,
      );
      expect(createCashTagRequestSchema.safeParse({ name: 'Fake', systemKey: 'tax' }).success).toBe(
        false,
      );
      expect(updateCashTagRequestSchema.safeParse({ systemKey: 'tax' }).success).toBe(false);
      expect(updateCashTagRequestSchema.safeParse({ system: false }).success).toBe(false);
      // Renaming and re-tinting stay allowed (a system tag is addressed by key).
      expect(updateCashTagRequestSchema.parse({ name: 'Steuer' })).toEqual({ name: 'Steuer' });
    });
  });

  describe('movement tags', () => {
    it('replaces the whole set, and an empty set means untagged', () => {
      expect(setCashMovementTagsRequestSchema.parse({ tagIds: [] })).toEqual({ tagIds: [] });
      expect(setCashMovementTagsRequestSchema.parse({ tagIds: [UUID, UUID2] })).toEqual({
        tagIds: [UUID, UUID2],
      });
    });

    it('accepts a repeated id (the unique key makes it a no-op) but bounds the set', () => {
      expect(setCashMovementTagsRequestSchema.parse({ tagIds: [UUID, UUID] }).tagIds).toHaveLength(
        2,
      );
      const tooMany = Array.from({ length: CASH_TAGS_PER_ITEM_MAX + 1 }, () => UUID);
      expect(setCashMovementTagsRequestSchema.safeParse({ tagIds: tooMany }).success).toBe(false);
      expect(setCashMovementTagsRequestSchema.safeParse({ tagIds: ['nope'] }).success).toBe(false);
    });
  });

  describe('budgets', () => {
    it('treats a null period as the recurring monthly target', () => {
      const budget = {
        id: UUID,
        portfolioId: UUID2,
        tagId: UUID,
        period: null,
        amount: 300,
        currency: 'EUR',
        createdAt: NOW,
        updatedAt: NOW,
      };
      expect(cashBudgetSchema.parse(budget).period).toBeNull();
      expect(cashBudgetSchema.parse({ ...budget, period: '2026-12' }).period).toBe('2026-12');
    });

    it('defaults the currency and accepts an omitted period on create', () => {
      const parsed = createCashBudgetRequestSchema.parse({
        portfolioId: UUID,
        tagId: UUID2,
        amount: 300,
      });
      expect(parsed).toEqual({ portfolioId: UUID, tagId: UUID2, amount: 300, currency: 'EUR' });
    });

    it('validates the month and refuses a non-positive or non-finite amount', () => {
      expect(cashMonthSchema.safeParse('2026-13').success).toBe(false);
      expect(cashMonthSchema.safeParse('2026-00').success).toBe(false);
      expect(cashMonthSchema.safeParse('2026-1').success).toBe(false);
      expect(cashMonthSchema.parse('2026-01')).toBe('2026-01');
      for (const amount of [0, -1, Number.POSITIVE_INFINITY, Number.NaN, 1e13]) {
        expect(
          createCashBudgetRequestSchema.safeParse({ portfolioId: UUID, tagId: UUID2, amount })
            .success,
          `amount ${amount} must be rejected`,
        ).toBe(false);
      }
    });

    it('pins the portfolio, tag and period at creation (a move is delete + create)', () => {
      expect(updateCashBudgetRequestSchema.parse({ amount: 400 })).toEqual({ amount: 400 });
      for (const field of ['portfolioId', 'tagId', 'period']) {
        expect(
          updateCashBudgetRequestSchema.safeParse({ amount: 400, [field]: UUID }).success,
          `${field} must not be patchable`,
        ).toBe(false);
      }
    });
  });

  describe('rules', () => {
    it('carries a tag SET and defaults matchType/priority/enabled', () => {
      expect(createCashRuleRequestSchema.parse({ tagIds: [UUID], pattern: 'REWE' })).toEqual({
        tagIds: [UUID],
        pattern: 'REWE',
        matchType: 'contains',
        priority: 0,
        enabled: true,
      });
      expect(CASH_RULE_MATCH_TYPES).toEqual(['contains', 'equals', 'starts_with', 'regex']);
    });

    it('refuses a rule that could never do anything', () => {
      expect(createCashRuleRequestSchema.safeParse({ tagIds: [], pattern: 'REWE' }).success).toBe(
        false,
      );
      expect(createCashRuleRequestSchema.safeParse({ tagIds: [UUID], pattern: '  ' }).success).toBe(
        false,
      );
      expect(updateCashRuleRequestSchema.safeParse({ tagIds: [] }).success).toBe(false);
    });

    it('keeps priority a bounded integer (evaluation order, first match wins)', () => {
      expect(
        cashRuleSchema.safeParse({
          id: UUID,
          tagIds: [UUID2],
          matchType: 'regex',
          pattern: '^REWE',
          priority: 5,
          enabled: true,
          createdAt: NOW,
          updatedAt: NOW,
        }).success,
      ).toBe(true);
      for (const priority of [-1, 1.5, 10_001]) {
        expect(
          createCashRuleRequestSchema.safeParse({ tagIds: [UUID], pattern: 'x', priority }).success,
          `priority ${priority} must be rejected`,
        ).toBe(false);
      }
    });
  });

  describe('the additive cash-movement overlay', () => {
    const preFusion = {
      id: UUID,
      kind: 'withdrawal' as const,
      amountEur: -12.34,
      sourceId: UUID2,
      transactionId: null,
      transferId: null,
      counterpartSourceId: null,
      dividendId: null,
      taxYear: null,
      executedAt: NOW,
      note: 'REWE Wien',
      source: 'manual',
      createdAt: NOW,
    };

    it('still parses a pre-fusion movement fixture unchanged', () => {
      expect(cashMovementSchema.parse(preFusion)).toEqual(preFusion);
    });

    it('carries the tag set and the non-EUR provenance when present', () => {
      const fused = { ...preFusion, tags: [UUID2], originalCurrency: 'USD' };
      expect(cashMovementSchema.parse(fused)).toEqual(fused);
      expect(
        cashMovementSchema.parse({ ...preFusion, tags: [], originalCurrency: null }).tags,
      ).toEqual([]);
    });
  });
});
