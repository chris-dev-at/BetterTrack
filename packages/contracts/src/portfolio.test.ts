import { describe, expect, it } from 'vitest';

import { MAX_CASH_AMOUNT_EUR, cashEntryRequestSchema, cashPreviewRequestSchema } from './portfolio';

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
