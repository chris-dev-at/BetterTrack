/**
 * Portfolio money-math core (PROJECTPLAN.md §6.8, §5.4).
 *
 * Transactions are the source of truth; **holdings are derived, never stored**.
 * This module owns the three derivations that turn a transaction log into the
 * numbers a user sees:
 *
 *  1. {@link reducePosition} — average-cost basis and realized P/L from a single
 *     asset's transactions (BUY re-averages, SELL realizes against the running
 *     average and is rejected if it would push the held quantity negative).
 *  2. {@link deriveHoldings} — the per-asset holdings view: quantity, average
 *     cost, market value (EUR), unrealized P/L €/%, and day change.
 *  3. {@link valueOverTime} — the portfolio value-over-time series, daily from
 *     the first transaction to a given `today`, summing every asset's held
 *     quantity × that day's price, converted at that day's FX rate.
 *  4. {@link netFlowsOverTime} + {@link timeWeightedReturn} — the cash-flow-
 *     neutralized performance series (daily time-weighted return, issue #125):
 *     deposits/withdrawals cause no jump; the curve moves only when holdings
 *     move. {@link rebasePerformance} re-bases a window slice to 0 %.
 *
 * **Purity (a hard requirement, §6.8/§12):** everything here is a pure
 * function of its inputs. There are no imports — no DB, no HTTP, no clock.
 * Currency conversion is injected as a {@link CurrencyConverter}; price history,
 * the reporting day (`today`), and FX all arrive as parameters. A silent
 * off-by-one or a mid-computation rounding here costs real money, so:
 *
 *  - **No rounding mid-computation** (§5.4). Every value is returned at full
 *    `number` precision; display rounding (money 2 dp, quantities 6 dp) lives in
 *    the display layer, never here.
 *  - **Quantity comparisons use a tolerance** ({@link QTY_EPSILON}) so that
 *    selling exactly the held quantity is allowed despite floating-point dust,
 *    while a genuine over-sell is rejected.
 */

// ---------------------------------------------------------------------------
// Tolerance
// ---------------------------------------------------------------------------

/**
 * Quantity comparison tolerance. Quantities are stored at scale 8 (§5.5), so the
 * smallest meaningful unit is 1e-8; this tolerance sits an order of magnitude
 * below that. Two uses, both on the money path:
 *
 *  - a SELL of `qty` is rejected only when `qty` exceeds the held quantity by
 *    *more* than this — so selling the whole position (where float arithmetic
 *    may leave a ±1e-15 residue) is allowed, but over-selling by a real unit
 *    (≥ 1e-8) is not;
 *  - a held quantity within this of zero is treated as flat (clamped to 0), so a
 *    fully-closed position reports exactly `0`, not float dust.
 */
export const QTY_EPSILON = 1e-9;

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

/**
 * Currency conversion into the base currency (EUR in v1, a parameter throughout
 * — §5.4). Structurally satisfied by the application's `CurrencyService`, but
 * declared here as a minimal interface so the domain stays decoupled and pure.
 *
 * `opts.date` (ISO `YYYY-MM-DD`) selects the historical daily rate; omitting it
 * uses the current spot rate. `opts.base` overrides the target currency (future
 * per-user base currency).
 */
