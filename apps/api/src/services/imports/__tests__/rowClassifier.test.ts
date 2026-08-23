import { describe, expect, it } from 'vitest';

import type { ImportRowKind } from '@bettertrack/contracts';

import {
  classifyRows,
  DEFAULT_AI_MAX_CALLS,
  DEFAULT_AI_MAX_ROWS_PER_CALL,
  DEFAULT_REVIEW_CONFIDENCE,
  type ClassifiableRow,
  type ClassifiedKind,
} from '../rowClassifier';
import type { ImportRowAiSeam } from '../rowClassifierAi';

/**
 * Row-kind classification cascade (PROJECTPLAN.md §16 2026-07-31). Every test
 * runs against an INJECTED stub seam — none of these can reach a model. A stub
 * called more times than it has scripted replies THROWS, so a runaway stage-3
 * loop fails loudly instead of quietly burning calls; live completions are
 * structurally impossible here because the real AiService is never constructed.
 */

/** Scripted-reply stub: records requests, refuses to answer beyond its script. */
function stubAiSeam(replies: string[]): {
  seam: ImportRowAiSeam;
  calls: { system: string; prompt: string }[];
} {
  const calls: { system: string; prompt: string }[] = [];
  return {
    calls,
    seam: {
      complete: async (request) => {
        calls.push(request);
        const reply = replies[calls.length - 1];
        if (reply === undefined) {
          throw new Error('stub seam: unexpected extra completion — runaway AI loop');
        }
        return { text: reply, model: 'stub-cheap-7b' };
      },
    },
  };
}

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

async function kinds(rows: ClassifiableRow[], ctx?: Parameters<typeof classifyRows>[1]) {
  const results = await classifyRows(rows, ctx);
  return results.map((result) => result.kind);
}

describe('constants', () => {
  it('exposes the documented defaults', () => {
    expect(DEFAULT_REVIEW_CONFIDENCE).toBe(0.8);
    expect(DEFAULT_AI_MAX_ROWS_PER_CALL).toBe(40);
    expect(DEFAULT_AI_MAX_CALLS).toBe(3);
  });
});

describe('stage 1 — deterministic structure', () => {
  it('reads quantity+price as a trade, direction from the amount sign', async () => {
    const results = await classifyRows([
      row({ quantity: 10, price: 152.3, amount: -1523 }),
      row({ quantity: 4, price: 310, amount: 1240 }),
    ]);
    expect(results[0]).toMatchObject({
      kind: 'buy',
      confidence: 0.95,
      stage: 'structure',
      needsReview: false,
    });
    expect(results[1]).toMatchObject({ kind: 'sell', confidence: 0.95, stage: 'structure' });
  });

  it('falls back to the quantity sign when the amount carries none', async () => {
    const results = await classifyRows([row({ quantity: -3, price: 99 })]);
    // Trade Republic-style negative sold quantities are a sell.
    expect(results[0]!.kind).toBe('sell');
  });

  it('never guesses a trade direction it has no signal for', async () => {
    const results = await classifyRows([row({ quantity: 5, price: 42 })]);
    expect(results[0]!.kind).toBe('unknown');
    expect(results[0]!.needsReview).toBe(true);
  });

  it('trusts a canonical kindHint alone', async () => {
    const results = await classifyRows([row({ kindHint: 'Dividend' })]);
    expect(results[0]).toMatchObject({
      kind: 'dividend',
      confidence: 0.92,
      stage: 'structure',
    });
  });

  it('flags internal-only fee/tax hints for review', async () => {
    const [fee, tax] = await classifyRows([row({ kindHint: 'fee' }), row({ kindHint: 'tax' })]);
    expect(fee).toMatchObject({ kind: 'fee', needsReview: true });
    expect(tax).toMatchObject({ kind: 'tax', needsReview: true });
  });

  it('resolves a declared cash family by the amount sign', async () => {
    const results = await classifyRows([
      row({ kindHint: 'cash', amount: 500 }),
      row({ kindHint: 'cash', amount: -80 }),
    ]);
    expect(results[0]!.kind).toBe('deposit');
    expect(results[1]!.kind).toBe('withdrawal');
  });

  it('flags a kindHint that contradicts the structural trade reading', async () => {
    const results = await classifyRows([
      row({ kindHint: 'sell', quantity: 2, price: 10, amount: -20 }),
    ]);
    expect(results[0]!.kind).toBe('buy'); // structure wins over the hint…
    expect(results[0]!.needsReview).toBe(true); // …but the conflict is surfaced
    expect(results[0]!.evidence).toContain('conflicts with kindHint');
  });

  it('treats a bare signed amount as provisional only (below the bar)', async () => {
    const results = await classifyRows([row({ amount: -50 }), row({ amount: 700 })]);
    expect(results[0]!.confidence).toBeLessThan(DEFAULT_REVIEW_CONFIDENCE);
    expect(results[1]!.confidence).toBeLessThan(DEFAULT_REVIEW_CONFIDENCE);
  });
});

