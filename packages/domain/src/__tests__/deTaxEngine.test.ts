import { describe, expect, it } from 'vitest';

import {
  costBasisStrategyForCountry,
  deCarryPots,
  dePotCategoryForAssetType,
  deYearOutcome,
  realizedSellsEur,
  settleDeYear,
  TaxComputationError,
  TAX_COUNTRY_AT,
  TAX_COUNTRY_DE,
  viennaYearOf,
  type DeTaxableEvent,
  type DeYearAggregates,
  type TaxableTransaction,
} from '../tax';
import { DE_TAX_FIXTURES, type DeTaxFixtureScenario } from './deTaxFixtures';

/**
 * The DE tax engine against the #576 fixture set (V5-P4 arc (a), issue #580).
 *
 * This suite is the "fixtures activated" deliverable: every scenario's inputs
 * run through the REAL engine — `realizedSellsEur` with the `fifo` strategy
 * for the per-sell realizations, `deCarryPots` for the cross-year pot chain,
 * and `settleDeYear` for the chronological settlement deltas — and every
 * hand-computed expected number must come out exactly. The companion
 * `deTaxFixtures.test.ts` (shape/consistency, #576) stays untouched.
 *
 * Money asserts compare whole cents (`centsOf`) wherever a fixture literal is
 * cent-clean, exactly like the shape test — full-FP intermediate values are
 * the engine's business, the fixtures pin the observable boundary amounts.
 */

const centsOf = (v: number): number => Math.round(v * 100);

const expectCentsEqual = (actual: number, expected: number, label: string): void => {
  expect(`${label}: ${centsOf(actual)}`).toBe(`${label}: ${centsOf(expected)}`);
};

/** A scenario's trades in the engine's input shape (category stripped). */
function taxablesOf(scenario: DeTaxFixtureScenario): TaxableTransaction[] {
  return scenario.transactions.map((t) => ({
    id: t.id,
    assetId: t.assetId,
    side: t.side,
    quantity: t.quantity,
    priceEur: t.priceEur,
    feeEur: t.feeEur,
    executedAt: t.executedAt,
  }));
}

interface YearEvent {
  id: string;
  ms: number;
  year: number;
  event: DeTaxableEvent;
}

/**
 * The scenario's taxable events (sells with their ENGINE-computed FIFO P/L,
 * dividends with their gross), chronological — the recording order the
 * settlement steps replay.
 */
function engineEventsOf(scenario: DeTaxFixtureScenario): YearEvent[] {
  const realizations = new Map(
    realizedSellsEur(taxablesOf(scenario), 'fifo').map((r) => [r.id, r]),
  );
  const sells: YearEvent[] = scenario.transactions
    .filter((t) => t.side === 'sell')
    .map((t) => {
      const realization = realizations.get(t.id);
      if (!realization) throw new Error(`No realization for sell ${t.id}`);
      return {
        id: t.id,
        ms: Date.parse(t.executedAt),
        year: viennaYearOf(t.executedAt),
        event: {
          kind: 'sell_gain' as const,
          category: t.category,
          amountEur: realization.realizedPnlEur,
        },
      };
    });
  const dividends: YearEvent[] = scenario.dividends.map((d) => ({
    id: d.id,
    ms: Date.parse(d.executedAt),
    year: viennaYearOf(d.executedAt),
    event: { kind: 'dividend' as const, amountEur: d.grossEur },
  }));
  return [...sells, ...dividends].sort((a, b) => a.ms - b.ms);
}

