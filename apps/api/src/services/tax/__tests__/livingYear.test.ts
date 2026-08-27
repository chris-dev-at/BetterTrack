import { describe, expect, it } from 'vitest';

import type { UserTaxSettingsRecord } from '../../../data/repositories/taxRepository';
import {
  AT_AS_CUSTOM_PARAMS,
  TAX_COUNTRY_AT,
  TAX_COUNTRY_DE,
  TAX_COUNTRY_FI,
  type CustomTaxParams,
} from '../../../domain/tax';
import {
  isDerivableDividend,
  isDerivableSell,
  liveCountryOf,
  liveDerivableYears,
  liveRegimeOf,
  liveRegimeStrategy,
  settleLiveYears,
  type LiveRegime,
  type LiveYearRowView,
} from '../livingYear';
import {
  categoryOfBuilder,
  divRecord,
  realizationsBuilder,
  taxMovement,
  txRecord,
  yearOf,
} from './records';

/**
 * Living-year tax derivation (#1399): every automatic year follows the same
 * current-regime engine, while manual facts stay literal.
 *
 * Every assertion is a cent-exact figure driven through the REAL engine — the
 * domain settlements behind `settleLiveYears` — with no DB and no network.
 */

const settings = (over: Partial<UserTaxSettingsRecord> = {}): UserTaxSettingsRecord => ({
  mode: 'none',
  country: null,
  manualDefaultAmountEur: null,
  manualDefaultRatePct: null,
  customParams: null,
  ...over,
});

const parseParams = (): CustomTaxParams => AT_AS_CUSTOM_PARAMS;

/** Assemble the row view the derivation runs over from records + an asset-type map. */
function viewOf(
  transactions: LiveYearRowView['transactions'],
  dividendRows: LiveYearRowView['dividendRows'] = [],
  assetType: Record<string, string> = {},
): LiveYearRowView {
  return {
    transactions,
    dividendRows,
    realizationsFor: realizationsBuilder(transactions),
    categoryOf: categoryOfBuilder(assetType),
    yearOf,
  };
}

describe('liveCountryOf', () => {
  it('narrows to a supported engine; legacy null ⇒ AT', () => {
    expect(liveCountryOf('DE')).toBe(TAX_COUNTRY_DE);
    expect(liveCountryOf('FI')).toBe(TAX_COUNTRY_FI);
    expect(liveCountryOf('AT')).toBe(TAX_COUNTRY_AT);
    expect(liveCountryOf(null)).toBe(TAX_COUNTRY_AT);
  });

  it('fails LOUD on an unwired country instead of silently running the AT engine (#669)', () => {
    expect(() => liveCountryOf('US')).toThrow(/no live engine/);
  });
});

describe('liveRegimeOf', () => {
  it('maps each mode to its live regime', () => {
    expect(liveRegimeOf(settings({ mode: 'none' }), parseParams)).toEqual({ kind: 'none' });
    expect(liveRegimeOf(settings({ mode: 'manual_per_trade' }), parseParams)).toEqual({
      kind: 'manual',
    });
    expect(
      liveRegimeOf(settings({ mode: 'country_specific', country: 'DE' }), parseParams),
    ).toEqual({ kind: 'country', country: TAX_COUNTRY_DE });
    // A legacy country_specific row with no country still resolves to AT.
    expect(
      liveRegimeOf(settings({ mode: 'country_specific', country: null }), parseParams),
    ).toEqual({ kind: 'country', country: TAX_COUNTRY_AT });
    expect(liveRegimeOf(settings({ mode: 'custom' }), parseParams)).toEqual({
      kind: 'custom',
      params: AT_AS_CUSTOM_PARAMS,
    });
  });
});

describe('liveRegimeStrategy', () => {
  it('picks the cost basis each regime realizes sells under', () => {
    expect(liveRegimeStrategy({ kind: 'country', country: TAX_COUNTRY_AT })).toBe('moving-average');
    expect(liveRegimeStrategy({ kind: 'country', country: TAX_COUNTRY_DE })).toBe('fifo');
    expect(liveRegimeStrategy({ kind: 'country', country: TAX_COUNTRY_FI })).toBe('fifo');
    expect(liveRegimeStrategy({ kind: 'custom', params: AT_AS_CUSTOM_PARAMS })).toBe(
      'moving-average',
    );
    expect(
      liveRegimeStrategy({
        kind: 'custom',
        params: { ...AT_AS_CUSTOM_PARAMS, costBasis: 'fifo' },
      }),
    ).toBe('fifo');
    expect(liveRegimeStrategy({ kind: 'none' })).toBeNull();
    expect(liveRegimeStrategy({ kind: 'manual' })).toBeNull();
  });
});

