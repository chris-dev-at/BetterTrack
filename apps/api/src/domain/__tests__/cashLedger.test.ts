import { describe, expect, it } from 'vitest';

import {
  applyCashMovement,
  CASH_EPSILON,
  CASH_MOVEMENT_KINDS,
  CASH_MOVEMENT_SIGN,
  cashBalance,
  cashBalanceOverTime,
  cashBalancesBySource,
  CashLedgerError,
  EXTERNAL_CASH_MOVEMENT_KINDS,
  externalCashFlowsForTwr,
  InsufficientCashError,
  isExternalCashMovement,
  netWorthSeries,
  pairedTransferMovements,
  projectCashLedger,
  projectCashLedgerBySource,
  floorCents,
  setBalanceDelta,
  setBalanceMovement,
  spendableAsOf,
  type CashMovement,
  type CashMovementKind,
  type SourcedCashMovement,
} from '../cashLedger';
import { timeWeightedReturn, type ValuePoint } from '../holdings';

// --- Helpers ---------------------------------------------------------------

function mv(kind: CashMovementKind, amountEur: number, occurredAt: string): CashMovement {
  return { kind, amountEur, occurredAt };
}

/** Deposit 1000 → buy 400 → sell proceeds 150 → withdraw 200; balance 550. */
function mixedSequence(): CashMovement[] {
  return [
    mv('deposit', 1000, '2026-01-05T09:00:00Z'),
    mv('buy', -400, '2026-01-06T10:00:00Z'),
    mv('sell_proceeds', 150, '2026-01-07T11:00:00Z'),
    mv('withdrawal', -200, '2026-01-08T12:00:00Z'),
  ];
}

// ---------------------------------------------------------------------------
// floorCents — the whole-cent boundary quantizer, floor policy (#370, #322)
// ---------------------------------------------------------------------------

describe('floorCents', () => {
  it('is a no-op on values already expressible in whole cents', () => {
    expect(floorCents(0)).toBe(0);
    expect(floorCents(100)).toBe(100);
    expect(floorCents(1234.56)).toBe(1234.56);
    expect(floorCents(-99.99)).toBe(-99.99);
    // Exact cents whose decimal literal underflows (8.61 → 860.999…9) survive
    // rather than dropping a cent.
    expect(floorCents(8.61)).toBe(8.61);
    expect(floorCents(0.07)).toBe(0.07);
  });

  it('floors sub-cent EUR down (never rounds up — the #370 policy)', () => {
    // Every sub-cent residue truncates toward zero, even one that half-away
    // rounding would have carried up to the next cent.
    expect(floorCents(100.006)).toBe(100.0);
    expect(floorCents(100.004)).toBe(100.0);
    expect(floorCents(0.005)).toBe(0.0);
    expect(floorCents(0.009999)).toBe(0.0);
    // 1.005 is stored as 1.00499999…; it floors down to 1.00, not up to 1.01.
    expect(floorCents(1.005)).toBe(1.0);
    expect(floorCents(2.675)).toBe(2.67);
  });

  it('truncates the magnitude toward zero for negative (outflow) amounts', () => {
    // A buy/withdrawal stores a negative amount; flooring shrinks its magnitude
    // so the deducted amount is ≤ the true cost, never more.
    expect(floorCents(-100.006)).toBe(-100.0);
    expect(floorCents(-0.005)).toBe(0);
    expect(Object.is(floorCents(-0.005), 0)).toBe(true);
    expect(floorCents(-1.005)).toBe(-1.0);
  });

  it('sheds FP summation dust so a reconciled balance is exactly zero cents', () => {
    // 0.1 + 0.2 − 0.3 leaves ~5.5e-17 of float dust; flooring lands it at 0.
    const dust = 0.1 + 0.2 - 0.3;
    expect(dust).not.toBe(0);
    expect(floorCents(dust)).toBe(0);
    // A value a hair below a cent boundary from summation still floors onto it.
    expect(floorCents(0.1 + 0.2)).toBe(0.3);
  });

  it('makes withdraw-all safe: the floored balance can be fully withdrawn', () => {
    // A sub-cent FX-converted buy leaves a true balance of 100.006. The reported
    // (floored) balance is 100.00 — withdrawing it leaves a true 0.006 that
    // itself floors to exactly 0. Rounding UP to 100.01 would have overdrawn the
    // true 100.006 (the #322/#370 bug flooring fixes).
    const trueBalance = cashBalance([mv('deposit', 100.006, '2026-01-01T00:00:00Z')]);
    const reported = floorCents(trueBalance);
    expect(reported).toBe(100.0);
    expect(reported).toBeLessThanOrEqual(trueBalance + CASH_EPSILON);
    const after = floorCents(trueBalance - reported);
    expect(after).toBe(0);
    expect(Object.is(after, 0)).toBe(true);
  });

  it('throws on a non-finite amount', () => {
    expect(() => floorCents(Number.POSITIVE_INFINITY)).toThrow(CashLedgerError);
    expect(() => floorCents(Number.NaN)).toThrow(CashLedgerError);
  });
});

// ---------------------------------------------------------------------------
// cashBalance — the reconciliation invariant
// ---------------------------------------------------------------------------

