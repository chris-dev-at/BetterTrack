import { describe, expect, test } from 'vitest';

import { amountToInput, truncateMoneyForInput } from './moneyInput';

describe('truncateMoneyForInput', () => {
  test('cuts a raw market quote to cents (owner directive 2026-07-12)', () => {
    // The canonical case: a price-at-date lookup hands back a full-precision quote.
    expect(truncateMoneyForInput(231.499320001)).toBe('231.49');
  });

  test('truncates DOWN — never rounds a prefilled cent up', () => {
    expect(truncateMoneyForInput(231.999)).toBe('231.99');
    expect(truncateMoneyForInput(99.999)).toBe('99.99');
    expect(truncateMoneyForInput(0.999)).toBe('0.99');
  });

  test('always emits exactly 2 fractional digits (pads < 2 decimals + integers)', () => {
    expect(truncateMoneyForInput(108)).toBe('108.00');
    expect(truncateMoneyForInput(231.5)).toBe('231.50');
    expect(truncateMoneyForInput(0)).toBe('0.00');
  });

  test('negatives truncate toward zero (cut the string), never -0.00', () => {
    expect(truncateMoneyForInput(-231.499320001)).toBe('-231.49');
    expect(truncateMoneyForInput(-0.5)).toBe('-0.50');
    // A negative sub-cent magnitude keeps its sign via the sub-cent branch
    // (below); only a true zero magnitude drops it.
    expect(truncateMoneyForInput(-0)).toBe('0.00');
  });

  test('float-safe: string-cut, not Math.trunc(v*100)/100', () => {
    // These are the values that break the ×100 approach — 0.29*100 === 28.999…,
    // so the naive floor yields 0.28 / 8.28 / 1.14. String truncation is exact.
    expect(truncateMoneyForInput(0.29)).toBe('0.29');
    expect(truncateMoneyForInput(8.29)).toBe('8.29');
    expect(truncateMoneyForInput(1.15)).toBe('1.15');
    expect(truncateMoneyForInput(0.1 + 0.2)).toBe('0.30'); // 0.30000000000000004
  });

  test('sub-cent magnitudes stay visible — up to 6 significant decimals, truncated (owner ruling 2026-07-14)', () => {
    expect(truncateMoneyForInput(0.000012)).toBe('0.000012');
    expect(truncateMoneyForInput(0.00000424)).toBe('0.00000424'); // SHIB-USD-style quote
    expect(truncateMoneyForInput(1e-7)).toBe('0.0000001'); // exponential toString expanded
    // Truncated — never rounded — after the 6th significant decimal.
    expect(truncateMoneyForInput(0.0000123456789)).toBe('0.0000123456');
    expect(truncateMoneyForInput(0.0099999999)).toBe('0.00999999');
  });

  test('sub-cent trims trailing zeros and keeps the sign', () => {
    expect(truncateMoneyForInput(0.005)).toBe('0.005');
    expect(truncateMoneyForInput(-0.000012)).toBe('-0.000012');
  });

  test('sub-cent boundaries: 0.01 keeps the cents rule; immeasurably small still collapses', () => {
    expect(truncateMoneyForInput(0.01)).toBe('0.01');
    expect(truncateMoneyForInput(1e-21)).toBe('0.00'); // below toFixed(20) resolution
  });

  test('non-finite input yields "" (blank the field, never NaN)', () => {
    expect(truncateMoneyForInput(NaN)).toBe('');
    expect(truncateMoneyForInput(Infinity)).toBe('');
    expect(truncateMoneyForInput(-Infinity)).toBe('');
  });
});

describe('amountToInput', () => {
  test('rounds half-up to 2 dp — distinct from truncateMoneyForInput', () => {
    expect(amountToInput(200)).toBe('200.00');
    // A user-facing offered amount rounds; the same input truncates to 231.49.
    expect(amountToInput(231.499)).toBe('231.50');
    expect(truncateMoneyForInput(231.499)).toBe('231.49');
  });
});