describe('isDerivableSell / isDerivableDividend', () => {
  it('everything but a manual fact participates in derivation', () => {
    expect(isDerivableSell(txRecord({ id: 's', side: 'sell', taxMode: 'country_specific' }))).toBe(
      true,
    );
    // A `none`-frozen sell IS derivable — this is what lets a mode switch heal it.
    expect(isDerivableSell(txRecord({ id: 's', side: 'sell', taxMode: 'none' }))).toBe(true);
    expect(isDerivableSell(txRecord({ id: 'b', side: 'buy', taxMode: 'country_specific' }))).toBe(
      false,
    );
    expect(isDerivableSell(txRecord({ id: 's', side: 'sell', taxMode: 'manual_per_trade' }))).toBe(
      false,
    );
    expect(isDerivableDividend(divRecord({ id: 'd', grossAmountEur: 10, taxMode: 'none' }))).toBe(
      true,
    );
    expect(
      isDerivableDividend(divRecord({ id: 'd', grossAmountEur: 10, taxMode: 'manual_per_trade' })),
    ).toBe(false);
  });
});

describe('liveDerivableYears', () => {
  it('collects derivable rows and unattached corrections from every year', () => {
    const transactions = [
      txRecord({ id: 's-old', side: 'sell', executedAt: new Date('2024-06-10T10:00:00Z') }),
      txRecord({ id: 's-live', side: 'sell', executedAt: new Date('2026-06-10T10:00:00Z') }),
      txRecord({
        id: 's-manual',
        side: 'sell',
        taxMode: 'manual_per_trade',
        executedAt: new Date('2027-06-10T10:00:00Z'),
      }),
    ];
    const dividendRows = [
      divRecord({ id: 'd', grossAmountEur: 5, executedAt: new Date('2025-06-10T10:00:00Z') }),
    ];
    const movements = [
      // An unattached correction with no surviving rows still keeps its year live.
      taxMovement({ id: 'm1', kind: 'tax_refund', amountEur: 10, taxYear: 2028 }),
      taxMovement({ id: 'm2', kind: 'tax_withholding', amountEur: -5, taxYear: 2023 }),
      // An attached movement (belongs to a row) is not a standalone year signal.
      taxMovement({
        id: 'm3',
        kind: 'tax_withholding',
        amountEur: -5,
        taxYear: 2029,
        transactionId: 's-live',
      }),
    ];
    expect(liveDerivableYears({ transactions, dividendRows, yearOf }, movements)).toEqual([
      2023, 2024, 2025, 2026, 2028,
    ]);
  });
});

// ─── AT: intra-year loss offset, refund of tax already paid, hard Jan-1 reset ──

