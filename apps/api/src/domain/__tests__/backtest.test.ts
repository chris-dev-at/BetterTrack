import { describe, expect, it, vi } from 'vitest';

import {
  backtest,
  BacktestError,
  rebalanceToTargets,
  type BacktestAsset,
  type BacktestInput,
  type CurrencyConverter,
} from '../backtest';

// --- Helpers ---------------------------------------------------------------

/**
 * A constant-rate stub converter: `amount → amount · rate(currency)`, the same
 * rate every day. Mirrors the holdings test stub. `vi.fn` so tests can assert FX
 * coalescing (one call per (currency, day)).
 */
function stubConverter(rates: Record<string, number> = { EUR: 1, USD: 0.9 }): CurrencyConverter {
  return {
    toBase: vi.fn((amount: number, currency: string) => {
      const rate = rates[currency];
      if (rate === undefined) return Promise.reject(new Error(`no rate for ${currency}`));
      return Promise.resolve(amount * rate);
    }),
  };
}

/**
 * A date-varying converter: `rates[currency][date]` (falling back to a flat
 * `rates[currency]` map when a date is not listed). Lets a test show FX actually
 * moving the index — a *constant* rate cancels out of the price ratio, so only a
 * changing rate proves "convert at that day's FX".
 */
function datedConverter(byDate: Record<string, Record<string, number>>): CurrencyConverter {
  return {
    toBase: vi.fn((amount: number, currency: string, opts?: { date?: string }) => {
      const day = opts?.date;
      const rate = day !== undefined ? byDate[currency]?.[day] : undefined;
      if (rate === undefined) return Promise.reject(new Error(`no rate for ${currency} on ${day}`));
      return Promise.resolve(amount * rate);
    }),
  };
}

/** Build a daily-close series from a base date and an array of closes. */
function dailyCloses(start: string, closes: number[]): { date: string; close: number }[] {
  const ms = Date.parse(`${start}T00:00:00Z`);
  return closes.map((close, i) => ({
    date: new Date(ms + i * 86_400_000).toISOString().slice(0, 10),
    close,
  }));
}

