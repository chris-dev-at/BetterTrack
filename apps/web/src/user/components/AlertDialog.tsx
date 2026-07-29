import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import type { Alert, AlertKind, CreateAlertRequest } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { ALERTS_QUERY_KEY, createAlert, updateAlert } from '../../lib/alertsApi';
import { ApiError } from '../../lib/apiClient';
import { formatUnitPrice } from '../../lib/format';
import { truncateMoneyForInput } from '../../lib/moneyInput';
import { Button, Field, Input, Select } from '../../ui/origin';
import { AssetSearchBox } from './AssetSearchBox';
import { Dialog } from './Dialog';
import { ALERT_KIND_META, ALERT_KIND_ORDER } from './alertMeta';
import { Alert as AlertBanner } from './ui';

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

/** Group the kinds under their caption key for the `<optgroup>` layout. */
function groupedKinds(): { groupKey: string; kinds: AlertKind[] }[] {
  const groups: { groupKey: string; kinds: AlertKind[] }[] = [];
  for (const kind of ALERT_KIND_ORDER) {
    const { groupKey } = ALERT_KIND_META[kind];
    const last = groups[groups.length - 1];
    if (last && last.groupKey === groupKey) last.kinds.push(kind);
    else groups.push({ groupKey, kinds: [kind] });
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
  const t = useT();
  const queryClient = useQueryClient();
  const editing = !!existing;

  const [selectedAsset, setSelectedAsset] = useState<AlertDialogAsset | null>(
    asset ?? (existing ? { ...existing.asset } : null),
  );
  const [kind, setKind] = useState<AlertKind>(existing?.kind ?? 'price_above');
  const initialThreshold = existing
    ? // Edit opens on the STORED threshold — keep it exact, never cents-truncated
      // (truncating on open + save would silently mutate the saved value).
      String(existing.threshold)
    : asset && referencePrice != null && ALERT_KIND_META['price_above'].unit === 'price'
      ? // Seed from the live quote → a market-data autofill: cut to cents.
        truncateMoneyForInput(referencePrice)
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
      setFormError(t('workboard.alerts.dialog.errorNoAsset'));
      return;
    }
    const value = Number(threshold);
    if (!threshold.trim() || !Number.isFinite(value) || value <= 0) {
      setFormError(t('workboard.alerts.dialog.errorThreshold'));
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
      // Same market-data seed as on open — cut the live quote to cents.
      setThreshold(truncateMoneyForInput(referencePrice));
    }
  }

  const errorMessage =
    formError ??
    (mutation.error instanceof ApiError
      ? mutation.error.message
      : mutation.error
        ? t('workboard.alerts.dialog.saveError')
        : null);

  // Reference-price hint under the threshold field, only for the `*_from_ref`
  // kinds: the STORED reference once measured (edit), the live quote about to
  // be captured (create with a quote), or a no-quote fallback.
  const refHint = !kindMeta.ref
    ? undefined
    : editing && existing?.refPrice != null
      ? t('workboard.alerts.dialog.refMeasured', {
          price: formatUnitPrice(existing.refPrice, currency),
        })
      : referencePrice != null
        ? t('workboard.alerts.dialog.refWillCapture', {
            price: formatUnitPrice(referencePrice, currency),
          })
        : t('workboard.alerts.dialog.refWillCaptureNoPrice');

  return (
    <Dialog
      title={
        editing ? t('workboard.alerts.dialog.editTitle') : t('workboard.alerts.dialog.createTitle')
      }
      description={
        editing
          ? t('workboard.alerts.dialog.editDescription')
          : t('workboard.alerts.dialog.createDescription')
      }
      onClose={onClose}
    >
      <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
        {/* Asset — a picker when creating from the Workboard, locked otherwise. */}
        {selectedAsset ? (
          <div
            className="bt-input flex items-center justify-between gap-3"
            style={{ height: 'auto' }}
          >
            <span className="min-w-0 truncate">
              <span className="bt-row-title">{selectedAsset.symbol}</span>{' '}
              <span className="bt-muted">{selectedAsset.name}</span>
            </span>
            {!editing && !asset ? (
              <button
                className="bt-link shrink-0"
                onClick={() => setSelectedAsset(null)}
                style={{ fontSize: 12 }}
                type="button"
              >
                {t('workboard.alerts.dialog.changeAsset')}
              </button>
            ) : null}
          </div>
        ) : (
          <Field label={t('workboard.alerts.dialog.assetLabel')}>
            <AssetSearchBox
              placeholder={t('workboard.alerts.dialog.assetPlaceholder')}
              onSelect={(item) =>
                setSelectedAsset({
                  id: item.id,
                  symbol: item.symbol,
                  name: item.name,
                  currency: item.currency,
                })
              }
            />
          </Field>
        )}

        {/* Kind — a grouped selector when creating; locked in edit mode. */}
        <Field htmlFor="alert-kind" label={t('workboard.alerts.dialog.whenLabel')}>
          {editing ? (
            <p className="bt-input" style={{ display: 'flex', alignItems: 'center' }}>
              {t(kindMeta.labelKey)}
            </p>
          ) : (
            <Select
              id="alert-kind"
              onChange={(e) => selectKind(e.target.value as AlertKind)}
              value={kind}
            >
              {groups.map((g) => (
                <optgroup key={g.groupKey} label={t(g.groupKey)}>
                  {g.kinds.map((k) => (
                    <option key={k} value={k}>
                      {t(ALERT_KIND_META[k].labelKey)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          )}
        </Field>

        {/* Threshold — price or percent per the kind. */}
        <Field
          hint={refHint}
          htmlFor="alert-threshold"
          label={
            kindMeta.unit === 'price'
              ? t('workboard.alerts.dialog.thresholdPrice', { currency })
              : t('workboard.alerts.dialog.thresholdPercent')
          }
        >
          <div className="flex items-center gap-2">
            <Input
              className="bt-num"
              id="alert-threshold"
              inputMode="decimal"
              min="0"
              onChange={(e) => setThreshold(e.target.value)}
              placeholder={kindMeta.unit === 'price' ? '0.00' : '5'}
              step="any"
              type="number"
              value={threshold}
            />
            <span className="bt-meta">{kindMeta.unit === 'price' ? currency : '%'}</span>
          </div>
        </Field>

        {/* Repeat vs one-shot. */}
        <label className="flex items-start gap-2.5">
          <input
            checked={repeat}
            className="mt-0.5 h-4 w-4"
            onChange={(e) => setRepeat(e.target.checked)}
            style={{ accentColor: 'var(--bt-gold)' }}
            type="checkbox"
          />
          <span className="bt-soft">
            {t('workboard.alerts.dialog.repeatLabel')}
            <span className="bt-meta block">
              {repeat
                ? t('workboard.alerts.dialog.repeatOnHint')
                : t('workboard.alerts.dialog.repeatOffHint')}
            </span>
          </span>
        </label>

        {errorMessage ? <AlertBanner tone="error">{errorMessage}</AlertBanner> : null}

        <div className="flex justify-end gap-2">
          <Button disabled={mutation.isPending} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button disabled={mutation.isPending} type="submit" variant="primary">
            {mutation.isPending
              ? t('common.saving')
              : editing
                ? t('workboard.alerts.dialog.saveChanges')
                : t('workboard.alerts.dialog.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
