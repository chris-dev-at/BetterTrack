import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import type { Time } from 'lightweight-charts';
import { Link, useParams } from 'react-router-dom';

import {
  BACKTEST_PREVIEW_RANGES,
  type BacktestPreviewRange,
  type SharedConglomerateDetailResponse,
} from '@bettertrack/contracts';

import { useT } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import { cx } from '../../lib/cx';
import { getSharedConglomerate, previewSharedConglomerateSandbox } from '../../lib/socialApi';
import { formatPercent, formatSignedPercent } from '../../lib/format';
import { EmptyState, Skeleton, StatCard } from '../../ui';
import { PriceChart, type ChartPoint } from '../../ui/charts';
import { useDebounce } from '../hooks/useDebounce';
import { NestedBadge } from '../workboard/ConglomeratesListPage';
import { CommentThread } from './CommentThread';
import { ItemFollowButton } from './ItemFollowButton';

const SHARED_STALE_MS = 30_000;

/** One shared asset constituent — the only kind the what-if sandbox re-weights. */
type SharedAssetPosition = Extract<
  SharedConglomerateDetailResponse['positions'][number],
  { kind: 'asset' }
>;

/**
 * Read-only view of a friend-shared conglomerate (PROJECTPLAN.md §6.9, §13.2
 * V2-P9): its positions with the embedded asset identity, exactly as the owner
 * sees them — no edit affordance anywhere. A non-friend / private / unknown
 * basket 404s and surfaces the not-found affordance.
 *
 * V5-P6 arc c adds a collapsed-by-default "what-if" sandbox: the viewer can
 * re-weight the constituents locally and see the backtest recompute, without any
 * write and without edit rights. It folds away compact and is offered only for
 * flat (non-nested) all-asset baskets — nested re-weighting is #592's scope.
 */
