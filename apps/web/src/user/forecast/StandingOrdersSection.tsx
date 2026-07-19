import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import type { PortfolioSummary, StandingOrder } from '@bettertrack/contracts';

import { useT, type TranslateFn } from '../../i18n';
import { formatDate, formatMoney, formatQuantity } from '../../lib/format';
import {
  STANDING_ORDERS_QUERY_KEY,
  deleteStandingOrder,
  listStandingOrders,
  pauseStandingOrder,
  resumeStandingOrder,
} from '../../lib/standingOrdersApi';
import { EmptyState, Skeleton } from '../../ui';
import { Alert, Button, cx } from '../components/ui';

import { StandingOrderDialog } from './StandingOrderDialog';

const EM_DASH = '—';

/**
 * Standing-orders management surface (PROJECTPLAN.md §13.5 V5-P6b arc (a);
 * issue #593 provides the engine + endpoints, #595 the web half). Lists the
 * caller's recurring buy / cash-add / cash-deduct orders with per-row edit,
 * pause / resume and delete; the create dialog is a compact modal so no
 * top-level nav is added (anti-bloat — this rides inside the Forecast tab,
 * "your portfolio, continued").
 */
export function StandingOrdersSection({ portfolios }: { portfolios: PortfolioSummary[] }) {
  const t = useT();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<StandingOrder | null>(null);

  const query = useQuery({
    queryKey: STANDING_ORDERS_QUERY_KEY,
    queryFn: ({ signal }) => listStandingOrders(undefined, signal),
    staleTime: 30_000,
  });

  const orders = query.data?.orders ?? [];

  const disableCreate = portfolios.length === 0;

  return (
    <section aria-labelledby="forecast-standing-orders-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            id="forecast-standing-orders-heading"
            className="text-sm font-semibold text-neutral-200"
          >
            {t('forecast.standingOrders.title')}
          </h2>
          <p className="text-xs text-neutral-500">{t('forecast.standingOrders.subtitle')}</p>
        </div>
        <Button onClick={() => setCreating(true)} disabled={disableCreate}>
          {t('forecast.standingOrders.newOrder')}
        </Button>
      </div>

      {query.isLoading ? (
        <div className="flex flex-col gap-2">
          <Skeleton height="h-16" />
          <Skeleton height="h-16" />
        </div>
      ) : query.isError ? (
        <Alert tone="error">{t('forecast.standingOrders.loadError')}</Alert>
      ) : orders.length === 0 ? (
        <EmptyState
          icon="🔁"
          title={t('forecast.standingOrders.emptyTitle')}
          description={t('forecast.standingOrders.emptyDescription')}
          cta={
            !disableCreate ? (
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="rounded text-sm text-sky-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
              >
                {t('forecast.standingOrders.emptyCta')}
              </button>
            ) : null
          }
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {orders.map((order) => (
            <StandingOrderRow key={order.id} order={order} onEdit={setEditing} />
          ))}
        </ul>
      )}

      {creating ? (
        <StandingOrderDialog portfolios={portfolios} onClose={() => setCreating(false)} />
      ) : null}
      {editing ? (
        <StandingOrderDialog
          portfolios={portfolios}
          existing={editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </section>
  );
}

// ─── Row ─────────────────────────────────────────────────────────────────────

function StandingOrderRow({
  order,
  onEdit,
}: {
  order: StandingOrder;
  onEdit: (order: StandingOrder) => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const pauseMutation = useMutation({
    mutationFn: () => pauseStandingOrder(order.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: STANDING_ORDERS_QUERY_KEY }),
  });
  const resumeMutation = useMutation({
    mutationFn: () => resumeStandingOrder(order.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: STANDING_ORDERS_QUERY_KEY }),
  });
  const deleteMutation = useMutation({
    mutationFn: () => deleteStandingOrder(order.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: STANDING_ORDERS_QUERY_KEY }),
  });

  const busy = pauseMutation.isPending || resumeMutation.isPending || deleteMutation.isPending;
  const paused = order.status === 'paused';

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-neutral-800 bg-neutral-900/40 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-neutral-100">{orderTitle(t, order)}</span>
            <StatusBadge paused={paused} />
          </span>
          <span className="text-xs text-neutral-400">
            {describeAmount(t, order)} · {describeCadence(t, order)}
            {order.endDate ? (
              <>
                {' '}
                · {t('forecast.standingOrders.list.endsOn', { date: formatDate(order.endDate) })}
              </>
            ) : null}
          </span>
          <span className="text-xs text-neutral-500">
            {order.nextRunDate
              ? t('forecast.standingOrders.list.nextRun', {
                  date: formatDate(order.nextRunDate),
                })
              : t('forecast.standingOrders.list.noNextRun')}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 pt-1 text-sm">
        {paused ? (
          <button
            type="button"
            onClick={() => resumeMutation.mutate()}
            disabled={busy}
            className="font-medium text-sky-400 hover:text-sky-300 disabled:cursor-not-allowed disabled:text-neutral-600"
          >
            {resumeMutation.isPending
              ? t('forecast.standingOrders.list.resuming')
              : t('forecast.standingOrders.list.resume')}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => pauseMutation.mutate()}
            disabled={busy}
            className="font-medium text-amber-400 hover:text-amber-300 disabled:cursor-not-allowed disabled:text-neutral-600"
          >
            {pauseMutation.isPending
              ? t('forecast.standingOrders.list.pausing')
              : t('forecast.standingOrders.list.pause')}
          </button>
        )}
        <button
          type="button"
          onClick={() => onEdit(order)}
          disabled={busy}
          className="font-medium text-neutral-300 hover:text-neutral-100 disabled:cursor-not-allowed disabled:text-neutral-600"
        >
          {t('common.edit')}
        </button>
        {confirmingDelete ? (
          <span className="inline-flex items-center gap-2 text-xs">
            <span className="text-neutral-400">
              {t('forecast.standingOrders.list.deleteConfirm')}
            </span>
            <button
              type="button"
              onClick={() => deleteMutation.mutate()}
              disabled={busy}
              className="font-medium text-red-400 hover:text-red-300 disabled:cursor-not-allowed disabled:text-neutral-600"
            >
              {deleteMutation.isPending ? t('common.saving') : t('common.yes')}
            </button>
            <button
              type="button"
              onClick={() => setConfirmingDelete(false)}
              disabled={busy}
              className="font-medium text-neutral-400 hover:text-neutral-200 disabled:cursor-not-allowed disabled:text-neutral-600"
            >
              {t('common.no')}
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            disabled={busy}
            className="font-medium text-red-400 hover:text-red-300 disabled:cursor-not-allowed disabled:text-neutral-600"
          >
            {t('common.delete')}
          </button>
        )}
      </div>

      {pauseMutation.isError || resumeMutation.isError || deleteMutation.isError ? (
        <Alert tone="error">{t('forecast.standingOrders.list.updateError')}</Alert>
      ) : null}
    </li>
  );
}

