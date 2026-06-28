import { describe, expect, test } from 'vitest';

import {
  EM_DASH,
  formatDate,
  formatDateTime,
  formatMoney,
  formatPercent,
  formatQuantity,
  formatSignedDelta,
  formatSignedPercent,
  formatWeight,
} from './format';

// ---------------------------------------------------------------------------
// formatMoney
//
// PROJECTPLAN §7.1 mandates symbol-LAST money: "1.234,56 €". de-AT's native
// Intl currency output is symbol-first (€ 1.234,56); these assertions pin the
// reconstructed symbol-last layout so a regression is caught immediately.

describe('formatMoney', () => {
  test('formats EUR symbol-last (PROJECTPLAN §7.1)', () => {
    expect(formatMoney(1234.56)).toBe('1.234,56 €');
  });

  test('always uses 2 decimal places', () => {
    expect(formatMoney(42)).toBe('42,00 €');
  });

  test('formats zero', () => {
    expect(formatMoney(0)).toBe('0,00 €');
  });

  test('normalises negative zero — no stray minus', () => {
    expect(formatMoney(-0)).toBe('0,00 €');
  });

  test('formats a negative value with the symbol still last', () => {
    expect(formatMoney(-50)).toBe('-50,00 €');
  });

  test('formats a large negative value', () => {
    expect(formatMoney(-1234.56)).toBe('-1.234,56 €');
  });

  test('honours an explicit currency, symbol-last (USD)', () => {
    expect(formatMoney(1234.56, 'USD')).toBe('1.234,56 $');
  });

  test('returns em dash for null / undefined / NaN / Infinity', () => {
    expect(formatMoney(null)).toBe(EM_DASH);
    expect(formatMoney(undefined)).toBe(EM_DASH);
    expect(formatMoney(NaN)).toBe(EM_DASH);
    expect(formatMoney(Infinity)).toBe(EM_DASH);
    expect(formatMoney(-Infinity)).toBe(EM_DASH);
  });
});

// ---------------------------------------------------------------------------
// formatQuantity

describe('formatQuantity', () => {
  test('formats a whole number without decimals', () => {
    expect(formatQuantity(12)).toBe('12');
  });

  test('formats a fractional quantity', () => {
    expect(formatQuantity(12.5)).toBe('12,5');
  });

  test('keeps up to 6 decimal places', () => {
    expect(formatQuantity(0.123456)).toBe('0,123456');
  });

  test('rounds beyond 6 decimal places', () => {
    expect(formatQuantity(1.1234567)).toBe('1,123457');
  });

  test('groups thousands (separator varies by ICU; normalised to a space)', () => {
    expect(formatQuantity(1234567)).toMatch(/^1[. ]234[. ]567$/);
  });

  test('returns em dash for null / NaN', () => {
    expect(formatQuantity(null)).toBe(EM_DASH);
    expect(formatQuantity(NaN)).toBe(EM_DASH);
  });
});

// ---------------------------------------------------------------------------
// formatPercent / formatWeight

describe('formatPercent', () => {
  test('formats a positive percent, 1 dp, space before %', () => {
    expect(formatPercent(2.5)).toBe('2,5 %');
  });

  test('formats a negative percent (matches AC example "-2,5 %")', () => {
    expect(formatPercent(-2.5)).toBe('-2,5 %');
  });

  test('formats zero', () => {
    expect(formatPercent(0)).toBe('0,0 %');
  });

  test('formats 100 %', () => {
    expect(formatPercent(100)).toBe('100,0 %');
  });

  test('returns em dash for null / undefined / NaN', () => {
    expect(formatPercent(null)).toBe(EM_DASH);
    expect(formatPercent(undefined)).toBe(EM_DASH);
    expect(formatPercent(NaN)).toBe(EM_DASH);
  });
});

describe('formatWeight', () => {
  test('is an alias of formatPercent', () => {
    expect(formatWeight(30)).toBe(formatPercent(30));
    expect(formatWeight(null)).toBe(formatPercent(null));
  });
});

// ---------------------------------------------------------------------------
// formatSignedPercent

describe('formatSignedPercent', () => {
  test('prepends + for positive values', () => {
    expect(formatSignedPercent(2.5)).toBe('+2,5 %');
  });

  test('keeps - for negative values', () => {
    expect(formatSignedPercent(-1.5)).toBe('-1,5 %');
  });

  test('shows no sign for zero', () => {
    expect(formatSignedPercent(0)).toBe('0,0 %');
  });

  test('returns em dash for null / NaN', () => {
    expect(formatSignedPercent(null)).toBe(EM_DASH);
    expect(formatSignedPercent(NaN)).toBe(EM_DASH);
  });
});

// ---------------------------------------------------------------------------
// formatSignedDelta

describe('formatSignedDelta', () => {
  test('prepends + for positive values', () => {
    expect(formatSignedDelta(1.25)).toBe('+1,25');
  });

  test('keeps - for negative values', () => {
    expect(formatSignedDelta(-50)).toBe('-50,00');
  });

  test('shows no sign for zero', () => {
    expect(formatSignedDelta(0)).toBe('0,00');
  });

  test('groups thousands (separator varies by ICU)', () => {
    expect(formatSignedDelta(1234.56)).toMatch(/^\+1[. ]234,56$/);
  });

  test('returns em dash for null / undefined', () => {
    expect(formatSignedDelta(null)).toBe(EM_DASH);
    expect(formatSignedDelta(undefined)).toBe(EM_DASH);
  });
});

// ---------------------------------------------------------------------------
// formatDate / formatDateTime

describe('formatDate', () => {
  test('formats an ISO timestamp to a de-AT medium date', () => {
    // Midday UTC avoids any timezone day-boundary ambiguity.
    expect(formatDate('2024-01-15T12:00:00.000Z')).toBe('15.01.2024');
  });

  test('returns em dash for null / undefined / invalid', () => {
    expect(formatDate(null)).toBe(EM_DASH);
    expect(formatDate(undefined)).toBe(EM_DASH);
    expect(formatDate('not-a-date')).toBe(EM_DASH);
  });
});

describe('formatDateTime', () => {
  test('formats an ISO timestamp to a de-AT medium date + short time', () => {
    const result = formatDateTime('2024-01-15T12:00:00.000Z');
    // The date is deterministic; the hour depends on the host timezone, so we
    // assert the shape rather than an exact time.
    expect(result).toMatch(/15\.01\.2024/);
    expect(result).toMatch(/\d{2}:\d{2}/);
  });

  test('returns em dash for null / undefined / invalid', () => {
    expect(formatDateTime(null)).toBe(EM_DASH);
    expect(formatDateTime(undefined)).toBe(EM_DASH);
    expect(formatDateTime('bad')).toBe(EM_DASH);
  });
});
