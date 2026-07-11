import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import type {
  CashPreviewResponse,
  CashSource,
  SearchResultItem,
  Transaction,
  TransactionInput,
  TransactionSide,
  UpdateTransactionRequest,
} from '@bettertrack/contracts';

import { useT, type TranslateFn } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import { getAssetDailyCloses } from '../../lib/assetApi';
import {
  createTransactions,
  previewCash,
  updatePortfolio,
  updateTransaction,
} from '../../lib/portfolioApi';
import { pickDefaultSourceId } from '../portfolio/cashSourceUtils';
import { formatMoney, formatQuantity } from '../../lib/format';
import { MoneyText } from '../../ui';
import { useDebounce } from '../hooks/useDebounce';
import { AssetSearchBox } from './AssetSearchBox';
import { Dialog } from './Dialog';
import {
  dateForPrice,
  formatSeriesPrice,
  priceForDate,
  toDailyPoints,
  weekdayShort,
  type DailyPoint,
} from './priceDateLink';
import { Alert, Button, cx } from './ui';

/** Compact native-currency suffix for the Price field (falls back to the code). */
function currencySuffix(code: string): string {
  const map: Record<string, string> = { EUR: '€', USD: '$', GBP: '£', JPY: '¥' };
  return map[code] ?? code;
}

/** The minimal asset identity a transaction row needs to display + post. */
export interface TransactionDialogAsset {
  id: string;
  symbol: string;
  name: string;
  /** ISO-4217 native currency — prices and fees are entered in it (§6.9). */
  currency: string;
}

/** A prefilled line for the bulk buy flow (e.g. Builder → Add to Portfolio, §6.5). */
export interface TransactionPrefillRow {
  asset: TransactionDialogAsset;
  side?: TransactionSide;
  quantity?: number;
  price?: number;
  fee?: number;
  /** ISO `YYYY-MM-DD`; defaults to today. */
  date?: string;
  note?: string;
}

export interface TransactionDialogProps {
  /** The portfolio these transactions belong to (§6.8 — the API is id-scoped). */
  portfolioId: string;
  onClose: () => void;
  /** Called after a successful create/edit so the page can refetch. */
  onSubmitted: () => void;
  /** Edit mode: the existing transaction (its asset is fixed). */
  transaction?: Transaction;
  /** Create mode: lock the form to one asset (e.g. a holding's "Record transaction"). */
  asset?: TransactionDialogAsset | null;
  /** Create mode: prefilled rows to review and submit together (single & bulk, §7.3). */
  prefill?: TransactionPrefillRow[] | null;
  /**
   * The portfolio's sticky "pay from cash" default (§14, #220): preselects the
   * cash-link checkbox on the single-asset create row. Always shown, never
   * silently applied — the user still sees and can uncheck it before submit.
   */
  defaultPayFromCash?: boolean;
  /**
   * The portfolio's active cash sources (V3-P3). When a cash-linked buy/sell has
   * more than one source to choose from, a picker appears next to the checkbox;
   * with only Main it stays hidden and the flow funds/receives from Main. Omitted
   * → no picker (the server defaults to Main).
   */
  cashSources?: CashSource[];
  /** The portfolio's display name, shown as the grey header subtitle (#378). */
  portfolioName?: string;
  /**
   * The Main cash source's EUR balance, for the buy-from-cash "Max affordable"
   * chip (#378). Web always funds from Main (no source picker), so this is the
   * balance a pay-from-cash buy draws on. Omitted → no affordability Max.
   */
  availableCashEur?: number;
  /**
   * The quantity currently held of the locked/edited asset, for the sell "Max"
   * chip (#378). Omitted → no held Max (e.g. a freshly searched asset).
   */
  heldQuantity?: number;
  /** Today as ISO `YYYY-MM-DD`, injectable for deterministic tests. */
  today?: string;
}

/**
 * How the user is entering the trade size.
 * - `quantity`: enter quantity + price (the canonical stored shape).
 * - `amount`: enter price + total amount (invested on buy / received on sell);
 *   the quantity is derived as `amount / price` (§14, owner request 2026-07-02).
 */
export type EntryMode = 'quantity' | 'amount';

/** One editable transaction line. Numeric fields are raw strings, parsed on submit. */
interface Row {
  key: string;
  asset: TransactionDialogAsset;
  side: TransactionSide;
  entryMode: EntryMode;
  quantity: string;
  /** Total money moved, used only when `entryMode === 'amount'`. */
  amount: string;
  price: string;
  fee: string;
  date: string;
  note: string;
  /**
   * "Pay from cash balance" (buy) / "Add proceeds to cash balance" (sell), §14.
   * One flag whose meaning follows `side` so a side switch doesn't silently
   * drop the user's cash-link choice.
   */
  cashLinked: boolean;
  /**
   * Backdated pay-from-cash: settle the cash leg as of today (#378). Only sent
   * on a cash-linked BUY whose cash was insufficient at the buy date — the
   * acquisition keeps its past date, the withdrawal moves to today.
   */
  settleCashAsOfToday: boolean;
  /**
   * Uncovered sell acknowledgment (issue #369): the user confirmed selling more
   * than they hold. Only meaningful while the row is genuinely uncovered
   * (sell quantity > held); resets are handled by the detection, not the flag.
   */
  allowUncovered: boolean;
  /**
   * How the uncovered shares are basised (#369): `zero` = count as 0 % (basis =
   * sale price → no gain, the default); `entry` = the user typed the original
   * buy-in price in {@link uncoveredEntryPrice}.
   */
  uncoveredMode: 'zero' | 'entry';
  /** Native per-unit buy-in price for the uncovered shares (mode `entry`), raw. */
  uncoveredEntryPrice: string;
}

/**
 * Decimal places the derived quantity is rounded to. Eight covers fractional
 * shares and crypto (BTC has 8 — a satoshi); the same precision Yahoo/most
 * brokers surface. Rounding is round-half-up via `Math.round`.
 */
export const DERIVED_QUANTITY_DECIMALS = 8;

export interface DerivedQuantity {
  /** `amount / price`, rounded to {@link DERIVED_QUANTITY_DECIMALS}. */
  quantity: number;
  /** `quantity * price` — the money that will actually be recorded. */
  recordedAmount: number;
  /** `recordedAmount - amount`: the rounding residual, disclosed to the user. */
  residual: number;
}

/**
 * Derive a canonical quantity from a (price, amount) pair. Returns `null` when
 * the inputs cannot yield a valid, positive, finite quantity — so callers never
 * submit NaN/Infinity. The recorded cost basis is `quantity * price`, which may
 * differ from the entered `amount` by up to half a unit in the last decimal
 * times the price; that residual is surfaced in the UI, never hidden.
 */
export function deriveQuantityFromAmount(price: number, amount: number): DerivedQuantity | null {
  if (!Number.isFinite(price) || !Number.isFinite(amount)) return null;
  if (price <= 0 || amount <= 0) return null;
  const factor = 10 ** DERIVED_QUANTITY_DECIMALS;
  const quantity = Math.round((amount / price) * factor) / factor;
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  const recordedAmount = quantity * price;
  return { quantity, recordedAmount, residual: recordedAmount - amount };
}

