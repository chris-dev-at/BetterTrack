import { and, desc, eq, inArray, lt } from 'drizzle-orm';

import type { Database } from '../db';
import { assets, portfolioCashMovements, portfolios, transactions } from '../schema';
import type { AssetRow, TransactionRow } from '../schema';

/**
 * Transaction persistence (PROJECTPLAN.md §6.9). Transactions are the source of
 * truth for the whole portfolio; holdings and the value series are derived from
 * them and never stored.
 *
 * Every read is scoped to the caller through the owning portfolio (a join on
 * `portfolios.user_id`), so a transaction id belonging to another user is
 * indistinguishable from a missing one — no IDOR by construction (§10).
 */

type Side = TransactionRow['side'];

/** A transaction with its money columns parsed to `number` (DB stores `numeric`). */
export interface TransactionRecord {
  id: string;
  portfolioId: string;
  assetId: string;
  side: Side;
  quantity: number;
  price: number;
  fee: number;
  executedAt: Date;
  note: string | null;
}

/** A transaction row enriched with its asset metadata for the ledger view. */
export interface TransactionWithAsset extends TransactionRecord {
  asset: {
    id: string;
    symbol: string;
    name: string;
    exchange: string | null;
    currency: string;
    type: AssetRow['type'];
    isCustom: boolean;
  };
}

/**
 * A linked EUR cash movement created atomically with its transaction (§14,
 * #220): a `buy` funded from cash (negative `amountEur`) or `sell_proceeds`
 * booked into cash (positive). The sign/kind invariant is enforced by the
 * domain engine + a DB check; the caller passes the already-signed EUR amount.
 */
export interface LinkedCashMovement {
  kind: 'buy' | 'sell_proceeds';
  amountEur: number;
  note: string | null;
}

/** Fields for a single insert; money values arrive as `number`s. */
export interface NewTransaction {
  assetId: string;
  side: Side;
  quantity: number;
  price: number;
  fee: number;
  executedAt: Date;
  note: string | null;
  /** Optional cash movement written in the same DB transaction as this row. */
  cashMovement?: LinkedCashMovement | null;
}

function toRecord(row: typeof transactions.$inferSelect): TransactionRecord {
  return {
    id: row.id,
    portfolioId: row.portfolioId,
    assetId: row.assetId,
    side: row.side,
    quantity: Number(row.quantity),
    price: Number(row.price),
    fee: Number(row.fee),
    executedAt: row.executedAt,
    note: row.note ?? null,
  };
}

