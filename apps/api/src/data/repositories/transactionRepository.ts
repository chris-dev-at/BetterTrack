import { and, asc, desc, eq, inArray, lt, or } from 'drizzle-orm';

import {
  decodeTransactionExecutedAtCursor,
  encodeTransactionExecutedAtCursor,
  type TransactionListOrder,
} from '@bettertrack/contracts';

import type { Database } from '../db';
import { assets, portfolioCashMovements, portfolios, transactions } from '../schema';
import type { AssetRow, TransactionRow } from '../schema';
import {
  insertCashMovementsInTransaction,
  listPortfolioCashMovementsInTransaction,
  lockPortfolioCashLedgerInTransaction,
  type CashMovementRecord,
  type NewCashMovement,
} from './cashMovementRepository';
import { stampMovementTags } from './cashSystemTagStamp';

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
  /**
   * Custom-mode parameter snapshot (V5-P4c, #584): the exact rule set this row
   * was taxed under, frozen at recording time. Null on non-custom rows.
   */
  taxParams: unknown;
  /**
   * Uncovered sell (issue #369). `allowUncovered` is true when this SELL was
   * recorded against an insufficient/zero holding behind the explicit
   * acknowledgment — persisted so replays (holdings, tax, oversell re-checks on
   * edit/delete) don't reject an already-accepted oversell. `uncoveredEntryPrice`
   * is the native per-unit basis the user supplied for the uncovered shares
   * (null = the sale price is used → 0 realized on that portion). Both are the
   * covered-sell defaults (false / null) on every other row.
   */
  allowUncovered: boolean;
  uncoveredEntryPrice: number | null;
  /** Source tag (V5-P0c): how this row entered the ledger; `manual` for hand entry. */
  source: string;
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
  /** Source tag (V5-P0c); defaults to `manual` when the batch is hand-entered. */
  source?: string;
}

/** Tax facts frozen onto a row at recording time (V3-P4); absent on buys/none. */
export interface NewTransactionTax {
  mode: NonNullable<TaxMode>;
  country: string | null;
  amountEur: number | null;
  /** Custom-mode parameter snapshot (V5-P4c); absent on every other mode. */
  params?: unknown;
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
  /**
   * Uncovered sell (issue #369): the persisted acknowledgment + the native
   * per-unit basis for the uncovered shares (null/absent = a covered sell, or
   * the sale-price default on the uncovered portion).
   */
  allowUncovered?: boolean;
  uncoveredEntryPrice?: number | null;
  /**
   * Source tag (V5-P0c): how this row entered the ledger. Defaults to `manual`;
   * the CSV apply path passes `import:<broker>`. The row's linked cash movements
   * inherit it. Server-assigned only — never client-suppliable.
   */
  source?: string;
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
    taxParams: row.taxParams ?? null,
    allowUncovered: row.allowUncovered,
    uncoveredEntryPrice: row.uncoveredEntryPrice === null ? null : Number(row.uncoveredEntryPrice),
    source: row.source,
  };
}

export interface CashLedgerTransactionBatch {
  rows: readonly NewTransaction[];
  extraMovements?: readonly BatchCashMovement[];
}

