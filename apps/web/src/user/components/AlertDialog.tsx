import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import type { Alert, AlertKind, CreateAlertRequest } from '@bettertrack/contracts';

import { ALERTS_QUERY_KEY, createAlert, updateAlert } from '../../lib/alertsApi';
import { ApiError } from '../../lib/apiClient';
import { formatMoney } from '../../lib/format';
import { AssetSearchBox } from './AssetSearchBox';
import { Dialog } from './Dialog';
import { ALERT_KIND_META, ALERT_KIND_ORDER } from './alertMeta';
import { Alert as AlertBanner, Button, cx } from './ui';

/** Minimal asset identity the dialog needs to create/label an alert. */
export interface AlertDialogAsset {
  id: string;
  symbol: string;
  name: string;
  currency: string;
}

export interface AlertDialogProps {
  onClose: () => void;
  /**
   * Prefilled, locked asset — the asset-page inline create passes the current
   * asset. When absent the dialog shows an asset picker (Workboard create).
   */
  asset?: AlertDialogAsset | null;
  /** Current quote price shown as reference context for the `*_from_ref` kinds. */
  referencePrice?: number | null;
  /** Edit mode: the alert being edited. Its kind + asset are immutable (§14). */
  existing?: Alert | null;
}

/** Group the kinds under their caption for the `<optgroup>` layout. */
function groupedKinds(): { group: string; kinds: AlertKind[] }[] {
  const groups: { group: string; kinds: AlertKind[] }[] = [];
  for (const kind of ALERT_KIND_ORDER) {
    const { group } = ALERT_KIND_META[kind];
    const last = groups[groups.length - 1];
    if (last && last.group === group) last.kinds.push(kind);
    else groups.push({ group, kinds: [kind] });
  }
  return groups;
}

/**
 * Create / edit dialog for a price alert (PROJECTPLAN.md §14, V3-P10 arc b).
 * Shared by the Workboard alerts panel and the asset-page inline widget:
 *
 * - **create, asset locked** (asset page) — kind + threshold + repeat, with the
 *   current quote shown as reference context;
 * - **create, asset picked** (Workboard) — an {@link AssetSearchBox} picker first;
 * - **edit** — kind + asset are immutable (create a new alert instead), so only
 *   the threshold and repeat behaviour are editable.
 */