describe.each(DE_TAX_FIXTURES.map((s) => [s.id, s] as const))('%s', (_id, scenario) => {
  it('realizes every sell per FIFO lot consumption — proceeds, basis, P/L exact', () => {
    const realizations = realizedSellsEur(taxablesOf(scenario), 'fifo');
    expect(realizations.map((r) => r.id)).toEqual(scenario.expectedSells.map((e) => e.id));
    for (const [i, expected] of scenario.expectedSells.entries()) {
      const actual = realizations[i]!;
      const label = `${scenario.id}/${expected.id}`;
      expectCentsEqual(actual.proceedsEur, expected.proceedsEur, `${label} proceeds`);
      expectCentsEqual(actual.costBasisEur, expected.fifoCostBasisEur, `${label} basis`);
      expectCentsEqual(actual.realizedPnlEur, expected.realizedPnlEur, `${label} pnl`);
      expect(actual.uncoveredQuantity).toBe(0);
    }
  });

  it('the moving-average strategy reproduces the stated divergent P/L — never the FIFO one', () => {
    const divergent = scenario.expectedSells.filter((e) => e.movingAveragePnlEur !== undefined);
    if (divergent.length === 0) return;
    const averaged = new Map(
      realizedSellsEur(taxablesOf(scenario), 'moving-average').map((r) => [r.id, r]),
    );
    for (const expected of divergent) {
      const actual = averaged.get(expected.id)!;
      const label = `${scenario.id}/${expected.id}`;
      expectCentsEqual(actual.realizedPnlEur, expected.movingAveragePnlEur!, `${label} avg pnl`);
      expect(centsOf(actual.realizedPnlEur)).not.toBe(centsOf(expected.realizedPnlEur));
    }
  });

  it('chains the loss pots across years exactly (allowance never carries)', () => {
    const events = engineEventsOf(scenario);
    for (const [i, year] of scenario.expectedYears.entries()) {
      const priorYears = scenario.expectedYears
        .slice(0, i)
        .map((prior) => events.filter((e) => e.year === prior.year).map((e) => e.event));
      const pots = deCarryPots(priorYears);
      const label = `${scenario.id}/${year.year}`;
      expectCentsEqual(pots.aktienEur, year.aktienPotInEur, `${label} aktien pot in`);
      expectCentsEqual(pots.sonstigeEur, year.sonstigePotInEur, `${label} sonstige pot in`);
    }
  });

  it('replays every settlement step: marginal deltas and held-after, event by event', () => {
    const events = engineEventsOf(scenario);
    for (const year of scenario.expectedYears) {
      const yearEvents = events.filter((e) => e.year === year.year);
      expect(yearEvents.map((e) => e.id)).toEqual(year.steps.map((s) => s.eventId));

      const existing: DeTaxableEvent[] = [];
      let held = 0;
      for (const [i, step] of year.steps.entries()) {
        const settlement = settleDeYear({
          aktienPotInEur: year.aktienPotInEur,
          sonstigePotInEur: year.sonstigePotInEur,
          existingEvents: existing,
          heldEur: held,
          newEvents: [yearEvents[i]!.event],
        });
        const label = `${scenario.id}/${year.year}/${step.eventId}`;
        // Held always equals the existing events' target — no drift to correct.
        expectCentsEqual(settlement.correctionDeltaEur, 0, `${label} correction`);
        expectCentsEqual(settlement.newEventDeltasEur[0]!, step.deltaEur, `${label} delta`);
        expectCentsEqual(settlement.heldAfterEur, step.heldAfterEur, `${label} held`);
        existing.push(yearEvents[i]!.event);
        held = settlement.heldAfterEur;
      }
    }
  });

  it('settling all events in one batch lands on the same deltas and target', () => {
    const events = engineEventsOf(scenario);
    for (const year of scenario.expectedYears) {
      const settlement = settleDeYear({
        aktienPotInEur: year.aktienPotInEur,
        sonstigePotInEur: year.sonstigePotInEur,
        existingEvents: [],
        heldEur: 0,
        newEvents: events.filter((e) => e.year === year.year).map((e) => e.event),
      });
      const label = `${scenario.id}/${year.year}`;
      expect(settlement.newEventDeltasEur.map(centsOf)).toEqual(
        year.steps.map((s) => centsOf(s.deltaEur)),
      );
      expectCentsEqual(settlement.heldAfterEur, year.totalTaxEur, `${label} final held`);
    }
  });

  it('derives the year-end state exactly: allowance, base, KapESt, Soli, pot-outs', () => {
    const events = engineEventsOf(scenario);
    for (const year of scenario.expectedYears) {
      const outcome = settleDeYear({
        aktienPotInEur: year.aktienPotInEur,
        sonstigePotInEur: year.sonstigePotInEur,
        existingEvents: events.filter((e) => e.year === year.year).map((e) => e.event),
        heldEur: year.totalTaxEur,
        newEvents: [],
      }).yearEnd;
      const label = `${scenario.id}/${year.year}`;
      expectCentsEqual(
        outcome.taxableBeforeAllowanceEur,
        year.taxableBeforeAllowanceEur,
        `${label} taxableBefore`,
      );
      expectCentsEqual(outcome.allowanceUsedEur, year.allowanceUsedEur, `${label} allowanceUsed`);
      expectCentsEqual(
        outcome.allowanceRemainingEur,
        year.allowanceRemainingEur,
        `${label} allowanceRemaining`,
      );
      expectCentsEqual(outcome.taxableBaseEur, year.taxableBaseEur, `${label} base`);
      expectCentsEqual(outcome.kapestEur, year.kapestEur, `${label} kapest`);
      expectCentsEqual(outcome.soliEur, year.soliEur, `${label} soli`);
      expectCentsEqual(outcome.totalTaxEur, year.totalTaxEur, `${label} total`);
      expectCentsEqual(outcome.aktienPotOutEur, year.aktienPotOutEur, `${label} aktien out`);
      expectCentsEqual(outcome.sonstigePotOutEur, year.sonstigePotOutEur, `${label} sonstige out`);
    }
  });
});

