import {
  backtestComparisonResponseSchema,
  backtestResponseSchema,
  MAX_NESTING_DEPTH,
  sharedSandboxAggregateResponseSchema,
  sharedSandboxPreviewRequestSchema,
  sharedSandboxPreviewResponseSchema,
} from '@bettertrack/contracts';
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';

import type { AssetRepository } from '../../../data/repositories/assetRepository';
import type { ConglomerateRepository } from '../../../data/repositories/conglomerateRepository';
import type { MarketDataService } from '../../../providers';
import type { CurrencyService } from '../../currency/currencyService';
import {
  backtestComparisonCacheKey,
  backtestPreviewCacheKey,
  createBacktestService,
  SANDBOX_MAX_NESTED_SHARE_PCT,
} from '../backtestService';

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

  it('normal and paranoid global-only previews never share a cached result', () => {
    expect(backtestPreviewCacheKey('u1', input, 'EUR')).not.toBe(
      backtestPreviewCacheKey('u1', input, 'EUR', { globalOnly: true }),
    );
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
  D: [
    { date: '2025-12-30', close: 100 },
    { date: '2025-12-31', close: 105 },
    { date: '2026-01-02', close: 95 },
    { date: '2026-01-05', close: 110 },
  ],
  HIDDEN_EARLY: [
    { date: '2025-12-30', close: 20 },
    { date: '2026-01-02', close: 22 },
    { date: '2026-01-05', close: 24 },
  ],
  HIDDEN_LATE: [
    { date: '2026-01-02', close: 30 },
    { date: '2026-01-05', close: 33 },
  ],
  // A long-history pair for the comparison COVERAGE fixtures (#1755), sparse on
  // purpose — the axis is the union of the basket's own price dates.
  LONG: [
    { date: '2024-01-02', close: 100 },
    { date: '2024-07-01', close: 110 },
    { date: '2025-01-02', close: 120 },
    { date: '2025-06-16', close: 130 },
    { date: '2026-01-05', close: 137 },
  ],
  // Delisted 2025-06-15 after falling 100 → 5: data STOPS inside the window.
  DELISTED: [
    { date: '2024-01-02', close: 100 },
    { date: '2024-07-01', close: 80 },
    { date: '2025-01-02', close: 40 },
    { date: '2025-06-15', close: 5 },
  ],
  // Alive throughout, but its exchange was shut on the window's final day —
  // the calendar mismatch a coverage check must NOT read as a delisting.
  HOLIDAY_SHY: [
    { date: '2024-01-02', close: 100 },
    { date: '2024-07-01', close: 105 },
    { date: '2025-01-02', close: 115 },
    { date: '2025-06-16', close: 125 },
    { date: '2026-01-02', close: 131 },
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
/**
 * A NESTED u1-owned conglomerate (V5-P6): 50 % of the CONG_ID basket (60/40
 * A/B) + 50 % direct A — hand-flattened equivalent: 80 % A / 20 % B.
 */
const NESTED_ID = '018f0000-0000-7000-8000-000000000002';
/** A u1-owned conglomerate holding a PRIVATE custom asset (arc-c sandbox tests). */
const CUSTOM_CONG_ID = '018f0000-0000-7000-8000-000000000003';
/** The middle and root baskets of a valid root → child → grandchild depth-3 chain. */
const DEEP_MID_ID = '018f0000-0000-7000-8000-000000000004';
const DEEP_ROOT_ID = '018f0000-0000-7000-8000-000000000005';
/** Opaque nested fixtures used to prove the shared response never names descendants. */
const HIDDEN_CHILD_ID = '018f0000-0000-7000-8000-000000000006';
const HIDDEN_ROOT_ID = '018f0000-0000-7000-8000-000000000007';
/** Opaque nested fixtures for private/no-history descendant error redaction. */
const HIDDEN_CUSTOM_ROOT_ID = '018f0000-0000-7000-8000-000000000008';
const HIDDEN_NO_HISTORY_CHILD_ID = '018f0000-0000-7000-8000-000000000009';
const HIDDEN_NO_HISTORY_ROOT_ID = '018f0000-0000-7000-8000-00000000000a';
/** Flat fixture whose valid three-decimal weights expose redundant normalization drift. */
const PRECISE_FLAT_ID = '018f0000-0000-7000-8000-00000000000b';
/** The friend viewing u1's shared baskets in the arc-c sandbox tests. */
const VIEWER_ID = 'v1';

function createHarness() {
  const store = new Map<string, string>();
  let historyCalls = 0;

  const assetRepo = {
    // Global catalog asset by default (ownerId null). The arc-c sandbox tests use
    // the `CUSTOM` id to model a private custom asset (ownerId set → not globally
    // backtestable in a viewer's sandbox).
    findByIdForUser: async (assetId: string, userId: string) => ({
      id: assetId,
      symbol: assetId,
      currency: 'EUR',
      providerId: 'stub',
      providerRef: assetId,
      ownerId: assetId === 'CUSTOM' ? userId : null,
    }),
    // Unseeded catalog: presets fall back to the static provider spec.
    findGlobal: async () => null,
  } as unknown as AssetRepository;

  const conglomerateRepo = {
    findByIdForOwner: async (ownerId: string, id: string) => {
      if (ownerId !== 'u1') return null;
      if (id === CONG_ID) {
        return {
          id: CONG_ID,
          name: 'My Mix',
          positions: [
            { kind: 'asset', assetId: 'A', weightPct: 60 },
            { kind: 'asset', assetId: 'B', weightPct: 40 },
          ],
        };
      }
      if (id === NESTED_ID) {
        return {
          id: NESTED_ID,
          name: 'Nested Mix',
          positions: [
            { kind: 'conglomerate', childId: CONG_ID, weightPct: 50 },
            { kind: 'asset', assetId: 'A', weightPct: 50 },
          ],
        };
      }
      if (id === CUSTOM_CONG_ID) {
        return {
          id: CUSTOM_CONG_ID,
          name: 'Has Custom',
          positions: [
            { kind: 'asset', assetId: 'A', weightPct: 50 },
            { kind: 'asset', assetId: 'CUSTOM', weightPct: 50 },
          ],
        };
      }
      if (id === DEEP_MID_ID) {
        return {
          id: DEEP_MID_ID,
          name: 'Deep Mid',
          positions: [{ kind: 'conglomerate', childId: CONG_ID, weightPct: 100 }],
        };
      }
      if (id === DEEP_ROOT_ID) {
        return {
          id: DEEP_ROOT_ID,
          name: 'Deep Root',
          positions: [{ kind: 'conglomerate', childId: DEEP_MID_ID, weightPct: 100 }],
        };
      }
      if (id === HIDDEN_CHILD_ID) {
        return {
          id: HIDDEN_CHILD_ID,
          name: 'Opaque Child',
          positions: [
            { kind: 'asset', assetId: 'HIDDEN_EARLY', weightPct: 50 },
            { kind: 'asset', assetId: 'HIDDEN_LATE', weightPct: 50 },
          ],
        };
      }
      if (id === HIDDEN_ROOT_ID) {
        return {
          id: HIDDEN_ROOT_ID,
          name: 'Opaque Root',
          positions: [{ kind: 'conglomerate', childId: HIDDEN_CHILD_ID, weightPct: 100 }],
        };
      }
      if (id === HIDDEN_CUSTOM_ROOT_ID) {
        return {
          id: HIDDEN_CUSTOM_ROOT_ID,
          name: 'Opaque Custom Root',
          positions: [{ kind: 'conglomerate', childId: CUSTOM_CONG_ID, weightPct: 100 }],
        };
      }
      if (id === HIDDEN_NO_HISTORY_CHILD_ID) {
        return {
          id: HIDDEN_NO_HISTORY_CHILD_ID,
          name: 'Opaque No-history Child',
          positions: [{ kind: 'asset', assetId: 'SECRET_NO_HISTORY', weightPct: 100 }],
        };
      }
      if (id === HIDDEN_NO_HISTORY_ROOT_ID) {
        return {
          id: HIDDEN_NO_HISTORY_ROOT_ID,
          name: 'Opaque No-history Root',
          positions: [
            { kind: 'conglomerate', childId: HIDDEN_NO_HISTORY_CHILD_ID, weightPct: 100 },
          ],
        };
      }
      if (id === PRECISE_FLAT_ID) {
        return {
          id: PRECISE_FLAT_ID,
          name: 'Precise Flat Mix',
          positions: [
            { kind: 'asset', assetId: 'A', weightPct: 0.001 },
            { kind: 'asset', assetId: 'B', weightPct: 0.61 },
            { kind: 'asset', assetId: 'D', weightPct: 99.389 },
          ],
        };
      }
      return null;
    },
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
    // Model the §6.9 share guard for the arc-c sandbox: viewer `v1` may read
    // u1's shared baskets; everyone/everything else is a 404.
    authorizeConglomerateRead: async (viewerId: string, conglomerateId: string) =>
      viewerId === VIEWER_ID &&
      [
        CONG_ID,
        NESTED_ID,
        CUSTOM_CONG_ID,
        DEEP_ROOT_ID,
        HIDDEN_ROOT_ID,
        HIDDEN_CUSTOM_ROOT_ID,
        HIDDEN_NO_HISTORY_ROOT_ID,
        PRECISE_FLAT_ID,
      ].includes(conglomerateId)
        ? { ownerId: 'u1' }
        : undefined,
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

  it('a NESTED conglomerate backtests exactly like its hand-flattened equivalent (V5-P6)', async () => {
    const { service } = createHarness();

    // Primary = the hand-flattened equivalent of NESTED_ID (50 % of the 60/40
    // CONG_ID basket + 50 % direct A ⇒ 80/20 A/B); benchmark = the nested
    // basket itself, run through resolveConglomerateBasket over the SAME
    // window. Equal series ⇔ the recursion resolves to exactly those weights.
    const res = await service.runPreview('u1', {
      positions: [
        { assetId: 'A', weight: 80 },
        { assetId: 'B', weight: 20 },
      ],
      range: '1Y',
      benchmark: { conglomerateId: NESTED_ID },
    });

    expect(res.benchmark?.kind).toBe('conglomerate');
    expect(res.benchmark?.label).toBe('Nested Mix');
    expect(res.benchmark?.series.length).toBe(res.series.length);
    for (let i = 0; i < res.series.length; i += 1) {
      expect(res.benchmark!.series[i]!.date).toBe(res.series[i]!.date);
      expect(res.benchmark!.series[i]!.value).toBeCloseTo(res.series[i]!.value, 10);
    }
    expect(res.benchmark!.stats.totalReturnPct).toBeCloseTo(res.stats.totalReturnPct, 10);
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

// ---------------------------------------------------------------------------
// N-way conglomerate comparison (V5-P6): the shared-window engine fan-out
// ---------------------------------------------------------------------------

/** Comparison-test conglomerates, all owned by u1 (positions over the CLOSES fixture). */
const CA = '018f0000-0000-7000-8000-0000000000a1'; // 60/40 A/B (== the PREVIEW basket)
const CB = '018f0000-0000-7000-8000-0000000000b1'; // 100 % B
const CC = '018f0000-0000-7000-8000-0000000000c1'; // 100 % C — a late listing (starts 2026-01-02)
const CD = '018f0000-0000-7000-8000-0000000000d1'; // 100 % A
const CN = '018f0000-0000-7000-8000-0000000000e1'; // 100 % of CA — a NESTED basket
const CEMPTY = '018f0000-0000-7000-8000-0000000000c2'; // no positions at all
const CPARENT = '018f0000-0000-7000-8000-0000000000c3'; // 60 % A + 40 % of the EMPTY basket
const CL = '018f0000-0000-7000-8000-0000000000f1'; // 100 % LONG — the coverage primary
const CX = '018f0000-0000-7000-8000-0000000000f2'; // 100 % DELISTED — stops mid-window
const CH = '018f0000-0000-7000-8000-0000000000f3'; // 100 % HOLIDAY_SHY — a 3-day tail gap

/** An asset or nested constituent, as the repository serves it. */
type StubConstituent =
  | { kind: 'asset'; assetId: string; weightPct: number }
  | { kind: 'conglomerate'; childId: string; weightPct: number };

const COMPARISON_CONGLOMERATES: Record<string, { name: string; positions: StubConstituent[] }> = {
  [CA]: {
    name: 'A/B Mix',
    positions: [
      { kind: 'asset', assetId: 'A', weightPct: 60 },
      { kind: 'asset', assetId: 'B', weightPct: 40 },
    ],
  },
  [CB]: { name: 'All B', positions: [{ kind: 'asset', assetId: 'B', weightPct: 100 }] },
  [CC]: { name: 'Late C', positions: [{ kind: 'asset', assetId: 'C', weightPct: 100 }] },
  [CD]: { name: 'All A', positions: [{ kind: 'asset', assetId: 'A', weightPct: 100 }] },
  [CN]: {
    name: 'Nested A/B Mix',
    positions: [{ kind: 'conglomerate', childId: CA, weightPct: 100 }],
  },
  [CEMPTY]: { name: 'Bonds', positions: [] },
  [CPARENT]: {
    name: 'Core',
    positions: [
      { kind: 'asset', assetId: 'A', weightPct: 60 },
      { kind: 'conglomerate', childId: CEMPTY, weightPct: 40 },
    ],
  },
  [CL]: { name: 'Long Runner', positions: [{ kind: 'asset', assetId: 'LONG', weightPct: 100 }] },
  [CX]: {
    name: 'Delisted Co',
    positions: [{ kind: 'asset', assetId: 'DELISTED', weightPct: 100 }],
  },
  [CH]: {
    name: 'Shut Friday',
    positions: [{ kind: 'asset', assetId: 'HOLIDAY_SHY', weightPct: 100 }],
  },
};

function createComparisonHarness() {
  const store = new Map<string, string>();
  let historyCalls = 0;
  // A per-harness MUTABLE copy: the cache tests rewrite a basket's positions
  // mid-test, exactly as a Builder autosave does between two comparisons.
  const catalog = new Map(
    Object.entries(COMPARISON_CONGLOMERATES).map(([id, entry]) => [
      id,
      { name: entry.name, positions: [...entry.positions] },
    ]),
  );

  // Assets the caller may no longer see — a paranoid transition that won
  // mid-request, or a custom asset scoped out of a shared sandbox.
  const hidden = new Set<string>();

  const assetRepo = {
    findByIdForUser: async (assetId: string) =>
      hidden.has(assetId)
        ? null
        : {
            id: assetId,
            symbol: assetId,
            currency: 'EUR',
            providerId: 'stub',
            providerRef: assetId,
          },
    findGlobal: async () => null,
  } as unknown as AssetRepository;

  const conglomerateRepo = {
    findByIdForOwner: async (ownerId: string, id: string) => {
      const entry = ownerId === 'u1' ? catalog.get(id) : undefined;
      return entry ? { id, name: entry.name, positions: entry.positions } : null;
    },
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
    now: () => Date.parse('2026-01-05T12:00:00Z'),
  });

  return { service, store, catalog, hidden, historyCalls: () => historyCalls };
}

describe('backtestService.runComparison — N-way conglomerate comparison (V5-P6)', () => {
  it('for N=2 reproduces the V4-P7 benchmark run exactly (regression parity)', async () => {
    const { service } = createComparisonHarness();

    // Comparison [CA, CB]: CA is the primary (== the inline PREVIEW basket), CB
    // the second series run over CA's window — the exact shape a V4-P7 preview
    // of PREVIEW with a CB benchmark produces. Series AND stats must match.
    const cmp = await service.runComparison('u1', { conglomerateIds: [CA, CB], range: '1Y' });
    const preview = await service.runPreview('u1', {
      ...PREVIEW,
      benchmark: { conglomerateId: CB },
    });

    expect(() => backtestComparisonResponseSchema.parse(cmp)).not.toThrow();
    expect(cmp.series.map((s) => s.conglomerateId)).toEqual([CA, CB]);
    // Primary (CA) === the preview's own basket.
    expect(cmp.series[0]!.series).toEqual(preview.series);
    expect(cmp.series[0]!.stats).toEqual(preview.stats);
    // Second series (CB) === the preview's benchmark run.
    expect(cmp.series[1]!.series).toEqual(preview.benchmark!.series);
    expect(cmp.series[1]!.stats).toEqual(preview.benchmark!.stats);
  });

  it('overlays three conglomerates on one shared window, in request order', async () => {
    const { service } = createComparisonHarness();
    const cmp = await service.runComparison('u1', { conglomerateIds: [CA, CB, CD], range: '1Y' });

    expect(() => backtestComparisonResponseSchema.parse(cmp)).not.toThrow();
    expect(cmp.series.map((s) => s.conglomerateId)).toEqual([CA, CB, CD]);
    expect(cmp.series.map((s) => s.name)).toEqual(['A/B Mix', 'All B', 'All A']);
    // Every series shares the primary's window and opens at the base-100 index.
    for (const s of cmp.series) {
      expect(s.series[0]!.date).toBe(cmp.startDate);
      expect(s.series.at(-1)!.date).toBe(cmp.endDate);
      expect(s.series[0]!.value).toBeCloseTo(100, 10);
    }
    // Default baseline is the first id; its own deltas are all 0.
    expect(cmp.baselineId).toBe(CA);
    expect(cmp.series[0]!.deltas.totalReturnPct).toBe(0);
    // CD is 100 % A (100→132 = +32 %); CA is the 60/40 mix. The delta is real.
    expect(cmp.series[2]!.stats.totalReturnPct).toBeCloseTo(32, 10);
    expect(cmp.series[2]!.deltas.totalReturnPct).toBeCloseTo(
      cmp.series[2]!.stats.totalReturnPct - cmp.series[0]!.stats.totalReturnPct,
      10,
    );
  });

  it('re-picking the baseline recomputes the deltas without re-running the backtests', async () => {
    const { service, store } = createComparisonHarness();

    const vsCA = await service.runComparison('u1', { conglomerateIds: [CA, CB, CD], range: '1Y' });
    const coreEntries = store.size; // the baseline-independent core is now cached

    const vsCB = await service.runComparison('u1', {
      conglomerateIds: [CA, CB, CD],
      range: '1Y',
      baselineId: CB,
    });

    // No new cache entry — the baseline is not part of the core memo key.
    expect(store.size).toBe(coreEntries);
    expect(vsCB.baselineId).toBe(CB);
    // The per-series stats are identical (same window); only the deltas moved.
    expect(vsCB.series.map((s) => s.stats)).toEqual(vsCA.series.map((s) => s.stats));
    // vs CA: CA is the baseline → its own delta is 0. vs CB: CA's delta is now
    // measured against CB, so it takes CB's stat as the reference — a different
    // number. (CA total return 15.2 %, CB −10 %, CD 32 % over the fixture.)
    const caReturn = vsCA.series[0]!.stats.totalReturnPct;
    const cbReturn = vsCA.series[1]!.stats.totalReturnPct;
    expect(vsCA.series[0]!.deltas.totalReturnPct).toBe(0);
    expect(vsCB.series[1]!.deltas.totalReturnPct).toBe(0); // CB is now the baseline
    expect(vsCB.series[0]!.deltas.totalReturnPct).toBeCloseTo(caReturn - cbReturn, 10);
    expect(caReturn - cbReturn).not.toBeCloseTo(0, 6); // the two baselines really differ
  });

  it('rejects a non-primary series that does not cover the primary window (2-series alignment semantics)', async () => {
    const { service } = createComparisonHarness();
    // CA's window starts 2025-12-30; CC (100 % C) only lists from 2026-01-02, so
    // it cannot cover the window — a 422, exactly as a short V4-P7 benchmark.
    await expect(
      service.runComparison('u1', { conglomerateIds: [CA, CC], range: '1Y' }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'BACKTEST_UNAVAILABLE' });
  });

  it('refuses a series whose data STOPS inside the window, like one that starts late (#1755)', async () => {
    const { service } = createComparisonHarness();
    // The issue's scenario, in the fixture's own numbers: the primary runs the
    // whole window; the second basket's only holding was delisted 2025-06-15
    // after falling 100 → 5. Its START is fine — both list on 2024-01-02 — so
    // the clip notice is silent and this used to be accepted and charted.
    await expect(
      service.runComparison('u1', { conglomerateIds: [CL, CX], range: '3Y' }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'BACKTEST_UNAVAILABLE' });
    // Named, exactly as a start-clipped series is named.
    await expect(
      service.runComparison('u1', { conglomerateIds: [CL, CX], range: '3Y' }),
    ).rejects.toMatchObject({ message: expect.stringContaining('Delisted Co') });

    // What that refusal is protecting the grid from: run the same basket on its
    // own and its CAGR is annualised over the 1.45 years it survived, not over
    // the window a comparison would print it in.
    const solo = await service.runPreview('u1', {
      positions: [{ assetId: 'DELISTED', weight: 100 }],
      range: '3Y',
    });
    expect(solo.startDate).toBe('2024-01-02');
    expect(solo.endDate).toBe('2025-06-15'); // the line just stops
    const years = (start: string, end: string) =>
      (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / (86_400_000 * 365.25);
    const survived = (Math.pow(0.05, 1 / years('2024-01-02', '2025-06-15')) - 1) * 100;
    const overTheWindow = (Math.pow(0.05, 1 / years('2024-01-02', '2026-01-05')) - 1) * 100;
    expect(solo.stats.cagrPct).toBeCloseTo(survived, 6);
    // The two are ~10 pp apart, and the shorter one is the more dramatic — which
    // is precisely why it may not be differenced against a full-window series.
    expect(survived).toBeLessThan(overTheWindow - 9);
  });

  it('tolerates a tail gap a trading calendar explains, and never reports an end a series misses', async () => {
    const { service } = createComparisonHarness();
    // `Shut Friday` is alive throughout; its exchange was simply closed on the
    // primary's final day. A coverage check with no grace would refuse every
    // cross-market comparison on any day the two calendars disagree.
    const cmp = await service.runComparison('u1', { conglomerateIds: [CL, CH], range: '3Y' });
    expect(() => backtestComparisonResponseSchema.parse(cmp)).not.toThrow();
    expect(cmp.series.map((s) => s.conglomerateId)).toEqual([CL, CH]);

    // …and the reported window end is the last day EVERY charted series reaches,
    // not the primary's own — a response never claims an end one of its curves
    // stops short of.
    expect(cmp.endDate).toBe('2026-01-02');
    for (const s of cmp.series) {
      expect(s.series.at(-1)!.date >= cmp.endDate).toBe(true);
    }
  });

  it('reports each series’ unresolved share, and the benchmark path reports its own', async () => {
    const { service } = createComparisonHarness();
    // `Core` is 60 % A + 40 % of an EMPTY basket: the flatten drops the child and
    // normalizes A to 100, so the curve is the 60 % leg alone. Saying so is what
    // stops the chart claiming to be the whole basket while the calculator on
    // the same screen withholds 40 % of the budget.
    const cmp = await service.runComparison('u1', { conglomerateIds: [CA, CPARENT], range: '1Y' });
    expect(() => backtestComparisonResponseSchema.parse(cmp)).not.toThrow();
    expect(cmp.series[0]!.unresolvedPct).toBe(0);
    expect(cmp.series[1]!.unresolvedPct).toBeCloseTo(40, 9);
    // It IS the 100 %-A curve — the number above is the only thing that says so.
    expect(cmp.series[1]!.stats.totalReturnPct).toBeCloseTo(32, 6);

    // The V4-P7 benchmark path resolves through the same flatten and reports it
    // too; an asset benchmark is always fully resolved.
    const withCong = await service.runPreview('u1', {
      ...PREVIEW,
      benchmark: { conglomerateId: CPARENT },
    });
    expect(withCong.benchmark?.unresolvedPct).toBeCloseTo(40, 9);
    const withAsset = await service.runPreview('u1', {
      ...PREVIEW,
      benchmark: { assetId: 'D' },
    });
    expect(withAsset.benchmark?.unresolvedPct).toBe(0);
  });

  it("404s when a conglomerate is not the caller's", async () => {
    const { service } = createComparisonHarness();
    await expect(
      service.runComparison('u2', { conglomerateIds: [CA, CB], range: '1Y' }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'CONGLOMERATE_NOT_FOUND' });
  });

  it('an edit to a compared basket recomputes instead of serving the pre-edit core', async () => {
    const { service, catalog, historyCalls } = createComparisonHarness();
    const before = await service.runComparison('u1', { conglomerateIds: [CA, CB], range: '1Y' });
    // CA is the 60/40 A/B mix: 0.6·132 + 0.4·90 = 115.2 ⇒ +15.2 %.
    expect(before.series[0]!.stats.totalReturnPct).toBeCloseTo(15.2, 6);

    // Same ids, same params, nothing edited ⇒ the memo answers, no provider work.
    const warm = historyCalls();
    const again = await service.runComparison('u1', { conglomerateIds: [CA, CB], range: '1Y' });
    expect(again).toEqual(before);
    expect(historyCalls()).toBe(warm);

    // The Builder rewrites CA to 10/90 — the same id, a different basket.
    catalog.get(CA)!.positions = [
      { kind: 'asset', assetId: 'A', weightPct: 10 },
      { kind: 'asset', assetId: 'B', weightPct: 90 },
    ];
    const after = await service.runComparison('u1', { conglomerateIds: [CA, CB], range: '1Y' });
    expect(historyCalls()).toBeGreaterThan(warm);
    // 0.1·132 + 0.9·90 = 94.2 ⇒ −5.8 %: the edited basket, not the cached one.
    expect(after.series[0]!.stats.totalReturnPct).toBeCloseTo(-5.8, 6);
  });

  it('an edit to a NESTED CHILD recomputes too — its id never appears in the request', async () => {
    const { service, catalog } = createComparisonHarness();
    const before = await service.runComparison('u1', { conglomerateIds: [CN, CB], range: '1Y' });
    // CN is 100 % of CA, so it resolves to CA's 60/40 A/B mix.
    expect(before.series[0]!.stats.totalReturnPct).toBeCloseTo(15.2, 6);

    // Editing the CHILD changes the parent's effective weights.
    catalog.get(CA)!.positions = [{ kind: 'asset', assetId: 'A', weightPct: 100 }];
    const after = await service.runComparison('u1', { conglomerateIds: [CN, CB], range: '1Y' });
    expect(after.series[0]!.stats.totalReturnPct).toBeCloseTo(32, 6);
  });

  it('a refused asset costs ZERO provider history calls, even batched across series', async () => {
    // The batched load runs in two phases — authorize every asset, then fetch —
    // precisely so a request that ends in a 404 sends no provider traffic. Fanned
    // out in one phase, asset A of the first basket would already be in flight
    // while B is refused. B sits in BOTH baskets, so this also covers the
    // refusal landing in a later series than the one that would have resolved.
    const { service, hidden, historyCalls } = createComparisonHarness();
    hidden.add('B');

    await expect(
      service.runComparison('u1', { conglomerateIds: [CA, CB], range: '1Y' }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'ASSET_NOT_FOUND' });
    expect(historyCalls()).toBe(0);
  });

  it('the resolved composition is part of the memo key (an id alone is a mutable handle)', () => {
    const base = { conglomerateIds: [CA, CB], range: '1Y' as const };
    const keyFor = (weight: number) =>
      backtestComparisonCacheKey('u1', base, 'EUR', {
        compositions: [
          {
            id: CA,
            name: 'A/B Mix',
            positions: [
              { assetId: 'A', weight },
              { assetId: 'B', weight: 100 - weight },
            ],
            unresolvedPct: 0,
          },
          { id: CB, name: 'All B', positions: [{ assetId: 'B', weight: 100 }], unresolvedPct: 0 },
        ],
      });
    expect(keyFor(60)).toBe(keyFor(60));
    expect(keyFor(60)).not.toBe(keyFor(90));
  });

  it('neither the baseline NOR the id order is part of the core memo key', () => {
    const base = { conglomerateIds: [CA, CB], range: '1Y' as const };
    expect(backtestComparisonCacheKey('u1', base, 'EUR')).toBe(
      backtestComparisonCacheKey('u1', { ...base, baselineId: CB }, 'EUR'),
    );
    // A comparison is a SET (#1755): re-ordering the picker is the same
    // comparison and must hit the same entry. Keying by the ordered list gave
    // one six-basket set 720 keys per (range, mode, frequency) — a memo that
    // could essentially never be hit twice.
    expect(backtestComparisonCacheKey('u1', base, 'EUR')).toBe(
      backtestComparisonCacheKey('u1', { conglomerateIds: [CB, CA], range: '1Y' }, 'EUR'),
    );
    // …and that holds for the compositions the key is content-addressed by, in
    // whatever order the caller resolved them.
    const compositions = [
      { id: CA, name: 'A/B Mix', positions: [{ assetId: 'A', weight: 100 }], unresolvedPct: 0 },
      { id: CB, name: 'All B', positions: [{ assetId: 'B', weight: 100 }], unresolvedPct: 0 },
    ];
    expect(backtestComparisonCacheKey('u1', base, 'EUR', { compositions })).toBe(
      backtestComparisonCacheKey('u1', { conglomerateIds: [CB, CA], range: '1Y' }, 'EUR', {
        compositions: [compositions[1]!, compositions[0]!],
      }),
    );
    // An empty nested child changes what a basket IS without changing its
    // resolved vector, so the unresolved share is part of the identity too.
    expect(backtestComparisonCacheKey('u1', base, 'EUR', { compositions })).not.toBe(
      backtestComparisonCacheKey('u1', base, 'EUR', {
        compositions: [{ ...compositions[0]!, unresolvedPct: 40 }, compositions[1]!],
      }),
    );
    expect(backtestComparisonCacheKey('u1', base, 'EUR')).not.toBe(
      backtestComparisonCacheKey('u1', base, 'EUR', { globalOnly: true }),
    );
  });

  it('answers a re-ordered comparison from the memo, in the caller’s own order', async () => {
    const { service, store, historyCalls } = createComparisonHarness();
    const forward = await service.runComparison('u1', {
      conglomerateIds: [CA, CB, CD],
      range: '1Y',
    });
    const warm = historyCalls();
    const entries = store.size;

    const reversed = await service.runComparison('u1', {
      conglomerateIds: [CD, CB, CA],
      range: '1Y',
    });
    // No second engine run and no second memo entry — the same comparison.
    expect(historyCalls()).toBe(warm);
    expect(store.size).toBe(entries);
    // The RESPONSE still follows the request: the chart legend and the grid's
    // columns are the caller's order, with each series' own stats attached.
    expect(reversed.series.map((s) => s.conglomerateId)).toEqual([CD, CB, CA]);
    expect(reversed.baselineId).toBe(CD);
    const statsById = new Map(forward.series.map((s) => [s.conglomerateId, s.stats]));
    for (const s of reversed.series) expect(s.stats).toEqual(statsById.get(s.conglomerateId));
    // Deltas follow the new default baseline, not the old one.
    expect(reversed.series[0]!.deltas.totalReturnPct).toBe(0);
  });

  it('loads each shared asset ONCE across the compared baskets', async () => {
    const { service, historyCalls } = createComparisonHarness();
    // CA is 60/40 A/B, CB is 100 % B, CD is 100 % A, CN resolves to CA's A/B
    // mix: four baskets, seven resolved positions, but only TWO distinct assets.
    // Loading per occurrence charged the provider layer (and the row read) once
    // per occurrence — at the contract's ceilings, 1500 loads for 250 assets.
    const cmp = await service.runComparison('u1', {
      conglomerateIds: [CA, CB, CD, CN],
      range: '1Y',
    });
    expect(cmp.series).toHaveLength(4);
    expect(historyCalls()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Shared-conglomerate what-if sandbox (§13.5 V5-P6 arc c)
// ---------------------------------------------------------------------------

describe('backtestService.runSharedSandboxPreview', () => {
  /** The shared basket at its original 60/40 A/B weights. */
  const ORIGINAL = {
    conglomerateId: CONG_ID,
    positions: [
      { id: 'A', weight: 60 },
      { id: 'B', weight: 40 },
    ],
    range: '1Y' as const,
  };

  it('keeps a valid three-decimal flat vector bit-identical to the legacy direct-position preview', async () => {
    const { service } = createHarness();
    const positions = [
      { assetId: 'A', weight: 0.001 },
      { assetId: 'B', weight: 0.61 },
      { assetId: 'D', weight: 99.389 },
    ];
    const sandbox = await service.runSharedSandboxPreview(VIEWER_ID, {
      conglomerateId: PRECISE_FLAT_ID,
      positions: positions.map((position) => ({
        id: position.assetId,
        weight: position.weight,
      })),
      range: '1Y',
    });
    // The owner inline preview is the pre-nesting direct-position path. Pin the
    // complete response, including exact normalized contribution weights.
    const ownerPreview = await service.runPreview('u1', { positions, range: '1Y' });
    expect(() => backtestResponseSchema.parse(sandbox)).not.toThrow();
    expect(sandbox).toEqual(ownerPreview);
  });

  it('a weight tweak changes the curve; re-running at the original weights restores it exactly', async () => {
    const { service } = createHarness();
    const shared = await service.runSharedSandboxPreview(VIEWER_ID, ORIGINAL);
    const tweaked = await service.runSharedSandboxPreview(VIEWER_ID, {
      ...ORIGINAL,
      positions: [
        { id: 'A', weight: 80 },
        { id: 'B', weight: 20 },
      ],
    });
    expect(tweaked.series).not.toEqual(shared.series);

    // "Reset to shared" is just the same call at the original weights — the
    // curve comes back byte-for-byte.
    const reset = await service.runSharedSandboxPreview(VIEWER_ID, ORIGINAL);
    expect(reset.series).toEqual(shared.series);
    expect(reset.stats).toEqual(shared.stats);
  });

  it('404s an unauthorized viewer — same outcome as the read-only shared view', async () => {
    const { service } = createHarness();
    await expect(service.runSharedSandboxPreview('stranger', ORIGINAL)).rejects.toMatchObject({
      statusCode: 404,
      code: 'CONGLOMERATE_NOT_FOUND',
    });
  });

  it('rejects a tweak whose id set does not match the shared basket (no foreign-id injection)', async () => {
    const { service } = createHarness();
    await expect(
      service.runSharedSandboxPreview(VIEWER_ID, {
        ...ORIGINAL,
        positions: [
          { id: 'A', weight: 60 },
          // A foreign id the share never exposed — pinned out.
          { id: 'Z', weight: 40 },
        ],
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'SANDBOX_POSITIONS_MISMATCH' });
  });

  it('re-weights a nested top-level constituent and resolves its effective assets recursively', async () => {
    const { service } = createHarness();
    const sandbox = await service.runSharedSandboxPreview(VIEWER_ID, {
      conglomerateId: NESTED_ID,
      positions: [
        { id: CONG_ID, weight: 80 },
        { id: 'A', weight: 20 },
      ],
      range: '1Y',
    });

    // The child keeps its stored 60/40 A/B split: an 80% child plus 20% direct A
    // resolves to exactly 68/32 A/B.
    const handFlattened = await service.runPreview('u1', {
      positions: [
        { assetId: 'A', weight: 68 },
        { assetId: 'B', weight: 32 },
      ],
      range: '1Y',
    });
    expect(sandbox.series).toHaveLength(handFlattened.series.length);
    for (let index = 0; index < sandbox.series.length; index += 1) {
      expect(sandbox.series[index]!.date).toBe(handFlattened.series[index]!.date);
      expect(sandbox.series[index]!.value).toBeCloseTo(handFlattened.series[index]!.value, 10);
    }

    // …and what that aggregate must never become is the OPAQUE CHILD's own
    // curve (#1755). The child is 60/40 A/B; this mix is 68/32, and the
    // difference is what the root's public 20 % of A is doing. The redaction is
    // a mix, so it has to stay one.
    const childCurve = await service.runPreview('u1', PREVIEW);
    expect(sandbox.series.at(-1)!.value).not.toBeCloseTo(childCurve.series.at(-1)!.value, 2);
  });

  it('refuses a sandbox that collapses the basket onto the opaque child (#1755)', async () => {
    const { service } = createHarness();
    // The extraction: hold the public sibling at a rounding error and push the
    // nested row as high as the wire allows. The child's share goes to ~100 %,
    // so the "aggregate-only" series, stats, max drawdown, best/worst days and
    // startDate become the hidden basket's own — no algebra required.
    const extract = (childWeight: number) =>
      service.runSharedSandboxPreview(VIEWER_ID, {
        conglomerateId: NESTED_ID,
        positions: [
          { id: CONG_ID, weight: childWeight },
          { id: 'A', weight: 0.001 },
        ],
        range: '1Y',
      });

    // Layer one, the contract: the original 1_000_000 never reaches the service.
    const overWire = sharedSandboxPreviewRequestSchema.safeParse({
      positions: [
        { id: CONG_ID, weight: 1_000_000 },
        { id: 'A', weight: 0.001 },
      ],
      range: '1Y',
    });
    expect(overWire.success).toBe(false);

    // Layer two, the service: an in-contract 100 still leaves the child at
    // 99.999 % of the basket, so the bound is on the resulting SHARE.
    await expect(extract(100)).rejects.toMatchObject({
      statusCode: 422,
      code: 'SANDBOX_NESTED_SHARE_CAP',
    });

    // Re-weighting inside the bound stays fully available, and even at the cap
    // the response is a genuine mix — not the child's curve.
    expect(SANDBOX_MAX_NESTED_SHARE_PCT).toBe(90);
    const atCap = await service.runSharedSandboxPreview(VIEWER_ID, {
      conglomerateId: NESTED_ID,
      positions: [
        { id: CONG_ID, weight: 90 },
        { id: 'A', weight: 10 },
      ],
      range: '1Y',
    });
    const childCurve = await service.runPreview('u1', PREVIEW);
    expect(atCap.series.at(-1)!.value).not.toBeCloseTo(childCurve.series.at(-1)!.value, 2);
  });

  it('leaves a root that IS one nested basket alone — the share is not the viewer’s doing', async () => {
    const { service } = createHarness();
    // `Opaque Root` is 100 % of its child in the SHARE ITSELF, so its stored
    // share is already 100 %. Bounding that would refuse "reset to shared" for
    // a basket the viewer is already allowed to see the curve of.
    const sandbox = await service.runSharedSandboxPreview(VIEWER_ID, {
      conglomerateId: HIDDEN_ROOT_ID,
      positions: [{ id: HIDDEN_CHILD_ID, weight: 100 }],
      range: '1Y',
    });
    expect(sharedSandboxAggregateResponseSchema.safeParse(sandbox).success).toBe(true);
  });

  it('never serializes hidden descendant identities through contributions, notices or entry events', async () => {
    const { service } = createHarness();
    const input = {
      conglomerateId: HIDDEN_ROOT_ID,
      positions: [{ id: HIDDEN_CHILD_ID, weight: 100 }],
      range: '1Y' as const,
    };

    // Clip would normally name HIDDEN_LATE in its limiting notice; cash would
    // normally name HIDDEN_EARLY in its notice and HIDDEN_LATE in an entry event.
    for (const response of [
      await service.runSharedSandboxPreview(VIEWER_ID, input),
      await service.runSharedSandboxPreview(VIEWER_ID, { ...input, mode: 'cash' }),
    ]) {
      expect(sharedSandboxAggregateResponseSchema.safeParse(response).success).toBe(true);
      expect(sharedSandboxPreviewResponseSchema.safeParse(response).success).toBe(true);
      expect(response).not.toHaveProperty('contributions');
      expect(response).not.toHaveProperty('notice');
      expect(response).not.toHaveProperty('benchmark');
      expect(response).not.toHaveProperty('entryEvents');
      const wire = JSON.stringify(response);
      expect(wire).not.toContain('"HIDDEN_EARLY"');
      expect(wire).not.toContain('"HIDDEN_LATE"');
    }
  });

  it.each([
    {
      label: 'private custom asset',
      conglomerateId: HIDDEN_CUSTOM_ROOT_ID,
      childId: CUSTOM_CONG_ID,
      hiddenIdentity: 'CUSTOM',
    },
    {
      label: 'asset with no price history',
      conglomerateId: HIDDEN_NO_HISTORY_ROOT_ID,
      childId: HIDDEN_NO_HISTORY_CHILD_ID,
      hiddenIdentity: 'SECRET_NO_HISTORY',
    },
  ])('redacts a hidden descendant $label from errors', async (fixture) => {
    const { service } = createHarness();
    const caught: unknown = await service
      .runSharedSandboxPreview(VIEWER_ID, {
        conglomerateId: fixture.conglomerateId,
        positions: [{ id: fixture.childId, weight: 100 }],
        range: '1Y',
      })
      .catch((error: unknown) => error);

    expect(caught).toMatchObject({
      statusCode: 422,
      code: 'BACKTEST_UNAVAILABLE',
      message: 'This shared basket can’t be backtested with the selected settings.',
    });
    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof Error) {
      expect(caught.message).not.toContain(fixture.hiddenIdentity);
    }
  });

  it('runs a valid nest at the planner-set maximum depth', async () => {
    expect(MAX_NESTING_DEPTH).toBe(3);
    const { service } = createHarness();
    const sandbox = await service.runSharedSandboxPreview(VIEWER_ID, {
      conglomerateId: DEEP_ROOT_ID,
      positions: [{ id: DEEP_MID_ID, weight: 100 }],
      range: '1Y',
    });
    const handFlattened = await service.runPreview('u1', PREVIEW);
    expect(sandbox.series).toEqual(handFlattened.series);
    expect(sandbox.stats).toEqual(handFlattened.stats);
  });

  it('cannot introduce a self-cycle by substituting the shared root id', async () => {
    const { service } = createHarness();
    await expect(
      service.runSharedSandboxPreview(VIEWER_ID, {
        conglomerateId: NESTED_ID,
        positions: [
          { id: NESTED_ID, weight: 80 },
          { id: 'A', weight: 20 },
        ],
        range: '1Y',
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'SANDBOX_POSITIONS_MISMATCH' });
  });

  it('refuses a basket with a private custom asset — a viewer never sees the owner’s manual valuations', async () => {
    const { service } = createHarness();
    await expect(
      service.runSharedSandboxPreview(VIEWER_ID, {
        conglomerateId: CUSTOM_CONG_ID,
        positions: [
          { id: 'A', weight: 50 },
          { id: 'CUSTOM', weight: 50 },
        ],
        range: '1Y',
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'SANDBOX_PRIVATE_ASSET' });
  });

  it('never memoises or writes: each sandbox run recomputes off the warm provider history', async () => {
    const { service, store, historyCalls } = createHarness();
    await service.runSharedSandboxPreview(VIEWER_ID, ORIGINAL);
    expect(store.size).toBe(0); // no Redis memo for the sandbox
    const before = historyCalls();
    await service.runSharedSandboxPreview(VIEWER_ID, ORIGINAL);
    expect(historyCalls()).toBe(before + 2); // fresh compute, one load per asset
  });
});
