import { and, asc, eq } from 'drizzle-orm';

import type { Database } from '../db';
import { portfolioCashMovements } from '../schema';
import type { CashMovementRow } from '../schema';

/**
 * Per-portfolio cash-ledger persistence (PROJECTPLAN.md §14, #220/#278).
 *
 * Every movement is a reconciling row with a **signed** EUR amount, so the
 * current balance is literally the sum of the rows — computed by
 * `domain/cashLedger.cashBalance`, never stored. This repository is a thin data
 * seam: it inserts and lists movements; the sign/kind invariant and the
 * no-negative-balance gate live in the pure domain engine and the service that
 * calls it. Linked `buy` / `sell_proceeds` movements are written atomically
 * with their transaction on the transaction path (see `transactionRepository`).
 *
 * Reads are scoped to a `portfolio_id` the caller has already been authorised
 * for by the service (the portfolio ownership check precedes every call).
 */

type Kind = CashMovementRow['kind'];

/** A cash movement with its EUR amount parsed to `number` (DB stores `numeric`). */
export interface CashMovementRecord {
  id: string;
  portfolioId: string;
  kind: Kind;
  /** Signed EUR amount, full precision (inflows > 0, outflows < 0). */
  amountEur: number;
  transactionId: string | null;
  executedAt: Date;
  note: string | null;
  createdAt: Date;
}

/** Fields for a single insert; `amountEur` arrives signed as a `number`. */
export interface NewCashMovement {
  kind: Kind;
  amountEur: number;
  executedAt: Date;
  note: string | null;
  transactionId?: string | null;
}

function toRecord(row: CashMovementRow): CashMovementRecord {
  return {
    id: row.id,
    portfolioId: row.portfolioId,
    kind: row.kind,
    amountEur: Number(row.amountEur),
    transactionId: row.transactionId ?? null,
    executedAt: row.executedAt,
    note: row.note ?? null,
    createdAt: row.createdAt,
  };
}

export function createCashMovementRepository(db: Database) {
  return {
    /** Record a single cash movement (deposit/withdrawal — external, unlinked). */
    async insert(portfolioId: string, movement: NewCashMovement): Promise<CashMovementRecord> {
      const [row] = await db
        .insert(portfolioCashMovements)
        .values({
          portfolioId,
          kind: movement.kind,
          amountEur: String(movement.amountEur),
          transactionId: movement.transactionId ?? null,
          executedAt: movement.executedAt,
          note: movement.note,
        })
        .returning();
      if (!row) throw new Error('Cash movement insert returned no row');
      return toRecord(row);
    },

    /**
     * Every cash movement in a portfolio, chronological (`executed_at` then id).
     * The order lets the service feed `domain/cashLedger` a ready-to-replay
     * history; the balance is the sum of `amountEur` regardless of order.
     */
    async listForPortfolio(portfolioId: string): Promise<CashMovementRecord[]> {
      const rows = await db
        .select()
        .from(portfolioCashMovements)
        .where(eq(portfolioCashMovements.portfolioId, portfolioId))
        .orderBy(asc(portfolioCashMovements.executedAt), asc(portfolioCashMovements.id));
      return rows.map(toRecord);
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
