import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import {
  STANDING_ORDER_KINDS,
  type PortfolioSummary,
  type SearchResultItem,
  type StandingOrder,
  type StandingOrderCadence,
  type StandingOrderKind,
} from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import {
  STANDING_ORDERS_QUERY_KEY,
  createStandingOrder,
  updateStandingOrder,
} from '../../lib/standingOrdersApi';
import { AssetSearchBox } from '../components/AssetSearchBox';
import { Dialog } from '../components/Dialog';
import { Alert, Button, cx } from '../components/ui';

const inputClass = cx(
  'w-full rounded-md bg-neutral-950 px-3 py-2 text-sm text-neutral-100',
  'ring-1 ring-inset ring-neutral-700 placeholder:text-neutral-600',
  'focus:outline-none focus:ring-2 focus:ring-sky-500',
);

/**
 * Minimal picked-asset shape held in dialog state after a search selection.
 * Symbol/name are shown as a locked chip; the id + currency are what post.
 */
interface PickedAsset {
  id: string;
  symbol: string;
  name: string;
  currency: string;
}

export interface StandingOrderDialogProps {
  /** Active portfolio (the create endpoint requires one; edit inherits from the order). */
  portfolios: PortfolioSummary[];
  /** Edit mode — the order being edited. Kind, asset and schedule are immutable server-side. */
  existing?: StandingOrder | null;
  onClose: () => void;
}

/**
 * Create / edit dialog for a standing order (PROJECTPLAN.md §13.5 V5-P6b arc
 * (a), issue #593 contracts). Three kinds share one form:
 *
 *  - **buy-asset** — locks an asset via {@link AssetSearchBox} + share
 *    quantity; the asset is required.
 *  - **cash-add / cash-deduct** — a EUR magnitude + short label ("salary",
 *    "Netflix"); no asset field is shown or posted.
 *
 * Cadence is `daily` (fires every day from `startDate`) or `monthly` (fires
 * once on `anchorDay`, clamped to month-end in shorter months). `endDate` is
 * optional; on edit only `amount`, `label` and `endDate` can be changed —
 * every other field is displayed read-only and the server refuses updates.
 */
