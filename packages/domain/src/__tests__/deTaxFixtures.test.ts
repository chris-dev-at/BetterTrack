import { describe, expect, it } from 'vitest';

import { floorCents, viennaYearOf } from '../tax';
import {
  DE_KAPEST_RATE,
  DE_SOLI_RATE,
  DE_SPARER_PAUSCHBETRAG_EUR,
  DE_TAX_FIXTURES,
  type DeExpectedYear,
  type DeTaxFixtureScenario,
} from './deTaxFixtures';

/**
 * Shape/consistency test for the DE fixture set (V5-P4 arc (a), issue #576).
 *
 * The DE engine does NOT exist yet — this suite proves the hand-computed
 * fixtures are internally consistent, so CI stays green until the follow-up
 * engine issue makes them pass for real: dates are valid, the transaction log
 * is coherent, per-sell arithmetic reconciles, year aggregates follow the
 * researched §16 2026-07-17 year-target formula, quantization matches
 * `floorCents` (parity with the AT engine's quantizer), and settlement steps
 * chain to the year-end target. It deliberately does NOT recompute FIFO lot
 * consumption — that is the engine's core, and the fixture basis numbers are
 * hand-computed by design.
 */

/** Exact-cent comparison: all fixture money values are cent-clean literals. */
const centsOf = (v: number): number => Math.round(v * 100);

const expectCentsEqual = (actual: number, expected: number, label: string): void => {
  expect(`${label}: ${centsOf(actual)}`).toBe(`${label}: ${centsOf(expected)}`);
};

interface TaxableEvent {
  id: string;
  ms: number;
  year: number;
}

/** The year's taxable events (sells + dividends — never buys), chronological. */
function taxableEventsOf(scenario: DeTaxFixtureScenario): TaxableEvent[] {
  const sells = scenario.transactions
    .filter((t) => t.side === 'sell')
    .map((t) => ({ id: t.id, ms: Date.parse(t.executedAt), year: viennaYearOf(t.executedAt) }));
  const dividends = scenario.dividends.map((d) => ({
    id: d.id,
    ms: Date.parse(d.executedAt),
    year: viennaYearOf(d.executedAt),
  }));
  return [...sells, ...dividends].sort((a, b) => a.ms - b.ms);
}

/**
 * The researched DE year-end aggregation (§16 2026-07-17), applied to a year's
 * STATED aggregates — the reference the hand-computed fields must obey. Pot
 * remainders and the one-directional cross-offset (a negative Sonstige
 * remainder also offsets Aktien gains, never vice versa) per §20 Abs. 6 EStG.
 */
function recomputeYearEnd(y: DeExpectedYear) {
  const aktienRemainder = y.aktienSalePnlEur - y.aktienPotInEur;
  const sonstigeRemainder = y.dividendsEur + y.sonstigeSalePnlEur - y.sonstigePotInEur;
  let aktienPositive = Math.max(0, aktienRemainder);
  const aktienPotOut = Math.max(0, -aktienRemainder);
  let sonstigePotOut = 0;
  if (sonstigeRemainder < 0) {
    const crossOffset = Math.min(-sonstigeRemainder, aktienPositive);
    aktienPositive -= crossOffset;
    sonstigePotOut = -sonstigeRemainder - crossOffset;
  }
  const taxableBeforeAllowance = aktienPositive + Math.max(0, sonstigeRemainder);
  const allowanceUsed = Math.min(DE_SPARER_PAUSCHBETRAG_EUR, taxableBeforeAllowance);
  const taxableBase = taxableBeforeAllowance - allowanceUsed;
  const kapest = floorCents(DE_KAPEST_RATE * taxableBase);
  const soli = floorCents(DE_SOLI_RATE * kapest);
  return {
    aktienPotOut,
    sonstigePotOut,
    taxableBeforeAllowance,
    allowanceUsed,
    taxableBase,
    kapest,
    soli,
  };
}

const byId = new Map(DE_TAX_FIXTURES.map((s) => [s.id, s]));

