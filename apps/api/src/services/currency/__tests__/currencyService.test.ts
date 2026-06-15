import { describe, expect, it, vi } from 'vitest';

import {
  createCurrencyService,
  DEFAULT_BASE_CURRENCY,
  type FxRateSource,
} from '../currencyService';

/** A stub rate source returning fixed `to`-per-`from` rates (§5.4 conversion stubs). */
function stubSource(overrides: Partial<FxRateSource> = {}): FxRateSource {
  return {
    getSpotRate: overrides.getSpotRate ?? (() => Promise.resolve(1.1)), // 1 EUR = 1.1 USD
    getHistoricalRate: overrides.getHistoricalRate ?? (() => Promise.resolve(1.2)),
  };
}

describe('createCurrencyService', () => {
  it('defaults the base currency to EUR but keeps it a parameter', () => {
    expect(DEFAULT_BASE_CURRENCY).toBe('EUR');
    expect(createCurrencyService({ source: stubSource() }).baseCurrency).toBe('EUR');
    expect(createCurrencyService({ source: stubSource(), baseCurrency: 'usd' }).baseCurrency).toBe(
      'USD',
    );
  });

  describe('getRate', () => {
    it.each([
      { from: 'EUR', to: 'EUR', expected: 1, source: 'identity' },
      { from: 'EUR', to: 'USD', expected: 1.1, source: 'spot' },
    ])('$from → $to via $source returns $expected', async ({ from, to, expected }) => {
      const svc = createCurrencyService({ source: stubSource() });
      await expect(svc.getRate(from, to)).resolves.toBe(expected);
    });

    it('does not call the source for an identity conversion', async () => {
      const getSpotRate = vi.fn(() => Promise.resolve(1.1));
      const svc = createCurrencyService({ source: stubSource({ getSpotRate }) });
      await expect(svc.getRate('eur', 'EUR')).resolves.toBe(1);
      expect(getSpotRate).not.toHaveBeenCalled();
    });

    it('routes to the historical source when a date is given', async () => {
      const getHistoricalRate = vi.fn(() => Promise.resolve(1.25));
      const svc = createCurrencyService({ source: stubSource({ getHistoricalRate }) });
      await expect(svc.getRate('EUR', 'USD', { date: '2026-01-02' })).resolves.toBe(1.25);
      expect(getHistoricalRate).toHaveBeenCalledWith('EUR', 'USD', '2026-01-02');
    });
  });

  describe('convert / toBase', () => {
    it.each([
      { amount: 100, from: 'USD', to: 'USD', rate: 1, expected: 100 },
      { amount: 100, from: 'EUR', to: 'USD', rate: 1.1, expected: 110 },
      { amount: 50, from: 'EUR', to: 'USD', rate: 1.1, expected: 55 },
    ])('convert($amount, $from→$to) = $expected', async ({ amount, from, to, rate, expected }) => {
      const svc = createCurrencyService({
        source: stubSource({ getSpotRate: () => Promise.resolve(rate) }),
      });
      await expect(svc.convert(amount, from, to)).resolves.toBeCloseTo(expected, 10);
    });

    it('toBase converts into EUR by default', async () => {
      const svc = createCurrencyService({
        source: stubSource({ getSpotRate: () => Promise.resolve(0.9) }), // 1 USD = 0.9 EUR
      });
      await expect(svc.toBase(100, 'USD')).resolves.toBeCloseTo(90, 10);
    });

    it('toBase honours a per-call base override (future per-user base)', async () => {
      const getSpotRate = vi.fn(() => Promise.resolve(1.3));
      const svc = createCurrencyService({ source: stubSource({ getSpotRate }) });
      await expect(svc.toBase(10, 'GBP', { base: 'USD' })).resolves.toBeCloseTo(13, 10);
      expect(getSpotRate).toHaveBeenCalledWith('GBP', 'USD');
    });

    it('passes the historical date through toBase', async () => {
      const getHistoricalRate = vi.fn(() => Promise.resolve(1.05));
      const svc = createCurrencyService({ source: stubSource({ getHistoricalRate }) });
      await expect(svc.toBase(200, 'USD', { date: '2025-12-31' })).resolves.toBeCloseTo(210, 10);
      expect(getHistoricalRate).toHaveBeenCalledWith('USD', 'EUR', '2025-12-31');
    });

    it('does not round mid-computation (full precision preserved)', async () => {
      const svc = createCurrencyService({
        source: stubSource({ getSpotRate: () => Promise.resolve(1.23456789) }),
      });
      await expect(svc.convert(3, 'EUR', 'USD')).resolves.toBe(3 * 1.23456789);
    });
  });

  describe('validation (money path fails loud)', () => {
    it('rejects an invalid currency code', async () => {
      const svc = createCurrencyService({ source: stubSource() });
      await expect(svc.getRate('EU', 'USD')).rejects.toThrowError(/Invalid currency code/);
    });

    it('rejects a non-finite amount', async () => {
      const svc = createCurrencyService({ source: stubSource() });
      await expect(svc.convert(Number.NaN, 'EUR', 'USD')).rejects.toThrowError(/finite number/);
    });

    it('rejects a non-positive rate from the source', async () => {
      const svc = createCurrencyService({
        source: stubSource({ getSpotRate: () => Promise.resolve(0) }),
      });
      await expect(svc.convert(1, 'EUR', 'USD')).rejects.toThrowError(/invalid rate/);
    });
  });
});
