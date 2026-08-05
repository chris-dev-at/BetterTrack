import { and, asc, eq, sql } from 'drizzle-orm';

import type { Database } from '../db';
import { portfolioCashMovements } from '../schema';
import type { CashMovementRow } from '../schema';
import { restampMovementTags, stampMovementTags } from './cashSystemTagStamp';

/**
 * Per-portfolio cash-ledger persistence (PROJECTPLAN.md §14, #220/#278; cash
 * sources V3-P3 §13.3).
 *
 * Every movement is a reconciling row with a **signed** EUR amount, so the
 * current balance is literally the sum of the rows — computed by
 * `domain/cashLedger.cashBalance` (per source or rolled up), never stored. This
 * repository is a thin data seam: it inserts and lists movements; the sign/kind
 * invariant and the per-source no-negative-balance gate live in the pure domain
 * engine and the service that calls it. Linked `buy` / `sell_proceeds`
 * movements are written atomically with their transaction on the transaction
 * path (see `transactionRepository`); the two legs of a transfer are written in
 * one INSERT statement here, so a mid-transfer failure leaves neither behind.
 *
 * Reads are scoped to a `portfolio_id` the caller has already been authorised
 * for by the service (the portfolio ownership check precedes every call).
 */

type Kind = CashMovementRow['kind'];

/** A cash movement with its EUR amount parsed to `number` (DB stores `numeric`). */
export interface CashMovementRecord {
  id: string;
  portfolioId: string;
  /** The cash source this movement belongs to (V3-P3). */
  sourceId: string;
  kind: Kind;
  /** Signed EUR amount, full precision (inflows > 0, outflows < 0). */
  amountEur: number;
  transactionId: string | null;
  /** Pairing id shared by both legs of one transfer; null otherwise (V3-P3). */
  transferId: string | null;
  /** The other leg's source on a transfer leg; null otherwise (V3-P3). */
  counterpartSourceId: string | null;
  /** The dividend a `dividend` inflow / its tax settlement belongs to (V3-P4). */
  dividendId: string | null;
  /** Vienna tax year of a `tax_withholding` / `tax_refund`; null otherwise (V3-P4). */
  taxYear: number | null;
  executedAt: Date;
  note: string | null;
  /** Source tag (V5-P0c): how this movement entered the ledger; `manual` for hand entry. */
  source: string;
  /**
   * Provenance for a row that entered from a NON-EUR feed (V5 cash fusion).
   * `amountEur` stays the single authoritative figure and the ledger never reads
   * this; NULL means the amount is genuinely EUR. Surfaced so the ledger can mark
   * a magnitude that was carried over 1:1 and still needs an FX pass.
   */
  originalCurrency: string | null;
  createdAt: Date;
}

/** Fields for a single insert; `amountEur` arrives signed as a `number`. */
export interface NewCashMovement {
  sourceId: string;
  kind: Kind;
  amountEur: number;
  executedAt: Date;
  note: string | null;
  transactionId?: string | null;
  transferId?: string | null;
  counterpartSourceId?: string | null;
  dividendId?: string | null;
  taxYear?: number | null;
  /** Source tag (V5-P0c); defaults to `manual`. Server-assigned only. */
  source?: string;
}

function toRecord(row: CashMovementRow): CashMovementRecord {
  return {
    id: row.id,
    portfolioId: row.portfolioId,
    sourceId: row.sourceId,
    kind: row.kind,
    amountEur: Number(row.amountEur),
    transactionId: row.transactionId ?? null,
    transferId: row.transferId ?? null,
    counterpartSourceId: row.counterpartSourceId ?? null,
    dividendId: row.dividendId ?? null,
    taxYear: row.taxYear ?? null,
    executedAt: row.executedAt,
    note: row.note ?? null,
    source: row.source,
    originalCurrency: row.originalCurrency ?? null,
    createdAt: row.createdAt,
  };
}

function toInsertValues(portfolioId: string, movement: NewCashMovement) {
  return {
    portfolioId,
    sourceId: movement.sourceId,
    kind: movement.kind,
    amountEur: String(movement.amountEur),
    transactionId: movement.transactionId ?? null,
    transferId: movement.transferId ?? null,
    counterpartSourceId: movement.counterpartSourceId ?? null,
    dividendId: movement.dividendId ?? null,
    taxYear: movement.taxYear ?? null,
    executedAt: movement.executedAt,
    note: movement.note,
    source: movement.source ?? 'manual',
  };
}

