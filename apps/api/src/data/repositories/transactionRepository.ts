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
type TaxMode = TransactionRow['taxMode'];

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
  /**
   * Tax facts frozen at recording time (V3-P4, §16 2026-07-08). `taxMode` null
   * = recorded before the tax engine (behaves like 'none'); `taxAmountEur` is
   * the signed tax the recording produced (null = none computed/entered).
   */
  taxMode: TaxMode;
  taxCountry: string | null;
  taxAmountEur: number | null;
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
 * #220): a `buy` funded from cash (negative `amountEur`), `sell_proceeds`
 * booked into cash (positive), or the sell's tax settlement (V3-P4:
 * `tax_withholding` negative / `tax_refund` positive, carrying its Vienna
 * `taxYear`), against the given cash source (V3-P3). The sign/kind invariant
 * is enforced by the domain engine + a DB check; the caller passes the
 * already-signed EUR amount and a resolved, active source id.
 */
export interface LinkedCashMovement {
  kind: 'buy' | 'sell_proceeds' | 'tax_withholding' | 'tax_refund';
  amountEur: number;
  sourceId: string;
  note: string | null;
  /** Required on tax settlements, absent otherwise (DB CHECK enforced). */
  taxYear?: number | null;
  /**
   * The movement's own date, when it must differ from the transaction's
   * `executedAt` (#378: a backdated pay-from-cash buy whose cash was insufficient
   * at the buy date settles the cash leg **as of today** while the acquisition
   * keeps its past date). Omitted → the movement inherits the row's `executedAt`,
   * the invariant for every same-day cash-funded buy/sell and tax settlement.
   */
  occurredAt?: Date;
}

/**
 * An unattached cash movement written atomically with a transaction batch
 * (V3-P4): a year-settlement correction posted when the batch re-shapes
 * history (e.g. a backdated buy shifting existing AT sells' gains). Not linked
 * to any single row — it settles the *year*.
 */
export interface BatchCashMovement {
  kind: 'tax_withholding' | 'tax_refund';
  amountEur: number;
  sourceId: string;
  note: string | null;
  taxYear: number;
  executedAt: Date;
}

/** Tax facts frozen onto a row at recording time (V3-P4); absent on buys/none. */
export interface NewTransactionTax {
  mode: NonNullable<TaxMode>;
  country: string | null;
  amountEur: number | null;
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
  /** Tax mode/amount recorded on the row (V3-P4); null = pre-engine shape. */
  tax?: NewTransactionTax | null;
  /** Cash movements written in the same DB transaction as this row (§14, V3-P4). */
  cashMovements?: readonly LinkedCashMovement[];
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
    taxMode: row.taxMode ?? null,
    taxCountry: row.taxCountry ?? null,
    taxAmountEur: row.taxAmountEur === null ? null : Number(row.taxAmountEur),
  };
}

export function createTransactionRepository(db: Database) {
  return {
    /**
     * Bulk insert (the buy flow, §6.9). Returns the inserted rows in input order.
     * When any row carries {@link LinkedCashMovement}s (pay-from-cash /
     * add-proceeds, §14; tax settlements, V3-P4) — or the batch carries
     * unattached {@link BatchCashMovement} year corrections — the transactions
     * *and* every movement are written in one DB transaction so the ledger is
     * never half-applied: a cash movement can never reference a transaction
     * that failed to persist, and the cash balance + tax year reconcile
     * atomically.
     */
    async insertMany(
      portfolioId: string,
      rows: readonly NewTransaction[],
      extraMovements: readonly BatchCashMovement[] = [],
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
              taxMode: r.tax?.mode ?? null,
              taxCountry: r.tax?.country ?? null,
              taxAmountEur:
                r.tax?.amountEur === undefined || r.tax?.amountEur === null
                  ? null
                  : String(r.tax.amountEur),
            })),
          )
          .returning();

      const hasCashLink = rows.some((r) => (r.cashMovements?.length ?? 0) > 0);
      if (!hasCashLink && extraMovements.length === 0) {
        const inserted = await insertTxns(db);
        return inserted.map(toRecord);
      }

      return db.transaction(async (tx) => {
        const inserted = await insertTxns(tx as unknown as Database);
        const cashRows = inserted.flatMap((row, i) =>
          (rows[i]?.cashMovements ?? []).map((link) => ({
            portfolioId,
            sourceId: link.sourceId,
            kind: link.kind,
            amountEur: String(link.amountEur),
            transactionId: row.id,
            taxYear: link.taxYear ?? null,
            // A cash leg dated apart from its transaction (#378 settle-as-of-today)
            // carries its own date; every other leg inherits the row's.
            executedAt: link.occurredAt ?? row.executedAt,
            note: link.note,
          })),
        );
        const extraRows = extraMovements.map((extra) => ({
          portfolioId,
          sourceId: extra.sourceId,
          kind: extra.kind,
          amountEur: String(extra.amountEur),
          taxYear: extra.taxYear,
          executedAt: extra.executedAt,
          note: extra.note,
        }));
        if (cashRows.length > 0 || extraRows.length > 0) {
          await tx.insert(portfolioCashMovements).values([...cashRows, ...extraRows]);
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
          taxMode: transactions.taxMode,
          taxCountry: transactions.taxCountry,
          taxAmountEur: transactions.taxAmountEur,
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
        taxMode: row.taxMode ?? null,
        taxCountry: row.taxCountry ?? null,
        taxAmountEur: row.taxAmountEur === null ? null : Number(row.taxAmountEur),
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
          taxMode: transactions.taxMode,
          taxCountry: transactions.taxCountry,
          taxAmountEur: transactions.taxAmountEur,
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
