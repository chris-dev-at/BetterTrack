/**
 * Storage-drift conformance vectors — issue #1094 (extends #917).
 *
 * The F1 fixture, executed against `numeric(20,8)` storage: four raw buys of
 * `0.1000000049` and one sell of their exact raw sum `0.4000000196` pass the
 * write path's epsilon validation on the RAW values; PostgreSQL then rounds
 * each row independently to scale 8, so the stored log every later replay
 * sees is `0.10000000 × 4` buys against a `0.40000002` sell — a `2e-8`
 * shortfall that is a persistence artifact, not an oversell. Both shared
 * replays (`holdings.reducePosition`, `tax.realizedSellsEur`) waive a
 * shortfall within one `QTY_STORAGE_QUANTUM` (`1e-8`) per contributing stored
 * row and close the position exactly; anything beyond the envelope fails
 * closed.
 *
 * Like `domain/**` itself this module imports nothing: pure data + types,
 * every number a literal. It is a **conformance vector** for the mobile
 * Kotlin port (which pins `packages/domain` vectors — standing board
 * obligation, §16 2026-08-04): both vectors must replay identically there.
 * `holdings.test.ts` and `tax.test.ts` pin them here.
 */

export interface StorageDriftVectorRow {
  id: string;
  side: 'buy' | 'sell';
  /** Stored quantity — the post-`numeric(20,8)` readback value, not the raw input. */
  quantity: number;
  /** Price per unit (native currency; the tax pin reads it as EUR). */
  price: number;
  fee: number;
  executedAt: string;
}

export interface StorageDriftVectorOutcome {
  /** `true` → the replay must reject the log (OversellError / TaxComputationError). */
  throws: boolean;
  /** Exact final held quantity (asserted with `toBe`). Only when `throws` is false. */
  quantity?: number;
  /** Expected realized P/L; asserted within {@link realizedPnlTolerance}. */
  realizedPnl?: number;
  realizedPnlTolerance?: number;
}

export interface StorageDriftVector {
  name: string;
  description: string;
  rows: readonly StorageDriftVectorRow[];
  expected: StorageDriftVectorOutcome;
}

/**
 * The raw client inputs of the F1 fixture — what the write path validated
 * BEFORE storage rounded the rows apart. Recorded for integration tests that
 * construct the stored-drift state through a real `numeric(20,8)` column.
 */
export const F1_RAW_BUY_QUANTITY = 0.1000000049;
export const F1_RAW_SELL_QUANTITY = 0.4000000196;

/**
 * F1 through the storage oracle: the stored shortfall is `2e-8`, within the
 * five contributing rows' `5e-8` envelope — the replay must close the
 * position at exactly 0 with the drift dust realizing at the sale price
 * (0 gain), so the P/L is the covered `0.4 × (60 − 50) = 4`.
 */
export const F1_STORED_DRIFT_VECTOR: StorageDriftVector = {
  name: 'f1-stored-drift',
  description:
    '4 raw buys of 0.1000000049 + a sell of their exact raw sum 0.4000000196, ' +
    'as stored by numeric(20,8): buys 0.10000000 each, sell 0.40000002. ' +
    'Within the per-row envelope — replays cleanly to a flat position.',
  rows: [
    {
      id: 'f1-b1',
      side: 'buy',
      quantity: 0.1,
      price: 50,
      fee: 0,
      executedAt: '2026-01-01T10:00:00Z',
    },
    {
      id: 'f1-b2',
      side: 'buy',
      quantity: 0.1,
      price: 50,
      fee: 0,
      executedAt: '2026-01-02T10:00:00Z',
    },
    {
      id: 'f1-b3',
      side: 'buy',
      quantity: 0.1,
      price: 50,
      fee: 0,
      executedAt: '2026-01-03T10:00:00Z',
    },
    {
      id: 'f1-b4',
      side: 'buy',
      quantity: 0.1,
      price: 50,
      fee: 0,
      executedAt: '2026-01-04T10:00:00Z',
    },
    {
      id: 'f1-s1',
      side: 'sell',
      quantity: 0.40000002,
      price: 60,
      fee: 0,
      executedAt: '2026-01-05T10:00:00Z',
    },
  ],
  expected: { throws: false, quantity: 0, realizedPnl: 4, realizedPnlTolerance: 1e-6 },
};

/**
 * The same buys against a genuinely oversold sell: a `6e-8` shortfall exceeds
 * the five contributing rows' `5e-8` envelope (+`1e-9` epsilon) and can never
 * be numeric(20,8) rounding drift — the replay must fail closed.
 */
export const F1_BEYOND_ENVELOPE_VECTOR: StorageDriftVector = {
  name: 'f1-beyond-envelope',
  description:
    'The F1 stored buys against a sell of 0.40000006: beyond the per-row ' +
    'envelope — the replay must throw.',
  rows: [
    {
      id: 'f1-b1',
      side: 'buy',
      quantity: 0.1,
      price: 50,
      fee: 0,
      executedAt: '2026-01-01T10:00:00Z',
    },
    {
      id: 'f1-b2',
      side: 'buy',
      quantity: 0.1,
      price: 50,
      fee: 0,
      executedAt: '2026-01-02T10:00:00Z',
    },
    {
      id: 'f1-b3',
      side: 'buy',
      quantity: 0.1,
      price: 50,
      fee: 0,
      executedAt: '2026-01-03T10:00:00Z',
    },
    {
      id: 'f1-b4',
      side: 'buy',
      quantity: 0.1,
      price: 50,
      fee: 0,
      executedAt: '2026-01-04T10:00:00Z',
    },
    {
      id: 'f1-s1',
      side: 'sell',
      quantity: 0.40000006,
      price: 60,
      fee: 0,
      executedAt: '2026-01-05T10:00:00Z',
    },
  ],
  expected: { throws: true },
};

export const STORAGE_DRIFT_VECTORS: readonly StorageDriftVector[] = [
  F1_STORED_DRIFT_VECTOR,
  F1_BEYOND_ENVELOPE_VECTOR,
];
