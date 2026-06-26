/**
 * Portfolio money-math core (PROJECTPLAN.md §6.9, §5.4).
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
 *
 * **Purity (a hard requirement, §6.9 acceptance):** everything here is a pure
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
 * shares" — §6.9). A typed error so the write path can map it to a 400 rather
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
 * A single portfolio transaction in its asset's **native currency** (§6.9).
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
  /** Per-SELL realized P/L, for the transaction rows (§6.9). */
  realizations: SellRealization[];
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number, got ${value}`);
  }
}

/**
 * Average-cost basis and realized P/L for one asset's transactions (§6.9).
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
  // how the caller supplied the list.
  const ordered = transactions
    .map((t, index) => ({ t, index }))
    .sort((a, b) => {
      if (a.t.executedAt < b.t.executedAt) return -1;
      if (a.t.executedAt > b.t.executedAt) return 1;
      return a.index - b.index;
    });

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
        throw new OversellError(t.quantity, held, assetId);
      }
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
 * One row of the holdings view (§6.9). Native-currency facts (`avgCost`,
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
 * Derive the holdings view (§6.9) for a set of assets from their transactions.
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

/** A daily close / custom-asset value point, native currency (§5.3). */
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
   * treatment of sparse custom-asset data (§6.9).
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
 * Reconstruct the daily portfolio value series in EUR (§6.9).
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
    const sortedTxns = [...txns].sort((a, b) =>
      dayOf(a.executedAt) < dayOf(b.executedAt) ? -1 : 1,
    );
    const sortedPrices = [...asset.prices].sort((a, b) => {
      assertIsoDate(a.date, 'price point date');
      assertIsoDate(b.date, 'price point date');
      return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    });
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
