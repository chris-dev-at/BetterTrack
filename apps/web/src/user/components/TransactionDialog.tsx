import { useId, useState } from 'react';

import type {
  SearchResultItem,
  Transaction,
  TransactionInput,
  TransactionSide,
} from '@bettertrack/contracts';

import { ApiError } from '../../lib/apiClient';
import { createTransactions, updateTransaction } from '../../lib/portfolioApi';
import { AssetSearchBox } from './AssetSearchBox';
import { Dialog } from './Dialog';
import { Alert, Button, cx } from './ui';

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

/** Two-decimal money string for previews and mode-switch preservation. */
function formatMoney(amount: number): string {
  return amount.toFixed(2);
}

const inputClass = cx(
  'w-full rounded-md bg-neutral-950 px-3 py-2 text-sm text-neutral-100',
  'ring-1 ring-inset ring-neutral-700 placeholder:text-neutral-600',
  'focus:outline-none focus:ring-2 focus:ring-sky-500',
);

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
    return [makeRow('locked', props.asset, today)];
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
    },
  };
}

/**
 * Record / edit transactions (PROJECTPLAN.md §6.9, §7.3 `TransactionDialog`).
 * Single (locked asset or free search pick), edit, and bulk-prefilled in one
 * component; the buy flow always posts the `{ transactions: [...] }` batch.
 */