describe('stage 2 — multilingual keyword table', () => {
  it('maps German and English verbs, case-insensitively', async () => {
    expect(
      await kinds([
        row({ text: 'Sparplanausführung Apple', amount: -10 }),
        row({ text: 'Verkauf von Anteilen', amount: 40 }),
        row({ text: 'DIVIDENDE iShares', amount: 5 }),
        row({ text: 'Einzahlung OnlineBanking', amount: 100 }),
        row({ text: 'Lastschrift Kartenzahlung', amount: -30 }),
        row({ text: 'Purchase order', amount: -75 }),
        row({ text: 'Wire Deposit', amount: 300 }),
        row({ text: 'ATM Withdrawal', amount: -60 }),
      ]),
    ).toEqual(['buy', 'sell', 'dividend', 'deposit', 'withdrawal', 'buy', 'deposit', 'withdrawal']);
  });

  it('reads the SELL out of "Verkauf" instead of the Kauf (ordering pin)', async () => {
    expect(await kinds([row({ text: 'Teilverkauf', amount: 90 })])).toEqual(['sell']);
  });

  it('ranks cost markers above direction verbs (a named fee is not a trade)', async () => {
    expect(await kinds([row({ text: 'Verkaufsprovision Order 4711', amount: -2 })])).toEqual([
      'fee',
    ]);
    expect(await kinds([row({ text: 'KESt aus Verkauf', amount: -8 })])).toEqual(['tax']);
  });

  it('matches compounds and ASCII-transliterated spellings', async () => {
    expect(await kinds([row({ text: 'Depotgebühr Q1/26', amount: -4.59 })])).toEqual(['fee']);
    expect(await kinds([row({ text: 'Fremdgebuehr', amount: -1.2 })])).toEqual(['fee']);
    expect(await kinds([row({ text: 'KESt Kapitalertragsteuer', amount: -3 })])).toEqual(['tax']);
  });

  it('flags internal-only fee/tax kinds even at high confidence', async () => {
    const results = await classifyRows([row({ text: 'Depotgebühr', amount: -4 })]);
    expect(results[0]).toMatchObject({
      kind: 'fee',
      confidence: 0.85,
      stage: 'keyword',
      needsReview: true,
    });
  });

  it('flags a keyword whose implied direction the signed amount contradicts', async () => {
    const results = await classifyRows([
      row({ text: 'Gutschrift auf Verrechnungskonto', amount: -5 }),
    ]);
    expect(results[0]!.needsReview).toBe(true);
    expect(results[0]!.evidence).toContain('contradicts the amount sign');
  });

  it('flags a cash keyword on a row that carries an asset identity', async () => {
    const results = await classifyRows([
      row({ text: 'Credit Agricole CIB note', amount: 15, isin: 'FR0010510800' }),
    ]);
    expect(results[0]!.needsReview).toBe(true);
    expect(results[0]!.evidence).toContain('asset identity');
  });
});