function StatusBadge({ paused }: { paused: boolean }) {
  const t = useT();
  return (
    <span
      className={cx(
        'inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset',
        paused
          ? 'bg-neutral-800/60 text-neutral-400 ring-neutral-700'
          : 'bg-emerald-900/40 text-emerald-300 ring-emerald-800/60',
      )}
    >
      {paused
        ? t('forecast.standingOrders.status.paused')
        : t('forecast.standingOrders.status.active')}
    </span>
  );
}

// ─── Labels ──────────────────────────────────────────────────────────────────

/** Row title — asset symbol for a buy, or the label (falling back to the kind). */
function orderTitle(t: TranslateFn, order: StandingOrder): string {
  if (order.kind === 'buy-asset') {
    return order.assetSymbol ?? EM_DASH;
  }
  return order.label ?? t(`forecast.standingOrders.kind.${order.kind}`);
}

function describeAmount(t: TranslateFn, order: StandingOrder): string {
  if (order.kind === 'buy-asset') {
    return t('forecast.standingOrders.list.buyAmount', {
      quantity: formatQuantity(order.amount),
      symbol: order.assetSymbol ?? EM_DASH,
    });
  }
  const money = formatMoney(order.amount, order.currency);
  return order.kind === 'cash-add'
    ? t('forecast.standingOrders.list.cashAdd', { amount: money })
    : t('forecast.standingOrders.list.cashDeduct', { amount: money });
}

function describeCadence(t: TranslateFn, order: StandingOrder): string {
  if (order.cadence === 'daily') {
    return t('forecast.standingOrders.list.cadenceDaily');
  }
  return t('forecast.standingOrders.list.cadenceMonthly', { day: order.anchorDay ?? 1 });
}
