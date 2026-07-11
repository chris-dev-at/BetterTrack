import { useQuery } from '@tanstack/react-query';
import type { Time } from 'lightweight-charts';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import {
  DEFAULT_LIVE_RATE,
  LIVE_RATES,
  LIVE_WINDOWS,
  LIVE_WINDOW_MS,
  type Alert as AlertType,
  type AssetDetailResponse,
  type HistoryInterval,
  type HistoryRange,
  type LiveRate,
  type LiveWindow,
  type PricePoint,
  type QuoteResponse,
  type RealtimeLiveFrame,
} from '@bettertrack/contracts';
import { useT } from '../../i18n';
import { getAssetDetail, getAssetHistory, getAssetQuote } from '../../lib/assetApi';
import { ALERTS_QUERY_KEY, listAlerts } from '../../lib/alertsApi';
import { useLiveFrames } from '../../lib/realtime';
import {
  WATCHLISTS_QUERY_KEY,
  listWatchlists,
  useAddToWatchlist,
  useWatchlistMembership,
} from '../../lib/workboardApi';
import { cx } from '../../lib/cx';
import { formatDateTime, formatSignedPercent } from '../../lib/format';
import { Disclaimer, EmptyState, MoneyText, Skeleton, StatCard } from '../../ui';
import { PriceChart } from '../../ui/charts';
import type { ChartPoint, PriceRange } from '../../ui/charts';
import { AlertDialog, type AlertDialogAsset } from '../components/AlertDialog';
import { AlertList } from '../components/AlertList';
import { Alert, Button } from '../components/ui';

// ─── Range mapping ────────────────────────────────────────────────────────────

/** Chart's `PriceRange` tokens use 'Max'; the API contract uses 'MAX'. */
function toHistoryRange(r: PriceRange): HistoryRange {
  return r === 'Max' ? 'MAX' : r;
}

/** §5.3 cache TTLs mirrored client-side so TanStack Query stays polite. */
const HISTORY_STALE_MS: Record<HistoryRange, number> = {
  '1D': 60_000,
  '1W': 300_000,
  '1M': 900_000,
  '3M': 3_600_000,
  '6M': 3_600_000,
  '1Y': 3_600_000,
  '5Y': 21_600_000,
  MAX: 21_600_000,
};

// ─── Chart point conversion ───────────────────────────────────────────────────

/**
 * Maps API `PricePoint[]` (ISO-8601 `time`, native `close`) to lightweight-charts
 * `ChartPoint[]` (`Time` + `value`). Intraday intervals use Unix-second timestamps;
 * daily/weekly/monthly use ISO date strings (`YYYY-MM-DD`).
 */
function toChartPoints(points: PricePoint[], interval: HistoryInterval | undefined): ChartPoint[] {
  const isIntraday = interval === '1m' || interval === '15m' || interval === '30m';
  return points.map((p) => ({
    time: (isIntraday
      ? Math.floor(new Date(p.time).getTime() / 1000)
      : p.time.slice(0, 10)) as Time,
    value: p.close,
  }));
}

/**
 * Live frames → chart points (§6.3, V3-P7b). Live times are Unix seconds;
 * frames landing within the same second keep the newest value (lightweight-
 * charts requires strictly ascending unique times).
 */
function toLiveChartPoints(frames: RealtimeLiveFrame[]): ChartPoint[] {
  const bySecond = new Map<number, number>();
  for (const frame of frames) {
    bySecond.set(Math.floor(Date.parse(frame.at) / 1000), frame.price);
  }
  return [...bySecond.entries()].map(([time, value]) => ({ time: time as Time, value }));
}

/** Trim a frame list to the selected live window, anchored at the newest frame. */
function trimToWindow(frames: RealtimeLiveFrame[], window: LiveWindow): RealtimeLiveFrame[] {
  const last = frames[frames.length - 1];
  if (!last) return frames;
  const cutoff = Date.parse(last.at) - LIVE_WINDOW_MS[window];
  return frames.filter((frame) => Date.parse(frame.at) >= cutoff);
}

// ─── Header ───────────────────────────────────────────────────────────────────

