import { describe, expect, it } from 'vitest';

import {
  allocateBudget,
  AllocationError,
  DEFAULT_FRACTIONAL_STEP,
  WEIGHT_SUM_TOLERANCE,
  type AllocationInput,
  type AllocationLine,
  type AllocationPositionInput,
} from '../allocation';

// --- Helpers ---------------------------------------------------------------

/** A position where the assetId doubles as the symbol. */
function pos(assetId: string, weight: number, priceEur: number): AllocationPositionInput {
  return { assetId, symbol: assetId, weight, priceEur };
}

function line(result: ReturnType<typeof allocateBudget>, assetId: string): AllocationLine {
  const found = result.positions.find((p) => p.assetId === assetId);
  if (found === undefined) throw new Error(`no line for ${assetId}`);
  return found;
}

/** The §6.7 worked example: B = 1000 €, BAYN 30 % @ 25 €, NVDA 60 % @ 150 €, GOOGL 10 % @ 140 €. */
function workedExample(mode: 'whole' | 'fractional'): AllocationInput {
  return {
    budgetEur: 1000,
    mode,
    positions: [
      { assetId: 'bayn', symbol: 'BAYN.DE', weight: 0.3, priceEur: 25 },
      { assetId: 'nvda', symbol: 'NVDA', weight: 0.6, priceEur: 150 },
      { assetId: 'googl', symbol: 'GOOGL', weight: 0.1, priceEur: 140 },
    ],
  };
}

// ---------------------------------------------------------------------------
// §6.7 worked example (whole shares)
// ---------------------------------------------------------------------------

describe('allocateBudget — §6.7 worked example (whole shares)', () => {
  it('reproduces the worked example exactly: 12/4/0 shares, 900 € spent, 100 € left', () => {
    const res = allocateBudget(workedExample('whole'));

    expect(line(res, 'bayn').qty).toBe(12);
    expect(line(res, 'bayn').costEur).toBe(300);
    expect(line(res, 'nvda').qty).toBe(4);
    expect(line(res, 'nvda').costEur).toBe(600);
    expect(line(res, 'googl').qty).toBe(0);
    expect(line(res, 'googl').costEur).toBe(0);

    expect(res.totalCostEur).toBe(900);
    expect(res.leftoverEur).toBe(100);
  });

  it('flags GOOGL unreachable with its price, its slice, and a ≈1400 € suggested min budget', () => {
    const res = allocateBudget(workedExample('whole'));
    const googl = line(res, 'googl');

    expect(googl.note).toBe(
      'GOOGL share price (140 €) exceeds its 100 € slice; raise the budget to ≥ ~1400 € or use fractional mode.',
    );
    // Unreachable, but not unbuyable — 140 € is within the 1000 € budget.
    expect(googl.unbuyable).toBeUndefined();
    expect(res.warnings).toEqual([googl.note]);
  });

  it('reports actual % vs target % and Δpp per position', () => {
    const res = allocateBudget(workedExample('whole'));

    expect(line(res, 'bayn').actualPct).toBeCloseTo(30, 9);
    expect(line(res, 'bayn').targetPct).toBeCloseTo(30, 9);
    expect(line(res, 'bayn').deltaPp).toBeCloseTo(0, 9);
    expect(line(res, 'googl').actualPct).toBe(0);
    expect(line(res, 'googl').targetPct).toBeCloseTo(10, 9);
    expect(line(res, 'googl').deltaPp).toBeCloseTo(-10, 9);
  });
});

// ---------------------------------------------------------------------------
// Whole-share greedy fill (§6.7 step 4)
// ---------------------------------------------------------------------------

