import { and, asc, eq, exists, sql } from 'drizzle-orm';

import type {
  ImportRowCandidate,
  ImportRowResolvedBy,
  ImportUnderstanding,
} from '@bettertrack/contracts';

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
  /**
   * Near-match suggestions for an UNRESOLVED identity (§13.4): ranked hits the
   * search already returned that did not match exactly. Display only — the row
   * stays `unmapped` and is never auto-applied. Null when none were captured.
   */
  candidates: ImportRowCandidate[] | null;
  /**
   * The tag ids the owner's own cash rules assigned to this row's memo at
   * STAGING time (#964). Null on non-cash rows, on rows with no memo, and
   * wherever no rule matched. Apply replays exactly this list, so the preview
   * and the booked movement cannot disagree.
   */
  ruleTagIds: string[] | null;
  /**
   * Provenance for {@link ImportRowRecord.assetId} (#964): null when the
   * pipeline matched the instrument exactly, `'user'` when a person pinned it
   * in the wizard — or confirmed the row's KIND. Never a model.
   */
  resolvedBy: ImportRowResolvedBy | null;
  /**
   * True while this row's KIND is still an open question (§16 2026-08-29): the
   * fields above are what staging parsed (with `amountEur` SIGNED as the file
   * wrote it) and `kind` is null because the classifier would not name one.
   * The wire flag is `error` — that vocabulary is frozen — so this is the only
   * thing that tells a confirmable row from an unreadable one.
   */
  kindUndecided: boolean;
}

