import { backtestResponseSchema } from '@bettertrack/contracts';
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';

import type { AssetRepository } from '../../../data/repositories/assetRepository';
import type { ConglomerateRepository } from '../../../data/repositories/conglomerateRepository';
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
  // A late listing: no data on/before the basket's t₀ (2025-12-30).
  C: [
    { date: '2026-01-02', close: 10 },
    { date: '2026-01-05', close: 11 },
  ],
  // Preset fallback identity (unseeded catalog): +10 % over the window.
  '^GSPC': [
    { date: '2025-12-30', close: 5000 },
    { date: '2025-12-31', close: 5100 },
    { date: '2026-01-02', close: 5200 },
    { date: '2026-01-05', close: 5500 },
  ],
};

/** The u1-owned conglomerate the benchmark tests reference: the same 60/40 A/B basket. */
const CONG_ID = '018f0000-0000-7000-8000-000000000001';

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
    // Unseeded catalog: presets fall back to the static provider spec.
    findGlobal: async () => null,
  } as unknown as AssetRepository;

  const conglomerateRepo = {
    findByIdForOwner: async (ownerId: string, id: string) =>
      ownerId === 'u1' && id === CONG_ID
        ? {
            id: CONG_ID,
            name: 'My Mix',
            positions: [
              { assetId: 'A', weightPct: 60 },
              { assetId: 'B', weightPct: 40 },
            ],
          }
        : null,
  } as unknown as ConglomerateRepository;

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
    conglomerateRepo,
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

// ---------------------------------------------------------------------------
// Custom benchmarks (V4-P7): second engine run with the same parameters
// ---------------------------------------------------------------------------

describe('backtestService.runPreview — custom benchmarks (V4-P7)', () => {
  it('runs a conglomerate benchmark through the same engine with the same window, mode and rebalance schedule (parameter parity)', async () => {
    const { service } = createHarness();

    // The benchmark conglomerate holds the same 60/40 A/B basket as PREVIEW, so
    // if — and only if — the benchmark run shares every parameter with the
    // primary run, its series and stats must be identical to running that
    // basket as the primary. The yearly schedule makes this discriminating:
    // buy-and-hold ends at 115.2, the rebalanced run at 114.48.
    const withBench = await service.runPreview('u1', {
      ...PREVIEW,
      rebalance: 'yearly',
      benchmark: { conglomerateId: CONG_ID },
    });
    const direct = await service.runPreview('u1', { ...PREVIEW, rebalance: 'yearly' });

    expect(() => backtestResponseSchema.parse(withBench)).not.toThrow();
    expect(withBench.benchmark).not.toBeNull();
    expect(withBench.benchmark?.kind).toBe('conglomerate');
    expect(withBench.benchmark?.refId).toBe(CONG_ID);
    expect(withBench.benchmark?.label).toBe('My Mix');
    expect(withBench.benchmark?.series).toEqual(direct.series);
    expect(withBench.benchmark?.stats).toEqual(direct.stats);
    expect(withBench.benchmark?.series.at(-1)?.value).toBeCloseTo(114.48, 10);
  });

  it('runs an asset benchmark as a single-constituent basket through the same path', async () => {
    const { service } = createHarness();
    const res = await service.runPreview('u1', { ...PREVIEW, benchmark: { assetId: 'B' } });

    expect(res.benchmark?.kind).toBe('asset');
    expect(res.benchmark?.refId).toBe('B');
    expect(res.benchmark?.label).toBe('B');
    // B alone: 100 → 90 over the window.
    expect(res.benchmark?.stats.totalReturnPct).toBeCloseTo(-10, 10);
    expect(res.benchmark?.series[0]?.value).toBeCloseTo(100, 10);
  });

  it('falls back to the static provider spec for a preset the catalog has not seeded', async () => {
    const { service } = createHarness();
    const res = await service.runPreview('u1', { ...PREVIEW, benchmark: { preset: '^GSPC' } });

    expect(res.benchmark?.kind).toBe('asset');
    expect(res.benchmark?.refId).toBe('^GSPC');
    expect(res.benchmark?.label).toBe('^GSPC');
    // 5000 → 5500 over the window (identity FX in the stub).
    expect(res.benchmark?.stats.totalReturnPct).toBeCloseTo(10, 10);
  });

  it("404s another user's conglomerate — ownership enforced, no existence leak", async () => {
    const { service } = createHarness();
    await expect(
      service.runPreview('u2', { ...PREVIEW, benchmark: { conglomerateId: CONG_ID } }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'CONGLOMERATE_NOT_FOUND' });
  });

  it("422s a benchmark whose history starts after the basket's t₀ instead of comparing a shorter window", async () => {
    const { service } = createHarness();
    await expect(
      service.runPreview('u1', { ...PREVIEW, benchmark: { assetId: 'C' } }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'BACKTEST_UNAVAILABLE' });
  });

  it('every benchmark choice is its own memo-key axis', () => {
    const keys = new Set([
      backtestPreviewCacheKey('u1', { ...PREVIEW, benchmark: null }, 'EUR'),
      backtestPreviewCacheKey('u1', { ...PREVIEW, benchmark: { preset: '^GSPC' } }, 'EUR'),
      backtestPreviewCacheKey('u1', { ...PREVIEW, benchmark: { assetId: 'B' } }, 'EUR'),
      backtestPreviewCacheKey('u1', { ...PREVIEW, benchmark: { conglomerateId: CONG_ID } }, 'EUR'),
    ]);
    expect(keys.size).toBe(4);
  });
});
