import { describe, expect, it } from 'vitest';

import {
  classifyRows,
  KEYWORD_GROUPS,
  NON_TRADE_MARKERS,
  type ClassifiableRow,
  type ClassifiedKind,
} from '../rowClassifier';

/**
 * The stage-2 tables are the module's actual vocabulary, and an alternative no
 * test ever exercises is an alternative nobody has checked. The shipped suite
 * exercised 29 of 44 keyword alternatives; the 15 silent ones are where
 * `veräußerung` sat, matching neither the spelling German exports ship nor the
 * one `'VERÄUSSERUNG'.toLowerCase()` produces.
 *
 * Every test below is driven FROM the exported tables, so a term added to the
 * source without a thought about how it reads is exercised the moment it lands.
 */

function row(overrides: Partial<ClassifiableRow> = {}): ClassifiableRow {
  return {
    text: null,
    kindHint: null,
    quantity: null,
    price: null,
    amount: null,
    symbol: null,
    isin: null,
    ...overrides,
  };
}

/**
 * Amount signs consistent with each kind, so the sign check never fires and the
 * test measures the TABLE rather than the sign rule. `fee`/`tax` are money out.
 */
const CONSISTENT_AMOUNT: Record<string, number> = {
  buy: -500,
  sell: 500,
  dividend: 12.5,
  deposit: 1500,
  withdrawal: -250,
  fee: -4.59,
  tax: -8.14,
};

describe('stage-2 keyword table — every listed alternative is exercised', () => {
  const cases = KEYWORD_GROUPS.flatMap((group) =>
    group.alternatives.map((alternative) => ({ kind: group.kind, alternative })),
  );

  it('lists a non-trivial vocabulary (guards an accidentally emptied table)', () => {
    expect(cases.length).toBeGreaterThanOrEqual(44);
    expect(new Set(KEYWORD_GROUPS.map((group) => group.kind)).size).toBe(KEYWORD_GROUPS.length);
  });

  for (const { kind, alternative } of cases) {
    it(`reads "${alternative}" as ${kind}`, async () => {
      // A trade verb needs instrument evidence to resolve, by design — give the
      // trade cases an ISIN so this measures the table, not the gate.
      const evidence: Partial<ClassifiableRow> =
        kind === 'buy' || kind === 'sell' ? { isin: 'US0378331005' } : {};
      const [result] = await classifyRows([
        row({ text: alternative, amount: CONSISTENT_AMOUNT[kind], ...evidence }),
      ]);
      expect(result!.kind).toBe(kind);
      expect(result!.stage).toBe('keyword');
    });
  }
});

describe('stage-2 keyword table — German spellings all reach the same row', () => {
  /** ä→ae … ß→ss: the spelling German CSV exports actually ship. */
  const expand = (value: string): string =>
    value.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');

  const SPELLINGS: { term: string; kind: ClassifiedKind }[] = [
    { term: 'Veräußerung', kind: 'sell' },
    { term: 'Ausschüttung', kind: 'dividend' },
    { term: 'Gebühr', kind: 'fee' },
    { term: 'Depotgebühr', kind: 'fee' },
    { term: 'Überweisung', kind: 'deposit' },
  ];

  for (const { term, kind } of SPELLINGS) {
    it(`reads ${term} as ${kind} in all three spellings`, async () => {
      // The third spelling is the one an ALL-CAPS export round-trips to:
      // capital ß uppercases to SS, so `'VERÄUSSERUNG'.toLowerCase()` is
      // `veräusserung` — neither the umlaut form nor the ASCII form.
      const spellings = [term, expand(term), term.toUpperCase().toLowerCase()];
      for (const spelling of spellings) {
        const [result] = await classifyRows([
          row({
            text: spelling,
            amount: CONSISTENT_AMOUNT[kind],
            ...(kind === 'sell' ? { isin: 'AT0000123456' } : {}),
          }),
        ]);
        expect(result!.kind, `${term} as ${spelling}`).toBe(kind);
      }
    });
  }
});

describe('non-trade markers — every listed alternative is exercised', () => {
  const cases = NON_TRADE_MARKERS.flatMap((group) =>
    group.alternatives.map((alternative) => ({ id: group.id, alternative })),
  );

  it('covers all four marker families', () => {
    expect(new Set(NON_TRADE_MARKERS.map((group) => group.id))).toEqual(
      new Set(['reversal', 'transfer', 'corporateAction', 'taxAccrual']),
    );
  });

  for (const { id, alternative } of cases) {
    it(`pins a row naming "${alternative}" to a human decision (${id})`, async () => {
      // Full trade shape: if the marker did not fire this row would resolve as
      // an unreviewed buy at 0.95.
      const [result] = await classifyRows([
        row({
          text: `${alternative} Muster Tech AG`,
          quantity: 10,
          price: 152.3,
          amount: -1523,
          isin: 'DE0001234567',
        }),
      ]);
      expect(result!.needsReview).toBe(true);
      expect(result!.kind).not.toBe('buy');
      expect(result!.kind).not.toBe('sell');
      expect(result!.evidence).toContain(`non-trade marker "${alternative}"`);
    });
  }
});