export function TransactionDialog(props: TransactionDialogProps) {
  const { portfolioId, onClose, onSubmitted, transaction } = props;
  const isEdit = !!transaction;
  const today = isoToday(props.today);
  const headingId = useId();

  const [rows, setRows] = useState<Row[]>(() => rowsFromProps(props, today));
  const [picking, setPicking] = useState<boolean>(rows.length === 0);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function updateRow(key: string, patch: Partial<Row>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function pickAsset(item: SearchResultItem) {
    const asset: TransactionDialogAsset = {
      id: item.id,
      symbol: item.symbol,
      name: item.name,
      currency: item.currency,
    };
    setRows([makeRow('picked', asset, today)]);
    setPicking(false);
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (rows.length === 0) {
      setError('Select an asset first.');
      return;
    }

    const inputs: TransactionInput[] = [];
    for (const row of rows) {
      const { input, error: rowError } = validateRow(row);
      if (rowError) {
        setError(rowError);
        return;
      }
      inputs.push(input!);
    }

    setSubmitting(true);
    setError(null);
    try {
      if (isEdit) {
        const input = inputs[0]!;
        await updateTransaction(portfolioId, transaction.id, {
          side: input.side,
          quantity: input.quantity,
          price: input.price,
          fee: input.fee,
          executedAt: input.executedAt,
          note: input.note ?? null,
        });
      } else {
        await createTransactions(portfolioId, inputs);
      }
      onSubmitted();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'OVERSELL') {
        setError(err.message);
      } else {
        setError('Could not save. Please try again.');
      }
      setSubmitting(false);
    }
  }

  const title = isEdit ? 'Edit transaction' : 'Record transaction';

  return (
    <Dialog
      title={title}
      onClose={onClose}
      widthClassName={rows.length > 1 ? 'max-w-2xl' : 'max-w-lg'}
    >
      {picking ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-neutral-400">Search for the asset you transacted.</p>
          <AssetSearchBox
            onSelect={pickAsset}
            autoFocus
            placeholder="Search to record a buy/sell…"
          />
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4" aria-labelledby={headingId}>
          <span id={headingId} className="sr-only">
            {title}
          </span>

          {rows.map((row, index) => (
            <RowFields
              key={row.key}
              row={row}
              showAssetHeader={rows.length > 1 || isEdit || !!props.asset}
              showDivider={index > 0}
              onChange={(patch) => updateRow(row.key, patch)}
            />
          ))}

          {!isEdit && !props.asset && !props.prefill ? (
            <button
              type="button"
              onClick={() => {
                setRows([]);
                setPicking(true);
                setError(null);
              }}
              className="self-start text-xs text-neutral-500 hover:text-neutral-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              ← Change asset
            </button>
          ) : null}

          {error ? <Alert tone="error">{error}</Alert> : null}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Record'}
            </Button>
          </div>
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
      patch.amount = formatMoney(quantity * price);
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

function RowFields({
  row,
  showAssetHeader,
  showDivider,
  onChange,
}: {
  row: Row;
  showAssetHeader: boolean;
  showDivider: boolean;
  onChange: (patch: Partial<Row>) => void;
}) {
  const isAmountMode = row.entryMode === 'amount';
  const derived =
    isAmountMode && row.price.trim() !== '' && row.amount.trim() !== ''
      ? deriveQuantityFromAmount(Number(row.price), Number(row.amount))
      : null;
  const amountLabel = row.side === 'sell' ? 'Amount received' : 'Amount invested';

  const toggleBtn = (mode: EntryMode) =>
    cx(
      'flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition',
      'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
      row.entryMode === mode
        ? 'bg-neutral-800 text-neutral-100 ring-1 ring-inset ring-neutral-600'
        : 'text-neutral-400 hover:text-neutral-200',
    );

  return (
    <div className={cx('flex flex-col gap-3', showDivider && 'border-t border-neutral-800 pt-4')}>
      {showAssetHeader ? (
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-sm font-semibold text-neutral-100">
            {row.asset.symbol}
          </span>
          <span className="truncate text-xs text-neutral-500">{row.asset.name}</span>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-neutral-300">Side</span>
          <select
            value={row.side}
            onChange={(e) => onChange({ side: e.target.value as TransactionSide })}
            aria-label={`Side for ${row.asset.symbol}`}
            className={inputClass}
          >
            <option value="buy">Buy</option>
            <option value="sell">Sell</option>
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-neutral-300">Date</span>
          <input
            type="date"
            value={row.date}
            onChange={(e) => onChange({ date: e.target.value })}
            aria-label={`Date for ${row.asset.symbol}`}
            className={inputClass}
          />
        </label>

        <div
          className="col-span-2 flex gap-1 rounded-md bg-neutral-950 p-1 ring-1 ring-inset ring-neutral-700"
          role="group"
          aria-label={`Entry mode for ${row.asset.symbol}`}
        >
          <button
            type="button"
            onClick={() => switchEntryMode(row, 'quantity', onChange)}
            aria-pressed={!isAmountMode}
            className={toggleBtn('quantity')}
          >
            By quantity
          </button>
          <button
            type="button"
            onClick={() => switchEntryMode(row, 'amount', onChange)}
            aria-pressed={isAmountMode}
            className={toggleBtn('amount')}
          >
            By amount
          </button>
        </div>

        {isAmountMode ? (
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-neutral-300">
              {amountLabel} ({row.asset.currency})
            </span>
            <input
              type="number"
              inputMode="decimal"
              step="any"
              min="0"
              value={row.amount}
              onChange={(e) => onChange({ amount: e.target.value })}
              aria-label={`${amountLabel} for ${row.asset.symbol}`}
              className={inputClass}
            />
          </label>
        ) : (
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-neutral-300">Quantity</span>
            <input
              type="number"
              inputMode="decimal"
              step="any"
              min="0"
              value={row.quantity}
              onChange={(e) => onChange({ quantity: e.target.value })}
              aria-label={`Quantity for ${row.asset.symbol}`}
              className={inputClass}
            />
          </label>
        )}

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-neutral-300">Price ({row.asset.currency})</span>
          <input
            type="number"
            inputMode="decimal"
            step="any"
            min="0"
            value={row.price}
            onChange={(e) => onChange({ price: e.target.value })}
            aria-label={`Price for ${row.asset.symbol}`}
            className={inputClass}
          />
        </label>

        {isAmountMode ? (
          <p
            className="col-span-2 text-xs text-neutral-400"
            role="status"
            aria-label={`Derived quantity for ${row.asset.symbol}`}
          >
            {derived ? (
              <>
                ≈{' '}
                <span className="font-mono text-neutral-200">
                  {formatDerivedQuantity(derived.quantity)}
                </span>{' '}
                {row.asset.symbol} · records{' '}
                <span className="font-mono text-neutral-200">
                  {formatMoney(derived.recordedAmount)} {row.asset.currency}
                </span>
                {Math.abs(derived.residual) >= 0.005
                  ? ` (${derived.residual > 0 ? '+' : '−'}${formatMoney(
                      Math.abs(derived.residual),
                    )} vs entered, from 8-decimal rounding)`
                  : ''}
              </>
            ) : (
              'Enter a price and amount above 0 to derive the quantity.'
            )}
          </p>
        ) : null}

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-neutral-300">Fee ({row.asset.currency})</span>
          <input
            type="number"
            inputMode="decimal"
            step="any"
            min="0"
            value={row.fee}
            onChange={(e) => onChange({ fee: e.target.value })}
            aria-label={`Fee for ${row.asset.symbol}`}
            placeholder="0"
            className={inputClass}
          />
        </label>

        <label className="col-span-2 flex flex-col gap-1.5">
          <span className="text-sm font-medium text-neutral-300">Note (optional)</span>
          <input
            type="text"
            value={row.note}
            maxLength={1000}
            onChange={(e) => onChange({ note: e.target.value })}
            aria-label={`Note for ${row.asset.symbol}`}
            className={inputClass}
          />
        </label>
      </div>
    </div>
  );
}
