import { describe, expect, it } from 'vitest';

import {
  TAX_COUNTRY_AT,
  TAX_COUNTRY_DE,
  TAX_COUNTRY_FI,
  type DeTaxableEvent,
} from '../../../domain/tax';
import {
  deEventsByYear,
  deYearStateForYear,
  isDeDividend,
  isDeSell,
  portfolioHasDeRows,
  portfolioHasFiRows,
  rowEngineCountry,
  type DeRowView,
} from '../countryState';
import { categoryOfBuilder, divRecord, realizationsBuilder, txRecord, yearOf } from './records';

/**
 * Per-country tax bookkeeping (V5-P4/#635): country routing, DE FIFO
 * realizations, ring-fenced loss pots, and cross-year carry — all cent-exact,
 * deterministic, and network-free.
 */

const d = (day: string): Date => new Date(`${day}T12:00:00.000Z`);

/** Assemble the DE row view from records with a FIFO realizations map + types. */
function deView(
  transactions: readonly ReturnType<typeof txRecord>[],
  dividendRows: readonly ReturnType<typeof divRecord>[] = [],
  assetType: Record<string, string> = {},
): DeRowView {
  return {
    transactions,
    dividendRows,
    deRealizations: realizationsBuilder(transactions)('fifo'),
    categoryOf: categoryOfBuilder(assetType),
    yearOf,
  };
}

describe('rowEngineCountry', () => {
  it('maps DE/FI to themselves and legacy null/AT to AT', () => {
    expect(rowEngineCountry('DE')).toBe(TAX_COUNTRY_DE);
    expect(rowEngineCountry('FI')).toBe(TAX_COUNTRY_FI);
    expect(rowEngineCountry('AT')).toBe(TAX_COUNTRY_AT);
    expect(rowEngineCountry(null)).toBe(TAX_COUNTRY_AT);
  });

  it('fails LOUD on an unwired country instead of falling through to the AT pool (#669)', () => {
    expect(() => rowEngineCountry('US')).toThrow(/no settlement component/);
  });
});

describe('country-specific classification', () => {
  it('routes rows to the retained country engines', () => {
    const deSell = txRecord({ id: 's', side: 'sell', taxCountry: 'DE' });
    const fiSell = txRecord({ id: 's', side: 'sell', taxCountry: 'FI' });
    const atSell = txRecord({ id: 's', side: 'sell', taxCountry: 'AT' });
    expect(isDeSell(deSell)).toBe(true);
    expect(isDeSell(atSell)).toBe(false);

    const deDiv = divRecord({ id: 'd', grossAmountEur: 1, taxCountry: 'DE' });
    const fiDiv = divRecord({ id: 'd', grossAmountEur: 1, taxCountry: 'FI' });
    expect(isDeDividend(deDiv)).toBe(true);
    expect(isDeDividend(fiDiv)).toBe(false);

    expect(portfolioHasDeRows([deSell], [])).toBe(true);
    expect(portfolioHasDeRows([atSell], [fiDiv])).toBe(false);
    expect(portfolioHasFiRows([fiSell], [])).toBe(true);
    expect(portfolioHasFiRows([], [fiDiv])).toBe(true);
    expect(portfolioHasFiRows([deSell], [deDiv])).toBe(false);
  });
});

