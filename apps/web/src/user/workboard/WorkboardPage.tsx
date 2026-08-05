/**
 * /workboard page (PROJECTPLAN.md §6.4). Three zones:
 *  1. Watchlist — drag-to-reorder, per-row remove, sparkline + live quote
 *  2. Alerts panel — placeholder (P5)
 *  3. My Conglomerates — placeholder (P3)
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AssetBatchQuote, AssetSparkline, WorkboardItem } from '@bettertrack/contracts';

import { getAssetQuotes, getAssetSparklines } from '../../lib/assetApi';
import { cx } from '../../lib/cx';
import { formatDate, formatSignedPercent } from '../../lib/format';
import { EARNINGS_CALENDAR_QUERY_KEY, getEarningsCalendar } from '../../lib/marketIntelApi';
import { useT } from '../../i18n';
import {
  WATCHLISTS_QUERY_KEY,
  WORKBOARD_QUERY_KEY,
  listWatchlists,
  listWorkboard,
  removeFromWorkboard,
  reorderWorkboard,
} from '../../lib/workboardApi';
import { EmptyState, MarketStateBadge, MoneyText, Skeleton } from '../../ui';
import { Sparkline } from '../../ui/charts';
import { Alert, Button } from '../components/ui';
import { AsyncReadState } from '../components/AsyncReadState';
import { AudiencePicker } from '../components/AudiencePicker';
import { useMutationFeedback } from '../hooks/useMutationFeedback';
import { NormalModeOnly } from '../vault/ui/ParanoidSurfaceGate';

// ─── Watchlist row ────────────────────────────────────────────────────────────

interface WatchlistRowProps {
  item: WorkboardItem;
  quoteResult: AssetBatchQuote | undefined;
  sparkline: AssetSparkline | undefined;
  quoteLoading: boolean;
  sparklineLoading: boolean;
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
  quoteResult,
  sparkline,
  quoteLoading,
  sparklineLoading,
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
  const quote = quoteResult?.quote;
  const sparkData = sparkline?.points.map((point) => point.close) ?? [];
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
        'bt-b-rule last:border-b-0 transition-colors',
        isDragging && 'opacity-40',
        isDragOver && '',
      )}
    >
      {/* Drag handle */}
      <td className="w-5 cursor-grab select-none pl-2 pr-0 text-center bt-muted" aria-hidden="true">
        ⠿
      </td>

      {/* Sparkline (1M) */}
      <td className="px-2 py-3">
        {sparklineLoading ? (
          <Skeleton width="w-24" height="h-7" />
        ) : sparkline ? (
          <Sparkline
            data={sparkData}
            ariaLabel={t('workboard.overview.watchlist.sparklineAriaLabel', {
              symbol: item.asset.symbol,
            })}
          />
        ) : null}
      </td>

      {/* Symbol + Name + optional note */}
      <td className="min-w-0 px-3 py-3">
        <div className="flex items-center gap-2">
          <Link
            to={`/assets/${item.assetId}`}
            className="font-mono text-sm font-medium transition-colors"
          >
            {item.asset.symbol}
          </Link>
          {/* Exchange session badge (§13.5 V5-P1) — only where the quote resolved. */}
          <MarketStateBadge state={quote?.marketState} />
        </div>
        <p className="max-w-[12rem] truncate text-xs bt-muted" title={item.asset.name}>
          {item.asset.name}
        </p>
        {item.note ? <p className="mt-0.5 text-xs italic bt-muted">{item.note}</p> : null}
      </td>

      {/* Price */}
      <td className="px-3 py-3 text-right text-sm">
        {quoteLoading ? (
          <Skeleton variant="line" width="w-20" className="ml-auto" />
        ) : quote ? (
          <MoneyText amount={quote.price} currency={quote.currency} unitPrice />
        ) : (
          <span className="bt-muted">—</span>
        )}
      </td>

      {/* Day ±% */}
      <td className="px-3 py-3 text-right text-sm tabular-nums">
        {quoteLoading ? (
          <Skeleton variant="line" width="w-14" className="ml-auto" />
        ) : dayPct != null ? (
          <span className={dayPct > 0 ? 'bt-pos' : dayPct < 0 ? 'bt-neg' : 'bt-muted'}>
            {formatSignedPercent(dayPct)}
          </span>
        ) : (
          <span className="bt-muted">—</span>
        )}
      </td>

      {/* Alert count badge — alerts API arrives in P5 */}
      <td className="px-3 py-3 text-center">
        <span
          className="bt-badge inline-flex h-5 min-w-[1.25rem] items-center justify-center px-1.5 text-xs"
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
          className="rounded p-1 text-xs bt-muted transition-colors hover:bt-neg disabled:cursor-not-allowed disabled:opacity-40"
        >
          ✕
        </button>
      </td>
    </tr>
  );
}

// ─── Watchlist audience control (§6.9, V3-P5) ────────────────────────────────