// A mixed file — the NORMAL case (§16 2026-07-31): cash movements, trades, a
// dividend, a fee and a tax row in ONE file, resolved without any model call.
const MIXED_FIXTURE: ClassifiableRow[] = [
  row({ text: 'Einzahlung OnlineBanking', amount: 2500 }), // 0
  row({ text: 'Lastschrift Karte', amount: -89.9 }), // 1
  row({ text: 'Deposit wire transfer', amount: 1000 }), // 2
  row({ text: 'Withdrawal ATM Vienna', amount: -200 }), // 3
  row({
    text: 'Kauf Marktorder',
    quantity: 10,
    price: 152.3,
    amount: -1523,
    symbol: 'AAPL',
    isin: 'US0378331005',
  }), // 4
  row({ text: 'Sell to close', quantity: 4, price: 310.5, amount: 1242, symbol: 'MSFT' }), // 5
  row({ text: 'Sparplanausführung VWRL', quantity: 1.5, price: 118.2, amount: -177.3 }), // 6
  row({ text: 'Ausschüttung iShares CORE MSCI World', amount: 63.2, symbol: 'SWDA' }), // 7
  row({ text: 'Dividend payment AT&T', amount: 12.4, symbol: 'T' }), // 8
  row({ text: 'Depotgebühr 1. Quartal', amount: -4.59 }), // 9
  row({ text: 'KESt auf Verkauf', amount: -8.14 }), // 10
  row({ text: 'Quellensteuer USA', amount: -2.48, symbol: 'T' }), // 11
];

const MIXED_EXPECTED: ClassifiedKind[] = [
  'deposit',
  'withdrawal',
  'deposit',
  'withdrawal',
  'buy',
  'sell',
  'buy',
  'dividend',
  'dividend',
  'fee',
  'tax',
  'tax',
];

describe('acceptance — a mixed file resolves with stages 1–2 ALONE (zero AI)', () => {
  it('classifies every row correctly and spends NO model call', async () => {
    const { seam, calls } = stubAiSeam(['THIS MUST NEVER BE RETURNED']);
    const results = await classifyRows(MIXED_FIXTURE, { ai: seam });

    expect(results.map((result) => result.kind)).toEqual(MIXED_EXPECTED);
    expect(calls).toHaveLength(0); // the fallback stayed a fallback

    // Only the internal-only fee/tax rows require a human decision.
    expect(results.filter((result) => result.needsReview).map((result) => result.index)).toEqual([
      9, 10, 11,
    ]);
    for (const result of results) {
      expect(result.confidence).toBeGreaterThanOrEqual(DEFAULT_REVIEW_CONFIDENCE);
      expect(['structure', 'keyword']).toContain(result.stage);
    }
  });

  it('keeps working with no ai seam configured at all', async () => {
    const results = await classifyRows(MIXED_FIXTURE);
    expect(results.map((result) => result.kind)).toEqual(MIXED_EXPECTED);
  });
});

describe('acceptance — the named failure is pinned', () => {
  it('20 cash rows + 1 trade row ⇒ 20 cash kinds + 1 trade kind (no coercion)', async () => {
    const { seam, calls } = stubAiSeam(['NEVER']);
    const cashTexts = [
      ['Einzahlung Dauerauftrag', 500],
      ['Überweisungsgutschrift Lohn', 2340.55],
      ['Auszahlung Bargeld', -400],
      ['Belastung Kartenzahlung', -62.17],
    ] as const;
    const rows: ClassifiableRow[] = Array.from({ length: 20 }, (_, i) => {
      const entry = cashTexts[i % cashTexts.length]!;
      return row({ text: entry[0], amount: entry[1] });
    });
    // One odd trade row right in the middle of the cash — the row the owner
    // watched get broken or swallowed as "just another cash withdraw".
    const TRADE_INDEX = 13;
    rows.splice(
      TRADE_INDEX,
      0,
      row({
        text: 'Kauf Limitorder',
        quantity: 25,
        price: 87.44,
        amount: -2186,
        symbol: 'VWCE',
        isin: 'IE00BK5BQT80',
      }),
    );

    const results = await classifyRows(rows, { ai: seam });

    expect(results).toHaveLength(21);
    expect(calls).toHaveLength(0); // one odd row never wakes the fallback either
    expect(results[TRADE_INDEX]).toMatchObject({
      kind: 'buy',
      confidence: 0.95,
      stage: 'structure',
      needsReview: false,
    });

    const cashResults = results.filter((_, i) => i !== TRADE_INDEX);
    expect(cashResults.map((result) => result.kind)).toEqual(
      Array.from({ length: 20 }, (_, p) => (p % 4 < 2 ? 'deposit' : 'withdrawal')),
    );
    expect(new Set(results.map((result) => result.needsReview))).toEqual(new Set([false]));
  });
});

