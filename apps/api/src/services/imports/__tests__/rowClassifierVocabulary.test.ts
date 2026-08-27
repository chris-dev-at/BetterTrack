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
 * This file has THREE jobs, and it used to do only the first:
 *
 * 1. **Recall, driven from the tables.** Every alternative is exercised the
 *    moment it lands, without anyone remembering to write a case for it.
 * 2. **The tables themselves, pinned literally** ({@link
 *    EXPECTED_KEYWORD_VOCABULARY}). Generating the cases FROM the constants
 *    means DELETING a term deletes its test instead of failing it: a mutation
 *    that dropped two terms took the suite from 463 tests to 461 and stayed
 *    green, because the only floor was a `toBeGreaterThanOrEqual(44)` sitting
 *    seven below the 51 terms that actually existed. A vocabulary is a
 *    contract; it is written out here in full, so removing a word is a diff a
 *    reviewer reads, not a test that quietly stops existing.
 * 3. **Negative space** — see the bottom half. Every regression the last two
 *    fix rounds shipped was a term that matched MORE than it was meant to, and
 *    a recall-only suite cannot see one: `ertrag` was added to fix
 *    `Ertragsgutschrift` and silently ate `Übertrag`, `Zinsertrag` and
 *    `Vertrag`; `fusion` and `split` ate `Diffusion`, `Infusion` and `Splitit`.
 *    Both passed every recall test in this file on the day they shipped.
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

// --- The tables, written out ------------------------------------------------

/**
 * The stage-2 vocabulary, verbatim and in table order. Order IS semantics here
 * (first match wins, `verkauf` before `kauf`, cost markers before direction
 * verbs, dividends before deposits), so this pins the sequence, not a set.
 */
const EXPECTED_KEYWORD_VOCABULARY: readonly (readonly [ClassifiedKind, readonly string[]])[] = [
  ['tax', ['kapitalertragsteuer', 'ertragsteuer', 'quellensteuer', 'withholding', 'kest']],
  [
    'fee',
    [
      'depotgebuehr',
      'depotgebuhr',
      'gebuehr',
      'gebuhr',
      'provision',
      'entgelt',
      'commission',
      'accountfee',
      'managementfee',
      'mgmtfee',
      'custodyfee',
      'servicefee',
      'platformfee',
      'transactionfee',
      'brokeragefee',
      'charge',
      'fee',
    ],
  ],
  ['sell', ['verkauf', 'veraeusserung', 'verausserung', 'disposal', 'sell', 'sale', 'sold']],
  ['buy', ['sparplan', 'purchase', 'kauf', 'buy']],
  [
    'dividend',
    [
      'ertragsgutschrift',
      'kapitalertrag',
      'ertrag',
      'dividende',
      'dividend',
      'ausschuettung',
      'ausschuttung',
      'distribution',
      'coupon',
    ],
  ],
  [
    'deposit',
    [
      'zinsgutschrift',
      'zinsertrag',
      'zinsen',
      'interest',
      'einzahlung',
      'zahlungseingang',
      'ueberweisung',
      'uberweisung',
      'gutschrift',
      'deposit',
      'credit',
      'top-up',
      'topup',
    ],
  ],
  ['withdrawal', ['auszahlung', 'lastschrift', 'belastung', 'abbuchung', 'withdrawal', 'debit']],
];

/** The non-trade markers, verbatim and in scan order. */
const EXPECTED_MARKER_VOCABULARY: readonly (readonly [string, readonly string[]])[] = [
  [
    'reversal',
    [
      'stornierung',
      'stornobuchung',
      'storno',
      'rueckbuchung',
      'ruckbuchung',
      'cancellation',
      'cancelled',
      'canceled',
      'reversal',
    ],
  ],
  [
    'transfer',
    [
      'depotuebertrag',
      'depotubertrag',
      'depoteingang',
      'depotausgang',
      'einbuchung',
      'ausbuchung',
      'einlieferung',
      'auslieferung',
    ],
  ],
  [
    'corporateAction',
    [
      'kapitalmassnahme',
      'corporate action',
      'umtausch',
      'fusion',
      'merger',
      'aktiensplit',
      'split',
    ],
  ],
  ['taxAccrual', ['vorabpauschale', 'thesaurierung', 'thesaurierend']],
];