describe('settleLiveYears — AT (flat KESt)', () => {
  const atRegime: LiveRegime = { kind: 'country', country: TAX_COUNTRY_AT };

  it('taxes a later year in full despite a prior-year loss (hard Jan-1 reset, no carry)', () => {
    const transactions = [
      txRecord({ id: 'b1', side: 'buy', quantity: 10, price: 100, executedAt: d('2025-02-10') }),
      txRecord({ id: 's1', side: 'sell', quantity: 10, price: 80, executedAt: d('2025-06-10') }),
      txRecord({ id: 'b2', side: 'buy', quantity: 10, price: 100, executedAt: d('2026-02-10') }),
      txRecord({ id: 's2', side: 'sell', quantity: 10, price: 145, executedAt: d('2026-06-10') }),
    ];
    const results = settleLiveYears({
      regime: atRegime,
      view: viewOf(transactions),
      years: [2026, 2025], // any order in → ascending out
      heldOf: () => 0,
    });
    expect(results.map((r) => r.year)).toEqual([2025, 2026]);
    // 2025 nets −200 → €0 target; 2026's +450 gain is taxed in full at 27.5 %
    // (nothing held yet, so the whole 123.75 posts as the year's correction) —
    // the 2025 loss never reaches it: no cross-year carry.
    expect(results[0]).toMatchObject({ year: 2025, correctionDeltaEur: 0, targetAfterEur: 0 });
    expect(results[1]).toMatchObject({
      year: 2026,
      correctionDeltaEur: 123.75,
      targetAfterEur: 123.75,
    });
  });

  it('refunds tax already paid when a same-year loss shrinks the pool', () => {
    // +450 gain (June, taxed 123.75) then −100 loss (Sept): net 350 pool.
    const transactions = [
      txRecord({ id: 'b1', side: 'buy', quantity: 10, price: 100, executedAt: d('2026-01-10') }),
      txRecord({ id: 's1', side: 'sell', quantity: 10, price: 145, executedAt: d('2026-06-10') }),
      txRecord({ id: 'b2', side: 'buy', quantity: 10, price: 100, executedAt: d('2026-08-10') }),
      txRecord({ id: 's2', side: 'sell', quantity: 10, price: 90, executedAt: d('2026-09-10') }),
    ];
    const [result] = settleLiveYears({
      regime: atRegime,
      view: viewOf(transactions),
      years: [2026],
      heldOf: (year) => (year === 2026 ? 123.75 : 0),
    });
    // Target 27.5 % × 350 = 96.25; the €27.50 over-withheld refunds as a correction.
    expect(result!.correctionDeltaEur).toBe(-27.5);
    expect(result!.targetAfterEur).toBe(96.25);
  });

  it('taxes a new dividend into the same pool with a marginal delta', () => {
    const transactions = [
      txRecord({ id: 'b1', side: 'buy', quantity: 10, price: 100, executedAt: d('2026-01-10') }),
      txRecord({ id: 's1', side: 'sell', quantity: 10, price: 145, executedAt: d('2026-06-10') }),
    ];
    const [result] = settleLiveYears({
      regime: atRegime,
      view: viewOf(transactions),
      years: [2026],
      heldOf: (year) => (year === 2026 ? 123.75 : 0),
      newEventsByYear: new Map([[2026, [{ kind: 'dividend', amountEur: 100 }]]]),
    });
    // Pool 450 → 550; 27.5 % × 550 = 151.25, so the dividend withholds 27.50.
    expect(result!.correctionDeltaEur).toBe(0);
    expect(result!.newEventDeltasEur).toEqual([27.5]);
    expect(result!.targetAfterEur).toBe(151.25);
  });

  it('floors the tax to whole cents (#370 — never rounds up)', () => {
    const transactions = [
      txRecord({ id: 'b1', side: 'buy', quantity: 1, price: 100, executedAt: d('2026-01-10') }),
      txRecord({
        id: 's1',
        side: 'sell',
        quantity: 1,
        price: 133.33,
        executedAt: d('2026-06-10'),
      }),
    ];
    // 27.5 % × 33.33 = 9.16575 → floors to 9.16.
    const [result] = settleLiveYears({
      regime: atRegime,
      view: viewOf(transactions),
      years: [2026],
      heldOf: () => 0,
    });
    expect(result!.correctionDeltaEur).toBe(9.16);
    expect(result!.targetAfterEur).toBe(9.16);
  });
});

// ─── FI: progressive pääomatulovero over the living-year pool ─────────────────

describe('settleLiveYears — FI (progressive)', () => {
  it('taxes 30 % to €30k and 34 % above via the FIFO-realized pool', () => {
    const transactions = [
      txRecord({
        id: 'b1',
        side: 'buy',
        quantity: 1,
        price: 10_000,
        taxCountry: 'FI',
        executedAt: d('2026-01-10'),
      }),
      txRecord({
        id: 's1',
        side: 'sell',
        quantity: 1,
        price: 50_000,
        taxCountry: 'FI',
        executedAt: d('2026-06-10'),
      }),
    ];
    const [result] = settleLiveYears({
      regime: { kind: 'country', country: TAX_COUNTRY_FI },
      view: viewOf(transactions),
      years: [2026],
      heldOf: () => 0,
    });
    // 40,000 gain → 30 % × 30,000 + 34 % × 10,000 = 12,400.
    expect(result!.correctionDeltaEur).toBe(12_400);
    expect(result!.targetAfterEur).toBe(12_400);
  });
});