/** Render a quantity with up to {@link DERIVED_QUANTITY_DECIMALS}, trimming trailing zeros. */
export function formatDerivedQuantity(quantity: number): string {
  const fixed = quantity.toFixed(DERIVED_QUANTITY_DECIMALS);
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

/**
 * A dot-decimal money string for the amount **input** field (fill-max and
 * mode-switch preservation). It feeds a raw `<input>` value re-parsed with
 * `Number()`, so it must stay locale-independent (always `.`) — this is NOT
 * display; user-facing money renders through the shared `formatMoney`.
 */
function amountToInput(amount: number): string {
  return amount.toFixed(2);
}

/**
 * Outlined field (#378 brand tokens): #171717 fill, #262626 border, tabular
 * figures, and the one accent — a gold ring on focus. Paired with a `group`
 * wrapper the label turns gold too (`group-focus-within`). Number spinners are
 * suppressed so the €-suffix / link adornment sits flush.
 */
const inputClass = cx(
  'w-full rounded-lg bg-neutral-900 px-3 py-2.5 text-sm tabular-nums text-neutral-100',
  'ring-1 ring-inset ring-neutral-800 placeholder:text-neutral-600',
  'focus:outline-none focus:ring-2 focus:ring-[#F6B82E]',
  '[&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [&]:[-moz-appearance:textfield]',
);

/** Grey uppercase field label that turns gold while its field is focused. */
function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-[0.7rem] font-medium uppercase tracking-wide text-neutral-500 transition-colors group-focus-within:text-[#F6B82E]">
      {children}
    </span>
  );
}

/** Local UTC-day so the default date matches the value-series day key (§6.9). */
function isoToday(today?: string): string {
  if (today) return today;
  return new Date().toISOString().slice(0, 10);
}

