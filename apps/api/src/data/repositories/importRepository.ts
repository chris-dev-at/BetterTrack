import { and, asc, eq } from 'drizzle-orm';

import type { Database } from '../db';
import { assets, importBatches, importRows } from '../schema';
import type { ImportBatchRow, NewImportRowRow } from '../schema';

/**
 * Broker-import staging persistence (PROJECTPLAN.md §13.4 V4-P8). Batches and
 * their normalized rows are pure staging — applying a batch routes every
 * portfolio write through the portfolio/tax services, never through SQL here.
 * Every batch read is owner-scoped (`WHERE owner_id = :ownerId`), so a foreign
 * batch id is indistinguishable from a missing one — no IDOR by construction
 * (§8).
 */

/** Money columns parsed to `number` (DB stores `numeric`), nulls preserved. */
export interface ImportRowRecord {
  id: string;
  batchId: string;
  rowIndex: number;
  raw: string;
  kind: 'buy' | 'sell' | 'dividend' | 'deposit' | 'withdrawal' | null;
  flag: 'mapped' | 'unmapped' | 'duplicate' | 'error';
  message: string | null;
  executedAt: Date | null;
  isin: string | null;
  symbol: string | null;
  name: string | null;
  quantity: number | null;
  price: number | null;
  fee: number | null;
  amountEur: number | null;
  currency: string | null;
  note: string | null;
  assetId: string | null;
  contentHash: string | null;
  result: 'applied' | 'skipped_duplicate' | 'skipped_unmapped' | 'skipped_error' | 'failed' | null;
  resultMessage: string | null;
  /** Resolved catalog snapshot for display; null while/when unresolved. */
  asset: { id: string; symbol: string; name: string; currency: string } | null;
}

export interface CreateImportBatchInput {
  ownerId: string;
  portfolioId: string;
  brokerId: string;
  filename: string;
}

/** A staged row as the service normalizes it (ids/batch wiring added here). */
export interface StageImportRowInput {
  rowIndex: number;
  raw: string;
  kind: ImportRowRecord['kind'];
  flag: ImportRowRecord['flag'];
  message: string | null;
  executedAt: Date | null;
  isin: string | null;
  symbol: string | null;
  name: string | null;
  quantity: number | null;
  price: number | null;
  fee: number | null;
  amountEur: number | null;
  currency: string | null;
  note: string | null;
  assetId: string | null;
  contentHash: string | null;
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));

function toRowRecord(
  row: typeof importRows.$inferSelect,
  asset: ImportRowRecord['asset'],
): ImportRowRecord {
  return {
    id: row.id,
    batchId: row.batchId,
    rowIndex: row.rowIndex,
    raw: row.raw,
    kind: row.kind,
    flag: row.flag,
    message: row.message,
    executedAt: row.executedAt,
    isin: row.isin,
    symbol: row.symbol,
    name: row.name,
    quantity: num(row.quantity),
    price: num(row.price),
    fee: num(row.fee),
    amountEur: num(row.amountEur),
    currency: row.currency,
    note: row.note,
    assetId: row.assetId,
    contentHash: row.contentHash,
    result: row.result,
    resultMessage: row.resultMessage,
    asset,
  };
}

export function createImportRepository(db: Database) {
  /** Batch rows in file order, each joined with its resolved asset snapshot. */
  async function listRows(batchId: string): Promise<ImportRowRecord[]> {
    const rows = await db
      .select({ row: importRows, asset: assets })
      .from(importRows)
      .leftJoin(assets, eq(importRows.assetId, assets.id))
      .where(eq(importRows.batchId, batchId))
      .orderBy(asc(importRows.rowIndex), asc(importRows.id));
    return rows.map(({ row, asset }) =>
      toRowRecord(
        row,
        asset
          ? { id: asset.id, symbol: asset.symbol, name: asset.name, currency: asset.currency }
          : null,
      ),
    );
  }

  return {
    /** Persist a batch + its staged rows in one transaction (staging only, §13.4). */
    async createBatch(
      input: CreateImportBatchInput,
      rows: StageImportRowInput[],
    ): Promise<ImportBatchRow> {
      return db.transaction(async (tx) => {
        const [batch] = await tx
          .insert(importBatches)
          .values({
            ownerId: input.ownerId,
            portfolioId: input.portfolioId,
            brokerId: input.brokerId,
            filename: input.filename,
          })
          .returning();
        if (!batch) throw new Error('Import batch vanished after insert');
        if (rows.length > 0) {
          const values: NewImportRowRow[] = rows.map((r) => ({
            batchId: batch.id,
            rowIndex: r.rowIndex,
            raw: r.raw,
            kind: r.kind,
            flag: r.flag,
            message: r.message,
            executedAt: r.executedAt,
            isin: r.isin,
            symbol: r.symbol,
            name: r.name,
            quantity: r.quantity === null ? null : String(r.quantity),
            price: r.price === null ? null : String(r.price),
            fee: r.fee === null ? null : String(r.fee),
            amountEur: r.amountEur === null ? null : String(r.amountEur),
            currency: r.currency,
            note: r.note,
            assetId: r.assetId,
            contentHash: r.contentHash,
          }));
          await tx.insert(importRows).values(values);
        }
        return batch;
      });
    },

    /** A batch scoped to its owner (§8): null when unknown or foreign. */
    async findBatchForOwner(ownerId: string, batchId: string): Promise<ImportBatchRow | null> {
      const [row] = await db
        .select()
        .from(importBatches)
        .where(and(eq(importBatches.id, batchId), eq(importBatches.ownerId, ownerId)))
        .limit(1);
      return row ?? null;
    },

    listRows,

    /** Mark rows with their apply outcome (called row-by-row during apply). */
    async setRowResults(
      updates: Array<{
        id: string;
        result: NonNullable<ImportRowRecord['result']>;
        resultMessage: string | null;
        /** A fresh apply-time duplicate also flips the stored preview flag. */
        flag?: ImportRowRecord['flag'];
      }>,
    ): Promise<void> {
      if (updates.length === 0) return;
      await db.transaction(async (tx) => {
        for (const u of updates) {
          await tx
            .update(importRows)
            .set({
              result: u.result,
              resultMessage: u.resultMessage,
              ...(u.flag ? { flag: u.flag } : {}),
            })
            .where(eq(importRows.id, u.id));
        }
      });
    },

    /**
     * Atomically claim a pending batch for apply: flip `pending` → `applied`
     * (recording when + which cash source) in one compare-and-set, so exactly
     * one of any concurrent applies wins. Null when the batch was already
     * claimed — the caller answers 409, and no row is ever booked twice.
     */
    async claimPendingBatch(
      batchId: string,
      cashSourceId: string | null,
    ): Promise<ImportBatchRow | null> {
      const [row] = await db
        .update(importBatches)
        .set({ status: 'applied', appliedAt: new Date(), cashSourceId })
        .where(and(eq(importBatches.id, batchId), eq(importBatches.status, 'pending')))
        .returning();
      return row ?? null;
    },

    /** Hard-delete an owned batch (rows cascade). False when not owned. */
    async deleteBatchForOwner(ownerId: string, batchId: string): Promise<boolean> {
      const rows = await db
        .delete(importBatches)
        .where(and(eq(importBatches.id, batchId), eq(importBatches.ownerId, ownerId)))
        .returning({ id: importBatches.id });
      return rows.length > 0;
    },
  };
}

export type ImportRepository = ReturnType<typeof createImportRepository>;