// ─── FIFO strategy unit tests ─────────────────────────────────────────────────

const tx = (
  id: string,
  side: 'buy' | 'sell',
  quantity: number,
  priceEur: number,
  executedAt: string,
  extra: Partial<TaxableTransaction> = {},
): TaxableTransaction => ({
  id,
  assetId: extra.assetId ?? 'asset-1',
  side,
  quantity,
  priceEur,
  feeEur: 0,
  executedAt,
  ...extra,
});

describe('FIFO cost-basis strategy', () => {
  it('pro-rates buy fees into the lot and consumes partial lots oldest-first', () => {
    const realizations = realizedSellsEur(
      [
        // lot1: 4 @ 10, fee 2 → per-unit 10.50; lot2: 6 @ 20, fee 3 → per-unit 20.50
        tx('b1', 'buy', 4, 10, '2024-01-05T12:00:00.000Z', { feeEur: 2 }),
        tx('b2', 'buy', 6, 20, '2024-02-05T12:00:00.000Z', { feeEur: 3 }),
        // 5 units: all of lot1 + 1 of lot2 → basis 4·10.5 + 1·20.5 = 62.50
        tx('s1', 'sell', 5, 30, '2024-06-05T12:00:00.000Z', { feeEur: 1 }),
        // remaining 5 of lot2 → basis 102.50
        tx('s2', 'sell', 5, 8, '2024-09-05T12:00:00.000Z'),
      ],
      'fifo',
    );
    expect(realizations).toHaveLength(2);
    expect(realizations[0]).toMatchObject({
      id: 's1',
      proceedsEur: 149,
      costBasisEur: 62.5,
      realizedPnlEur: 86.5,
    });
    expect(realizations[1]).toMatchObject({
      id: 's2',
      proceedsEur: 40,
      costBasisEur: 102.5,
      realizedPnlEur: -62.5,
    });
  });

  it('keeps per-asset lot queues independent', () => {
    const realizations = realizedSellsEur(
      [
        tx('a-buy', 'buy', 10, 100, '2024-01-05T12:00:00.000Z', { assetId: 'a' }),
        tx('b-buy', 'buy', 10, 1, '2024-01-06T12:00:00.000Z', { assetId: 'b' }),
        tx('a-sell', 'sell', 10, 150, '2024-05-05T12:00:00.000Z', { assetId: 'a' }),
      ],
      'fifo',
    );
    expect(realizations).toHaveLength(1);
    // Asset b's cheap lot must not leak into asset a's basis.
    expect(realizations[0]!.costBasisEur).toBe(1000);
    expect(realizations[0]!.realizedPnlEur).toBe(500);
  });

  it('throws on an unacknowledged oversell, exactly like the moving average', () => {
    const log = [
      tx('b1', 'buy', 5, 10, '2024-01-05T12:00:00.000Z'),
      tx('s1', 'sell', 6, 10, '2024-02-05T12:00:00.000Z'),
    ];
    expect(() => realizedSellsEur(log, 'fifo')).toThrow(TaxComputationError);
  });

  it('handles an acknowledged uncovered sell: real lots release, the rest takes the supplied basis, the position closes', () => {
    const realizations = realizedSellsEur(
      [
        tx('b1', 'buy', 2, 100, '2024-01-05T12:00:00.000Z'),
        // 5 sold, 2 covered (basis 200) + 3 uncovered at the supplied 30 (90).
        tx('s1', 'sell', 5, 50, '2024-03-05T12:00:00.000Z', {
          allowUncovered: true,
          uncoveredEntryPriceEur: 30,
        }),
        // The queue is empty afterwards: a fresh buy starts a fresh lot.
        tx('b2', 'buy', 1, 10, '2024-05-05T12:00:00.000Z'),
        tx('s2', 'sell', 1, 25, '2024-06-05T12:00:00.000Z'),
      ],
      'fifo',
    );
    expect(realizations[0]).toMatchObject({
      id: 's1',
      proceedsEur: 250,
      costBasisEur: 290,
      realizedPnlEur: -40,
      uncoveredQuantity: 3,
    });
    expect(realizations[1]).toMatchObject({ id: 's2', costBasisEur: 10, realizedPnlEur: 15 });
  });

  it('an uncovered sell without an entry price books 0 gain on the uncovered portion', () => {
    const realizations = realizedSellsEur(
      [
        tx('b1', 'buy', 1, 100, '2024-01-05T12:00:00.000Z'),
        tx('s1', 'sell', 3, 60, '2024-03-05T12:00:00.000Z', { allowUncovered: true }),
      ],
      'fifo',
    );
    // Covered unit: 60 − 100 = −40; uncovered units basised at the sale price.
    expect(realizations[0]).toMatchObject({
      proceedsEur: 180,
      costBasisEur: 220,
      realizedPnlEur: -40,
      uncoveredQuantity: 2,
    });
  });

  it('clamps float dust when fractional sells close the position', () => {
    const realizations = realizedSellsEur(
      [
        tx('b1', 'buy', 0.3, 10, '2024-01-05T12:00:00.000Z'),
        tx('s1', 'sell', 0.1, 12, '2024-02-05T12:00:00.000Z'),
        // 0.3 − 0.1 leaves 0.19999…; the epsilon tolerance must accept 0.2.
        tx('s2', 'sell', 0.2, 12, '2024-03-05T12:00:00.000Z'),
      ],
      'fifo',
    );
    expect(realizations).toHaveLength(2);
    expect(realizations[1]!.realizedPnlEur).toBeCloseTo(0.4, 10);
    // The position is closed: another sell must be an oversell.
    expect(() =>
      realizedSellsEur(
        [
          tx('b1', 'buy', 0.3, 10, '2024-01-05T12:00:00.000Z'),
          tx('s1', 'sell', 0.1, 12, '2024-02-05T12:00:00.000Z'),
          tx('s2', 'sell', 0.2, 12, '2024-03-05T12:00:00.000Z'),
          tx('s3', 'sell', 0.1, 12, '2024-04-05T12:00:00.000Z'),
        ],
        'fifo',
      ),
    ).toThrow(TaxComputationError);
  });

  it('defaults to the moving average: omitting the strategy is the pre-V5-P4 replay', () => {
    const log = [
      tx('b1', 'buy', 100, 100, '2024-01-10T12:00:00.000Z'),
      tx('b2', 'buy', 100, 200, '2024-03-15T12:00:00.000Z'),
      tx('s1', 'sell', 100, 180, '2024-06-20T12:00:00.000Z'),
      tx('s2', 'sell', 50, 210, '2024-11-05T12:00:00.000Z'),
    ];
    expect(realizedSellsEur(log)).toEqual(realizedSellsEur(log, 'moving-average'));
    // And the average genuinely differs from FIFO on this log (#576 S2).
    expect(realizedSellsEur(log)[0]!.realizedPnlEur).toBe(3000);
    expect(realizedSellsEur(log, 'fifo')[0]!.realizedPnlEur).toBe(8000);
  });

  it('maps tax countries to strategies: DE → fifo, AT/unknown → moving-average', () => {
    expect(costBasisStrategyForCountry(TAX_COUNTRY_DE)).toBe('fifo');
    expect(costBasisStrategyForCountry(TAX_COUNTRY_AT)).toBe('moving-average');
    expect(costBasisStrategyForCountry(null)).toBe('moving-average');
    expect(costBasisStrategyForCountry(undefined)).toBe('moving-average');
  });
});