function numToInput(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

function makeRow(
  key: string,
  asset: TransactionDialogAsset,
  today: string,
  seed?: Partial<Row>,
): Row {
  return {
    key,
    asset,
    side: 'buy',
    entryMode: 'quantity',
    quantity: '',
    amount: '',
    price: '',
    fee: '',
    date: today,
    note: '',
    cashLinked: false,
    settleCashAsOfToday: false,
    allowUncovered: false,
    uncoveredMode: 'zero',
    uncoveredEntryPrice: '',
    ...seed,
  };
}

function rowsFromProps(props: TransactionDialogProps, today: string): Row[] {
  if (props.transaction) {
    const t = props.transaction;
    return [
      {
        key: t.id,
        asset: {
          id: t.asset.id,
          symbol: t.asset.symbol,
          name: t.asset.name,
          currency: t.asset.currency,
        },
        side: t.side,
        entryMode: 'quantity',
        quantity: String(t.quantity),
        amount: '',
        price: String(t.price),
        fee: String(t.fee),
        date: t.executedAt.slice(0, 10),
        note: t.note ?? '',
        cashLinked: false,
        settleCashAsOfToday: false,
        allowUncovered: false,
        uncoveredMode: 'zero',
        uncoveredEntryPrice: '',
      },
    ];
  }
  if (props.prefill && props.prefill.length > 0) {
    return props.prefill.map((p, i) =>
      makeRow(`prefill-${i}`, p.asset, today, {
        side: p.side ?? 'buy',
        quantity: numToInput(p.quantity),
        price: numToInput(p.price),
        fee: numToInput(p.fee),
        date: p.date ?? today,
        note: p.note ?? '',
      }),
    );
  }
  if (props.asset) {
    return [
      makeRow('locked', props.asset, today, { cashLinked: props.defaultPayFromCash ?? false }),
    ];
  }
  return [];
}

/** Parse a row into a wire `TransactionInput`, or collect a human error. */
function validateRow(row: Row): { input?: TransactionInput; error?: string } {
  const price = Number(row.price);
  const fee = row.fee.trim() === '' ? 0 : Number(row.fee);

  let quantity: number;

  if (row.entryMode === 'amount') {
    // Amount mode divides by price, so price must be strictly positive here
    // (unlike quantity mode, where a 0 price — e.g. an airdrop — is allowed).
    const amount = Number(row.amount);
    if (!row.price.trim() || !Number.isFinite(price) || price <= 0) {
      return { error: `${row.asset.symbol}: price must be greater than 0.` };
    }
    if (!row.amount.trim() || !Number.isFinite(amount) || amount <= 0) {
      return { error: `${row.asset.symbol}: amount must be greater than 0.` };
    }
    const derived = deriveQuantityFromAmount(price, amount);
    if (!derived) {
      return {
        error: `${row.asset.symbol}: could not derive a valid quantity from that price and amount.`,
      };
    }
    quantity = derived.quantity;
  } else {
    quantity = Number(row.quantity);
    if (!row.quantity.trim() || !Number.isFinite(quantity) || quantity <= 0) {
      return { error: `${row.asset.symbol}: quantity must be greater than 0.` };
    }
    if (!row.price.trim() || !Number.isFinite(price) || price < 0) {
      return { error: `${row.asset.symbol}: price must be 0 or more.` };
    }
  }

  if (!Number.isFinite(fee) || fee < 0) {
    return { error: `${row.asset.symbol}: fee must be 0 or more.` };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) {
    return { error: `${row.asset.symbol}: pick a valid date.` };
  }

  return {
    input: {
      assetId: row.asset.id,
      side: row.side,
      quantity,
      price,
      fee,
      // Anchor at UTC midnight so the date portion (the value-series day key) is
      // exactly the chosen calendar day — no timezone off-by-one (§6.9 domain).
      executedAt: `${row.date}T00:00:00.000Z`,
      note: row.note.trim() === '' ? null : row.note.trim(),
      // §14: the checkbox's meaning follows the row's own side, never a stale one.
      payFromCash: row.cashLinked && row.side === 'buy' ? true : undefined,
      addProceedsToCash: row.cashLinked && row.side === 'sell' ? true : undefined,
      // #378: only a cash-linked buy can settle its cash leg as of today.
      settleCashAsOfToday:
        row.cashLinked && row.side === 'buy' && row.settleCashAsOfToday ? true : undefined,
    },
  };
}

/** The row's (quantity, price) as it would be recorded, or `null` while incomplete. */
function resolveRowQuantityPrice(row: Row): { quantity: number; price: number } | null {
  const price = Number(row.price);
  if (!row.price.trim() || !Number.isFinite(price) || price < 0) return null;
  if (row.entryMode === 'amount') {
    if (price <= 0) return null;
    const amount = Number(row.amount);
    if (!row.amount.trim() || !Number.isFinite(amount) || amount <= 0) return null;
    const derived = deriveQuantityFromAmount(price, amount);
    return derived ? { quantity: derived.quantity, price } : null;
  }
  const quantity = Number(row.quantity);
  if (!row.quantity.trim() || !Number.isFinite(quantity) || quantity <= 0) return null;
  return { quantity, price };
}

/** Quantity tolerance for the uncovered-sell trigger (mirrors domain QTY_EPSILON). */
const UNCOVERED_QTY_EPSILON = 1e-9;

/** An uncovered sell: how much of the sell isn't covered by the holding (#369). */
interface UncoveredInfo {
  /** Currently held quantity, clamped ≥ 0. */
  held: number;
  /** The resolved sell quantity. */
  sellQty: number;
  /** `sellQty − held`: shares being sold that aren't held. */
  uncoveredQty: number;
}

/**
 * Detect an uncovered sell (issue #369): a SELL whose resolved quantity exceeds
 * the held position (a **zero** holding counts). Returns `null` when the row is
 * not a sell, the holding is unknown (a freshly searched asset), or the sell is
 * fully covered.
 */
function uncoveredForRow(row: Row, heldQuantity: number | undefined): UncoveredInfo | null {
  if (row.side !== 'sell' || heldQuantity == null) return null;
  const resolved = resolveRowQuantityPrice(row);
  if (!resolved) return null;
  const held = heldQuantity > 0 ? heldQuantity : 0;
  if (resolved.quantity <= held + UNCOVERED_QTY_EPSILON) return null;
  return { held, sellQty: resolved.quantity, uncoveredQty: resolved.quantity - held };
}

/**
 * The EUR amount a cash-linked row would move (§14): quantity·price + fee for a
 * buy funded from cash, quantity·price − fee for a sell's net proceeds — mirrors
 * `portfolioService.buildCashLink`. Native-currency assets are previewed as-is;
 * the server converts to EUR via the historical rate at submit time, so this is
 * an estimate for non-EUR assets, good enough to block an obvious overdraw.
 */
function cashAmountForRow(row: Row): number | null {
  const resolved = resolveRowQuantityPrice(row);
  if (!resolved) return null;
  const feeInput = Number(row.fee);
  const fee = row.fee.trim() !== '' && Number.isFinite(feeInput) && feeInput >= 0 ? feeInput : 0;
  const gross = resolved.quantity * resolved.price;
  const amount = row.side === 'buy' ? gross + fee : gross - fee;
  return amount > 0 ? amount : null;
}

/**
 * The row's order value for the pinned footer Total (#378): cost on a buy
 * (quantity·price + fee), proceeds on a sell (quantity·price − fee). Unlike
 * {@link cashAmountForRow} it keeps non-positive values so the Total tracks
 * live; `null` only while the row is incomplete.
 */
function orderTotalForRow(row: Row): number | null {
  const resolved = resolveRowQuantityPrice(row);
  if (!resolved) return null;
  const feeInput = Number(row.fee);
  const fee = row.fee.trim() !== '' && Number.isFinite(feeInput) && feeInput >= 0 ? feeInput : 0;
  const gross = resolved.quantity * resolved.price;
  return row.side === 'buy' ? gross + fee : gross - fee;
}

/**
 * Record / edit transactions (PROJECTPLAN.md §6.9, §7.3 `TransactionDialog`).
 * Single (locked asset or free search pick), edit, and bulk-prefilled in one
 * component; the buy flow always posts the `{ transactions: [...] }` batch.
 */
export function TransactionDialog(props: TransactionDialogProps) {
  const { portfolioId, onClose, onSubmitted, transaction } = props;
  const t = useT();
  const isEdit = !!transaction;
  const today = isoToday(props.today);
  const headingId = useId();

  // Web funds/receives cash from the portfolio's Main source — no source picker
  // (#378). The API still accepts `cashSourceId`, so send the resolved Main id
  // when known; the server falls back to Main when it is omitted.
  const cashSourceId = pickDefaultSourceId(props.cashSources ?? []);

  const [rows, setRows] = useState<Row[]>(() => rowsFromProps(props, today));
  const [picking, setPicking] = useState<boolean>(rows.length === 0);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // --- Linked date ↔ price fields (#226) ------------------------------------
  // The assist applies only to a single-asset *create* flow: bulk prefill prices
  // at current market by design, and edit opens on the stored values. The daily
  // close series is fetched once per asset and both directions resolve locally.
  const linkingEnabled = !isEdit && !props.prefill;
  const linkAsset = linkingEnabled && rows.length === 1 ? rows[0]!.asset : null;
  const linkAssetId = linkAsset?.id ?? null;

  const [linked, setLinked] = useState(true);
  const [series, setSeries] = useState<DailyPoint[] | null>(null);
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [priceAuto, setPriceAuto] = useState(false);
  const [dateAuto, setDateAuto] = useState(false);
  const [linkNote, setLinkNote] = useState<string | null>(null);
  /** Set once the user types a price, so the load-time auto-fill never clobbers it. */
  const manualPrice = useRef(false);

  useEffect(() => {
    if (!linkAssetId) {
      setSeries(null);
      return;
    }
    const controller = new AbortController();
    manualPrice.current = false;
    setSeriesLoading(true);
    setSeries(null);
    setLinkNote(null);
    setPriceAuto(false);
    setDateAuto(false);
    getAssetDailyCloses(linkAssetId, controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return;
        const points = toDailyPoints(res.points);
        setSeries(points);
        // Default-on-open: fill an empty price with the latest close (≈ current
        // price at daily granularity), so Record with no edits books at today's
        // price. Never overwrite a value the user already typed.
        if (points.length > 0 && !manualPrice.current) {
          const latest = formatSeriesPrice(points[points.length - 1]!.close);
          setRows((rs) =>
            rs.length === 1 && rs[0]!.price.trim() === '' ? [{ ...rs[0]!, price: latest }] : rs,
          );
          setPriceAuto(true);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setSeries([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setSeriesLoading(false);
      });
    return () => controller.abort();
  }, [linkAssetId]);

  const hasSeries = series !== null && series.length > 0;

  function setSingleRow(patch: Partial<Row>) {
    setRows((rs) => (rs.length === 1 ? [{ ...rs[0]!, ...patch }] : rs));
  }

  /** Date drives price: fill the close for the picked day (or the prior trading day). */
  function resolveDateToPrice(date: string) {
    if (!linked || !hasSeries) return;
    const res = priceForDate(series!, date);
    if (!res) {
      setLinkNote('No price data on or before that date.');
      return;
    }
    setSingleRow({ price: formatSeriesPrice(res.price) });
    setPriceAuto(true);
    setLinkNote(res.adjusted ? `Market closed — using ${weekdayShort(res.date)} close.` : null);
  }

  /** Price drives date: jump to the most recent day the series was at that price. */
  function resolvePriceToDate() {
    if (!linked || !hasSeries || rows.length !== 1) return;
    const raw = rows[0]!.price.trim();
    if (raw === '') return;
    const price = Number(raw);
    if (!Number.isFinite(price) || price <= 0) return;
    const res = dateForPrice(series!, price);
    if (!res) {
      setLinkNote('Never at this price in available history.');
      return;
    }
    setSingleRow({ date: res.date });
    setDateAuto(true);
    setLinkNote(null);
  }

  /** Change handler for the linked row: last-edited field drives its partner. */
  function handleLinkedChange(patch: Partial<Row>) {
    if ('date' in patch && typeof patch.date === 'string') {
      setDateAuto(false);
      setSingleRow(patch);
      resolveDateToPrice(patch.date);
      return;
    }
    if ('price' in patch) {
      manualPrice.current = true;
      setPriceAuto(false);
      setLinkNote(null);
      setSingleRow(patch);
      return;
    }
    setSingleRow(patch);
  }

  /** Commit price → date on blur only (never per keystroke, §5.3), and only for a typed price. */
  function handlePriceBlur() {
    if (linked && !priceAuto) resolvePriceToDate();
  }

  function toggleLinked() {
    const next = !linked;
    setLinked(next);
    if (!next) {
      // Unlinked: both fields become fully manual — drop the auto markers/note.
      setPriceAuto(false);
      setDateAuto(false);
      setLinkNote(null);
    }
  }

  function updateRow(key: string, patch: Partial<Row>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  // --- Cash-link preview (§14, #220; date-aware #378) -----------------------
  // Eligible only for the single-asset create row (bulk prefill is out of
  // scope — V2-P7 — and an edit doesn't carry cash flags at all).
  const cashRow = linkingEnabled && rows.length === 1 ? rows[0]! : null;
  const cashRowLinked = cashRow?.cashLinked ?? false;
  const cashRowSide = cashRow?.side ?? null;
  const cashRowDate = cashRow?.date ?? null;
  const cashAmount = cashRowLinked && cashRow ? cashAmountForRow(cashRow) : null;
  const debouncedCashAmount = useDebounce(cashAmount, 400);
  // A backdated pay-from-cash BUY asks the server for the cash spendable AS OF
  // its date (#378), so the preview can warn "short back then" instead of
  // checking only today's balance.
  const asOfDateForPreview =
    cashRowLinked && cashRowSide === 'buy' && cashRowDate && cashRowDate < today
      ? cashRowDate
      : undefined;
  /** Set once the user picks the settle-as-of-today opt-in, so we stop defaulting it. */
  const settleTouched = useRef(false);

  const [cashPreview, setCashPreview] = useState<CashPreviewResponse | null>(null);
  const [cashPreviewLoading, setCashPreviewLoading] = useState(false);

  useEffect(() => {
    if (!cashRowLinked || debouncedCashAmount == null) {
      setCashPreview(null);
      return;
    }
    const controller = new AbortController();
    setCashPreviewLoading(true);
    previewCash(
      portfolioId,
      {
        kind: cashRowSide === 'sell' ? 'sell_proceeds' : 'buy',
        amountEur: debouncedCashAmount,
        sourceId: cashSourceId ?? undefined,
        asOfDate: asOfDateForPreview,
      },
      controller.signal,
    )
      .then((res) => {
        if (controller.signal.aborted) return;
        setCashPreview(res);
        // Default the settle-as-of-today opt-in ON the first time the warning
        // applies — affordable today, short as of the buy date — unless the user
        // has already made a choice. They can still opt out (see the card).
        if (
          cashRowSide === 'buy' &&
          res.sufficient &&
          res.asOfSufficient === false &&
          !settleTouched.current
        ) {
          setSingleRow({ settleCashAsOfToday: true });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setCashPreview(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setCashPreviewLoading(false);
      });
    return () => controller.abort();
  }, [
    portfolioId,
    cashRowLinked,
    cashRowSide,
    debouncedCashAmount,
    cashSourceId,
    asOfDateForPreview,
  ]);

  const settleToday = cashRow?.settleCashAsOfToday ?? false;
  // Affordable today but short as of the past buy date → the #378 warning path.
  const backdatedShort =
    cashRowLinked &&
    cashRowSide === 'buy' &&
    cashPreview !== null &&
    cashPreview.sufficient &&
    cashPreview.asOfSufficient === false;
  // Not enough cash even today (the classic overdraw block).
  const cashAfterNegative = cashRowLinked && cashPreview !== null && !cashPreview.sufficient;
  // Record is blocked when it can't be funded: short today, or short back then
  // with the user opting NOT to settle as of today.
  const cashBlocksRecord = cashAfterNegative || (backdatedShort && !settleToday);

  function toggleCashLinked() {
    if (!cashRow) return;
    settleTouched.current = false;
    setSingleRow({ cashLinked: !cashRow.cashLinked, settleCashAsOfToday: false });
  }

  function toggleSettleToday() {
    if (!cashRow) return;
    settleTouched.current = true;
    setSingleRow({ settleCashAsOfToday: !cashRow.settleCashAsOfToday });
  }

  // --- Uncovered sell (issue #369) ------------------------------------------
  // Selling more than held (a zero holding counts) is allowed only behind an
  // explicit acknowledgment. Detected on the single-asset *create* row where the
  // held quantity is known; edit keeps the server's strict oversell guard, and a
  // freshly searched asset (unknown holding) falls back to the server's OVERSELL.
  const uncoveredRow = !isEdit && rows.length === 1 ? rows[0]! : null;
  const uncoveredInfo = uncoveredRow ? uncoveredForRow(uncoveredRow, props.heldQuantity) : null;
  const uncoveredAck = uncoveredRow?.allowUncovered ?? false;
  // Record is blocked until the user acknowledges an uncovered sell.
  const uncoveredBlocksRecord = uncoveredInfo != null && !uncoveredAck;

  function toggleUncoveredAck() {
    if (!uncoveredRow) return;
    setSingleRow({ allowUncovered: !uncoveredRow.allowUncovered });
  }
  function setUncoveredMode(mode: 'zero' | 'entry') {
    setSingleRow({ uncoveredMode: mode });
  }
  function setUncoveredEntryPrice(value: string) {
    setSingleRow({ uncoveredEntryPrice: value });
  }

  /** Max affordable/held for the current row, in the active entry unit (#378). */
  function maxForRow(row: Row): number | null {
    if (row.side === 'sell') {
      if (props.heldQuantity == null || props.heldQuantity <= 0) return null;
      if (row.entryMode === 'amount') {
        const price = Number(row.price);
        return row.price.trim() !== '' && Number.isFinite(price) && price > 0
          ? props.heldQuantity * price
          : null;
      }
      return props.heldQuantity;
    }
    // Buy: only when funding from cash and the amount is in EUR (Main is EUR, so
    // an affordability estimate is exact only for a EUR-priced asset).
    if (!row.cashLinked || props.availableCashEur == null || row.asset.currency !== 'EUR') {
      return null;
    }
    if (row.entryMode === 'amount') {
      return props.availableCashEur > 0 ? props.availableCashEur : null;
    }
    const price = Number(row.price);
    if (row.price.trim() === '' || !Number.isFinite(price) || price <= 0) return null;
    const feeInput = Number(row.fee);
    const fee = row.fee.trim() !== '' && Number.isFinite(feeInput) && feeInput >= 0 ? feeInput : 0;
    const qty = (props.availableCashEur - fee) / price;
    return qty > 0 ? qty : null;
  }

  function fillMax(row: Row) {
    const max = maxForRow(row);
    if (max == null) return;
    const patch: Partial<Row> =
      row.entryMode === 'amount'
        ? { amount: amountToInput(max) }
        : { quantity: formatDerivedQuantity(max) };
    if (row.key === cashRow?.key && linkAsset) handleLinkedChange(patch);
    else updateRow(row.key, patch);
  }

  function pickAsset(item: SearchResultItem) {
    const asset: TransactionDialogAsset = {
      id: item.id,
      symbol: item.symbol,
      name: item.name,
      currency: item.currency,
    };
    settleTouched.current = false;
    setRows([makeRow('picked', asset, today, { cashLinked: props.defaultPayFromCash ?? false })]);
    setPicking(false);
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (rows.length === 0) {
      setError(t('portfolio.transaction.selectAssetFirst'));
      return;
    }

    const inputs: TransactionInput[] = [];
    for (const row of rows) {
      const { input, error: rowError } = validateRow(row);
      if (rowError) {
        setError(rowError);
        return;
      }
      // Route a cash-linked movement to the chosen source (V3-P3); web always
      // funds/receives from Main (no picker, #378) but keeps the API's
      // `cashSourceId` working by sending the resolved Main id when known.
      if (row.key === cashRow?.key && row.cashLinked && cashSourceId) {
        input!.cashSourceId = cashSourceId;
      }
      // Uncovered sell (issue #369): attach the acknowledged flag + the chosen
      // basis for the uncovered shares. `zero` mode omits the entry price so the
      // server basises them at the sale price (0 realized); `entry` mode sends
      // the user's buy-in price for an accurate realized gain.
      if (row.key === uncoveredRow?.key && uncoveredInfo && uncoveredAck) {
        input!.allowUncovered = true;
        if (row.uncoveredMode === 'entry') {
          const entry = Number(row.uncoveredEntryPrice);
          if (row.uncoveredEntryPrice.trim() === '' || !Number.isFinite(entry) || entry < 0) {
            setError(t('portfolio.transaction.uncoveredEntryPriceInvalid'));
            return;
          }
          input!.uncoveredEntryPrice = entry;
        }
      }
      inputs.push(input!);
    }

    // Never a silent negative (§14): the live preview already disables Record,
    // but re-check here too — the block a race or a stale preview relies on.
    if (cashBlocksRecord) {
      setError(
        backdatedShort
          ? t('portfolio.transaction.backdatedBlocked')
          : t('portfolio.transaction.cashNegative'),
      );
      return;
    }

    // An unacknowledged uncovered sell never submits (#369): the button is
    // already disabled, but re-check here for keyboard/enter submits too.
    if (uncoveredBlocksRecord) {
      setError(t('portfolio.transaction.uncoveredBlocked'));
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      if (isEdit) {
        const input = inputs[0]!;
        // Patch only what changed: the server rejects any financial-field edit
        // on a cash-linked transaction, so a note-only edit must not restate
        // the numbers. The date compares by calendar day — the form only edits
        // the day, and resending it would clobber a stored time-of-day.
        const patch: UpdateTransactionRequest = {};
        if (input.side !== transaction.side) patch.side = input.side;
        if (input.quantity !== transaction.quantity) patch.quantity = input.quantity;
        if (input.price !== transaction.price) patch.price = input.price;
        if (input.fee !== transaction.fee) patch.fee = input.fee;
        if (input.executedAt.slice(0, 10) !== transaction.executedAt.slice(0, 10)) {
          patch.executedAt = input.executedAt;
        }
        if ((input.note ?? null) !== (transaction.note ?? null)) patch.note = input.note ?? null;
        if (Object.keys(patch).length > 0) {
          await updateTransaction(portfolioId, transaction.id, patch);
        }
      } else {
        await createTransactions(portfolioId, inputs);
        // Sticky default (§14): remember this choice for next time, but only
        // when it actually changed — the toggle itself is always shown, never
        // silently pre-applied.
        if (cashRow && cashRow.cashLinked !== (props.defaultPayFromCash ?? false)) {
          await updatePortfolio(portfolioId, { defaultPayFromCash: cashRow.cashLinked }).catch(
            () => undefined,
          );
        }
      }
      onSubmitted();
      onClose();
    } catch (err) {
      if (
        err instanceof ApiError &&
        (err.code === 'OVERSELL' ||
          err.code === 'INSUFFICIENT_CASH' ||
          err.code === 'TRANSACTION_CASH_LINKED')
      ) {
        setError(err.message);
      } else {
        setError(t('portfolio.transaction.saveError'));
      }
      setSubmitting(false);
    }
  }

  const title = isEdit
    ? t('portfolio.transaction.titleEdit')
    : t('portfolio.transaction.titleCreate');

  // Footer total — the order value in the (first) row's native currency: cost on
  // a buy, proceeds on a sell. Sparse rows sum for the bulk flow.
  const totalCurrency = rows[0]?.asset.currency ?? 'EUR';
  let total: number | null = null;
  for (const row of rows) {
    const rowTotal = orderTotalForRow(row);
    if (rowTotal != null) total = (total ?? 0) + rowTotal;
  }

  const ctaLabel = isEdit
    ? t('portfolio.transaction.saveChanges')
    : rows.length === 1
      ? rows[0]!.side === 'sell'
        ? t('portfolio.transaction.recordSell')
        : t('portfolio.transaction.recordBuy')
      : t('portfolio.transaction.record');

  const footer = picking ? undefined : (
    <div className="flex flex-col gap-3">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="flex items-baseline justify-between">
        <span className="text-sm text-neutral-400">{t('portfolio.transaction.total')}</span>
        <span className="text-2xl font-bold tabular-nums text-[#F6B82E]">
          {total == null ? '—' : <MoneyText amount={total} currency={totalCurrency} />}
        </span>
      </div>
      <button
        type="submit"
        form={headingId}
        disabled={submitting || cashBlocksRecord || uncoveredBlocksRecord}
        className={cx(
          'w-full rounded-lg px-4 py-3 text-sm font-semibold text-black transition',
          'bg-[#F6B82E] hover:bg-[#ffca4d] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#F6B82E] focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-900',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
      >
        {submitting ? t('portfolio.transaction.saving') : ctaLabel}
      </button>
    </div>
  );

  return (
    <Dialog
      title={title}
      description={props.portfolioName}
      onClose={onClose}
      footer={footer}
      widthClassName="max-w-lg"
    >
      {picking ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-neutral-400">{t('portfolio.transaction.searchPrompt')}</p>
          <AssetSearchBox
            onSelect={pickAsset}
            autoFocus
            placeholder={t('portfolio.transaction.searchPlaceholder')}
          />
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('portfolio.transaction.cancel')}
          </Button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} id={headingId} className="flex flex-col gap-5">
          {rows.map((row, index) => {
            // The link assist lives on the single-asset create row (see above).
            const link: RowLink | undefined =
              linkAsset && (seriesLoading || hasSeries)
                ? {
                    linked,
                    loading: seriesLoading,
                    priceAuto,
                    dateAuto,
                    note: linkNote,
                    onToggle: toggleLinked,
                    onPriceBlur: handlePriceBlur,
                  }
                : undefined;
            // The cash-link toggle lives on the same eligible row (see above).
            const cash: RowCash | undefined =
              cashRow && cashRow.key === row.key
                ? {
                    checked: row.cashLinked,
                    loading: cashPreviewLoading,
                    preview: cashPreview,
                    afterNegative: cashAfterNegative,
                    backdatedShort,
                    settleToday,
                    buyDate: row.date,
                    onToggle: toggleCashLinked,
                    onToggleSettleToday: toggleSettleToday,
                  }
                : undefined;
            // The uncovered-sell card lives on the same eligible create row.
            const uncovered: RowUncovered | undefined =
              uncoveredRow && uncoveredRow.key === row.key && uncoveredInfo
                ? {
                    info: uncoveredInfo,
                    acknowledged: row.allowUncovered,
                    mode: row.uncoveredMode,
                    entryPrice: row.uncoveredEntryPrice,
                    currency: row.asset.currency,
                    onToggleAck: toggleUncoveredAck,
                    onSetMode: setUncoveredMode,
                    onSetEntryPrice: setUncoveredEntryPrice,
                  }
                : undefined;
            const canChangeAsset = !isEdit && !props.asset && !props.prefill && rows.length === 1;
            return (
              <RowFields
                key={row.key}
                row={row}
                t={t}
                showAssetHeader={rows.length > 1}
                showDivider={index > 0}
                onChangeAsset={
                  canChangeAsset
                    ? () => {
                        setRows([]);
                        setPicking(true);
                        setError(null);
                      }
                    : undefined
                }
                onChange={link ? handleLinkedChange : (patch) => updateRow(row.key, patch)}
                onFillMax={maxForRow(row) != null ? () => fillMax(row) : undefined}
                link={link}
                cash={cash}
                uncovered={uncovered}
              />
            );
          })}
        </form>
      )}
    </Dialog>
  );
}

/**
 * Switch a row's entry mode, carrying already-entered values across sensibly:
 * quantity→amount fills the amount from `quantity * price`, and amount→quantity
 * fills the quantity from the derived value — so a toggle never loses work.
 */
function switchEntryMode(row: Row, next: EntryMode, onChange: (patch: Partial<Row>) => void) {
  if (next === row.entryMode) return;
  const price = Number(row.price);
  const priceUsable = row.price.trim() !== '' && Number.isFinite(price) && price > 0;

  if (next === 'amount') {
    const quantity = Number(row.quantity);
    const patch: Partial<Row> = { entryMode: 'amount' };
    if (row.quantity.trim() !== '' && Number.isFinite(quantity) && quantity > 0 && priceUsable) {
      patch.amount = amountToInput(quantity * price);
    }
    onChange(patch);
    return;
  }

  const amount = Number(row.amount);
  const patch: Partial<Row> = { entryMode: 'quantity' };
  if (row.amount.trim() !== '' && Number.isFinite(amount) && amount > 0 && priceUsable) {
    const derived = deriveQuantityFromAmount(price, amount);
    if (derived) patch.quantity = formatDerivedQuantity(derived.quantity);
  }
  onChange(patch);
}

/** Linked date ↔ price controls for the single-asset create row (#226). */
export interface RowLink {
  linked: boolean;
  /** The daily close series is still loading. */
  loading: boolean;
  /** The price value was auto-filled from a lookup (not typed). */
  priceAuto: boolean;
  /** The date value was auto-filled from a lookup (not typed). */
  dateAuto: boolean;
  /** Inline status ("market closed — using Fri close" / "never at this price…"). */
  note: string | null;
  onToggle: () => void;
  onPriceBlur: () => void;
}

/** Pay-from-cash card controls for the eligible row (§14; date-aware #378). */
export interface RowCash {
  checked: boolean;
  /** The live preview is still loading. */
  loading: boolean;
  preview: CashPreviewResponse | null;
  /** The buy would take TODAY's cash balance negative — a hard overdraw. */
  afterNegative: boolean;
  /** Affordable today but short as of the past buy date — the #378 warning. */
  backdatedShort: boolean;
  /** The settle-as-of-today opt-in is on. */
  settleToday: boolean;
  /** The buy's date, for the backdated warning copy. */
  buyDate: string;
  onToggle: () => void;
  onToggleSettleToday: () => void;
}

/** Uncovered-sell card controls for the eligible sell row (issue #369). */
export interface RowUncovered {
  /** Held / sell / uncovered quantities driving the warning copy. */
  info: UncoveredInfo;
  /** The "continue anyway" acknowledgment is on. */
  acknowledged: boolean;
  /** Basis for the uncovered shares: 0 % (sale price) or a typed buy-in. */
  mode: 'zero' | 'entry';
  /** Native buy-in price string (mode `entry`). */
  entryPrice: string;
  /** Asset native currency, for the buy-in suffix. */
  currency: string;
  onToggleAck: () => void;
  onSetMode: (mode: 'zero' | 'entry') => void;
  onSetEntryPrice: (value: string) => void;
}

/** Small "auto" marker so a fetched value is never mistaken for a typed one. */
function AutoHint() {
  return (
    <span className="ml-1 text-[0.65rem] font-normal uppercase tracking-wide text-[#F6B82E]">
      auto
    </span>
  );
}

/** A chain glyph — closed when linked, broken when not — for the link toggle. */
function LinkGlyph({ linked }: { linked: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {linked ? (
        <>
          <path d="M9 12h6" />
          <path d="M8.5 8H7a4 4 0 0 0 0 8h1.5" />
          <path d="M15.5 8H17a4 4 0 0 1 0 8h-1.5" />
        </>
      ) : (
        <>
          <path d="M8.5 8H7a4 4 0 0 0 0 8h1.5" />
          <path d="M15.5 8H17a4 4 0 0 1 0 8h-1.5" />
          <path d="M4 4l16 16" />
        </>
      )}
    </svg>
  );
}

/** Downward chevron for the asset-picker card (the one gold affordance there). */
function Chevron() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/** Emerald/red segmented Buy · Sell toggle (unselected: flat dark grey). */
function SideToggle({
  side,
  symbol,
  t,
  onChange,
}: {
  side: TransactionSide;
  symbol: string;
  t: TranslateFn;
  onChange: (side: TransactionSide) => void;
}) {
  const seg = (value: TransactionSide, selectedCls: string) =>
    cx(
      'flex-1 rounded-md px-3 py-2 text-sm font-semibold transition',
      'focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500',
      side === value ? selectedCls : 'text-neutral-400 hover:text-neutral-200',
    );
  return (
    <div
      role="group"
      aria-label={t('portfolio.transaction.sideAria', { symbol })}
      className="flex gap-2 rounded-lg bg-neutral-900 p-1 ring-1 ring-inset ring-neutral-800"
    >
      <button
        type="button"
        aria-pressed={side === 'buy'}
        onClick={() => onChange('buy')}
        className={seg(
          'buy',
          'bg-emerald-500/10 text-emerald-400 ring-1 ring-inset ring-emerald-500/40',
        )}
      >
        {t('portfolio.transaction.buy')}
      </button>
      <button
        type="button"
        aria-pressed={side === 'sell'}
        onClick={() => onChange('sell')}
        className={seg('sell', 'bg-red-500/10 text-red-400 ring-1 ring-inset ring-red-500/40')}
      >
        {t('portfolio.transaction.sell')}
      </button>
    </div>
  );
}

/** The asset selector: dark card, grey label, bold symbol + name, gold chevron. */
function AssetCard({
  asset,
  t,
  onChangeAsset,
}: {
  asset: TransactionDialogAsset;
  t: TranslateFn;
  onChangeAsset?: () => void;
}) {
  const body = (
    <>
      <span className="flex flex-col text-left">
        <span className="text-[0.7rem] font-medium uppercase tracking-wide text-neutral-500">
          {t('portfolio.transaction.assetLabel')}
        </span>
        <span className="font-mono text-base font-semibold text-neutral-100">{asset.symbol}</span>
        <span className="truncate text-xs text-neutral-500">{asset.name}</span>
      </span>
      {onChangeAsset ? (
        <span className="shrink-0 text-[#F6B82E]">
          <Chevron />
        </span>
      ) : null}
    </>
  );
  if (!onChangeAsset) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg bg-neutral-900 px-4 py-3 ring-1 ring-inset ring-neutral-800">
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onChangeAsset}
      aria-label={t('portfolio.transaction.changeAssetAria')}
      className="flex items-center justify-between gap-3 rounded-lg bg-neutral-900 px-4 py-3 text-left ring-1 ring-inset ring-neutral-800 transition hover:ring-neutral-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#F6B82E]"
    >
      {body}
    </button>
  );
}

/** Gold "Max" chip that fills the max affordable/held into the active field. */
function MaxChip({ symbol, t, onClick }: { symbol: string; t: TranslateFn; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t('portfolio.transaction.maxAria', { symbol })}
      className="rounded-md bg-[#F6B82E]/10 px-2 py-0.5 text-[0.7rem] font-semibold uppercase tracking-wide text-[#F6B82E] ring-1 ring-inset ring-[#F6B82E]/30 transition hover:bg-[#F6B82E]/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#F6B82E]"
    >
      {t('portfolio.transaction.max')}
    </button>
  );
}

/** A checkbox styled as a switch (keeps role=checkbox for a11y + tests). */
function ToggleSwitch({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: () => void;
  ariaLabel: string;
}) {
  return (
    <span className="relative inline-flex h-5 w-9 shrink-0 items-center">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        aria-label={ariaLabel}
        className="peer absolute inset-0 z-10 m-0 cursor-pointer opacity-0"
      />
      <span
        aria-hidden="true"
        className="h-5 w-9 rounded-full bg-neutral-700 transition-colors peer-checked:bg-[#F6B82E] peer-focus-visible:ring-2 peer-focus-visible:ring-[#F6B82E] peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-neutral-900"
      />
      <span
        aria-hidden="true"
        className="absolute left-0.5 h-4 w-4 rounded-full bg-white transition-transform peer-checked:translate-x-4"
      />
    </span>
  );
}

/** The pay-from-cash card: toggle, live "Cash after", and the #378 warning. */
function CashCard({ row, cash, t }: { row: Row; cash: RowCash; t: TranslateFn }) {
  const isSell = row.side === 'sell';
  const toggleLabel = isSell
    ? t('portfolio.transaction.addProceedsToCash')
    : t('portfolio.transaction.payFromCash');
  const after = cash.preview?.afterEur ?? null;
  return (
    <div className="flex flex-col gap-3 rounded-lg bg-neutral-900 p-4 ring-1 ring-inset ring-neutral-800">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-neutral-200">{toggleLabel}</span>
        <ToggleSwitch checked={cash.checked} onChange={cash.onToggle} ariaLabel={toggleLabel} />
      </div>

      {cash.checked ? (
        <p
          className="flex items-baseline justify-between text-sm"
          role="status"
          aria-label={t('portfolio.transaction.cashPreviewAria')}
        >
          {cash.loading || !cash.preview ? (
            <span className="text-neutral-500">{t('portfolio.transaction.cashCalculating')}</span>
          ) : (
            <>
              <span className="text-neutral-400">{t('portfolio.transaction.cashAfter')}</span>
              <span className="flex items-center gap-2 tabular-nums">
                <span className={cash.afterNegative ? 'text-red-400' : 'text-emerald-400'}>
                  <MoneyText amount={after} currency="EUR" />
                </span>
                {cash.afterNegative ? (
                  <span className="text-xs text-red-400">
                    {t('portfolio.transaction.cashShort')}{' '}
                    <MoneyText amount={cash.preview.shortfallEur} currency="EUR" />
                  </span>
                ) : null}
              </span>
            </>
          )}
        </p>
      ) : null}

      {cash.checked && cash.backdatedShort ? (
        <div className="flex flex-col gap-2 rounded-md border border-[#F6B82E]/40 bg-[#F6B82E]/10 p-3">
          <p className="text-xs leading-relaxed text-[#F6B82E]">
            {t('portfolio.transaction.backdatedWarning', { date: cash.buyDate })}
          </p>
          <label className="flex items-center gap-2 text-xs font-medium text-neutral-200">
            <input
              type="checkbox"
              checked={cash.settleToday}
              onChange={cash.onToggleSettleToday}
              aria-label={t('portfolio.transaction.deductToday')}
              className="h-4 w-4 rounded border-neutral-600 bg-neutral-900 text-[#F6B82E] focus:ring-[#F6B82E]"
            />
            {t('portfolio.transaction.deductToday')}
          </label>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The uncovered-sell card (issue #369): a warning that the sell exceeds the
 * holding, the **required** "continue anyway" acknowledgment, and the basis
 * choice for the shares the user doesn't own (count as 0 %, or enter the
 * original buy-in). Shown only while the row is genuinely uncovered.
 */
function UncoveredCard({
  row,
  uncovered,
  t,
}: {
  row: Row;
  uncovered: RowUncovered;
  t: TranslateFn;
}) {
  const symbol = row.asset.symbol;
  // Display quantities go through the shared locale-aware formatter (§7.1 rule 3);
  // `formatDerivedQuantity` stays reserved for raw input-field values.
  const held = formatQuantity(uncovered.info.held);
  const sellQty = formatQuantity(uncovered.info.sellQty);
  const uncoveredQty = formatQuantity(uncovered.info.uncoveredQty);
  const modeBtn = (mode: 'zero' | 'entry') =>
    cx(
      'flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition',
      'focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500',
      uncovered.mode === mode
        ? 'bg-neutral-800 text-neutral-100 ring-1 ring-inset ring-neutral-700'
        : 'text-neutral-400 hover:text-neutral-200',
    );
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-red-500/40 bg-red-500/10 p-4">
      <p className="text-sm font-medium text-red-300" role="alert">
        {t('portfolio.transaction.uncoveredWarning', {
          symbol,
          held,
          quantity: sellQty,
          uncovered: uncoveredQty,
        })}
      </p>
      <p className="text-xs leading-relaxed text-neutral-300">
        {t('portfolio.transaction.uncoveredNoShorts')}
      </p>

      <label className="flex items-center gap-2 text-sm font-medium text-neutral-100">
        <input
          type="checkbox"
          checked={uncovered.acknowledged}
          onChange={uncovered.onToggleAck}
          aria-label={t('portfolio.transaction.uncoveredAck')}
          className="h-4 w-4 rounded border-neutral-600 bg-neutral-900 text-red-500 focus:ring-red-500"
        />
        {t('portfolio.transaction.uncoveredAck')}
      </label>

      {uncovered.acknowledged ? (
        <div className="flex flex-col gap-2">
          <span className="text-[0.7rem] font-medium uppercase tracking-wide text-neutral-500">
            {t('portfolio.transaction.uncoveredBasisLabel')}
          </span>
          <div
            className="flex gap-1 rounded-lg bg-neutral-900 p-1 ring-1 ring-inset ring-neutral-800"
            role="group"
            aria-label={t('portfolio.transaction.uncoveredBasisLabel')}
          >
            <button
              type="button"
              onClick={() => uncovered.onSetMode('zero')}
              aria-pressed={uncovered.mode === 'zero'}
              className={modeBtn('zero')}
            >
              {t('portfolio.transaction.uncoveredBasisZero')}
            </button>
            <button
              type="button"
              onClick={() => uncovered.onSetMode('entry')}
              aria-pressed={uncovered.mode === 'entry'}
              className={modeBtn('entry')}
            >
              {t('portfolio.transaction.uncoveredBasisEntry')}
            </button>
          </div>

          {uncovered.mode === 'entry' ? (
            <label className="group flex flex-col gap-1.5">
              <FieldLabel>{t('portfolio.transaction.uncoveredEntryPriceLabel')}</FieldLabel>
              <span className="relative">
                <input
                  type="number"
                  inputMode="decimal"
                  step="any"
                  min="0"
                  value={uncovered.entryPrice}
                  onChange={(e) => uncovered.onSetEntryPrice(e.target.value)}
                  aria-label={t('portfolio.transaction.uncoveredEntryPriceAria', { symbol })}
                  className={cx(inputClass, 'pr-8')}
                />
                <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-sm text-neutral-500">
                  {currencySuffix(uncovered.currency)}
                </span>
              </span>
            </label>
          ) : null}

          <p className="text-xs leading-relaxed text-neutral-400">
            {t('portfolio.transaction.uncoveredNudge')}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function RowFields({
  row,
  t,
  showAssetHeader,
  showDivider,
  onChangeAsset,
  onChange,
  onFillMax,
  link,
  cash,
  uncovered,
}: {
  row: Row;
  t: TranslateFn;
  showAssetHeader: boolean;
  showDivider: boolean;
  onChangeAsset?: () => void;
  onChange: (patch: Partial<Row>) => void;
  onFillMax?: () => void;
  link?: RowLink;
  cash?: RowCash;
  uncovered?: RowUncovered;
}) {
  const symbol = row.asset.symbol;
  const isAmountMode = row.entryMode === 'amount';
  const derived =
    isAmountMode && row.price.trim() !== '' && row.amount.trim() !== ''
      ? deriveQuantityFromAmount(Number(row.price), Number(row.amount))
      : null;
  const amountLabel = isAmountMode
    ? row.side === 'sell'
      ? t('portfolio.transaction.amountReceivedLabel')
      : t('portfolio.transaction.amountInvestedLabel')
    : t('portfolio.transaction.quantityLabel');
  const amountAria =
    row.side === 'sell'
      ? t('portfolio.transaction.amountReceivedAria', { symbol })
      : t('portfolio.transaction.amountInvestedAria', { symbol });

  const modeBtn = (mode: EntryMode) =>
    cx(
      'flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition',
      'focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500',
      row.entryMode === mode
        ? 'bg-neutral-800 text-neutral-100 ring-1 ring-inset ring-neutral-700'
        : 'text-neutral-400 hover:text-neutral-200',
    );

  return (
    <div className={cx('flex flex-col gap-5', showDivider && 'border-t border-neutral-800 pt-5')}>
      {showAssetHeader ? (
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-sm font-semibold text-neutral-100">{symbol}</span>
          <span className="truncate text-xs text-neutral-500">{row.asset.name}</span>
        </div>
      ) : null}

      {/* Buy · Sell segmented toggle + Date, at the top. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <SideToggle
            side={row.side}
            symbol={symbol}
            t={t}
            onChange={(side) => onChange({ side })}
          />
        </div>
        <label className="group flex flex-col gap-1.5 sm:w-40">
          <FieldLabel>
            {t('portfolio.transaction.dateLabel')}
            {link?.dateAuto ? <AutoHint /> : null}
          </FieldLabel>
          <input
            type="date"
            value={row.date}
            onChange={(e) => onChange({ date: e.target.value })}
            aria-label={t('portfolio.transaction.dateAria', { symbol })}
            className={inputClass}
          />
        </label>
      </div>

      {/* Asset selector card (single-asset flows). */}
      {!showAssetHeader ? (
        <AssetCard asset={row.asset} t={t} onChangeAsset={onChangeAsset} />
      ) : null}

      {/* Quantity ⇄ Amount toggle. */}
      <div
        className="flex gap-1 rounded-lg bg-neutral-900 p-1 ring-1 ring-inset ring-neutral-800"
        role="group"
        aria-label={t('portfolio.transaction.entryModeAria', { symbol })}
      >
        <button
          type="button"
          onClick={() => switchEntryMode(row, 'quantity', onChange)}
          aria-pressed={!isAmountMode}
          className={modeBtn('quantity')}
        >
          {t('portfolio.transaction.byQuantity')}
        </button>
        <button
          type="button"
          onClick={() => switchEntryMode(row, 'amount', onChange)}
          aria-pressed={isAmountMode}
          className={modeBtn('amount')}
        >
          {t('portfolio.transaction.byAmount')}
        </button>
      </div>

      {/* Quantity | Price row. */}
      <div className="grid grid-cols-2 gap-3">
        <label className="group flex flex-col gap-1.5">
          <span className="flex min-h-5 items-center justify-between gap-2">
            <FieldLabel>{amountLabel}</FieldLabel>
            {onFillMax ? <MaxChip symbol={symbol} t={t} onClick={onFillMax} /> : null}
          </span>
          <input
            type="number"
            inputMode="decimal"
            step="any"
            min="0"
            value={isAmountMode ? row.amount : row.quantity}
            onChange={(e) =>
              onChange(isAmountMode ? { amount: e.target.value } : { quantity: e.target.value })
            }
            aria-label={
              isAmountMode ? amountAria : t('portfolio.transaction.quantityAria', { symbol })
            }
            className={inputClass}
          />
        </label>

        <label className="group flex flex-col gap-1.5">
          <span className="flex min-h-5 items-center">
            <FieldLabel>
              {t('portfolio.transaction.priceLabel')}
              {link?.priceAuto ? <AutoHint /> : null}
            </FieldLabel>
          </span>
          <span className="relative">
            <input
              type="number"
              inputMode="decimal"
              step="any"
              min="0"
              value={row.price}
              onChange={(e) => onChange({ price: e.target.value })}
              onBlur={link ? link.onPriceBlur : undefined}
              aria-label={t('portfolio.transaction.priceAria', { symbol })}
              className={cx(inputClass, link ? 'pr-14' : 'pr-8')}
            />
            <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center gap-1.5">
              <span className="text-sm text-neutral-500">{currencySuffix(row.asset.currency)}</span>
              {link ? (
                <button
                  type="button"
                  onClick={link.onToggle}
                  disabled={link.loading}
                  aria-pressed={link.linked}
                  aria-label={link.linked ? 'Unlink date and price' : 'Link date and price'}
                  className={cx(
                    'pointer-events-auto rounded p-0.5 transition disabled:opacity-40',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-[#F6B82E]',
                    link.linked ? 'text-[#F6B82E]' : 'text-neutral-500 hover:text-neutral-300',
                  )}
                >
                  <LinkGlyph linked={link.linked} />
                </button>
              ) : null}
            </span>
          </span>
        </label>
      </div>

      {link?.note ? (
        <p className="-mt-2 text-xs text-amber-400" role="status">
          {link.note}
        </p>
      ) : null}

      {link ? (
        <p className="-mt-3 text-xs text-neutral-500" role="status">
          {link.loading
            ? 'Loading price history…'
            : link.linked
              ? t('portfolio.transaction.linkHint')
              : t('portfolio.transaction.linkManualHint')}
        </p>
      ) : null}

      {isAmountMode ? (
        <p
          className="-mt-2 text-xs text-neutral-400"
          role="status"
          aria-label={t('portfolio.transaction.derivedAria', { symbol })}
        >
          {derived ? (
            <>
              ≈{' '}
              <span className="font-mono text-neutral-200">{formatQuantity(derived.quantity)}</span>{' '}
              {symbol} · records{' '}
              <span className="font-mono text-neutral-200">
                {formatMoney(derived.recordedAmount, row.asset.currency)}
              </span>
              {Math.abs(derived.residual) >= 0.005
                ? ` (${derived.residual > 0 ? '+' : '−'}${formatMoney(
                    Math.abs(derived.residual),
                    row.asset.currency,
                  )} vs entered, from 8-decimal rounding)`
                : ''}
            </>
          ) : (
            'Enter a price and amount above 0 to derive the quantity.'
          )}
        </p>
      ) : null}

      {/* Fee. */}
      <label className="group flex flex-col gap-1.5">
        <FieldLabel>{t('portfolio.transaction.feeLabel')}</FieldLabel>
        <span className="relative">
          <input
            type="number"
            inputMode="decimal"
            step="any"
            min="0"
            value={row.fee}
            onChange={(e) => onChange({ fee: e.target.value })}
            aria-label={t('portfolio.transaction.feeAria', { symbol })}
            placeholder="0"
            className={cx(inputClass, 'pr-8')}
          />
          <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-sm text-neutral-500">
            {currencySuffix(row.asset.currency)}
          </span>
        </span>
      </label>

      {/* Pay-from-cash card (Main default, no source picker — #378). */}
      {cash ? <CashCard row={row} cash={cash} t={t} /> : null}

      {/* Uncovered-sell warning + acknowledgment + basis choice (issue #369). */}
      {uncovered ? <UncoveredCard row={row} uncovered={uncovered} t={t} /> : null}

      {/* Note. */}
      <label className="group flex flex-col gap-1.5">
        <FieldLabel>{t('portfolio.transaction.noteLabel')}</FieldLabel>
        <input
          type="text"
          value={row.note}
          maxLength={1000}
          onChange={(e) => onChange({ note: e.target.value })}
          aria-label={t('portfolio.transaction.noteAria', { symbol })}
          className={inputClass}
        />
      </label>
    </div>
  );
}
