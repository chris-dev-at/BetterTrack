/**
 * /workboard page (PROJECTPLAN.md §6.4). Three zones:
 *  1. Watchlist — drag-to-reorder, per-row remove, sparkline + live quote
 *  2. Alerts panel — placeholder (P5)
 *  3. My Conglomerates — placeholder (P3)
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkboardItem } from '@bettertrack/contracts';

import { getAssetHistory, getAssetQuote } from '../../lib/assetApi';
import { cx } from '../../lib/cx';
import { formatDate, formatSignedPercent } from '../../lib/format';
import { EARNINGS_CALENDAR_QUERY_KEY, getEarningsCalendar } from '../../lib/marketIntelApi';
import { useT } from '../../i18n';
import {
  WATCHLIST_SHARING_QUERY_KEY,
  WORKBOARD_QUERY_KEY,
  getWatchlistSharing,
  listWorkboard,
  removeFromWorkboard,
  reorderWorkboard,
  updateWatchlistSharing,
} from '../../lib/workboardApi';
import { EmptyState, MoneyText, Skeleton } from '../../ui';
import { Sparkline } from '../../ui/charts';
import { Alert, Button } from '../components/ui';

// ─── Watchlist row ────────────────────────────────────────────────────────────

interface WatchlistRowProps {
  item: WorkboardItem;
  isDragging: boolean;
  isDragOver: boolean;
  onDragStart: () => void;
  onDragOver: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
  onRemove: () => void;
  removeDisabled: boolean;
}

function WatchlistRow({
  item,
  isDragging,
  isDragOver,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onRemove,
  removeDisabled,
}: WatchlistRowProps) {
  const t = useT();
  const quoteQuery = useQuery({
    queryKey: ['asset', item.assetId, 'quote'],
    queryFn: ({ signal }) => getAssetQuote(item.assetId, signal),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

  const sparklineQuery = useQuery({
    queryKey: ['asset', item.assetId, 'history', '1M'],
    queryFn: ({ signal }) => getAssetHistory(item.assetId, '1M', signal),
    staleTime: 900_000,
  });

  const quote = quoteQuery.data?.quote;
  const sparkData = sparklineQuery.data?.points.map((p) => p.close) ?? [];
  const dayPct = quote?.dayChangePct;

  return (
    <tr
      draggable
      onDragStart={onDragStart}
      onDragOver={(e) => {
        e.preventDefault();
        onDragOver();
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      onDragEnd={onDragEnd}
      className={cx(
        'border-b border-neutral-800 last:border-b-0 transition-colors',
        isDragging && 'opacity-40',
        isDragOver && 'bg-sky-950/40',
      )}
    >
      {/* Drag handle */}
      <td
        className="w-5 cursor-grab select-none pl-2 pr-0 text-center text-neutral-600"
        aria-hidden="true"
      >
        ⠿
      </td>

      {/* Sparkline (1M) */}
      <td className="px-2 py-3">
        {sparklineQuery.isLoading ? (
          <Skeleton width="w-24" height="h-7" />
        ) : (
          <Sparkline
            data={sparkData}
            ariaLabel={t('workboard.overview.watchlist.sparklineAriaLabel', {
              symbol: item.asset.symbol,
            })}
          />
        )}
      </td>

      {/* Symbol + Name + optional note */}
      <td className="min-w-0 px-3 py-3">
        <Link
          to={`/assets/${item.assetId}`}
          className="block font-mono text-sm font-medium text-neutral-100 transition-colors hover:text-sky-400"
        >
          {item.asset.symbol}
        </Link>
        <p className="max-w-[12rem] truncate text-xs text-neutral-500" title={item.asset.name}>
          {item.asset.name}
        </p>
        {item.note ? <p className="mt-0.5 text-xs italic text-neutral-600">{item.note}</p> : null}
      </td>

      {/* Price */}
      <td className="px-3 py-3 text-right text-sm">
        {quoteQuery.isLoading ? (
          <Skeleton variant="line" width="w-20" className="ml-auto" />
        ) : quote ? (
          <MoneyText amount={quote.price} currency={quote.currency} unitPrice />
        ) : (
          <span className="text-neutral-600">—</span>
        )}
      </td>

      {/* Day ±% */}
      <td className="px-3 py-3 text-right text-sm tabular-nums">
        {quoteQuery.isLoading ? (
          <Skeleton variant="line" width="w-14" className="ml-auto" />
        ) : dayPct != null ? (
          <span
            className={
              dayPct > 0 ? 'text-emerald-400' : dayPct < 0 ? 'text-red-400' : 'text-neutral-400'
            }
          >
            {formatSignedPercent(dayPct)}
          </span>
        ) : (
          <span className="text-neutral-600">—</span>
        )}
      </td>

      {/* Alert count badge — alerts API arrives in P5 */}
      <td className="px-3 py-3 text-center">
        <span
          className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-neutral-800 px-1.5 text-xs text-neutral-500 ring-1 ring-neutral-700"
          title={t('workboard.overview.watchlist.alertsComingSoonTitle')}
        >
          —
        </span>
      </td>

      {/* Remove */}
      <td className="py-3 pr-2 text-right">
        <button
          type="button"
          onClick={onRemove}
          disabled={removeDisabled}
          aria-label={t('workboard.overview.watchlist.removeAriaLabel', {
            symbol: item.asset.symbol,
          })}
          className="rounded p-1 text-xs text-neutral-600 transition-colors hover:bg-neutral-800 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          ✕
        </button>
      </td>
    </tr>
  );
}