function AssetHeader({
  detail,
  liveQuote,
}: {
  detail: AssetDetailResponse;
  liveQuote: QuoteResponse | undefined;
}) {
  const { asset } = detail;
  // Prefer the most recent quote: live-poll result first, then initial detail.
  const quote = liveQuote?.quote ?? detail.quote;
  const stale = liveQuote?.stale ?? detail.stale;
  const asOf = liveQuote?.asOf ?? detail.asOf;

  const dayChangePct = quote?.dayChangePct;
  const isUp = dayChangePct != null && dayChangePct > 0;
  const isDown = dayChangePct != null && dayChangePct < 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">{asset.name}</h1>
          <p className="mt-0.5 text-sm text-neutral-400">
            <span className="font-mono text-neutral-300">{asset.symbol}</span>
            {asset.exchange ? (
              <>
                <span className="mx-1.5 text-neutral-600">·</span>
                {asset.exchange}
              </>
            ) : null}
            <span className="mx-1.5 text-neutral-600">·</span>
            <span className="capitalize">{asset.type}</span>
          </p>
        </div>

        {quote ? (
          <div className="text-right">
            <p className="text-3xl font-semibold tabular-nums text-neutral-100">
              <MoneyText
                amount={quote.price}
                currency={quote.currency}
                convertedAmount={detail.eurPrice}
                unitPrice
              />
            </p>
            {dayChangePct != null ? (
              <p
                className={
                  isUp
                    ? 'text-sm tabular-nums text-emerald-400'
                    : isDown
                      ? 'text-sm tabular-nums text-red-400'
                      : 'text-sm tabular-nums text-neutral-400'
                }
              >
                {formatSignedPercent(dayChangePct)}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="text-right">
            <Skeleton height="h-9" width="w-32" />
            <Skeleton height="h-4" width="w-20" className="mt-1" />
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
        {stale ? (
          <span className="rounded bg-amber-900/40 px-1.5 py-0.5 text-amber-400 ring-1 ring-amber-800">
            Stale
          </span>
        ) : null}
        {asOf ? <span>As of {formatDateTime(asOf)}</span> : null}
        <span>Data may be delayed.</span>
      </div>
    </div>
  );
}

// ─── Stats row ────────────────────────────────────────────────────────────────

function StatsRow({
  detail,
  liveQuote,
}: {
  detail: AssetDetailResponse;
  liveQuote: QuoteResponse | undefined;
}) {
  const quote = liveQuote?.quote ?? detail.quote;
  if (!quote) return null;

  const { prevClose, currency } = quote;
  if (prevClose == null) return null;

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatCard label="Prev Close" value={<MoneyText amount={prevClose} currency={currency} />} />
    </div>
  );
}

// ─── Section shells ───────────────────────────────────────────────────────────

/**
 * Inline price-alerts widget on the asset page (PROJECTPLAN.md §14, V3-P10 arc
 * b). Creating prefills the current asset and passes the live quote as
 * reference context; the list is this asset's slice of the shared alerts query,
 * with the same edit / delete / re-arm actions as the Workboard panel.
 */
function AlertsSection({
  asset,
  referencePrice,
}: {
  asset: AlertDialogAsset;
  referencePrice: number | null;
}) {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AlertType | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ALERTS_QUERY_KEY,
    queryFn: ({ signal }) => listAlerts(signal),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const alerts = (data?.items ?? []).filter((a) => a.asset.id === asset.id);

  return (
    <section aria-labelledby="alerts-heading" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id="alerts-heading" className="text-base font-semibold text-neutral-200">
          Your alerts on this asset
        </h2>
        <Button variant="secondary" onClick={() => setCreating(true)}>
          + New alert
        </Button>
      </div>

      {isLoading ? (
        <Skeleton height="h-24" />
      ) : isError ? (
        <Alert tone="error">Could not load your alerts. Please try again.</Alert>
      ) : alerts.length === 0 ? (
        <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
          <EmptyState
            icon="🔔"
            title="No alerts on this asset yet"
            description="Create an alert to get notified when it crosses a price or moves by a percentage."
          />
        </div>
      ) : (
        <AlertList alerts={alerts} showAsset={false} onEdit={setEditing} />
      )}

      {creating ? (
        <AlertDialog
          asset={asset}
          referencePrice={referencePrice}
          onClose={() => setCreating(false)}
        />
      ) : null}
      {editing ? <AlertDialog existing={editing} onClose={() => setEditing(null)} /> : null}
    </section>
  );
}

function AppearsInSection() {
  return (
    <section aria-labelledby="appears-in-heading" className="flex flex-col gap-3">
      <h2 id="appears-in-heading" className="text-base font-semibold text-neutral-200">
        Appears in
      </h2>
      <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
        <EmptyState
          icon="📂"
          title="Not in any conglomerate or portfolio"
          description="Add this asset to a conglomerate or record a transaction to see it here."
        />
      </div>
    </section>
  );
}

// ─── Actions ─────────────────────────────────────────────────────────────────

/** Closes a popover on Escape or on a mousedown outside `containerRef`. */
function usePopoverDismiss(
  open: boolean,
  onClose: () => void,
  containerRef: React.RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('keydown', handleKey);
    document.addEventListener('mousedown', handleClick);
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.removeEventListener('mousedown', handleClick);
    };
  }, [open, onClose, containerRef]);
}