/**
 * Opens the same authoritative audience picker used by My items. In particular,
 * this must never route through the legacy private↔friends endpoint: that path
 * can overwrite a specific-friends, group, or public-link audience.
 */
function WatchlistSharingControl() {
  const t = useT();
  const queryClient = useQueryClient();
  const [sharingOpen, setSharingOpen] = useState(false);
  const query = useQuery({
    queryKey: WATCHLISTS_QUERY_KEY,
    queryFn: ({ signal }) => listWatchlists(signal),
    staleTime: 30_000,
  });
  const watchlist = query.data?.watchlists.find((item) => item.isDefault);
  // Any non-private audience is a live share (specific friends, a group, or an
  // active public link) and must read as shared — narrowing this to all_friends
  // would tell a user with a public link that the list is not shared.
  const shared = watchlist !== undefined && watchlist.audience !== 'private';
  return (
    <div className="flex flex-col items-end gap-1.5">
      <AsyncReadState
        loading={query.isLoading}
        error={query.error}
        onRetry={() => void query.refetch()}
      />
      <Button
        variant="secondary"
        onClick={() => setSharingOpen(true)}
        disabled={watchlist === undefined}
        aria-haspopup="dialog"
      >
        {shared
          ? t('workboard.overview.watchlist.sharedButton')
          : t('workboard.overview.watchlist.shareButton')}
      </Button>
      {sharingOpen && watchlist ? (
        <AudiencePicker
          kind="watchlist"
          subjectId={watchlist.id}
          subjectLabel={watchlist.name}
          onClose={() => setSharingOpen(false)}
          onChanged={() => void queryClient.invalidateQueries({ queryKey: WATCHLISTS_QUERY_KEY })}
        />
      ) : null}
    </div>
  );
}

// ─── Zone 1: Watchlist ────────────────────────────────────────────────────────

