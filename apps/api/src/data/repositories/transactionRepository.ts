import { and, desc, eq, lt } from 'drizzle-orm';

import type { Database } from '../db';
import { assets, portfolios, transactions } from '../schema';
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

/** Fields for a single insert; money values arrive as `number`s. */
export interface NewTransaction {
  assetId: string;
  side: Side;
  quantity: number;
  price: number;
  fee: number;
  executedAt: Date;
  note: string | null;
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
    /** Bulk insert (the buy flow, §6.9). Returns the inserted rows in input order. */
    async insertMany(
      portfolioId: string,
      rows: readonly NewTransaction[],
    ): Promise<TransactionRecord[]> {
      if (rows.length === 0) return [];
      const inserted = await db
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
      return inserted.map(toRecord);
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
     * Newest-first ledger for a user, keyset paginated by UUIDv7 id (§8). The
     * portfolio join scopes the result to the caller; the asset join enriches
     * each row for display.
     */
    async listByUser(
      userId: string,
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
        .innerJoin(portfolios, eq(transactions.portfolioId, portfolios.id))
        .innerJoin(assets, eq(transactions.assetId, assets.id))
        .where(
          and(
            eq(portfolios.userId, userId),
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

    /** Update a transaction's mutable fields. Caller has already authorised it. */
    async update(
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

      const rows = await db
        .update(transactions)
        .set(set)
        .where(eq(transactions.id, id))
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