// ─── Mode switches re-derive every documented year (#1399) ────────────────────

describe('settleLiveYears — mode-switch healing (#341)', () => {
  it('re-taxes a previously untaxed sell after a switch to AT', () => {
    // Both rows were frozen while the setting was `none`, so nothing was ever
    // withheld — yet the P/L exists. Switching to AT re-derives the year.
    const transactions = [
      txRecord({
        id: 'b1',
        side: 'buy',
        quantity: 10,
        price: 100,
        taxMode: 'none',
        taxCountry: null,
        executedAt: d('2026-01-10'),
      }),
      txRecord({
        id: 's1',
        side: 'sell',
        quantity: 10,
        price: 200,
        taxMode: 'none',
        taxCountry: null,
        executedAt: d('2026-06-10'),
      }),
    ];
    const [result] = settleLiveYears({
      regime: { kind: 'country', country: TAX_COUNTRY_AT },
      view: viewOf(transactions),
      years: [2026],
      heldOf: () => 0, // `none` froze €0 of tax
    });
    // €1,000 gain now enters the AT pool: 27.5 % × 1,000 = 275 withheld via the
    // self-healing correction — no new event, purely a re-derivation.
    expect(result!.correctionDeltaEur).toBe(275);
    expect(result!.targetAfterEur).toBe(275);
  });

  it('a switch TO `none` refunds every euro of engine-held tax', () => {
    const transactions = [
      txRecord({ id: 'b1', side: 'buy', quantity: 10, price: 100, executedAt: d('2026-01-10') }),
      txRecord({ id: 's1', side: 'sell', quantity: 10, price: 145, executedAt: d('2026-06-10') }),
    ];
    const [result] = settleLiveYears({
      regime: { kind: 'none' },
      view: viewOf(transactions),
      years: [2026],
      heldOf: (year) => (year === 2026 ? 123.75 : 0),
      newEventsByYear: new Map([[2026, [{ kind: 'dividend', amountEur: 100 }]]]),
    });
    // The engine has no claim under `none`: target 0, the 123.75 refunds, and a
    // concurrent new event contributes nothing.
    expect(result!.correctionDeltaEur).toBe(-123.75);
    expect(result!.newEventDeltasEur).toEqual([0]);
    expect(result!.targetAfterEur).toBe(0);
  });
});

// ─── DE: dual pots + allowance through the live derivation ────────────────────

describe('settleLiveYears — DE (Abgeltungsteuer + Soli)', () => {
  const deRegime: LiveRegime = { kind: 'country', country: TAX_COUNTRY_DE };

  it('derives allowance, base, KapESt and Soli for a documented year', () => {
    const transactions = [
      txRecord({
        id: 'b1',
        side: 'buy',
        quantity: 10,
        price: 100,
        taxCountry: 'DE',
        assetId: 'stk',
        executedAt: d('2026-01-10'),
      }),
      txRecord({
        id: 's1',
        side: 'sell',
        quantity: 10,
        price: 300,
        taxCountry: 'DE',
        assetId: 'stk',
        executedAt: d('2026-06-10'),
      }),
    ];
    const dividends = [
      divRecord({
        id: 'd1',
        grossAmountEur: 500,
        taxCountry: 'DE',
        assetId: 'fund',
        executedAt: d('2026-07-10'),
      }),
    ];
    const [result] = settleLiveYears({
      regime: deRegime,
      view: viewOf(transactions, dividends, { stk: 'stock', fund: 'etf' }),
      years: [2026],
      heldOf: () => 0,
    });
    // Aktien gain 2,000 + Sonstige dividend 500 = 2,500; − €1,000 allowance =
    // base 1,500 → KapESt 375 + Soli 20.62 = 395.62.
    expect(result!.correctionDeltaEur).toBe(395.62);
    expect(result!.targetAfterEur).toBe(395.62);
    expect(result!.deState?.outcome.allowanceUsedEur).toBe(1000);
    expect(result!.deState?.outcome.kapestEur).toBe(375);
    expect(result!.deState?.outcome.soliEur).toBe(20.62);
    expect(result!.deState?.outcome.totalTaxEur).toBe(395.62);
  });

  it('chains loss pots through earlier living years', () => {
    const transactions = [
      txRecord({
        id: 'b0',
        side: 'buy',
        quantity: 10,
        price: 100,
        taxCountry: 'DE',
        assetId: 'stk',
        executedAt: d('2024-01-10'),
      }),
      txRecord({
        id: 's0',
        side: 'sell',
        quantity: 10,
        price: 20,
        taxCountry: 'DE',
        assetId: 'stk',
        executedAt: d('2024-06-10'),
      }),
      txRecord({
        id: 'b1',
        side: 'buy',
        quantity: 10,
        price: 100,
        taxCountry: 'DE',
        assetId: 'stk',
        executedAt: d('2025-01-10'),
      }),
      txRecord({
        id: 's1',
        side: 'sell',
        quantity: 10,
        price: 350,
        taxCountry: 'DE',
        assetId: 'stk',
        executedAt: d('2025-06-10'),
      }),
    ];
    const [, result] = settleLiveYears({
      regime: deRegime,
      view: viewOf(transactions, [], { stk: 'stock' }),
      years: [2024, 2025],
      heldOf: () => 0,
    });
    // 2024's €800 Aktien loss carries in and offsets 2025's €2,500 gain → 1,700;
    // − €1,000 allowance = base 700 → KapESt 175 + Soli 9.62 = 184.62.
    expect(result!.deState?.potIns.aktienEur).toBe(800);
    expect(result!.correctionDeltaEur).toBe(184.62);
    expect(result!.targetAfterEur).toBe(184.62);
  });
});