function WatchlistZone() {
  const t = useT();
  const queryClient = useQueryClient();
  const feedback = useMutationFeedback();
  const [orderedItems, setOrderedItems] = useState<WorkboardItem[]>([]);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  // Always refetches on mount (§13.2) — landing on the watchlist right after an
  // icon-add elsewhere in the app must never require a manual reload.
  const { data, isLoading, isError } = useQuery({
    queryKey: WORKBOARD_QUERY_KEY,
    queryFn: ({ signal }) => listWorkboard(undefined, signal),
    staleTime: 30_000,
    refetchOnMount: 'always',
  });

  // Aggregate market reads: ordering is canonical so a drag-only reorder keeps
  // the same cache entry. One quote observer owns the single 60-second poll.
  const assetIds = useMemo(
    () => [...new Set(orderedItems.map((item) => item.assetId))].sort(),
    [orderedItems],
  );
  // `placeholderData` matters because the id set is part of the key: adding or
  // removing one row mints a new entry, and without it every surviving row
  // would drop back to a skeleton and re-render from scratch.
  const quoteQuery = useQuery({
    queryKey: ['assets', 'workboard', 'quotes', assetIds] as const,
    queryFn: ({ signal }) => getAssetQuotes(assetIds, signal),
    enabled: assetIds.length > 0,
    staleTime: 60_000,
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });
  const sparklineQuery = useQuery({
    queryKey: ['assets', 'workboard', 'sparklines', assetIds] as const,
    queryFn: ({ signal }) => getAssetSparklines(assetIds, signal),
    enabled: assetIds.length > 0,
    staleTime: 900_000,
    placeholderData: keepPreviousData,
  });
  const quotesByAssetId = useMemo(
    () => new Map(quoteQuery.data?.quotes.map((quote) => [quote.assetId, quote]) ?? []),
    [quoteQuery.data],
  );
  const sparklinesByAssetId = useMemo(
    () =>
      new Map(
        sparklineQuery.data?.sparklines.map((sparkline) => [sparkline.assetId, sparkline]) ?? [],
      ),
    [sparklineQuery.data],
  );

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
      void queryClient.invalidateQueries({ queryKey: WORKBOARD_QUERY_KEY });
      feedback.success(t('mutationFeedback.watchlistReordered'));
    },
    onError: (error) => {
      // Revert optimistic order to last known server state.
      if (data) setOrderedItems(data.items);
      feedback.error(t('workboard.overview.watchlist.reorderError'), error);
    },
  });

  const handleDragStart = (id: string) => {
    setDraggedId(id);
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
        <h2 id="watchlist-heading" className="text-lg font-semibold bt-soft">
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
        <h2 id="watchlist-heading" className="text-lg font-semibold bt-soft">
          {t('workboard.overview.watchlist.heading')}
        </h2>
        <Alert tone="error">{t('workboard.overview.watchlist.loadError')}</Alert>
      </section>
    );
  }

  return (
    <section aria-labelledby="watchlist-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="watchlist-heading" className="text-lg font-semibold bt-soft">
          {t('workboard.overview.watchlist.heading')}
        </h2>
        <NormalModeOnly>
          <WatchlistSharingControl />
        </NormalModeOnly>
      </div>

      {removeError ? <Alert tone="error">{removeError}</Alert> : null}

      {/* One shared market read per zone => one state and one retry, not N
          identical buttons stamped into every row. */}
      <AsyncReadState
        loading={false}
        reads={[
          { error: quoteQuery.error, refetch: () => void quoteQuery.refetch() },
          { error: sparklineQuery.error, refetch: () => void sparklineQuery.refetch() },
        ]}
      />

      {orderedItems.length === 0 ? (
        <EmptyState
          icon="👁"
          title={t('workboard.overview.watchlist.emptyTitle')}
          description={t('workboard.overview.watchlist.emptyDescription')}
          cta={
            <Link to="/assets/search" className="rounded text-sm bt-link">
              {t('workboard.overview.watchlist.emptySearchLink')}
            </Link>
          }
        />
      ) : (
        <div className="overflow-x-auto bt-panel">
          <table className="w-full text-left">
            <thead>
              <tr className="bt-b-rule bt-label">
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
                  quoteResult={quotesByAssetId.get(item.assetId)}
                  sparkline={sparklinesByAssetId.get(item.assetId)}
                  quoteLoading={quoteQuery.isLoading}
                  sparklineLoading={sparklineQuery.isLoading}
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
      <h2 id="earnings-heading" className="text-lg font-semibold bt-soft">
        {t('workboard.overview.earnings.heading')}
      </h2>
      <div className="overflow-hidden bt-panel">
        <ul className="bt-band">
          {rows.map((e) => (
            <li key={`${e.assetId}-${e.date}`} className="flex items-center gap-3 px-4 py-2.5">
              <div className="flex min-w-0 flex-1 flex-col">
                <Link
                  to={`/assets/${e.assetId}`}
                  className="font-mono text-sm font-medium transition-colors"
                >
                  {e.symbol}
                </Link>
                <span className="max-w-[14rem] truncate text-xs bt-muted" title={e.name}>
                  {e.name}
                </span>
              </div>
              <span
                className="bt-badge inline-flex items-center px-2 py-0.5 text-[0.65rem] uppercase tracking-wide"
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
                  e.estimated ? 'bt-badge bt-badge--gold' : 'bt-badge bt-badge--pos',
                )}
              >
                {e.estimated
                  ? t('workboard.overview.earnings.estimated')
                  : t('workboard.overview.earnings.confirmed')}
              </span>
              <span className="w-24 shrink-0 text-right text-sm tabular-nums bt-soft">
                {formatDate(e.date)}
              </span>
            </li>
          ))}
        </ul>
        {hiddenCount > 0 || expanded ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="w-full bt-t-rule py-2 text-xs font-medium bt-link transition-colors"
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

// ─── Zone 2: Alerts (summary panel not built yet — signposts the real tab) ────

/**
 * The overview's alerts panel is still a stub, but ALERTS THEMSELVES SHIP —
 * `/workbench/alerts` is a full CRUD page one tab away. The copy therefore says
 * that the *panel* is unbuilt and points at the feature, instead of the old
 * "Alerts panel coming soon", which told a user holding twelve live alerts that
 * the feature did not exist yet.
 */
function AlertsZone() {
  const t = useT();
  return (
    <section aria-labelledby="alerts-heading" className="flex flex-col gap-4">
      <h2 id="alerts-heading" className="text-lg font-semibold bt-soft">
        {t('workboard.overview.alerts.heading')}
      </h2>
      <div className="bt-panel p-6">
        <EmptyState
          icon="🔔"
          title={t('workboard.overview.alerts.emptyTitle')}
          description={t('workboard.overview.alerts.emptyDescription')}
          cta={
            <Link to="/workbench/alerts" className="rounded text-sm bt-link">
              {t('workboard.overview.alerts.emptyCta')}
            </Link>
          }
        />
      </div>
    </section>
  );
}

// ─── Zone 3: My Blueprints (same stub-vs-shipped split as AlertsZone) ─────────

function ConglomeratesZone() {
  const t = useT();
  return (
    <section aria-labelledby="conglomerates-heading" className="flex flex-col gap-4">
      <h2 id="conglomerates-heading" className="text-lg font-semibold bt-soft">
        {t('workboard.overview.conglomerates.heading')}
      </h2>
      <div className="bt-panel p-6">
        <EmptyState
          icon="📊"
          title={t('workboard.overview.conglomerates.emptyTitle')}
          description={t('workboard.overview.conglomerates.emptyDescription')}
          cta={
            <Link to="/workbench/blueprints" className="rounded text-sm bt-link">
              {t('workboard.overview.conglomerates.emptyCta')}
            </Link>
          }
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
        <h1 className="text-2xl font-semibold tracking-tight">{t('workboard.overview.title')}</h1>
        <p className="mt-1 text-sm bt-muted">{t('workboard.overview.subtitle')}</p>
      </div>
      <WatchlistZone />
      <UpcomingEarningsZone />
      <AlertsZone />
      <ConglomeratesZone />
    </div>
  );
}