async function insertManyWithExecutor(
  executor: Database,
  portfolioId: string,
  rows: readonly NewTransaction[],
  extraMovements: readonly BatchCashMovement[],
): Promise<TransactionRecord[]> {
  if (rows.length === 0) return [];

  const inserted = await executor
    .insert(transactions)
    .values(
      rows.map((row) => ({
        portfolioId,
        assetId: row.assetId,
        side: row.side,
        quantity: String(row.quantity),
        price: String(row.price),
        fee: String(row.fee),
        executedAt: row.executedAt,
        note: row.note,
        taxMode: row.tax?.mode ?? null,
        taxCountry: row.tax?.country ?? null,
        taxAmountEur:
          row.tax?.amountEur === undefined || row.tax?.amountEur === null
            ? null
            : String(row.tax.amountEur),
        taxParams: row.tax?.params ?? null,
        allowUncovered: row.allowUncovered ?? false,
        uncoveredEntryPrice:
          row.uncoveredEntryPrice === undefined || row.uncoveredEntryPrice === null
            ? null
            : String(row.uncoveredEntryPrice),
        source: row.source ?? 'manual',
      })),
    )
    .returning();

  const cashRows = inserted.flatMap((row, index) =>
    (rows[index]?.cashMovements ?? []).map((link) => ({
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
      // A linked cash leg carries its parent transaction's source (V5-P0c).
      source: rows[index]?.source ?? 'manual',
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
    source: extra.source ?? 'manual',
  }));
  if (cashRows.length > 0 || extraRows.length > 0) {
    const booked = await executor
      .insert(portfolioCashMovements)
      .values([...cashRows, ...extraRows])
      .returning({
        id: portfolioCashMovements.id,
        kind: portfolioCashMovements.kind,
        // The note comes back because auto-tagging runs the owner's rules
        // over it as well as stamping the kind's app-owned tag.
        note: portfolioCashMovements.note,
      });
    // Auto-tagging (V5 cash fusion), inside the same transaction as the
    // trade: a buy becomes `investment`, a sell leg `sale_proceeds`, a tax
    // settlement `tax`. Rolled back with the trade if the trade rolls back.
    await stampMovementTags(executor, portfolioId, booked);
  }
  return inserted.map(toRecord);
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
      executor?: Database,
    ): Promise<TransactionRecord[]> {
      if (rows.length === 0) return [];
      // A caller that already owns a transaction (the standing-order archive
      // guard) keeps both the trade and its active-portfolio lock in that same
      // atomic boundary. Ordinary callers retain the original transaction policy.
      if (executor) return insertManyWithExecutor(executor, portfolioId, rows, extraMovements);
      const hasCashLink = rows.some((r) => (r.cashMovements?.length ?? 0) > 0);
      if (!hasCashLink && extraMovements.length === 0) {
        return insertManyWithExecutor(db, portfolioId, rows, extraMovements);
      }

      return db.transaction((tx) =>
        insertManyWithExecutor(tx as unknown as Database, portfolioId, rows, extraMovements),
      );
    },

    /**
     * Cash-linked bulk insert with the shared advisory-lock-first order. The
     * synchronous planner receives a post-lock ledger snapshot and returns the
     * already-validated rows to write; no provider/tax I/O belongs inside it.
     */
    async insertManyWithCashLedgerLock(
      portfolioId: string,
      plan: (fresh: readonly CashMovementRecord[]) => CashLedgerTransactionBatch,
    ): Promise<TransactionRecord[]> {
      return db.transaction(async (tx) => {
        await lockPortfolioCashLedgerInTransaction(tx, portfolioId);
        const fresh = await listPortfolioCashMovementsInTransaction(tx, portfolioId);
        const batch = plan(fresh);
        return insertManyWithExecutor(
          tx as unknown as Database,
          portfolioId,
          batch.rows,
          batch.extraMovements ?? [],
        );
      });
    },

    /** Every transaction for one asset in a portfolio (for oversell checks + holdings). */
    async listForAsset(portfolioId: string, assetId: string): Promise<TransactionRecord[]> {
      const rows = await db
        .select()
        .from(transactions)
        .where(and(eq(transactions.portfolioId, portfolioId), eq(transactions.assetId, assetId)))
        .orderBy(asc(transactions.executedAt), asc(transactions.id));
      return rows.map(toRecord);
    },

    /**
     * Every transaction in a portfolio (for holdings + the value series), in
     * recording order for equal execution timestamps. UUIDv7 ids preserve the
     * normal write order and make money-math replays deterministic when an
     * import restores multiple rows at the same instant.
     */
    async listForPortfolio(portfolioId: string): Promise<TransactionRecord[]> {
      const rows = await db
        .select()
        .from(transactions)
        .where(eq(transactions.portfolioId, portfolioId))
        .orderBy(asc(transactions.executedAt), asc(transactions.id));
      return rows.map(toRecord);
    },

    /**
     * Newest-first ledger for one portfolio. The legacy/default walk remains
     * keyset-paginated by UUIDv7 id (§8); display consumers may explicitly opt
     * into executed-time ordering and its `(executedAt, id)` compound keyset.
     * The caller authorises portfolio ownership first; this only scopes rows to
     * the portfolio and enriches each with its asset for display.
     */
    async listByPortfolio(
      portfolioId: string,
      params: {
        limit: number;
        cursor?: string;
        source?: string;
        assetId?: string;
        order?: TransactionListOrder;
      },
    ): Promise<{ items: TransactionWithAsset[]; nextCursor: string | null }> {
      const order = params.order ?? 'id';
      const executedAtCursor =
        order === 'executedAt' && params.cursor
          ? decodeTransactionExecutedAtCursor(params.cursor)
          : null;
      if (order === 'executedAt' && params.cursor && executedAtCursor === null) {
        throw new Error('Invalid executed-time transaction cursor reached the repository.');
      }
      const cursorFilter =
        order === 'executedAt' && executedAtCursor
          ? or(
              lt(transactions.executedAt, new Date(executedAtCursor.executedAt)),
              and(
                eq(transactions.executedAt, new Date(executedAtCursor.executedAt)),
                lt(transactions.id, executedAtCursor.id),
              ),
            )
          : params.cursor
            ? lt(transactions.id, params.cursor)
            : undefined;
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
          taxParams: transactions.taxParams,
          allowUncovered: transactions.allowUncovered,
          uncoveredEntryPrice: transactions.uncoveredEntryPrice,
          source: transactions.source,
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
            // Source-tag filter (V5-P0c): return only rows carrying this exact tag.
            params.source ? eq(transactions.source, params.source) : undefined,
            // Holding expansions fetch only their asset's rows on demand.
            params.assetId ? eq(transactions.assetId, params.assetId) : undefined,
            cursorFilter,
          ),
        )
        .orderBy(
          ...(order === 'executedAt'
            ? [desc(transactions.executedAt), desc(transactions.id)]
            : [desc(transactions.id)]),
        )
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
        taxParams: row.taxParams ?? null,
        allowUncovered: row.allowUncovered,
        uncoveredEntryPrice:
          row.uncoveredEntryPrice === null ? null : Number(row.uncoveredEntryPrice),
        source: row.source,
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
      const tail = items.at(-1);
      return {
        items,
        nextCursor:
          hasMore && tail
            ? order === 'executedAt'
              ? encodeTransactionExecutedAtCursor({
                  executedAt: tail.executedAt.toISOString(),
                  id: tail.id,
                })
              : tail.id
            : null,
      };
    },

    /** Complete, sorted source facet for the portfolio ledger (independent of row filters). */
    async listSourceTagsByPortfolio(portfolioId: string): Promise<string[]> {
      const rows = await db
        .selectDistinct({ source: transactions.source })
        .from(transactions)
        .where(eq(transactions.portfolioId, portfolioId))
        .orderBy(asc(transactions.source));
      return rows.map((row) => row.source);
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
          taxParams: transactions.taxParams,
          allowUncovered: transactions.allowUncovered,
          uncoveredEntryPrice: transactions.uncoveredEntryPrice,
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

    /**
     * Delete a transaction and append its tax corrections as one unit. The
     * cash-ledger advisory lock comes first, matching open-year reconciliation;
     * a failure after the parent delete therefore rolls the cascade and every
     * correction back without introducing a lock-order inversion.
     */
    async deleteForUserWithCorrections(
      userId: string,
      portfolioId: string,
      id: string,
      corrections: readonly NewCashMovement[],
    ): Promise<boolean> {
      return db.transaction(async (tx) => {
        await lockPortfolioCashLedgerInTransaction(tx, portfolioId);

        // Resolve ownership inside the same transaction (DELETE..USING +
        // RETURNING is awkward across drivers). Restating portfolio scope also
        // prevents corrections ever landing beside a row from another owned
        // portfolio when a stale/mismatched scoped URL reaches this seam.
        const owned = await tx
          .select({ id: transactions.id })
          .from(transactions)
          .innerJoin(portfolios, eq(transactions.portfolioId, portfolios.id))
          .where(
            and(
              eq(transactions.id, id),
              eq(transactions.portfolioId, portfolioId),
              eq(portfolios.userId, userId),
            ),
          )
          .limit(1);
        if (!owned[0]) return false;

        await tx
          .delete(transactions)
          .where(and(eq(transactions.id, id), eq(transactions.portfolioId, portfolioId)));
        await insertCashMovementsInTransaction(tx, portfolioId, corrections);
        return true;
      });
    },
  };
}

export type TransactionRepository = ReturnType<typeof createTransactionRepository>;
