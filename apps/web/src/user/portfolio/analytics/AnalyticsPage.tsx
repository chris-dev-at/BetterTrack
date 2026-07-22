import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { Time } from 'lightweight-charts';

import {
  ANALYTICS_INFLATION_MODES,
  type AnalyticsInflationMode,
  type AnalyticsInflationPreset,
  type AnalyticsMode,
  type PortfolioAsset,
  type PortfolioHistoryRange,
} from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import type { TranslateFn } from '../../../i18n';
import { getAnalyticsSeries, type AnalyticsSeriesParams } from '../../../lib/analyticsApi';
import { getPortfolio, getPortfolioHistory, listPortfolios } from '../../../lib/portfolioApi';
import { cx } from '../../../lib/cx';
import { EM_DASH, formatDate, formatPercent, formatSignedPercent } from '../../../lib/format';
import { EmptyState, Skeleton, StatCard } from '../../../ui';
import { PriceChart } from '../../../ui/charts';
import type { BenchmarkSeries, ChartPoint } from '../../../ui/charts';
import { Alert } from '../../components/ui';
import { ACTIVE_PORTFOLIO_PARAM, resolveActivePortfolio } from '../PortfolioSwitcher';
import { AiInsightsPanel } from './AiInsightsPanel';
import { CompareControl, type CompareTarget } from './CompareControl';
import { ContributionTable } from './ContributionTable';

// ─── Range presets ────────────────────────────────────────────────────────────

/** The standard scales offered beside the free (custom) date range (§13.3). */
const RANGE_PRESETS = ['m1', 'm3', 'm6', 'y1', 'ytd', 'max'] as const;
type RangePreset = (typeof RANGE_PRESETS)[number] | 'custom';

/** §6.9 caches the per-asset history 1 h; mirror that as the overlay staleTime. */
const HISTORY_STALE_MS = 3_600_000;

/** Local date → ISO `YYYY-MM-DD` (Vienna-approximate; a window bound, not a timestamp). */
function isoDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Resolve a preset (or custom from/to) into the endpoint's `from`/`to` window. */
function resolveWindow(
  preset: RangePreset,
  customFrom: string,
  customTo: string,
): { from?: string; to?: string } {
  if (preset === 'custom') {
    return { from: customFrom || undefined, to: customTo || undefined };
  }
  if (preset === 'max') return {};
  const now = new Date();
  const to = isoDay(now);
  if (preset === 'ytd') return { from: `${now.getFullYear()}-01-01`, to };
  const months = preset === 'm1' ? 1 : preset === 'm3' ? 3 : preset === 'm6' ? 6 : 12;
  const from = new Date(now);
  from.setMonth(from.getMonth() - months);
  return { from: isoDay(from), to };
}

/** Nearest month-granular history range for the per-asset overlay fetch. */
function overlayHistoryRange(preset: RangePreset): PortfolioHistoryRange {
  if (preset === 'm1') return '1M';
  if (preset === 'max' || preset === 'custom') return 'MAX';
  return '1Y';
}