describe('DE tax fixture catalog', () => {
  it('contains the eight mandated scenarios with unique ids', () => {
    expect(DE_TAX_FIXTURES.map((s) => s.id)).toEqual([
      'de-simple-gain',
      'de-fifo-multi-lot',
      'de-allowance-exhaustion',
      'de-aktien-loss-ringfenced',
      'de-sonstige-loss-cross-offset',
      'de-rounding-truncation',
      'de-year-boundary-carry',
      'de-intra-year-refund',
    ]);
    expect(byId.size).toBe(DE_TAX_FIXTURES.length);
  });

  it('documents every scenario with statute references', () => {
    for (const s of DE_TAX_FIXTURES) {
      expect(s.ruleRefs.length, s.id).toBeGreaterThan(0);
      expect(s.title.length, s.id).toBeGreaterThan(0);
      expect(s.description.length, s.id).toBeGreaterThan(0);
      expect(s.expectedYears.length, s.id).toBeGreaterThan(0);
    }
  });
});

describe.each(DE_TAX_FIXTURES.map((s) => [s.id, s] as const))('%s', (_id, scenario) => {
  it('has valid, coherent inputs (dates parse; amounts sane; ids unique)', () => {
    const ids = new Set<string>();
    for (const t of scenario.transactions) {
      expect(ids.has(t.id), `duplicate id ${t.id}`).toBe(false);
      ids.add(t.id);
      expect(Number.isInteger(viennaYearOf(t.executedAt))).toBe(true);
      expect(t.quantity).toBeGreaterThan(0);
      expect(t.priceEur).toBeGreaterThanOrEqual(0);
      expect(t.feeEur).toBeGreaterThanOrEqual(0);
    }
    for (const d of scenario.dividends) {
      expect(ids.has(d.id), `duplicate id ${d.id}`).toBe(false);
      ids.add(d.id);
      expect(Number.isInteger(viennaYearOf(d.executedAt))).toBe(true);
      expect(d.grossEur).toBeGreaterThan(0);
    }
  });

  it('never sells more units than were bought before the sell', () => {
    const ordered = [...scenario.transactions].sort(
      (a, b) => Date.parse(a.executedAt) - Date.parse(b.executedAt),
    );
    const held = new Map<string, number>();
    for (const t of ordered) {
      const current = held.get(t.assetId) ?? 0;
      if (t.side === 'buy') {
        held.set(t.assetId, current + t.quantity);
      } else {
        expect(current + 1e-9, `oversell in ${t.id}`).toBeGreaterThanOrEqual(t.quantity);
        held.set(t.assetId, current - t.quantity);
      }
    }
  });

  it('states exactly one expected realization per sell, with matching category', () => {
    const sells = scenario.transactions
      .filter((t) => t.side === 'sell')
      .sort((a, b) => Date.parse(a.executedAt) - Date.parse(b.executedAt));
    expect(scenario.expectedSells.map((e) => e.id)).toEqual(sells.map((t) => t.id));
    for (const expectedSell of scenario.expectedSells) {
      const sell = sells.find((t) => t.id === expectedSell.id)!;
      expect(expectedSell.category).toBe(sell.category);
      // proceeds = qty · price − fee (sell fee deducted, §20 Abs. 4 Satz 1).
      expectCentsEqual(
        expectedSell.proceedsEur,
        sell.quantity * sell.priceEur - sell.feeEur,
        `${scenario.id}/${sell.id} proceeds`,
      );
      // P/L = proceeds − FIFO basis. The basis itself is hand-computed (the
      // FIFO replay is the engine's job, not this shape test's).
      expectCentsEqual(
        expectedSell.realizedPnlEur,
        expectedSell.proceedsEur - expectedSell.fifoCostBasisEur,
        `${scenario.id}/${sell.id} pnl`,
      );
      if (expectedSell.movingAveragePnlEur !== undefined) {
        // Stated only to prove divergence — it must actually diverge.
        expect(centsOf(expectedSell.movingAveragePnlEur)).not.toBe(
          centsOf(expectedSell.realizedPnlEur),
        );
      }
    }
  });

  it('year aggregates reconcile with the per-event inputs', () => {
    const years = scenario.expectedYears.map((y) => y.year);
    expect([...years].sort((a, b) => a - b)).toEqual(years);
    expect(new Set(years).size).toBe(years.length);

    // Every taxable event falls in a listed year.
    for (const event of taxableEventsOf(scenario)) {
      expect(years, `year of ${event.id} missing`).toContain(event.year);
    }

    for (const y of scenario.expectedYears) {
      const sellsInYear = scenario.expectedSells.filter((e) => {
        const t = scenario.transactions.find((tx) => tx.id === e.id)!;
        return viennaYearOf(t.executedAt) === y.year;
      });
      const aktienPnl = sellsInYear
        .filter((e) => e.category === 'aktien')
        .reduce((sum, e) => sum + e.realizedPnlEur, 0);
      const sonstigePnl = sellsInYear
        .filter((e) => e.category === 'sonstige')
        .reduce((sum, e) => sum + e.realizedPnlEur, 0);
      const dividends = scenario.dividends
        .filter((d) => viennaYearOf(d.executedAt) === y.year)
        .reduce((sum, d) => sum + d.grossEur, 0);

      expectCentsEqual(y.aktienSalePnlEur, aktienPnl, `${scenario.id}/${y.year} aktien pnl`);
      expectCentsEqual(y.sonstigeSalePnlEur, sonstigePnl, `${scenario.id}/${y.year} sonstige pnl`);
      expectCentsEqual(y.dividendsEur, dividends, `${scenario.id}/${y.year} dividends`);
    }
  });

  it('follows the researched year-target formula (pots, cross-offset, allowance, floors)', () => {
    for (const y of scenario.expectedYears) {
      const ref = recomputeYearEnd(y);
      const label = `${scenario.id}/${y.year}`;
      expectCentsEqual(
        y.taxableBeforeAllowanceEur,
        ref.taxableBeforeAllowance,
        `${label} taxableBefore`,
      );
      expectCentsEqual(y.allowanceUsedEur, ref.allowanceUsed, `${label} allowanceUsed`);
      expectCentsEqual(y.taxableBaseEur, ref.taxableBase, `${label} base`);
      expectCentsEqual(y.kapestEur, ref.kapest, `${label} kapest`);
      expectCentsEqual(y.soliEur, ref.soli, `${label} soli`);
      expectCentsEqual(y.totalTaxEur, y.kapestEur + y.soliEur, `${label} total`);
      expectCentsEqual(y.aktienPotOutEur, ref.aktienPotOut, `${label} aktien pot out`);
      expectCentsEqual(y.sonstigePotOutEur, ref.sonstigePotOut, `${label} sonstige pot out`);

      // Allowance identities: per-year budget, never negative, no carry.
      expect(y.allowanceUsedEur).toBeGreaterThanOrEqual(0);
      expectCentsEqual(
        y.allowanceUsedEur + y.allowanceRemainingEur,
        DE_SPARER_PAUSCHBETRAG_EUR,
        `${label} allowance budget`,
      );
      // Pots are stored positive.
      expect(y.aktienPotInEur).toBeGreaterThanOrEqual(0);
      expect(y.sonstigePotInEur).toBeGreaterThanOrEqual(0);
      expect(y.aktienPotOutEur).toBeGreaterThanOrEqual(0);
      expect(y.sonstigePotOutEur).toBeGreaterThanOrEqual(0);
    }
  });

  it('chains pots across consecutive listed years', () => {
    for (let i = 1; i < scenario.expectedYears.length; i += 1) {
      const prev = scenario.expectedYears[i - 1]!;
      const next = scenario.expectedYears[i]!;
      expect(next.year).toBe(prev.year + 1);
      expectCentsEqual(next.aktienPotInEur, prev.aktienPotOutEur, `${scenario.id} aktien carry`);
      expectCentsEqual(
        next.sonstigePotInEur,
        prev.sonstigePotOutEur,
        `${scenario.id} sonstige carry`,
      );
    }
    // First listed year starts with empty pots in every current scenario.
    expect(scenario.expectedYears[0]!.aktienPotInEur).toBe(0);
    expect(scenario.expectedYears[0]!.sonstigePotInEur).toBe(0);
  });

  it('settlement steps cover the year events chronologically and chain to the target', () => {
    const events = taxableEventsOf(scenario);
    for (const y of scenario.expectedYears) {
      const eventsInYear = events.filter((e) => e.year === y.year);
      expect(y.steps.map((s) => s.eventId)).toEqual(eventsInYear.map((e) => e.id));

      let held = 0;
      for (const step of y.steps) {
        // Deltas are stored cent-quantized (they become movements).
        expect(floorCents(step.deltaEur)).toBe(step.deltaEur);
        held = (centsOf(held) + centsOf(step.deltaEur)) / 100;
        expectCentsEqual(step.heldAfterEur, held, `${scenario.id}/${y.year}/${step.eventId} held`);
        // Tax held is never negative — losses park, they never pre-refund.
        expect(step.heldAfterEur).toBeGreaterThanOrEqual(0);
      }
      // The steps land exactly on the year-end target: Σ deltas = total tax.
      expectCentsEqual(held, y.totalTaxEur, `${scenario.id}/${y.year} final held`);
    }
  });
});

