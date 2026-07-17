import { and, asc, eq } from 'drizzle-orm';

import type { Database } from '../db';
import { portfolioCashMovements } from '../schema';
import type { CashMovementRow } from '../schema';

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

export function createCashMovementRepository(db: Database) {
  return {
    /** Record a single cash movement (deposit/withdrawal — external, unlinked). */
    async insert(portfolioId: string, movement: NewCashMovement): Promise<CashMovementRecord> {
      const [row] = await db
        .insert(portfolioCashMovements)
        .values(toInsertValues(portfolioId, movement))
        .returning();
      if (!row) throw new Error('Cash movement insert returned no row');
      return toRecord(row);
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
      return [toRecord(outgoing), toRecord(incoming)];
    },

    /**
     * Every cash movement in a portfolio — all sources — chronological
     * (`executed_at` then id). The order lets the service feed
     * `domain/cashLedger` a ready-to-replay history; the balance is the sum of
     * `amountEur` regardless of order.
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