/** The bucket an asset filters by: market assets by `type`, custom assets by `category`. */
function groupKeyOf(asset: PortfolioAsset): string {
  return asset.isCustom ? (asset.category ?? 'other') : asset.type;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

/**
 * Portfolio → Analytics deep-dive (PROJECTPLAN.md §13.3 V3-P9). "See anything in
 * the most detail": a configurable main graph (per-asset show/hide, category/type
 * filters, free date range + standard scales, value vs performance-% modes), a
 * per-asset contribution table reacting to the same filters, the relocated
 * overlay-assets mode, compare vs any benchmark (asset/index, another portfolio,
 * a conglomerate) with side-by-side stats, and an inflation real-terms mode.
 *
 * The primary curve, compare overlay, per-series stats and contribution rows all
 * come from the single `analytics/.../series` endpoint — every knob travels in
 * its query, so any change re-requests and the whole surface recomputes live.
 */
export function AnalyticsPage() {
  const t = useT();
  const [searchParams] = useSearchParams();

  const [mode, setMode] = useState<AnalyticsMode>('value');
  const [preset, setPreset] = useState<RangePreset>('y1');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [excludedGroups, setExcludedGroups] = useState<Set<string>>(new Set());
  const [overlayAssets, setOverlayAssets] = useState(false);
  const [compare, setCompare] = useState<CompareTarget | null>(null);
  const [inflation, setInflation] = useState<'none' | AnalyticsInflationMode>('none');
  const [inflationRate, setInflationRate] = useState('');

  const portfoliosQuery = useQuery({
    queryKey: ['portfolios'],
    queryFn: ({ signal }) => listPortfolios(signal),
    staleTime: 60_000,
  });
  const activeParam = searchParams.get(ACTIVE_PORTFOLIO_PARAM);
  const portfolio = useMemo(
    () => resolveActivePortfolio(portfoliosQuery.data?.portfolios ?? [], activeParam),
    [portfoliosQuery.data, activeParam],
  );
  const portfolioId = portfolio?.id ?? null;

  // Filters are asset-id / context scoped, so switching portfolios must clear
  // them — a stale `hide`/`compare` from another portfolio would mis-filter.
  useEffect(() => {
    setHidden(new Set());
    setExcludedGroups(new Set());
    setCompare(null);
  }, [portfolioId]);

  // The asset universe for the visibility toggles + group chips (current holdings).
  const portfolioQuery = useQuery({
    queryKey: ['portfolio', portfolioId],
    queryFn: ({ signal }) => getPortfolio(portfolioId!, signal),
    enabled: portfolioId !== null,
    staleTime: 60_000,
  });

  const parsedRate = Number.parseFloat(inflationRate);
  const inflationParam: Pick<AnalyticsSeriesParams, 'inflation' | 'inflationRate'> =
    inflation === 'none'
      ? {}
      : inflation === 'flat'
        ? Number.isFinite(parsedRate) && parsedRate > -100
          ? { inflation: 'flat', inflationRate: parsedRate }
          : {}
        : { inflation };

  const dateWindow = resolveWindow(preset, customFrom, customTo);
  const analyticsParams: AnalyticsSeriesParams = {
    from: dateWindow.from,
    to: dateWindow.to,
    mode,
    hide: [...hidden],
    hideGroups: [...excludedGroups],
    compareKind: compare?.kind,
    compareId: compare?.id,
    ...inflationParam,
  };

  const analyticsQuery = useQuery({
    queryKey: ['analytics', portfolioId, analyticsParams],
    queryFn: ({ signal }) => getAnalyticsSeries(portfolioId!, analyticsParams, signal),
    enabled: portfolioId !== null,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  // Relocated overlay-assets mode (#122): each holding's own daily series, fetched
  // only while the toggle is on. Mapped to normalized overlays below.
  const overlayHistory = useQuery({
    queryKey: ['portfolio', portfolioId, 'history', overlayHistoryRange(preset), true],
    queryFn: ({ signal }) =>
      getPortfolioHistory(portfolioId!, overlayHistoryRange(preset), true, signal),
    enabled: portfolioId !== null && overlayAssets,
    staleTime: HISTORY_STALE_MS,
  });

  const data = analyticsQuery.data;
  const respMode = data?.mode ?? mode;
  const isPerf = respMode === 'perf';

  const primaryPoints = useMemo<ChartPoint[]>(
    () => (data?.primary.points ?? []).map((p) => ({ time: p.date as Time, value: p.value })),
    [data],
  );

  // Per-asset overlays (#122): raw native closes in value mode (the chart
  // normalizes every series to its first visible value); re-based to their own
  // first close in perf mode, where the axis is already a % scale.
  const assetOverlays = useMemo<BenchmarkSeries[]>(() => {
    if (!overlayAssets) return [];
    const assets = overlayHistory.data?.assets ?? [];
    if (!isPerf) {
      return assets.map((a) => ({
        label: a.symbol,
        series: a.points.map((p) => ({ time: p.date as Time, value: p.close })),
      }));
    }
    return assets
      .filter((a) => (a.points[0]?.close ?? 0) > 0)
      .map((a) => {
        const first = a.points[0]!.close;
        return {
          label: a.symbol,
          series: a.points.map((p) => ({
            time: p.date as Time,
            value: (p.close / first - 1) * 100,
          })),
        };
      });
  }, [overlayAssets, overlayHistory.data, isPerf]);

  // Compare overlay rides the same overlays channel: in value mode it normalizes
  // to % alongside the primary (comparable across currency scales); in perf mode
  // it is already a % curve. Side-by-side stats below carry the precise numbers.
  const overlays = useMemo<BenchmarkSeries[]>(() => {
    const compareSeries: BenchmarkSeries[] = data?.compare
      ? [
          {
            label: data.compare.label,
            series: data.compare.points.map((p) => ({ time: p.date as Time, value: p.value })),
          },
        ]
      : [];
    return [...compareSeries, ...assetOverlays];
  }, [data, assetOverlays]);

  const assets = portfolioQuery.data?.holdings.map((h) => h.asset) ?? [];
  const presentGroups = useMemo(() => {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const asset of assets) {
      const key = groupKeyOf(asset);
      if (!seen.has(key)) {
        seen.add(key);
        ordered.push(key);
      }
    }
    return ordered;
  }, [assets]);

  function toggleHidden(id: string) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleGroup(key: string) {
    setExcludedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // ── Loading / error / empty ──
  if (portfoliosQuery.isLoading || (portfolioId !== null && portfolioQuery.isLoading)) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton height="h-8" width="w-48" />
        <Skeleton height="h-80" />
        <Skeleton height="h-40" />
      </div>
    );
  }

  if (portfoliosQuery.isError || portfolioId === null || portfolioQuery.isError) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader t={t} />
        <Alert tone="error">{t('portfolio.analytics.loadError')}</Alert>
      </div>
    );
  }

  if (assets.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader t={t} />
        <EmptyState
          icon="📊"
          title={t('portfolio.analytics.empty.title')}
          description={t('portfolio.analytics.empty.description')}
        />
      </div>
    );
  }

  const chartLoading = analyticsQuery.isLoading || (overlayAssets && overlayHistory.isLoading);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader t={t} />

      {analyticsQuery.isError ? (
        <Alert tone="error">{t('portfolio.analytics.loadError')}</Alert>
      ) : null}

      {/* Top controls: display mode, range presets + custom window, inflation. */}
      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <ModeToggle t={t} mode={mode} onChange={setMode} />
            <InflationControl
              t={t}
              inflation={inflation}
              onInflationChange={setInflation}
              rate={inflationRate}
              onRateChange={setInflationRate}
              presets={data?.inflationPresets ?? []}
            />
          </div>
        </div>

        <RangeControl
          t={t}
          preset={preset}
          onPreset={setPreset}
          customFrom={customFrom}
          customTo={customTo}
          onCustomFrom={setCustomFrom}
          onCustomTo={setCustomTo}
          resolvedFrom={data?.from}
          resolvedTo={data?.to}
        />
      </section>

      <CompareControl value={compare} onChange={setCompare} currentPortfolioId={portfolioId} />

      {/* Main graph. */}
      <section
        aria-label={t('portfolio.analytics.chart.ariaLabel')}
        className="flex flex-col gap-3"
      >
        {data?.inflation ? (
          <p className="flex items-center gap-2 text-xs text-amber-300">
            <span className="rounded bg-amber-900/50 px-1.5 py-0.5 font-medium uppercase tracking-wide">
              {t('portfolio.analytics.inflation.realTermsBadge')}
            </span>
            {t('portfolio.analytics.inflation.realTermsHint')}
          </p>
        ) : null}
        <PriceChart
          series={primaryPoints}
          mode={isPerf ? 'baseline' : 'area'}
          percentValues={isPerf}
          overlays={overlays}
          showRangeToggle={false}
          loading={chartLoading}
          emptyMessage={t('portfolio.analytics.chart.emptyMessage')}
          ariaLabel={t('portfolio.analytics.chart.ariaLabel')}
        />
      </section>

      {/* Side-by-side stats: primary + optional compare. */}
      {data ? (
        <section className="grid gap-4 sm:grid-cols-2">
          <StatsBlock
            t={t}
            caption={t('portfolio.analytics.stats.portfolioCaption')}
            label={data.primary.label}
            stats={data.primary.stats}
          />
          {data.compare ? (
            <StatsBlock
              t={t}
              caption={t('portfolio.analytics.stats.compareCaption')}
              label={data.compare.label}
              stats={data.compare.stats}
            />
          ) : null}
        </section>
      ) : null}

      {/* Visibility & overlay filters. */}
      <VisibilityFilters
        t={t}
        assets={assets}
        hidden={hidden}
        onToggleAsset={toggleHidden}
        presentGroups={presentGroups}
        excludedGroups={excludedGroups}
        onToggleGroup={toggleGroup}
        overlayAssets={overlayAssets}
        onToggleOverlay={() => setOverlayAssets((v) => !v)}
      />

      {/* Per-asset contribution table (visible set). */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-neutral-200">
          {t('portfolio.analytics.contribution.sectionHeading')}
        </h2>
        <ContributionTable
          rows={data?.contributions ?? []}
          baseCurrency={data?.baseCurrency ?? 'EUR'}
        />
      </section>

      {/* AI insights (§13.5 V5-P12) — hidden entirely unless the capability read
          says AI is available; compact and fold-away (anti-bloat). */}
      <AiInsightsPanel portfolioId={portfolioId} hasHoldings={assets.length > 0} />
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────────

function PageHeader({ t }: { t: TranslateFn }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-neutral-100">
          {t('portfolio.analytics.title')}
        </h1>
        <p className="max-w-2xl text-sm text-neutral-400">{t('portfolio.analytics.subtitle')}</p>
      </div>
      <Link
        to="/portfolio"
        className="rounded px-2 py-1 text-sm text-sky-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        {t('portfolio.analytics.backToOverview')}
      </Link>
    </header>
  );
}