// ─── Watchlist friend-sharing toggle (§6.9, V2-P9) ───────────────────────────

/**
 * Whole-watchlist friend-sharing toggle (§6.9, V2-P9): mirrors the portfolio
 * private↔friends model. Sharing exposes a read-only copy of the watchlist to
 * the owner's friends via their Friends overview; revoking closes access immediately.
 */
function WatchlistSharingToggle() {
  const t = useT();
  const queryClient = useQueryClient();
  const [error, setError] = useState(false);
  const { data } = useQuery({
    queryKey: WATCHLIST_SHARING_QUERY_KEY,
    queryFn: ({ signal }) => getWatchlistSharing(signal),
    staleTime: 30_000,
  });
  const mutation = useMutation({
    mutationFn: (visibility: 'private' | 'friends') => updateWatchlistSharing(visibility),
    onSuccess: (res) => {
      setError(false);
      queryClient.setQueryData(WATCHLIST_SHARING_QUERY_KEY, res);
      void queryClient.invalidateQueries({ queryKey: ['social', 'my-shared'] });
    },
    onError: () => setError(true),
  });
  const shared = data?.visibility === 'friends';
  return (
    <div className="flex flex-col items-end gap-1.5">
      <Button
        variant="secondary"
        onClick={() => mutation.mutate(shared ? 'private' : 'friends')}
        disabled={mutation.isPending || data === undefined}
        aria-pressed={shared}
      >
        {shared
          ? t('workboard.overview.watchlist.sharedButton')
          : t('workboard.overview.watchlist.shareButton')}
      </Button>
      {error ? <Alert tone="error">{t('workboard.overview.watchlist.shareError')}</Alert> : null}
    </div>
  );
}

// ─── Zone 1: Watchlist ────────────────────────────────────────────────────────