describe('cashBalance', () => {
  it('is the sum of signed movements across a mixed sequence', () => {
    expect(cashBalance(mixedSequence())).toBe(550);
  });

  it('reconciles: current cash === sum of movements, for representative sequences', () => {
    const sequences = [
      mixedSequence(),
      [mv('deposit', 0.1, '2026-01-05'), mv('deposit', 0.2, '2026-01-06')],
      [
        mv('deposit', 123.45, '2026-01-05T09:00:00Z'),
        mv('withdrawal', -23.45, '2026-01-05T10:00:00Z'),
        mv('buy', -100, '2026-01-06T09:00:00Z'),
        mv('sell_proceeds', 250.5, '2026-02-01T09:00:00Z'),
        mv('withdrawal', -250.5, '2026-02-02T09:00:00Z'),
      ],
    ];
    for (const movements of sequences) {
      const plainSum = movements.reduce((sum, m) => sum + m.amountEur, 0);
      expect(cashBalance(movements)).toBe(plainSum);
    }
  });

  it('is 0 for an empty ledger', () => {
    expect(cashBalance([])).toBe(0);
  });

  it('does not enforce non-negativity — reconciliation is a pure sum', () => {
    // A buy larger than all deposits: projection rejects it, the sum reports it.
    expect(cashBalance([mv('deposit', 100, '2026-01-05'), mv('buy', -150, '2026-01-06')])).toBe(
      -50,
    );
  });

  it('rejects an unknown kind', () => {
    // 'dividend' graduated to a real kind in V3-P4 — probe with true garbage.
    expect(() => cashBalance([mv('jackpot' as CashMovementKind, 10, '2026-01-05')])).toThrow(
      CashLedgerError,
    );
  });

  it('rejects non-finite and zero amounts', () => {
    for (const amount of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0]) {
      expect(() => cashBalance([mv('deposit', amount, '2026-01-05')])).toThrow(CashLedgerError);
    }
  });

  it('rejects a sign that contradicts the kind, for every kind', () => {
    expect(() => cashBalance([mv('deposit', -10, '2026-01-05')])).toThrow(
      /deposit must carry a strictly positive/,
    );
    expect(() => cashBalance([mv('sell_proceeds', -10, '2026-01-05')])).toThrow(
      /sell_proceeds must carry a strictly positive/,
    );
    expect(() => cashBalance([mv('withdrawal', 10, '2026-01-05')])).toThrow(
      /withdrawal must carry a strictly negative/,
    );
    expect(() => cashBalance([mv('buy', 10, '2026-01-05')])).toThrow(
      /buy must carry a strictly negative/,
    );
  });

  it('rejects an unparseable timestamp and names the movement index', () => {
    expect(() =>
      cashBalance([mv('deposit', 10, '2026-01-05'), mv('deposit', 10, 'yesterday-ish')]),
    ).toThrow(/ISO-8601/);
  });
});

// ---------------------------------------------------------------------------
// applyCashMovement — the admission gate ("available → after")
// ---------------------------------------------------------------------------