function ModeToggle({
  t,
  mode,
  onChange,
}: {
  t: TranslateFn;
  mode: AnalyticsMode;
  onChange: (mode: AnalyticsMode) => void;
}) {
  return (
    <div
      role="group"
      aria-label={t('portfolio.analytics.displayModeAriaLabel')}
      className="inline-flex gap-0.5 rounded-md bg-neutral-900 p-0.5 ring-1 ring-inset ring-neutral-800"
    >
      <SegmentButton selected={mode === 'value'} onClick={() => onChange('value')}>
        {t('portfolio.analytics.valueMode')}
      </SegmentButton>
      <SegmentButton selected={mode === 'perf'} onClick={() => onChange('perf')}>
        {t('portfolio.analytics.perfMode')}
      </SegmentButton>
    </div>
  );
}

function InflationControl({
  t,
  inflation,
  onInflationChange,
  rate,
  onRateChange,
  presets,
}: {
  t: TranslateFn;
  inflation: 'none' | AnalyticsInflationMode;
  onInflationChange: (mode: 'none' | AnalyticsInflationMode) => void;
  rate: string;
  onRateChange: (rate: string) => void;
  /**
   * Per-preset effective %/yr, from the analytics response (V4-P0). Each
   * option's label ends with e.g. "≈ 2.6 %/yr" so users see what the preset
   * actually does before selecting it. Falls back to no suffix while the
   * response is loading.
   */
  presets: readonly AnalyticsInflationPreset[];
}) {
  const labels: Record<'none' | AnalyticsInflationMode, string> = {
    none: t('portfolio.analytics.inflation.none'),
    'hicp-at': t('portfolio.analytics.inflation.hicpAt'),
    'hicp-eu': t('portfolio.analytics.inflation.hicpEu'),
    'cpi-us': t('portfolio.analytics.inflation.cpiUs'),
    flat: t('portfolio.analytics.inflation.flat'),
  };
  const rateSuffix = t('portfolio.analytics.inflation.rateSuffix');
  const presetRate = new Map(presets.map((p) => [p.id, p.pctPerYear]));
  const decorate = (id: AnalyticsInflationMode): string => {
    const base = labels[id];
    if (id === 'flat') return base;
    const rate = presetRate.get(id as AnalyticsInflationPreset['id']);
    if (rate == null) return base;
    // "≈ 2.6 %/yr", localised via the rateSuffix key (EN "%/yr", DE "%/J").
    return t('portfolio.analytics.inflation.presetLabel', {
      label: base,
      rate: rate.toFixed(1),
      suffix: rateSuffix,
    });
  };
  return (
    <div className="flex items-center gap-2">
      <select
        aria-label={t('portfolio.analytics.inflation.label')}
        value={inflation}
        onChange={(e) => onInflationChange(e.target.value as 'none' | AnalyticsInflationMode)}
        className={cx(
          'rounded-md bg-neutral-900 px-2.5 py-1.5 text-sm text-neutral-100',
          'ring-1 ring-inset ring-neutral-800 focus:outline-none focus:ring-2 focus:ring-sky-500',
        )}
      >
        <option value="none">{labels.none}</option>
        {ANALYTICS_INFLATION_MODES.map((id) => (
          <option key={id} value={id}>
            {decorate(id)}
          </option>
        ))}
      </select>
      {inflation === 'flat' ? (
        <span className="flex items-center gap-1">
          <input
            type="number"
            inputMode="decimal"
            step="0.1"
            value={rate}
            onChange={(e) => onRateChange(e.target.value)}
            aria-label={t('portfolio.analytics.inflation.rateLabel')}
            className={cx(
              'w-20 rounded-md bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 tabular-nums',
              'ring-1 ring-inset ring-neutral-800 focus:outline-none focus:ring-2 focus:ring-sky-500',
            )}
          />
          <span className="text-xs text-neutral-500">
            {t('portfolio.analytics.inflation.rateSuffix')}
          </span>
        </span>
      ) : null}
    </div>
  );
}