function WatchlistZone() {
  const t = useT();
  const queryClient = useQueryClient();
  const [orderedItems, setOrderedItems] = useState<WorkboardItem[]>([]);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [reorderError, setReorderError] = useState<string | null>(null);

  // Always refetches on mount (§13.2) — landing on the watchlist right after an
  // icon-add elsewhere in the app must never require a manual reload.
  const { data, isLoading, isError } = useQuery({
    queryKey: WORKBOARD_QUERY_KEY,
    queryFn: ({ signal }) => listWorkboard(undefined, signal),
    staleTime: 30_000,
    refetchOnMount: 'always',
  });

  // Mirror server order; resets on every successful fetch (including post-remove refetch).
  useEffect(() => {
    if (data) setOrderedItems(data.items);
  }, [data]);

  const removeMutation = useMutation({
    mutationFn: (itemId: string) => removeFromWorkboard(itemId),
    onSuccess: () => {
      setRemoveError(null);
      void queryClient.invalidateQueries({ queryKey: WORKBOARD_QUERY_KEY });
    },
    onError: () => setRemoveError(t('workboard.overview.watchlist.removeError')),
  });

  const reorderMutation = useMutation({
    mutationFn: (itemIds: string[]) => reorderWorkboard(itemIds),
    onSuccess: () => {
      setReorderError(null);
      void queryClient.invalidateQueries({ queryKey: WORKBOARD_QUERY_KEY });
    },
    onError: () => {
      // Revert optimistic order to last known server state.
      if (data) setOrderedItems(data.items);
      setReorderError(t('workboard.overview.watchlist.reorderError'));
    },
  });

  const handleDragStart = (id: string) => {
    setDraggedId(id);
    setReorderError(null);
  };

  const handleDragOver = (id: string) => {
    setDragOverId(id);
  };

  const handleDrop = (targetId: string) => {
    const fromId = draggedId;
    setDraggedId(null);
    setDragOverId(null);

    if (!fromId || fromId === targetId) return;

    const fromIndex = orderedItems.findIndex((i) => i.id === fromId);
    const toIndex = orderedItems.findIndex((i) => i.id === targetId);
    if (fromIndex === -1 || toIndex === -1) return;

    const next = [...orderedItems];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved!);

    setOrderedItems(next);
    reorderMutation.mutate(next.map((i) => i.id));
  };

  const handleDragEnd = () => {
    setDraggedId(null);
    setDragOverId(null);
  };

  if (isLoading) {
    return (
      <section aria-labelledby="watchlist-heading" className="flex flex-col gap-4">
        <h2 id="watchlist-heading" className="text-lg font-semibold text-neutral-200">
          {t('workboard.overview.watchlist.heading')}
        </h2>
        <div className="flex flex-col gap-2">
          <Skeleton height="h-14" />
          <Skeleton height="h-14" />
          <Skeleton height="h-14" />
        </div>
      </section>
    );
  }

  if (isError) {
    return (
      <section aria-labelledby="watchlist-heading" className="flex flex-col gap-4">
        <h2 id="watchlist-heading" className="text-lg font-semibold text-neutral-200">
          {t('workboard.overview.watchlist.heading')}
        </h2>
        <Alert tone="error">{t('workboard.overview.watchlist.loadError')}</Alert>
      </section>
    );
  }

  return (
    <section aria-labelledby="watchlist-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="watchlist-heading" className="text-lg font-semibold text-neutral-200">
          {t('workboard.overview.watchlist.heading')}
        </h2>
        <WatchlistSharingToggle />
      </div>

      {removeError ? <Alert tone="error">{removeError}</Alert> : null}
      {reorderError ? <Alert tone="error">{reorderError}</Alert> : null}

      {orderedItems.length === 0 ? (
        <EmptyState
          icon="👁"
          title={t('workboard.overview.watchlist.emptyTitle')}
          description={t('workboard.overview.watchlist.emptyDescription')}
          cta={
            <Link
              to="/assets/search"
              className="rounded text-sm text-sky-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              {t('workboard.overview.watchlist.emptySearchLink')}
            </Link>
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-800">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-neutral-800 bg-neutral-900/60 text-xs uppercase tracking-wide text-neutral-500">
                <th scope="col" className="w-5 pl-2" aria-hidden="true" />
                <th scope="col" className="px-2 py-2">
                  {t('workboard.overview.watchlist.trendHeader')}
                </th>
                <th scope="col" className="px-3 py-2">
                  {t('workboard.overview.watchlist.assetHeader')}
                </th>
                <th scope="col" className="px-3 py-2 text-right">
                  {t('workboard.overview.watchlist.priceHeader')}
                </th>
                <th scope="col" className="px-3 py-2 text-right">
                  {t('workboard.overview.watchlist.dayHeader')}
                </th>
                <th scope="col" className="px-3 py-2 text-center">
                  {t('workboard.overview.watchlist.alertsHeader')}
                </th>
                <th
                  scope="col"
                  className="pr-2"
                  aria-label={t('workboard.overview.watchlist.actionsAriaLabel')}
                />
              </tr>
            </thead>
            <tbody>
              {orderedItems.map((item) => (
                <WatchlistRow
                  key={item.id}
                  item={item}
                  isDragging={draggedId === item.id}
                  isDragOver={dragOverId === item.id}
                  onDragStart={() => handleDragStart(item.id)}
                  onDragOver={() => handleDragOver(item.id)}
                  onDrop={() => handleDrop(item.id)}
                  onDragEnd={handleDragEnd}
                  onRemove={() => removeMutation.mutate(item.id)}
                  removeDisabled={removeMutation.isPending}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ─── Upcoming earnings panel (§13.5 V5-P5 arc b) ─────────────────────────────

/** How many rows show before the panel offers "show more" (anti-bloat: compact). */
const EARNINGS_PANEL_COLLAPSED = 5;

/**
 * Compact "Upcoming earnings" panel: the next earnings dates across the user's
 * held + watched assets, chronological, estimated vs confirmed flagged,
 * expandable past the first few. Entirely ABSENT when the calendar is
 * unavailable (gate off / no capability) or empty — never an empty shell.
 */
function UpcomingEarningsZone() {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const { data } = useQuery({
    queryKey: EARNINGS_CALENDAR_QUERY_KEY,
    queryFn: ({ signal }) => getEarningsCalendar(signal),
    staleTime: 15 * 60_000,
  });

  // Invisible when unconfigured or when nothing is coming up (anti-bloat rule).
  if (!data || !data.available || data.entries.length === 0) return null;

  const rows = expanded ? data.entries : data.entries.slice(0, EARNINGS_PANEL_COLLAPSED);
  const hiddenCount = data.entries.length - rows.length;

  return (
    <section aria-labelledby="earnings-heading" className="flex flex-col gap-4">
      <h2 id="earnings-heading" className="text-lg font-semibold text-neutral-200">
        {t('workboard.overview.earnings.heading')}
      </h2>
      <div className="overflow-hidden rounded-lg border border-neutral-800">
        <ul className="divide-y divide-neutral-800">
          {rows.map((e) => (
            <li key={`${e.assetId}-${e.date}`} className="flex items-center gap-3 px-4 py-2.5">
              <div className="flex min-w-0 flex-1 flex-col">
                <Link
                  to={`/assets/${e.assetId}`}
                  className="font-mono text-sm font-medium text-neutral-100 transition-colors hover:text-sky-400"
                >
                  {e.symbol}
                </Link>
                <span className="max-w-[14rem] truncate text-xs text-neutral-500" title={e.name}>
                  {e.name}
                </span>
              </div>
              <span
                className="inline-flex items-center rounded-full bg-neutral-800 px-2 py-0.5 text-[0.65rem] uppercase tracking-wide text-neutral-400 ring-1 ring-neutral-700"
                title={
                  e.held
                    ? t('workboard.overview.earnings.heldTitle')
                    : t('workboard.overview.earnings.watchedTitle')
                }
              >
                {e.held
                  ? t('workboard.overview.earnings.held')
                  : t('workboard.overview.earnings.watched')}
              </span>
              <span
                className={cx(
                  'inline-flex items-center rounded-full px-2 py-0.5 text-[0.65rem] font-medium uppercase tracking-wide ring-1',
                  e.estimated
                    ? 'bg-amber-950/40 text-amber-300 ring-amber-800/60'
                    : 'bg-emerald-950/40 text-emerald-300 ring-emerald-800/60',
                )}
              >
                {e.estimated
                  ? t('workboard.overview.earnings.estimated')
                  : t('workboard.overview.earnings.confirmed')}
              </span>
              <span className="w-24 shrink-0 text-right text-sm tabular-nums text-neutral-300">
                {formatDate(e.date)}
              </span>
            </li>
          ))}
        </ul>
        {hiddenCount > 0 || expanded ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="w-full border-t border-neutral-800 bg-neutral-900/60 py-2 text-xs font-medium text-sky-400 transition-colors hover:bg-neutral-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          >
            {expanded
              ? t('workboard.overview.earnings.showLess')
              : t('workboard.overview.earnings.showMore', { count: hiddenCount })}
          </button>
        ) : null}
      </div>
    </section>
  );
}

// ─── Zone 2: Alerts (placeholder) ────────────────────────────────────────────

function AlertsZone() {
  const t = useT();
  return (
    <section aria-labelledby="alerts-heading" className="flex flex-col gap-4">
      <h2 id="alerts-heading" className="text-lg font-semibold text-neutral-200">
        {t('workboard.overview.alerts.heading')}
      </h2>
      <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-6">
        <EmptyState
          icon="🔔"
          title={t('workboard.overview.alerts.emptyTitle')}
          description={t('workboard.overview.alerts.emptyDescription')}
        />
      </div>
    </section>
  );
}

// ─── Zone 3: My Conglomerates (placeholder) ───────────────────────────────────

function ConglomeratesZone() {
  const t = useT();
  return (
    <section aria-labelledby="conglomerates-heading" className="flex flex-col gap-4">
      <h2 id="conglomerates-heading" className="text-lg font-semibold text-neutral-200">
        {t('workboard.overview.conglomerates.heading')}
      </h2>
      <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-6">
        <EmptyState
          icon="📊"
          title={t('workboard.overview.conglomerates.emptyTitle')}
          description={t('workboard.overview.conglomerates.emptyDescription')}
        />
      </div>
    </section>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

/** Workboard page (PROJECTPLAN.md §6.4): watchlist zone now; alerts + conglomerates as placeholders. */
export function WorkboardPage() {
  const t = useT();
  return (
    <div className="flex flex-col gap-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">
          {t('workboard.overview.title')}
        </h1>
        <p className="mt-1 text-sm text-neutral-400">{t('workboard.overview.subtitle')}</p>
      </div>
      <WatchlistZone />
      <UpcomingEarningsZone />
      <AlertsZone />
      <ConglomeratesZone />
    </div>
  );
}