describe('allocateBudget — whole-share greedy fill', () => {
  it('buys the share that most reduces Σ|actual − target|, not the largest weight', () => {
    // After floors (B = 1000): a (w .5 @ 180) 2×180 = 360, deficit 140 ⇒ reduction 100;
    // b (w .3 @ 160) 1×160 = 160, deficit 140 ⇒ reduction 120; c (w .2 @ 190) 1×190, deficit 10.
    // Leftover 290 affords any of them; greedy must pick b (reduction 120) over
    // the naive largest-weight pick a (reduction 100).
    const res = allocateBudget({
      budgetEur: 1000,
      mode: 'whole',
      positions: [pos('a', 0.5, 180), pos('b', 0.3, 160), pos('c', 0.2, 190)],
    });

    expect(line(res, 'a').qty).toBe(2); // NOT 3 — naive weight-first would buy a
    expect(line(res, 'b').qty).toBe(2);
    expect(line(res, 'c').qty).toBe(1);
    expect(res.totalCostEur).toBe(870);
    expect(res.leftoverEur).toBe(130);
  });

  it('breaks reduction ties by larger target weight, regardless of input order', () => {
    // a and b have identical prices and identical post-floor deficits (100 each,
    // reduction 80 each); b is listed first, but a has the larger weight and must win.
    const res = allocateBudget({
      budgetEur: 1000,
      mode: 'whole',
      positions: [pos('b', 0.34, 120), pos('a', 0.46, 120), pos('c', 0.2, 50)],
    });

    expect(line(res, 'a').qty).toBe(4); // 3 from the floor + the tie-broken fill
    expect(line(res, 'b').qty).toBe(2);
    expect(line(res, 'c').qty).toBe(4);
    expect(res.totalCostEur).toBe(920);
    expect(res.leftoverEur).toBe(80);
  });

  it('keeps filling in descending-reduction order while purchases reduce the deviation', () => {
    // Floors (B = 1000): a 7×38 = 266 (deficit 34, reduction 30), b 6×44 = 264
    // (deficit 36, reduction 28), c 1×340 (deficit 60, reduction < 0). Leftover 130.
    // Greedy buys a (30), then b (28), then stops: every further buy overshoots.
    const res = allocateBudget({
      budgetEur: 1000,
      mode: 'whole',
      positions: [pos('a', 0.3, 38), pos('b', 0.3, 44), pos('c', 0.4, 340)],
    });

    expect(line(res, 'a').qty).toBe(8);
    expect(line(res, 'b').qty).toBe(7);
    expect(line(res, 'c').qty).toBe(1);
    expect(res.totalCostEur).toBe(952);
    expect(res.leftoverEur).toBe(48);
  });

  it('does not buy an affordable share whose purchase fails to strictly reduce the deviation', () => {
    // a sits exactly half a share under target (deficit 100 @ price 200 ⇒ reduction 0):
    // affordable within the 1110 € leftover, but buying would not reduce Σ|actual − target|.
    // This is the worked example's "no fill possible" semantics.
    const res = allocateBudget({
      budgetEur: 2000,
      mode: 'whole',
      positions: [pos('a', 0.15, 200), pos('b', 0.35, 690), pos('c', 0.5, 1900)],
    });

    expect(line(res, 'a').qty).toBe(1);
    expect(line(res, 'b').qty).toBe(1);
    expect(line(res, 'c').qty).toBe(0);
    expect(res.totalCostEur).toBe(890);
    expect(res.leftoverEur).toBe(1110);

    const c = line(res, 'c');
    expect(c.note).toContain('1900 €');
    expect(c.note).toContain('~3800 €');
    expect(c.unbuyable).toBeUndefined(); // 1900 ≤ 2000: unreachable, not unbuyable
  });
});

// ---------------------------------------------------------------------------
// Fractional mode
// ---------------------------------------------------------------------------

