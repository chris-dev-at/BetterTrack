import { describe, expect, it } from 'vitest';

import {
  allocateBudget,
  AllocationError,
  DEFAULT_FRACTIONAL_STEP,
  rescaleUnreachableWeight,
  unreachableWeightNote,
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

/** The "raise the budget to ≥ ~X €" figure an unreachable-weight note promises. */
function suggestedMin(note: string): number {
  const match = /≥ ~([\d.]+) €/.exec(note);
  if (match?.[1] === undefined) throw new Error(`no suggested minimum in note: ${note}`);
  return Number(match[1]);
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
      // 99.995 % — inside §6.5's ±0.01 pp write contract, which the engine now
      // mirrors exactly (#1778); anything looser is refused up front.
      positions: [pos('x', 0.5, 10), pos('y', 0.49995, 10)],
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
    // §6.5: "status `active` requires Σ weights = 100 ± 0.01" ⇒ ±0.0001 as a
    // fraction. Before #1778 the engine allowed 1e-3 — ±0.1 pp, 10× looser than
    // the contract `conglomerateService` enforces on write.
    expect(WEIGHT_SUM_TOLERANCE).toBe(1e-4);
    const third = 0.33333; // 33.333 % at numeric(6,3) precision; ×3 = 0.99999
    const res = allocateBudget({
      budgetEur: 300,
      mode: 'whole',
      positions: [pos('x', third, 10), pos('y', third, 10), pos('z', third, 10)],
    });
    expect(res.totalCostEur).toBeLessThanOrEqual(300);
  });

  it('refuses a basket 0.1 pp off 100 % instead of silently scaling it up (§6.5)', () => {
    // 99.9 % — accepted and normalised up by the pre-#1778 ±0.1 pp tolerance.
    expect(() =>
      allocateBudget({
        budgetEur: 1000,
        mode: 'whole',
        positions: [pos('x', 0.5, 10), pos('y', 0.499, 10)],
      }),
    ).toThrowError(AllocationError);
    expect(() =>
      allocateBudget({
        budgetEur: 1000,
        mode: 'whole',
        positions: [pos('x', 0.5, 10), pos('y', 0.499, 10)],
      }),
    ).toThrowError(/must sum to ~1/);
  });
});

// ---------------------------------------------------------------------------
// At-least-one-share mode (opt-in, §13.2 V2-P7)
// ---------------------------------------------------------------------------