export interface CurrencyConverter {
  toBase(
    amount: number,
    currency: string,
    opts?: { date?: string; base?: string },
  ): Promise<number>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when a SELL would push the held quantity negative ("you only hold 3.5
 * shares" — §6.8). A typed error so the write path can map it to a 400 rather
 * than a 500; the message carries the offending quantities.
 */
export class OversellError extends Error {
  readonly assetId: string | null;
  readonly held: number;
  readonly requested: number;

  constructor(requested: number, held: number, assetId: string | null) {
    super(`Cannot sell ${requested} units${assetId ? ` of ${assetId}` : ''}: only ${held} held.`);
    this.name = 'OversellError';
    this.assetId = assetId;
    this.held = held;
    this.requested = requested;
  }
}

// ---------------------------------------------------------------------------
// Transactions & positions
// ---------------------------------------------------------------------------

export type TransactionSide = 'buy' | 'sell';

/**
 * A single portfolio transaction in its asset's **native currency** (§6.8).
 *
 * `executedAt` is an ISO-8601 timestamp used for two things: chronological
 * ordering (BUY/SELL interleaving changes the running average, so order
 * matters) and — via its date portion `YYYY-MM-DD` — the day key for the
 * value-over-time series. Callers should pass timestamps in a single, consistent
 * zone (UTC recommended); the domain reads the date portion verbatim and does no
 * timezone conversion of its own, which keeps the day boundary off-by-one-free.
 */
export interface Transaction {
  assetId: string;
  side: TransactionSide;
  /** Units transacted; strictly positive. */
  quantity: number;
  /** Price per unit, native currency; non-negative. */
  price: number;
  /** Total fee for the transaction, native currency; non-negative. */
  fee: number;
  /** ISO-8601 timestamp. */
  executedAt: string;
  /**
   * Uncovered sell (issue #369). When true, a SELL exceeding the held quantity
   * (including a zero holding) is **permitted** instead of throwing
   * {@link OversellError}: the covered shares realize against the running
   * average, the uncovered remainder against {@link uncoveredEntryPrice} (or the
   * sale price when that is absent → 0 realized on that portion), and the
   * position closes at exactly 0 — **no shorts**. Ignored on buys and on covered
   * sells (where quantity ≤ held). Absent → the historical strict behavior
   * (an oversell throws).
   */
  allowUncovered?: boolean;
  /**
   * Native per-unit cost basis for the uncovered portion of an
   * {@link allowUncovered} SELL (issue #369). `null`/absent → the sale `price`
   * is used, so the uncovered shares realize 0. Ignored unless the sell is
   * genuinely uncovered (quantity exceeds held).
   */
  uncoveredEntryPrice?: number | null;
}

/** Realized P/L attributed to a single SELL, by its index in the input list. */
export interface SellRealization {
  /** Index of the SELL in the original (unsorted) transaction array. */
  index: number;
  /** `quantity · (price − avg_cost) − fee`, native currency. */
  realizedPnl: number;
}

/** The outcome of reducing one asset's transaction log. */
export interface PositionState {
  /** Net held quantity (≥ 0); exactly 0 when the position is flat. */
  quantity: number;
  /** Average cost per unit, native currency; 0 when flat. */
  avgCost: number;
  /** Cumulative realized P/L across every SELL, native currency. */
  realizedPnl: number;
  /** Per-SELL realized P/L, for the transaction rows (§6.8). */
  realizations: SellRealization[];
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number, got ${value}`);
  }
}

/** Epoch-ms of a transaction's `executedAt`; unparseable input fails loud. */
function executedAtToMs(executedAt: string): number {
  const ms = Date.parse(executedAt);
  if (Number.isNaN(ms)) {
    throw new Error(`Transaction executedAt must be an ISO-8601 date/time, got ${executedAt}`);
  }
  return ms;
}

/**
 * Average-cost basis and realized P/L for one asset's transactions (§6.8).
 *
 * Processes transactions in chronological order (`executedAt`, ties broken by
 * input order for determinism):
 *
 *  - **BUY** re-averages: `avg = (held·avg + qty·price + fee) / (held + qty)` —
 *    the fee is capitalised into the cost basis.
 *  - **SELL** realizes `qty·(price − avg) − fee` and reduces the quantity; the
 *    average cost is unchanged. A SELL exceeding the held quantity (beyond
 *    {@link QTY_EPSILON}) throws {@link OversellError}.
 *
 * The input may contain transactions for a single asset; mixing assets is a
 * programming error and throws.
 */
export function reducePosition(transactions: readonly Transaction[]): PositionState {
  // Tag with original indices, then stable-sort by (executedAt, index) so the
  // running average sees BUY/SELL in the true chronological order regardless of
  // how the caller supplied the list. Compare as epoch-ms, NOT as strings:
  // ISO-8601 admits mixed sub-second precision (`…T10:00:00Z` vs
  // `…T10:00:00.500Z`) and non-UTC offsets, neither of which sorts
  // lexicographically in time order ('.' < 'Z'), so a string comparison here
  // would replay sells before the buys that funded them (issue #218).
  const ordered = transactions
    .map((t, index) => ({ t, index, executedAtMs: executedAtToMs(t.executedAt) }))
    .sort((a, b) => a.executedAtMs - b.executedAtMs || a.index - b.index);

  let assetId: string | null = null;
  let held = 0;
  let avg = 0;
  let realizedPnl = 0;
  const realizations: SellRealization[] = [];

  for (const { t, index } of ordered) {
    if (assetId === null) {
      assetId = t.assetId;
    } else if (t.assetId !== assetId) {
      throw new Error(
        `reducePosition received transactions for multiple assets (${assetId}, ${t.assetId}); group by asset first.`,
      );
    }

    if (!Number.isFinite(t.quantity) || t.quantity <= 0) {
      throw new Error(`Transaction quantity must be a finite positive number, got ${t.quantity}`);
    }
    assertFiniteNonNegative(t.price, 'Transaction price');
    assertFiniteNonNegative(t.fee, 'Transaction fee');

    if (t.side === 'buy') {
      const newHeld = held + t.quantity;
      // newHeld > 0 always (held ≥ 0, quantity > 0), so the division is safe.
      avg = (held * avg + t.quantity * t.price + t.fee) / newHeld;
      held = newHeld;
    } else {
      if (t.quantity > held + QTY_EPSILON) {
        // Over-selling the held quantity: rejected unless the caller explicitly
        // acknowledged an uncovered sell (issue #369).
        if (!t.allowUncovered) {
          throw new OversellError(t.quantity, held, assetId);
        }
        // Uncovered sell: the covered shares (the whole held position, ≥ 0)
        // realize against the running average; the uncovered remainder realizes
        // against its supplied entry price, or the sale price when none is given
        // (→ 0 on that portion). The fee applies once to the whole sell. No
        // shorts — the position closes at exactly 0.
        const covered = held;
        const uncovered = t.quantity - covered;
        const uncoveredBasis = t.uncoveredEntryPrice ?? t.price;
        if (t.uncoveredEntryPrice != null) {
          assertFiniteNonNegative(t.uncoveredEntryPrice, 'Transaction uncovered entry price');
        }
        const pnl = covered * (t.price - avg) + uncovered * (t.price - uncoveredBasis) - t.fee;
        realizedPnl += pnl;
        realizations.push({ index, realizedPnl: pnl });
        held = 0;
        avg = 0;
      } else {
        const pnl = t.quantity * (t.price - avg) - t.fee;
        realizedPnl += pnl;
        realizations.push({ index, realizedPnl: pnl });
        held -= t.quantity;
        // Clamp float dust: a sell-everything leaves held at ~±1e-15, not 0.
        if (Math.abs(held) <= QTY_EPSILON) {
          held = 0;
          avg = 0;
        }
      }
    }
  }

  return { quantity: held, avgCost: held === 0 ? 0 : avg, realizedPnl, realizations };
}

// ---------------------------------------------------------------------------
// Holdings view
// ---------------------------------------------------------------------------

/** A current quote for an asset, native currency. `null` when unavailable. */
export interface HoldingQuote {
  price: number;
  /** Previous close, for day change; absent/`null` when unknown. */
  prevClose?: number | null;
}

/** Per-asset inputs for {@link deriveHoldings}: identity, currency, live quote. */
export interface HoldingAssetInput {
  assetId: string;
  /** ISO-4217 native currency of the asset. */
  currency: string;
  /** Current quote, or `null` when the provider has nothing (degrades, §6.3). */
  quote: HoldingQuote | null;
}

/**
 * One row of the holdings view (§6.8). Native-currency facts (`avgCost`,
 * `price`, `realizedPnl`) sit alongside EUR-converted figures. Every EUR figure
 * is `null` when it cannot be computed (no quote, or a flat position).
 *
 * All EUR figures use the **current spot** rate — §5.4 routes quotes and totals
 * through current rates (historical rates are reserved for the value-over-time
 * series). Cost basis is therefore the *open* cost basis valued at today's FX,
 * which makes `unrealizedPnlEur = marketValueEur − costBasisEur` pure asset
 * performance; the percentage is FX-independent.
 */
export interface Holding {
  assetId: string;
  currency: string;
  /** Net held quantity (≥ 0). */
  quantity: number;
  /** Average cost per unit, native currency; 0 when flat. */
  avgCost: number;
  /** Cumulative realized P/L, native currency. */
  realizedPnl: number;
  /** Current price per unit, native currency; `null` without a quote. */
  price: number | null;
  /** Held quantity × price, in EUR. */
  marketValueEur: number | null;
  /** Open cost basis (quantity × avg cost), in EUR at current FX. */
  costBasisEur: number | null;
  /** `marketValueEur − costBasisEur`. */
  unrealizedPnlEur: number | null;
  /** `(price − avgCost) / avgCost · 100`; `null` when avg cost is 0. */
  unrealizedPnlPct: number | null;
  /** Held quantity × (price − prevClose), in EUR. */
  dayChangeEur: number | null;
  /** `(price − prevClose) / prevClose · 100`; `null` without a prev close. */
  dayChangePct: number | null;
}

/**
 * Derive the holdings view (§6.8) for a set of assets from their transactions.
 *
 * One {@link Holding} is produced per asset that has at least one transaction,
 * in the order the assets are supplied. Fully-closed positions (net quantity 0)
 * are included so their realized P/L is available; their EUR market figures are
 * `null` (nothing is held to value). Every transacted asset must have a matching
 * entry in `assets` — a missing currency/quote is a programming error and
 * throws.
 */
export async function deriveHoldings(
  transactions: readonly Transaction[],
  assets: readonly HoldingAssetInput[],
  converter: CurrencyConverter,
): Promise<Holding[]> {
  const byAsset = new Map<string, Transaction[]>();
  for (const t of transactions) {
    const list = byAsset.get(t.assetId);
    if (list) list.push(t);
    else byAsset.set(t.assetId, [t]);
  }

  // Fail loud on the money path: a transacted asset with no currency/quote
  // input would otherwise silently vanish from the holdings view (and from the
  // portfolio totals built on it). Same contract as valueOverTime.
  const covered = new Set(assets.map((a) => a.assetId));
  const missing = [...byAsset.keys()].filter((id) => !covered.has(id));
  if (missing.length > 0) {
    throw new Error(
      `deriveHoldings: transactions reference assets with no currency/quote input: ${missing.join(', ')}.`,
    );
  }

  const holdings: Holding[] = [];
  for (const asset of assets) {
    const txns = byAsset.get(asset.assetId);
    if (!txns) continue; // no transactions → not a holding

    const pos = reducePosition(txns);
    const price = asset.quote?.price ?? null;

    const holding: Holding = {
      assetId: asset.assetId,
      currency: asset.currency,
      quantity: pos.quantity,
      avgCost: pos.avgCost,
      realizedPnl: pos.realizedPnl,
      price,
      marketValueEur: null,
      costBasisEur: null,
      unrealizedPnlEur: null,
      unrealizedPnlPct: null,
      dayChangeEur: null,
      dayChangePct: null,
    };

    if (pos.quantity > 0 && price !== null) {
      // Current spot for both market value and cost basis (§5.4): same rate, so
      // the EUR P/L is exactly the asset's native P/L converted once.
      const marketValueEur = await converter.toBase(pos.quantity * price, asset.currency);
      const costBasisEur = await converter.toBase(pos.quantity * pos.avgCost, asset.currency);
      holding.marketValueEur = marketValueEur;
      holding.costBasisEur = costBasisEur;
      holding.unrealizedPnlEur = marketValueEur - costBasisEur;
      // FX-independent (numerator and denominator share the asset's currency).
      holding.unrealizedPnlPct =
        pos.avgCost > 0 ? ((price - pos.avgCost) / pos.avgCost) * 100 : null;

      const prevClose = asset.quote?.prevClose ?? null;
      if (prevClose !== null) {
        holding.dayChangeEur = await converter.toBase(
          pos.quantity * (price - prevClose),
          asset.currency,
        );
        holding.dayChangePct = prevClose !== 0 ? ((price - prevClose) / prevClose) * 100 : null;
      }
    }

    holdings.push(holding);
  }

  return holdings;
}

// ---------------------------------------------------------------------------
// Value over time
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A daily close / custom-asset value point, native currency (§6.8). */
export interface PricePoint {
  /** ISO `YYYY-MM-DD`. */
  date: string;
  /** Close (market asset) or value point (custom asset), native currency. */
  close: number;
}

/** Per-asset inputs for {@link valueOverTime}: currency and its price history. */
export interface ValueOverTimeAsset {
  assetId: string;
  /** ISO-4217 native currency of the asset. */
  currency: string;
  /**
   * Daily closes or custom-asset value points, native currency, any order.
   * Between points the value carries forward (step function) — the honest
   * treatment of sparse custom-asset data (§6.8).
   */
  prices: readonly PricePoint[];
}

export interface ValueOverTimeInput {
  /** Every transaction across the portfolio (any order). */
  transactions: readonly Transaction[];
  /** One entry per transacted asset; a missing asset throws. */
  assets: readonly ValueOverTimeAsset[];
  /** The last day of the series, ISO `YYYY-MM-DD`. */
  today: string;
  converter: CurrencyConverter;
}

/** One point on the portfolio value-over-time series. */
export interface ValuePoint {
  /** ISO `YYYY-MM-DD`. */
  date: string;
  /** Total portfolio value in EUR on that day. */
  valueEur: number;
}

/** Date portion of an ISO timestamp, validated. */
function dayOf(executedAt: string): string {
  const day = executedAt.slice(0, 10);
  if (!ISO_DATE.test(day)) {
    throw new Error(`Transaction executedAt must be an ISO-8601 date/time, got ${executedAt}`);
  }
  return day;
}

function assertIsoDate(date: string, label: string): void {
  if (!ISO_DATE.test(date)) {
    throw new Error(`${label} must be ISO YYYY-MM-DD, got ${date}`);
  }
}

/** UTC midnight epoch-ms of an ISO date (no clock read; deterministic). */
function dateToMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

/**
 * Expand a sparse price series into one close per calendar day over
 * `[startDay, endDay]` (issue #122: the per-asset overlay series the portfolio
 * graph draws next to the value curve).
 *
 * **Carry-forward is the gap policy** (the same step function
 * {@link valueOverTime} applies): a weekend, market holiday or provider gap has
 * no close of its own, so the last known close before it is repeated — the
 * honest daily valuation of an asset that simply didn't trade that day. Days
 * *before* the first available close are omitted rather than invented (an asset
 * listed after `startDay` starts where its data starts).
 *
 * Pure and deterministic: unsorted input is sorted, later duplicates of a date
 * win (matching the provider-over-stored merge order upstream), and malformed
 * dates or non-finite closes throw rather than silently mis-plotting.
 */
export function dailyCloseSeries(
  prices: readonly PricePoint[],
  startDay: string,
  endDay: string,
): PricePoint[] {
  assertIsoDate(startDay, 'startDay');
  assertIsoDate(endDay, 'endDay');
  if (endDay < startDay || prices.length === 0) return [];

  for (const point of prices) {
    assertIsoDate(point.date, 'price point date');
    if (!Number.isFinite(point.close)) {
      throw new Error(`Price point on ${point.date} must be a finite number, got ${point.close}`);
    }
  }
  const byDate = new Map<string, number>();
  for (const p of prices) byDate.set(p.date, p.close);
  const sorted = [...byDate].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const series: PricePoint[] = [];
  let idx = 0;
  let lastClose: number | null = null;
  for (let ms = dateToMs(startDay); ms <= dateToMs(endDay); ms += MS_PER_DAY) {
    const day = new Date(ms).toISOString().slice(0, 10);
    while (idx < sorted.length) {
      const entry = sorted[idx];
      if (entry === undefined || entry[0] > day) break;
      lastClose = entry[1];
      idx += 1;
    }
    if (lastClose === null) continue; // before the first known close
    series.push({ date: day, close: lastClose });
  }
  return series;
}

/**
 * Reconstruct the daily portfolio value series in EUR (§6.8).
 *
 * For every calendar day from the first transaction to `today`:
 * `value(d) = Σ over assets of qty_held(d) · price_native(d) · fx(currency, d)`,
 * where `qty_held(d)` is the net quantity through day `d`, `price_native(d)` is
 * the latest price on or before `d` (carried forward — the step function for
 * sparse data), and `fx` is that day's historical rate into EUR.
 *
 * Returns an empty series when there are no transactions, or when the first
 * transaction is after `today`.
 *
 * FX is **coalesced** to one conversion per (currency, day): the per-asset
 * native contributions are summed by currency first (synchronously), then each
 * distinct (currency, day) rate is fetched once via a memoised promise. This is
 * the request-coalescing the money path requires — and, because conversion is
 * linear, `Σ native · rate` is identical at full precision to converting each
 * asset's contribution individually.
 */
export async function valueOverTime(input: ValueOverTimeInput): Promise<ValuePoint[]> {
  const { transactions, assets, today, converter } = input;
  assertIsoDate(today, 'today');

  if (transactions.length === 0) return [];

  const assetById = new Map<string, ValueOverTimeAsset>();
  for (const a of assets) assetById.set(a.assetId, a);

  // Group transactions by asset and find the series start (earliest day).
  const txnsByAsset = new Map<string, Transaction[]>();
  let startDay: string | null = null;
  for (const t of transactions) {
    const day = dayOf(t.executedAt);
    if (startDay === null || day < startDay) startDay = day;
    if (!assetById.has(t.assetId)) {
      throw new Error(
        `valueOverTime: transaction references asset ${t.assetId} with no price/currency input.`,
      );
    }
    const list = txnsByAsset.get(t.assetId);
    if (list) list.push(t);
    else txnsByAsset.set(t.assetId, [t]);
  }
  // startDay is non-null here (transactions.length > 0).
  if (startDay === null || startDay > today) return [];

  // Per-asset cursors, walked forward in lockstep with the day loop.
  interface Cursor {
    asset: ValueOverTimeAsset;
    txns: Transaction[]; // sorted ascending by day
    prices: PricePoint[]; // sorted ascending by date
    txnIdx: number;
    priceIdx: number;
    qty: number;
    lastClose: number | null;
  }
  const cursors: Cursor[] = [];
  for (const [assetId, txns] of txnsByAsset) {
    const asset = assetById.get(assetId);
    if (!asset) continue; // unreachable: validated above.
    // Within-day order is irrelevant here (quantities sum per day), so the day
    // key alone is a consistent sort key.
    const sortedTxns = [...txns].sort((a, b) => {
      const dayA = dayOf(a.executedAt);
      const dayB = dayOf(b.executedAt);
      return dayA < dayB ? -1 : dayA > dayB ? 1 : 0;
    });
    // Validate every point up front — a sort comparator never runs for 0/1
    // element arrays, so validation there would let a lone malformed date or a
    // NaN close silently mis-value the asset.
    for (const point of asset.prices) {
      assertIsoDate(point.date, 'price point date');
      if (!Number.isFinite(point.close)) {
        throw new Error(
          `Price point for ${asset.assetId} on ${point.date} must be a finite number, got ${point.close}`,
        );
      }
    }
    const sortedPrices = [...asset.prices].sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
    );
    cursors.push({
      asset,
      txns: sortedTxns,
      prices: sortedPrices,
      txnIdx: 0,
      priceIdx: 0,
      qty: 0,
      lastClose: null,
    });
  }

  // Pass 1 (sync): per day, sum each asset's native contribution by currency.
  const startMs = dateToMs(startDay);
  const endMs = dateToMs(today);
  const days: string[] = [];
  const buckets: Array<Map<string, number>> = [];
  for (let ms = startMs; ms <= endMs; ms += MS_PER_DAY) {
    const day = new Date(ms).toISOString().slice(0, 10);
    days.push(day);
    const bucket = new Map<string, number>();

    for (const c of cursors) {
      // Advance the holding through every transaction up to and including today.
      while (c.txnIdx < c.txns.length) {
        const txn = c.txns[c.txnIdx];
        if (txn === undefined || dayOf(txn.executedAt) > day) break;
        c.qty += txn.side === 'buy' ? txn.quantity : -txn.quantity;
        // No shorts (issue #369): an uncovered sell closes the position at 0, it
        // never goes negative — so a later buy rebuilds from 0, not from a
        // phantom debt. This also folds away the sell-everything float dust
        // (~±1e-15) that the display clamp below would otherwise handle.
        if (c.qty < QTY_EPSILON) c.qty = 0;
        c.txnIdx += 1;
      }
      // Advance the price to the latest close on or before today (carry forward).
      while (c.priceIdx < c.prices.length) {
        const point = c.prices[c.priceIdx];
        if (point === undefined || point.date > day) break;
        c.lastClose = point.close;
        c.priceIdx += 1;
      }

      // Clamp float dust / closed positions to exactly flat.
      const heldQty = c.qty > QTY_EPSILON ? c.qty : 0;
      if (heldQty === 0 || c.lastClose === null) continue;

      const native = heldQty * c.lastClose;
      bucket.set(c.asset.currency, (bucket.get(c.asset.currency) ?? 0) + native);
    }

    buckets.push(bucket);
  }

  // Pass 2 (async): resolve each distinct (currency, day) rate exactly once.
  const rateCache = new Map<string, Promise<number>>();
  const rateToBase = (currency: string, date: string): Promise<number> => {
    const key = `${currency}|${date}`;
    let pending = rateCache.get(key);
    if (!pending) {
      pending = converter.toBase(1, currency, { date });
      rateCache.set(key, pending);
    }
    return pending;
  };

  // Pass 3: combine native sums with their rates into the EUR series.
  const series: ValuePoint[] = [];
  for (let i = 0; i < days.length; i += 1) {
    const day = days[i];
    const bucket = buckets[i];
    if (day === undefined || bucket === undefined) continue; // unreachable
    let valueEur = 0;
    for (const [currency, native] of bucket) {
      const rate = await rateToBase(currency, day);
      if (!Number.isFinite(rate) || rate <= 0) {
        throw new Error(`Invalid FX rate ${rate} for ${currency} on ${day}`);
      }
      valueEur += native * rate;
    }
    series.push({ date: day, valueEur });
  }

  return series;
}

// ---------------------------------------------------------------------------
// Cost basis over time (V5-P1 snapshots, issue #553)
// ---------------------------------------------------------------------------

/** One point on the daily open-cost-basis series. */
export interface CostBasisPoint {
  /** ISO `YYYY-MM-DD`. */
  date: string;
  /** Open cost basis (Σ held qty · avg cost) in EUR at that day's FX rate. */
  costBasisEur: number;
}

/** Input for {@link costBasisOverTime} — deliberately the same shape as {@link valueOverTime}. */
export interface CostBasisOverTimeInput {
  /** Every transaction across the portfolio (any order). */
  transactions: readonly Transaction[];
  /**
   * One entry per transacted asset — the SAME inputs {@link valueOverTime}
   * takes. Only the price series' *dates* matter here: an asset contributes
   * cost basis on a day exactly when it would contribute value (a close on or
   * before that day exists), so `pl = value − cost` never mixes two different
   * asset sets. The close amounts themselves are never read.
   */
  assets: readonly ValueOverTimeAsset[];
  /** The last day of the series, ISO `YYYY-MM-DD`. */
  today: string;
  converter: CurrencyConverter;
}

/**
 * Reconstruct the daily **open cost basis** series in EUR (V5-P1 daily
 * snapshots, issue #553): for every calendar day from the first transaction to
 * `today`, `cost(d) = Σ over assets of qty_held(d) · avg_cost(d) · fx(ccy, d)`.
 *
 * The position math is **not re-derived here**: each asset's `(qty, avgCost)`
 * as of a day is {@link reducePosition} replayed over exactly the transactions
 * up to and including that day (prefixes preserve the input's relative order,
 * so same-instant tie-breaking matches a full replay — no forked formulas).
 * Between transaction days the state carries forward. Conversion happens at
 * each day's **historical** FX rate — the same convention the value series
 * uses — coalesced to one lookup per (currency, day), so the derived
 * `pl(d) = holdingsValue(d) − cost(d)` compares like with like day by day.
 *
 * An asset contributes only from the day its first price is known (the
 * {@link valueOverTime} gate): before that the value series carries 0 for it,
 * and a nonzero cost against a zero value would fake a total loss.
 *
 * Returns an empty series when there are no transactions, or when the first
 * transaction is after `today`.
 */
export async function costBasisOverTime(input: CostBasisOverTimeInput): Promise<CostBasisPoint[]> {
  const { transactions, assets, today, converter } = input;
  assertIsoDate(today, 'today');

  if (transactions.length === 0) return [];

  const assetById = new Map<string, ValueOverTimeAsset>();
  for (const a of assets) assetById.set(a.assetId, a);

  // Group transactions by asset (original order preserved) + find the start day.
  const txnsByAsset = new Map<string, Transaction[]>();
  let startDay: string | null = null;
  for (const t of transactions) {
    const day = dayOf(t.executedAt);
    if (startDay === null || day < startDay) startDay = day;
    if (!assetById.has(t.assetId)) {
      throw new Error(
        `costBasisOverTime: transaction references asset ${t.assetId} with no price/currency input.`,
      );
    }
    const list = txnsByAsset.get(t.assetId);
    if (list) list.push(t);
    else txnsByAsset.set(t.assetId, [t]);
  }
  if (startDay === null || startDay > today) return [];

  // Per-asset cursors: the distinct transaction days (each holding a prefix
  // reduction of every transaction up to and including that day) plus a price
  // cursor for the priced-yet gate.
  interface Cursor {
    currency: string;
    /** Ascending distinct txn days, each with the reduced state through that day. */
    states: Array<{ day: string; quantity: number; avgCost: number }>;
    priceDates: string[]; // sorted ascending
    stateIdx: number;
    priceIdx: number;
    quantity: number;
    avgCost: number;
    priced: boolean;
  }
  const cursors: Cursor[] = [];
  for (const [assetId, txns] of txnsByAsset) {
    const asset = assetById.get(assetId);
    if (!asset) continue; // unreachable: validated above
    const distinctDays = [...new Set(txns.map((t) => dayOf(t.executedAt)))].sort();
    // Prefix replays reuse reducePosition verbatim — the money math has one
    // home. A filter preserves relative input order, so ties resolve exactly
    // as they would in a full replay.
    const states = distinctDays.map((day) => {
      const prefix = txns.filter((t) => dayOf(t.executedAt) <= day);
      const state = reducePosition(prefix);
      return { day, quantity: state.quantity, avgCost: state.avgCost };
    });
    for (const point of asset.prices) assertIsoDate(point.date, 'price point date');
    const priceDates = asset.prices.map((p) => p.date).sort();
    cursors.push({
      currency: asset.currency,
      states,
      priceDates,
      stateIdx: 0,
      priceIdx: 0,
      quantity: 0,
      avgCost: 0,
      priced: false,
    });
  }

  // Pass 1 (sync): per day, sum each asset's native open cost by currency.
  const startMs = dateToMs(startDay);
  const endMs = dateToMs(today);
  const days: string[] = [];
  const buckets: Array<Map<string, number>> = [];
  for (let ms = startMs; ms <= endMs; ms += MS_PER_DAY) {
    const day = new Date(ms).toISOString().slice(0, 10);
    days.push(day);
    const bucket = new Map<string, number>();

    for (const c of cursors) {
      while (c.stateIdx < c.states.length) {
        const state = c.states[c.stateIdx];
        if (state === undefined || state.day > day) break;
        c.quantity = state.quantity;
        c.avgCost = state.avgCost;
        c.stateIdx += 1;
      }
      while (c.priceIdx < c.priceDates.length) {
        const date = c.priceDates[c.priceIdx];
        if (date === undefined || date > day) break;
        c.priced = true;
        c.priceIdx += 1;
      }
      if (!c.priced || c.quantity <= QTY_EPSILON) continue;
      const native = c.quantity * c.avgCost;
      if (native === 0) continue;
      bucket.set(c.currency, (bucket.get(c.currency) ?? 0) + native);
    }

    buckets.push(bucket);
  }

  // Pass 2 (async): one FX resolution per distinct (currency, day) — the same
  // coalescing valueOverTime applies, and conversion is linear so summing
  // native amounts first is exact.
  const rateCache = new Map<string, Promise<number>>();
  const rateToBase = (currency: string, date: string): Promise<number> => {
    const key = `${currency}|${date}`;
    let pending = rateCache.get(key);
    if (!pending) {
      pending = converter.toBase(1, currency, { date });
      rateCache.set(key, pending);
    }
    return pending;
  };

  const series: CostBasisPoint[] = [];
  for (let i = 0; i < days.length; i += 1) {
    const day = days[i];
    const bucket = buckets[i];
    if (day === undefined || bucket === undefined) continue; // unreachable
    let costBasisEur = 0;
    for (const [currency, native] of bucket) {
      const rate = await rateToBase(currency, day);
      if (!Number.isFinite(rate) || rate <= 0) {
        throw new Error(`Invalid FX rate ${rate} for ${currency} on ${day}`);
      }
      costBasisEur += native * rate;
    }
    series.push({ date: day, costBasisEur });
  }

  return series;
}

// ---------------------------------------------------------------------------
// Performance over time — time-weighted return (issue #125)
// ---------------------------------------------------------------------------

/**
 * EUR value comparison tolerance for the performance series: below this a
 * day's value or return denominator is float dust (or genuinely empty), not a
 * measurable amount, and the return for that segment is treated as flat.
 */
export const VALUE_EPSILON = 1e-9;

/** One day's net **external** cash flow into the portfolio, EUR. */
export interface FlowPoint {
  /** ISO `YYYY-MM-DD`. */
  date: string;
  /**
   * Net flow that day in EUR: money moving *into* the portfolio is positive
   * (a BUY costs `qty · price + fee`), money moving *out* is negative (a SELL
   * returns `qty · price − fee`). Fees therefore stay inside the flow, so the
   * derived performance is **net of transaction costs**.
   */
  flowEur: number;
}

/** Input for {@link netFlowsOverTime}. */
export interface NetFlowsInput {
  /** Every transaction across the portfolio (any order). */
  transactions: readonly Transaction[];
  /** ISO-4217 native currency per transacted asset id; a missing asset throws. */
  currencyByAsset: ReadonlyMap<string, string>;
  converter: CurrencyConverter;
}

/**
 * The portfolio's daily net external cash flows in EUR (issue #125) — the
 * companion series {@link timeWeightedReturn} needs to strip deposits and
 * withdrawals out of the value curve.
 *
 * In BetterTrack there is no cash balance: transactions *are* the external
 * flows. A BUY is money entering (cost plus fee), a SELL is money leaving
 * (proceeds net of fee). Same-day flows aggregate per (currency, day) first —
 * conversion is linear, so summing native amounts before converting is exact —
 * and each distinct (currency, day) rate is fetched once, mirroring the FX
 * coalescing in {@link valueOverTime}.
 *
 * Returns a **sparse** series (only days with a flow), sorted ascending.
 */
export async function netFlowsOverTime(input: NetFlowsInput): Promise<FlowPoint[]> {
  const { transactions, currencyByAsset, converter } = input;

  // Pass 1 (sync): signed native flow summed per (day, currency).
  const nativeByDay = new Map<string, Map<string, number>>();
  for (const t of transactions) {
    const day = dayOf(t.executedAt);
    const currency = currencyByAsset.get(t.assetId);
    if (currency === undefined) {
      throw new Error(
        `netFlowsOverTime: transaction references asset ${t.assetId} with no currency input.`,
      );
    }
    if (!Number.isFinite(t.quantity) || !Number.isFinite(t.price) || !Number.isFinite(t.fee)) {
      throw new Error(`netFlowsOverTime: non-finite quantity/price/fee on ${t.executedAt}`);
    }
    const native =
      t.side === 'buy' ? t.quantity * t.price + t.fee : -(t.quantity * t.price - t.fee);
    const bucket = nativeByDay.get(day) ?? new Map<string, number>();
    bucket.set(currency, (bucket.get(currency) ?? 0) + native);
    nativeByDay.set(day, bucket);
  }

  // Pass 2 (async): one FX resolution per distinct (currency, day).
  const rateCache = new Map<string, Promise<number>>();
  const rateToBase = (currency: string, date: string): Promise<number> => {
    const key = `${currency}|${date}`;
    let pending = rateCache.get(key);
    if (!pending) {
      pending = converter.toBase(1, currency, { date });
      rateCache.set(key, pending);
    }
    return pending;
  };

  const days = [...nativeByDay.keys()].sort();
  const flows: FlowPoint[] = [];
  for (const day of days) {
    const bucket = nativeByDay.get(day);
    if (bucket === undefined) continue; // unreachable
    let flowEur = 0;
    for (const [currency, native] of bucket) {
      const rate = await rateToBase(currency, day);
      if (!Number.isFinite(rate) || rate <= 0) {
        throw new Error(`Invalid FX rate ${rate} for ${currency} on ${day}`);
      }
      flowEur += native * rate;
    }
    flows.push({ date: day, flowEur });
  }
  return flows;
}

/** One point on the performance (time-weighted return) series. */
export interface PerformancePoint {
  /** ISO `YYYY-MM-DD`. */
  date: string;
  /** Cumulative time-weighted return since the series start, in percent (0 = flat). */
  pct: number;
}

/**
 * Cash-flow-neutralized performance of the value series: the daily
 * **time-weighted return**, chain-linked and expressed as a cumulative
 * percentage (issue #125). A 1 000 € deposit causes **no** jump — the curve
 * moves only when holdings move.
 *
 * Daily linking uses the robust hybrid flow convention: **inflows count at the
 * start of the day, outflows at the end** —
 *
 *     r_d = (V_d − min(F_d, 0)) / (V_{d−1} + max(F_d, 0))
 *
 * so a buy's execution→close move on the new money is genuine day-`d`
 * performance, while a full liquidation still books its final day correctly
 * (`V_d = 0` with the proceeds in the numerator) instead of collapsing to
 * −100 %. Degenerate segments — a zero denominator (nothing invested yet, or a
 * flat stretch after selling everything) or a zero numerator (a day whose value
 * is 0 only because no price is known yet) — carry no performance information
 * and link as flat (`r = 1`); the curve simply resumes when data does. This
 * keeps the chained index strictly positive, so a later rebase is always
 * well-defined.
 *
 * Inflows on such pre-price days are not lost, though: while the value is
 * unmeasurable, incoming cash accumulates into the linking base, so the first
 * real value point links against the money actually put in (issue #218 — a
 * custom asset bought before its first value point shows its true first move,
 * not 0 %). The residual tradeoff: a *partial* sell before the first value
 * point books against that full basis as if the remainder were worth 0 — with
 * no price the domain cannot know otherwise, and a full pre-price liquidation
 * (the far likelier case) is booked correctly by the same rule.
 *
 * A zero-value day **without** a flow is treated as a data gap, not a
 * liquidation, and the previous real value is kept as the next day's linking
 * base — so the move across the gap still counts instead of being dropped from
 * the chain. The flip side: a genuine total-loss day (true value 0, no flow)
 * is indistinguishable from such a gap and also links flat rather than −100 %.
 * That is a deliberate tradeoff — {@link valueOverTime} carries closes
 * forward, so a true zero close cannot occur there; only a flow (a sell) takes
 * the reconstructed value to 0.
 *
 * Flows on days outside the value series (e.g. a future-dated transaction) are
 * ignored — that money never enters the plotted window.
 */
export function timeWeightedReturn(
  values: readonly ValuePoint[],
  flows: readonly FlowPoint[],
): PerformancePoint[] {
  const flowByDate = new Map<string, number>();
  for (const f of flows) {
    assertIsoDate(f.date, 'flow point date');
    if (!Number.isFinite(f.flowEur)) {
      throw new Error(`Flow on ${f.date} must be a finite number, got ${f.flowEur}`);
    }
    flowByDate.set(f.date, (flowByDate.get(f.date) ?? 0) + f.flowEur);
  }

  const sorted = [...values].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const series: PerformancePoint[] = [];
  let index = 1;
  let prevValue = 0;
  for (const point of sorted) {
    assertIsoDate(point.date, 'value point date');
    if (!Number.isFinite(point.valueEur)) {
      throw new Error(`Value on ${point.date} must be a finite number, got ${point.valueEur}`);
    }
    const flow = flowByDate.get(point.date) ?? 0;
    const numerator = point.valueEur - Math.min(flow, 0);
    const denominator = prevValue + Math.max(flow, 0);
    const r =
      numerator > VALUE_EPSILON && denominator > VALUE_EPSILON ? numerator / denominator : 1;
    index *= r;
    series.push({ date: point.date, pct: (index - 1) * 100 });
    // Next day's linking base (see docstring):
    //  - a real value is the base;
    //  - a flow-less zero-value day is a data gap — keep the last base so the
    //    move across the gap isn't lost;
    //  - an INFLOW day with no measurable value means the assets have no price
    //    yet (a custom asset transacted before its first value point): the cash
    //    that came in IS the invested basis, so accumulate it (issue #218) —
    //    the first real value then links against the money put in instead of
    //    collapsing the whole pre-price stretch to a flat 0 %;
    //  - an OUTFLOW day with no value is a genuine liquidation and the base
    //    resets (that day's return was already booked via the numerator).
    if (point.valueEur > VALUE_EPSILON) prevValue = point.valueEur;
    else if (flow > 0) prevValue += flow;
    else if (flow < 0) prevValue = 0;
  }
  return series;
}

/**
 * Re-express a performance series relative to its own first point (issue #125):
 * the first point becomes 0 % and every later point the TWR **since that
 * window start** — what a range-sliced (1M/6M/1Y) performance chart shows.
 * Compounding, not subtraction: percentages don't add across time.
 */
export function rebasePerformance(points: readonly PerformancePoint[]): PerformancePoint[] {
  const first = points[0];
  if (first === undefined) return [];
  const base = 1 + first.pct / 100;
  // timeWeightedReturn keeps the chained index strictly positive, so a
  // non-positive base means corrupted input — fail loud on the money path.
  if (!Number.isFinite(base) || base <= 0) {
    throw new Error(`rebasePerformance: non-positive base index ${base} at ${first.date}`);
  }
  return points.map((p) => ({ date: p.date, pct: ((1 + p.pct / 100) / base - 1) * 100 }));
}