describe('stage 3 — batched CHEAP-tier fallback', () => {
  const AMBIGUOUS: ClassifiableRow[] = [
    row({ text: 'Booking reference 8842' }),
    row({ text: 'Abschluss' }),
    row({}),
    row({ text: 'Nw' }),
    row({ text: 'PM' }),
  ];

  it('sends N ambiguous rows in ONE call and applies every trusted label', async () => {
    const { seam, calls } = stubAiSeam(['0=buy\n1=sell\n2=dividend\n3=deposit\n4=withdrawal']);
    const results = await classifyRows(AMBIGUOUS, { ai: seam });

    expect(calls).toHaveLength(1); // N ⇒ 1, not N
    expect(results.map((result) => result.kind)).toEqual([
      'buy',
      'sell',
      'dividend',
      'deposit',
      'withdrawal',
    ]);
    for (const result of results) {
      expect(result.stage).toBe('ai');
      expect(result.confidence).toBe(0.75);
      expect(result.needsReview).toBe(false);
    }
    // The prompt carries indexed facts only — the model names kinds, never values.
    expect(calls[0]!.system).toContain('<index>=<LABEL>');
    // Text facts are emitted UNQUOTED (flattened): the prompt must not contain
    // a quote character at all, so this expectation is intentionally bare.
    expect(calls[0]!.prompt).toContain('0: text=Booking reference 8842');
    expect(calls[0]!.prompt).not.toContain('undefined');
  });

  it('tolerates bent formatting before giving up on a line', async () => {
    const { seam } = stubAiSeam(['Sure:\n0 = BUY\n1 -> sell\n2: DIVIDEND\n???']);
    const results = await classifyRows(AMBIGUOUS.slice(0, 4), { ai: seam });
    expect(results.map((result) => result.kind)).toEqual(['buy', 'sell', 'dividend', 'unknown']);
    expect(results[3]!.needsReview).toBe(true);
  });

  it('turns a fully malformed reply into needs-review, never a wrong kind', async () => {
    const { seam, calls } = stubAiSeam([
      'I am very sorry, but I really cannot classify these particular rows.',
    ]);
    const results = await classifyRows(AMBIGUOUS, { ai: seam });

    expect(calls).toHaveLength(1);
    for (const result of results) {
      expect(result.kind).toBe('unknown');
      expect(result.needsReview).toBe(true);
      expect(result.evidence).toContain('missing/malformed');
    }
  });

  it('parses defensively around hallucinated indexes and foreign labels', async () => {
    const { seam } = stubAiSeam(['0=buy\n99=withdrawal\n2=transfer\n3=DEPOSIT']);
    const results = await classifyRows(AMBIGUOUS, { ai: seam });
    expect(results[0]).toMatchObject({ kind: 'buy', needsReview: false });
    expect(results[1]).toMatchObject({ kind: 'unknown', needsReview: true }); // missing line
    expect(results[2]).toMatchObject({ kind: 'unknown', needsReview: true }); // foreign label
    expect(results[3]).toMatchObject({ kind: 'deposit', needsReview: false });
    expect(results[4]).toMatchObject({ kind: 'unknown', needsReview: true }); // absent
  });

  it('batches up to aiMaxRowsPerCall and keeps classifying across chunks', async () => {
    const { seam, calls } = stubAiSeam([
      '0=deposit\n1=deposit',
      '2=withdrawal\n3=withdrawal',
      '4=dividend',
    ]);
    const results = await classifyRows(AMBIGUOUS, { ai: seam, aiMaxRowsPerCall: 2 });
    expect(calls).toHaveLength(3);
    expect(results.map((result) => result.kind)).toEqual([
      'deposit',
      'deposit',
      'withdrawal',
      'withdrawal',
      'dividend',
    ]);
  });

  it('flags the remainder for review once the call budget is spent', async () => {
    const { seam, calls } = stubAiSeam(['0=deposit\n1=deposit']);
    const results = await classifyRows(AMBIGUOUS, {
      ai: seam,
      aiMaxRowsPerCall: 2,
      aiMaxCalls: 1,
    });

    expect(calls).toHaveLength(1);
    expect(results[0]).toMatchObject({ kind: 'deposit', needsReview: false });
    expect(results[1]).toMatchObject({ kind: 'deposit', needsReview: false });
    expect(results.slice(2).map((result) => result.kind)).toEqual([
      'unknown',
      'unknown',
      'unknown',
    ]);
    for (const result of results.slice(2)) {
      expect(result.needsReview).toBe(true);
      expect(result.evidence).toContain('ai call budget exhausted');
    }
  });

  it('degrades to needs-review (without throwing) when the provider errors', async () => {
    let attempts = 0;
    const failingSeam: ImportRowAiSeam = {
      complete: async (request) => {
        attempts += 1;
        void request;
        throw new Error('connection refused');
      },
    };
    const results = await classifyRows(AMBIGUOUS, { ai: failingSeam, aiMaxCalls: 1 });
    expect(attempts).toBe(1); // one attempt, then stop — never a retry loop
    for (const result of results) {
      expect(result.kind).toBe('unknown');
      expect(result.needsReview).toBe(true);
    }
  });

  it('marks every AI-derived result for review when the caller distrusts them', async () => {
    const { seam } = stubAiSeam(['0=buy\n1=sell\n2=dividend\n3=deposit\n4=withdrawal']);
    const results = await classifyRows(AMBIGUOUS, { ai: seam, aiLowTrustResults: true });
    for (const result of results) {
      expect(result.stage).toBe('ai');
      expect(result.needsReview).toBe(true);
    }
  });

  it('never wakes the fallback for rows stages 1–2 settled confidently', async () => {
    const { calls } = stubAiSeam(['NEVER']);
    const results = await classifyRows([
      row({ text: 'Einzahlung', amount: 10 }),
      row({ quantity: 1, price: 1, amount: -1 }),
      row({ text: 'unparseable noise' }), // ambiguous, but no seam configured
    ]);
    expect(calls).toHaveLength(0);
    expect(results.map((result) => result.kind)).toEqual(['deposit', 'buy', 'unknown']);
  });
});

