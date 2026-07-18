import type { AssetRef } from '@bettertrack/contracts';
import { describe, expect, it, vi } from 'vitest';

import { AssetNotFoundError } from '../errors';
import type { StooqClient } from '../stooqClient';
import { createStooqProvider } from '../stooqProvider';

/**
 * Stooq provider (§13.5 V5-P1c): maps the (stubbed) Stooq client onto the §5.1
 * contract shapes with normalized symbols + currency, no live network. Instant
 * spacing so the request queue never sleeps in tests.
 */
const FAST_QUEUE = { minSpacingMs: 0 } as const;
const AAPL: AssetRef = { providerId: 'yahoo', providerRef: 'AAPL' };

function providerWith(overrides: Partial<StooqClient> = {}) {
  const client: StooqClient = {
    quote:
      overrides.quote ??
      (async () => ({ symbol: 'AAPL.US', date: '2026-07-16', time: '22:00:04', close: 209.05 })),
    history:
      overrides.history ??
      (async () => [
        { date: '2026-07-14', close: 205.8 },
        { date: '2026-07-15', close: 207.9 },
      ]),
  };
  return createStooqProvider({
    client,
    queueOptions: FAST_QUEUE,
    now: () => Date.parse('2026-07-16T23:00:00Z'),
  });
}

describe('StooqProvider.getQuote', () => {
  it('maps a US quote: price + USD, no fabricated day move', async () => {
    const quote = await providerWith().getQuote(AAPL);
    expect(quote).toMatchObject({
      price: 209.05,
      currency: 'USD',
      prevClose: null,
      dayChangePct: null,
    });
    // asOf comes from the Stooq date/time.
    expect(quote.asOf).toBe('2026-07-16T22:00:04.000Z');
  });

  it('maps a XETRA `.DE` quote to EUR', async () => {
    const quote = await providerWith().getQuote({ providerId: 'yahoo', providerRef: 'BAYN.DE' });
    expect(quote.currency).toBe('EUR');
  });

  it('throws AssetNotFoundError when Stooq returns N/D (null close)', async () => {
    const provider = providerWith({
      quote: async () => ({ symbol: 'X', date: null, time: null, close: null }),
    });
    await expect(provider.getQuote(AAPL)).rejects.toBeInstanceOf(AssetNotFoundError);
  });

  it('throws AssetNotFoundError for an unsupported ref without calling the client', async () => {
    const quote = vi.fn();
    const provider = providerWith({ quote });
    await expect(
      provider.getQuote({ providerId: 'yahoo', providerRef: 'BTC-USD' }),
    ).rejects.toBeInstanceOf(AssetNotFoundError);
    expect(quote).not.toHaveBeenCalled();
  });
});

describe('StooqProvider.getHistory + getMeta + canServe', () => {
  it('maps daily rows to ISO price points', async () => {
    const points = await providerWith().getHistory(AAPL, '1M', '1d');
    expect(points).toEqual([
      { time: '2026-07-14T00:00:00.000Z', close: 205.8 },
      { time: '2026-07-15T00:00:00.000Z', close: 207.9 },
    ]);
  });

  it('derives a symbol-based meta with the mapped currency/type', async () => {
    const meta = await providerWith().getMeta(AAPL);
    expect(meta).toMatchObject({
      providerId: 'stooq',
      providerRef: 'AAPL',
      symbol: 'AAPL',
      currency: 'USD',
      type: 'stock',
    });
  });

  it('canServe gates by mappability', () => {
    const provider = providerWith();
    expect(provider.canServe?.(AAPL)).toBe(true);
    expect(provider.canServe?.({ providerId: 'yahoo', providerRef: 'BTC-USD' })).toBe(false);
  });

  it('search returns nothing (catalog is Yahoo-fed)', async () => {
    expect(await providerWith().search('apple')).toEqual([]);
  });
});
