import { describe, expect, it } from 'vitest';

import { timeWeightedReturn, type FlowPoint, type ValuePoint } from '../holdings';
import {
  computeSeriesStats,
  computeTwrStats,
  modifiedDietz,
  modifiedDietzReturn,
  type DietzAnchor,
} from '../seriesStats';

/**
 * Money-weighted (Modified Dietz) return vectors (#1669, §16 2026-09-14).
 * Every expectation below is hand-computed and the arithmetic is written out
 * next to it — no generator-driven expectations. The TWR of the same fixture
 * comes from `timeWeightedReturn`/`computeTwrStats`, i.e. the very functions
 * the served `performance` curve is built from, so each vector pins the two
 * headline figures of one window against each other.
 */

// --- Helpers ---------------------------------------------------------------

const DAY = 86_400_000;

/** A frozen value point — mutation by the implementation would throw. */
function v(date: string, valueEur: number): ValuePoint {
  return Object.freeze({ date, valueEur });
}

/** A frozen flow point. */
function f(date: string, flowEur: number): FlowPoint {
  return Object.freeze({ date, flowEur });
}

/** The window's TWR, percent, as the served curve states it for that anchor. */
function twrPct(values: readonly ValuePoint[], flows: readonly FlowPoint[], anchor: DietzAnchor) {
  const curve = timeWeightedReturn(values, flows);
  if (anchor === 'inception') return curve[curve.length - 1]!.pct; // since-inception, not re-based
  return computeTwrStats(curve)!.totalReturnPct; // re-based onto the window's first point
}

// ---------------------------------------------------------------------------
// modifiedDietz — the instant-based core
// ---------------------------------------------------------------------------