export type CashMovementTransactionExecutor = Pick<Database, 'execute' | 'select' | 'insert'>;

/** A transaction that can participate in the portfolio-wide mutation lock. */
export type PortfolioMutationTransactionExecutor = Pick<Database, 'execute'>;

type CashMovementUpdatePatch = {
  sourceId: string;
  kind: Kind;
  amountEur: number;
  executedAt: Date;
  note: string | null;
};

/**
 * Serialize per-portfolio mutations whose correctness depends on one coherent
 * active ledger/portfolio boundary. Cash-ledger mutations use it for the
 * solvency gate and open-year tax reconciler; archive transitions use it to
 * close that same boundary against standing-order writes.
 *
 * Keying is deliberately per portfolio: PostgreSQL's one-int advisory-lock
 * namespace receives `hashtext(portfolioId)`. The same UUID therefore always
 * shares one lock across cash writes, transaction/dividend deletes, tax
 * reconciliation, archive transitions and standing-order execution. A rare
 * 32-bit hash collision only serializes two unrelated portfolios; it cannot
 * weaken correctness. Because this is an xact lock, PostgreSQL releases it
 * automatically on commit/rollback.
 *
 * Every participating path takes this lock before reading or mutating ledger
 * rows. Keeping that advisory-lock-first order avoids a cycle with parent-row
 * deletes, whose cash movements cascade while the same transaction holds it.
 */
