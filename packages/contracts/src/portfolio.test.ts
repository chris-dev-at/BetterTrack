import { describe, expect, it } from 'vitest';

import {
  MAX_CASH_AMOUNT_EUR,
  cashEntryRequestSchema,
  cashPreviewRequestSchema,
  importSourceTag,
  sourceTagSchema,
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