describe('the vocabulary is a contract, not whatever the source happens to say', () => {
  it('pins every stage-2 term, in table order', () => {
    // Deep equality, not a count and not a subset: adding a term fails here
    // (write it down), and so does REMOVING one — which a test generated from
    // the constants cannot do, because the case disappears with the term.
    expect(KEYWORD_GROUPS.map((group) => [group.kind, [...group.alternatives]])).toEqual(
      EXPECTED_KEYWORD_VOCABULARY.map(([kind, alternatives]) => [kind, [...alternatives]]),
    );
  });

  it('pins every non-trade marker term, in scan order', () => {
    expect(NON_TRADE_MARKERS.map((group) => [group.id, [...group.alternatives]])).toEqual(
      EXPECTED_MARKER_VOCABULARY.map(([id, alternatives]) => [id, [...alternatives]]),
    );
  });

  it('states the exact vocabulary size (a floor seven terms low hid a mutation)', () => {
    const keywordTerms = KEYWORD_GROUPS.flatMap((group) => group.alternatives);
    const markerTerms = NON_TRADE_MARKERS.flatMap((group) => group.alternatives);
    expect(keywordTerms).toHaveLength(61);
    expect(markerTerms).toHaveLength(27);
    // No term may appear twice in the keyword table: a duplicate in a LATER
    // group is dead (first match wins) and reads as coverage that is not there.
    expect(new Set(keywordTerms).size).toBe(keywordTerms.length);
    expect(new Set(markerTerms).size).toBe(markerTerms.length);
    expect(new Set(KEYWORD_GROUPS.map((group) => group.kind)).size).toBe(KEYWORD_GROUPS.length);
  });
});

