import { describe, expect, it } from 'vitest';

import {
  OversellError,
  QTY_EPSILON,
  QTY_STORAGE_QUANTUM,
  reducePosition,
  type Transaction,
} from '../holdings';
import {
  COST_BASIS_STRATEGIES,
  QTY_EPSILON as TAX_QTY_EPSILON,
  QTY_STORAGE_QUANTUM as TAX_QTY_STORAGE_QUANTUM,
  realizedSellsEur,
  TaxComputationError,
  type TaxableTransaction,
} from '../tax';
import vectorFile from './storageDrift.vectors.json';

/**
 * Storage-drift conformance vectors (#917 tax replay, #1094 holdings replay).
 *
 * The JSON file is the cross-language contract: ports (the mobile Kotlin port
 * pins its conformance vectors on this package) replay the same stored rows
 * and must land on the same waive/throw decision and the same realized
 * figures. This suite pins the reference implementation to the file, so a
 * behavior change here fails a test instead of silently drifting the ports.
 */

interface VectorTransaction {
  id: string;
  assetId: string;
  side: 'buy' | 'sell';
  quantity: number;
  price: number;
  fee: number;
  executedAt: string;
}

interface StorageDriftVector {
  id: string;
  summary: string;
  transactions: VectorTransaction[];
  expected: {
    holdings:
      | { quantity: number; avgCost: number; realizedPnl: number; tolerance: number }
      | { throws: string };
    tax:
      | { realizedPnlEur: number; uncoveredQuantity: number; tolerance: number }
      | { throws: string };
  };
}

interface StorageDriftVectorFile {
  version: number;
  quantum: number;
  epsilon: number;
  vectors: StorageDriftVector[];
}

const file = vectorFile as unknown as StorageDriftVectorFile;

const toHoldings = (t: VectorTransaction): Transaction => ({
  assetId: t.assetId,
  side: t.side,
  quantity: t.quantity,
  price: t.price,
  fee: t.fee,
  executedAt: t.executedAt,
});

const toTax = (t: VectorTransaction): TaxableTransaction => ({
  id: t.id,
  assetId: t.assetId,
  side: t.side,
  quantity: t.quantity,
  priceEur: t.price,
  feeEur: t.fee,
  executedAt: t.executedAt,
});

describe('storage-drift conformance vectors (#917/#1094)', () => {
  it('the published constants match both replay implementations', () => {
    expect(file.quantum).toBe(QTY_STORAGE_QUANTUM);
    expect(file.quantum).toBe(TAX_QTY_STORAGE_QUANTUM);
    expect(file.epsilon).toBe(QTY_EPSILON);
    expect(file.epsilon).toBe(TAX_QTY_EPSILON);
  });

  for (const vector of file.vectors) {
    describe(vector.id, () => {
      it('holdings replay (reducePosition) matches the vector', () => {
        const expected = vector.expected.holdings;
        if ('throws' in expected) {
          expect(expected.throws).toBe('OversellError');
          expect(() => reducePosition(vector.transactions.map(toHoldings))).toThrow(OversellError);
          return;
        }
        const pos = reducePosition(vector.transactions.map(toHoldings));
        expect(pos.quantity).toBe(expected.quantity);
        expect(pos.avgCost).toBe(expected.avgCost);
        expect(Math.abs(pos.realizedPnl - expected.realizedPnl)).toBeLessThanOrEqual(
          expected.tolerance,
        );
      });

      for (const strategy of COST_BASIS_STRATEGIES) {
        it(`tax replay (realizedSellsEur, ${strategy}) matches the vector`, () => {
          const expected = vector.expected.tax;
          if ('throws' in expected) {
            expect(expected.throws).toBe('TaxComputationError');
            expect(() => realizedSellsEur(vector.transactions.map(toTax), strategy)).toThrow(
              TaxComputationError,
            );
            return;
          }
          const sells = realizedSellsEur(vector.transactions.map(toTax), strategy);
          expect(sells).toHaveLength(1);
          expect(Math.abs(sells[0]!.realizedPnlEur - expected.realizedPnlEur)).toBeLessThanOrEqual(
            expected.tolerance,
          );
          expect(sells[0]!.uncoveredQuantity).toBe(expected.uncoveredQuantity);
        });
      }
    });
  }
});