describe('allocateBudget — fractional mode', () => {
  it('rounds each qty down to the default 0.0001 step and spends ≈ B minus dust', () => {
    expect(DEFAULT_FRACTIONAL_STEP).toBe(0.0001);
    const res = allocateBudget(workedExample('fractional'));

    expect(line(res, 'bayn').qty).toBeCloseTo(12, 8);
    expect(line(res, 'nvda').qty).toBeCloseTo(4, 8);
    // 100 / 140 = 0.7142857… ⇒ floored to the 0.0001 step, not e.g. 0.71
    expect(line(res, 'googl').qty).toBeCloseTo(0.7142, 8);
    expect(line(res, 'googl').costEur).toBeCloseTo(99.988, 6);

    expect(res.totalCostEur).toBeCloseTo(999.988, 6);
    expect(res.totalCostEur).toBeLessThanOrEqual(1000);
    expect(res.leftoverEur).toBeCloseTo(0.012, 6);
    expect(res.warnings).toEqual([]);
  });

  it('honours a custom step, always rounding down', () => {
    const res = allocateBudget({
      budgetEur: 100,
      mode: 'fractional',
      step: 0.5,
      positions: [pos('x', 1, 30)],
    });

    // 100 / 30 = 3.33… shares ⇒ floored to 3.0 at step 0.5
    expect(line(res, 'x').qty).toBe(3);
    expect(line(res, 'x').costEur).toBe(90);
    expect(res.totalCostEur).toBe(90);
    expect(res.leftoverEur).toBe(10);
  });

  it('flags a slice smaller than one step, with a suggested min budget', () => {
    const res = allocateBudget({
      budgetEur: 100,
      mode: 'fractional',
      step: 1,
      positions: [pos('x', 0.9, 10), pos('y', 0.1, 200)],
    });

    expect(line(res, 'x').qty).toBe(9);
    const y = line(res, 'y');
    expect(y.qty).toBe(0);
    expect(y.unbuyable).toBe(true); // one 1-share step costs 200 € > the whole 100 € budget
    expect(y.note).toContain('200 €');
    expect(y.note).toContain('~2000 €');
    expect(res.totalCostEur).toBe(90);
    expect(res.leftoverEur).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Unbuyable positions & budget edges
// ---------------------------------------------------------------------------

describe('allocateBudget — unbuyable positions and budget edges', () => {
  it('flags a single price above the whole budget as unbuyable with qty 0', () => {
    const res = allocateBudget({
      budgetEur: 100,
      mode: 'whole',
      positions: [pos('x', 1, 250)],
    });

    const x = line(res, 'x');
    expect(x.qty).toBe(0);
    expect(x.unbuyable).toBe(true);
    expect(x.note).toContain('250 €');
    expect(res.totalCostEur).toBe(0);
    expect(res.leftoverEur).toBe(100);
  });

  it('a budget too small for any share leaves everything at 0 with leftover = budget', () => {
    const res = allocateBudget({
      budgetEur: 20,
      mode: 'whole',
      positions: [pos('a', 0.5, 100), pos('b', 0.5, 300)],
    });

    for (const l of res.positions) {
      expect(l.qty).toBe(0);
      expect(l.costEur).toBe(0);
      expect(l.unbuyable).toBe(true);
      expect(l.note).toBeTruthy();
    }
    expect(res.totalCostEur).toBe(0);
    expect(res.leftoverEur).toBe(20);
    expect(res.warnings).toHaveLength(2);
  });

  it('handles a zero budget without crashing: qty 0 everywhere, leftover 0, actualPct 0', () => {
    const res = allocateBudget({
      budgetEur: 0,
      mode: 'whole',
      positions: [pos('x', 1, 10)],
    });

    expect(line(res, 'x').qty).toBe(0);
    expect(line(res, 'x').actualPct).toBe(0);
    expect(res.totalCostEur).toBe(0);
    expect(res.leftoverEur).toBe(0);
  });

  it('spends the budget exactly when it divides cleanly (no epsilon under-buy)', () => {
    const res = allocateBudget({
      budgetEur: 100,
      mode: 'whole',
      positions: [pos('x', 1, 100)],
    });

    expect(line(res, 'x').qty).toBe(1);
    expect(res.totalCostEur).toBe(100);
    expect(res.leftoverEur).toBe(0);
  });

  it('a zero-weight position stays at qty 0 with no unreachable note', () => {
    const res = allocateBudget({
      budgetEur: 200,
      mode: 'whole',
      positions: [pos('x', 1, 50), pos('z', 0, 80)],
    });

    expect(line(res, 'x').qty).toBe(4);
    const z = line(res, 'z');
    expect(z.qty).toBe(0);
    expect(z.note).toBeUndefined();
    expect(z.targetPct).toBe(0);
    expect(z.deltaPp).toBe(0);
    expect(res.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Output consistency
// ---------------------------------------------------------------------------

describe('allocateBudget — output consistency', () => {
  it('preserves input order and keeps totals, leftover, and percentages consistent', () => {
    const input: AllocationInput = {
      budgetEur: 777.77,
      mode: 'whole',
      positions: [pos('c', 0.2, 190), pos('a', 0.5, 181), pos('b', 0.3, 161)],
    };
    const res = allocateBudget(input);

    expect(res.positions.map((p) => p.assetId)).toEqual(['c', 'a', 'b']);

    let sumCost = 0;
    let sumTargetPct = 0;
    for (const [i, l] of res.positions.entries()) {
      expect(l.costEur).toBe(l.qty * input.positions[i]!.priceEur);
      expect(l.actualPct).toBeCloseTo((l.costEur / input.budgetEur) * 100, 9);
      expect(l.deltaPp).toBeCloseTo(l.actualPct - l.targetPct, 12);
      sumCost += l.costEur;
      sumTargetPct += l.targetPct;
    }
    expect(sumCost).toBe(res.totalCostEur);
    expect(sumTargetPct).toBeCloseTo(100, 9);
    expect(res.totalCostEur + res.leftoverEur).toBeCloseTo(input.budgetEur, 9);
    expect(res.totalCostEur).toBeLessThanOrEqual(input.budgetEur);
  });

  it('normalises weights that sum to slightly less than 1 so targets still span the budget', () => {
    const res = allocateBudget({
      budgetEur: 1000,
      mode: 'fractional',
      positions: [pos('x', 0.5, 10), pos('y', 0.4995, 10)],
    });

    const sumTargetPct = res.positions.reduce((s, l) => s + l.targetPct, 0);
    expect(sumTargetPct).toBeCloseTo(100, 9);
    expect(res.totalCostEur).toBeLessThanOrEqual(1000);
    expect(res.leftoverEur).toBeCloseTo(0, 2); // 10 € shares divide both slices to dust level
  });
});

// ---------------------------------------------------------------------------
// Validation (fail-loud, typed error)
// ---------------------------------------------------------------------------

describe('allocateBudget — validation', () => {
  const valid = () => workedExample('whole');

  const cases: Array<[string, () => AllocationInput, string]> = [
    ['negative budget', () => ({ ...valid(), budgetEur: -1 }), 'budgetEur'],
    ['NaN budget', () => ({ ...valid(), budgetEur: Number.NaN }), 'budgetEur'],
    ['infinite budget', () => ({ ...valid(), budgetEur: Infinity }), 'budgetEur'],
    [
      'unknown mode',
      () => ({ ...valid(), mode: 'both' as AllocationInput['mode'] }),
      "mode must be 'whole' or 'fractional'",
    ],
    ['empty positions', () => ({ ...valid(), positions: [] }), 'at least one position'],
    [
      'zero price',
      () => ({ ...valid(), positions: [pos('x', 1, 0)] }),
      'finite positive number of EUR',
    ],
    [
      'negative price',
      () => ({ ...valid(), positions: [pos('x', 1, -5)] }),
      'finite positive number of EUR',
    ],
    [
      'NaN price',
      () => ({ ...valid(), positions: [pos('x', 1, Number.NaN)] }),
      'finite positive number of EUR',
    ],
    [
      'negative weight',
      () => ({ ...valid(), positions: [pos('x', 1.2, 10), pos('y', -0.2, 10)] }),
      'finite non-negative number',
    ],
    [
      'NaN weight',
      () => ({ ...valid(), positions: [pos('x', Number.NaN, 10)] }),
      'finite non-negative number',
    ],
    [
      'weights summing far below 1',
      () => ({ ...valid(), positions: [pos('x', 0.45, 10), pos('y', 0.45, 10)] }),
      'sum to ~1',
    ],
    [
      'weights summing above 1 + tolerance',
      () => ({ ...valid(), positions: [pos('x', 0.5, 10), pos('y', 0.502, 10)] }),
      'sum to ~1',
    ],
    [
      'duplicate assetId',
      () => ({ ...valid(), positions: [pos('x', 0.5, 10), pos('x', 0.5, 10)] }),
      'Duplicate position assetId',
    ],
    [
      'zero step (fractional)',
      () => ({ ...valid(), mode: 'fractional' as const, step: 0 }),
      'step must be a finite positive number',
    ],
    [
      'negative step (fractional)',
      () => ({ ...valid(), mode: 'fractional' as const, step: -0.01 }),
      'step must be a finite positive number',
    ],
    [
      'NaN step (fractional)',
      () => ({ ...valid(), mode: 'fractional' as const, step: Number.NaN }),
      'step must be a finite positive number',
    ],
  ];

  it.each(cases)('rejects %s with a typed AllocationError', (_name, build, snippet) => {
    expect(() => allocateBudget(build())).toThrowError(AllocationError);
    expect(() => allocateBudget(build())).toThrowError(snippet);
  });

  it('accepts weight sums within the documented tolerance (numeric(6,3) rounding)', () => {
    expect(WEIGHT_SUM_TOLERANCE).toBe(1e-3);
    const third = 0.33333; // 33.333 % at numeric(6,3) precision; ×3 = 0.99999
    const res = allocateBudget({
      budgetEur: 300,
      mode: 'whole',
      positions: [pos('x', third, 10), pos('y', third, 10), pos('z', third, 10)],
    });
    expect(res.totalCostEur).toBeLessThanOrEqual(300);
  });
});

// ---------------------------------------------------------------------------
// Property-style: never overshoot, in both modes, across many random baskets
// ---------------------------------------------------------------------------

describe('allocateBudget — never-overshoot property', () => {
  // Deterministic LCG so failures reproduce (no Math.random in domain tests).
  function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }

  it('holds totalCostEur ≤ budgetEur and internal consistency across 300 random baskets', () => {
    const rnd = lcg(42);
    const steps = [undefined, DEFAULT_FRACTIONAL_STEP, 0.01, 0.5, 1];

    for (let i = 0; i < 300; i += 1) {
      const n = 1 + Math.floor(rnd() * 6);
      const raw = Array.from({ length: n }, () => 0.05 + rnd());
      const rawSum = raw.reduce((a, b) => a + b, 0);
      const positions = raw.map((w, j) => pos(`a${j}`, w / rawSum, 0.5 + rnd() * 400));
      const budgetEur = rnd() * 5000;
      const mode = i % 2 === 0 ? ('whole' as const) : ('fractional' as const);
      const step = mode === 'fractional' ? steps[i % steps.length] : undefined;

      const res = allocateBudget({
        budgetEur,
        mode,
        positions,
        ...(step !== undefined ? { step } : {}),
      });

      // The hard invariant, checked with exact FP comparison — never overshoot.
      expect(res.totalCostEur).toBeLessThanOrEqual(budgetEur);
      expect(res.leftoverEur).toBeGreaterThanOrEqual(0);
      expect(res.totalCostEur + res.leftoverEur).toBeCloseTo(budgetEur, 6);

      let sumCost = 0;
      for (const [j, l] of res.positions.entries()) {
        expect(l.qty).toBeGreaterThanOrEqual(0);
        if (mode === 'whole') {
          expect(Number.isInteger(l.qty)).toBe(true);
        } else {
          const units = l.qty / (step ?? DEFAULT_FRACTIONAL_STEP);
          expect(Math.abs(units - Math.round(units))).toBeLessThan(1e-6);
        }
        expect(l.costEur).toBeCloseTo(l.qty * positions[j]!.priceEur, 8);
        if (l.qty === 0 && positions[j]!.weight > 0) {
          expect(l.note).toBeTruthy();
        }
        sumCost += l.costEur;
      }
      expect(sumCost).toBeCloseTo(res.totalCostEur, 8);
    }
  });
});