describe('output contract', () => {
  it('returns one verdict per row, in order, with echoed array indexes', async () => {
    const results = await classifyRows([row(), row(), row()]);
    expect(results.map((result) => result.index)).toEqual([0, 1, 2]);
    for (const result of results) {
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
      expect(result.evidence.length).toBeGreaterThan(0);
    }
  });

  it('rounds confidence to two decimals and flags below a raised bar', async () => {
    const results = await classifyRows([row({ kindHint: 'buy' })], {
      reviewConfidenceBelow: 0.93,
    });
    expect(results[0]!.confidence).toBe(0.92);
    expect(results[0]!.needsReview).toBe(true); // below the raised bar ⇒ human
  });

  it('emits only locked wire kinds plus internal fee/tax/unknown', async () => {
    const allowed: readonly string[] = [
      'buy',
      'sell',
      'dividend',
      'deposit',
      'withdrawal',
      'fee',
      'tax',
      'unknown',
    ];
    const sample: ClassifiableRow[] = [
      row({ kindHint: 'buy' }),
      row({ kindHint: 'sell' }),
      row({ kindHint: 'dividend' }),
      row({ kindHint: 'deposit' }),
      row({ kindHint: 'withdrawal' }),
      row({ kindHint: 'fee' }),
      row({ kindHint: 'tax' }),
      row(),
    ];
    for (const result of await classifyRows(sample)) {
      expect(allowed).toContain(result.kind as string);
    }
    const wireOnly: readonly ImportRowKind[] = ['buy', 'sell', 'dividend', 'deposit', 'withdrawal'];
    expect(wireOnly).toHaveLength(5); // vocabulary unchanged (locked)
  });
});