describe('deEventsByYear', () => {
  it('buckets sells (FIFO gain + pot category) and dividends per Vienna year', () => {
    const transactions = [
      txRecord({
        id: 'b',
        side: 'buy',
        quantity: 10,
        price: 100,
        taxCountry: 'DE',
        assetId: 'stk',
        executedAt: d('2026-01-10'),
      }),
      txRecord({
        id: 's',
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
        id: 'dv',
        grossAmountEur: 500,
        taxCountry: 'DE',
        assetId: 'fund',
        executedAt: d('2026-07-10'),
      }),
    ];
    const byYear = deEventsByYear(deView(transactions, dividends, { stk: 'stock', fund: 'etf' }));
    expect(byYear.get(2026)).toEqual([
      { kind: 'sell_gain', category: 'aktien', amountEur: 2000 },
      { kind: 'dividend', amountEur: 500 },
    ]);
  });

  it('realizes DE sells per FIFO — never the moving average — and merges pending events', () => {
    const transactions = [
      txRecord({
        id: 'b1',
        side: 'buy',
        quantity: 100,
        price: 100,
        taxCountry: 'DE',
        assetId: 'stk',
        executedAt: d('2026-01-10'),
      }),
      txRecord({
        id: 'b2',
        side: 'buy',
        quantity: 100,
        price: 200,
        taxCountry: 'DE',
        assetId: 'stk',
        executedAt: d('2026-03-10'),
      }),
      txRecord({
        id: 's1',
        side: 'sell',
        quantity: 100,
        price: 180,
        taxCountry: 'DE',
        assetId: 'stk',
        executedAt: d('2026-06-10'),
      }),
    ];
    // FIFO consumes the €100 lot → 8,000; the moving average (basis 150) is 3,000.
    expect(realizationsBuilder(transactions)('fifo').get('s1')!.realizedPnlEur).toBe(8000);
    expect(realizationsBuilder(transactions)('moving-average').get('s1')!.realizedPnlEur).toBe(
      3000,
    );

    const extra = new Map<number, readonly DeTaxableEvent[]>([
      [2026, [{ kind: 'dividend', amountEur: 200 }]],
    ]);
    const byYear = deEventsByYear(deView(transactions, [], { stk: 'stock' }), extra);
    expect(byYear.get(2026)).toEqual([
      { kind: 'sell_gain', category: 'aktien', amountEur: 8000 },
      { kind: 'dividend', amountEur: 200 },
    ]);
  });
});

describe('DE year outcome — ring-fence, cross-offset, allowance', () => {
  it('ring-fences an Aktien loss: it carries as a pot, never offsetting dividend income', () => {
    // Aktien loss −500, Sonstige dividend 1,000 in the same year.
    const transactions = [
      txRecord({
        id: 'b',
        side: 'buy',
        quantity: 5,
        price: 200,
        taxCountry: 'DE',
        assetId: 'stk',
        executedAt: d('2026-01-10'),
      }),
      txRecord({
        id: 's',
        side: 'sell',
        quantity: 5,
        price: 100,
        taxCountry: 'DE',
        assetId: 'stk',
        executedAt: d('2026-06-10'),
      }),
    ];
    const dividends = [
      divRecord({
        id: 'dv',
        grossAmountEur: 1000,
        taxCountry: 'DE',
        assetId: 'fund',
        executedAt: d('2026-07-10'),
      }),
    ];
    const byYear = deEventsByYear(deView(transactions, dividends, { stk: 'stock', fund: 'etf' }));
    const { outcome } = deYearStateForYear(byYear, 2026);
    // The €500 Aktien loss cannot touch the dividend — it parks in the Aktien
    // pot; the €1,000 dividend is fully absorbed by the allowance → €0 tax.
    expect(outcome.aktienPotOutEur).toBe(500);
    expect(outcome.sonstigePotOutEur).toBe(0);
    expect(outcome.allowanceUsedEur).toBe(1000);
    expect(outcome.totalTaxEur).toBe(0);
  });

  it('lets a Sonstige loss offset an Aktien gain, then applies the allowance after', () => {
    // Aktien gain +2,000, Sonstige sale loss −800.
    const transactions = [
      txRecord({
        id: 'ab',
        side: 'buy',
        quantity: 10,
        price: 100,
        taxCountry: 'DE',
        assetId: 'stk',
        executedAt: d('2026-01-10'),
      }),
      txRecord({
        id: 'as',
        side: 'sell',
        quantity: 10,
        price: 300,
        taxCountry: 'DE',
        assetId: 'stk',
        executedAt: d('2026-06-10'),
      }),
      txRecord({
        id: 'sb',
        side: 'buy',
        quantity: 10,
        price: 100,
        taxCountry: 'DE',
        assetId: 'fund',
        executedAt: d('2026-02-10'),
      }),
      txRecord({
        id: 'ss',
        side: 'sell',
        quantity: 10,
        price: 20,
        taxCountry: 'DE',
        assetId: 'fund',
        executedAt: d('2026-07-10'),
      }),
    ];
    const byYear = deEventsByYear(deView(transactions, [], { stk: 'stock', fund: 'etf' }));
    const { outcome } = deYearStateForYear(byYear, 2026);
    // 2,000 − 800 cross-offset = 1,200; − €1,000 allowance = base 200 →
    // KapESt 50 + Soli 2.75 = 52.75. Both pots empty (the loss was consumed).
    expect(outcome.taxableBaseEur).toBe(200);
    expect(outcome.kapestEur).toBe(50);
    expect(outcome.soliEur).toBe(2.75);
    expect(outcome.totalTaxEur).toBe(52.75);
    expect(outcome.aktienPotOutEur).toBe(0);
    expect(outcome.sonstigePotOutEur).toBe(0);
  });

  it('applies the €1,000 allowance to income NET of a same-pot loss (never the gross)', () => {
    // Sonstige dividends 1,800, Sonstige sale loss −300 → net 1,500.
    const transactions = [
      txRecord({
        id: 'b',
        side: 'buy',
        quantity: 10,
        price: 50,
        taxCountry: 'DE',
        assetId: 'fund',
        executedAt: d('2026-01-10'),
      }),
      txRecord({
        id: 's',
        side: 'sell',
        quantity: 10,
        price: 20,
        taxCountry: 'DE',
        assetId: 'fund',
        executedAt: d('2026-06-10'),
      }),
    ];
    const dividends = [
      divRecord({
        id: 'dv',
        grossAmountEur: 1800,
        taxCountry: 'DE',
        assetId: 'fund',
        executedAt: d('2026-07-10'),
      }),
    ];
    const byYear = deEventsByYear(deView(transactions, dividends, { fund: 'etf' }));
    const { outcome } = deYearStateForYear(byYear, 2026);
    // Base = 1,500 − 1,000 = 500 (NOT 1,800 − 1,000): KapESt 125 + Soli 6.87.
    expect(outcome.allowanceUsedEur).toBe(1000);
    expect(outcome.allowanceRemainingEur).toBe(0);
    expect(outcome.taxableBaseEur).toBe(500);
    expect(outcome.kapestEur).toBe(125);
    expect(outcome.soliEur).toBe(6.87);
    expect(outcome.totalTaxEur).toBe(131.87);
  });
});