describe('acceptance pins (issue #576)', () => {
  it('the FIFO scenario provably differs from moving average in total', () => {
    const s = byId.get('de-fifo-multi-lot')!;
    const fifoTotal = s.expectedSells.reduce((sum, e) => sum + e.realizedPnlEur, 0);
    const maTotal = s.expectedSells.reduce((sum, e) => sum + (e.movingAveragePnlEur ?? 0), 0);
    expect(s.expectedSells.every((e) => e.movingAveragePnlEur !== undefined)).toBe(true);
    expect(centsOf(fifoTotal)).toBe(centsOf(8500));
    expect(centsOf(maTotal)).toBe(centsOf(6000));
  });

  it('the allowance scenario exhausts €1,000 partially, then fully', () => {
    const [year] = byId.get('de-allowance-exhaustion')!.expectedYears;
    expect(year!.steps.map((s) => centsOf(s.deltaEur))).toEqual([0, 7912, 10550]);
    expect(year!.allowanceRemainingEur).toBe(0);
  });

  it('the ring-fence scenario taxes the dividend while the Aktien loss carries out', () => {
    const [year] = byId.get('de-aktien-loss-ringfenced')!.expectedYears;
    expect(year!.taxableBaseEur).toBeGreaterThan(0);
    expect(year!.aktienPotOutEur).toBe(1500);
  });

  it('a refund-of-already-withheld step exists and stays within what was withheld', () => {
    const [year] = byId.get('de-intra-year-refund')!.expectedYears;
    const refund = year!.steps.find((s) => s.deltaEur < 0);
    expect(refund).toBeDefined();
    expect(centsOf(refund!.deltaEur)).toBe(-19782);
    // The cross-offset scenario also refunds mid-year (§43a Abs. 3 Satz 2).
    const crossYear = byId.get('de-sonstige-loss-cross-offset')!.expectedYears[0]!;
    expect(crossYear.steps.some((s) => s.deltaEur < 0)).toBe(true);
  });

  it('pots carry across the year boundary while the allowance resets', () => {
    const [y2024, y2025] = byId.get('de-year-boundary-carry')!.expectedYears;
    expect(y2024!.allowanceRemainingEur).toBe(DE_SPARER_PAUSCHBETRAG_EUR); // unused, lost
    expect(y2025!.aktienPotInEur).toBe(800);
    expect(y2025!.sonstigePotInEur).toBe(300);
    expect(y2025!.allowanceUsedEur).toBe(DE_SPARER_PAUSCHBETRAG_EUR); // fresh budget
  });

  it('Soli is 5.5 % of the (floored) KapESt, floored — never rounded up', () => {
    const [year] = byId.get('de-rounding-truncation')!.expectedYears;
    // 0.25 · 1,344.42 = 336.105 → 336.10 (not 336.11); 0.055 · 336.10 =
    // 18.4855 → 18.48 (not 18.49; §4 Satz 2 SolzG).
    expect(year!.kapestEur).toBe(336.1);
    expect(year!.soliEur).toBe(18.48);
  });
});
