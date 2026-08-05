import { describe, expect, it } from 'vitest';

import {
  MAX_CASH_AMOUNT_EUR,
  cashEntryRequestSchema,
  cashMovementKindSchema,
  cashMovementsQuerySchema,
  cashPreviewRequestSchema,
  importSourceTag,
  sourceTagSchema,
  transactionListQuerySchema,
} from './portfolio';

describe('cash amount validation (§14 hardening)', () => {
  it('accepts a normal positive magnitude', () => {
    expect(cashEntryRequestSchema.safeParse({ amountEur: 1000 }).success).toBe(true);
    expect(cashEntryRequestSchema.safeParse({ amountEur: MAX_CASH_AMOUNT_EUR }).success).toBe(true);
  });

  it('rejects a non-finite amount rather than letting Infinity reach the ledger', () => {
    // A finite guard: without it, zod `.number()` admits Infinity, which reaches
    // Postgres `numeric(20,6)` as a 500 instead of a clean 400.
    expect(cashEntryRequestSchema.safeParse({ amountEur: Infinity }).success).toBe(false);
    expect(cashEntryRequestSchema.safeParse({ amountEur: -Infinity }).success).toBe(false);
    expect(cashEntryRequestSchema.safeParse({ amountEur: Number.NaN }).success).toBe(false);
  });

  it('rejects an amount beyond the representable ledger range', () => {
    expect(cashEntryRequestSchema.safeParse({ amountEur: MAX_CASH_AMOUNT_EUR + 1 }).success).toBe(
      false,
    );
    expect(cashEntryRequestSchema.safeParse({ amountEur: 1e300 }).success).toBe(false);
  });

  it('still rejects zero and negative magnitudes', () => {
    expect(cashEntryRequestSchema.safeParse({ amountEur: 0 }).success).toBe(false);
    expect(cashEntryRequestSchema.safeParse({ amountEur: -5 }).success).toBe(false);
  });

  it('applies the same bounds to the preview schema', () => {
    expect(cashPreviewRequestSchema.safeParse({ kind: 'deposit', amountEur: 50 }).success).toBe(
      true,
    );
    expect(
      cashPreviewRequestSchema.safeParse({ kind: 'deposit', amountEur: Infinity }).success,
    ).toBe(false);
    expect(cashPreviewRequestSchema.safeParse({ kind: 'deposit', amountEur: 1e300 }).success).toBe(
      false,
    );
  });
});

describe('cash movement kinds (§16 2026-07-30 — the `fee` kind)', () => {
  it('pins the wire enum, `fee` included', () => {
    // `packages/contracts` depends on zod alone (never on `@bettertrack/domain`),
    // so it cannot assert agreement with `CASH_MOVEMENT_KINDS` here — the real
    // three-way cross-check against the domain list AND the Postgres enum lives
    // in apps/api/src/__tests__/cashFee.test.ts, where all three are in scope.
    // This is the change detector for the wire shape itself.
    expect([...cashMovementKindSchema.options].sort()).toEqual(
      [
        'buy',
        'deposit',
        'dividend',
        'fee',
        'sell_proceeds',
        'tax_refund',
        'tax_withholding',
        'transfer_in',
        'transfer_out',
        'withdrawal',
      ].sort(),
    );
  });

  it('lets the preview endpoint size a proposed fee like any other outflow', () => {
    expect(cashPreviewRequestSchema.safeParse({ kind: 'fee', amountEur: 12.5 }).success).toBe(true);
    // Still a positive MAGNITUDE on the wire — the service assigns the sign.
    expect(cashPreviewRequestSchema.safeParse({ kind: 'fee', amountEur: -12.5 }).success).toBe(
      false,
    );
  });
});

describe('source tag validation (V5-P0c)', () => {
  it('accepts manual, standing-order, and import/sync slugs', () => {
    for (const tag of [
      'manual',
      'standing-order',
      'import:trade_republic',
      'import:george',
      'import:flatex',
      'import:ibkr',
      'sync:parqet',
      'sync:george',
    ]) {
      expect(sourceTagSchema.safeParse(tag).success, tag).toBe(true);
    }
  });

  it('rejects malformed, uppercase, empty-slug, and unknown-kind tags', () => {
    for (const tag of [
      'IMPORT',
      'import',
      'import:',
      'import:Trade_Republic',
      'sync',
      'export:foo',
      'sync :parqet',
      'manual:x',
      '',
    ]) {
      expect(sourceTagSchema.safeParse(tag).success, tag).toBe(false);
    }
  });

  it('builds a valid import tag from a broker id', () => {
    expect(importSourceTag('trade_republic')).toBe('import:trade_republic');
    expect(sourceTagSchema.safeParse(importSourceTag('george')).success).toBe(true);
  });
});

describe('cash movement pagination', () => {
  it('coerces a bounded limit and accepts UUID or untagged filters', () => {
    const cursor = '11111111-1111-7111-8111-111111111111';
    expect(cashMovementsQuerySchema.parse({ cursor, limit: '20', tag: cursor })).toEqual({
      cursor,
      limit: 20,
      tag: cursor,
    });
    expect(cashMovementsQuerySchema.safeParse({ tag: 'untagged' }).success).toBe(true);
  });

  it('rejects malformed cursors, tags, and out-of-range limits', () => {
    expect(cashMovementsQuerySchema.safeParse({ cursor: 'not-a-cursor' }).success).toBe(false);
    expect(cashMovementsQuerySchema.safeParse({ tag: 'food' }).success).toBe(false);
    expect(cashMovementsQuerySchema.safeParse({ limit: 201 }).success).toBe(false);
  });
});

describe('transaction pagination filters', () => {
  it('accepts a bounded per-asset holding query', () => {
    const cursor = '11111111-1111-7111-8111-111111111111';
    const assetId = '22222222-2222-7222-8222-222222222222';
    expect(transactionListQuerySchema.parse({ cursor, limit: '8', assetId })).toEqual({
      cursor,
      limit: 8,
      assetId,
    });
  });

  it('rejects malformed holding asset filters', () => {
    expect(transactionListQuerySchema.safeParse({ assetId: 'not-an-asset-id' }).success).toBe(
      false,
    );
  });
});
