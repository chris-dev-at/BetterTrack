import { useId, useState } from 'react';

import {
  CUSTOM_ASSET_CATEGORIES,
  type CreateCustomAssetRequest,
  type CustomAssetCategory,
} from '@bettertrack/contracts';

import { createCustomAsset } from '../../lib/portfolioApi';
import { Dialog } from './Dialog';
import { Alert, Button, cx } from './ui';

export interface CustomInvestmentDialogProps {
  onClose: () => void;
  /** Called after a successful create so the page can refetch. */
  onCreated: () => void;
  /** Today as ISO `YYYY-MM-DD`, injectable for deterministic tests. */
  today?: string;
}

/** Human labels for the §6.9 custom-investment categories. */
const CATEGORY_LABELS: Record<CustomAssetCategory, string> = {
  real_estate: 'Real estate',
  vehicle: 'Vehicle',
  collectible: 'Collectible',
  cash: 'Cash',
  unlisted_stock: 'Unlisted stock',
  other: 'Other',
};

const inputClass = cx(
  'w-full rounded-md bg-neutral-950 px-3 py-2 text-sm text-neutral-100',
  'ring-1 ring-inset ring-neutral-700 placeholder:text-neutral-600',
  'focus:outline-none focus:ring-2 focus:ring-sky-500',
);

function isoToday(today?: string): string {
  if (today) return today;
  return new Date().toISOString().slice(0, 10);
}

/**
 * Create a custom investment (PROJECTPLAN.md §6.9). Name, category, currency, and
 * an optional initial purchase recorded as a BUY transaction. Value points are
 * maintained afterwards via the {@link ValuePointEditor}.
 */
export function CustomInvestmentDialog({ onClose, onCreated, today }: CustomInvestmentDialogProps) {
  const headingId = useId();
  const [name, setName] = useState('');
  const [category, setCategory] = useState<CustomAssetCategory>('real_estate');
  const [currency, setCurrency] = useState('EUR');

  const [withPurchase, setWithPurchase] = useState(false);
  const [quantity, setQuantity] = useState('1');
  const [price, setPrice] = useState('');
  const [fee, setFee] = useState('');
  const [date, setDate] = useState(isoToday(today));

  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Give your investment a name.');
      return;
    }
    const ccy = currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(ccy)) {
      setError('Currency must be a 3-letter ISO code, e.g. EUR.');
      return;
    }

    const body: CreateCustomAssetRequest = { name: trimmedName, category, currency: ccy };

    if (withPurchase) {
      const qty = Number(quantity);
      const px = Number(price);
      const f = fee.trim() === '' ? 0 : Number(fee);
      if (!quantity.trim() || !Number.isFinite(qty) || qty <= 0) {
        setError('Initial quantity must be greater than 0.');
        return;
      }
      if (!price.trim() || !Number.isFinite(px) || px < 0) {
        setError('Initial price must be 0 or more.');
        return;
      }
      if (!Number.isFinite(f) || f < 0) {
        setError('Fee must be 0 or more.');
        return;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        setError('Pick a valid purchase date.');
        return;
      }
      body.initialPurchase = {
        quantity: qty,
        price: px,
        fee: f,
        // UTC-midnight anchor → date portion is the exact day key (§6.9).
        executedAt: `${date}T00:00:00.000Z`,
      };
    }

    setSubmitting(true);
    setError(null);
    try {
      await createCustomAsset(body);
      onCreated();
      onClose();
    } catch {
      setError('Could not create the investment. Please try again.');
      setSubmitting(false);
    }
  }

  return (
    <Dialog title="New custom investment" onClose={onClose} widthClassName="max-w-lg">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4" aria-labelledby={headingId}>
        <span id={headingId} className="sr-only">
          New custom investment
        </span>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-neutral-300">Name</span>
          <input
            type="text"
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            aria-label="Name"
            placeholder="e.g. Apartment in Vienna"
            className={inputClass}
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-neutral-300">Category</span>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as CustomAssetCategory)}
              aria-label="Category"
              className={inputClass}
            >
              {CUSTOM_ASSET_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-neutral-300">Currency</span>
            <input
              type="text"
              value={currency}
              maxLength={3}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              aria-label="Currency"
              placeholder="EUR"
              className={cx(inputClass, 'uppercase')}
            />
          </label>
        </div>

        <label className="flex items-center gap-2 text-sm text-neutral-300">
          <input
            type="checkbox"
            checked={withPurchase}
            onChange={(e) => setWithPurchase(e.target.checked)}
            className="h-4 w-4 rounded border-neutral-700 bg-neutral-950 text-sky-600 focus:ring-sky-500"
          />
          Record an initial purchase
        </label>

        {withPurchase ? (
          <div className="grid grid-cols-2 gap-3 rounded-md border border-neutral-800 p-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-neutral-300">Quantity</span>
              <input
                type="number"
                inputMode="decimal"
                step="any"
                min="0"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                aria-label="Initial quantity"
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-neutral-300">Date</span>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                aria-label="Purchase date"
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-neutral-300">
                Price ({currency.toUpperCase() || 'EUR'})
              </span>
              <input
                type="number"
                inputMode="decimal"
                step="any"
                min="0"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                aria-label="Initial price"
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-neutral-300">
                Fee ({currency.toUpperCase() || 'EUR'})
              </span>
              <input
                type="number"
                inputMode="decimal"
                step="any"
                min="0"
                value={fee}
                onChange={(e) => setFee(e.target.value)}
                aria-label="Initial fee"
                placeholder="0"
                className={inputClass}
              />
            </label>
          </div>
        ) : null}

        {error ? <Alert tone="error">{error}</Alert> : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Creating…' : 'Create investment'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