function RangeControl({
  t,
  preset,
  onPreset,
  customFrom,
  customTo,
  onCustomFrom,
  onCustomTo,
  resolvedFrom,
  resolvedTo,
}: {
  t: TranslateFn;
  preset: RangePreset;
  onPreset: (preset: RangePreset) => void;
  customFrom: string;
  customTo: string;
  onCustomFrom: (value: string) => void;
  onCustomTo: (value: string) => void;
  resolvedFrom: string | undefined;
  resolvedTo: string | undefined;
}) {
  const presetLabels: Record<RangePreset, string> = {
    m1: t('portfolio.analytics.range.m1'),
    m3: t('portfolio.analytics.range.m3'),
    m6: t('portfolio.analytics.range.m6'),
    y1: t('portfolio.analytics.range.y1'),
    ytd: t('portfolio.analytics.range.ytd'),
    max: t('portfolio.analytics.range.max'),
    custom: t('portfolio.analytics.range.custom'),
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="group"
          aria-label={t('portfolio.analytics.range.heading')}
          className="inline-flex flex-wrap gap-0.5 rounded-md bg-neutral-900 p-0.5 ring-1 ring-inset ring-neutral-800"
        >
          {RANGE_PRESETS.map((p) => (
            <SegmentButton key={p} selected={preset === p} onClick={() => onPreset(p)}>
              {presetLabels[p]}
            </SegmentButton>
          ))}
          <SegmentButton selected={preset === 'custom'} onClick={() => onPreset('custom')}>
            {presetLabels.custom}
          </SegmentButton>
        </div>
        {resolvedFrom && resolvedTo ? (
          <span className="text-xs tabular-nums text-neutral-500">
            {formatDate(resolvedFrom)} – {formatDate(resolvedTo)}
          </span>
        ) : null}
      </div>
      {preset === 'custom' ? (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="date"
            value={customFrom}
            onChange={(e) => onCustomFrom(e.target.value)}
            aria-label={t('portfolio.analytics.range.fromLabel')}
            className="rounded-md bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 ring-1 ring-inset ring-neutral-800 focus:outline-none focus:ring-2 focus:ring-sky-500"
          />
          <span aria-hidden="true" className="text-neutral-600">
            –
          </span>
          <input
            type="date"
            value={customTo}
            onChange={(e) => onCustomTo(e.target.value)}
            aria-label={t('portfolio.analytics.range.toLabel')}
            className="rounded-md bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 ring-1 ring-inset ring-neutral-800 focus:outline-none focus:ring-2 focus:ring-sky-500"
          />
        </div>
      ) : null}
    </div>
  );
}

