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

import {
  getAssetQuotes,
  getAssetSparklines,
  workboardQuotesQueryKey,
  workboardSparklinesQueryKey,
} from '../../lib/assetApi';
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
import { Page, PageHead, SectionHead, Surface } from '../../ui/origin';
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
  onMoveUp: () => void;
  onMoveDown: () => void;
  moveUpDisabled: boolean;
  moveDownDisabled: boolean;
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
  onMoveUp,
  onMoveDown,
  moveUpDisabled,
  moveDownDisabled,
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
      <td
        className="bt-workboard-watchlist__drag w-5 cursor-grab select-none pl-2 pr-0 text-center bt-muted"
        aria-hidden="true"
      >
        ⠿
      </td>

      {/* Sparkline (1M) */}
      <td
        className="bt-workboard-watchlist__trend px-2 py-3"
        data-label={t('workboard.overview.watchlist.trendHeader')}
      >
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
      <td className="bt-workboard-watchlist__asset min-w-0 px-3 py-3">
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
      <td
        className="bt-workboard-watchlist__price px-3 py-3 text-right text-sm"
        data-label={t('workboard.overview.watchlist.priceHeader')}
      >
        {quoteLoading ? (
          <Skeleton variant="line" width="w-20" className="ml-auto" />
        ) : quote ? (
          <MoneyText amount={quote.price} currency={quote.currency} unitPrice />
        ) : (
          <span className="bt-muted">—</span>
        )}
      </td>

      {/* Day ±% */}
      <td
        className="bt-workboard-watchlist__change px-3 py-3 text-right text-sm tabular-nums"
        data-label={t('workboard.overview.watchlist.dayHeader')}
      >
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
      <td
        className="bt-workboard-watchlist__alerts px-3 py-3 text-center"
        data-label={t('workboard.overview.watchlist.alertsHeader')}
      >
        <span
          className="bt-badge inline-flex h-5 min-w-[1.25rem] items-center justify-center px-1.5 text-xs"
          title={t('workboard.overview.watchlist.alertsComingSoonTitle')}
        >
          —
        </span>
      </td>

      {/* Remove */}
      <td className="bt-workboard-watchlist__actions py-3 pr-2 text-right">
        <div
          aria-label={`${t('workboard.overview.watchlist.actionsAriaLabel')} · ${item.asset.symbol}`}
          className="bt-workboard-order-actions"
          role="group"
        >
          <button
            aria-label={`${item.asset.symbol} · ↑`}
            className="bt-workboard-order-btn"
            disabled={moveUpDisabled}
            onClick={onMoveUp}
            type="button"
          >
            ↑
          </button>
          <button
            aria-label={`${item.asset.symbol} · ↓`}
            className="bt-workboard-order-btn"
            disabled={moveDownDisabled}
            onClick={onMoveDown}
            type="button"
          >
            ↓
          </button>
          <button
            type="button"
            onClick={onRemove}
            disabled={removeDisabled}
            aria-label={t('workboard.overview.watchlist.removeAriaLabel', {
              symbol: item.asset.symbol,
            })}
            className="bt-workboard-order-btn is-remove"
          >
            ✕
          </button>
        </div>
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
    queryKey: workboardQuotesQueryKey(assetIds),
    queryFn: ({ signal }) => getAssetQuotes(assetIds, signal),
    enabled: assetIds.length > 0,
    staleTime: 60_000,
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });
  const sparklineQuery = useQuery({
    queryKey: workboardSparklinesQueryKey(assetIds),
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

  // A row the provider could not price comes back as a 200 with the id in
  // `failed`, so neither query is in an error state and the row would silently
  // render "—" forever (the sparkline read has a 15-minute stale window and no
  // poll). Report the partial outage once for the zone, with one retry that
  // re-runs only the reads that actually lost rows.
  const failedQuoteIds = quoteQuery.data?.failed ?? [];
  const failedSparklineIds = sparklineQuery.data?.failed ?? [];
  // An id that resolves to no *visible* row is in neither `quotes` nor `failed`:
  // the server keeps invisible ids absent so they stay indistinguishable from a
  // foreign custom asset (§10), which leaves the client to notice. Without this
  // the row an asset deletion stranded between the list read and the aggregate
  // read renders "—" with nothing to press. Skipped while `placeholderData`
  // still shows the previous id set's answer, which legitimately lacks a
  // just-added row.
  const unresolvedQuoteIds =
    quoteQuery.data && !quoteQuery.isPlaceholderData
      ? assetIds.filter((id) => !quotesByAssetId.has(id) && !failedQuoteIds.includes(id))
      : [];
  const unresolvedAssetCount = new Set([
    ...failedQuoteIds,
    ...failedSparklineIds,
    ...unresolvedQuoteIds,
  ]).size;
  const retryUnresolvedReads = () => {
    if (failedQuoteIds.length > 0 || unresolvedQuoteIds.length > 0) void quoteQuery.refetch();
    if (failedSparklineIds.length > 0) void sparklineQuery.refetch();
  };

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

  const handleMove = (itemId: string, offset: -1 | 1) => {
    if (reorderMutation.isPending) return;
    const fromIndex = orderedItems.findIndex((item) => item.id === itemId);
    const toIndex = fromIndex + offset;
    if (fromIndex < 0 || toIndex < 0 || toIndex >= orderedItems.length) return;
    const next = [...orderedItems];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved!);
    setOrderedItems(next);
    reorderMutation.mutate(next.map((item) => item.id));
  };

  const handleDragEnd = () => {
    setDraggedId(null);
    setDragOverId(null);
  };

  if (isLoading) {
    return (
      <section aria-label={t('workboard.overview.watchlist.heading')}>
        <SectionHead title={t('workboard.overview.watchlist.heading')} />
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
      <section aria-label={t('workboard.overview.watchlist.heading')}>
        <SectionHead title={t('workboard.overview.watchlist.heading')} />
        <Alert tone="error">{t('workboard.overview.watchlist.loadError')}</Alert>
      </section>
    );
  }

  return (
    <section aria-label={t('workboard.overview.watchlist.heading')}>
      <SectionHead
        actions={
          <NormalModeOnly>
            <WatchlistSharingControl />
          </NormalModeOnly>
        }
        title={t('workboard.overview.watchlist.heading')}
      />

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

      {unresolvedAssetCount > 0 ? (
        <Alert tone="error">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {t(
                `workboard.overview.watchlist.partialMarketError.${
                  unresolvedAssetCount === 1 ? 'one' : 'other'
                }`,
                { count: unresolvedAssetCount },
              )}
            </span>
            <Button variant="secondary" onClick={retryUnresolvedReads}>
              {t('common.retry')}
            </Button>
          </div>
        </Alert>
      ) : null}

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
        <Surface className="bt-workboard-watchlist-table">
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
              {orderedItems.map((item, index) => (
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
                  onMoveUp={() => handleMove(item.id, -1)}
                  onMoveDown={() => handleMove(item.id, 1)}
                  moveUpDisabled={index === 0 || reorderMutation.isPending}
                  moveDownDisabled={index === orderedItems.length - 1 || reorderMutation.isPending}
                  onRemove={() => removeMutation.mutate(item.id)}
                  removeDisabled={removeMutation.isPending}
                />
              ))}
            </tbody>
          </table>
        </Surface>
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
    <section aria-label={t('workboard.overview.earnings.heading')}>
      <SectionHead title={t('workboard.overview.earnings.heading')} />
      <Surface>
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
      </Surface>
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
    <section aria-label={t('workboard.overview.alerts.heading')}>
      <SectionHead title={t('workboard.overview.alerts.heading')} />
      <Surface className="bt-workboard-signpost">
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
      </Surface>
    </section>
  );
}

// ─── Zone 3: My Blueprints (same stub-vs-shipped split as AlertsZone) ─────────

function ConglomeratesZone() {
  const t = useT();
  return (
    <section aria-label={t('workboard.overview.conglomerates.heading')}>
      <SectionHead title={t('workboard.overview.conglomerates.heading')} />
      <Surface className="bt-workboard-signpost">
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
      </Surface>
    </section>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

/** Workboard page (PROJECTPLAN.md §6.4): watchlist zone now; alerts + conglomerates as placeholders. */
export function WorkboardPage() {
  const t = useT();
  return (
    <Page className="bt-phone-surface bt-workboard-family bt-workboard-page" width="wide">
      <PageHead sub={t('workboard.overview.subtitle')} title={t('workboard.overview.title')} />
      <WatchlistZone />
      <UpcomingEarningsZone />
      <div className="bt-workboard-glance">
        <AlertsZone />
        <ConglomeratesZone />
      </div>
    </Page>
  );
}
