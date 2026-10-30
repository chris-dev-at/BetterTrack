import { describe, expect, it } from 'vitest';

import { findVanishedHoldings } from '../portfolioSnapshots';

/**
 * Issue #1729, guard (a): the persist-time check that a recomputation did not
 * lose a still-held asset the last kept row carries. Pure, so the holding
 * semantics (which must mirror `valueOverTime`'s quantity walk) are pinned
 * case by case here; the end-to-end refusal lives in `snapshotJobs.test.ts`.
 */

const A = 'asset-a';
const B = 'asset-b';

function txn(assetId: string, side: 'buy' | 'sell', quantity: number, day: string) {
  return { assetId, side, quantity, executedAt: new Date(`${day}T10:00:00.000Z`) };
}

function row(date: string, assetValues: Record<string, number>) {
  return { date, assetValues };
}

const anchor = row('2026-08-07', { [A]: 480, [B]: 200 });

describe('findVanishedHoldings', () => {
  it('reports a held asset missing from the rows after the anchor, at its first such day', () => {
    const rows = [row('2026-08-08', { [B]: 200 }), row('2026-08-09', { [B]: 200 })];
    const txns = [txn(A, 'buy', 3, '2026-07-01'), txn(B, 'buy', 2, '2026-07-01')];
    expect(findVanishedHoldings(anchor, rows, txns)).toEqual([{ assetId: A, day: '2026-08-08' }]);
  });

  it('passes a computation that keeps every anchored asset keyed', () => {
    const rows = [row('2026-08-08', { [A]: 470, [B]: 200 }), row('2026-08-09', { [A]: 0, [B]: 0 })];
    const txns = [txn(A, 'buy', 3, '2026-07-01'), txn(B, 'buy', 2, '2026-07-01')];
    expect(findVanishedHoldings(anchor, rows, txns)).toEqual([]);
  });

  it('does not mistake a position fully sold before the written days for a drop', () => {
    const rows = [row('2026-08-08', { [B]: 200 })];
    const txns = [
      txn(A, 'buy', 3, '2026-07-01'),
      txn(A, 'sell', 3, '2026-08-01'),
      txn(B, 'buy', 2, '2026-07-01'),
    ];
    expect(findVanishedHoldings(anchor, rows, txns)).toEqual([]);
  });

  it('does not mistake an asset whose transactions were deleted for a drop', () => {
    const rows = [row('2026-08-08', { [B]: 200 })];
    expect(findVanishedHoldings(anchor, rows, [txn(B, 'buy', 2, '2026-07-01')])).toEqual([]);
  });

  it('reports a position sold inside the written range — it was still held on the first day', () => {
    const rows = [row('2026-08-08', { [B]: 200 }), row('2026-08-09', { [B]: 200 })];
    const txns = [txn(A, 'buy', 3, '2026-07-01'), txn(A, 'sell', 3, '2026-08-09')];
    expect(findVanishedHoldings(anchor, rows, txns)).toEqual([{ assetId: A, day: '2026-08-08' }]);
  });

  it('reports a flat position re-bought inside the written range, at the re-buy day', () => {
    const rows = [
      row('2026-08-08', { [B]: 200 }),
      row('2026-08-09', { [B]: 200 }),
      row('2026-08-10', { [B]: 200 }),
    ];
    const txns = [
      txn(A, 'buy', 3, '2026-07-01'),
      txn(A, 'sell', 3, '2026-08-01'),
      txn(A, 'buy', 1, '2026-08-10'),
    ];
    expect(findVanishedHoldings(anchor, rows, txns)).toEqual([{ assetId: A, day: '2026-08-10' }]);
  });

  it('walks a same-day close-and-reopen like the engine: flat clamps to 0, then the buy holds', () => {
    const rows = [row('2026-08-08', { [B]: 200 })];
    const txns = [
      txn(A, 'buy', 3, '2026-07-01'),
      txn(A, 'sell', 3, '2026-08-08'),
      txn(A, 'buy', 2, '2026-08-08'),
    ];
    expect(findVanishedHoldings(anchor, rows, txns)).toEqual([{ assetId: A, day: '2026-08-08' }]);
  });

  it('treats sub-epsilon dust as flat, exactly like valueOverTime', () => {
    const rows = [row('2026-08-08', { [B]: 200 })];
    const txns = [txn(A, 'buy', 1, '2026-07-01'), txn(A, 'sell', 1 - 1e-12, '2026-08-01')];
    expect(findVanishedHoldings(anchor, rows, txns)).toEqual([]);
  });

  it('ignores rows on or before the anchor — those are not written by this persist', () => {
    const rows = [row('2026-08-06', { [B]: 200 }), row('2026-08-07', { [B]: 200 })];
    const txns = [txn(A, 'buy', 3, '2026-07-01')];
    expect(findVanishedHoldings(anchor, rows, txns)).toEqual([]);
  });

  it('only guards assets the anchor carries — an asset new to the rows is not compared', () => {
    const fresh = row('2026-08-07', { [B]: 200 });
    const rows = [row('2026-08-08', { [B]: 200 })];
    const txns = [txn(A, 'buy', 3, '2026-07-01'), txn(B, 'buy', 2, '2026-07-01')];
    expect(findVanishedHoldings(fresh, rows, txns)).toEqual([]);
  });
});