describe('DE loss-pot carry across years', () => {
  it('carries an Aktien loss forward and offsets a later gain (§20 Abs. 6)', () => {
    const transactions = [
      // 2024: Aktien loss −800.
      txRecord({
        id: 'b24',
        side: 'buy',
        quantity: 10,
        price: 100,
        taxCountry: 'DE',
        assetId: 'stk',
        executedAt: d('2024-01-10'),
      }),
      txRecord({
        id: 's24',
        side: 'sell',
        quantity: 10,
        price: 20,
        taxCountry: 'DE',
        assetId: 'stk',
        executedAt: d('2024-06-10'),
      }),
      // 2025: Aktien gain +2,500.
      txRecord({
        id: 'b25',
        side: 'buy',
        quantity: 10,
        price: 100,
        taxCountry: 'DE',
        assetId: 'stk',
        executedAt: d('2025-01-10'),
      }),
      txRecord({
        id: 's25',
        side: 'sell',
        quantity: 10,
        price: 350,
        taxCountry: 'DE',
        assetId: 'stk',
        executedAt: d('2025-06-10'),
      }),
    ];
    const byYear = deEventsByYear(deView(transactions, [], { stk: 'stock' }));
    expect(deYearStateForYear(byYear, 2024).outcome.totalTaxEur).toBe(0);
    // The €800 loss enters 2025 as its Aktien pot-in.
    expect(deYearStateForYear(byYear, 2025).potIns).toEqual({ aktienEur: 800, sonstigeEur: 0 });
    // 2,500 − 800 = 1,700; − €1,000 allowance = base 700 → KapESt 175 + Soli 9.62.
    expect(deYearStateForYear(byYear, 2025).outcome.totalTaxEur).toBe(184.62);
    expect(deYearStateForYear(byYear, 2025).potIns.aktienEur).toBe(800);
  });
});