export function createTransactionRepository(db: Database) {
  return {
    /**
     * Bulk insert (the buy flow, §6.9). Returns the inserted rows in input order.
     * When any row carries a {@link LinkedCashMovement} (pay-from-cash /
     * add-proceeds, §14), the transactions *and* their linked cash movements are
     * written in one DB transaction so the ledger is never half-applied — a cash
     * movement can never reference a transaction that failed to persist, and the
     * cash balance reconciles atomically.
     */
    async insertMany(
      portfolioId: string,
      rows: readonly NewTransaction[],
    ): Promise<TransactionRecord[]> {
      if (rows.length === 0) return [];

      const insertTxns = (executor: Database) =>
        executor
          .insert(transactions)
          .values(
            rows.map((r) => ({
              portfolioId,
              assetId: r.assetId,
              side: r.side,
              quantity: String(r.quantity),
              price: String(r.price),
              fee: String(r.fee),
              executedAt: r.executedAt,
              note: r.note,
            })),
          )
          .returning();

      const hasCashLink = rows.some((r) => r.cashMovement);
      if (!hasCashLink) {
        const inserted = await insertTxns(db);
        return inserted.map(toRecord);
      }

      return db.transaction(async (tx) => {
        const inserted = await insertTxns(tx as unknown as Database);
        const cashRows = inserted
          .map((row, i) => {
            const link = rows[i]?.cashMovement;
            if (!link) return null;
            return {
              portfolioId,
              kind: link.kind,
              amountEur: String(link.amountEur),
              transactionId: row.id,
              executedAt: row.executedAt,
              note: link.note,
            };
          })
          .filter((v): v is NonNullable<typeof v> => v !== null);
        if (cashRows.length > 0) {
          await tx.insert(portfolioCashMovements).values(cashRows);
        }
        return inserted.map(toRecord);
      });
    },

    /** Every transaction for one asset in a portfolio (for oversell checks + holdings). */
    async listForAsset(portfolioId: string, assetId: string): Promise<TransactionRecord[]> {
      const rows = await db
        .select()
        .from(transactions)
        .where(and(eq(transactions.portfolioId, portfolioId), eq(transactions.assetId, assetId)));
      return rows.map(toRecord);
    },

    /** Every transaction in a portfolio (for holdings + the value series). */
    async listForPortfolio(portfolioId: string): Promise<TransactionRecord[]> {
      const rows = await db
        .select()
        .from(transactions)
        .where(eq(transactions.portfolioId, portfolioId));
      return rows.map(toRecord);
    },

    /**
     * Newest-first ledger for one portfolio, keyset paginated by UUIDv7 id (§8).
     * The caller authorises portfolio ownership first; this only scopes rows to
     * the portfolio and enriches each with its asset for display.
     */
    async listByPortfolio(
      portfolioId: string,
      params: { limit: number; cursor?: string },
    ): Promise<{ items: TransactionWithAsset[]; nextCursor: string | null }> {
      const rows = await db
        .select({
          id: transactions.id,
          portfolioId: transactions.portfolioId,
          assetId: transactions.assetId,
          side: transactions.side,
          quantity: transactions.quantity,
          price: transactions.price,
          fee: transactions.fee,
          executedAt: transactions.executedAt,
          note: transactions.note,
          assetSymbol: assets.symbol,
          assetName: assets.name,
          assetExchange: assets.exchange,
          assetCurrency: assets.currency,
          assetType: assets.type,
          assetOwnerId: assets.ownerId,
        })
        .from(transactions)
        .innerJoin(assets, eq(transactions.assetId, assets.id))
        .where(
          and(
            eq(transactions.portfolioId, portfolioId),
            params.cursor ? lt(transactions.id, params.cursor) : undefined,
          ),
        )
        .orderBy(desc(transactions.id))
        .limit(params.limit + 1);

      const hasMore = rows.length > params.limit;
      const page = hasMore ? rows.slice(0, params.limit) : rows;
      const items: TransactionWithAsset[] = page.map((row) => ({
        id: row.id,
        portfolioId: row.portfolioId,
        assetId: row.assetId,
        side: row.side,
        quantity: Number(row.quantity),
        price: Number(row.price),
        fee: Number(row.fee),
        executedAt: row.executedAt,
        note: row.note ?? null,
        asset: {
          id: row.assetId,
          symbol: row.assetSymbol,
          name: row.assetName,
          exchange: row.assetExchange ?? null,
          currency: row.assetCurrency,
          type: row.assetType,
          isCustom: row.assetOwnerId !== null,
        },
      }));
      return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
    },

    /** A single transaction visible to the caller (via its portfolio), else null. */
    async findByIdForUser(userId: string, id: string): Promise<TransactionRecord | null> {
      const rows = await db
        .select({
          id: transactions.id,
          portfolioId: transactions.portfolioId,
          assetId: transactions.assetId,
          side: transactions.side,
          quantity: transactions.quantity,
          price: transactions.price,
          fee: transactions.fee,
          executedAt: transactions.executedAt,
          note: transactions.note,
        })
        .from(transactions)
        .innerJoin(portfolios, eq(transactions.portfolioId, portfolios.id))
        .where(and(eq(transactions.id, id), eq(portfolios.userId, userId)))
        .limit(1);
      const row = rows[0];
      return row ? toRecord(row as typeof transactions.$inferSelect) : null;
    },

    /**
     * Update a transaction's mutable fields, scoped to the caller at the DB layer
     * (defense-in-depth — the service authorises first, but the WHERE restricts
     * the update to transactions in one of the caller's own portfolios).
     */
    async update(
      userId: string,
      id: string,
      patch: {
        side?: Side;
        quantity?: number;
        price?: number;
        fee?: number;
        executedAt?: Date;
        note?: string | null;
      },
    ): Promise<TransactionRecord | null> {
      const set: Record<string, unknown> = {};
      if (patch.side !== undefined) set.side = patch.side;
      if (patch.quantity !== undefined) set.quantity = String(patch.quantity);
      if (patch.price !== undefined) set.price = String(patch.price);
      if (patch.fee !== undefined) set.fee = String(patch.fee);
      if (patch.executedAt !== undefined) set.executedAt = patch.executedAt;
      if (patch.note !== undefined) set.note = patch.note;

      const ownedPortfolios = db
        .select({ id: portfolios.id })
        .from(portfolios)
        .where(eq(portfolios.userId, userId));
      const rows = await db
        .update(transactions)
        .set(set)
        .where(and(eq(transactions.id, id), inArray(transactions.portfolioId, ownedPortfolios)))
        .returning();
      const row = rows[0];
      return row ? toRecord(row) : null;
    },

    /** Delete a transaction scoped to the caller. Returns false when not theirs. */
    async deleteForUser(userId: string, id: string): Promise<boolean> {
      // Resolve ownership first (DELETE..USING + RETURNING is awkward across drivers).
      const owned = await db
        .select({ id: transactions.id })
        .from(transactions)
        .innerJoin(portfolios, eq(transactions.portfolioId, portfolios.id))
        .where(and(eq(transactions.id, id), eq(portfolios.userId, userId)))
        .limit(1);
      if (!owned[0]) return false;
      await db.delete(transactions).where(eq(transactions.id, id));
      return true;
    },
  };
}

export type TransactionRepository = ReturnType<typeof createTransactionRepository>;
