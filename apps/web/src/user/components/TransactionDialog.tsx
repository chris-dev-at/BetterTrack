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

/** One editable transaction line. Numeric fields are raw strings, parsed on submit. */
interface Row {
  key: string;
  asset: TransactionDialogAsset;
  side: TransactionSide;
  quantity: string;
  price: string;
  fee: string;
  date: string;
  note: string;
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
    quantity: '',
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
        quantity: String(t.quantity),
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
  const quantity = Number(row.quantity);
  const price = Number(row.price);
  const fee = row.fee.trim() === '' ? 0 : Number(row.fee);

  if (!row.quantity.trim() || !Number.isFinite(quantity) || quantity <= 0) {
    return { error: `${row.asset.symbol}: quantity must be greater than 0.` };
  }
  if (!row.price.trim() || !Number.isFinite(price) || price < 0) {
    return { error: `${row.asset.symbol}: price must be 0 or more.` };
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
  const { onClose, onSubmitted, transaction } = props;
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
        await updateTransaction(transaction.id, {
          side: input.side,
          quantity: input.quantity,
          price: input.price,
          fee: input.fee,
          executedAt: input.executedAt,
          note: input.note ?? null,
        });
      } else {
        await createTransactions(inputs);
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