export function SharedConglomeratePage() {
  const t = useT();
  const { id = '' } = useParams<{ id: string }>();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['social', 'shared', 'conglomerate', id],
    queryFn: ({ signal }) => getSharedConglomerate(id, signal),
    staleTime: SHARED_STALE_MS,
    retry: false,
  });

  // The sandbox re-weights top-level ASSET constituents only. A basket with any
  // nested child is not sandboxable here (recursive re-weighting is #592), so it
  // simply renders without the sandbox — zero added bloat on the shared view.
  const assetPositions = useMemo<SharedAssetPosition[]>(
    () => (data ? data.positions.filter((p): p is SharedAssetPosition => p.kind === 'asset') : []),
    [data],
  );
  const sandboxable = Boolean(data) && assetPositions.length === (data?.positions.length ?? 0);

  if (isLoading) {
    return (
      <section className="flex flex-col gap-3">
        <Skeleton height="h-8" width="w-64" />
        <Skeleton height="h-24" />
      </section>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <EmptyState
          title={t('social.shared.conglomerateUnavailableTitle')}
          description={t('social.shared.unavailableDescription')}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <BackLink />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-neutral-100">{data.name}</h2>
          <ItemFollowButton kind="conglomerate" subjectId={id} ownerId={data.owner.id} />
        </div>
        <p className="text-sm text-neutral-500">
          {t('social.shared.sharedByStatus', {
            username: data.owner.username,
            status:
              data.status === 'active'
                ? t('workboard.conglomerates.status.active')
                : t('workboard.conglomerates.status.draft'),
          })}
        </p>
        {data.description ? <p className="text-sm text-neutral-400">{data.description}</p> : null}
      </div>

      {data.positions.length === 0 ? (
        <EmptyState
          title={t('social.shared.noPositionsTitle')}
          description={t('social.shared.noPositionsDescription')}
        />
      ) : (
        <ul className="divide-y divide-neutral-800">
          {data.positions.map((p) => (
            <li
              key={p.kind === 'asset' ? p.assetId : p.childId}
              className="flex items-center justify-between gap-3 py-3"
            >
              {p.kind === 'asset' ? (
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-neutral-100">{p.asset.symbol}</p>
                  <p className="truncate text-xs text-neutral-500">{p.asset.name}</p>
                </div>
              ) : (
                <div className="flex min-w-0 items-center gap-2">
                  <p className="truncate text-sm font-medium text-neutral-100">{p.child.name}</p>
                  <NestedBadge />
                </div>
              )}
              <span className="shrink-0 text-sm font-medium tabular-nums text-neutral-200">
                {formatPercent(p.weightPct)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {sandboxable ? <WhatIfSandbox conglomerateId={id} positions={assetPositions} /> : null}

      <CommentThread kind="conglomerate" subjectId={id} />
    </div>
  );
}

/** Clamp a tweaked weight to the display range and 3-decimal precision. */
function clampWeight(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const bounded = Math.min(100, Math.max(0, value));
  return Math.round(bounded * 1000) / 1000;
}

function rangeLabel(t: TranslateFn, token: BacktestPreviewRange): string {
  switch (token) {
    case '1Y':
      return t('workboard.backtest.range.oneYear');
    case '3Y':
      return t('workboard.backtest.range.threeYear');
    case '5Y':
      return t('workboard.backtest.range.fiveYear');
    case 'MAX':
      return t('workboard.backtest.range.max');
  }
}

/**
 * The collapsed-by-default what-if sandbox (§13.5 V5-P6 arc c). All tweaks are
 * LOCAL React state; the only network call is the read-only share-scoped preview,
 * so nothing is persisted and "reset to shared" simply restores the shared
 * weights. The query is gated on the panel being open, so an unexpanded sandbox
 * costs nothing.
 */
function WhatIfSandbox({
  conglomerateId,
  positions,
}: {
  conglomerateId: string;
  positions: SharedAssetPosition[];
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<BacktestPreviewRange>('MAX');
  // Local weight overrides keyed by assetId; seeded from the shared weights.
  const [weights, setWeights] = useState<Record<string, number>>(() =>
    Object.fromEntries(positions.map((p) => [p.assetId, p.weightPct])),
  );

  // The tweak set is pinned to the CURRENT shared constituents: an un-tweaked (or
  // newly-appeared) asset falls back to its shared weight, so the request always
  // covers exactly the shared basket — the server's exact-set guard is satisfied.
  const weightFor = (assetId: string, fallback: number) => weights[assetId] ?? fallback;
  const isPristine = positions.every((p) => weightFor(p.assetId, p.weightPct) === p.weightPct);

  const previewPositions = useMemo(
    () => positions.map((p) => ({ id: p.assetId, weight: weights[p.assetId] ?? p.weightPct })),
    [positions, weights],
  );
  const allPositive = previewPositions.every((p) => p.weight > 0);
  const debouncedPositions = useDebounce(previewPositions, 400);

  const preview = useQuery({
    queryKey: [
      'social',
      'shared',
      'conglomerate',
      conglomerateId,
      'sandbox',
      range,
      debouncedPositions,
    ],
    queryFn: ({ signal }) =>
      previewSharedConglomerateSandbox(
        conglomerateId,
        { positions: debouncedPositions, range },
        signal,
      ),
    enabled: open && allPositive,
    staleTime: 60_000,
    retry: false,
  });

  const chartPoints: ChartPoint[] = useMemo(
    () =>
      preview.data
        ? preview.data.series.map((pt) => ({ time: pt.date as Time, value: pt.value }))
        : [],
    [preview.data],
  );

  return (
    <section className="rounded-xl border border-neutral-800 bg-neutral-900/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        <span className="flex flex-col">
          <span className="text-sm font-semibold text-neutral-100">
            {t('social.shared.sandbox.toggle')}
          </span>
          <span className="text-xs text-neutral-500">{t('social.shared.sandbox.subtitle')}</span>
        </span>
        <span aria-hidden="true" className="text-neutral-500">
          {open ? '▲' : '▼'}
        </span>
      </button>

      {open ? (
        <div className="flex flex-col gap-4 border-t border-neutral-800 px-4 py-4">
          <p className="text-xs text-neutral-500">{t('social.shared.sandbox.description')}</p>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div
              role="group"
              aria-label={t('social.shared.sandbox.rangeAriaLabel')}
              className="inline-flex rounded-md bg-neutral-900 p-0.5 ring-1 ring-inset ring-neutral-800"
            >
              {BACKTEST_PREVIEW_RANGES.map((token) => {
                const selected = token === range;
                return (
                  <button
                    key={token}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setRange(token)}
                    className={cx(
                      'rounded px-2 py-1 text-xs font-medium transition-colors',
                      'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
                      selected
                        ? 'bg-sky-600 text-white'
                        : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100',
                    )}
                  >
                    {rangeLabel(t, token)}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              onClick={() =>
                setWeights(Object.fromEntries(positions.map((p) => [p.assetId, p.weightPct])))
              }
              disabled={isPristine}
              className={cx(
                'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
                isPristine
                  ? 'cursor-not-allowed text-neutral-600'
                  : 'text-sky-300 hover:bg-neutral-800',
              )}
            >
              {t('social.shared.sandbox.reset')}
            </button>
          </div>

          <ul className="flex flex-col gap-2">
            {positions.map((p) => (
              <SandboxWeightRow
                key={p.assetId}
                symbol={p.asset.symbol}
                name={p.asset.name}
                weight={weightFor(p.assetId, p.weightPct)}
                onWeight={(w) => setWeights((prev) => ({ ...prev, [p.assetId]: clampWeight(w) }))}
              />
            ))}
          </ul>

          {!allPositive ? (
            <p className="text-xs text-amber-300">
              {t('social.shared.sandbox.weightsPositiveHint')}
            </p>
          ) : preview.isError ? (
            <p className="text-xs text-red-300">{t('social.shared.sandbox.previewError')}</p>
          ) : preview.isLoading ? (
            <Skeleton height="h-56" />
          ) : preview.data && chartPoints.length > 0 ? (
            <>
              <PriceChart
                series={chartPoints}
                showRangeToggle={false}
                loading={preview.isFetching}
                height={220}
                ariaLabel={t('social.shared.sandbox.chartAriaLabel')}
              />
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <StatCard
                  label={t('workboard.backtest.stats.totalReturn')}
                  value={formatSignedPercent(preview.data.stats.totalReturnPct)}
                />
                <StatCard
                  label={t('workboard.backtest.stats.cagr')}
                  value={formatSignedPercent(preview.data.stats.cagrPct)}
                />
                <StatCard
                  label={t('workboard.backtest.stats.maxDrawdown')}
                  value={formatSignedPercent(preview.data.stats.maxDrawdownPct)}
                />
                <StatCard
                  label={t('workboard.backtest.stats.volatility')}
                  value={formatPercent(preview.data.stats.volatilityPct)}
                />
              </div>
            </>
          ) : (
            <p className="text-xs text-neutral-500">{t('social.shared.sandbox.empty')}</p>
          )}
        </div>
      ) : null}
    </section>
  );
}

/**
 * One re-weightable constituent row: a 0–100 slider and a 0.001-precision number
 * input kept in sync. The number field keeps a local draft string so decimals can
 * be typed without the parsed value fighting the caret, re-syncing when the weight
 * changes elsewhere (slider, reset).
 */
function SandboxWeightRow({
  symbol,
  name,
  weight,
  onWeight,
}: {
  symbol: string;
  name: string;
  weight: number;
  onWeight: (weight: number) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(String(weight));

  useEffect(() => {
    if (draft === '' || Number(draft) === weight) return;
    setDraft(String(weight));
  }, [weight, draft]);

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-neutral-800 bg-neutral-950/40 p-3 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-mono text-sm font-semibold text-neutral-100">{symbol}</span>
        <span className="truncate text-xs text-neutral-500" title={name}>
          {name}
        </span>
      </div>
      <div className="flex flex-1 items-center gap-3">
        <input
          type="range"
          min={0}
          max={100}
          step={0.5}
          value={weight}
          onChange={(e) => onWeight(Number(e.target.value))}
          aria-label={t('social.shared.sandbox.weightSliderAriaLabel', { symbol })}
          className="min-w-0 flex-1 accent-sky-500"
        />
        <div className="flex items-center gap-1">
          <input
            type="number"
            min={0}
            max={100}
            step={0.001}
            value={draft}
            onChange={(e) => {
              const raw = e.target.value;
              setDraft(raw);
              if (raw === '') return;
              const parsed = Number(raw);
              if (Number.isFinite(parsed)) onWeight(parsed);
            }}
            aria-label={t('social.shared.sandbox.weightAriaLabel', { symbol })}
            className="w-20 rounded-md bg-neutral-950 px-2 py-1.5 text-right text-sm tabular-nums text-neutral-100 ring-1 ring-inset ring-neutral-700 focus:outline-none focus:ring-2 focus:ring-sky-500"
          />
          <span aria-hidden="true" className="text-sm text-neutral-500">
            %
          </span>
        </div>
      </div>
    </li>
  );
}

function BackLink() {
  const t = useT();
  return (
    <Link
      to="/social/friends"
      className="w-fit text-xs text-sky-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
    >
      {t('social.shared.backToFriends')}
    </Link>
  );
}