function StatsBlock({
  t,
  caption,
  label,
  stats,
}: {
  t: TranslateFn;
  caption: string;
  label: string;
  stats: {
    totalReturnPct: number;
    cagrPct: number | null;
    maxDrawdownPct: number;
    bestDay: { date: string; returnPct: number } | null;
    worstDay: { date: string; returnPct: number } | null;
  };
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg bg-neutral-900/60 p-4">
      <div className="flex flex-col">
        <span className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          {caption}
        </span>
        <span className="truncate font-semibold text-neutral-100">{label}</span>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard
          label={t('portfolio.analytics.stats.totalReturn')}
          value={<span className="text-lg">{formatSignedPercent(stats.totalReturnPct)}</span>}
        />
        <StatCard
          label={t('portfolio.analytics.stats.cagr')}
          value={<span className="text-lg">{formatSignedPercent(stats.cagrPct)}</span>}
        />
        <StatCard
          label={t('portfolio.analytics.stats.maxDrawdown')}
          value={<span className="text-lg">{formatPercent(stats.maxDrawdownPct)}</span>}
        />
        <StatCard
          label={t('portfolio.analytics.stats.bestDay')}
          value={<DayStat day={stats.bestDay} />}
        />
        <StatCard
          label={t('portfolio.analytics.stats.worstDay')}
          value={<DayStat day={stats.worstDay} />}
        />
      </div>
    </div>
  );
}

