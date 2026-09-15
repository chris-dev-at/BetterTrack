/**
 * The one bounded-drain used by every scheduled retention sweep.
 *
 * A retention job that issues a single `DELETE … WHERE created_at < cutoff` runs
 * one transaction over the whole eligible range: it holds locks for as long as
 * that takes, and — because the row count is unbounded — it can be killed by a
 * statement timeout or exhaust the worker before it converges, so the table
 * never actually shrinks. Draining in fixed batches makes each statement small
 * and the sweep restartable; a short batch proves nothing eligible remains.
 */

/** Delete at most `limit` rows older than `cutoff`; resolves to how many went. */
export type BoundedDelete = (cutoff: Date, limit: number) => Promise<number>;

export interface BatchedDeleteResult {
  deleted: number;
  /** True when the per-run ceiling stopped the drain before it converged. */
  capped: boolean;
}

/** Nothing was eligible (or the window is "retain forever"). */
export const NOTHING_PRUNED: BatchedDeleteResult = { deleted: 0, capped: false };

/**
 * Repeat `deleteOlderThan` in `batchSize` slices until a short batch proves the
 * cutoff is drained, or until `maxRows` defers the rest to the next scheduled
 * run. Rows past the ceiling are not dropped — the cutoff rule is recomputed
 * next run and they remain eligible.
 */
export async function deleteInBatches(
  deleteOlderThan: BoundedDelete,
  cutoff: Date,
  batchSize: number,
  maxRows: number,
): Promise<BatchedDeleteResult> {
  let total = 0;
  while (total < maxRows) {
    const limit = Math.min(batchSize, maxRows - total);
    const deleted = await deleteOlderThan(cutoff, limit);
    total += deleted;
    if (deleted < limit) return { deleted: total, capped: false };
  }
  return { deleted: total, capped: true };
}

/** Shared guard so a mis-tuned sweep fails at construction, not at 03:00. */
export function assertBatchBounds(label: string, batchSize: number, maxRowsPerRun: number): void {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error(`${label} batch size must be a positive integer`);
  }
  if (!Number.isSafeInteger(maxRowsPerRun) || maxRowsPerRun < batchSize) {
    throw new Error(`${label} per-run ceiling must be an integer at least one batch wide`);
  }
}