// ─── Pot classification & guards ──────────────────────────────────────────────

describe('DE pot classification and input guards', () => {
  it('classifies only stocks as Aktien; every other asset type is Sonstige', () => {
    expect(dePotCategoryForAssetType('stock')).toBe('aktien');
    for (const type of ['etf', 'index', 'fx', 'commodity', 'crypto', 'custom']) {
      expect(dePotCategoryForAssetType(type), type).toBe('sonstige');
    }
  });

  it('rejects malformed aggregates and events loudly', () => {
    const base: DeYearAggregates = {
      aktienPotInEur: 0,
      sonstigePotInEur: 0,
      aktienSalePnlEur: 0,
      sonstigeSalePnlEur: 0,
      dividendsEur: 0,
    };
    expect(() => deYearOutcome({ ...base, aktienPotInEur: -1 })).toThrow(TaxComputationError);
    expect(() => deYearOutcome({ ...base, sonstigePotInEur: Number.NaN })).toThrow(
      TaxComputationError,
    );
    expect(() => deYearOutcome({ ...base, dividendsEur: -5 })).toThrow(TaxComputationError);
    const settle = (event: DeTaxableEvent) =>
      settleDeYear({
        aktienPotInEur: 0,
        sonstigePotInEur: 0,
        existingEvents: [],
        heldEur: 0,
        newEvents: [event],
      });
    expect(() => settle({ kind: 'dividend', amountEur: 0 })).toThrow(TaxComputationError);
    expect(() => settle({ kind: 'dividend', amountEur: -10 })).toThrow(TaxComputationError);
    expect(() => settle({ kind: 'sell_gain', category: 'weird' as never, amountEur: 10 })).toThrow(
      TaxComputationError,
    );
    expect(() => settle({ kind: 'nope' as never, amountEur: 10 } as never)).toThrow(
      TaxComputationError,
    );
  });

  it('reconciles held drift as a correction before new events (backdated re-shape)', () => {
    // Existing events target €0 tax (loss year) but €50 is held — e.g. a
    // deleted gain left its withholding behind. The correction refunds it.
    const settlement = settleDeYear({
      aktienPotInEur: 0,
      sonstigePotInEur: 0,
      existingEvents: [{ kind: 'sell_gain', category: 'aktien', amountEur: -400 }],
      heldEur: 50,
      newEvents: [],
    });
    expect(settlement.correctionDeltaEur).toBe(-50);
    expect(settlement.heldAfterEur).toBe(0);
    expect(settlement.yearEnd.aktienPotOutEur).toBe(400);
  });

  it('passes pots through empty years unchanged (indefinite carry, §20 Abs. 6)', () => {
    const lossYear: DeTaxableEvent[] = [
      { kind: 'sell_gain', category: 'aktien', amountEur: -800 },
      { kind: 'sell_gain', category: 'sonstige', amountEur: -300 },
    ];
    expect(deCarryPots([])).toEqual({ aktienEur: 0, sonstigeEur: 0 });
    expect(deCarryPots([lossYear])).toEqual({ aktienEur: 800, sonstigeEur: 300 });
    // An interleaved event-less year changes nothing.
    expect(deCarryPots([lossYear, []])).toEqual({ aktienEur: 800, sonstigeEur: 300 });
  });
});