function DayStat({ day }: { day: { date: string; returnPct: number } | null }) {
  if (!day) return <span className="text-lg text-neutral-500">{EM_DASH}</span>;
  return (
    <span className="flex flex-col">
      <span className="text-lg">{formatSignedPercent(day.returnPct)}</span>
      <span className="text-xs font-normal text-neutral-500">{formatDate(day.date)}</span>
    </span>
  );
}

function VisibilityFilters({
  t,
  assets,
  hidden,
  onToggleAsset,
  presentGroups,
  excludedGroups,
  onToggleGroup,
  overlayAssets,
  onToggleOverlay,
}: {
  t: TranslateFn;
  assets: PortfolioAsset[];
  hidden: Set<string>;
  onToggleAsset: (id: string) => void;
  presentGroups: string[];
  excludedGroups: Set<string>;
  onToggleGroup: (key: string) => void;
  overlayAssets: boolean;
  onToggleOverlay: () => void;
}) {
  return (
    <section className="flex flex-col gap-4 rounded-lg bg-neutral-900/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
          {t('portfolio.analytics.filters.heading')}
        </h2>
        <button
          type="button"
          aria-pressed={overlayAssets}
          onClick={onToggleOverlay}
          title={t('portfolio.analytics.filters.overlayHint')}
          className={cx(
            'rounded-md px-2.5 py-1 text-xs font-medium ring-1 ring-inset transition-colors',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
            overlayAssets
              ? 'bg-sky-600 text-white ring-sky-600'
              : 'bg-neutral-900 text-neutral-400 ring-neutral-800 hover:bg-neutral-800 hover:text-neutral-100',
          )}
        >
          {t('portfolio.analytics.filters.overlayToggle')}
        </button>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-neutral-500">
          {t('portfolio.analytics.filters.assetsHeading')}
        </span>
        <div className="flex flex-wrap gap-1.5">
          {assets.map((asset) => {
            const shown = !hidden.has(asset.id);
            return (
              <FilterChip
                key={asset.id}
                active={shown}
                onClick={() => onToggleAsset(asset.id)}
                ariaLabel={t('portfolio.analytics.filters.assetToggle', { symbol: asset.symbol })}
              >
                {asset.symbol}
              </FilterChip>
            );
          })}
        </div>
      </div>

      {presentGroups.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-neutral-500">
            {t('portfolio.analytics.filters.groupsHeading')}
          </span>
          <div className="flex flex-wrap gap-1.5">
            {presentGroups.map((key) => {
              const included = !excludedGroups.has(key);
              const label = t(`portfolio.analytics.groups.${key}`);
              return (
                <FilterChip
                  key={key}
                  active={included}
                  onClick={() => onToggleGroup(key)}
                  ariaLabel={t('portfolio.analytics.filters.groupToggle', { group: label })}
                >
                  {label}
                </FilterChip>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function FilterChip({
  active,
  onClick,
  ariaLabel,
  children,
}: {
  active: boolean;
  onClick: () => void;
  ariaLabel: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={ariaLabel}
      onClick={onClick}
      className={cx(
        'rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
        active
          ? 'bg-sky-600/20 text-sky-200 ring-sky-700'
          : 'bg-neutral-900 text-neutral-500 line-through ring-neutral-800 hover:text-neutral-300',
      )}
    >
      {children}
    </button>
  );
}

function SegmentButton({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cx(
        'rounded px-2.5 py-1 text-xs font-medium transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
        selected
          ? 'bg-sky-600 text-white'
          : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100',
      )}
    >
      {children}
    </button>
  );
}