describe('allocateBudget — atLeastOneShare (opt-in force-single mode)', () => {
  /** The owner's €240-share-on-€1000-budget case: a 20 % slice (200 €) cannot afford one 240 € share. */
  const case240 = (atLeastOneShare: boolean): AllocationInput => ({
    budgetEur: 1000,
    mode: 'whole',
    atLeastOneShare,
    positions: [pos('exp', 0.2, 240), pos('cheap', 0.8, 10)],
  });

  it('ON: the €240 position gets exactly 1 share and the remainder rebalances onto the rest', () => {
    const res = allocateBudget(case240(true));

    expect(line(res, 'exp').qty).toBe(1);
    expect(line(res, 'exp').costEur).toBe(240);
    expect(line(res, 'exp').note).toBeUndefined();
    // Remainder 760 € re-targets CHEAP (the whole rest weight): 76 × 10 €.
    expect(line(res, 'cheap').qty).toBe(76);
    expect(res.totalCostEur).toBe(1000);
    expect(res.leftoverEur).toBe(0);
    expect(res.warnings).toEqual([]);
  });

  it('OFF: the €240 position stays at 0 with its unreachable note (unchanged behavior)', () => {
    const res = allocateBudget(case240(false));

    expect(line(res, 'exp').qty).toBe(0);
    expect(line(res, 'exp').note).toBeTruthy();
    expect(line(res, 'cheap').qty).toBe(80);
    expect(res.totalCostEur).toBe(800);
    expect(res.leftoverEur).toBe(200);
  });

  it('flag false and flag absent produce identical results (default OFF)', () => {
    const { atLeastOneShare: _off, ...withoutFlag } = case240(false);
    expect(allocateBudget(case240(false))).toEqual(allocateBudget(withoutFlag));
    expect(allocateBudget({ ...workedExample('whole'), atLeastOneShare: false })).toEqual(
      allocateBudget(workedExample('whole')),
    );
  });

  it('is ignored in fractional mode (out of scope): results match the flag-less run', () => {
    expect(allocateBudget({ ...workedExample('fractional'), atLeastOneShare: true })).toEqual(
      allocateBudget(workedExample('fractional')),
    );
  });

  it('ON: §6.7 worked example — GOOGL costs more deployment than it adds, so it is refused and flagged at a reachable 1040 €', () => {
    // Before #1778 this granted GOOGL its share: BAYN refloored to 11 × 25 €
    // and NVDA to 3 × 150 €, so 140 € bought in cost 175 € of BAYN + NVDA —
    // 865 € invested against the flag-off plan's 900 €, i.e. 35 € pulled back
    // out of the market by turning the flag on. The retreat keeps the flag-off
    // plan and says what budget would actually reach GOOGL.
    const res = allocateBudget({ ...workedExample('whole'), atLeastOneShare: true });
    const off = allocateBudget(workedExample('whole'));

    expect(line(res, 'bayn').qty).toBe(12);
    expect(line(res, 'nvda').qty).toBe(4);
    expect(line(res, 'googl').qty).toBe(0);
    expect(res.totalCostEur).toBe(900);
    expect(res.totalCostEur).toBeGreaterThanOrEqual(off.totalCostEur);
    expect(res.leftoverEur).toBe(100);

    // Flagged with a budget the FORCE path actually reaches — 1040 €, not the
    // flag-off 1400 € — and re-running there does buy the share.
    expect(line(res, 'googl').note).toBe(
      'GOOGL share price (140 €) exceeds its 100 € slice; raise the budget to ≥ ~1040 € or use fractional mode.',
    );
    const raised = allocateBudget({
      ...workedExample('whole'),
      atLeastOneShare: true,
      budgetEur: 1040,
    });
    expect(line(raised, 'googl').qty).toBe(1);
    expect(line(raised, 'bayn').qty).toBe(12);
    expect(line(raised, 'nvda').qty).toBe(4);
    expect(raised.totalCostEur).toBe(1040);
  });

  it('ON: unaffordable candidates are dropped, never forced past the budget (overshoot guard)', () => {
    // Candidates by weight: a (.4 @ 450 €), d (.3 @ 480 €), e (.05 @ 45 €); f floors normally.
    // a fits (450 ≤ 500); d would overshoot (930 > 500) and is dropped; the
    // cheaper, lower-weight e still fits (495 ≤ 500) — drop the least-affordable, never blow B.
    const res = allocateBudget({
      budgetEur: 500,
      mode: 'whole',
      atLeastOneShare: true,
      positions: [pos('a', 0.4, 450), pos('d', 0.3, 480), pos('e', 0.05, 45), pos('f', 0.25, 10)],
    });

    expect(line(res, 'a').qty).toBe(1);
    expect(line(res, 'd').qty).toBe(0);
    expect(line(res, 'd').note).toBeTruthy();
    expect(line(res, 'd').unbuyable).toBeUndefined(); // 480 ≤ 500: unaffordable now, not unbuyable
    expect(line(res, 'e').qty).toBe(1);
    expect(res.totalCostEur).toBe(495);
    expect(res.totalCostEur).toBeLessThanOrEqual(500);
    expect(res.leftoverEur).toBe(5);
  });

  it('ON: when not all candidates fit, the larger target weight wins regardless of input order', () => {
    // g and h cost the same 300 €; only one fits the 500 € budget after floors
    // reserve nothing (both are under-slice). h is listed second but weighs more.
    const res = allocateBudget({
      budgetEur: 500,
      mode: 'whole',
      atLeastOneShare: true,
      positions: [pos('g', 0.2, 300), pos('h', 0.3, 300), pos('f', 0.5, 10)],
    });

    expect(line(res, 'h').qty).toBe(1);
    expect(line(res, 'g').qty).toBe(0);
    expect(res.totalCostEur).toBeLessThanOrEqual(500);
  });

  it('ON: a share price above the whole budget stays unbuyable — never forced', () => {
    const res = allocateBudget({
      budgetEur: 300,
      mode: 'whole',
      atLeastOneShare: true,
      positions: [pos('a', 0.3, 100), pos('z', 0.2, 400), pos('c', 0.5, 20)],
    });

    expect(line(res, 'a').qty).toBe(1); // forced: 90 € slice < 100 € share
    const z = line(res, 'z');
    expect(z.qty).toBe(0);
    expect(z.unbuyable).toBe(true);
    expect(z.note).toBeTruthy();
    expect(line(res, 'c').qty).toBe(7); // remainder 200 € → c's rebalanced ~142.86 € slice → 7 × 20 €
    expect(res.totalCostEur).toBe(240);
    expect(res.leftoverEur).toBe(60);
  });

  it('ON: the remainder splits across the rest proportionally to their weights', () => {
    const res = allocateBudget({
      budgetEur: 1000,
      mode: 'whole',
      atLeastOneShare: true,
      positions: [pos('exp', 0.1, 340), pos('x', 0.6, 1), pos('y', 0.3, 1)],
    });

    expect(line(res, 'exp').qty).toBe(1);
    // Remainder 660 € splits 0.6 : 0.3 ⇒ 440 € and 220 € at 1 € per share.
    expect(line(res, 'x').qty).toBe(440);
    expect(line(res, 'y').qty).toBe(220);
    expect(res.totalCostEur).toBe(1000);
    expect(res.leftoverEur).toBe(0);
  });

  it('ON: a forced position gets exactly one share, even with plenty of leftover', () => {
    // exp's 50 € slice cannot afford its 60 € share; x floors to 2 × 400 € both
    // with and without the grant, so forcing costs no deployment and stands.
    const res = allocateBudget({
      budgetEur: 1000,
      mode: 'whole',
      atLeastOneShare: true,
      positions: [pos('exp', 0.05, 60), pos('x', 0.95, 400)],
    });

    expect(line(res, 'exp').qty).toBe(1); // never topped up from the 140 € leftover
    expect(line(res, 'x').qty).toBe(2);
    expect(res.totalCostEur).toBe(860);
    expect(res.leftoverEur).toBe(140);
  });

  it('ON: a zero-weight position is never forced', () => {
    const res = allocateBudget({
      budgetEur: 100,
      mode: 'whole',
      atLeastOneShare: true,
      positions: [pos('x', 1, 30), pos('z', 0, 80)],
    });

    expect(line(res, 'x').qty).toBe(3);
    expect(line(res, 'z').qty).toBe(0);
    expect(line(res, 'z').note).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #1778 — the force pass never deploys less capital than the flag-off plan,
// and every unreachable-weight note names a budget that actually reaches it
// ---------------------------------------------------------------------------

describe('allocateBudget — atLeastOneShare never deploys less than the flag-off plan (#1778)', () => {
  /**
   * The defect-1 basket: A's 900 € slice buys its 900 € share outright, B's
   * 100 € slice cannot afford its 150 € share. Forcing B re-targets A off the
   * 850 € remainder — below A's own 900 € price — so A floored to 0 and the
   * greedy fill could not put it back (900 + 150 > 1000).
   */
  const dominant = (atLeastOneShare: boolean): AllocationInput => ({
    budgetEur: 1000,
    mode: 'whole',
    atLeastOneShare,
    positions: [pos('a', 0.9, 900), pos('b', 0.1, 150)],
  });

  it('keeps the dominant leg it used to zero: 900 € invested, not 150 €', () => {
    // Before #1778, ON returned: a qty 0 (0 % actual vs 90 % target, Δ −90 pp),
    // b qty 1, total 150 €, leftover 850 € — 750 € of a 1000 € budget moved out
    // of the market by turning the flag on.
    const on = allocateBudget(dominant(true));
    const off = allocateBudget(dominant(false));

    expect(line(on, 'a').qty).toBeGreaterThanOrEqual(1);
    expect(line(on, 'a').qty).toBe(1);
    expect(line(on, 'a').costEur).toBe(900);
    expect(line(on, 'a').deltaPp).toBeCloseTo(0, 9);
    expect(line(on, 'b').qty).toBe(0);
    expect(on.totalCostEur).toBe(900);
    expect(on.leftoverEur).toBe(100);

    // The rule, stated: the flag is never worse than not setting it.
    expect(on.totalCostEur).toBeGreaterThanOrEqual(off.totalCostEur);
    expect(on.totalCostEur).toBeLessThanOrEqual(1000);
  });

  it('suggests 1050 € for the refused single — not the 1000 € the user is already at', () => {
    // Before #1778 the note printed pᵢ/wᵢ against the REBALANCED slice: "a share
    // price (900 €) exceeds its 850 € slice; raise the budget to ≥ ~1000 €" —
    // the budget already in force, which reproduces the same qty 0.
    const on = allocateBudget(dominant(true));

    expect(line(on, 'a').note).toBeUndefined(); // a is bought; nothing to flag
    expect(line(on, 'b').note).toBe(
      'b share price (150 €) exceeds its 100 € slice; raise the budget to ≥ ~1050 € or use fractional mode.',
    );

    // Round trip: the promised budget really does buy the share.
    const raised = allocateBudget({ ...dominant(true), budgetEur: 1050 });
    expect(line(raised, 'b').qty).toBe(1);
    expect(line(raised, 'a').qty).toBe(1);
    expect(raised.totalCostEur).toBe(1050);

    // And 1050 € is the honest figure: 1049.99 € still cannot seat both.
    const short = allocateBudget({ ...dominant(true), budgetEur: 1049.99 });
    expect(line(short, 'b').qty).toBe(0);
  });

  it('OFF is unchanged by the rule: the same basket still floors a to one share', () => {
    const off = allocateBudget(dominant(false));

    expect(line(off, 'a').qty).toBe(1);
    expect(line(off, 'b').qty).toBe(0);
    expect(off.totalCostEur).toBe(900);
    // With the flag off the reachable budget is the plain slice threshold.
    expect(line(off, 'b').note).toContain('~1500 €');
  });

  it('still grants singles wherever they cost no deployment (the flag is not disabled)', () => {
    // The owner's €240-on-€1000 case: forcing exp re-floors cheap from 80 to 76
    // shares, spending the whole budget instead of 800 € — strictly better.
    const res = allocateBudget({
      budgetEur: 1000,
      mode: 'whole',
      atLeastOneShare: true,
      positions: [pos('exp', 0.2, 240), pos('cheap', 0.8, 10)],
    });

    expect(line(res, 'exp').qty).toBe(1);
    expect(line(res, 'cheap').qty).toBe(76);
    expect(res.totalCostEur).toBe(1000);
    expect(res.totalCostEur).toBeGreaterThan(
      allocateBudget({
        budgetEur: 1000,
        mode: 'whole',
        positions: [pos('exp', 0.2, 240), pos('cheap', 0.8, 10)],
      }).totalCostEur,
    );
  });

  it('retreats one single at a time, keeping the larger-weight grant (§6.7 priority)', () => {
    // b (w .15 @ 400 €) and c (w .05 @ 300 €) are both under-slice candidates
    // and both would be admitted together (400 + 300 ≤ 1250), but granting both
    // leaves too little for a and d to refloor. The smaller-weight single (c) is
    // dropped first and b keeps its share — a partial retreat that still beats
    // the flag-off plan by 44 €.
    const basket = [pos('a', 0.43, 356), pos('b', 0.15, 400), pos('c', 0.05, 300), pos('d', 0.37, 240)]; // prettier-ignore
    const res = allocateBudget({
      budgetEur: 1250,
      mode: 'whole',
      atLeastOneShare: true,
      positions: basket,
    });
    const off = allocateBudget({ budgetEur: 1250, mode: 'whole', positions: basket });

    expect(line(res, 'b').qty).toBe(1);
    expect(line(res, 'c').qty).toBe(0);
    expect(line(res, 'a').qty).toBe(1);
    expect(line(res, 'd').qty).toBe(2);
    expect(res.totalCostEur).toBe(1236);
    expect(off.totalCostEur).toBe(1192);
    expect(res.totalCostEur).toBeGreaterThan(off.totalCostEur);
    expect(res.totalCostEur).toBeLessThanOrEqual(1250);

    // c's note prices in the single b keeps: pᵢ·Σ_rest w/wᵢ + Σ forced, verified.
    expect(line(res, 'c').note).toContain('~5500 €');
    const raised = allocateBudget({
      budgetEur: 5500,
      mode: 'whole',
      atLeastOneShare: true,
      positions: basket,
    });
    expect(line(raised, 'c').qty).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// #1778 — the quantity floor is a floor (relative epsilon only), and the FP
// backstop shaves the position that actually over-floored
// ---------------------------------------------------------------------------

describe('allocateBudget — floor precision', () => {
  it('does not floor a ratio upward past its mathematical floor', () => {
    // 500 / 250.0000000625 = 1.9999999995 — mathematically one share. The old
    // absolute 1e-9 epsilon floored it to 2 (cost 500.000000125), pushing the
    // total to 1000.000000125 and making the backstop strip a share from b:
    // a = 2, b = 499. §6.7's floor gives a = 1, b = 500.
    const res = allocateBudget({
      budgetEur: 1000,
      mode: 'whole',
      positions: [pos('a', 0.5, 250.0000000625), pos('b', 0.5, 1)],
    });

    expect(line(res, 'a').qty).toBe(1);
    expect(line(res, 'b').qty).toBe(500);
    expect(res.totalCostEur).toBeLessThanOrEqual(1000);
    expect(res.leftoverEur).toBeGreaterThanOrEqual(0);
  });

  it('still snaps a quantity that FP division drops a hair below its boundary', () => {
    // 5 € / 0.0001 steps at 1 € = 50 000 steps; the division lands just under.
    const res = allocateBudget({
      budgetEur: 5,
      mode: 'fractional',
      positions: [pos('x', 1, 1)],
    });

    expect(line(res, 'x').qty).toBeCloseTo(5, 9);
    expect(res.totalCostEur).toBeLessThanOrEqual(5);
    expect(res.leftoverEur).toBeCloseTo(0, 9);
  });

  it('shaves the over-floored position, not the cheapest one', () => {
    // a's ratio sits 1e-12 relative below 2, inside the snap tolerance, so its
    // floor costs a hair more than its 500 € slice and the exact Σ ≤ B check
    // trips. The shave must land on a (over its own target), not on b, which is
    // exactly on target — the pre-#1778 backstop took b down to 499 shares.
    const price = 500 / (2 - 1e-12);
    const res = allocateBudget({
      budgetEur: 1000,
      mode: 'whole',
      positions: [pos('a', 0.5, price), pos('b', 0.5, 1)],
    });

    expect(line(res, 'a').qty).toBe(1);
    expect(line(res, 'b').qty).toBe(500);
    expect(res.totalCostEur).toBeLessThanOrEqual(1000);
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

  it('holds the invariants with atLeastOneShare ON, granting singles whenever affordable (200 baskets)', () => {
    const rnd = lcg(1337);

    for (let i = 0; i < 200; i += 1) {
      const n = 1 + Math.floor(rnd() * 6);
      const raw = Array.from({ length: n }, () => 0.05 + rnd());
      const rawSum = raw.reduce((a, b) => a + b, 0);
      const positions = raw.map((w, j) => pos(`a${j}`, w / rawSum, 0.5 + rnd() * 400));
      const budgetEur = rnd() * 2000;

      const res = allocateBudget({ budgetEur, mode: 'whole', atLeastOneShare: true, positions });
      const off = allocateBudget({ budgetEur, mode: 'whole', positions });

      // The hard invariant survives the force pass — never overshoot.
      expect(res.totalCostEur).toBeLessThanOrEqual(budgetEur);
      expect(res.leftoverEur).toBeGreaterThanOrEqual(0);
      expect(res.totalCostEur + res.leftoverEur).toBeCloseTo(budgetEur, 6);
      // …and so does the second one (#1778): turning the flag ON never deploys
      // less capital than leaving it off. Exact, not approximate: two plans with
      // identical per-position costs sum bit-identically.
      expect(res.totalCostEur).toBeGreaterThanOrEqual(off.totalCostEur);

      let sumCost = 0;
      for (const [j, l] of res.positions.entries()) {
        const p = positions[j]!;
        expect(Number.isInteger(l.qty)).toBe(true);
        expect(l.costEur).toBeCloseTo(l.qty * p.priceEur, 8);
        // A clearly under-slice position left at 0 was either unaffordable at
        // its turn — the total only grows after it, so "affordable at the end"
        // implies "affordable then" — or granting it would have deployed less
        // than the flag-off plan and the engine retreated to it (#1778).
        const sliceShares = (budgetEur * p.weight) / p.priceEur;
        if (l.qty === 0 && p.weight > 0 && sliceShares < 0.999) {
          const unaffordable = p.priceEur > res.leftoverEur - 1e-6;
          expect(unaffordable || res.totalCostEur === off.totalCostEur).toBe(true);
        }
        sumCost += l.costEur;
      }
      expect(sumCost).toBeCloseTo(res.totalCostEur, 8);
    }
  });

  it('every unreachable-weight note names a budget that really buys the position (300 baskets)', () => {
    // The round trip the note promises, as a property: re-run the SAME call at
    // the suggested figure and the flagged position must come back with at
    // least one increment — off the force path and on it (#1778).
    const rnd = lcg(2024);

    for (let i = 0; i < 300; i += 1) {
      const n = 1 + Math.floor(rnd() * 5);
      const raw = Array.from({ length: n }, () => 0.05 + rnd());
      const rawSum = raw.reduce((a, b) => a + b, 0);
      const positions = raw.map((w, j) => pos(`a${j}`, w / rawSum, 0.5 + rnd() * 400));
      const budgetEur = rnd() * 1500;
      const mode = i % 3 === 0 ? ('fractional' as const) : ('whole' as const);
      const atLeastOneShare = i % 2 === 0;
      const input: AllocationInput = { budgetEur, mode, atLeastOneShare, positions };

      const res = allocateBudget(input);
      for (const l of res.positions) {
        if (l.note === undefined) continue;
        const suggested = suggestedMin(l.note);
        expect(suggested).toBeGreaterThan(budgetEur);
        const raised = allocateBudget({ ...input, budgetEur: suggested });
        const reached = raised.positions.find((p) => p.assetId === l.assetId)!;
        expect(reached.qty).toBeGreaterThan(0);
        expect(raised.totalCostEur).toBeLessThanOrEqual(suggested);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The note's denomination (#1831)
// ---------------------------------------------------------------------------

describe('allocateBudget — the note is spelled in the run’s currency', () => {
  it('renders a CHF run entirely in CHF: no euro sign anywhere in the notes', () => {
    // The §6.7 worked example, run by a CHF-base caller: same numbers, same
    // sentence, but every figure is the money the caller actually asked about.
    // A hardcoded `€` used to tell them to raise a CHF budget "to ≥ ~1400 €".
    const res = allocateBudget({ ...workedExample('whole'), currency: 'CHF' });
    const googl = line(res, 'googl');

    expect(googl.note).toBe(
      'GOOGL share price (140 CHF) exceeds its 100 CHF slice; raise the budget to ≥ ~1400 CHF or use fractional mode.',
    );
    expect(res.warnings).toEqual([googl.note]);
    for (const warning of res.warnings) expect(warning).not.toContain('€');
    // The structured facts carry the denomination, so a caller restating them
    // (the Invest Calculator's withheld-share rescale) keeps this spelling.
    expect(googl.unreachable?.currency).toBe('CHF');
    // Only the label moved: the plan itself is untouched.
    expect(res.totalCostEur).toBe(900);
    expect(res.leftoverEur).toBe(100);
    expect(res.totalCostEur).toBeLessThanOrEqual(1000);
  });

  it('renders the fractional-mode note in the run currency too', () => {
    const res = allocateBudget({
      budgetEur: 100,
      mode: 'fractional',
      step: 1,
      currency: 'USD',
      positions: [pos('x', 0.99, 50), pos('y', 0.01, 80)],
    });

    const y = line(res, 'y');
    expect(y.note).toBe(
      'y: one 1-share step (80 USD) exceeds its 1 USD slice; raise the budget to ≥ ~8000 USD.',
    );
    expect(y.note).not.toContain('€');
    expect(res.totalCostEur).toBeLessThanOrEqual(100);
  });

  it('is byte-identical to the euro sentence for a EUR run, given or omitted', () => {
    // §6.7's worked example is the contract for a EUR-base run: the currency
    // parameter may not move it by one character.
    const omitted = allocateBudget(workedExample('whole'));
    const given = allocateBudget({ ...workedExample('whole'), currency: 'EUR' });
    const lowercase = allocateBudget({ ...workedExample('whole'), currency: 'eur' });

    expect(line(omitted, 'googl').note).toBe(
      'GOOGL share price (140 €) exceeds its 100 € slice; raise the budget to ≥ ~1400 € or use fractional mode.',
    );
    expect(line(given, 'googl').note).toBe(line(omitted, 'googl').note);
    expect(lowercase.warnings).toEqual(omitted.warnings);
  });

  it('keeps Σ cost ≤ B when the caller withheld part of the budget', () => {
    // What the Invest Calculator does with an unresolved nested slice (#1811):
    // the engine is handed the resolved remainder, and the note is restated in
    // the caller's own denomination. Both budgets bound the same plan.
    const budgetChf = 1000;
    const allocatable = budgetChf * 0.6;
    const res = allocateBudget({
      budgetEur: allocatable,
      mode: 'whole',
      currency: 'CHF',
      positions: [pos('big', 0.9, 200), pos('small', 0.1, 140)],
    });

    expect(res.totalCostEur).toBeLessThanOrEqual(allocatable);
    expect(res.totalCostEur).toBeLessThanOrEqual(budgetChf);
    const small = line(res, 'small');
    expect(small.unreachable).toBeDefined();
    const restated = unreachableWeightNote(
      rescaleUnreachableWeight(small.unreachable!, allocatable / budgetChf),
    );
    expect(restated).toContain('CHF');
    expect(restated).not.toContain('€');
  });
});