export interface CreateImportBatchInput {
  ownerId: string;
  portfolioId: string;
  brokerId: string;
  filename: string;
  /**
   * What the GENERIC pipeline understood about the file (#964). Null for every
   * batch a broker mapper claimed — that path labels no columns.
   */
  understanding?: ImportUnderstanding | null;
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
  candidates: ImportRowCandidate[] | null;
  ruleTagIds: string[] | null;
  /** See {@link ImportRowRecord.kindUndecided}. Omitted ⇒ decided, as before. */
  kindUndecided?: boolean;
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
    candidates: row.candidates ?? null,
    ruleTagIds: row.ruleTagIds ?? null,
    resolvedBy: row.resolvedBy ?? null,
    kindUndecided: row.kindUndecided,
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
            understanding: input.understanding ?? null,
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
            candidates: r.candidates,
            ruleTagIds: r.ruleTagIds,
            kindUndecided: r.kindUndecided ?? false,
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
     * Re-point ONE staged row at the asset a person pinned (#964), together
     * with everything that derives from it: the preview verdict, its
     * explanation, the recomputed content hash, and the provenance stamp.
     *
     * CONDITIONAL ON THE BATCH STILL BEING PENDING, and that is the whole point
     * of the correlated `EXISTS` rather than a bare `WHERE id = …`.
     *
     * The service checks `pending` and then awaits four more things — the row
     * list, the asset, the portfolio's existing content hashes — before it gets
     * here. `applyBatch` can claim the batch anywhere in that gap. An
     * unconditional write would then stamp a row `mapped` + `resolvedBy: user`
     * on a batch that has already finished applying, leaving the user with a
     * row the preview calls pinned, whose apply outcome says `skipped_unmapped`,
     * whose money was never booked, and which can never be applied because every
     * retry is a 409. Folding the check INTO the write closes the window
     * entirely: check and write are one statement, so there is no interval for
     * the claim to land in.
     *
     * Same compare-and-set shape `claimPendingBatch` uses for the batch itself,
     * for the same reason. Returns whether the row was written; false means the
     * batch was claimed first and the caller owes the client a 409.
     */
    async setRowResolution(update: {
      id: string;
      assetId: string;
      flag: ImportRowRecord['flag'];
      message: string | null;
      contentHash: string;
      resolvedBy: ImportRowResolvedBy;
    }): Promise<boolean> {
      const rows = await db
        .update(importRows)
        .set({
          assetId: update.assetId,
          flag: update.flag,
          message: update.message,
          contentHash: update.contentHash,
          resolvedBy: update.resolvedBy,
        })
        .where(
          and(
            eq(importRows.id, update.id),
            exists(
              db
                .select({ one: sql`1` })
                .from(importBatches)
                .where(
                  and(
                    eq(importBatches.id, importRows.batchId),
                    eq(importBatches.status, 'pending'),
                  ),
                ),
            ),
          ),
        )
        .returning({ id: importRows.id });
      return rows.length > 0;
    },

    /**
     * RE-STAGE ONE ROW around the kind a person confirmed (§16 2026-08-29 gap
     * (b)) — every column the derivation produced, in one statement.
     *
     * It is a full row rewrite rather than a `kind` stamp because a kind is not
     * a label on the row: it decides which columns survive (a cash movement
     * carries no instrument identity, a trade carries no `amount_eur`), which
     * magnitudes are stored, whether an asset was resolved, what the content
     * hash is, and which cash-rule tags apply. Writing less would leave the row
     * describing a shape it no longer has.
     *
     * `kind_undecided` flips to FALSE in the same statement, which is what
     * makes confirmation ONE-SHOT: the parsed identity a cash derivation
     * discards cannot be re-derived from, so a second confirmation would be
     * deriving from an already-shaped row. The service refuses it, and this
     * write is where the refusal becomes a fact rather than a check.
     *
     * CONDITIONAL ON THE BATCH STILL BEING PENDING, for the reason
     * {@link setRowResolution} spells out in full: the service awaits several
     * reads between its own `pending` check and this write, `applyBatch` can
     * claim the batch in that gap, and an unconditional write would leave a row
     * the preview calls importable on a batch that has already finished. Check
     * and write are one statement, so there is no interval to lose.
     *
     * Returns whether the row was written; false means the claim won and the
     * caller owes the client a 409.
     */
    async confirmRowKind(update: {
      id: string;
      kind: NonNullable<ImportRowRecord['kind']>;
      flag: ImportRowRecord['flag'];
      message: string | null;
      executedAt: Date;
      isin: string | null;
      symbol: string | null;
      name: string | null;
      quantity: number | null;
      price: number | null;
      fee: number | null;
      amountEur: number | null;
      currency: string;
      note: string | null;
      assetId: string | null;
      contentHash: string;
      candidates: ImportRowCandidate[] | null;
      ruleTagIds: string[] | null;
      resolvedBy: ImportRowResolvedBy;
    }): Promise<boolean> {
      const rows = await db
        .update(importRows)
        .set({
          kind: update.kind,
          flag: update.flag,
          message: update.message,
          executedAt: update.executedAt,
          isin: update.isin,
          symbol: update.symbol,
          name: update.name,
          quantity: update.quantity === null ? null : String(update.quantity),
          price: update.price === null ? null : String(update.price),
          fee: update.fee === null ? null : String(update.fee),
          amountEur: update.amountEur === null ? null : String(update.amountEur),
          currency: update.currency,
          note: update.note,
          assetId: update.assetId,
          contentHash: update.contentHash,
          candidates: update.candidates,
          ruleTagIds: update.ruleTagIds,
          resolvedBy: update.resolvedBy,
          kindUndecided: false,
        })
        .where(
          and(
            eq(importRows.id, update.id),
            // Belt and braces with the service's own check: only a row whose
            // kind is genuinely open may be written by this path, so a race
            // between two confirmations of the same row resolves to one winner
            // in the database rather than in whichever request read first.
            eq(importRows.kindUndecided, true),
            exists(
              db
                .select({ one: sql`1` })
                .from(importBatches)
                .where(
                  and(
                    eq(importBatches.id, importRows.batchId),
                    eq(importBatches.status, 'pending'),
                  ),
                ),
            ),
          ),
        )
        .returning({ id: importRows.id });
      return rows.length > 0;
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