/** Filled/outline bookmark, mirroring the search-results watchlist icon (#256). */
function BookmarkIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 4h12v16l-6-4-6 4V4Z" />
    </svg>
  );
}

/**
 * Small, state-aware watchlist icon button (§13.2): filled once the asset is
 * on the watchlist, acts in place with no redirect, and a re-click never
 * surfaces an error (`useAddToWatchlist` swallows `ALREADY_WATCHING`). The
 * caret is the multiple-watchlists-ready affordance (one-click add to
 * General + a specific-list picker stub, mirroring #256's search rows).
 */
function WatchlistIconButton({ assetId, symbol }: { assetId: string; symbol: string }) {
  const { watchedIds } = useWatchlistMembership();
  const addMutation = useAddToWatchlist();
  const [listPickerOpen, setListPickerOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  usePopoverDismiss(listPickerOpen, () => setListPickerOpen(false), containerRef);

  // The caller's named lists — fetched only when the list picker opens (V3-P5).
  const listsQuery = useQuery({
    queryKey: WATCHLISTS_QUERY_KEY,
    queryFn: ({ signal }) => listWatchlists(signal),
    enabled: listPickerOpen,
    staleTime: 30_000,
  });

  const watched = watchedIds.has(assetId) || addMutation.isSuccess;

  function handleAdd(watchlistId?: string) {
    if (addMutation.isPending) return;
    addMutation.mutate({ assetId, watchlistId });
  }

  return (
    <div className="relative flex flex-col items-end gap-1">
      <div className="flex items-center rounded-md ring-1 ring-neutral-700" ref={containerRef}>
        <button
          type="button"
          onClick={() => {
            if (!watched) handleAdd();
          }}
          disabled={addMutation.isPending}
          aria-pressed={watched}
          aria-label={
            watched
              ? `${symbol} is on your watchlist`
              : addMutation.isError
                ? `Retry adding ${symbol} to your watchlist`
                : `Add ${symbol} to watchlist`
          }
          title={watched ? 'On your watchlist' : 'Add to watchlist'}
          className={cx(
            'rounded-l-md p-2 transition-colors',
            watched
              ? 'text-sky-400'
              : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100',
            addMutation.isError && 'text-red-400',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
            'disabled:cursor-not-allowed disabled:opacity-60',
          )}
        >
          <BookmarkIcon filled={watched} />
        </button>

        <button
          type="button"
          onClick={() => setListPickerOpen((o) => !o)}
          aria-label={`Choose a watchlist for ${symbol}`}
          aria-haspopup="menu"
          aria-expanded={listPickerOpen}
          className="rounded-r-md border-l border-neutral-700 p-1.5 text-xs text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          ▾
        </button>
      </div>

      {listPickerOpen ? (
        <div
          role="menu"
          aria-label={`Watchlists for ${symbol}`}
          className="absolute right-0 top-full z-10 mt-1 w-48 rounded-md border border-neutral-700 bg-neutral-900 p-2 text-xs shadow-xl"
        >
          {(listsQuery.data?.watchlists ?? []).map((list) => (
            <button
              key={list.id}
              type="button"
              role="menuitem"
              onClick={() => {
                handleAdd(list.isDefault ? undefined : list.id);
                setListPickerOpen(false);
              }}
              className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-neutral-200 hover:bg-neutral-800"
            >
              {list.name}
            </button>
          ))}
          {listsQuery.isLoading ? <p className="px-2 py-1.5 text-neutral-600">…</p> : null}
        </div>
      ) : null}

      {addMutation.isError ? (
        <Alert tone="error">Failed to add to Watchlist. Please try again.</Alert>
      ) : null}
    </div>
  );
}

// ─── Live Mode (§6.3, V3-P7b) ────────────────────────────────────────────────

/**
 * The chart's LIVE controls: the toggle plus, while live, the six short window
 * tokens and the refresh-rate tokens (#372, down to 1 s). Window and rate
 * switches only re-backfill / re-register this viewer's rate; the shared
 * upstream poll loop never restarts and never polls faster than the fastest
 * active viewer needs (§5.3).
 */
function LiveControls({
  live,
  window,
  rate,
  onToggle,
  onWindowChange,
  onRateChange,
}: {
  live: boolean;
  window: LiveWindow;
  rate: LiveRate;
  onToggle: () => void;
  onWindowChange: (window: LiveWindow) => void;
  onRateChange: (rate: LiveRate) => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        aria-pressed={live}
        aria-label={t('assets.live.toggleLabel')}
        onClick={onToggle}
        className={cx(
          'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold transition-colors',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
          live
            ? 'bg-red-600/20 text-red-400 ring-1 ring-inset ring-red-700'
            : 'text-neutral-400 ring-1 ring-inset ring-neutral-700 hover:bg-neutral-800 hover:text-neutral-100',
        )}
      >
        <span
          aria-hidden="true"
          className={cx(
            'h-1.5 w-1.5 rounded-full',
            live ? 'animate-pulse bg-red-400' : 'bg-neutral-600',
          )}
        />
        {t('assets.live.badge')}
      </button>

      {live ? (
        <>
          <div
            role="group"
            aria-label={t('assets.live.windowGroupLabel')}
            className="inline-flex gap-0.5 rounded-md bg-neutral-900 p-0.5 ring-1 ring-inset ring-neutral-800"
          >
            {LIVE_WINDOWS.map((token) => {
              const selected = token === window;
              return (
                <button
                  key={token}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onWindowChange(token)}
                  className={cx(
                    'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
                    selected
                      ? 'bg-sky-600 text-white'
                      : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100',
                  )}
                >
                  {token}
                </button>
              );
            })}
          </div>
          <div
            role="group"
            aria-label={t('assets.live.rateGroupLabel')}
            title={t('assets.live.rateGroupHint')}
            className="inline-flex gap-0.5 rounded-md bg-neutral-900 p-0.5 ring-1 ring-inset ring-neutral-800"
          >
            {LIVE_RATES.map((token) => {
              const selected = token === rate;
              return (
                <button
                  key={token}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onRateChange(token)}
                  className={cx(
                    'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
                    selected
                      ? 'bg-emerald-700 text-white'
                      : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100',
                  )}
                >
                  {token}
                </button>
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * Poll-fallback frame accumulator: when Live Mode is on but the stream is
 * unavailable (flag off, gateway down, reconnecting), the already-running 60 s
 * cache-served quote poll feeds the live chart instead — the §6.3 "light
 * preview", with zero user-visible errors. Cleared while streaming so the two
 * sources never mix.
 */
function usePollFallbackFrames(
  assetId: string,
  quote: QuoteResponse | undefined,
  active: boolean,
): RealtimeLiveFrame[] {
  const [frames, setFrames] = useState<RealtimeLiveFrame[]>([]);
  useEffect(() => {
    if (!active) {
      setFrames([]);
      return;
    }
    if (!quote?.quote || !quote.asOf) return;
    const { price, currency, dayChangePct } = quote.quote;
    const at = quote.asOf;
    setFrames((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.at >= at) return prev;
      return [...prev, { assetId, price, currency, dayChangePct: dayChangePct ?? null, at }];
    });
  }, [active, assetId, quote]);
  return frames;
}

/** Quick actions (§6.3): reachable near the top, right under the header. */
function ActionBar({ assetId, symbol }: { assetId: string; symbol: string }) {
  return (
    <section aria-labelledby="actions-heading" className="flex flex-col gap-3">
      <h2 id="actions-heading" className="sr-only">
        Quick actions
      </h2>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" disabled title="Coming soon">
            + Portfolio
          </Button>
          <Button variant="secondary" disabled title="Coming soon">
            + Conglomerate
          </Button>
        </div>
        <WatchlistIconButton assetId={assetId} symbol={symbol} />
      </div>
    </section>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

/**
 * Asset detail page (PROJECTPLAN.md §6.3). Fetches meta + quote via
 * `/assets/:id`, polls the quote every 60 s for a live-ish price, and
 * fetches chart history per selected range.
 *
 * Live Mode (V3-P7b): the LIVE toggle switches the chart to short real-time
 * windows fed by the gateway's shared per-asset poll stream (`live.watch` →
 * ring-buffer backfill → `live.frame`). The 60 s polled quote stays the
 * degradation path — gateway down or flag off just means slower frames, never
 * an error.
 */
export function AssetDetailPage() {
  const { id } = useParams<{ id: string }>();
  const t = useT();
  const [range, setRange] = useState<PriceRange>('1M');
  const [live, setLive] = useState(false);
  const [liveWindow, setLiveWindow] = useState<LiveWindow>('10m');
  const [liveRate, setLiveRate] = useState<LiveRate>(DEFAULT_LIVE_RATE);

  const historyRange = toHistoryRange(range);

  // Asset meta + initial quote.
  const detailQuery = useQuery({
    queryKey: ['asset', id] as const,
    queryFn: ({ signal }) => getAssetDetail(id!, signal),
    staleTime: 60_000,
    enabled: !!id,
  });

  // Live quote poll — refetch every 60 s (§5.3 quote TTL, §7.1 refetch-on-focus).
  // This is the socket-gateway fallback until §7.1 real-time wiring lands.
  const quoteQuery = useQuery({
    queryKey: ['asset', id, 'quote'] as const,
    queryFn: ({ signal }) => getAssetQuote(id!, signal),
    staleTime: 60_000,
    refetchInterval: 60_000,
    enabled: !!id && !!detailQuery.data,
  });

  // History for the selected range.
  const historyQuery = useQuery({
    queryKey: ['asset', id, 'history', historyRange] as const,
    queryFn: ({ signal }) => getAssetHistory(id!, historyRange, signal),
    staleTime: HISTORY_STALE_MS[historyRange],
    enabled: !!id,
  });

  // Live Mode (§6.3, V3-P7b): stream from the shared per-asset loop while it
  // is reachable; otherwise the 60 s quote poll above doubles as the source.
  const isCustom = detailQuery.data?.asset.isCustom ?? false;
  const liveActive = live && !isCustom && !!id;
  const { frames: streamedFrames, streaming } = useLiveFrames(id, liveWindow, liveRate, liveActive);
  const fallbackFrames = usePollFallbackFrames(id ?? '', quoteQuery.data, liveActive && !streaming);

  if (!id) return null;

  // Full-page loading state (first load only).
  if (detailQuery.isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Skeleton height="h-8" width="w-64" />
          <Skeleton height="h-4" width="w-40" />
        </div>
        <Skeleton height="h-80" />
      </div>
    );
  }

  if (detailQuery.isError) {
    return (
      <div className="flex flex-col gap-4">
        <Link to="/assets/search" className="text-sm text-sky-400 hover:underline">
          ← Back to Search
        </Link>
        <Alert tone="error">
          Could not load asset details. The asset may not exist or the server is temporarily
          unavailable.
        </Alert>
      </div>
    );
  }

  const detail = detailQuery.data!;
  const { asset } = detail;
  const chartMode = asset.isCustom ? 'step' : 'area';

  const chartPoints = toChartPoints(historyQuery.data?.points ?? [], historyQuery.data?.interval);
  const liveFrames = trimToWindow(streaming ? streamedFrames : fallbackFrames, liveWindow);
  const livePoints = toLiveChartPoints(liveFrames);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center gap-3">
        <Link to="/assets/search" className="text-sm text-neutral-500 hover:text-neutral-300">
          ← Search
        </Link>
      </div>

      {/* Header */}
      <AssetHeader detail={detail} liveQuote={quoteQuery.data} />

      {/* Quick actions — reachable near the top (§13.2), not buried below the fold */}
      <ActionBar assetId={id} symbol={asset.symbol} />

      {/* Price chart — historical ranges, or short live windows when LIVE is on (§6.3) */}
      <div className="flex flex-col gap-3">
        {!asset.isCustom ? (
          <div className="flex flex-wrap items-center gap-3">
            <LiveControls
              live={liveActive}
              window={liveWindow}
              rate={liveRate}
              onToggle={() => setLive((v) => !v)}
              onWindowChange={setLiveWindow}
              onRateChange={setLiveRate}
            />
            {liveActive && !streaming ? (
              <span className="text-xs text-neutral-500">{t('assets.live.fallbackNote')}</span>
            ) : null}
          </div>
        ) : null}
        {liveActive ? (
          <PriceChart
            series={livePoints}
            mode="area"
            showRangeToggle={false}
            live
            emptyMessage={t('assets.live.waiting')}
            ariaLabel={t('assets.live.chartAriaLabel', { symbol: asset.symbol })}
          />
        ) : (
          <PriceChart
            series={chartPoints}
            mode={chartMode}
            range={range}
            onRangeChange={setRange}
            loading={historyQuery.isLoading || historyQuery.isFetching}
            ariaLabel={t('assets.detail.chartAriaLabel', { symbol: asset.symbol })}
          />
        )}
      </div>

      {/* Stats row */}
      <StatsRow detail={detail} liveQuote={quoteQuery.data} />

      {/* Sections */}
      <AppearsInSection />
      <AlertsSection
        asset={{
          id,
          symbol: asset.symbol,
          name: asset.name,
          currency: quoteQuery.data?.quote?.currency ?? detail.quote?.currency ?? 'EUR',
        }}
        referencePrice={quoteQuery.data?.quote?.price ?? detail.quote?.price ?? null}
      />

      <Disclaimer>
        Market data comes from an unofficial source and may be delayed or inaccurate.
      </Disclaimer>
    </div>
  );
}
