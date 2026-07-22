import { afterEach, describe, expect, test } from 'vitest';

import {
  DISCREET_MASK,
  EM_DASH,
  formatDate,
  formatDateTime,
  formatMoney,
  formatPercent,
  formatQuantity,
  formatSignedDelta,
  formatSignedPercent,
  formatUnitPrice,
  formatWeight,
  getFormatLocale,
  getMoneyCurrency,
  isDiscreetMode,
  setDiscreetMode,
  setFormatLocale,
  setMoneyCurrency,
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

  test('rounds half-up (away from zero), never floors (§7.1 rule 1)', () => {
    // 2.125 is exactly representable in binary, so this pins the rounding mode
    // rather than a float artefact: half-up → 2,13 (banker's would give 2,12).
    expect(formatMoney(2.125)).toBe('2,13 €');
    expect(formatMoney(-2.125)).toBe('-2,13 €');
    expect(formatMoney(2.135)).toBe('2,14 €');
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
// Base-currency default (§5.4, §13.3 V3-P10d)
//
// The auth runtime drives the default money currency from the signed-in user's
// base currency; `afterEach` restores EUR so tests stay order-independent.

describe('setMoneyCurrency', () => {
  afterEach(() => setMoneyCurrency('EUR'));

  test('defaults to EUR', () => {
    expect(getMoneyCurrency()).toBe('EUR');
  });

  test('a USD base makes omitted-currency money render in $, still 2 dp symbol-last', () => {
    setMoneyCurrency('USD');
    expect(getMoneyCurrency()).toBe('USD');
    expect(formatMoney(1234.56)).toBe('1.234,56 $');
    expect(formatMoney(42)).toBe('42,00 $');
  });

  test('CHF and GBP hold the 2 dp symbol-last layout too (§5.4 display rules)', () => {
    setMoneyCurrency('CHF');
    expect(formatMoney(1234.5)).toBe('1.234,50 CHF');
    setMoneyCurrency('GBP');
    expect(formatMoney(-9.9)).toBe('-9,90 £');
  });

  test('an explicit currency still overrides the base default', () => {
    setMoneyCurrency('USD');
    expect(formatMoney(100, 'EUR')).toBe('100,00 €');
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

  test('keeps up to 8 decimal places (a satoshi), trailing zeros trimmed', () => {
    expect(formatQuantity(0.12345678)).toBe('0,12345678');
    expect(formatQuantity(0.5)).toBe('0,5');
  });

  test('rounds beyond 8 decimal places (half-up)', () => {
    expect(formatQuantity(1.123456785)).toBe('1,12345679');
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
// formatUnitPrice (§7.1 rule 4)
//
// Per-unit prices keep sub-cent precision so a micro-cap token price never
// collapses to 0,00 €; every other value follows the 2 dp money rule.

describe('formatUnitPrice', () => {
  test('a sub-cent price keeps up to 6 significant decimals, symbol-last', () => {
    expect(formatUnitPrice(0.000012)).toBe('0,000012 €');
    expect(formatUnitPrice(0.0000123456)).toBe('0,0000123456 €');
  });

  test('a negative sub-cent price keeps the minus and the precision', () => {
    expect(formatUnitPrice(-0.000012)).toBe('-0,000012 €');
  });

  test('honours an explicit native currency for a sub-cent price', () => {
    expect(formatUnitPrice(0.000012, 'USD')).toBe('0,000012 $');
  });

  test('a value at/above 0.01 follows the 2 dp money rule', () => {
    expect(formatUnitPrice(12.5)).toBe('12,50 €');
    expect(formatUnitPrice(0.01)).toBe('0,01 €');
  });

  test('exactly zero renders as money, not sub-cent precision', () => {
    expect(formatUnitPrice(0)).toBe('0,00 €');
    expect(formatUnitPrice(-0)).toBe('0,00 €');
  });

  test('returns em dash for null / undefined / NaN', () => {
    expect(formatUnitPrice(null)).toBe(EM_DASH);
    expect(formatUnitPrice(undefined)).toBe(EM_DASH);
    expect(formatUnitPrice(NaN)).toBe(EM_DASH);
  });
});

// ---------------------------------------------------------------------------
// formatPercent / formatWeight

describe('formatPercent', () => {
  test('formats a positive percent, 2 dp, space before %', () => {
    expect(formatPercent(2.5)).toBe('2,50 %');
  });

  test('formats a negative percent', () => {
    expect(formatPercent(-2.5)).toBe('-2,50 %');
  });

  test('formats zero', () => {
    expect(formatPercent(0)).toBe('0,00 %');
  });

  test('formats 100 %', () => {
    expect(formatPercent(100)).toBe('100,00 %');
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
    expect(formatSignedPercent(2.5)).toBe('+2,50 %');
  });

  test('keeps - for negative values', () => {
    expect(formatSignedPercent(-1.5)).toBe('-1,50 %');
  });

  test('shows no sign for zero', () => {
    expect(formatSignedPercent(0)).toBe('0,00 %');
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

// ---------------------------------------------------------------------------
// Locale-aware formatting (§13.3 V3-P1)
//
// The active Intl locale follows the user's chosen UI language. The default is
// de-AT (asserted above); switching to en-GB flips number/date formatting while
// money stays symbol-last in every locale. `afterEach` restores the default so
// no other test in this file inherits a switched locale.

describe('locale-aware formatting (§13.3 V3-P1)', () => {
  afterEach(() => setFormatLocale('de-AT'));

  test('en-GB uses "." decimals and "," grouping; money stays symbol-last', () => {
    setFormatLocale('en-GB');
    expect(getFormatLocale()).toBe('en-GB');
    expect(formatMoney(1234.56)).toBe('1,234.56 €');
    // en-GB disambiguates the dollar as "US$" — the locale's own symbol is kept.
    expect(formatMoney(1234.56, 'USD')).toBe('1,234.56 US$');
    expect(formatQuantity(1234.5)).toBe('1,234.5');
    expect(formatPercent(2.5)).toMatch(/^2\.50\s?%$/);
  });

  test('de-AT uses "," decimals and "." grouping (the default dialect)', () => {
    setFormatLocale('de-AT');
    expect(formatMoney(1234.56)).toBe('1.234,56 €');
    expect(formatPercent(2.5)).toBe('2,50 %');
  });

  test('dates render in the active locale, always Europe/Vienna wall-clock', () => {
    setFormatLocale('en-GB');
    expect(formatDate('2024-01-15T12:00:00.000Z')).toMatch(/15 Jan 2024/);
    setFormatLocale('de-AT');
    expect(formatDate('2024-01-15T12:00:00.000Z')).toBe('15.01.2024');
  });
});

// ---------------------------------------------------------------------------
// Discreet mode (§13.5 V5-P13 arc (a)) — the shared masking seam. Every
// absolute-money helper returns {@link DISCREET_MASK} while the flag is ON;
// percent / quantity / date helpers stay live so relative values keep rendering.
// The flag is module-level state driven by the auth runtime and the profile
// quick toggle — reset after each test to keep ordering irrelevant.

describe('discreet mode (§13.5 V5-P13 arc (a))', () => {
  afterEach(() => setDiscreetMode(false));

  test('toggles a module-level flag exposed by isDiscreetMode()', () => {
    expect(isDiscreetMode()).toBe(false);
    setDiscreetMode(true);
    expect(isDiscreetMode()).toBe(true);
    setDiscreetMode(false);
    expect(isDiscreetMode()).toBe(false);
  });

  test('masks every absolute-money helper — formatMoney/formatUnitPrice/formatSignedDelta', () => {
    setDiscreetMode(true);
    expect(formatMoney(1234.56)).toBe(DISCREET_MASK);
    expect(formatMoney(-1234.56, 'USD')).toBe(DISCREET_MASK);
    expect(formatMoney(0)).toBe(DISCREET_MASK);
    // Sub-cent path still masks — no unit-price leak.
    expect(formatUnitPrice(0.000012)).toBe(DISCREET_MASK);
    expect(formatUnitPrice(12.5, 'USD')).toBe(DISCREET_MASK);
    expect(formatSignedDelta(1.25)).toBe(DISCREET_MASK);
    expect(formatSignedDelta(-1.25)).toBe(DISCREET_MASK);
  });

  test('leaves percentages, quantities and dates untouched', () => {
    setDiscreetMode(true);
    // Relative values keep rendering — that's the whole point of discreet mode.
    expect(formatPercent(2.5)).toBe('2,50 %');
    expect(formatSignedPercent(2.5)).toMatch(/^\+2,50 %/);
    expect(formatWeight(50)).toBe('50,00 %');
    expect(formatQuantity(12.5)).toBe('12,5');
    expect(formatDate('2024-01-15T12:00:00.000Z')).toBe('15.01.2024');
  });

  test('em-dash for missing values wins over the mask (nothing to hide)', () => {
    setDiscreetMode(true);
    expect(formatMoney(null)).toBe(EM_DASH);
    expect(formatMoney(undefined)).toBe(EM_DASH);
    expect(formatMoney(Number.NaN)).toBe(EM_DASH);
    expect(formatUnitPrice(null)).toBe(EM_DASH);
    expect(formatSignedDelta(null)).toBe(EM_DASH);
  });

  test('turning the flag back off restores exact rendering', () => {
    setDiscreetMode(true);
    expect(formatMoney(1234.56)).toBe(DISCREET_MASK);
    setDiscreetMode(false);
    expect(formatMoney(1234.56)).toBe('1.234,56 €');
    expect(formatUnitPrice(0.000012)).toBe('0,000012 €');
    expect(formatSignedDelta(1.25)).toBe('+1,25');
  });
});
