import { describe, expect, it } from 'vitest';

import { dividendCalendarQuerySchema, projectedDividendIncomeQuerySchema } from './marketIntel';

/**
 * The two portfolio roll-up queries (§6.3 market-intelligence bullet, §13.5
 * V5-P5). Both narrow to ONE portfolio through the same optional `portfolioId`,
 * because the portfolio page renders them side by side under copy that names
 * "this portfolio" (#1898) — a shape that accepted the id on only one of them is
 * what let the calendar stay user-wide beside a scoped projection.
 */
describe('portfolio dividend roll-up queries', () => {
  const schemas = [
    ['dividend-calendar', dividendCalendarQuerySchema],
    ['dividend-projection', projectedDividendIncomeQuerySchema],
  ] as const;

  it.each(schemas)('%s: accepts a bare read (unscoped ⇒ user-wide)', (_name, schema) => {
    const parsed = schema.safeParse({});
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.portfolioId).toBeUndefined();
  });

  it.each(schemas)('%s: accepts a uuid portfolioId', (_name, schema) => {
    const portfolioId = '7f9b2d64-6c1a-4f2e-9a51-3d8b0c1e5a77';
    const parsed = schema.safeParse({ portfolioId });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.portfolioId).toBe(portfolioId);
  });

  it.each(schemas)('%s: rejects a non-uuid portfolioId (400, never a lookup)', (_name, schema) => {
    // The id reaches a WHERE clause on someone's book; a free-form string would
    // make "not a portfolio" and "not your portfolio" the same answer only by
    // luck of the repository's user filter. The shape refuses it up front.
    expect(schema.safeParse({ portfolioId: 'not-a-uuid' }).success).toBe(false);
    expect(schema.safeParse({ portfolioId: '' }).success).toBe(false);
    expect(schema.safeParse({ portfolioId: null }).success).toBe(false);
  });

  it.each(schemas)('%s: is strict — an unknown query key is rejected', (_name, schema) => {
    expect(schema.safeParse({ portfolioId: undefined, userId: 'someone-else' }).success).toBe(
      false,
    );
  });
});