export function StandingOrderDialog({ portfolios, existing, onClose }: StandingOrderDialogProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const isEdit = !!existing;

  const defaultPortfolioId = useMemo(() => {
    if (existing) return existing.portfolioId;
    return (portfolios.find((p) => p.isDefault) ?? portfolios[0])?.id ?? '';
  }, [existing, portfolios]);

  const [portfolioId, setPortfolioId] = useState(defaultPortfolioId);
  const [kind, setKind] = useState<StandingOrderKind>(existing?.kind ?? 'buy-asset');
  const [asset, setAsset] = useState<PickedAsset | null>(
    existing && existing.assetId && existing.assetSymbol
      ? {
          id: existing.assetId,
          symbol: existing.assetSymbol,
          name: existing.assetName ?? existing.assetSymbol,
          currency: existing.currency,
        }
      : null,
  );
  const [amount, setAmount] = useState(existing ? String(existing.amount) : '');
  const [label, setLabel] = useState(existing?.label ?? '');
  const [cadence, setCadence] = useState<StandingOrderCadence>(existing?.cadence ?? 'monthly');
  const [anchorDay, setAnchorDay] = useState(
    existing?.anchorDay != null ? String(existing.anchorDay) : '1',
  );
  const [startDate, setStartDate] = useState(existing?.startDate ?? '');
  const [endDate, setEndDate] = useState(existing?.endDate ?? '');
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      if (isEdit && existing) {
        const patch = {
          amount: Number(amount),
          label: label.trim() === '' ? null : label.trim(),
          endDate: endDate.trim() === '' ? null : endDate.trim(),
        };
        return updateStandingOrder(existing.id, patch);
      }
      const trimmedLabel = label.trim();
      const trimmedStart = startDate.trim();
      const trimmedEnd = endDate.trim();
      return createStandingOrder({
        portfolioId,
        kind,
        assetId: kind === 'buy-asset' ? asset!.id : undefined,
        amount: Number(amount),
        label: trimmedLabel === '' ? undefined : trimmedLabel,
        cadence,
        anchorDay: cadence === 'monthly' ? Number(anchorDay) : undefined,
        startDate: trimmedStart === '' ? undefined : trimmedStart,
        endDate: trimmedEnd === '' ? undefined : trimmedEnd,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: STANDING_ORDERS_QUERY_KEY });
      onClose();
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    const numericAmount = Number(amount);
    if (amount.trim() === '' || !Number.isFinite(numericAmount) || numericAmount <= 0) {
      setFormError(t('forecast.standingOrders.dialog.amountRequired'));
      return;
    }

    if (!isEdit) {
      if (!portfolioId) {
        setFormError(t('forecast.standingOrders.dialog.portfolioRequired'));
        return;
      }
      if (kind === 'buy-asset' && asset === null) {
        setFormError(t('forecast.standingOrders.dialog.assetRequired'));
        return;
      }
      if (cadence === 'monthly') {
        const day = Number(anchorDay);
        if (!Number.isInteger(day) || day < 1 || day > 31) {
          setFormError(t('forecast.standingOrders.dialog.anchorDayInvalid'));
          return;
        }
      }
      if (startDate.trim() !== '' && endDate.trim() !== '' && endDate.trim() < startDate.trim()) {
        setFormError(t('forecast.standingOrders.dialog.endBeforeStart'));
        return;
      }
    } else if (endDate.trim() !== '' && endDate.trim() < existing!.startDate) {
      setFormError(t('forecast.standingOrders.dialog.endBeforeStart'));
      return;
    }

    mutation.mutate();
  }

  const errorMessage =
    formError ??
    (mutation.error instanceof ApiError
      ? mutation.error.message
      : mutation.error
        ? t('forecast.standingOrders.dialog.saveError')
        : null);

  const amountLabelKey =
    kind === 'buy-asset'
      ? 'forecast.standingOrders.dialog.amountLabelShares'
      : 'forecast.standingOrders.dialog.amountLabelEur';

  return (
    <Dialog
      title={
        isEdit
          ? t('forecast.standingOrders.dialog.editTitle')
          : t('forecast.standingOrders.dialog.createTitle')
      }
      description={t('forecast.standingOrders.dialog.description')}
      onClose={onClose}
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {/* Kind — locked in edit mode (server refuses schedule changes). */}
        <div
          className="flex gap-1 rounded-md bg-neutral-950 p-1 ring-1 ring-inset ring-neutral-700"
          role="group"
          aria-label={t('forecast.standingOrders.dialog.kindGroupAria')}
        >
          {STANDING_ORDER_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => {
                if (isEdit) return;
                setKind(k);
                if (k !== 'buy-asset') setAsset(null);
              }}
              disabled={isEdit && k !== kind}
              aria-pressed={kind === k}
              className={cx(
                'flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
                kind === k
                  ? 'bg-neutral-800 text-neutral-100 ring-1 ring-inset ring-neutral-600'
                  : 'text-neutral-400 hover:text-neutral-200',
                isEdit && kind !== k ? 'cursor-not-allowed opacity-40' : '',
              )}
            >
              {t(`forecast.standingOrders.kind.${k}`)}
            </button>
          ))}
        </div>

        {/* Portfolio (create only — an order is bound to its portfolio at creation). */}
        {!isEdit && portfolios.length > 1 ? (
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-neutral-300">
              {t('forecast.standingOrders.dialog.portfolioLabel')}
            </span>
            <select
              value={portfolioId}
              onChange={(e) => setPortfolioId(e.target.value)}
              aria-label={t('forecast.standingOrders.dialog.portfolioLabel')}
              className={inputClass}
            >
              {portfolios.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {/* Asset — only for buy-asset; locked (chip) once picked. */}
        {kind === 'buy-asset' ? (
          asset ? (
            <div className="flex items-center justify-between gap-3 rounded-md bg-neutral-950 px-3 py-2 ring-1 ring-inset ring-neutral-700">
              <span className="min-w-0">
                <span className="font-mono text-sm text-neutral-200">{asset.symbol}</span>
                <span className="ml-2 truncate text-sm text-neutral-500">{asset.name}</span>
              </span>
              {!isEdit ? (
                <button
                  type="button"
                  onClick={() => setAsset(null)}
                  className="shrink-0 text-xs font-medium text-sky-400 hover:text-sky-300"
                >
                  {t('forecast.standingOrders.dialog.changeAsset')}
                </button>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-neutral-300">
                {t('forecast.standingOrders.dialog.assetLabel')}
              </span>
              <AssetSearchBox
                placeholder={t('forecast.standingOrders.dialog.assetPlaceholder')}
                onSelect={(item: SearchResultItem) =>
                  setAsset({
                    id: item.id,
                    symbol: item.symbol,
                    name: item.name,
                    currency: item.currency,
                  })
                }
              />
            </div>
          )
        ) : null}

        {/* Amount — meaning depends on kind. */}
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-neutral-300">{t(amountLabelKey)}</span>
          <input
            type="number"
            inputMode="decimal"
            step="any"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-label={t(amountLabelKey)}
            className={inputClass}
          />
        </label>

        {/* Label — optional; the human hint on the auto-recorded row. */}
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-neutral-300">
            {t('forecast.standingOrders.dialog.labelLabel')}
          </span>
          <input
            type="text"
            value={label}
            maxLength={120}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t('forecast.standingOrders.dialog.labelPlaceholder')}
            aria-label={t('forecast.standingOrders.dialog.labelLabel')}
            className={inputClass}
          />
        </label>

        {/* Cadence + anchor day — schedule is immutable in edit, so read-only there. */}
        {!isEdit ? (
          <div className="flex flex-col gap-3 sm:flex-row">
            <label className="flex-1 flex flex-col gap-1.5">
              <span className="text-sm font-medium text-neutral-300">
                {t('forecast.standingOrders.dialog.cadenceLabel')}
              </span>
              <select
                value={cadence}
                onChange={(e) => setCadence(e.target.value as StandingOrderCadence)}
                aria-label={t('forecast.standingOrders.dialog.cadenceLabel')}
                className={inputClass}
              >
                <option value="daily">{t('forecast.standingOrders.cadence.daily')}</option>
                <option value="monthly">{t('forecast.standingOrders.cadence.monthly')}</option>
              </select>
            </label>
            {cadence === 'monthly' ? (
              <label className="flex-1 flex flex-col gap-1.5">
                <span className="text-sm font-medium text-neutral-300">
                  {t('forecast.standingOrders.dialog.anchorDayLabel')}
                </span>
                <input
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max="31"
                  value={anchorDay}
                  onChange={(e) => setAnchorDay(e.target.value)}
                  aria-label={t('forecast.standingOrders.dialog.anchorDayLabel')}
                  className={inputClass}
                />
              </label>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-neutral-500">
            {t('forecast.standingOrders.dialog.scheduleImmutable')}
          </p>
        )}

        {/* Start (create only) + optional End date. */}
        <div className="flex flex-col gap-3 sm:flex-row">
          {!isEdit ? (
            <label className="flex-1 flex flex-col gap-1.5">
              <span className="text-sm font-medium text-neutral-300">
                {t('forecast.standingOrders.dialog.startDateLabel')}
              </span>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                aria-label={t('forecast.standingOrders.dialog.startDateLabel')}
                className={inputClass}
              />
            </label>
          ) : null}
          <label className="flex-1 flex flex-col gap-1.5">
            <span className="text-sm font-medium text-neutral-300">
              {t('forecast.standingOrders.dialog.endDateLabel')}
            </span>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              aria-label={t('forecast.standingOrders.dialog.endDateLabel')}
              className={inputClass}
            />
          </label>
        </div>

        {errorMessage ? <Alert tone="error">{errorMessage}</Alert> : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending
              ? t('common.saving')
              : isEdit
                ? t('common.save')
                : t('forecast.standingOrders.dialog.createSubmit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