/** A one-EUR-asset backtest input; the index then equals `close / close(t₀) · 100`. */
function singleAssetInput(
  closes: number[],
  start = '2026-01-01',
  over: Partial<BacktestInput> = {},
): BacktestInput {
  return {
    positions: [{ assetId: 'A', weight: 100 }],
    assets: [{ assetId: 'A', symbol: 'A', currency: 'EUR', prices: dailyCloses(start, closes) }],
    range: { start, end: dailyCloses(start, closes).at(-1)!.date },
    converter: stubConverter(),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Index construction, weighting, normalisation
// ---------------------------------------------------------------------------

describe('backtest — index construction', () => {
  it('opens at 100 and tracks a single EUR asset as a pure price ratio', async () => {
    const res = await backtest(singleAssetInput([100, 110, 99, 105]));
    expect(res.series.map((p) => p.date)).toEqual([
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
      '2026-01-04',
    ]);
    // index = 100 · close/100 (full precision — no mid-computation rounding)
    [100, 110, 99, 105].forEach((v, i) => expect(res.series[i]?.value).toBeCloseTo(v, 10));
    expect(res.startDate).toBe('2026-01-01');
    expect(res.endDate).toBe('2026-01-04');
    expect(res.notice).toBeNull();
    expect(res.benchmark).toBeNull();
  });

  it('normalises relative weights so the basket opens at exactly 100 (weights need not sum to 100)', async () => {
    // Two EUR assets, weights 3:1 (sum 4, not 100). Both flat → index stays 100.
    const res = await backtest({
      positions: [
        { assetId: 'A', weight: 3 },
        { assetId: 'B', weight: 1 },
      ],
      assets: [
        { assetId: 'A', symbol: 'A', currency: 'EUR', prices: dailyCloses('2026-01-01', [50, 50]) },
        { assetId: 'B', symbol: 'B', currency: 'EUR', prices: dailyCloses('2026-01-01', [10, 20]) },
      ],
      range: { start: '2026-01-01', end: '2026-01-02' },
      converter: stubConverter(),
    });
    // day1: 100·(0.75·1 + 0.25·1) = 100; day2: 100·(0.75·1 + 0.25·2) = 125
    expect(res.series[0]?.value).toBeCloseTo(100, 10);
    expect(res.series[1]?.value).toBeCloseTo(125, 10);
  });

  it('buy-and-hold: weights drift with price (no rebalancing)', async () => {
    // 50/50 by initial value. A doubles, B flat. End index = 100·(0.5·2 + 0.5·1) = 150.
    const res = await backtest({
      positions: [
        { assetId: 'A', weight: 50 },
        { assetId: 'B', weight: 50 },
      ],
      assets: [
        {
          assetId: 'A',
          symbol: 'A',
          currency: 'EUR',
          prices: dailyCloses('2026-01-01', [100, 200]),
        },
        {
          assetId: 'B',
          symbol: 'B',
          currency: 'EUR',
          prices: dailyCloses('2026-01-01', [100, 100]),
        },
      ],
      range: { start: '2026-01-01', end: '2026-01-02' },
      converter: stubConverter(),
    });
    expect(res.series.at(-1)?.value).toBeCloseTo(150, 10);
  });
});

// ---------------------------------------------------------------------------
// Common-start clipping notice (§6.6)
// ---------------------------------------------------------------------------

describe('backtest — common-start clipping', () => {
  it('clips the window to the latest first-available date and names the limiting asset', async () => {
    const res = await backtest({
      positions: [
        { assetId: 'OLD', weight: 50 },
        { assetId: 'TEM', weight: 50 },
      ],
      assets: [
        // OLD has long history; TEM only since 2024-06-14 → TEM limits the start.
        {
          assetId: 'OLD',
          symbol: 'OLD',
          currency: 'EUR',
          prices: [
            { date: '2024-06-12', close: 10 },
            { date: '2024-06-13', close: 10 },
            { date: '2024-06-14', close: 10 },
            { date: '2024-06-15', close: 12 },
          ],
        },
        {
          assetId: 'TEM',
          symbol: 'TEM',
          currency: 'EUR',
          prices: [
            { date: '2024-06-14', close: 20 },
            { date: '2024-06-15', close: 22 },
          ],
        },
      ],
      range: { start: '2024-01-01', end: '2024-06-15' },
      converter: stubConverter(),
    });
    expect(res.notice).toBe('Limited by TEM (data since 2024-06-14)');
    expect(res.startDate).toBe('2024-06-14');
    // Series starts at the common start, not the requested 2024-01-01.
    expect(res.series[0]?.date).toBe('2024-06-14');
    expect(res.series[0]?.value).toBe(100);
  });

  it('a zero-weight position still clips the window but contributes nothing (§6.6: "across positions")', async () => {
    const res = await backtest({
      positions: [
        { assetId: 'A', weight: 100 },
        { assetId: 'Z', weight: 0 },
      ],
      assets: [
        {
          assetId: 'A',
          symbol: 'A',
          currency: 'EUR',
          prices: dailyCloses('2026-01-01', [100, 110, 120, 130]),
        },
        {
          assetId: 'Z',
          symbol: 'Z',
          currency: 'EUR',
          prices: dailyCloses('2026-01-03', [50, 55]),
        },
      ],
      range: { start: '2026-01-01', end: '2026-01-04' },
      converter: stubConverter(),
    });
    expect(res.notice).toBe('Limited by Z (data since 2026-01-03)');
    expect(res.startDate).toBe('2026-01-03');
    // Index is A alone, re-based at 120.
    expect(res.series[0]?.value).toBe(100);
    expect(res.series[1]?.value).toBeCloseTo((130 / 120) * 100, 10);
    const z = res.contributions.find((c) => c.assetId === 'Z');
    expect(z?.weight).toBe(0);
    expect(z?.contributionPct).toBe(0);
  });

  it('produces no notice when the requested start is already within every asset’s history', async () => {
    const res = await backtest(singleAssetInput([100, 101, 102], '2026-03-02'));
    expect(res.notice).toBeNull();
    expect(res.startDate).toBe('2026-03-02');
  });

  it('clips the start up to a later requested start without a notice', async () => {
    // Data from 01-01, but the user asked to start 01-03 → no clip notice, t₀ = 01-03.
    const res = await backtest(
      singleAssetInput([100, 110, 120, 130], '2026-01-01', {
        range: { start: '2026-01-03', end: '2026-01-04' },
      }),
    );
    expect(res.notice).toBeNull();
    expect(res.startDate).toBe('2026-01-03');
    expect(res.series.map((p) => p.date)).toEqual(['2026-01-03', '2026-01-04']);
    // Re-based at 120 → [100, 108.333…]
    expect(res.series[0]?.value).toBe(100);
    expect(res.series[1]?.value).toBeCloseTo((130 / 120) * 100, 10);
  });
});

// ---------------------------------------------------------------------------
// FX conversion at the day's rate (§6.6)
// ---------------------------------------------------------------------------

describe('backtest — FX conversion', () => {
  it('values each close at that day’s FX rate (a moving rate moves the index)', async () => {
    // USD asset, native price flat at 100; USD→EUR rises 0.9 → 1.0. The index must
    // rise purely from FX: t₀ base = 100·0.9 = 90; day2 = 100·1.0 = 100.
    const res = await backtest({
      positions: [{ assetId: 'U', weight: 100 }],
      assets: [
        {
          assetId: 'U',
          symbol: 'U',
          currency: 'USD',
          prices: dailyCloses('2026-01-01', [100, 100]),
        },
      ],
      range: { start: '2026-01-01', end: '2026-01-02' },
      converter: datedConverter({
        USD: { '2026-01-01': 0.9, '2026-01-02': 1.0 },
      }),
    });
    expect(res.series[0]?.value).toBe(100);
    expect(res.series[1]?.value).toBeCloseTo(111.11111111111111, 9);
  });

  it('worked scenario (§6.6): per-day FX × carry-forward, hand-computed end to end', async () => {
    // 50/50 basket. E (EUR) trades daily, flat at 100 — it pins the axis to all
    // four days. U (USD) trades only 01-01 (100) and 01-04 (110); on 01-02/01-03
    // its last close carries forward but is revalued at THAT day's FX rate.
    //
    //   day        U close   USD→EUR   U in EUR   U ratio    index
    //   2026-01-01   100      0.90        90       1         100
    //   2026-01-02  (100)     0.92        92       92/90     100·(0.5 + 0.5·92/90)  = 101.11̄
    //   2026-01-03  (100)     0.95        95       95/90     100·(0.5 + 0.5·95/90)  = 102.77̄
    //   2026-01-04   110      1.00       110      110/90     100·(0.5 + 0.5·110/90) = 111.11̄
    const res = await backtest({
      positions: [
        { assetId: 'E', weight: 50 },
        { assetId: 'U', weight: 50 },
      ],
      assets: [
        {
          assetId: 'E',
          symbol: 'E',
          currency: 'EUR',
          prices: dailyCloses('2026-01-01', [100, 100, 100, 100]),
        },
        {
          assetId: 'U',
          symbol: 'U',
          currency: 'USD',
          prices: [
            { date: '2026-01-01', close: 100 },
            { date: '2026-01-04', close: 110 },
          ],
        },
      ],
      range: { start: '2026-01-01', end: '2026-01-04' },
      converter: datedConverter({
        EUR: { '2026-01-01': 1, '2026-01-02': 1, '2026-01-03': 1, '2026-01-04': 1 },
        USD: {
          '2026-01-01': 0.9,
          '2026-01-02': 0.92,
          '2026-01-03': 0.95,
          '2026-01-04': 1.0,
        },
      }),
    });

    const expected = [
      100,
      100 * (0.5 + (0.5 * 92) / 90),
      100 * (0.5 + (0.5 * 95) / 90),
      100 * (0.5 + (0.5 * 110) / 90),
    ];
    expected.forEach((v, i) => expect(res.series[i]?.value).toBeCloseTo(v, 10));

    // Attribution stays exact under moving FX: U returns (110/90 − 1) in EUR
    // terms, E is flat; weighted contributions sum to the total return.
    const u = res.contributions.find((c) => c.assetId === 'U');
    const e = res.contributions.find((c) => c.assetId === 'E');
    expect(u?.returnPct).toBeCloseTo((110 / 90 - 1) * 100, 9);
    expect(u?.contributionPct).toBeCloseTo(0.5 * (110 / 90 - 1) * 100, 9);
    expect(e?.contributionPct).toBeCloseTo(0, 9);
    const summed = res.contributions.reduce((s, c) => s + c.contributionPct, 0);
    expect(summed).toBeCloseTo(res.stats.totalReturnPct, 9);
    // total return = index(end) − 100 = 11.11̄%
    expect(res.stats.totalReturnPct).toBeCloseTo(100 * (0.5 + (0.5 * 110) / 90) - 100, 9);
  });

  it('coalesces FX: exactly one converter call per (currency, day)', async () => {
    // Two USD assets over 3 days → 3 distinct (USD, day) rates, fetched once each.
    const converter = stubConverter();
    await backtest({
      positions: [
        { assetId: 'A', weight: 50 },
        { assetId: 'B', weight: 50 },
      ],
      assets: [
        {
          assetId: 'A',
          symbol: 'A',
          currency: 'USD',
          prices: dailyCloses('2026-01-01', [100, 101, 102]),
        },
        {
          assetId: 'B',
          symbol: 'B',
          currency: 'USD',
          prices: dailyCloses('2026-01-01', [200, 201, 202]),
        },
      ],
      range: { start: '2026-01-01', end: '2026-01-03' },
      converter,
    });
    expect(converter.toBase).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Carry-forward over non-trading days (§6.6)
// ---------------------------------------------------------------------------

describe('backtest — carry-forward', () => {
  it('carries an asset’s last close forward on days it is missing from the union axis', async () => {
    // A trades every day; B is missing 01-02 and 01-03. The axis is the union of
    // both calendars; on B's missing days B holds its last close.
    const res = await backtest({
      positions: [
        { assetId: 'A', weight: 50 },
        { assetId: 'B', weight: 50 },
      ],
      assets: [
        {
          assetId: 'A',
          symbol: 'A',
          currency: 'EUR',
          prices: [
            { date: '2026-01-01', close: 100 },
            { date: '2026-01-02', close: 100 },
            { date: '2026-01-03', close: 100 },
            { date: '2026-01-04', close: 100 },
          ],
        },
        {
          assetId: 'B',
          symbol: 'B',
          currency: 'EUR',
          prices: [
            { date: '2026-01-01', close: 100 },
            // gap on 01-02 and 01-03 (carried forward at 100)
            { date: '2026-01-04', close: 200 },
          ],
        },
      ],
      range: { start: '2026-01-01', end: '2026-01-04' },
      converter: stubConverter(),
    });
    // Axis = union of both calendars = all four days.
    expect(res.series.map((p) => p.date)).toEqual([
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
      '2026-01-04',
    ]);
    // A flat at 1, B carried at 100/100=1 until 01-04 where it is 200/100=2.
    // index: [100, 100, 100, 100·(0.5·1 + 0.5·2)=150]
    [100, 100, 100, 150].forEach((v, i) => expect(res.series[i]?.value).toBeCloseTo(v, 10));
  });

  it('excludes calendar days on which no asset trades (no weekend dilution)', async () => {
    // A single asset with a two-day gap: the gap days never enter the axis.
    const res = await backtest({
      positions: [{ assetId: 'A', weight: 100 }],
      assets: [
        {
          assetId: 'A',
          symbol: 'A',
          currency: 'EUR',
          prices: [
            { date: '2026-01-01', close: 100 },
            { date: '2026-01-04', close: 110 },
          ],
        },
      ],
      range: { start: '2026-01-01', end: '2026-01-04' },
      converter: stubConverter(),
    });
    expect(res.series.map((p) => p.date)).toEqual(['2026-01-01', '2026-01-04']);
  });
});

// ---------------------------------------------------------------------------
// Statistics (§6.6) — each stat against a fixture
// ---------------------------------------------------------------------------

describe('backtest — statistics', () => {
  it('total return, drawdown, volatility, best/worst day on a known fixture', async () => {
    // Single EUR asset, index == close: [100, 110, 99, 105].
    const { stats } = await backtest(singleAssetInput([100, 110, 99, 105]));

    // total return = 105/100 − 1 = 5%
    expect(stats.totalReturnPct).toBeCloseTo(5, 10);

    // returns: +10%, −10%, +6.0606%
    // peak path 100,110,110,110 → worst drawdown at 99: 99/110 − 1 = −10%
    expect(stats.maxDrawdownPct).toBeCloseTo(-10, 10);

    // best / worst single-day return, tagged with the (later) date
    expect(stats.bestDay).toEqual({ date: '2026-01-02', returnPct: expect.closeTo(10, 9) });
    expect(stats.worstDay).toEqual({ date: '2026-01-03', returnPct: expect.closeTo(-10, 9) });

    // sample σ of [0.1, −0.1, 0.060606] × √252 × 100
    expect(stats.volatilityPct).toBeCloseTo(168.1826371806, 6);
  });

  it('max drawdown tracks the running peak across recoveries (deepest trough wins)', async () => {
    // [100, 90, 105, 80]: first trough −10% off the 100 peak, then a NEW peak at
    // 105, then the deeper trough 80/105 − 1 = −23.809…%. A naive min/max pair
    // (80/105 vs 80/100) or a peak that never updates would both get this wrong.
    const { stats } = await backtest(singleAssetInput([100, 90, 105, 80]));
    expect(stats.maxDrawdownPct).toBeCloseTo((80 / 105 - 1) * 100, 10);
    expect(stats.bestDay).toEqual({
      date: '2026-01-03',
      returnPct: expect.closeTo((105 / 90 - 1) * 100, 9),
    });
    expect(stats.worstDay).toEqual({
      date: '2026-01-04',
      returnPct: expect.closeTo((80 / 105 - 1) * 100, 9),
    });
  });

  it('CAGR annualises with ACT/365.25 and round-trips against the total growth', async () => {
    // Two points: 100 → 200 over 2024-01-01 … 2025-12-31 (730 days).
    const res = await backtest({
      positions: [{ assetId: 'A', weight: 100 }],
      assets: [
        {
          assetId: 'A',
          symbol: 'A',
          currency: 'EUR',
          prices: [
            { date: '2024-01-01', close: 100 },
            { date: '2025-12-31', close: 200 },
          ],
        },
      ],
      range: { start: '2024-01-01', end: '2025-12-31' },
      converter: stubConverter(),
    });
    expect(res.stats.totalReturnPct).toBeCloseTo(100, 9);
    expect(res.stats.cagrPct).toBeCloseTo(41.45493070645705, 6);

    // Independent invariant: (1 + cagr)^years == growth factor (== 2).
    const years = (Date.parse('2025-12-31') - Date.parse('2024-01-01')) / (86_400_000 * 365.25);
    expect((1 + (res.stats.cagrPct ?? 0) / 100) ** years).toBeCloseTo(2, 9);
  });

  it('per-position contributions sum to the total return', async () => {
    // A: 100→150 (+50%) weight 60; B: 100→80 (−20%) weight 40.
    const res = await backtest({
      positions: [
        { assetId: 'A', weight: 60 },
        { assetId: 'B', weight: 40 },
      ],
      assets: [
        {
          assetId: 'A',
          symbol: 'A',
          currency: 'EUR',
          prices: dailyCloses('2026-01-01', [100, 150]),
        },
        {
          assetId: 'B',
          symbol: 'B',
          currency: 'EUR',
          prices: dailyCloses('2026-01-01', [100, 80]),
        },
      ],
      range: { start: '2026-01-01', end: '2026-01-02' },
      converter: stubConverter(),
    });

    const a = res.contributions.find((c) => c.assetId === 'A');
    const b = res.contributions.find((c) => c.assetId === 'B');
    expect(a).toMatchObject({ symbol: 'A', weight: 0.6 });
    expect(a?.returnPct).toBeCloseTo(50, 9);
    expect(a?.contributionPct).toBeCloseTo(30, 9); // 0.6·50
    expect(b?.returnPct).toBeCloseTo(-20, 9);
    expect(b?.contributionPct).toBeCloseTo(-8, 9); // 0.4·−20

    const summed = res.contributions.reduce((s, c) => s + c.contributionPct, 0);
    expect(summed).toBeCloseTo(res.stats.totalReturnPct, 9);
    // index(end) = 100·(0.6·1.5 + 0.4·0.8) = 122 → total return 22%
    expect(res.stats.totalReturnPct).toBeCloseTo(22, 9);
  });

  it('degenerate single-day window: zero return, null annualised stats', async () => {
    const res = await backtest(singleAssetInput([100]));
    expect(res.series).toEqual([{ date: '2026-01-01', value: 100 }]);
    expect(res.stats.totalReturnPct).toBe(0);
    expect(res.stats.cagrPct).toBeNull();
    expect(res.stats.volatilityPct).toBeNull();
    expect(res.stats.maxDrawdownPct).toBe(0);
    expect(res.stats.bestDay).toBeNull();
    expect(res.stats.worstDay).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Benchmark overlay (§6.6)
// ---------------------------------------------------------------------------

describe('backtest — benchmark overlay', () => {
  it('runs the benchmark through the same pipeline at weight 100 over the same axis', async () => {
    const benchmark: BacktestAsset = {
      assetId: 'GSPC',
      symbol: '^GSPC',
      currency: 'USD',
      prices: dailyCloses('2026-01-01', [4000, 4040, 4080, 4120]),
    };
    const res = await backtest(singleAssetInput([100, 110, 99, 105], '2026-01-01', { benchmark }));

    expect(res.benchmark).not.toBeNull();
    expect(res.benchmark?.symbol).toBe('^GSPC');
    // Same dates as the portfolio series (same axis).
    expect(res.benchmark?.series.map((p) => p.date)).toEqual(res.series.map((p) => p.date));
    // Base 100, then 4040/4000·100, … (FX is constant → cancels in the ratio).
    expect(res.benchmark?.series[0]?.value).toBe(100);
    expect(res.benchmark?.series[1]?.value).toBeCloseTo((4040 / 4000) * 100, 9);
    expect(res.benchmark?.series.at(-1)?.value).toBeCloseTo((4120 / 4000) * 100, 9);
    // Benchmark stats computed by the same machinery.
    expect(res.benchmark?.stats.totalReturnPct).toBeCloseTo((4120 / 4000 - 1) * 100, 9);
  });

  it('aligns the benchmark to the portfolio t₀ even when the benchmark has earlier history', async () => {
    const benchmark: BacktestAsset = {
      assetId: 'GDAXI',
      symbol: '^GDAXI',
      currency: 'EUR',
      prices: [
        { date: '2025-12-30', close: 900 }, // before the portfolio start
        { date: '2026-01-01', close: 1000 },
        { date: '2026-01-02', close: 1100 },
      ],
    };
    const res = await backtest(singleAssetInput([100, 110], '2026-01-01', { benchmark }));
    // Benchmark re-based at the portfolio t₀ (2026-01-01 = 1000), not its own first day.
    expect(res.benchmark?.series[0]).toEqual({ date: '2026-01-01', value: 100 });
    expect(res.benchmark?.series[1]?.value).toBeCloseTo(110, 9);
  });

  it('converts the benchmark at each day’s FX and shares the coalesced rate cache with the basket', async () => {
    // Basket and benchmark are both USD → the distinct (USD, day) pairs number
    // exactly 2; a per-pipeline cache would fetch 4. The benchmark's native
    // price moves 200 → 210 while USD→EUR moves 0.9 → 1.0, so its EUR series is
    // 180 → 210 (index 100 → 116.66̄) — proving day-of FX applies to it too.
    const converter = datedConverter({
      USD: { '2026-01-01': 0.9, '2026-01-02': 1.0 },
    });
    const res = await backtest({
      positions: [{ assetId: 'A', weight: 100 }],
      assets: [
        {
          assetId: 'A',
          symbol: 'A',
          currency: 'USD',
          prices: dailyCloses('2026-01-01', [100, 100]),
        },
      ],
      range: { start: '2026-01-01', end: '2026-01-02' },
      converter,
      benchmark: {
        assetId: 'GSPC',
        symbol: '^GSPC',
        currency: 'USD',
        prices: dailyCloses('2026-01-01', [200, 210]),
      },
    });
    expect(res.series[1]?.value).toBeCloseTo((1.0 / 0.9) * 100, 9);
    expect(res.benchmark?.series[0]?.value).toBe(100);
    expect(res.benchmark?.series[1]?.value).toBeCloseTo((210 / 180) * 100, 9);
    expect(converter.toBase).toHaveBeenCalledTimes(2);
  });

  it('throws BacktestError when the benchmark lacks data at the backtest start', async () => {
    const benchmark: BacktestAsset = {
      assetId: 'LATE',
      symbol: 'LATE',
      currency: 'EUR',
      prices: dailyCloses('2026-01-03', [10, 11]), // starts after t₀
    };
    await expect(
      backtest(singleAssetInput([100, 110, 120, 130], '2026-01-01', { benchmark })),
    ).rejects.toThrow(BacktestError);
  });
});

// ---------------------------------------------------------------------------
// Validation & error states
// ---------------------------------------------------------------------------

describe('backtest — validation', () => {
  it('rejects an empty position list', async () => {
    await expect(
      backtest({
        positions: [],
        assets: [],
        range: { start: '2026-01-01', end: '2026-01-02' },
        converter: stubConverter(),
      }),
    ).rejects.toThrow(/at least one position/);
  });

  it('rejects a position referencing an asset with no market data', async () => {
    await expect(
      backtest({
        positions: [{ assetId: 'Z', weight: 100 }],
        assets: [],
        range: { start: '2026-01-01', end: '2026-01-02' },
        converter: stubConverter(),
      }),
    ).rejects.toThrow(/no market data/);
  });

  it('rejects weights that sum to zero', async () => {
    await expect(
      backtest({
        positions: [
          { assetId: 'A', weight: 0 },
          { assetId: 'B', weight: 0 },
        ],
        assets: [
          { assetId: 'A', symbol: 'A', currency: 'EUR', prices: dailyCloses('2026-01-01', [1, 1]) },
          { assetId: 'B', symbol: 'B', currency: 'EUR', prices: dailyCloses('2026-01-01', [1, 1]) },
        ],
        range: { start: '2026-01-01', end: '2026-01-02' },
        converter: stubConverter(),
      }),
    ).rejects.toThrow(/sum to a positive number/);
  });

  it('rejects a negative weight', async () => {
    await expect(
      backtest(
        singleAssetInput([100, 110], '2026-01-01', {
          positions: [{ assetId: 'A', weight: -1 }],
        }),
      ),
    ).rejects.toThrow(/non-negative/);
  });

  it('rejects an inverted range', async () => {
    await expect(
      backtest(
        singleAssetInput([100, 110], '2026-01-01', {
          range: { start: '2026-01-05', end: '2026-01-01' },
        }),
      ),
    ).rejects.toThrow(/must not be after/);
  });

  it('throws BacktestError when the range ends before any asset has data', async () => {
    await expect(
      backtest({
        positions: [{ assetId: 'A', weight: 100 }],
        assets: [
          {
            assetId: 'A',
            symbol: 'A',
            currency: 'EUR',
            prices: dailyCloses('2026-06-01', [10, 11]),
          },
        ],
        range: { start: '2026-01-01', end: '2026-02-01' },
        converter: stubConverter(),
      }),
    ).rejects.toThrow(BacktestError);
  });

  it('throws BacktestError on an invalid FX rate', async () => {
    await expect(
      backtest({
        positions: [{ assetId: 'A', weight: 100 }],
        assets: [
          {
            assetId: 'A',
            symbol: 'A',
            currency: 'USD',
            prices: dailyCloses('2026-01-01', [10, 11]),
          },
        ],
        range: { start: '2026-01-01', end: '2026-01-02' },
        converter: stubConverter({ USD: 0 }), // rate ≤ 0
      }),
    ).rejects.toThrow(/Invalid FX rate/);
  });

  it('rejects a malformed range date', async () => {
    await expect(
      backtest(
        singleAssetInput([100, 110], '2026-01-01', {
          range: { start: '01/01/2026', end: '2026-01-02' },
        }),
      ),
    ).rejects.toThrow(/ISO YYYY-MM-DD/);
  });

  it('rejects a malformed date even in a single-point price series (comparator-escape regression)', async () => {
    // A sort comparator never runs for a 1-element array — validation must be
    // an explicit pass, or this lone bad date slips straight into the axis.
    await expect(
      backtest({
        positions: [{ assetId: 'A', weight: 100 }],
        assets: [
          { assetId: 'A', symbol: 'A', currency: 'EUR', prices: [{ date: '2026-1-1', close: 10 }] },
        ],
        range: { start: '2026-01-01', end: '2026-01-02' },
        converter: stubConverter(),
      }),
    ).rejects.toThrow(/ISO YYYY-MM-DD/);
  });

  it('rejects a non-finite close anywhere in the series (not only at t₀)', async () => {
    await expect(
      backtest({
        positions: [{ assetId: 'A', weight: 100 }],
        assets: [
          {
            assetId: 'A',
            symbol: 'A',
            currency: 'EUR',
            prices: [
              { date: '2026-01-01', close: 100 },
              { date: '2026-01-02', close: Number.NaN },
            ],
          },
        ],
        range: { start: '2026-01-01', end: '2026-01-02' },
        converter: stubConverter(),
      }),
    ).rejects.toThrow(/finite close/);
  });

  it('rejects a non-finite close in the benchmark series too', async () => {
    await expect(
      backtest(
        singleAssetInput([100, 110], '2026-01-01', {
          benchmark: {
            assetId: 'B',
            symbol: 'B',
            currency: 'EUR',
            prices: [
              { date: '2026-01-01', close: 100 },
              { date: '2026-01-02', close: Number.POSITIVE_INFINITY },
            ],
          },
        }),
      ),
    ).rejects.toThrow(/finite close/);
  });
});

// ---------------------------------------------------------------------------
// Rebalance primitive (§14) — shared with future scheduled rebalancing
// ---------------------------------------------------------------------------

describe('rebalanceToTargets — the §14 entry-day rebalance primitive', () => {
  it('reallocates the total value to the normalised target weights', () => {
    const out = rebalanceToTargets(
      [
        { key: 'A', value: 60 },
        { key: 'B', value: 40 },
      ],
      [
        { key: 'A', weight: 1 },
        { key: 'B', weight: 1 },
      ],
    );
    expect(out).toEqual([
      { key: 'A', value: 50 },
      { key: 'B', value: 50 },
    ]);
  });

  it('normalises relative weights (they need not sum to 1 or 100) and conserves the total', () => {
    const out = rebalanceToTargets(
      [
        { key: 'A', value: 123.45 },
        { key: 'B', value: 0.55 },
        { key: 'C', value: 76 },
      ],
      [
        { key: 'A', weight: 3 },
        { key: 'B', weight: 1 },
      ],
    );
    const total = 123.45 + 0.55 + 76;
    expect(out[0]?.value).toBeCloseTo(0.75 * total, 12);
    expect(out[1]?.value).toBeCloseTo(0.25 * total, 12);
    expect(out.reduce((s, h) => s + h.value, 0)).toBeCloseTo(total, 12);
  });

  it('a target key absent from the holdings enters with its full share (the entry case)', () => {
    // SpaceX enters: it holds nothing yet but the targets now include it.
    const out = rebalanceToTargets(
      [
        { key: 'BAYN', value: 40 },
        { key: 'KO', value: 60 },
      ],
      [
        { key: 'BAYN', weight: 25 },
        { key: 'KO', weight: 25 },
        { key: 'SPX', weight: 50 },
      ],
    );
    expect(out).toEqual([
      { key: 'BAYN', value: 25 },
      { key: 'KO', value: 25 },
      { key: 'SPX', value: 50 },
    ]);
  });

  it('a holding key absent from the targets is liquidated into the pool (cash absorbs in)', () => {
    const out = rebalanceToTargets(
      [
        { key: 'A', value: 50 },
        { key: 'cash', value: 50 },
      ],
      [{ key: 'A', weight: 1 }],
    );
    expect(out).toEqual([{ key: 'A', value: 100 }]);
  });

  it('a zero total value is legal and yields all-zero holdings', () => {
    const out = rebalanceToTargets(
      [{ key: 'A', value: 0 }],
      [
        { key: 'A', weight: 1 },
        { key: 'B', weight: 1 },
      ],
    );
    expect(out).toEqual([
      { key: 'A', value: 0 },
      { key: 'B', value: 0 },
    ]);
  });

  it('rejects duplicate holding or target keys', () => {
    expect(() =>
      rebalanceToTargets(
        [
          { key: 'A', value: 1 },
          { key: 'A', value: 2 },
        ],
        [{ key: 'A', weight: 1 }],
      ),
    ).toThrow(/duplicate holding key/);
    expect(() =>
      rebalanceToTargets(
        [{ key: 'A', value: 1 }],
        [
          { key: 'A', weight: 1 },
          { key: 'A', weight: 2 },
        ],
      ),
    ).toThrow(/duplicate target key/);
  });

  it('rejects negative or non-finite holding values (shorts are not modelled)', () => {
    expect(() => rebalanceToTargets([{ key: 'A', value: -1 }], [{ key: 'A', weight: 1 }])).toThrow(
      /finite non-negative value/,
    );
    expect(() =>
      rebalanceToTargets([{ key: 'A', value: Number.NaN }], [{ key: 'A', weight: 1 }]),
    ).toThrow(/finite non-negative value/);
  });

  it('rejects negative, non-finite, empty, or all-zero target weights', () => {
    expect(() =>
      rebalanceToTargets([{ key: 'A', value: 1 }], [{ key: 'A', weight: -0.1 }]),
    ).toThrow(/finite non-negative weight/);
    expect(() =>
      rebalanceToTargets(
        [{ key: 'A', value: 1 }],
        [{ key: 'A', weight: Number.POSITIVE_INFINITY }],
      ),
    ).toThrow(/finite non-negative weight/);
    expect(() => rebalanceToTargets([{ key: 'A', value: 1 }], [])).toThrow(
      /sum to a positive number/,
    );
    expect(() =>
      rebalanceToTargets(
        [{ key: 'A', value: 1 }],
        [
          { key: 'A', weight: 0 },
          { key: 'B', weight: 0 },
        ],
      ),
    ).toThrow(/sum to a positive number/);
  });
});

// ---------------------------------------------------------------------------
// Late-listing modes (§14)
// ---------------------------------------------------------------------------

describe('backtest — late-listing modes (§14)', () => {
  /** 50/50 basket: A listed from day one, L lists on day 3 of 4. */
  function lateFixture(): BacktestInput {
    return {
      positions: [
        { assetId: 'A', weight: 50 },
        { assetId: 'L', weight: 50 },
      ],
      assets: [
        {
          assetId: 'A',
          symbol: 'A',
          currency: 'EUR',
          prices: dailyCloses('2026-01-01', [100, 110, 120, 130]),
        },
        {
          assetId: 'L',
          symbol: 'L',
          currency: 'EUR',
          prices: [
            { date: '2026-01-03', close: 200 },
            { date: '2026-01-04', close: 250 },
          ],
        },
      ],
      range: { start: '2026-01-01', end: '2026-01-04' },
      converter: stubConverter(),
    };
  }

  it('defaults to clip, and an explicit clip returns an identical result (pre-§14 regression)', async () => {
    const implicit = await backtest(lateFixture());
    const explicit = await backtest({ ...lateFixture(), mode: 'clip' });

    // The default mode carries the new fields in their clip shape …
    expect(implicit.mode).toBe('clip');
    expect(implicit.entryEvents).toEqual([]);
    expect(implicit.idleCashAvgPct).toBeNull();
    // … and is exactly the pre-§14 clipped result.
    expect(implicit.notice).toBe('Limited by L (data since 2026-01-03)');
    expect(implicit.startDate).toBe('2026-01-03');
    expect(implicit.series.map((p) => p.date)).toEqual(['2026-01-03', '2026-01-04']);
    expect(explicit).toEqual(implicit);
  });

  it('rejects an unknown mode (caller bug, not a data state)', async () => {
    await expect(backtest({ ...lateFixture(), mode: 'yolo' as never })).rejects.toThrow(
      /unknown mode/,
    );
  });

  it('cash mode: the late share sits at 0 % return, buys in at the first close on/after listing, and reports idle cash', async () => {
    // Hand-computed:
    //   day    A value        L value                cash   index
    //   01-01  0.5·1   = 0.5  —                      0.5    100
    //   01-02  0.5·1.1 = 0.55 —                      0.5    105
    //   01-03  0.5·1.2 = 0.6  0.5 (buys in at 200)   0      110
    //   01-04  0.5·1.3 = 0.65 0.5·250/200 = 0.625    0      127.5
    const res = await backtest({ ...lateFixture(), mode: 'cash' });

    expect(res.mode).toBe('cash');
    expect(res.startDate).toBe('2026-01-01');
    expect(res.notice).toBeNull(); // the full window ran — no clipping message
    expect(res.series.map((p) => p.date)).toEqual([
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
      '2026-01-04',
    ]);
    [100, 105, 110, 127.5].forEach((v, i) => expect(res.series[i]?.value).toBeCloseTo(v, 10));

    expect(res.entryEvents).toEqual([{ assetId: 'L', symbol: 'L', date: '2026-01-03' }]);

    // Mean uninvested share: 0.5 on 01-01, 0.5/1.05 on 01-02, 0 afterwards.
    expect(res.idleCashAvgPct).toBeCloseTo(((0.5 + 0.5 / 1.05) / 4) * 100, 10);

    // Attribution: A returns +30 % on half, L +25 % (from ITS entry) on half.
    const a = res.contributions.find((c) => c.assetId === 'A');
    const l = res.contributions.find((c) => c.assetId === 'L');
    expect(a?.returnPct).toBeCloseTo(30, 9);
    expect(a?.contributionPct).toBeCloseTo(15, 9);
    expect(l?.returnPct).toBeCloseTo(25, 9);
    expect(l?.contributionPct).toBeCloseTo(12.5, 9);
    const summed = res.contributions.reduce((s, c) => s + c.contributionPct, 0);
    expect(summed).toBeCloseTo(res.stats.totalReturnPct, 9);
  });

  it('cash mode: an asset that never lists inside the window stays cash the whole way (no event)', async () => {
    // Clip mode would throw here (common start after range end); cash mode keeps
    // the never-listed share as a 0 %-return drag instead.
    const res = await backtest({
      positions: [
        { assetId: 'A', weight: 50 },
        { assetId: 'L', weight: 50 },
      ],
      assets: [
        {
          assetId: 'A',
          symbol: 'A',
          currency: 'EUR',
          prices: dailyCloses('2026-01-01', [100, 110]),
        },
        { assetId: 'L', symbol: 'L', currency: 'EUR', prices: [{ date: '2026-02-01', close: 5 }] },
      ],
      range: { start: '2026-01-01', end: '2026-01-02' },
      converter: stubConverter(),
      mode: 'cash',
    });
    expect(res.entryEvents).toEqual([]);
    expect(res.series.map((p) => p.value)).toEqual([100, 105]);
    expect(res.idleCashAvgPct).toBeCloseTo(((0.5 + 0.5 / 1.05) / 2) * 100, 10);
    const l = res.contributions.find((c) => c.assetId === 'L');
    expect(l?.returnPct).toBe(0);
    expect(l?.contributionPct).toBe(0);
  });

  it('cash mode: a late USD asset buys in at the entry day’s FX and revalues at each day’s rate', async () => {
    // U enters 01-02 at 100 USD · 0.8 = 80 EUR; on 01-03 the same 100 USD is
    // worth 100 EUR, so its half returns +25 % purely from FX.
    const converter = datedConverter({
      EUR: { '2026-01-01': 1, '2026-01-02': 1, '2026-01-03': 1 },
      USD: { '2026-01-02': 0.8, '2026-01-03': 1.0 },
    });
    const res = await backtest({
      positions: [
        { assetId: 'A', weight: 50 },
        { assetId: 'U', weight: 50 },
      ],
      assets: [
        {
          assetId: 'A',
          symbol: 'A',
          currency: 'EUR',
          prices: dailyCloses('2026-01-01', [100, 100, 100]),
        },
        {
          assetId: 'U',
          symbol: 'U',
          currency: 'USD',
          prices: [
            { date: '2026-01-02', close: 100 },
            { date: '2026-01-03', close: 100 },
          ],
        },
      ],
      range: { start: '2026-01-01', end: '2026-01-03' },
      converter,
      mode: 'cash',
    });
    [100, 100, 112.5].forEach((v, i) => expect(res.series[i]?.value).toBeCloseTo(v, 10));
    // FX still coalesced: EUR×3 days + USD×2 listed days = 5 distinct pairs.
    expect(converter.toBase).toHaveBeenCalledTimes(5);
  });

  it('redistribute mode: equal split among listed constituents, entry-day rebalance per event, money-weighted attribution', async () => {
    // A (w 0.5) trades flat throughout; B (w 0.3) lists on day 3; C (w 0.2)
    // lists on day 5. Hand-computed:
    //   day 1  targets A ← 1.0 (absorbs B+C)            V = 1      index 100
    //   day 2  A flat                                   V = 1      index 100
    //   day 3  B enters at 50 → rebalance to A .6 / B .4 (each of A,B absorbs
    //          half of C's 0.2)                         V = 1      index 100
    //   day 4  B 55: 0.4·1.1 = 0.44, A 0.6              V = 1.04   index 104
    //   day 5  B 60 → 0.48; V pre = 1.08; C enters → rebalance to .5/.3/.2
    //                                                   V = 1.08   index 108
    const res = await backtest({
      positions: [
        { assetId: 'A', weight: 50 },
        { assetId: 'B', weight: 30 },
        { assetId: 'C', weight: 20 },
      ],
      assets: [
        {
          assetId: 'A',
          symbol: 'A',
          currency: 'EUR',
          prices: dailyCloses('2026-01-01', [100, 100, 100, 100, 100]),
        },
        {
          assetId: 'B',
          symbol: 'B',
          currency: 'EUR',
          prices: [
            { date: '2026-01-03', close: 50 },
            { date: '2026-01-04', close: 55 },
            { date: '2026-01-05', close: 60 },
          ],
        },
        { assetId: 'C', symbol: 'C', currency: 'EUR', prices: [{ date: '2026-01-05', close: 10 }] },
      ],
      range: { start: '2026-01-01', end: '2026-01-05' },
      converter: stubConverter(),
      mode: 'redistribute',
    });

    expect(res.mode).toBe('redistribute');
    expect(res.startDate).toBe('2026-01-01');
    expect(res.notice).toBeNull();
    expect(res.idleCashAvgPct).toBeNull();
    [100, 100, 100, 104, 108].forEach((v, i) => expect(res.series[i]?.value).toBeCloseTo(v, 10));

    // Two entry events, each late asset handled independently at its own date.
    expect(res.entryEvents).toEqual([
      { assetId: 'B', symbol: 'B', date: '2026-01-03' },
      { assetId: 'C', symbol: 'C', date: '2026-01-05' },
    ]);

    // Money-weighted attribution: B carried 40 % (its 30 % target + half of
    // C's missing 20 %) through its +20 % run, so it contributed the full 8 %
    // — MORE than weight·returnPct (0.3·20 = 6). The flat assets contribute 0.
    const a = res.contributions.find((c) => c.assetId === 'A');
    const b = res.contributions.find((c) => c.assetId === 'B');
    const c = res.contributions.find((c) => c.assetId === 'C');
    expect(a?.contributionPct).toBeCloseTo(0, 9);
    expect(b?.returnPct).toBeCloseTo(20, 9);
    expect(b?.contributionPct).toBeCloseTo(8, 9);
    expect(c?.contributionPct).toBeCloseTo(0, 9);
    const summed = res.contributions.reduce((s, x) => s + x.contributionPct, 0);
    expect(summed).toBeCloseTo(res.stats.totalReturnPct, 9);
  });

  it('cash mode: two late assets enter independently, each at its own date', async () => {
    const res = await backtest({
      positions: [
        { assetId: 'A', weight: 40 },
        { assetId: 'B', weight: 30 },
        { assetId: 'C', weight: 30 },
      ],
      assets: [
        {
          assetId: 'A',
          symbol: 'A',
          currency: 'EUR',
          prices: dailyCloses('2026-01-01', [10, 10, 10, 10]),
        },
        {
          assetId: 'B',
          symbol: 'B',
          currency: 'EUR',
          prices: dailyCloses('2026-01-02', [20, 20, 20]),
        },
        { assetId: 'C', symbol: 'C', currency: 'EUR', prices: dailyCloses('2026-01-04', [30]) },
      ],
      range: { start: '2026-01-01', end: '2026-01-04' },
      converter: stubConverter(),
      mode: 'cash',
    });
    expect(res.entryEvents).toEqual([
      { assetId: 'B', symbol: 'B', date: '2026-01-02' },
      { assetId: 'C', symbol: 'C', date: '2026-01-04' },
    ]);
    // Everything is flat, so the index pins at 100 while cash steps 0.6 → 0.3 → 0.
    expect(res.series.map((p) => p.value)).toEqual([100, 100, 100, 100]);
    expect(res.idleCashAvgPct).toBeCloseTo(((0.6 + 0.3 + 0.3 + 0) / 4) * 100, 10);
  });

  it('clips a full-window mode only up to the EARLIEST first-available date, with the notice', async () => {
    // Every constituent lists after the requested start — before A exists there
    // is nothing to hold, so the window clips to A's listing and says so.
    const res = await backtest({
      positions: [
        { assetId: 'A', weight: 50 },
        { assetId: 'L', weight: 50 },
      ],
      assets: [
        {
          assetId: 'A',
          symbol: 'A',
          currency: 'EUR',
          prices: dailyCloses('2026-02-01', [100, 100, 100]),
        },
        { assetId: 'L', symbol: 'L', currency: 'EUR', prices: dailyCloses('2026-02-03', [50]) },
      ],
      range: { start: '2026-01-01', end: '2026-02-03' },
      converter: stubConverter(),
      mode: 'cash',
    });
    expect(res.notice).toBe('Limited by A (data since 2026-02-01)');
    expect(res.startDate).toBe('2026-02-01');
    expect(res.entryEvents).toEqual([{ assetId: 'L', symbol: 'L', date: '2026-02-03' }]);
  });

  it('the benchmark always runs the full requested window in the late-listing modes', async () => {
    const benchmark: BacktestAsset = {
      assetId: 'GSPC',
      symbol: '^GSPC',
      currency: 'EUR',
      prices: dailyCloses('2026-01-01', [1000, 1010, 1020, 1030]),
    };
    const cash = await backtest({ ...lateFixture(), mode: 'cash', benchmark });
    // Full axis: the overlay shares every one of the four window days …
    expect(cash.benchmark?.series.map((p) => p.date)).toEqual([
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
      '2026-01-04',
    ]);
    expect(cash.benchmark?.series[0]?.value).toBe(100);
    expect(cash.benchmark?.stats.totalReturnPct).toBeCloseTo(3, 9);

    // … while clip mode on the same input clips the overlay with the basket.
    const clip = await backtest({ ...lateFixture(), mode: 'clip', benchmark });
    expect(clip.benchmark?.series.map((p) => p.date)).toEqual(['2026-01-03', '2026-01-04']);
  });

  it('SpaceX case: one late constituent, all three modes visibly differ, with entry markers (snapshot)', async () => {
    // 25/25/25/25 basket over ten days; SPX lists on day 6 ("listed 18 months
    // ago, backtest is 5Y", scaled down). BAYN rises, KO drifts up, BMW falls,
    // SPX gains 20 % from its listing.
    function spaceXCase(mode: 'clip' | 'cash' | 'redistribute'): BacktestInput {
      return {
        positions: [
          { assetId: 'BAYN', weight: 25 },
          { assetId: 'SPX', weight: 25 },
          { assetId: 'KO', weight: 25 },
          { assetId: 'BMW', weight: 25 },
        ],
        assets: [
          {
            assetId: 'BAYN',
            symbol: 'BAYN',
            currency: 'EUR',
            prices: dailyCloses('2026-01-01', [100, 102, 104, 106, 108, 110, 112, 114, 116, 118]),
          },
          {
            assetId: 'KO',
            symbol: 'KO',
            currency: 'EUR',
            prices: dailyCloses('2026-01-01', [50, 50.5, 51, 51.5, 52, 52.5, 53, 53.5, 54, 54.5]),
          },
          {
            assetId: 'BMW',
            symbol: 'BMW',
            currency: 'EUR',
            prices: dailyCloses('2026-01-01', [80, 79, 78, 77, 76, 75, 74, 73, 72, 71]),
          },
          {
            assetId: 'SPX',
            symbol: 'SPX',
            currency: 'EUR',
            prices: dailyCloses('2026-01-06', [400, 420, 440, 460, 480]),
          },
        ],
        range: { start: '2026-01-01', end: '2026-01-10' },
        converter: stubConverter(),
        mode,
      };
    }

    const clip = await backtest(spaceXCase('clip'));
    const cash = await backtest(spaceXCase('cash'));
    const redistribute = await backtest(spaceXCase('redistribute'));

    // Clip runs 01-06 → 01-10 with the clipping notice; the full-window modes
    // run all ten days with an SPX entry event instead of the notice.
    expect(clip.startDate).toBe('2026-01-06');
    expect(clip.notice).toBe('Limited by SPX (data since 2026-01-06)');
    expect(clip.entryEvents).toEqual([]);
    for (const res of [cash, redistribute]) {
      expect(res.startDate).toBe('2026-01-01');
      expect(res.notice).toBeNull();
      expect(res.entryEvents).toEqual([{ assetId: 'SPX', symbol: 'SPX', date: '2026-01-06' }]);
    }
    expect(cash.idleCashAvgPct).toBeGreaterThan(0);
    expect(redistribute.idleCashAvgPct).toBeNull();

    // Hand-computed end levels:
    //   post-listing growth factor  G = (118/110 + 54.5/52.5 + 71/75 + 480/400)/4
    //   clip          = 100 · G
    //   cash          = 25 · (118/100 + 54.5/50 + 71/80 + 480/400) = 108.9375
    //   redistribute  = 100 · G · V(01-06),  V(01-06) = (110/100 + 52.5/50 + 75/80)/3
    const growth = (118 / 110 + 54.5 / 52.5 + 71 / 75 + 480 / 400) / 4;
    const preEntry = (110 / 100 + 52.5 / 50 + 75 / 80) / 3;
    expect(clip.series.at(-1)?.value).toBeCloseTo(100 * growth, 9);
    expect(cash.series.at(-1)?.value).toBeCloseTo(108.9375, 9);
    expect(redistribute.series.at(-1)?.value).toBeCloseTo(100 * growth * preEntry, 9);

    // Visibly different results in all three modes.
    const ends = [clip, cash, redistribute].map((r) => r.series.at(-1)!.value);
    expect(Math.abs(ends[0]! - ends[1]!)).toBeGreaterThan(0.5);
    expect(Math.abs(ends[1]! - ends[2]!)).toBeGreaterThan(0.5);
    expect(Math.abs(ends[0]! - ends[2]!)).toBeGreaterThan(0.5);

    // Pin the full series triple + events for regression.
    const pick = ({
      startDate,
      endDate,
      notice,
      series,
      entryEvents,
      idleCashAvgPct,
    }: typeof clip) => ({
      startDate,
      endDate,
      notice,
      series,
      entryEvents,
      idleCashAvgPct,
    });
    expect({
      clip: pick(clip),
      cash: pick(cash),
      redistribute: pick(redistribute),
    }).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// Scheduled rebalancing (V4-P7)
// ---------------------------------------------------------------------------

describe('backtest — scheduled rebalancing (V4-P7)', () => {
  it('defaults to none: an omitted frequency and an explicit `none` are identical, with the new fields in their empty shape', async () => {
    // Covers all three modes: `clip` keeps the untouched pre-§14 pipeline,
    // the event-driven modes run with no boundary triggers.
    for (const mode of ['clip', 'cash', 'redistribute'] as const) {
      const omitted = await backtest({ ...singleAssetInput([100, 110, 99]), mode });
      const explicit = await backtest({
        ...singleAssetInput([100, 110, 99]),
        mode,
        rebalance: 'none',
      });
      expect(omitted.rebalance).toBe('none');
      expect(omitted.rebalanceEvents).toEqual([]);
      expect(explicit).toEqual(omitted);
    }
  });

  it('rejects an unknown rebalance frequency (caller bug, not a data state)', async () => {
    await expect(
      backtest({ ...singleAssetInput([100, 110]), rebalance: 'weekly' as never }),
    ).rejects.toThrow(/unknown rebalance frequency/);
  });

  it('yearly: a 60/40 two-asset backtest rebalances to target weights on the first trading day of the new year (hand-computed)', async () => {
    // A (60 %) and B (40 %), EUR. Hand-computed, portfolio in index units:
    //   day          A close  B close  a value          b value        index
    //   2025-12-30   100      100      0.6              0.4            100
    //   2025-12-31   120       90      0.72             0.36           108
    //   2026-01-02   120       90      0.72             0.36           108
    //     ↳ new year → rebalance 1.08 to 60/40:  a 0.648, b 0.432 (index unmoved)
    //   2026-01-05   132       90      0.648·1.1=0.7128 0.432          114.48
    // Buy-and-hold would end at 100·(0.6·1.32 + 0.4·0.9) = 115.2 — the schedule
    // visibly changes the result.
    const input: BacktestInput = {
      positions: [
        { assetId: 'A', weight: 60 },
        { assetId: 'B', weight: 40 },
      ],
      assets: [
        {
          assetId: 'A',
          symbol: 'A',
          currency: 'EUR',
          prices: [
            { date: '2025-12-30', close: 100 },
            { date: '2025-12-31', close: 120 },
            { date: '2026-01-02', close: 120 },
            { date: '2026-01-05', close: 132 },
          ],
        },
        {
          assetId: 'B',
          symbol: 'B',
          currency: 'EUR',
          prices: [
            { date: '2025-12-30', close: 100 },
            { date: '2025-12-31', close: 90 },
            { date: '2026-01-02', close: 90 },
            { date: '2026-01-05', close: 90 },
          ],
        },
      ],
      range: { start: '2025-12-30', end: '2026-01-05' },
      converter: stubConverter(),
    };

    const res = await backtest({ ...input, rebalance: 'yearly' });
    expect(res.rebalance).toBe('yearly');
    expect(res.mode).toBe('clip'); // schedule works in the default mode
    expect(res.entryEvents).toEqual([]); // nothing listed late
    // Exactly one rebalance, on the first trading day of 2026 (Jan 1 is not on
    // the axis) — and never on t₀, which already sits at target weights.
    expect(res.rebalanceEvents).toEqual([{ date: '2026-01-02' }]);
    [100, 108, 108, 114.48].forEach((v, i) => expect(res.series[i]?.value).toBeCloseTo(v, 10));
    expect(res.stats.totalReturnPct).toBeCloseTo(14.48, 10);

    // Money-weighted attribution across the rebalance still sums to the total:
    // A gains 0.12 in 2025 + 0.0648 after the reset = 0.1848; B loses 0.04.
    const a = res.contributions.find((c) => c.assetId === 'A');
    const b = res.contributions.find((c) => c.assetId === 'B');
    expect(a?.returnPct).toBeCloseTo(32, 9); // own price return, unaffected
    expect(a?.contributionPct).toBeCloseTo(18.48, 9);
    expect(b?.contributionPct).toBeCloseTo(-4, 9);
    const summed = res.contributions.reduce((s, c) => s + c.contributionPct, 0);
    expect(summed).toBeCloseTo(res.stats.totalReturnPct, 9);

    // The buy-and-hold end level differs — the schedule actually did something.
    const hold = await backtest(input);
    expect(hold.series.at(-1)?.value).toBeCloseTo(115.2, 10);
    expect(hold.rebalanceEvents).toEqual([]);
  });

  it('monthly: rebalances on the first trading day of the new month (a weekend boundary slides to Monday), hand-computed', async () => {
    // 50/50. 2026-01-31/02-01 fall on a weekend: the Feb rebalance executes on
    // Monday 2026-02-02, the month's first trading day.
    //   day          A close  B close  a value          b value          index
    //   2026-01-30   100      100      0.5              0.5              100
    //   2026-02-02   110      100      0.55             0.5              105
    //     ↳ new month → rebalance 1.05 to 50/50: 0.525 each
    //   2026-02-03   110      110      0.525            0.525·1.1=0.5775 110.25
    // (Buy-and-hold ends at 110 — the reset shifted capital into B pre-rise.)
    const res = await backtest({
      positions: [
        { assetId: 'A', weight: 50 },
        { assetId: 'B', weight: 50 },
      ],
      assets: [
        {
          assetId: 'A',
          symbol: 'A',
          currency: 'EUR',
          prices: [
            { date: '2026-01-30', close: 100 },
            { date: '2026-02-02', close: 110 },
            { date: '2026-02-03', close: 110 },
          ],
        },
        {
          assetId: 'B',
          symbol: 'B',
          currency: 'EUR',
          prices: [
            { date: '2026-01-30', close: 100 },
            { date: '2026-02-02', close: 100 },
            { date: '2026-02-03', close: 110 },
          ],
        },
      ],
      range: { start: '2026-01-30', end: '2026-02-03' },
      converter: stubConverter(),
      rebalance: 'monthly',
    });
    expect(res.rebalanceEvents).toEqual([{ date: '2026-02-02' }]);
    [100, 105, 110.25].forEach((v, i) => expect(res.series[i]?.value).toBeCloseTo(v, 10));
  });

  it('quarterly: skips plain month boundaries and rebalances on the first trading day of the new quarter, hand-computed', async () => {
    // 50/50. The Feb 2 month boundary must NOT trigger (same quarter); the
    // Apr 1 quarter boundary must.
    //   day          A close  B close  a value          b value  index
    //   2026-01-02   100      100      0.5              0.5      100
    //   2026-02-02   120      100      0.6              0.5      110   (no event)
    //   2026-04-01   120      100      0.6              0.5      110
    //     ↳ new quarter → rebalance 1.1 to 50/50: 0.55 each
    //   2026-04-02   132      100      0.55·1.1=0.605   0.55     115.5
    const closes = (c: [number, number, number, number]) =>
      ['2026-01-02', '2026-02-02', '2026-04-01', '2026-04-02'].map((date, i) => ({
        date,
        close: c[i]!,
      }));
    const res = await backtest({
      positions: [
        { assetId: 'A', weight: 50 },
        { assetId: 'B', weight: 50 },
      ],
      assets: [
        { assetId: 'A', symbol: 'A', currency: 'EUR', prices: closes([100, 120, 120, 132]) },
        { assetId: 'B', symbol: 'B', currency: 'EUR', prices: closes([100, 100, 100, 100]) },
      ],
      range: { start: '2026-01-02', end: '2026-04-02' },
      converter: stubConverter(),
      rebalance: 'quarterly',
    });
    expect(res.rebalanceEvents).toEqual([{ date: '2026-04-01' }]);
    [100, 110, 110, 115.5].forEach((v, i) => expect(res.series[i]?.value).toBeCloseTo(v, 10));
  });

  it('a trading gap spanning several period boundaries collapses into ONE rebalance on the next trading day', async () => {
    // Monthly schedule, but no trading day in all of February: 2026-01-16 jumps
    // to 2026-03-02 — one rebalance there, not two. A single-asset basket keeps
    // the index a pure price ratio (the reset is a value-conserving no-op) while
    // still reporting the executed schedule.
    const res = await backtest({
      positions: [{ assetId: 'A', weight: 100 }],
      assets: [
        {
          assetId: 'A',
          symbol: 'A',
          currency: 'EUR',
          prices: [
            { date: '2026-01-15', close: 100 },
            { date: '2026-01-16', close: 110 },
            { date: '2026-03-02', close: 120 },
            { date: '2026-03-03', close: 130 },
          ],
        },
      ],
      range: { start: '2026-01-15', end: '2026-03-03' },
      converter: stubConverter(),
      rebalance: 'monthly',
    });
    expect(res.rebalanceEvents).toEqual([{ date: '2026-03-02' }]);
    [100, 110, 120, 130].forEach((v, i) => expect(res.series[i]?.value).toBeCloseTo(v, 10));
  });

  it('clip mode + schedule: clips the window as usual, no entry events, and rebalances the full basket (hand-computed)', async () => {
    // L lists 2026-01-30 → clip start there (with the notice). Every asset is
    // listed from t₀, so the event-driven path emits no entry events; the Feb
    // boundary rebalances the whole basket.
    //   day          A close  L close  a value  l value          index
    //   2026-01-30   100      200      0.5      0.5              100
    //   2026-02-02   110      200      0.55     0.5              105
    //     ↳ rebalance 1.05 to 50/50: 0.525 each
    //   2026-02-03   110      220      0.525    0.525·1.1=0.5775 110.25
    const res = await backtest({
      positions: [
        { assetId: 'A', weight: 50 },
        { assetId: 'L', weight: 50 },
      ],
      assets: [
        {
          assetId: 'A',
          symbol: 'A',
          currency: 'EUR',
          prices: [
            { date: '2026-01-01', close: 90 },
            { date: '2026-01-30', close: 100 },
            { date: '2026-02-02', close: 110 },
            { date: '2026-02-03', close: 110 },
          ],
        },
        {
          assetId: 'L',
          symbol: 'L',
          currency: 'EUR',
          prices: [
            { date: '2026-01-30', close: 200 },
            { date: '2026-02-02', close: 200 },
            { date: '2026-02-03', close: 220 },
          ],
        },
      ],
      range: { start: '2026-01-01', end: '2026-02-03' },
      converter: stubConverter(),
      mode: 'clip',
      rebalance: 'monthly',
    });
    expect(res.notice).toBe('Limited by L (data since 2026-01-30)');
    expect(res.startDate).toBe('2026-01-30');
    expect(res.entryEvents).toEqual([]);
    expect(res.idleCashAvgPct).toBeNull();
    expect(res.rebalanceEvents).toEqual([{ date: '2026-02-02' }]);
    [100, 105, 110.25].forEach((v, i) => expect(res.series[i]?.value).toBeCloseTo(v, 10));
    const summed = res.contributions.reduce((s, c) => s + c.contributionPct, 0);
    expect(summed).toBeCloseTo(res.stats.totalReturnPct, 9);
  });

  it('cash mode + schedule: only the invested sleeve rebalances — the not-yet-listed share stays untouched cash and still buys in at full target weight (hand-computed)', async () => {
    // A 40 / B 40 / L 20; L lists 2026-02-03. Monthly schedule.
    //   day          closes            a         b     l     cash  index
    //   2026-01-30   A 100 B 100       0.4       0.4   —     0.2   100
    //   2026-02-02   A 120 B 100       0.48      0.4   —     0.2   108
    //     ↳ boundary: rebalance ONLY the sleeve (0.88) to A:B = 40:40 →
    //       a 0.44, b 0.44; the 0.2 pool is L's and stays exactly put
    //   2026-02-03   A 120 B 100 L 50  0.44      0.44  0.2   0     108
    //     ↳ L enters at its full 20 % target share (no boundary today)
    //   2026-02-04   A 132 B 100 L 55  0.44·1.1  0.44  0.22  0     114.4
    // Without the sleeve rebalance the last day would be 114.8 (a stays 0.48).
    const res = await backtest({
      positions: [
        { assetId: 'A', weight: 40 },
        { assetId: 'B', weight: 40 },
        { assetId: 'L', weight: 20 },
      ],
      assets: [
        {
          assetId: 'A',
          symbol: 'A',
          currency: 'EUR',
          prices: [
            { date: '2026-01-30', close: 100 },
            { date: '2026-02-02', close: 120 },
            { date: '2026-02-03', close: 120 },
            { date: '2026-02-04', close: 132 },
          ],
        },
        {
          assetId: 'B',
          symbol: 'B',
          currency: 'EUR',
          prices: [
            { date: '2026-01-30', close: 100 },
            { date: '2026-02-02', close: 100 },
            { date: '2026-02-03', close: 100 },
            { date: '2026-02-04', close: 100 },
          ],
        },
        {
          assetId: 'L',
          symbol: 'L',
          currency: 'EUR',
          prices: [
            { date: '2026-02-03', close: 50 },
            { date: '2026-02-04', close: 55 },
          ],
        },
      ],
      range: { start: '2026-01-30', end: '2026-02-04' },
      converter: stubConverter(),
      mode: 'cash',
      rebalance: 'monthly',
    });
    expect(res.rebalanceEvents).toEqual([{ date: '2026-02-02' }]);
    expect(res.entryEvents).toEqual([{ assetId: 'L', symbol: 'L', date: '2026-02-03' }]);
    [100, 108, 108, 114.4].forEach((v, i) => expect(res.series[i]?.value).toBeCloseTo(v, 10));
    // The pool was exactly L's 20 % on the first two days, 0 after entry.
    expect(res.idleCashAvgPct).toBeCloseTo(((0.2 + 0.2 / 1.08) / 4) * 100, 10);
    const summed = res.contributions.reduce((s, c) => s + c.contributionPct, 0);
    expect(summed).toBeCloseTo(res.stats.totalReturnPct, 9);
  });

  it('redistribute mode + schedule: an entry day on a period boundary is idempotent (both rebalance to the same effective targets)', async () => {
    // A 50 / L 50; L lists exactly on the Feb boundary. The entry-day rebalance
    // and the scheduled rebalance coincide — same targets, one combined effect,
    // one marker of each kind.
    //   day          closes         a               l     index
    //   2026-01-30   A 100          1.0 (absorbs L) —     100
    //   2026-02-02   A 110 L 40     1.1 → entry+boundary rebalance to 50/50:
    //                               a 0.55, l 0.55        110
    //   2026-02-03   A 110 L 48     0.55            0.66  121
    const res = await backtest({
      positions: [
        { assetId: 'A', weight: 50 },
        { assetId: 'L', weight: 50 },
      ],
      assets: [
        {
          assetId: 'A',
          symbol: 'A',
          currency: 'EUR',
          prices: [
            { date: '2026-01-30', close: 100 },
            { date: '2026-02-02', close: 110 },
            { date: '2026-02-03', close: 110 },
          ],
        },
        {
          assetId: 'L',
          symbol: 'L',
          currency: 'EUR',
          prices: [
            { date: '2026-02-02', close: 40 },
            { date: '2026-02-03', close: 48 },
          ],
        },
      ],
      range: { start: '2026-01-30', end: '2026-02-03' },
      converter: stubConverter(),
      mode: 'redistribute',
      rebalance: 'monthly',
    });
    expect(res.entryEvents).toEqual([{ assetId: 'L', symbol: 'L', date: '2026-02-02' }]);
    expect(res.rebalanceEvents).toEqual([{ date: '2026-02-02' }]);
    [100, 110, 121].forEach((v, i) => expect(res.series[i]?.value).toBeCloseTo(v, 10));
    // Attribution across the coinciding events: A carried everything to the
    // boundary (+10 %), then each half moves on its own; L adds 20 % on 0.55.
    const a = res.contributions.find((c) => c.assetId === 'A');
    const l = res.contributions.find((c) => c.assetId === 'L');
    expect(a?.contributionPct).toBeCloseTo(10, 9);
    expect(l?.contributionPct).toBeCloseTo(11, 9);
    const summed = res.contributions.reduce((s, c) => s + c.contributionPct, 0);
    expect(summed).toBeCloseTo(res.stats.totalReturnPct, 9);
  });

  it('the benchmark overlay is untouched by the schedule (single asset — rebalancing is the identity)', async () => {
    const benchmark: BacktestAsset = {
      assetId: 'GSPC',
      symbol: '^GSPC',
      currency: 'EUR',
      prices: [
        { date: '2025-12-30', close: 1000 },
        { date: '2025-12-31', close: 1010 },
        { date: '2026-01-02', close: 1020 },
      ],
    };
    const base: BacktestInput = {
      positions: [{ assetId: 'A', weight: 100 }],
      assets: [
        {
          assetId: 'A',
          symbol: 'A',
          currency: 'EUR',
          prices: [
            { date: '2025-12-30', close: 100 },
            { date: '2025-12-31', close: 110 },
            { date: '2026-01-02', close: 120 },
          ],
        },
      ],
      range: { start: '2025-12-30', end: '2026-01-02' },
      converter: stubConverter(),
      benchmark,
    };

    const scheduled = await backtest({ ...base, rebalance: 'yearly' });
    const hold = await backtest(base);
    expect(scheduled.rebalanceEvents).toEqual([{ date: '2026-01-02' }]);
    expect(scheduled.benchmark).toEqual(hold.benchmark);
  });
});