export function AlertDialog({ onClose, asset, referencePrice, existing }: AlertDialogProps) {
  const queryClient = useQueryClient();
  const editing = !!existing;

  const [selectedAsset, setSelectedAsset] = useState<AlertDialogAsset | null>(
    asset ?? (existing ? { ...existing.asset } : null),
  );
  const [kind, setKind] = useState<AlertKind>(existing?.kind ?? 'price_above');
  const initialThreshold = existing
    ? String(existing.threshold)
    : asset && referencePrice != null && ALERT_KIND_META['price_above'].unit === 'price'
      ? String(referencePrice)
      : '';
  const [threshold, setThreshold] = useState(initialThreshold);
  const [repeat, setRepeat] = useState(existing?.repeat ?? false);
  const [formError, setFormError] = useState<string | null>(null);

  const kindMeta = ALERT_KIND_META[kind];
  const currency = selectedAsset?.currency ?? 'EUR';
  const groups = useMemo(groupedKinds, []);

  const mutation = useMutation({
    mutationFn: async () => {
      const value = Number(threshold);
      if (editing) {
        return updateAlert(existing!.id, { threshold: value, repeat });
      }
      const body: CreateAlertRequest = {
        assetId: selectedAsset!.id,
        kind,
        threshold: value,
        repeat,
      };
      return createAlert(body);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ALERTS_QUERY_KEY });
      onClose();
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!selectedAsset) {
      setFormError('Pick an asset for this alert.');
      return;
    }
    const value = Number(threshold);
    if (!threshold.trim() || !Number.isFinite(value) || value <= 0) {
      setFormError('Enter a threshold greater than 0.');
      return;
    }
    mutation.mutate();
  }

  // When the kind flips to a price kind on the asset page, seed the threshold
  // with the current quote so a "rises above" alert starts at a sensible level.
  function selectKind(next: AlertKind) {
    setKind(next);
    if (
      !editing &&
      !threshold.trim() &&
      ALERT_KIND_META[next].unit === 'price' &&
      referencePrice != null
    ) {
      setThreshold(String(referencePrice));
    }
  }

  const errorMessage =
    formError ??
    (mutation.error instanceof ApiError
      ? mutation.error.message
      : mutation.error
        ? 'Could not save the alert. Please try again.'
        : null);

  return (
    <Dialog
      title={editing ? 'Edit alert' : 'New price alert'}
      description={
        editing
          ? 'The rule kind and asset are fixed — adjust the threshold or repeat behaviour.'
          : 'Get notified when this rule fires. Alerts are evaluated every minute against the latest quote.'
      }
      onClose={onClose}
    >
      <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
        {/* Asset — a picker when creating from the Workboard, locked otherwise. */}
        {selectedAsset ? (
          <div className="flex items-center justify-between gap-3 rounded-md bg-neutral-950 px-3 py-2 ring-1 ring-inset ring-neutral-700">
            <span className="min-w-0">
              <span className="font-mono text-sm text-neutral-200">{selectedAsset.symbol}</span>
              <span className="ml-2 truncate text-sm text-neutral-500">{selectedAsset.name}</span>
            </span>
            {!editing && !asset ? (
              <button
                type="button"
                onClick={() => setSelectedAsset(null)}
                className="shrink-0 text-xs font-medium text-sky-400 hover:text-sky-300"
              >
                Change
              </button>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-neutral-300">Asset</span>
            <AssetSearchBox
              placeholder="Search an asset to alert on…"
              onSelect={(item) =>
                setSelectedAsset({
                  id: item.id,
                  symbol: item.symbol,
                  name: item.name,
                  currency: item.currency,
                })
              }
            />
          </div>
        )}

        {/* Kind — a grouped selector when creating; locked in edit mode. */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="alert-kind" className="text-sm font-medium text-neutral-300">
            When
          </label>
          {editing ? (
            <p className="rounded-md bg-neutral-950 px-3 py-2 text-sm text-neutral-300 ring-1 ring-inset ring-neutral-700">
              {kindMeta.label}
            </p>
          ) : (
            <select
              id="alert-kind"
              value={kind}
              onChange={(e) => selectKind(e.target.value as AlertKind)}
              className="rounded-md bg-neutral-950 px-3 py-2 text-sm text-neutral-100 ring-1 ring-inset ring-neutral-700 focus:outline-none focus:ring-2 focus:ring-sky-500"
            >
              {groups.map((g) => (
                <optgroup key={g.group} label={g.group}>
                  {g.kinds.map((k) => (
                    <option key={k} value={k}>
                      {ALERT_KIND_META[k].label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          )}
        </div>

        {/* Threshold — price or percent per the kind. */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="alert-threshold" className="text-sm font-medium text-neutral-300">
            {kindMeta.unit === 'price' ? `Threshold price (${currency})` : 'Percent change'}
          </label>
          <div className="flex items-center gap-2">
            <input
              id="alert-threshold"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
              className="w-full rounded-md bg-neutral-950 px-3 py-2 text-sm text-neutral-100 ring-1 ring-inset ring-neutral-700 placeholder:text-neutral-600 focus:outline-none focus:ring-2 focus:ring-sky-500"
              placeholder={kindMeta.unit === 'price' ? '0.00' : '5'}
            />
            <span className="text-sm text-neutral-500">
              {kindMeta.unit === 'price' ? currency : '%'}
            </span>
          </div>
          {kindMeta.ref ? (
            <p className="text-xs text-neutral-500">
              {editing && existing?.refPrice != null
                ? `Measured from the reference captured at creation (${formatMoney(existing.refPrice, currency)}).`
                : referencePrice != null
                  ? `The current price (${formatMoney(referencePrice, currency)}) is captured as the reference when you create this alert.`
                  : 'The current market price is captured as the reference when you create this alert.'}
            </p>
          ) : null}
        </div>

        {/* Repeat vs one-shot. */}
        <label className="flex items-start gap-2.5">
          <input
            type="checkbox"
            checked={repeat}
            onChange={(e) => setRepeat(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-neutral-600 bg-neutral-950 text-sky-500 focus:ring-sky-500"
          />
          <span className="text-sm text-neutral-300">
            Repeat
            <span className="block text-xs text-neutral-500">
              {repeat
                ? 'Re-fires on every crossing, at most once per 24 h.'
                : 'One-shot — fires once, then pauses until you re-arm it.'}
            </span>
          </span>
        </label>

        {errorMessage ? <AlertBanner tone="error">{errorMessage}</AlertBanner> : null}

        <div className={cx('flex justify-end gap-2')}>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? 'Saving…' : editing ? 'Save changes' : 'Create alert'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