describe('stage-2 keyword table — every listed alternative is exercised', () => {
  const cases = KEYWORD_GROUPS.flatMap((group) =>
    group.alternatives.map((alternative) => ({ kind: group.kind, alternative })),
  );

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

// --- Negative space ---------------------------------------------------------

/**
 * What each term must NOT match. Every entry is a measured regression, not a
 * hypothetical: each one classified WRONGLY at the commit this file was fixed
 * at, and five of them did it at `needsReview: false`, i.e. booked unattended.
 *
 * The `notKind` column is the point. Asserting only the right answer would let
 * a future term be "fixed" by moving the collision to a different wrong kind.
 */
interface NegativeCase {
  /** The vocabulary term whose over-matching this pins. */
  term: string;
  what: string;
  input: ClassifiableRow;
  kind: ClassifiedKind;
  notKind: ClassifiedKind;
  /** Undefined ⇒ not asserted (the row is provisional for unrelated reasons). */
  needsReview?: boolean;
}

const TRADE_SHAPE = { quantity: 10, price: 152.3, amount: -1523, isin: 'US0001234567' } as const;

const NEGATIVE_SPACE: readonly NegativeCase[] = [
  {
    term: 'ertrag',
    what: 'Übertrag — a transfer from the current account, not a payout',
    input: row({ text: 'Übertrag von Girokonto', amount: 500 }),
    kind: 'deposit',
    notKind: 'dividend',
    needsReview: true,
  },
  {
    term: 'ertrag',
    what: 'Zinsertrag — THE German word for interest income, which books as a deposit',
    input: row({ text: 'Zinsertrag Tagesgeld', amount: 12.5 }),
    kind: 'deposit',
    notKind: 'dividend',
    needsReview: false,
  },
  {
    term: 'ertrag',
    what: 'Bausparvertrag — a contract, and `vertrag` ends in the term',
    input: row({ text: 'Bausparvertrag Einzahlung', amount: 1000 }),
    kind: 'deposit',
    notKind: 'dividend',
    needsReview: false,
  },
  {
    term: 'ertrag',
    what: 'Sparvertrag',
    input: row({ text: 'Sparvertrag Gutschrift', amount: 250 }),
    kind: 'deposit',
    notKind: 'dividend',
    needsReview: false,
  },
  {
    term: 'fusion',
    what: 'Diffusion Pharmaceuticals — a real ticker, bought with a real ISIN',
    input: row({ text: 'Kauf Diffusion Pharmaceuticals Inc', ...TRADE_SHAPE }),
    kind: 'buy',
    notKind: 'unknown',
    needsReview: false,
  },
  {
    term: 'fusion',
    what: 'Infusion Brands International',
    input: row({ text: 'Kauf Infusion Brands Intl', ...TRADE_SHAPE }),
    kind: 'buy',
    notKind: 'unknown',
    needsReview: false,
  },
  {
    term: 'split',
    what: 'Splitit Payments — a sale of a real holding',
    input: row({
      text: 'Verkauf Splitit Payments Ltd',
      quantity: 10,
      price: 152.3,
      amount: 1523,
      isin: 'IL0011564103',
    }),
    kind: 'sell',
    notKind: 'unknown',
    needsReview: false,
  },
  {
    term: 'umtausch',
    what: 'Waehrungsumtausch — a routine FX line, not a corporate action',
    input: row({ text: 'Waehrungsumtausch EUR/USD', amount: -500 }),
    kind: 'withdrawal',
    notKind: 'unknown',
  },
  {
    term: 'umtausch',
    what: 'Devisenumtausch',
    input: row({ text: 'Devisenumtausch Konto', amount: -500 }),
    kind: 'withdrawal',
    notKind: 'unknown',
  },
  {
    term: 'sell',
    what: 'Gesellschaft — a dividend from an ordinary German company',
    input: row({
      text: 'Ausschuettung Beispiel Gesellschaft mbH',
      amount: 40,
      isin: 'DE0001234567',
    }),
    kind: 'dividend',
    notKind: 'sell',
    needsReview: false,
  },
  {
    term: 'sale',
    what: 'Salesforce — a dividend, not a disposal',
    input: row({ text: 'Dividende Salesforce Inc', amount: 12.5, isin: 'US79466L3024' }),
    kind: 'dividend',
    notKind: 'sell',
    needsReview: false,
  },
  {
    term: 'sold',
    what: 'Soldat — the German for soldier',
    input: row({ text: 'Soldatenversicherung Praemie', amount: -50 }),
    kind: 'withdrawal',
    notKind: 'sell',
  },
  {
    term: 'fee',
    what: 'Coffee',
    input: row({ text: 'Coffee Shop Wien', amount: -4.5 }),
    kind: 'withdrawal',
    notKind: 'fee',
  },
  {
    term: 'charge',
    what: 'Recharge — a top-up, the OPPOSITE direction',
    input: row({ text: 'Recharge Handy Guthaben', amount: -20 }),
    kind: 'withdrawal',
    notKind: 'fee',
  },
  {
    term: 'provision',
    what: 'a trade memo naming its commission — the fee is a line item, not the kind',
    input: row({
      text: 'Wertpapierkauf Allianz SE, Provision EUR 5,90',
      quantity: 10,
      price: 220.5,
      amount: -2210.9,
      isin: 'DE0008404005',
    }),
    kind: 'buy',
    notKind: 'fee',
    needsReview: true,
  },
  {
    term: 'kapitalertragsteuer',
    what: 'a sale memo naming its withheld tax',
    input: row({
      text: 'Verkauf 50 Stk SAP, Kapitalertragsteuer EUR 12,34',
      quantity: 50,
      price: 140,
      amount: 6987.66,
      isin: 'DE0007164600',
    }),
    kind: 'sell',
    notKind: 'tax',
    needsReview: true,
  },
];

describe('negative space — what each term must NOT match', () => {
  for (const { term, what, input, kind, notKind, needsReview } of NEGATIVE_SPACE) {
    it(`"${term}" does not fire on ${what}`, async () => {
      const [result] = await classifyRows([input]);
      expect(result!.kind, result!.evidence).not.toBe(notKind);
      expect(result!.kind, result!.evidence).toBe(kind);
      if (needsReview !== undefined) {
        expect(result!.needsReview, result!.evidence).toBe(needsReview);
      }
    });
  }
});

/**
 * The other half of an anchor: it has to keep matching where it was meant to.
 * A precision fix that quietly costs recall is the same defect with the sign
 * flipped, and the recall loop above only proves the BARE term still works.
 */
describe('the anchored terms still fire in the compounds they exist for', () => {
  const STILL_FIRES: { text: string; kind: ClassifiedKind; amount: number }[] = [
    { text: 'Ertragsgutschrift Vanguard', kind: 'dividend', amount: 41.2 },
    { text: 'Ertragsausschuettung iShares', kind: 'dividend', amount: 41.2 },
    { text: 'Ertragsausschüttung iShares', kind: 'dividend', amount: 41.2 },
    { text: 'Kapitalertrag Depot', kind: 'dividend', amount: 41.2 },
    { text: 'Ertrag Beispiel Bau AG', kind: 'dividend', amount: 13.2 },
  ];

  for (const { text, kind, amount } of STILL_FIRES) {
    it(`still reads ${text} as ${kind}`, async () => {
      const [result] = await classifyRows([row({ text, amount })]);
      expect(result!.kind, result!.evidence).toBe(kind);
    });
  }

  it('still pins Umtausch, Fusion, Merger and Split as corporate actions', async () => {
    const shaped = ['Umtausch Muster AG', 'Fusion Muster AG', 'Merger Muster AG', 'Aktien-Split'];
    for (const text of shaped) {
      const [result] = await classifyRows([row({ text, ...TRADE_SHAPE })]);
      expect(result!.kind, text).toBe('unknown');
      expect(result!.needsReview, text).toBe(true);
      expect(result!.evidence, text).toContain('corporateAction');
    }
  });

  it('still pins Kapitalmaßnahme Umtausch even mid-sentence', async () => {
    const [result] = await classifyRows([
      row({ text: 'Kapitalmaßnahme Umtausch Fusion', quantity: 100, price: 23.4, amount: 2340 }),
    ]);
    expect(result!.kind).toBe('unknown');
    expect(result!.needsReview).toBe(true);
  });
});
