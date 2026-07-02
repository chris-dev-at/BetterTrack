import { describe, expect, it, vi } from 'vitest';

import {
  backtest,
  BacktestError,
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