describe('modifiedDietz — core formula on hand-computed windows', () => {
  it('weights a mid-window inflow by the fraction of the window remaining', () => {
    // Window 0 → 10 days; start 1 000, +500 at day 4 (weight 6/10), end 1 650.
    //   numerator   = 1 650 − 1 000 − 500        = 150
    //   denominator = 1 000 + 0.6 · 500          = 1 300
    //   MD          = 150 / 1 300                = 11.538461538…%
    const md = modifiedDietz({
      startMs: 0,
      endMs: 10 * DAY,
      startValue: 1000,
      endValue: 1650,
      flows: [{ atMs: 4 * DAY, amount: 500 }],
    });
    expect(md ?? Number.NaN).toBeCloseTo((150 / 1300) * 100, 12);
  });

  it('a flow at the window start weighs 1, a flow at the window end weighs 0', () => {
    // Start 1 000; +200 at t=0 (fully invested), −300 at t=end (never at work).
    //   numerator   = 1 300 − 1 000 − (200 − 300) = 400
    //   denominator = 1 000 + 1·200 + 0·(−300)    = 1 200
    //   MD          = 400 / 1 200                 = 33.333…%
    const md = modifiedDietz({
      startMs: 100,
      endMs: 100 + 5 * DAY,
      startValue: 1000,
      endValue: 1300,
      flows: [
        { atMs: 100, amount: 200 },
        { atMs: 100 + 5 * DAY, amount: -300 },
      ],
    });
    expect(md ?? Number.NaN).toBeCloseTo((400 / 1200) * 100, 12);
  });

  it('ignores flows before the start (inside the start value) and after the end (not yet happened)', () => {
    const inside = modifiedDietz({
      startMs: 10,
      endMs: 20,
      startValue: 100,
      endValue: 110,
      flows: [
        { atMs: 9, amount: 1_000_000 },
        { atMs: 21, amount: -1_000_000 },
      ],
    });
    // (110 − 100) / 100 = 10 %
    expect(inside ?? Number.NaN).toBeCloseTo(10, 12);
  });

  it('a zero-length window weighs its own instant flow as the capital (no 0/0)', () => {
    // start = end = t; +100 at t; value 100 → 100: (100 − 100 − 100) / (100 + 100) = −50 %.
    // Degenerate by construction, but total: a number, never NaN.
    const md = modifiedDietz({
      startMs: 7,
      endMs: 7,
      startValue: 100,
      endValue: 100,
      flows: [{ atMs: 7, amount: 100 }],
    });
    expect(md ?? Number.NaN).toBeCloseTo(-50, 12);
  });

  it.each<[string, Parameters<typeof modifiedDietz>[0]]>([
    ['no capital at all', { startMs: 0, endMs: DAY, startValue: 0, endValue: 0, flows: [] }],
    [
      'withdrawal outweighs the start value (denominator −50)',
      // 100 + 0.5 · (−300) = −50 ≤ 0 → no figure (never a sign flip).
      {
        startMs: 0,
        endMs: 2 * DAY,
        startValue: 100,
        endValue: 100,
        flows: [{ atMs: DAY, amount: -300 }],
      },
    ],
    [
      'float dust below EPSILON is no capital either',
      { startMs: 0, endMs: DAY, startValue: 1e-12, endValue: 5, flows: [] },
    ],
  ])('null when the window has no capital: %s', (_label, window) => {
    expect(modifiedDietz(window)).toBeNull();
  });

  it.each<[string, Parameters<typeof modifiedDietz>[0]]>([
    ['NaN start value', { startMs: 0, endMs: 1, startValue: Number.NaN, endValue: 1, flows: [] }],
    [
      'infinite flow',
      { startMs: 0, endMs: 1, startValue: 1, endValue: 1, flows: [{ atMs: 0, amount: Infinity }] },
    ],
    ['window runs backwards', { startMs: 5, endMs: 4, startValue: 1, endValue: 1, flows: [] }],
  ])('fails loud on the money path: %s', (_label, window) => {
    expect(() => modifiedDietz(window)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// modifiedDietzReturn — daily series + the TWR's own flow convention
// ---------------------------------------------------------------------------

describe('modifiedDietzReturn — (i) the reported shape: TWR deep red, Dietz clearly positive', () => {
  // 100 € opens the position, loses two thirds, sits there, then 100 000 €
  // arrives and the whole portfolio gains 50 % — the MAX-range shape the
  // mobile dev reported (#1669): a rising value curve under a negative TWR.
  const values = [
    v('2025-01-01', 100), //           buy 100 → close 100
    v('2025-01-02', 34), //            −66 %
    v('2025-01-11', 100_034), //       +100 000 deposit, flat market
    v('2025-01-21', 150_051), //       +50 % on everything
  ];
  const flows = [f('2025-01-01', 100), f('2025-01-11', 100_000)];

  it('the since-inception TWR chains 1 · 0.34 · 1 · 1.5 = 0.51 → −49 %', () => {
    // r₁ = 100/100 = 1; r₂ = 34/100 = 0.34; r₃ = 100 034/(34 + 100 000) = 1;
    // r₄ = 150 051/100 034 = 1.5 → index 0.51 → −49 %.
    expect(twrPct(values, flows, 'inception')).toBeCloseTo(-49, 9);
  });

  it('the money-weighted MAX figure is +95.18 %', () => {
    // Inception anchor: window opens the day before 2025-01-01 (2024-12-31),
    // T = 21 days, start capital 0.
    //   +100 on day 1 is an inflow at the previous close (2024-12-31) → w = 21/21 = 1
    //   +100 000 on 2025-01-11 → at the 2025-01-10 close → w = (21 − 10)/21 = 11/21
    //   numerator   = 150 051 − 0 − 100 100          = 49 951
    //   denominator = 0 + 100·1 + 100 000·11/21      = 52 480.952380…
    //   MD          = 49 951 / 52 480.952…            = 95.1793…%
    const md = modifiedDietzReturn(values, flows, { anchor: 'inception' });
    expect(md ?? Number.NaN).toBeCloseTo((49_951 / (100 + (100_000 * 11) / 21)) * 100, 9);
    expect(md ?? Number.NaN).toBeCloseTo(95.1793, 3);
    expect(md ?? Number.NaN).toBeGreaterThan(0);
  });
});

describe('modifiedDietzReturn — (ii) no flows: Dietz == total return == TWR', () => {
  const values = [
    v('2024-03-01', 100),
    v('2024-03-02', 110),
    v('2024-03-03', 99),
    v('2024-03-04', 120.45),
  ];

  it.each<DietzAnchor>(['first-point', 'inception'])(
    'anchor %s: (120.45 − 100) / 100 = 20.45 %',
    (anchor) => {
      const md = modifiedDietzReturn(values, [], { anchor });
      expect(md ?? Number.NaN).toBeCloseTo(20.45, 9);
      expect(md ?? Number.NaN).toBeCloseTo(
        computeSeriesStats(values.map((p) => ({ date: p.date, value: p.valueEur }))).totalReturnPct,
        9,
      );
      // With nothing flowing, the TWR chain is V_n/V_0 under both anchors too
      // (day one links flat when no money came in), so all three agree.
      expect(md ?? Number.NaN).toBeCloseTo(twrPct(values, [], anchor), 9);
    },
  );

  it('MAX with only the inception buy: bought intraday at 100, closed 104, now 150 → both +50 %', () => {
    // The #125 acceptance shape: day one's execution→close move is return on
    // MAX. TWR: r₁ = 104/100, r₂ = 150/104 → 1.5. Dietz (inception anchor):
    // start 0, +100 at weight 1: (150 − 0 − 100) / (0 + 100) = 50 %.
    const values = [v('2024-05-01', 104), v('2024-05-02', 150)];
    const flows = [f('2024-05-01', 100)];
    expect(twrPct(values, flows, 'inception')).toBeCloseTo(50, 9);
    expect(modifiedDietzReturn(values, flows, { anchor: 'inception' }) ?? Number.NaN).toBeCloseTo(
      50,
      9,
    );
    // The same window as a re-based slice starts at the 104 close and reads
    // 150/104 − 1 = 44.2307…% on both (the first day's flow is inside 104).
    expect(twrPct(values, flows, 'first-point')).toBeCloseTo((150 / 104 - 1) * 100, 9);
    expect(modifiedDietzReturn(values, flows, { anchor: 'first-point' }) ?? Number.NaN).toBeCloseTo(
      (150 / 104 - 1) * 100,
      9,
    );
  });
});

describe('modifiedDietzReturn — (iii) a withdrawal-only window', () => {
  it('1 000 → +100 on the day 400 leaves → 700: (700 − 1 000 + 400) / (1 000 − 0.5·400) = 12.5 %', () => {
    // 5 daily points, window T = 4 days (first-point anchor). The −400 on
    // 2024-01-03 is an outflow at that day's close → w = (4 − 2)/4 = 0.5.
    //   numerator   = 700 − 1 000 + 400 = 100
    //   denominator = 1 000 − 200       = 800
    const values = [
      v('2024-01-01', 1000),
      v('2024-01-02', 1000),
      v('2024-01-03', 700),
      v('2024-01-04', 700),
      v('2024-01-05', 700),
    ];
    const flows = [f('2024-01-03', -400)];
    expect(modifiedDietzReturn(values, flows, { anchor: 'first-point' }) ?? Number.NaN).toBeCloseTo(
      12.5,
      9,
    );
    // The TWR books the day as (700 + 400) / 1 000 = +10 % — same direction,
    // a different question (the 100 € was earned on 1 000 for one day, then
    // only 700 stayed invested — which the money-weighted figure credits).
    expect(twrPct(values, flows, 'first-point')).toBeCloseTo(10, 9);
  });
});

describe('modifiedDietzReturn — (iv) no capital → null', () => {
  it('a withdrawal larger than the start value (400 earned, 300 taken, denominator −50)', () => {
    // Start 100; day 2: worth 400, 300 withdrawn at the close → 100; day 3: 100.
    // T = 2 days; −300 at the 2024-02-02 close → w = (2 − 1)/2 = 0.5.
    //   denominator = 100 + 0.5 · (−300) = −50 ≤ 0 → null (the TWR still reads
    //   (100 + 300)/100 = 4× on day 2 → +300 %; the Dietz honestly declines).
    const values = [v('2024-02-01', 100), v('2024-02-02', 100), v('2024-02-03', 100)];
    const flows = [f('2024-02-02', -300)];
    expect(modifiedDietzReturn(values, flows, { anchor: 'first-point' })).toBeNull();
    expect(twrPct(values, flows, 'first-point')).toBeCloseTo(300, 9);
  });

  it('a zero start value with nothing flowing in', () => {
    expect(
      modifiedDietzReturn([v('2024-02-01', 0), v('2024-02-02', 0)], [], { anchor: 'first-point' }),
    ).toBeNull();
  });

  it('a zero start value that money later fills is fine: 0 → +100 → 110 = 10 %', () => {
    // First-point anchor, start 0; +100 on day 2 is an inflow at the day-1
    // close = the window start → w = 1. (110 − 0 − 100) / (0 + 100) = 10 %.
    const values = [v('2024-02-01', 0), v('2024-02-02', 100), v('2024-02-03', 110)];
    const flows = [f('2024-02-02', 100)];
    expect(modifiedDietzReturn(values, flows, { anchor: 'first-point' }) ?? Number.NaN).toBeCloseTo(
      10,
      9,
    );
  });

  it('an empty series has no window at all', () => {
    expect(modifiedDietzReturn([], [], { anchor: 'inception' })).toBeNull();
  });
});

describe('modifiedDietzReturn — single-period parity with the TWR daily link', () => {
  // Over ONE day the Dietz equals r_d − 1 exactly, for either sign: the two
  // headlines share one definition of when the money arrived.
  it('inflow: 1 000, +500 arrives, closes 1 650 → both +10 %', () => {
    // r = 1 650 / (1 000 + 500) = 1.1. Dietz: +500 at the previous close (w = 1):
    // (1 650 − 1 000 − 500) / (1 000 + 500) = 150 / 1 500 = 10 %.
    const values = [v('2024-04-01', 1000), v('2024-04-02', 1650)];
    const flows = [f('2024-04-02', 500)];
    expect(twrPct(values, flows, 'first-point')).toBeCloseTo(10, 9);
    expect(modifiedDietzReturn(values, flows, { anchor: 'first-point' }) ?? Number.NaN).toBeCloseTo(
      10,
      9,
    );
  });

  it('outflow: 1 000, gains 100, 500 leaves at the close → both +10 %', () => {
    // r = (600 + 500) / 1 000 = 1.1. Dietz: −500 at the window end (w = 0):
    // (600 − 1 000 + 500) / (1 000 + 0) = 100 / 1 000 = 10 %.
    const values = [v('2024-04-01', 1000), v('2024-04-02', 600)];
    const flows = [f('2024-04-02', -500)];
    expect(twrPct(values, flows, 'first-point')).toBeCloseTo(10, 9);
    expect(modifiedDietzReturn(values, flows, { anchor: 'first-point' }) ?? Number.NaN).toBeCloseTo(
      10,
      9,
    );
  });

  it('same-day flows net first (+300 and −100 = one +200 inflow at the day start)', () => {
    // 1 000 → 1 320 with net +200 at w = 1: (1 320 − 1 000 − 200) / 1 200 = 10 %.
    const values = [v('2024-04-01', 1000), v('2024-04-02', 1320)];
    const flows = [f('2024-04-02', 300), f('2024-04-02', -100)];
    expect(modifiedDietzReturn(values, flows, { anchor: 'first-point' }) ?? Number.NaN).toBeCloseTo(
      10,
      9,
    );
    expect(twrPct(values, flows, 'first-point')).toBeCloseTo(10, 9);
  });
});

describe('modifiedDietzReturn — flows on the first / last day and the window edges', () => {
  it('a first-day flow is inside the start value on a slice (identical to no flow)', () => {
    const values = [v('2024-06-01', 1000), v('2024-06-02', 1100), v('2024-06-03', 1210)];
    const withFlow = modifiedDietzReturn(values, [f('2024-06-01', 1000)], {
      anchor: 'first-point',
    });
    const without = modifiedDietzReturn(values, [], { anchor: 'first-point' });
    // (1 210 − 1 000) / 1 000 = 21 % either way.
    expect(withFlow ?? Number.NaN).toBeCloseTo(21, 9);
    expect(without ?? Number.NaN).toBeCloseTo(21, 9);
  });

  it('a last-day inflow is at work for one day of the window (weight 1/T)', () => {
    // T = 2 days. +500 on 2024-06-03 is an inflow at the 06-02 close → w = 1/2.
    // Flat market: (1 500 − 1 000 − 500) / (1 000 + 250) = 0 / 1 250 = 0 %.
    const values = [v('2024-06-01', 1000), v('2024-06-02', 1000), v('2024-06-03', 1500)];
    expect(
      modifiedDietzReturn(values, [f('2024-06-03', 500)], { anchor: 'first-point' }) ?? Number.NaN,
    ).toBeCloseTo(0, 9);
  });

  it('a last-day outflow leaves at the window end (weight 0)', () => {
    // Flat market: (500 − 1 000 + 500) / (1 000 + 0) = 0 %.
    const values = [v('2024-06-01', 1000), v('2024-06-02', 1000), v('2024-06-03', 500)];
    expect(
      modifiedDietzReturn(values, [f('2024-06-03', -500)], { anchor: 'first-point' }) ?? Number.NaN,
    ).toBeCloseTo(0, 9);
  });

  it('flows dated before the window or after its last point are ignored (as the TWR ignores them)', () => {
    const values = [v('2024-06-02', 1000), v('2024-06-03', 1100)];
    const flows = [f('2024-05-30', 999_999), f('2024-06-04', -999_999)];
    expect(modifiedDietzReturn(values, flows, { anchor: 'first-point' }) ?? Number.NaN).toBeCloseTo(
      10,
      9,
    );
    // Inception: the first day brings nothing in → degrades to the first-point
    // window (see below), same 10 %.
    expect(modifiedDietzReturn(values, flows, { anchor: 'inception' }) ?? Number.NaN).toBeCloseTo(
      10,
      9,
    );
  });

  it('a flow on an in-window day without a value point still counts (sparse series)', () => {
    // Points on 06-01 (1 000) and 06-05 (1 650); +500 on 06-03, no point that
    // day. T = 4 days; the inflow is at the 06-02 close → w = 3/4.
    //   (1 650 − 1 000 − 500) / (1 000 + 375) = 150 / 1 375 = 10.909…%
    const values = [v('2024-06-01', 1000), v('2024-06-05', 1650)];
    expect(
      modifiedDietzReturn(values, [f('2024-06-03', 500)], { anchor: 'first-point' }) ?? Number.NaN,
    ).toBeCloseTo((150 / 1375) * 100, 9);
  });
});

describe('modifiedDietzReturn — the inception anchor', () => {
  it('a single MAX day: bought at 100, closed at 104 → +4 % (= the TWR day-one link)', () => {
    // T = 1 day; +100 at w = 1: (104 − 0 − 100) / 100 = 4 %.
    const values = [v('2024-07-01', 104)];
    const flows = [f('2024-07-01', 100)];
    expect(modifiedDietzReturn(values, flows, { anchor: 'inception' }) ?? Number.NaN).toBeCloseTo(
      4,
      9,
    );
    expect(twrPct(values, flows, 'inception')).toBeCloseTo(4, 9);
  });

  it('a single-day slice has no elapsed time and no counted flow → 0 % on a positive value', () => {
    expect(
      modifiedDietzReturn([v('2024-07-01', 104)], [f('2024-07-01', 100)], {
        anchor: 'first-point',
      }),
    ).toBe(0);
    expect(modifiedDietzReturn([v('2024-07-01', 0)], [], { anchor: 'first-point' })).toBeNull();
  });

  it('a first-day outflow under inception leaves at that close (weight n/(n+1))', () => {
    // Day 1: +1 000 in, 200 out the same day, close 900 (+100 earned); day 2: 990.
    // Net day-1 flow +800 > 0 → inception anchor holds. T = 2 days.
    // The NET +800 is an inflow at the previous close → w = 1.
    //   (990 − 0 − 800) / (0 + 800) = 190 / 800 = 23.75 %
    // TWR: r₁ = 900/800 = 1.125, r₂ = 990/900 = 1.1 → 1.2375 → 23.75 %. Equal:
    // the day-one link IS a single period, and day two carries no flow.
    const values = [v('2024-07-01', 900), v('2024-07-02', 990)];
    const flows = [f('2024-07-01', 1000), f('2024-07-01', -200)];
    expect(modifiedDietzReturn(values, flows, { anchor: 'inception' }) ?? Number.NaN).toBeCloseTo(
      23.75,
      9,
    );
    expect(twrPct(values, flows, 'inception')).toBeCloseTo(23.75, 9);
  });

  it('degrades to the first-point window when day one brings nothing in (FX-truncated history)', () => {
    // A series that starts mid-life (no flow on its first day): the TWR links
    // day one flat and chains from 5 000; the Dietz must not count the 5 000
    // as gain. (5 500 − 5 000) / 5 000 = 10 % on both.
    const values = [v('2024-08-01', 5000), v('2024-08-02', 5500)];
    expect(modifiedDietzReturn(values, [], { anchor: 'inception' }) ?? Number.NaN).toBeCloseTo(
      10,
      9,
    );
    expect(twrPct(values, [], 'inception')).toBeCloseTo(10, 9);
  });

  it('a pre-price buy (#218): money in before the first value point is the basis', () => {
    // Custom asset bought for 1 000 on day 1 with no value yet (0), first
    // value 1 100 on day 3. Inception window T = 3 days, +1 000 at w = 1:
    //   (1 100 − 0 − 1 000) / 1 000 = 10 %. The TWR (#218) reads the same +10 %.
    const values = [v('2024-08-01', 0), v('2024-08-02', 0), v('2024-08-03', 1100)];
    const flows = [f('2024-08-01', 1000)];
    expect(modifiedDietzReturn(values, flows, { anchor: 'inception' }) ?? Number.NaN).toBeCloseTo(
      10,
      9,
    );
    expect(twrPct(values, flows, 'inception')).toBeCloseTo(10, 9);
  });
});

describe('modifiedDietzReturn — input discipline', () => {
  it('sorts on a copy and mutates nothing', () => {
    const values = Object.freeze([
      v('2024-09-03', 1210),
      v('2024-09-01', 1000),
      v('2024-09-02', 1100),
    ]);
    const flows = Object.freeze([f('2024-09-02', 0)]);
    expect(modifiedDietzReturn(values, flows, { anchor: 'first-point' }) ?? Number.NaN).toBeCloseTo(
      21,
      9,
    );
    expect(values.map((p) => p.date)).toEqual(['2024-09-03', '2024-09-01', '2024-09-02']);
  });

  it.each<[string, () => unknown]>([
    [
      'non-finite value',
      () => modifiedDietzReturn([v('2024-09-01', Number.NaN)], [], { anchor: 'first-point' }),
    ],
    [
      'non-finite flow',
      () =>
        modifiedDietzReturn([v('2024-09-01', 1)], [f('2024-09-01', Infinity)], {
          anchor: 'inception',
        }),
    ],
    [
      'malformed value date',
      () => modifiedDietzReturn([v('2024/09/01', 1)], [], { anchor: 'first-point' }),
    ],
    [
      'malformed flow date',
      () => modifiedDietzReturn([v('2024-09-01', 1)], [f('yesterday', 1)], { anchor: 'inception' }),
    ],
  ])('throws on %s', (_label, run) => {
    expect(run).toThrow();
  });
});
