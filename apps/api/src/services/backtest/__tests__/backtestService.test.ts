import { backtestResponseSchema } from '@bettertrack/contracts';
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';

import type { AssetRepository } from '../../../data/repositories/assetRepository';
import type { MarketDataService } from '../../../providers';
import type { CurrencyService } from '../../currency/currencyService';
import { backtestPreviewCacheKey, createBacktestService } from '../backtestService';

// ---------------------------------------------------------------------------
// Cache-key identity (V4-P7 — the rebalance frequency is part of the memo key)
// ---------------------------------------------------------------------------

describe('backtestPreviewCacheKey — V4-P7 rebalance-frequency separation', () => {
  const input = {
    positions: [{ assetId: 'a1', weight: 50 }],
    range: '5Y' as const,
    benchmark: null,
  };

  it('an omitted frequency and an explicit `none` share one memo entry', () => {
    expect(backtestPreviewCacheKey('u1', input, 'EUR')).toBe(
      backtestPreviewCacheKey('u1', { ...input, rebalance: 'none' }, 'EUR'),
    );
  });

  it('two previews differing only in rebalance frequency never share a cache entry', () => {
    const keys = new Set(
      (['none', 'monthly', 'quarterly', 'yearly'] as const).map((rebalance) =>
        backtestPreviewCacheKey('u1', { ...input, rebalance }, 'EUR'),
      ),
    );
    expect(keys.size).toBe(4);
  });

  it('frequency and late-listing mode are independent key axes', () => {
    const keys = new Set([
      backtestPreviewCacheKey('u1', { ...input, mode: 'clip', rebalance: 'monthly' }, 'EUR'),
      backtestPreviewCacheKey('u1', { ...input, mode: 'cash', rebalance: 'monthly' }, 'EUR'),
      backtestPreviewCacheKey('u1', { ...input, mode: 'cash', rebalance: 'none' }, 'EUR'),
      backtestPreviewCacheKey('u1', { ...input, mode: 'clip', rebalance: 'none' }, 'EUR'),
    ]);
    expect(keys.size).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// runPreview threading (stubbed deps — no HTTP, no DB)
// ---------------------------------------------------------------------------

/** Daily closes per provider ref, spanning the 2025→2026 year boundary. */
const CLOSES: Record<string, Array<{ date: string; close: number }>> = {
  A: [
    { date: '2025-12-30', close: 100 },
    { date: '2025-12-31', close: 120 },
    { date: '2026-01-02', close: 120 },
    { date: '2026-01-05', close: 132 },
  ],
  B: [
    { date: '2025-12-30', close: 100 },
    { date: '2025-12-31', close: 90 },
    { date: '2026-01-02', close: 90 },
    { date: '2026-01-05', close: 90 },
  ],
};

function createHarness() {
  const store = new Map<string, string>();
  let historyCalls = 0;

  const assetRepo = {
    findByIdForUser: async (assetId: string) => ({
      id: assetId,
      symbol: assetId,
      currency: 'EUR',
      providerId: 'stub',
      providerRef: assetId,
    }),
  } as unknown as AssetRepository;

  const marketData = {
    getHistory: async (ref: { providerRef: string }) => {
      historyCalls += 1;
      const closes = CLOSES[ref.providerRef] ?? [];
      return { value: closes.map((c) => ({ time: `${c.date}T00:00:00Z`, close: c.close })) };
    },
  } as unknown as MarketDataService;

  const currencyService = {
    baseCurrency: 'EUR',
    withBase() {
      return this;
    },
    toBase: async (amount: number) => amount,
  } as unknown as CurrencyService;

  const redis = {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    },
  } as unknown as Redis;

  const service = createBacktestService({
    assetRepo,
    marketData,
    currencyService,
    redis,
    // Fixed clock: the 1Y window ends 2026-01-05 and the engine clips to the
    // fixture's common start, so the axis spans the year boundary.
    now: () => Date.parse('2026-01-05T12:00:00Z'),
  });

  return { service, store, historyCalls: () => historyCalls };
}

const PREVIEW = {
  positions: [
    { assetId: 'A', weight: 60 },
    { assetId: 'B', weight: 40 },
  ],
  range: '1Y' as const,
};

describe('backtestService.runPreview — rebalance threading (V4-P7)', () => {
  it('threads the frequency to the engine and exposes the rebalance events in the wire response', async () => {
    const { service } = createHarness();
    const res = await service.runPreview('u1', { ...PREVIEW, rebalance: 'yearly' });

    // Contract-valid, with the new fields populated: one rebalance on the
    // first trading day of 2026 (matches the domain fixture: 114.48 vs the
    // buy-and-hold 115.2).
    expect(() => backtestResponseSchema.parse(res)).not.toThrow();
    expect(res.rebalance).toBe('yearly');
    expect(res.rebalanceEvents).toEqual([{ date: '2026-01-02' }]);
    expect(res.series.at(-1)?.value).toBeCloseTo(114.48, 10);
  });

  it('an omitted frequency stays buy-and-hold: `none` echoed, no events, unchanged result', async () => {
    const { service } = createHarness();
    const res = await service.runPreview('u1', PREVIEW);
    expect(res.rebalance).toBe('none');
    expect(res.rebalanceEvents).toEqual([]);
    expect(res.series.at(-1)?.value).toBeCloseTo(115.2, 10);
  });

  it('two previews differing only in frequency compute fresh and memoise separately; a repeat is a memo hit', async () => {
    const { service, store, historyCalls } = createHarness();

    const hold = await service.runPreview('u1', { ...PREVIEW, rebalance: 'none' });
    expect(historyCalls()).toBe(2); // one history load per position
    const yearly = await service.runPreview('u1', { ...PREVIEW, rebalance: 'yearly' });
    expect(historyCalls()).toBe(4); // fresh compute, not the other frequency's memo
    expect(store.size).toBe(2); // distinct cache entries
    expect(yearly.series).not.toEqual(hold.series);

    const repeat = await service.runPreview('u1', { ...PREVIEW, rebalance: 'yearly' });
    expect(historyCalls()).toBe(4); // memo hit — no refetch
    expect(repeat).toEqual(yearly);
  });
});