// ─── Custom: the parameterized regime through the live derivation ──────────────

describe('settleLiveYears — custom regime', () => {
  it('AT_AS_CUSTOM_PARAMS reproduces the AT living-year target', () => {
    const transactions = [
      txRecord({
        id: 'b1',
        side: 'buy',
        quantity: 10,
        price: 100,
        taxMode: 'custom',
        executedAt: d('2026-01-10'),
      }),
      txRecord({
        id: 's1',
        side: 'sell',
        quantity: 10,
        price: 145,
        taxMode: 'custom',
        executedAt: d('2026-06-10'),
      }),
    ];
    const [result] = settleLiveYears({
      regime: { kind: 'custom', params: AT_AS_CUSTOM_PARAMS },
      view: viewOf(transactions),
      years: [2026],
      heldOf: () => 0,
    });
    expect(result!.correctionDeltaEur).toBe(123.75);
    expect(result!.targetAfterEur).toBe(123.75);
  });

  it('carries a loss pot through earlier living years when carryForward is on', () => {
    const params: CustomTaxParams = { ...AT_AS_CUSTOM_PARAMS, carryForward: true };
    const transactions = [
      txRecord({
        id: 'b0',
        side: 'buy',
        quantity: 10,
        price: 100,
        taxMode: 'custom',
        executedAt: d('2024-01-10'),
      }),
      txRecord({
        id: 's0',
        side: 'sell',
        quantity: 10,
        price: 70,
        taxMode: 'custom',
        executedAt: d('2024-06-10'),
      }),
    ];
    const dividends = [
      divRecord({
        id: 'd1',
        grossAmountEur: 500,
        taxMode: 'custom',
        executedAt: d('2025-07-10'),
      }),
    ];
    const [, result] = settleLiveYears({
      regime: { kind: 'custom', params },
      view: viewOf(transactions, dividends),
      years: [2024, 2025],
      heldOf: () => 0,
    });
    // 2024's €300 loss parks in the pot; 2025's €500 dividend nets to €200 →
    // 27.5 % × 200 = 55.
    expect(result!.correctionDeltaEur).toBe(55);
    expect(result!.targetAfterEur).toBe(55);
  });
});

describe('settleLiveYears — no years', () => {
  it('returns nothing when there are no years to settle', () => {
    expect(
      settleLiveYears({
        regime: { kind: 'none' },
        view: viewOf([]),
        years: [],
        heldOf: () => 0,
      }),
    ).toEqual([]);
  });
});

/** ISO instant at noon UTC on the given day — a clean mid-Vienna-day timestamp. */
function d(day: string): Date {
  return new Date(`${day}T12:00:00.000Z`);
}
