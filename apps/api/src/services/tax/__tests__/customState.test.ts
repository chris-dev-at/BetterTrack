import { describe, expect, it } from 'vitest';

import {
  AT_AS_CUSTOM_PARAMS,
  settleAtYear,
  type CustomTaxableEvent,
  type CustomTaxParams,
} from '../../../domain/tax';
import {
  customCarryIntoYear,
  customChainSensitive,
  customGroupTargetForYear,
  customGroups,
  customParamsKey,
  customParamsRipple,
  customTargetForYear,
  isCustomDividend,
  isCustomFifoSell,
  isCustomSell,
  mergeCustomEvents,
  parseFrozenCustomParams,
  portfolioHasCustomRows,
  type CustomGroup,
  type CustomRowView,
} from '../customState';
import { divRecord, realizationsBuilder, txRecord, yearOf } from './records';

/**
 * Custom rule-built tax bookkeeping (V5-P4c, #584): rows frozen under distinct
 * parameter sets settle as independent regimes whose per-year targets sum. The
 * suite pins the grouping key, the FIFO/moving-average cost-basis seam, the
 * carry chain across years, and the AT-expressed-as-custom equivalence — all
 * cent-exact, deterministic, no network.
 */

const d = (day: string): Date => new Date(`${day}T12:00:00.000Z`);

/** A parameter set with AT defaults and the given overrides. */
const params = (over: Partial<CustomTaxParams> = {}): CustomTaxParams => ({
  ...AT_AS_CUSTOM_PARAMS,
  ...over,
});

const RATE10_FIFO = params({ ratePct: 10, costBasis: 'fifo' });

function customView(
  transactions: readonly ReturnType<typeof txRecord>[],
  dividendRows: readonly ReturnType<typeof divRecord>[] = [],
): CustomRowView {
  return { transactions, dividendRows, realizationsFor: realizationsBuilder(transactions), yearOf };
}

describe('parseFrozenCustomParams', () => {
  it('parses a valid snapshot and fails loud (with the row id) on a corrupt one', () => {
    expect(parseFrozenCustomParams(AT_AS_CUSTOM_PARAMS, 'r1')).toEqual(AT_AS_CUSTOM_PARAMS);
    expect(() => parseFrozenCustomParams({ ratePct: 999 }, 'r1')).toThrow(/r1/);
    expect(() => parseFrozenCustomParams(null, 'bad-row')).toThrow(/bad-row/);
  });
});

describe('customParamsKey & ripple', () => {
  it('keys identical sets the same and differing sets apart', () => {
    expect(customParamsKey(params())).toBe(customParamsKey(params()));
    expect(customParamsKey(params({ ratePct: 10 }))).not.toBe(customParamsKey(params()));
    expect(customParamsKey(params({ costBasis: 'fifo' }))).not.toBe(customParamsKey(params()));
    expect(customParamsKey(params({ carryForward: true }))).not.toBe(customParamsKey(params()));
  });

  it('flags cross-year state: reset-off OR carry-forward ripples, AT-style does not', () => {
    expect(customParamsRipple(AT_AS_CUSTOM_PARAMS)).toBe(false);
    expect(customParamsRipple(params({ yearReset: false }))).toBe(true);
    expect(customParamsRipple(params({ carryForward: true }))).toBe(true);
  });
});

describe('custom classification', () => {
  it('recognises custom sells/dividends and the FIFO cost-basis flag', () => {
    const atSell = txRecord({
      id: 's',
      side: 'sell',
      taxMode: 'custom',
      taxParams: AT_AS_CUSTOM_PARAMS,
    });
    const fifoSell = txRecord({
      id: 's2',
      side: 'sell',
      taxMode: 'custom',
      taxParams: RATE10_FIFO,
    });
    const div = divRecord({
      id: 'dv',
      grossAmountEur: 1,
      taxMode: 'custom',
      taxParams: AT_AS_CUSTOM_PARAMS,
    });
    expect(isCustomSell(atSell)).toBe(true);
    expect(isCustomSell(txRecord({ id: 'b', side: 'buy', taxMode: 'custom' }))).toBe(false);
    expect(isCustomDividend(div)).toBe(true);
    expect(isCustomFifoSell(fifoSell)).toBe(true);
    expect(isCustomFifoSell(atSell)).toBe(false);
    expect(portfolioHasCustomRows([atSell], [])).toBe(true);
    expect(portfolioHasCustomRows([txRecord({ id: 'x', side: 'sell', taxMode: 'none' })], [])).toBe(
      false,
    );
  });

  it('customChainSensitive fires on active ripple, frozen ripple, or any FIFO row', () => {
    const atSell = txRecord({
      id: 's',
      side: 'sell',
      taxMode: 'custom',
      taxParams: AT_AS_CUSTOM_PARAMS,
    });
    const fifoSell = txRecord({
      id: 's2',
      side: 'sell',
      taxMode: 'custom',
      taxParams: RATE10_FIFO,
    });
    // Only AT-style rows (reset-on, carry-off, moving-average) and no active set.
    expect(customChainSensitive([atSell], [])).toBe(false);
    // A FIFO row is sensitive — any trade can shift its lot consumption.
    expect(customChainSensitive([fifoSell], [])).toBe(true);
    // The ACTIVE set ripples even when every frozen row is AT-style.
    expect(customChainSensitive([atSell], [], params({ yearReset: false }))).toBe(true);
    expect(customChainSensitive([atSell], [], AT_AS_CUSTOM_PARAMS)).toBe(false);
  });
});