describe('applyCashMovement', () => {
  it('returns the balance after the movement', () => {
    expect(applyCashMovement(0, mv('deposit', 1000, '2026-01-05'))).toBe(1000);
    expect(applyCashMovement(1000, mv('buy', -400, '2026-01-05'))).toBe(600);
    expect(applyCashMovement(600, mv('withdrawal', -600, '2026-01-05'))).toBe(0);
  });

  it('allows spending the balance down to exactly 0', () => {
    expect(applyCashMovement(250, mv('buy', -250, '2026-01-05'))).toBe(0);
  });

  it('throws the typed InsufficientCashError when a buy would overdraw', () => {
    expect(() => applyCashMovement(100, mv('buy', -150, '2026-01-05'))).toThrow(
      InsufficientCashError,
    );
  });

  it('throws when a withdrawal would overdraw', () => {
    expect(() => applyCashMovement(100, mv('withdrawal', -100.01, '2026-01-05'))).toThrow(
      InsufficientCashError,
    );
  });

  it('carries the available balance, the movement, and the exact shortfall', () => {
    const movement = mv('buy', -150, '2026-01-05T09:00:00Z');
    let caught: unknown;
    try {
      applyCashMovement(100, movement);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InsufficientCashError);
    const err = caught as InsufficientCashError;
    expect(err.balanceEur).toBe(100);
    expect(err.movement).toBe(movement);
    expect(err.shortfallEur).toBe(50);
    expect(err.message).toContain('150');
    expect(err.name).toBe('InsufficientCashError');
  });

  it('InsufficientCashError is not a CashLedgerError — a valid movement, just unaffordable', () => {
    let caught: unknown;
    try {
      applyCashMovement(0, mv('withdrawal', -1, '2026-01-05'));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InsufficientCashError);
    expect(caught).not.toBeInstanceOf(CashLedgerError);
  });

  it('tolerates FP dust: 0.1 + 0.2 deposited, 0.3 spent, does not throw', () => {
    let balance = 0;
    balance = applyCashMovement(balance, mv('deposit', 0.1, '2026-01-05'));
    balance = applyCashMovement(balance, mv('deposit', 0.2, '2026-01-06'));
    balance = applyCashMovement(balance, mv('buy', -0.3, '2026-01-07'));
    expect(Math.abs(balance)).toBeLessThan(CASH_EPSILON);
  });

  it('tolerates dust the other way: 0.3 in, 0.1 + 0.2 out, does not throw', () => {
    let balance = 0;
    balance = applyCashMovement(balance, mv('deposit', 0.3, '2026-01-05'));
    balance = applyCashMovement(balance, mv('buy', -0.1, '2026-01-06'));
    balance = applyCashMovement(balance, mv('buy', -0.2, '2026-01-07'));
    expect(Math.abs(balance)).toBeLessThan(CASH_EPSILON);
  });

  it('a real overdraft of one cent is NOT dust and throws', () => {
    expect(() => applyCashMovement(0.3, mv('buy', -0.31, '2026-01-05'))).toThrow(
      InsufficientCashError,
    );
  });

  it('rejects a non-finite or negative starting balance', () => {
    for (const balance of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(() => applyCashMovement(balance, mv('deposit', 10, '2026-01-05'))).toThrow(
        CashLedgerError,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// projectCashLedger — chronological replay, no silent negative balances
// ---------------------------------------------------------------------------

describe('projectCashLedger', () => {
  it('returns the running balance after every movement (balance-over-time)', () => {
    const entries = projectCashLedger(mixedSequence());
    expect(entries.map((e) => e.balanceEur)).toEqual([1000, 600, 750, 550]);
    expect(entries.map((e) => e.movement.kind)).toEqual([
      'deposit',
      'buy',
      'sell_proceeds',
      'withdrawal',
    ]);
  });

  it('a sequence that stays ≥ 0 does not throw; one that dips negative does', () => {
    expect(() => projectCashLedger(mixedSequence())).not.toThrow();
    expect(() =>
      projectCashLedger([
        mv('deposit', 100, '2026-01-05'),
        mv('buy', -100, '2026-01-06'),
        mv('withdrawal', -1, '2026-01-07'),
      ]),
    ).toThrow(InsufficientCashError);
  });

  it('final projected balance equals cashBalance', () => {
    const movements = mixedSequence();
    const entries = projectCashLedger(movements);
    expect(entries[entries.length - 1]?.balanceEur).toBe(cashBalance(movements));
  });

  it('replays by occurredAt, not input order: a later-listed but earlier deposit funds a buy', () => {
    // Naive input-order replay would start with the buy and throw.
    const entries = projectCashLedger([
      mv('buy', -500, '2026-01-06T10:00:00Z'),
      mv('deposit', 1000, '2026-01-05T10:00:00Z'),
    ]);
    expect(entries.map((e) => e.movement.kind)).toEqual(['deposit', 'buy']);
    expect(entries.map((e) => e.balanceEur)).toEqual([1000, 500]);
  });

  it('a buy dated before its funding deposit throws, wherever it is listed', () => {
    expect(() =>
      projectCashLedger([
        mv('deposit', 1000, '2026-01-06T10:00:00Z'),
        mv('buy', -500, '2026-01-05T10:00:00Z'),
      ]),
    ).toThrow(InsufficientCashError);
  });

  it('breaks timestamp ties by input order', () => {
    const at = '2026-01-05T10:00:00Z';
    expect(() => projectCashLedger([mv('deposit', 100, at), mv('buy', -100, at)])).not.toThrow();
    expect(() => projectCashLedger([mv('buy', -100, at), mv('deposit', 100, at)])).toThrow(
      InsufficientCashError,
    );
  });

  it('does not mutate the input array', () => {
    const movements = [
      mv('buy', -500, '2026-01-06T10:00:00Z'),
      mv('deposit', 1000, '2026-01-05T10:00:00Z'),
    ];
    projectCashLedger(movements);
    expect(movements[0]?.kind).toBe('buy');
  });

  it('returns [] for an empty ledger', () => {
    expect(projectCashLedger([])).toEqual([]);
  });

  it('validates every movement up front', () => {
    expect(() =>
      projectCashLedger([mv('deposit', 10, '2026-01-05'), mv('deposit', -1, '2026-01-06')]),
    ).toThrow(CashLedgerError);
  });
});

// ---------------------------------------------------------------------------
// cashBalanceOverTime — end-of-day series
// ---------------------------------------------------------------------------

describe('cashBalanceOverTime', () => {
  it('emits one point per movement day with that day’s closing balance', () => {
    expect(cashBalanceOverTime(mixedSequence())).toEqual([
      { date: '2026-01-05', balanceEur: 1000 },
      { date: '2026-01-06', balanceEur: 600 },
      { date: '2026-01-07', balanceEur: 750 },
      { date: '2026-01-08', balanceEur: 550 },
    ]);
  });

  it('collapses same-day movements to the last balance of the day', () => {
    expect(
      cashBalanceOverTime([
        mv('deposit', 1000, '2026-01-05T09:00:00Z'),
        mv('buy', -400, '2026-01-05T15:00:00Z'),
        mv('withdrawal', -100, '2026-01-07T09:00:00Z'),
      ]),
    ).toEqual([
      { date: '2026-01-05', balanceEur: 600 },
      { date: '2026-01-07', balanceEur: 500 },
    ]);
  });

  it('is sparse — days without movements produce no point', () => {
    const points = cashBalanceOverTime(mixedSequence());
    expect(points.map((p) => p.date)).not.toContain('2026-01-09');
  });

  it('rejects negative-dipping histories like the projection', () => {
    expect(() => cashBalanceOverTime([mv('withdrawal', -1, '2026-01-05')])).toThrow(
      InsufficientCashError,
    );
  });

  it('returns [] for an empty ledger', () => {
    expect(cashBalanceOverTime([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// externalCashFlowsForTwr — the TWR classifier
// ---------------------------------------------------------------------------

describe('externalCashFlowsForTwr', () => {
  it('deposit-then-buy-from-cash yields exactly ONE external flow: the deposit', () => {
    const flows = externalCashFlowsForTwr([
      mv('deposit', 1000, '2026-01-05T09:00:00Z'),
      mv('buy', -1000, '2026-01-06T10:00:00Z'),
    ]);
    expect(flows).toEqual([{ date: '2026-01-05', flowEur: 1000 }]);
  });

  it('returns only deposits/withdrawals; buy and sell_proceeds are internal', () => {
    const flows = externalCashFlowsForTwr(mixedSequence());
    expect(flows).toEqual([
      { date: '2026-01-05', flowEur: 1000 },
      { date: '2026-01-08', flowEur: -200 },
    ]);
  });

  it('keeps the FlowPoint sign convention: deposits positive, withdrawals negative', () => {
    const flows = externalCashFlowsForTwr([
      mv('withdrawal', -200, '2026-01-08'),
      mv('deposit', 1000, '2026-01-05'),
    ]);
    expect(flows).toEqual([
      { date: '2026-01-05', flowEur: 1000 },
      { date: '2026-01-08', flowEur: -200 },
    ]);
  });

  it('nets same-day external flows into one point', () => {
    expect(
      externalCashFlowsForTwr([
        mv('deposit', 1000, '2026-01-05T09:00:00Z'),
        mv('deposit', 500, '2026-01-05T11:00:00Z'),
        mv('withdrawal', -300, '2026-01-05T15:00:00Z'),
      ]),
    ).toEqual([{ date: '2026-01-05', flowEur: 1200 }]);
  });

  it('is a pure classifier — it does not enforce solvency', () => {
    expect(() => externalCashFlowsForTwr([mv('withdrawal', -100, '2026-01-05')])).not.toThrow();
  });

  it('returns [] when there are no external movements', () => {
    expect(externalCashFlowsForTwr([])).toEqual([]);
    expect(
      externalCashFlowsForTwr([
        mv('sell_proceeds', 150, '2026-01-05'),
        mv('buy', -150, '2026-01-06'),
      ]),
    ).toEqual([]);
  });

  it('validates movements like the rest of the engine', () => {
    expect(() => externalCashFlowsForTwr([mv('deposit', -10, '2026-01-05')])).toThrow(
      CashLedgerError,
    );
  });
});

describe('isExternalCashMovement', () => {
  it('classifies exactly deposit/withdrawal as external', () => {
    expect(isExternalCashMovement('deposit')).toBe(true);
    expect(isExternalCashMovement('withdrawal')).toBe(true);
    expect(isExternalCashMovement('buy')).toBe(false);
    expect(isExternalCashMovement('sell_proceeds')).toBe(false);
    expect([...EXTERNAL_CASH_MOVEMENT_KINDS].sort()).toEqual(['deposit', 'withdrawal']);
  });

  it('every kind has a declared sign and an external/internal classification', () => {
    for (const kind of CASH_MOVEMENT_KINDS) {
      expect([1, -1]).toContain(CASH_MOVEMENT_SIGN[kind]);
      expect(typeof isExternalCashMovement(kind)).toBe('boolean');
    }
  });
});

// ---------------------------------------------------------------------------
// TWR neutrality — end-to-end against holdings.timeWeightedReturn
// ---------------------------------------------------------------------------

describe('TWR neutrality of cash-funded buys (composition with timeWeightedReturn)', () => {
  // Portfolio value INCLUDING cash (the V2-P6 wiring rule):
  // day 1: deposit 1000 → value 1000 (all cash)
  // day 2: buy 1000 of stock from cash → value 1000 (all shares) — pure form change
  // day 3: the stock gains 10 % → value 1100
  const values: ValuePoint[] = [
    { date: '2026-01-05', valueEur: 1000 },
    { date: '2026-01-06', valueEur: 1000 },
    { date: '2026-01-07', valueEur: 1100 },
  ];
  const movements: CashMovement[] = [
    mv('deposit', 1000, '2026-01-05T09:00:00Z'),
    mv('buy', -1000, '2026-01-06T10:00:00Z'),
  ];

  it('the performance-% curve is unaffected by the internal cash→stock conversion', () => {
    const series = timeWeightedReturn(values, externalCashFlowsForTwr(movements));
    expect(series.map((p) => p.date)).toEqual(['2026-01-05', '2026-01-06', '2026-01-07']);
    // Deposit day: flat (new money is not performance). Buy day: flat (form
    // change). Day 3: the genuine +10 % — and nothing else.
    expect(series[0]?.pct).toBeCloseTo(0, 9);
    expect(series[1]?.pct).toBeCloseTo(0, 9);
    expect(series[2]?.pct).toBeCloseTo(10, 9);
  });

  it('counterfactual: misclassifying the buy as an external flow corrupts the curve', () => {
    const misclassified = [
      { date: '2026-01-05', flowEur: 1000 },
      { date: '2026-01-06', flowEur: -1000 }, // the buy, wrongly treated as money leaving
    ];
    const corrupted = timeWeightedReturn(values, misclassified);
    // (1000 − (−1000)) / 1000 = 2 → a fictitious +100 % on the buy day.
    expect(corrupted[1]?.pct).toBeCloseTo(100, 9);
  });
});

// ---------------------------------------------------------------------------
// netWorthSeries — cash counts toward portfolio worth (#311)
// ---------------------------------------------------------------------------

describe('netWorthSeries', () => {
  it('returns an empty series when there are neither holdings values nor movements', () => {
    expect(netWorthSeries({ holdingsValues: [], movements: [], today: '2026-01-10' })).toEqual([]);
  });

  it('is the identity on the holdings curve when the ledger is empty', () => {
    const holdingsValues: ValuePoint[] = [
      { date: '2026-01-05', valueEur: 1000 },
      { date: '2026-01-06', valueEur: 1100 },
    ];
    expect(netWorthSeries({ holdingsValues, movements: [], today: '2026-01-06' })).toEqual(
      holdingsValues,
    );
  });

  it('renders a cash-only portfolio as a dense daily curve through today', () => {
    const movements = [
      mv('deposit', 1000, '2026-01-05T09:00:00Z'),
      mv('withdrawal', -250, '2026-01-07T09:00:00Z'),
    ];
    const series = netWorthSeries({ holdingsValues: [], movements, today: '2026-01-09' });
    expect(series).toEqual([
      { date: '2026-01-05', valueEur: 1000 },
      { date: '2026-01-06', valueEur: 1000 }, // carry-forward
      { date: '2026-01-07', valueEur: 750 },
      { date: '2026-01-08', valueEur: 750 },
      { date: '2026-01-09', valueEur: 750 },
    ]);
  });

  it('equals holdings value + end-of-day cash balance on every day of a known ledger fixture', () => {
    // Deposit 1000 on day 1; buy 400 of stock from cash on day 3 (holdings
    // curve starts at 400, flat close); sell for 150 back to cash on day 5
    // (holdings drop to 250 at flat prices — a real −37.5 % move on the sold
    // leg is irrelevant here, values are the fixture); withdraw 200 on day 6.
    const holdingsValues: ValuePoint[] = [
      { date: '2026-01-07', valueEur: 400 },
      { date: '2026-01-08', valueEur: 400 },
      { date: '2026-01-09', valueEur: 250 },
      { date: '2026-01-10', valueEur: 250 },
    ];
    const movements = [
      mv('deposit', 1000, '2026-01-05T09:00:00Z'),
      mv('buy', -400, '2026-01-07T10:00:00Z'),
      mv('sell_proceeds', 150, '2026-01-09T11:00:00Z'),
      mv('withdrawal', -200, '2026-01-10T12:00:00Z'),
    ];
    const series = netWorthSeries({ holdingsValues, movements, today: '2026-01-10' });
    // EOD cash: 1000, 1000, 600, 600, 750, 550. Holdings: 0, 0, 400, 400, 250, 250.
    expect(series).toEqual([
      { date: '2026-01-05', valueEur: 1000 },
      { date: '2026-01-06', valueEur: 1000 },
      { date: '2026-01-07', valueEur: 1000 },
      { date: '2026-01-08', valueEur: 1000 },
      { date: '2026-01-09', valueEur: 1000 },
      { date: '2026-01-10', valueEur: 800 },
    ]);
  });

  it('a deposit/withdrawal moves the curve by exactly its amount; a cash-funded buy does not move it', () => {
    const holdingsValues: ValuePoint[] = [
      { date: '2026-01-06', valueEur: 500 },
      { date: '2026-01-07', valueEur: 500 },
    ];
    const movements = [
      mv('deposit', 1000, '2026-01-05T09:00:00Z'),
      mv('buy', -500, '2026-01-06T10:00:00Z'), // funds the 500 of holdings above
      mv('withdrawal', -200, '2026-01-07T09:00:00Z'),
    ];
    const series = netWorthSeries({ holdingsValues, movements, today: '2026-01-07' });
    expect(series[0]).toEqual({ date: '2026-01-05', valueEur: 1000 }); // +1000: the deposit, exactly
    expect(series[1]).toEqual({ date: '2026-01-06', valueEur: 1000 }); // buy day: unchanged — money changed form
    expect(series[2]).toEqual({ date: '2026-01-07', valueEur: 800 }); // −200: the withdrawal, exactly
  });

  it('aggregates several same-day movements into one end-of-day balance', () => {
    const movements = [
      mv('deposit', 300, '2026-01-05T09:00:00Z'),
      mv('deposit', 700, '2026-01-05T15:00:00Z'),
      mv('withdrawal', -100, '2026-01-05T18:00:00Z'),
    ];
    const series = netWorthSeries({ holdingsValues: [], movements, today: '2026-01-05' });
    expect(series).toEqual([{ date: '2026-01-05', valueEur: 900 }]);
  });

  it('ignores movements dated after the series end', () => {
    const holdingsValues: ValuePoint[] = [{ date: '2026-01-05', valueEur: 100 }];
    const movements = [mv('deposit', 1000, '2026-02-01T09:00:00Z')];
    expect(netWorthSeries({ holdingsValues, movements, today: '2026-01-05' })).toEqual([
      { date: '2026-01-05', valueEur: 100 },
    ]);
    // Only future-dated movements and no holdings → nothing plottable.
    expect(netWorthSeries({ holdingsValues: [], movements, today: '2026-01-05' })).toEqual([]);
  });

  it('display path: renders a ledger that dips negative instead of throwing (write gates own solvency)', () => {
    // A cascade-deleted sell_proceeds can leave a withdrawal that once was
    // covered: the series shows the truth rather than 500ing the graph.
    const movements = [
      mv('withdrawal', -200, '2026-01-05T09:00:00Z'),
      mv('deposit', 1000, '2026-01-06T09:00:00Z'),
    ];
    const series = netWorthSeries({ holdingsValues: [], movements, today: '2026-01-06' });
    expect(series).toEqual([
      { date: '2026-01-05', valueEur: -200 },
      { date: '2026-01-06', valueEur: 800 },
    ]);
  });

  it('fails loud on malformed input', () => {
    expect(() => netWorthSeries({ holdingsValues: [], movements: [], today: 'not-a-day' })).toThrow(
      CashLedgerError,
    );
    expect(() =>
      netWorthSeries({
        holdingsValues: [{ date: '2026-01-05', valueEur: Number.NaN }],
        movements: [],
        today: '2026-01-05',
      }),
    ).toThrow(CashLedgerError);
    expect(() =>
      netWorthSeries({
        holdingsValues: [],
        movements: [mv('deposit', -5, '2026-01-05')], // sign contradicts kind
        today: '2026-01-05',
      }),
    ).toThrow(CashLedgerError);
  });

  it('composes with timeWeightedReturn: deposits and internal conversions both link flat', () => {
    // Deposit day, cash-funded buy day, then a genuine +10 % market move.
    const holdingsValues: ValuePoint[] = [
      { date: '2026-01-06', valueEur: 1000 },
      { date: '2026-01-07', valueEur: 1100 },
    ];
    const movements = [
      mv('deposit', 1000, '2026-01-05T09:00:00Z'),
      mv('buy', -1000, '2026-01-06T10:00:00Z'),
    ];
    const points = netWorthSeries({ holdingsValues, movements, today: '2026-01-07' });
    const perf = timeWeightedReturn(points, externalCashFlowsForTwr(movements));
    expect(perf.map((p) => p.pct)).toHaveLength(3);
    expect(perf[0]?.pct).toBeCloseTo(0, 9); // deposit: neutralized
    expect(perf[1]?.pct).toBeCloseTo(0, 9); // internal conversion: invisible
    expect(perf[2]?.pct).toBeCloseTo(10, 9); // the market move — and nothing else
  });
});

// ---------------------------------------------------------------------------
// V3-P3 — cash sources: per-source ledgers, transfers, set-balance
// ---------------------------------------------------------------------------

function smv(
  sourceId: string,
  kind: CashMovementKind,
  amountEur: number,
  occurredAt: string,
): SourcedCashMovement {
  return { sourceId, kind, amountEur, occurredAt };
}

describe('cashBalancesBySource', () => {
  it('sums each source independently and rolls up to the portfolio balance', () => {
    const movements = [
      smv('main', 'deposit', 1000, '2026-01-05T09:00:00Z'),
      smv('bank', 'deposit', 250, '2026-01-05T10:00:00Z'),
      smv('main', 'buy', -400, '2026-01-06T10:00:00Z'),
      smv('bank', 'withdrawal', -50, '2026-01-07T10:00:00Z'),
    ];
    const balances = cashBalancesBySource(movements);
    expect(balances.get('main')).toBe(600);
    expect(balances.get('bank')).toBe(200);
    // The portfolio roll-up is the union fed to the V2 balance function.
    expect(cashBalance(movements)).toBe(800);
    expect([...balances.values()].reduce((a, b) => a + b, 0)).toBe(cashBalance(movements));
  });

  it('omits sources without movements and fails loud on a missing sourceId', () => {
    expect(cashBalancesBySource([]).size).toBe(0);
    expect(() =>
      cashBalancesBySource([
        { kind: 'deposit', amountEur: 1, occurredAt: '2026-01-05', sourceId: '' },
      ]),
    ).toThrow(CashLedgerError);
  });
});

describe('projectCashLedgerBySource (per-source solvency gate)', () => {
  it('rejects a source overdraft even when another source holds plenty', () => {
    const movements = [
      smv('main', 'deposit', 10_000, '2026-01-05T09:00:00Z'),
      smv('bank', 'deposit', 100, '2026-01-05T10:00:00Z'),
      smv('bank', 'withdrawal', -150, '2026-01-06T10:00:00Z'), // bank has only 100
    ];
    let caught: unknown;
    try {
      projectCashLedgerBySource(movements);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InsufficientCashError);
    const rejection = caught as InsufficientCashError;
    expect(rejection.balanceEur).toBe(100);
    expect(rejection.shortfallEur).toBe(50);
    // The offending movement retains its source attribution.
    expect((rejection.movement as SourcedCashMovement).sourceId).toBe('bank');
  });

  it('projects each source chronologically and independently', () => {
    const movements = [
      smv('bank', 'transfer_in', 300, '2026-01-06T10:00:00Z'),
      smv('main', 'deposit', 1000, '2026-01-05T09:00:00Z'),
      smv('main', 'transfer_out', -300, '2026-01-06T10:00:00Z'),
      smv('main', 'buy', -500, '2026-01-07T10:00:00Z'),
    ];
    const projections = projectCashLedgerBySource(movements);
    expect([...projections.keys()].sort()).toEqual(['bank', 'main']);
    expect(projections.get('main')?.map((e) => e.balanceEur)).toEqual([1000, 700, 200]);
    expect(projections.get('bank')?.map((e) => e.balanceEur)).toEqual([300]);
  });

  it('per-source validity implies the portfolio-level union never dips negative', () => {
    const movements = [
      smv('main', 'deposit', 500, '2026-01-05T09:00:00Z'),
      smv('main', 'transfer_out', -500, '2026-01-06T10:00:00Z'),
      smv('bank', 'transfer_in', 500, '2026-01-06T10:00:00Z'),
      smv('bank', 'withdrawal', -500, '2026-01-07T10:00:00Z'),
    ];
    projectCashLedgerBySource(movements); // does not throw
    const union = projectCashLedger(movements); // neither does the roll-up
    expect(union.at(-1)?.balanceEur).toBe(0);
  });
});

describe('pairedTransferMovements', () => {
  it('builds mirrored double-entry legs sharing the timestamp', () => {
    const { outgoing, incoming } = pairedTransferMovements({
      fromSourceId: 'main',
      toSourceId: 'bank',
      amountEur: 500,
      occurredAt: '2026-02-01T12:00:00Z',
    });
    expect(outgoing).toEqual({
      kind: 'transfer_out',
      amountEur: -500,
      occurredAt: '2026-02-01T12:00:00Z',
      sourceId: 'main',
    });
    expect(incoming).toEqual({
      kind: 'transfer_in',
      amountEur: 500,
      occurredAt: '2026-02-01T12:00:00Z',
      sourceId: 'bank',
    });
    // The pair cancels in every roll-up.
    expect(cashBalance([outgoing, incoming])).toBe(0);
  });

  it('floors the magnitude to whole cents (#322/#370)', () => {
    const { outgoing, incoming } = pairedTransferMovements({
      fromSourceId: 'a',
      toSourceId: 'b',
      amountEur: 10.005,
      occurredAt: '2026-02-01T12:00:00Z',
    });
    // 10.005 floors down to 10.00 (never up to 10.01); the legs mirror exactly.
    expect(incoming.amountEur).toBe(10.0);
    expect(outgoing.amountEur).toBe(-10.0);
  });

  it('rejects same-source, non-positive, sub-cent and malformed inputs', () => {
    const base = { fromSourceId: 'a', toSourceId: 'b', occurredAt: '2026-02-01T12:00:00Z' };
    expect(() => pairedTransferMovements({ ...base, toSourceId: 'a', amountEur: 10 })).toThrow(
      CashLedgerError,
    );
    expect(() => pairedTransferMovements({ ...base, amountEur: 0 })).toThrow(CashLedgerError);
    expect(() => pairedTransferMovements({ ...base, amountEur: -5 })).toThrow(CashLedgerError);
    expect(() => pairedTransferMovements({ ...base, amountEur: 0.001 })).toThrow(CashLedgerError);
    expect(() => pairedTransferMovements({ ...base, amountEur: Number.NaN })).toThrow(
      CashLedgerError,
    );
    expect(() => pairedTransferMovements({ ...base, fromSourceId: '', amountEur: 10 })).toThrow(
      CashLedgerError,
    );
    expect(() =>
      pairedTransferMovements({ ...base, amountEur: 10, occurredAt: 'not-a-date' }),
    ).toThrow(CashLedgerError);
  });

  it('transfer legs are internal: never TWR flows, invisible to the net-worth curve', () => {
    expect(isExternalCashMovement('transfer_out')).toBe(false);
    expect(isExternalCashMovement('transfer_in')).toBe(false);

    const before = [
      smv('main', 'deposit', 1000, '2026-01-05T09:00:00Z'),
      smv('bank', 'deposit', 200, '2026-01-05T09:30:00Z'),
    ];
    const { outgoing, incoming } = pairedTransferMovements({
      fromSourceId: 'main',
      toSourceId: 'bank',
      amountEur: 500,
      occurredAt: '2026-01-06T10:00:00Z',
    });
    const after = [...before, outgoing, incoming];

    // Identical external-flow series…
    expect(externalCashFlowsForTwr(after)).toEqual(externalCashFlowsForTwr(before));
    // …and an identical net-worth curve, so the performance-% curve (a pure
    // function of the two) is unchanged by any internal transfer.
    const today = '2026-01-07';
    expect(netWorthSeries({ holdingsValues: [], movements: after, today })).toEqual(
      netWorthSeries({ holdingsValues: [], movements: before, today }),
    );
    const perfBefore = timeWeightedReturn(
      netWorthSeries({ holdingsValues: [], movements: before, today }),
      externalCashFlowsForTwr(before),
    );
    const perfAfter = timeWeightedReturn(
      netWorthSeries({ holdingsValues: [], movements: after, today }),
      externalCashFlowsForTwr(after),
    );
    expect(perfAfter).toEqual(perfBefore);
  });
});

describe('setBalanceDelta / setBalanceMovement', () => {
  it('computes the owner example exactly: €123.45 → €200.00 is +€76.55', () => {
    // Naive FP subtraction yields 76.55000000000001 — the delta must be exact.
    expect(setBalanceDelta(123.45, 200.0)).toBe(76.55);
    expect(123.45 + setBalanceDelta(123.45, 200.0)).toBe(200.0);
  });

  it('is symmetric for negative deltas: €200.00 → €123.45 is −€76.55', () => {
    expect(setBalanceDelta(200.0, 123.45)).toBe(-76.55);
    expect(200.0 + setBalanceDelta(200.0, 123.45)).toBe(123.45);
  });

  it('floors both operands to cents before differencing (#370)', () => {
    // 100.006 floors down to 100.00, so the recorded deposit is 100.00.
    expect(setBalanceDelta(0, 100.006)).toBe(100.0);
    expect(setBalanceDelta(100.004, 100.004)).toBe(0);
  });

  it('setting a balance to €0.00 withdraws everything, landing at exactly zero', () => {
    const delta = setBalanceDelta(123.45, 0);
    expect(delta).toBe(-123.45);
    expect(123.45 + delta).toBe(0);
  });

  it('rejects a negative or non-finite target and a non-finite current balance', () => {
    expect(() => setBalanceDelta(100, -1)).toThrow(CashLedgerError);
    expect(() => setBalanceDelta(100, Number.POSITIVE_INFINITY)).toThrow(CashLedgerError);
    expect(() => setBalanceDelta(Number.NaN, 100)).toThrow(CashLedgerError);
  });

  it('builds a normal deposit for a positive delta and a withdrawal for a negative one', () => {
    const up = setBalanceMovement({
      sourceId: 'bank',
      currentBalanceEur: 123.45,
      targetBalanceEur: 200.0,
      occurredAt: '2026-03-01T08:00:00Z',
    });
    expect(up).toEqual({
      kind: 'deposit',
      amountEur: 76.55,
      occurredAt: '2026-03-01T08:00:00Z',
      sourceId: 'bank',
    });

    const down = setBalanceMovement({
      sourceId: 'bank',
      currentBalanceEur: 200.0,
      targetBalanceEur: 123.45,
      occurredAt: '2026-03-01T08:00:00Z',
    });
    expect(down?.kind).toBe('withdrawal');
    expect(down?.amountEur).toBe(-76.55);
  });

  it('records nothing when the target equals the current balance', () => {
    expect(
      setBalanceMovement({
        sourceId: 'bank',
        currentBalanceEur: 200.0,
        targetBalanceEur: 200.0,
        occurredAt: '2026-03-01T08:00:00Z',
      }),
    ).toBeNull();
  });

  it('set-balance deltas are external flows, exactly like hand-entered deposits', () => {
    const movement = setBalanceMovement({
      sourceId: 'bank',
      currentBalanceEur: 0,
      targetBalanceEur: 500,
      occurredAt: '2026-03-01T08:00:00Z',
    });
    expect(movement).not.toBeNull();
    expect(isExternalCashMovement(movement!.kind)).toBe(true);
    expect(externalCashFlowsForTwr([movement!])).toEqual([{ date: '2026-03-01', flowEur: 500 }]);
  });
});

// --- spendableAsOf (backdated pay-from-cash, #378) --------------------------

describe('spendableAsOf', () => {
  /** The gate's own verdict: does inserting a buy of `cost` at `at` stay valid? */
  function gateAccepts(movements: CashMovement[], cost: number, at: string): boolean {
    try {
      projectCashLedger([...movements, mv('buy', -cost, at)]);
      return true;
    } catch (err) {
      if (err instanceof InsufficientCashError) return false;
      throw err;
    }
  }

  it('is 0 when the cash was only deposited AFTER the buy date (the #378 bug)', () => {
    // Buy SIE.DE dated 2025 for €400, but cash was first added in 2026.
    const movements = [mv('deposit', 500, '2026-02-01T00:00:00.000Z')];
    expect(spendableAsOf(movements, '2025-06-01T00:00:00.000Z')).toBe(0);
    // …and the gate agrees: a €400 buy backdated to 2025 would overdraw.
    expect(gateAccepts(movements, 400, '2025-06-01T00:00:00.000Z')).toBe(false);
  });

  it('is the balance already present when the deposit predates the buy', () => {
    const movements = [mv('deposit', 500, '2025-01-01T00:00:00.000Z')];
    expect(spendableAsOf(movements, '2025-06-01T00:00:00.000Z')).toBe(500);
    expect(gateAccepts(movements, 500, '2025-06-01T00:00:00.000Z')).toBe(true);
    expect(gateAccepts(movements, 500.01, '2025-06-01T00:00:00.000Z')).toBe(false);
  });

  it('takes the running MINIMUM from the buy instant on — a later withdrawal binds', () => {
    // €1000 in, then €900 withdrawn the next day: only €100 ever survives forward,
    // so a buy dated on the deposit day may spend at most €100, not €1000.
    const movements = [
      mv('deposit', 1000, '2026-01-01T00:00:00.000Z'),
      mv('withdrawal', -900, '2026-01-02T00:00:00.000Z'),
    ];
    expect(spendableAsOf(movements, '2026-01-01T00:00:00.000Z')).toBe(100);
    expect(gateAccepts(movements, 100, '2026-01-01T00:00:00.000Z')).toBe(true);
    expect(gateAccepts(movements, 150, '2026-01-01T00:00:00.000Z')).toBe(false);
  });

  it('counts a same-instant deposit as available to that instant (credits before debits)', () => {
    // A funding deposit sharing the buy day's timestamp funds that day's buy.
    const movements = [mv('deposit', 400, '2025-06-01T00:00:00.000Z')];
    expect(spendableAsOf(movements, '2025-06-01T00:00:00.000Z')).toBe(400);
    expect(gateAccepts(movements, 400, '2025-06-01T00:00:00.000Z')).toBe(true);
  });

  it('a buy dated at/after the newest movement yields the current balance (today path unchanged)', () => {
    const movements = [
      mv('deposit', 1000, '2026-01-01T00:00:00.000Z'),
      mv('buy', -300, '2026-01-05T00:00:00.000Z'),
    ];
    expect(spendableAsOf(movements, '2026-07-01T00:00:00.000Z')).toBe(700);
  });

  it('is 0 for an empty ledger', () => {
    expect(spendableAsOf([], '2025-06-01T00:00:00.000Z')).toBe(0);
  });

  it('matches the write-boundary gate across a mixed history (spendable is the exact cutover)', () => {
    const movements = [
      mv('deposit', 300, '2026-01-10T00:00:00.000Z'),
      mv('deposit', 500, '2026-03-01T00:00:00.000Z'),
      mv('withdrawal', -200, '2026-04-01T00:00:00.000Z'),
    ];
    const at = '2026-02-01T00:00:00.000Z'; // between the two deposits
    const spend = spendableAsOf(movements, at); // 300 (min from Feb on: 300, 800, 600)
    expect(spend).toBe(300);
    expect(gateAccepts(movements, spend, at)).toBe(true);
    expect(gateAccepts(movements, spend + 0.01, at)).toBe(false);
  });
});
