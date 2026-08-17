import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { useLocation } from 'react-router-dom';

import type { PortfolioSummary, StandingOrder } from '@bettertrack/contracts';

import { useT, type TranslateFn } from '../../i18n';
import { formatDate, formatMoney, formatQuantity } from '../../lib/format';
import { STANDING_ORDERS_QUERY_KEY } from '../../lib/standingOrdersApi';
import { EmptyState, Skeleton } from '../../ui';
import { Alert, Button, cx } from '../components/ui';

import { StandingOrderDialog } from './StandingOrderDialog';
import { usePortfolioStore } from '../portfolio/PortfolioStoreProvider';
import type { StandingOrderMaterializationResult } from '../vault/standingOrders/materialize';
import { oldestUnbookedStandingOrderDueDate } from '../vault/standingOrders/schedule';
import { useVaultMoneySession } from '../vault/engine/VaultMoneyEngineContext';

const EM_DASH = '—';
const NO_VAULT_MATERIALIZATION = () => null;
const NO_VAULT_SUBSCRIPTION = () => () => undefined;

interface StandingOrderNotice {
  kind: 'quote-unavailable' | 'insufficient-cash' | 'failed';
  dueDate: string;
}

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
  const store = usePortfolioStore();
  const materialization = useVaultStandingOrderMaterialization();
  const location = useLocation();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<StandingOrder | null>(null);

  const query = useQuery({
    queryKey: STANDING_ORDERS_QUERY_KEY,
    queryFn: ({ signal }) => store.listStandingOrders(undefined, signal),
    staleTime: 30_000,
  });

  const orders = query.data?.orders ?? [];

  // The notification route resolves before this async list does, so the
  // browser's one-shot native fragment scroll cannot see the target row. Retry
  // after query data commits the rows to the DOM.
  useEffect(() => {
    if (!location.hash.startsWith('#standing-order-') || query.data === undefined) return;
    document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'center' });
  }, [location.hash, query.data]);

  const disableCreate = portfolios.length === 0;

  return (
    <section aria-labelledby="forecast-standing-orders-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="forecast-standing-orders-heading" className="text-sm font-semibold bt-soft">
            {t('forecast.standingOrders.title')}
          </h2>
          <p className="text-xs bt-muted">{t('forecast.standingOrders.subtitle')}</p>
        </div>
        <Button
          data-testid="standing-order-create-trigger"
          onClick={() => setCreating(true)}
          disabled={disableCreate}
        >
          {t('forecast.standingOrders.newOrder')}
        </Button>
      </div>

      {query.isLoading ? (
        <div className="flex flex-col gap-2">
          <Skeleton height="h-16" />
          <Skeleton height="h-16" />
        </div>
      ) : query.isError ? (
        <div className="flex flex-col items-start gap-2">
          <Alert tone="error">{t('forecast.standingOrders.loadError')}</Alert>
          <Button onClick={() => void query.refetch()}>{t('common.retry')}</Button>
        </div>
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
                className="rounded text-sm bt-link"
              >
                {t('forecast.standingOrders.emptyCta')}
              </button>
            ) : null
          }
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {orders.map((order) => (
            <StandingOrderRow
              key={order.id}
              order={order}
              notice={standingOrderNotice(order, materialization)}
              onEdit={setEditing}
            />
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
  notice,
  onEdit,
}: {
  order: StandingOrder;
  notice: StandingOrderNotice | null;
  onEdit: (order: StandingOrder) => void;
}) {
  const t = useT();
  const store = usePortfolioStore();
  const queryClient = useQueryClient();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const rowId = useId();
  const titleId = `${rowId}-title`;
  const pauseResumeActionId = `${rowId}-pause-resume-action`;
  const editActionId = `${rowId}-edit-action`;
  const deleteActionId = `${rowId}-delete-action`;
  const deleteConfirmYesActionId = `${rowId}-delete-confirm-yes-action`;
  const deleteConfirmNoActionId = `${rowId}-delete-confirm-no-action`;

  const pauseMutation = useMutation({
    mutationFn: () => store.pauseStandingOrder(order.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: STANDING_ORDERS_QUERY_KEY }),
  });
  const resumeMutation = useMutation({
    mutationFn: () => store.resumeStandingOrder(order.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: STANDING_ORDERS_QUERY_KEY }),
  });
  const deleteMutation = useMutation({
    mutationFn: () => store.deleteStandingOrder(order.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: STANDING_ORDERS_QUERY_KEY }),
  });

  const busy = pauseMutation.isPending || resumeMutation.isPending || deleteMutation.isPending;
  const paused = order.status === 'paused';
  const suspendedByArchive = order.suspendedByArchive === true;

  return (
    <li id={`standing-order-${order.id}`} className="flex flex-col gap-2 bt-panel p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-2">
            <span id={titleId} className="text-sm font-semibold">
              {orderTitle(t, order)}
            </span>
            <StatusBadge paused={paused} suspendedByArchive={suspendedByArchive} />
          </span>
          <span className="text-xs bt-muted">
            {describeAmount(t, order)} · {describeCadence(t, order)}
            {order.endDate ? (
              <>
                {' '}
                · {t('forecast.standingOrders.list.endsOn', { date: formatDate(order.endDate) })}
              </>
            ) : null}
          </span>
          <span className="text-xs bt-muted">
            {order.nextRunDate
              ? t('forecast.standingOrders.list.nextRun', {
                  date: formatDate(order.nextRunDate),
                })
              : t('forecast.standingOrders.list.noNextRun')}
          </span>
          {notice ? <StandingOrderNoticeText notice={notice} /> : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 pt-1 text-sm">
        {!suspendedByArchive &&
          (paused ? (
            <button
              id={pauseResumeActionId}
              type="button"
              onClick={() => resumeMutation.mutate()}
              disabled={busy}
              aria-labelledby={`${titleId} ${pauseResumeActionId}`}
              className="font-medium bt-link disabled:cursor-not-allowed disabled:bt-muted"
            >
              {resumeMutation.isPending
                ? t('forecast.standingOrders.list.resuming')
                : t('forecast.standingOrders.list.resume')}
            </button>
          ) : (
            <button
              id={pauseResumeActionId}
              type="button"
              onClick={() => pauseMutation.mutate()}
              disabled={busy}
              aria-labelledby={`${titleId} ${pauseResumeActionId}`}
              className="font-medium bt-gold-note disabled:cursor-not-allowed disabled:bt-muted"
            >
              {pauseMutation.isPending
                ? t('forecast.standingOrders.list.pausing')
                : t('forecast.standingOrders.list.pause')}
            </button>
          ))}
        <button
          id={editActionId}
          type="button"
          onClick={() => onEdit(order)}
          disabled={busy}
          aria-labelledby={`${titleId} ${editActionId}`}
          className="font-medium bt-soft hover: disabled:cursor-not-allowed disabled:bt-muted"
        >
          {t('common.edit')}
        </button>
        {confirmingDelete ? (
          <span className="inline-flex items-center gap-2 text-xs">
            <span className="bt-muted">{t('forecast.standingOrders.list.deleteConfirm')}</span>
            <button
              id={deleteConfirmYesActionId}
              type="button"
              onClick={() => deleteMutation.mutate()}
              disabled={busy}
              aria-labelledby={`${titleId} ${deleteConfirmYesActionId}`}
              className="font-medium bt-neg hover:bt-neg disabled:cursor-not-allowed disabled:bt-muted"
            >
              {deleteMutation.isPending ? t('common.saving') : t('common.yes')}
            </button>
            <button
              id={deleteConfirmNoActionId}
              type="button"
              onClick={() => setConfirmingDelete(false)}
              disabled={busy}
              aria-labelledby={`${titleId} ${deleteConfirmNoActionId}`}
              className="font-medium bt-muted hover:bt-soft disabled:cursor-not-allowed disabled:bt-muted"
            >
              {t('common.no')}
            </button>
          </span>
        ) : (
          <button
            id={deleteActionId}
            type="button"
            onClick={() => setConfirmingDelete(true)}
            disabled={busy}
            aria-labelledby={`${titleId} ${deleteActionId}`}
            className="font-medium bt-neg hover:bt-neg disabled:cursor-not-allowed disabled:bt-muted"
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

function StandingOrderNoticeText({ notice }: { notice: StandingOrderNotice }) {
  const t = useT();
  const date = formatDate(notice.dueDate);
  const key =
    notice.kind === 'quote-unavailable'
      ? 'forecast.standingOrders.list.notBookedQuoteUnavailable'
      : notice.kind === 'insufficient-cash'
        ? 'forecast.standingOrders.list.notBookedInsufficientCash'
        : 'forecast.standingOrders.list.notBookedFailed';
  return <span className="text-xs bt-gold-note">{t(key, { date })}</span>;
}

function useVaultStandingOrderMaterialization(): StandingOrderMaterializationResult | null {
  const engine = useVaultMoneySession()?.engine;
  return useSyncExternalStore(
    engine?.subscribeStandingOrderMaterialization ?? NO_VAULT_SUBSCRIPTION,
    engine?.getLastStandingOrderMaterialization ?? NO_VAULT_MATERIALIZATION,
    NO_VAULT_MATERIALIZATION,
  );
}

function standingOrderNotice(
  order: StandingOrder,
  result: StandingOrderMaterializationResult | null,
): StandingOrderNotice | null {
  if (
    result === null ||
    order.status !== 'active' ||
    order.suspendedByArchive === true ||
    result.booked.some((booked) => booked.orderId === order.id)
  ) {
    return null;
  }

  // The document decides *whether* anything is owed and *since when*; the
  // retained scan entry only supplies the reason. Its own `dueDate` ages out the
  // moment the row moves on — another device books the occurrence, the watermark
  // advances, the user shortens `endDate` — so letting it speak for the schedule
  // is what kept resurrecting notices on ended, booked and not-yet-due orders.
  const dueDate = outstandingDueDate(order, result.today);
  if (dueDate === null) return null;

  if (result.failed.some((failure) => failure.orderId === order.id)) {
    return { kind: 'failed', dueDate };
  }

  const deferrals = result.deferred.filter((deferred) => deferred.orderId === order.id);
  if (deferrals.length === 0) return null;
  return {
    kind: deferrals.some((deferred) => deferred.reason === 'quote-unavailable')
      ? 'quote-unavailable'
      : 'insufficient-cash',
    dueDate,
  };
}

/**
 * The oldest occurrence the order still owes as of the scan day, or null when it
 * owes nothing — ended, booked up to date, or not yet due. Both halves are
 * load-bearing: {@link oldestUnbookedStandingOrderDueDate} reads
 * cadence/anchor/startDate/endDate against the booking watermark, and the
 * `> today` clamp stops a watermark that already covers today from naming
 * tomorrow's occurrence as an outage that started in the future.
 *
 * The contract regex-checks `lastPeriodKey` without proving it is a real
 * calendar day, and no read-path gate does either, so a document carrying
 * `2026-02-30` reaches this render. Drop that one row's notice rather than let a
 * RangeError take the whole Forecast page down.
 */
function outstandingDueDate(order: StandingOrder, today: string): string | null {
  let oldest: string | null;
  try {
    oldest = oldestUnbookedStandingOrderDueDate(order, order.lastPeriodKey);
  } catch {
    return null;
  }
  return oldest === null || oldest > today ? null : oldest;
}

function StatusBadge({
  paused,
  suspendedByArchive,
}: {
  paused: boolean;
  suspendedByArchive: boolean;
}) {
  const t = useT();
  return (
    <span
      className={cx(
        'inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset',
        paused || suspendedByArchive ? 'bt-badge' : 'bt-badge bt-badge--pos',
      )}
    >
      {suspendedByArchive
        ? t('forecast.standingOrders.status.suspendedByArchive')
        : paused
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