describe('customGroups', () => {
  it('splits rows by parameter set and realizes each under its own cost basis', () => {
    const transactions = [
      // Group A (AT, moving-average) on asset a1 → gain 450.
      txRecord({
        id: 'ab',
        side: 'buy',
        quantity: 10,
        price: 100,
        taxMode: 'custom',
        taxParams: AT_AS_CUSTOM_PARAMS,
        assetId: 'a1',
        executedAt: d('2026-01-10'),
      }),
      txRecord({
        id: 'as',
        side: 'sell',
        quantity: 10,
        price: 145,
        taxMode: 'custom',
        taxParams: AT_AS_CUSTOM_PARAMS,
        assetId: 'a1',
        executedAt: d('2026-06-10'),
      }),
      // Group B (rate 10, FIFO) on asset b1 → gain 8000 (FIFO consumes the €100 lot).
      txRecord({
        id: 'bb1',
        side: 'buy',
        quantity: 100,
        price: 100,
        taxMode: 'custom',
        taxParams: RATE10_FIFO,
        assetId: 'b1',
        executedAt: d('2026-01-10'),
      }),
      txRecord({
        id: 'bb2',
        side: 'buy',
        quantity: 100,
        price: 200,
        taxMode: 'custom',
        taxParams: RATE10_FIFO,
        assetId: 'b1',
        executedAt: d('2026-03-10'),
      }),
      txRecord({
        id: 'bs',
        side: 'sell',
        quantity: 100,
        price: 180,
        taxMode: 'custom',
        taxParams: RATE10_FIFO,
        assetId: 'b1',
        executedAt: d('2026-06-10'),
      }),
    ];
    const dividends = [
      divRecord({
        id: 'bdv',
        grossAmountEur: 200,
        taxMode: 'custom',
        taxParams: RATE10_FIFO,
        assetId: 'b1',
        executedAt: d('2026-07-10'),
      }),
    ];
    const groups = customGroups(customView(transactions, dividends));
    const groupA = groups.get(customParamsKey(AT_AS_CUSTOM_PARAMS))!;
    const groupB = groups.get(customParamsKey(RATE10_FIFO))!;
    expect(groups.size).toBe(2);
    expect(groupA.eventsByYear.get(2026)).toEqual([{ kind: 'sell_gain', amountEur: 450 }]);
    // Group B: the FIFO sell (June) then the dividend (July), chronological.
    expect(groupB.eventsByYear.get(2026)).toEqual([
      { kind: 'sell_gain', amountEur: 8000 },
      { kind: 'dividend', amountEur: 200 },
    ]);

    // Each group targets its own component; the year's custom total is the sum.
    expect(customGroupTargetForYear(groupA, 2026)).toBe(123.75); // 27.5 % × 450
    expect(customGroupTargetForYear(groupB, 2026)).toBe(820); // 10 % × 8,200
    expect(customTargetForYear([groupA, groupB], 2026)).toBe(943.75);
  });
});

describe('mergeCustomEvents', () => {
  it('appends pending events per year after the frozen ones', () => {
    const base = new Map<number, readonly CustomTaxableEvent[]>([
      [2026, [{ kind: 'sell_gain', amountEur: 100 }]],
    ]);
    const extra = new Map<number, readonly CustomTaxableEvent[]>([
      [2026, [{ kind: 'dividend', amountEur: 50 }]],
      [2027, [{ kind: 'sell_gain', amountEur: 10 }]],
    ]);
    const merged = mergeCustomEvents(base, extra);
    expect(merged.get(2026)).toEqual([
      { kind: 'sell_gain', amountEur: 100 },
      { kind: 'dividend', amountEur: 50 },
    ]);
    expect(merged.get(2027)).toEqual([{ kind: 'sell_gain', amountEur: 10 }]);
    // The base map is untouched (a fresh copy is returned).
    expect(base.get(2026)).toHaveLength(1);
  });
});

describe('custom carry & targets across years', () => {
  it('AT-expressed-as-custom reproduces the AT year target exactly', () => {
    const group: CustomGroup = {
      key: customParamsKey(AT_AS_CUSTOM_PARAMS),
      params: AT_AS_CUSTOM_PARAMS,
      eventsByYear: new Map([
        [
          2026,
          [
            { kind: 'sell_gain', amountEur: 450 },
            { kind: 'sell_gain', amountEur: -100 },
          ],
        ],
      ]),
    };
    const at = settleAtYear({
      existingGainsEur: [450, -100],
      existingDividendsEur: [],
      heldEur: 0,
      newEvents: [],
    });
    // Both land on 27.5 % × 350 = 96.25.
    expect(customGroupTargetForYear(group, 2026)).toBe(96.25);
    expect(customGroupTargetForYear(group, 2026)).toBe(at.heldAfterEur);
  });

  it('carries a loss pot across years when carryForward is on (DE-pot-style)', () => {
    const p = params({ carryForward: true });
    const group: CustomGroup = {
      key: customParamsKey(p),
      params: p,
      eventsByYear: new Map([
        [2024, [{ kind: 'sell_gain', amountEur: -300 }]],
        [2025, [{ kind: 'dividend', amountEur: 500 }]],
      ]),
    };
    // 2024's €300 loss parks in the pot and enters 2025.
    expect(customCarryIntoYear(p, group.eventsByYear, 2025).potEur).toBe(300);
    expect(customGroupTargetForYear(group, 2024)).toBe(0);
    // 2025's €500 dividend nets to €200 → 27.5 % × 200 = 55.
    expect(customGroupTargetForYear(group, 2025)).toBe(55);
  });
});