export async function lockPortfolioMutationInTransaction(
  tx: PortfolioMutationTransactionExecutor,
  portfolioId: string,
): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${portfolioId}))`);
}

/**
 * Cash-ledger callers use the portfolio mutation lock too. Archive transitions
 * participate in the same lock, so a portfolio cannot become archived between
 * a standing order's active check and its money write.
 */
export async function lockPortfolioCashLedgerInTransaction(
  tx: CashMovementTransactionExecutor,
  portfolioId: string,
): Promise<void> {
  await lockPortfolioMutationInTransaction(tx, portfolioId);
}

/** Read one portfolio's ledger through the caller's current transaction. */
export async function listPortfolioCashMovementsInTransaction(
  tx: Pick<Database, 'select'>,
  portfolioId: string,
): Promise<CashMovementRecord[]> {
  const rows = await tx
    .select()
    .from(portfolioCashMovements)
    .where(eq(portfolioCashMovements.portfolioId, portfolioId))
    .orderBy(asc(portfolioCashMovements.executedAt), asc(portfolioCashMovements.id));
  return rows.map(toRecord);
}

/** Insert and auto-tag cash movements inside a transaction the caller owns. */
export async function insertCashMovementsInTransaction(
  tx: CashMovementTransactionExecutor,
  portfolioId: string,
  movements: readonly NewCashMovement[],
): Promise<CashMovementRecord[]> {
  if (movements.length === 0) return [];
  const rows = await tx
    .insert(portfolioCashMovements)
    .values(movements.map((movement) => toInsertValues(portfolioId, movement)))
    .returning();
  await stampMovementTags(tx, portfolioId, rows);
  return rows.map(toRecord);
}

/**
 * Reconcile movements inside a transaction the caller already owns.
 *
 * The deliberately narrow executor excludes `transaction`, so this primitive
 * cannot open or control a nested boundary. Its advisory lock and fresh read
 * therefore remain part of the caller's atomic operation.
 */
export async function insertReconciledCashMovementsInTransaction(
  tx: CashMovementTransactionExecutor,
  portfolioId: string,
  plan: (fresh: CashMovementRecord[]) => NewCashMovement[],
): Promise<CashMovementRecord[]> {
  await lockPortfolioCashLedgerInTransaction(tx, portfolioId);
  const fresh = await listPortfolioCashMovementsInTransaction(tx, portfolioId);
  const movements = plan(fresh);
  // Auto-tagging rides inside the caller's transaction, so a rolled-back
  // reconciliation takes its labels with it (V5 cash fusion).
  return insertCashMovementsInTransaction(tx, portfolioId, movements);
}

export function createCashMovementRepository(db: Database) {
  return {
    /** Record a single cash movement (deposit/withdrawal — external, unlinked). */
    async insert(
      portfolioId: string,
      movement: NewCashMovement,
      executor: Database = db,
    ): Promise<CashMovementRecord> {
      const [row] = await executor
        .insert(portfolioCashMovements)
        .values(toInsertValues(portfolioId, movement))
        .returning();
      if (!row) throw new Error('Cash movement insert returned no row');
      await stampMovementTags(executor, portfolioId, [row]);
      return toRecord(row);
    },

    /**
     * Lock, re-read and validate immediately before inserting one movement.
     * Ownership/source resolution stays in the service; this transaction is
     * intentionally only the solvency-check + money-write critical section.
     */
    async insertWithCashLedgerLock(
      portfolioId: string,
      movement: NewCashMovement,
      validate: (fresh: readonly CashMovementRecord[]) => void,
    ): Promise<CashMovementRecord> {
      return db.transaction(async (tx) => {
        await lockPortfolioCashLedgerInTransaction(tx, portfolioId);
        const fresh = await listPortfolioCashMovementsInTransaction(tx, portfolioId);
        validate(fresh);
        const [inserted] = await insertCashMovementsInTransaction(tx, portfolioId, [movement]);
        if (!inserted) throw new Error('Cash movement insert returned no row');
        return inserted;
      });
    },

    /**
     * Insert movements a reconciler derived from a *stale* read, guarded
     * against a concurrent reconciler (#635 review): one transaction takes a
     * per-portfolio advisory lock, re-reads the portfolio's movements fresh,
     * and inserts only what `plan` still confirms against that read — so two
     * concurrent report reads can never both post the same tax correction.
     * `plan` must be pure over its argument (it may be skipped entirely when
     * it returns nothing).
     */
    async insertReconciled(
      portfolioId: string,
      plan: (fresh: CashMovementRecord[]) => NewCashMovement[],
    ): Promise<CashMovementRecord[]> {
      return db.transaction((tx) =>
        insertReconciledCashMovementsInTransaction(tx, portfolioId, plan),
      );
    },

    /**
     * Write both legs of a transfer **atomically** (V3-P3): one multi-row
     * INSERT, so either both movements persist or neither does — a mid-transfer
     * failure (constraint violation, connection loss) can never leave a
     * half-booked transfer behind. Returns `[outgoing, incoming]` resolved by
     * kind, independent of RETURNING order.
     */
    async insertTransferPair(
      portfolioId: string,
      legs: readonly [NewCashMovement, NewCashMovement],
    ): Promise<[CashMovementRecord, CashMovementRecord]> {
      const rows = await db
        .insert(portfolioCashMovements)
        .values(legs.map((leg) => toInsertValues(portfolioId, leg)))
        .returning();
      const outgoing = rows.find((r) => r.kind === 'transfer_out');
      const incoming = rows.find((r) => r.kind === 'transfer_in');
      if (rows.length !== 2 || !outgoing || !incoming) {
        throw new Error('Transfer insert did not return exactly one leg per direction');
      }
      // Both legs carry the `transfer` tag; they cancel, so splitting them into
      // two tags would double-count an internal move (V5 cash fusion).
      await stampMovementTags(db, portfolioId, rows);
      return [toRecord(outgoing), toRecord(incoming)];
    },

    /**
     * Every cash movement in a portfolio — all sources — chronological
     * (`executed_at` then id). The order lets the service feed
     * `domain/cashLedger` a ready-to-replay history; the balance is the sum of
     * `amountEur` regardless of order.
     */
    async listForPortfolio(
      portfolioId: string,
      executor: Pick<Database, 'select'> = db,
    ): Promise<CashMovementRecord[]> {
      return listPortfolioCashMovementsInTransaction(executor, portfolioId);
    },

    /**
     * Correct a hand-entered movement IN PLACE (V5 cash fusion, §16 2026-07-31).
     *
     * The row keeps its id, which is the deliberate difference from the way an
     * edited *trade* reworks its cash: a trade edit deletes the old movement and
     * books a new one, so the new row carries no user tags. A hand-entered
     * movement corrected here is still the same movement — a typo'd amount, a
     * wrong date — so the labels somebody put on it stay put, and only the
     * system tag moves when the kind does (`restampMovementTags`).
     *
     * The WHERE clause re-states the portfolio scope even though the service has
     * already resolved the row: the guarantee that no cross-portfolio id can
     * ever be written is worth stating in the statement that does the writing.
     * Returns null when nothing matched, which the service reads as a 404.
     */
    async updateForPortfolio(
      portfolioId: string,
      id: string,
      previousKind: Kind,
      patch: CashMovementUpdatePatch,
    ): Promise<CashMovementRecord | null> {
      const [row] = await db
        .update(portfolioCashMovements)
        .set({
          sourceId: patch.sourceId,
          kind: patch.kind,
          amountEur: String(patch.amountEur),
          executedAt: patch.executedAt,
          note: patch.note,
        })
        .where(
          and(
            eq(portfolioCashMovements.id, id),
            eq(portfolioCashMovements.portfolioId, portfolioId),
          ),
        )
        .returning();
      if (!row) return null;
      // Re-labelling hangs off the write path for the same reason stamping does
      // (see `cashSystemTagStamp`): a caller cannot forget it.
      await restampMovementTags(db, portfolioId, row, previousKind);
      return toRecord(row);
    },

    /**
     * Correct a movement under the portfolio cash-ledger lock. `plan` sees the
     * post-lock ledger and current row, so replay validation and the UPDATE use
     * one database snapshot and transaction.
     */
    async updateForPortfolioWithCashLedgerLock(
      portfolioId: string,
      id: string,
      plan: (
        fresh: readonly CashMovementRecord[],
        current: CashMovementRecord,
      ) => CashMovementUpdatePatch,
    ): Promise<{
      movement: CashMovementRecord;
      previous: CashMovementRecord;
    } | null> {
      return db.transaction(async (tx) => {
        await lockPortfolioCashLedgerInTransaction(tx, portfolioId);
        const fresh = await listPortfolioCashMovementsInTransaction(tx, portfolioId);
        const current = fresh.find((movement) => movement.id === id);
        if (!current) return null;
        const patch = plan(fresh, current);
        const [row] = await tx
          .update(portfolioCashMovements)
          .set({
            sourceId: patch.sourceId,
            kind: patch.kind,
            amountEur: String(patch.amountEur),
            executedAt: patch.executedAt,
            note: patch.note,
          })
          .where(
            and(
              eq(portfolioCashMovements.id, id),
              eq(portfolioCashMovements.portfolioId, portfolioId),
            ),
          )
          .returning();
        if (!row) return null;
        await restampMovementTags(tx, portfolioId, row, current.kind);
        return { movement: toRecord(row), previous: current };
      });
    },

    /**
     * Remove a hand-entered movement. `cash_movement_tags` cascades on
     * `movement_id`, so the labels go with it and no orphan link survives.
     * Returns whether a row was actually removed, so a repeat delete is a 404
     * rather than a silent success.
     */
    async deleteForPortfolio(portfolioId: string, id: string): Promise<boolean> {
      const rows = await db
        .delete(portfolioCashMovements)
        .where(
          and(
            eq(portfolioCashMovements.id, id),
            eq(portfolioCashMovements.portfolioId, portfolioId),
          ),
        )
        .returning({ id: portfolioCashMovements.id });
      return rows.length > 0;
    },

    /** Validate and delete one movement inside the shared ledger lock. */
    async deleteForPortfolioWithCashLedgerLock(
      portfolioId: string,
      id: string,
      validate: (fresh: readonly CashMovementRecord[], current: CashMovementRecord) => void,
    ): Promise<CashMovementRecord | null> {
      return db.transaction(async (tx) => {
        await lockPortfolioCashLedgerInTransaction(tx, portfolioId);
        const fresh = await listPortfolioCashMovementsInTransaction(tx, portfolioId);
        const current = fresh.find((movement) => movement.id === id);
        if (!current) return null;
        validate(fresh, current);
        const rows = await tx
          .delete(portfolioCashMovements)
          .where(
            and(
              eq(portfolioCashMovements.id, id),
              eq(portfolioCashMovements.portfolioId, portfolioId),
            ),
          )
          .returning({ id: portfolioCashMovements.id });
        return rows.length > 0 ? current : null;
      });
    },

    /** A single movement scoped to its portfolio, else null (defense-in-depth). */
    async findByIdForPortfolio(
      portfolioId: string,
      id: string,
    ): Promise<CashMovementRecord | null> {
      const rows = await db
        .select()
        .from(portfolioCashMovements)
        .where(
          and(
            eq(portfolioCashMovements.id, id),
            eq(portfolioCashMovements.portfolioId, portfolioId),
          ),
        )
        .limit(1);
      const row = rows[0];
      return row ? toRecord(row) : null;
    },
  };
}

export type CashMovementRepository = ReturnType<typeof createCashMovementRepository>;
