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
import { isConfirmedApiOutcome } from '../../lib/apiClient';
import { getSharedConglomerate, previewSharedConglomerateSandbox } from '../../lib/socialApi';
import { formatPercent, formatSignedPercent } from '../../lib/format';
import { EmptyState, Skeleton } from '../../ui';
import { Button, Icon, Input, Page, PageHead, Seg, Stat, StatStrip } from '../../ui/origin';
import { PriceChart, type ChartPoint } from '../../ui/charts';
import { useDebounce } from '../hooks/useDebounce';
import { NestedBadge } from '../workboard/ConglomeratesListPage';
import { Alert } from '../components/ui';
import { CommentThread } from './CommentThread';
import { ItemFollowButton } from './ItemFollowButton';

const SHARED_STALE_MS = 30_000;

/** One top-level shared constituent — an asset or a nested conglomerate. */
type SharedSandboxConstituent = SharedConglomerateDetailResponse['positions'][number];

function constituentId(position: SharedSandboxConstituent): string {
  return position.kind === 'asset' ? position.assetId : position.childId;
}

/**
 * Read-only view of a friend-shared conglomerate (PROJECTPLAN.md §6.9, §13.2
 * V2-P9): its positions with the embedded asset identity, exactly as the owner
 * sees them — no edit affordance anywhere. A non-friend / private / unknown
 * basket 404s and surfaces the not-found affordance.
 *
 * V5-P6 arc c adds a collapsed-by-default "what-if" sandbox: the viewer can
 * re-weight the constituents locally and see the backtest recompute, without any
 * write and without edit rights. A nested child remains one compact top-level
 * row; its stored internal allocation is resolved recursively by the preview.
 */
export function SharedConglomeratePage() {
  const t = useT();
  const { id = '' } = useParams<{ id: string }>();
  const { data, error, isLoading, isError, refetch } = useQuery({
    queryKey: ['social', 'shared', 'conglomerate', id],
    queryFn: ({ signal }) => getSharedConglomerate(id, signal),
    staleTime: SHARED_STALE_MS,
    retry: false,
  });

  if (isLoading) {
    return (
      <Page
        className="bt-phone-surface bt-shared-detail-page bt-social-page flex flex-col gap-3"
        width="wide"
      >
        <Skeleton height="h-8" width="w-64" />
        <Skeleton height="h-24" />
      </Page>
    );
  }

  if (isError && isConfirmedApiOutcome(error)) {
    return (
      <Page
        className="bt-phone-surface bt-shared-detail-page bt-social-page flex flex-col gap-4"
        width="wide"
      >
        <BackLink />
        <EmptyState
          title={t('social.shared.conglomerateUnavailableTitle')}
          description={t('social.shared.unavailableDescription')}
        />
      </Page>
    );
  }

  if (isError) {
    return (
      <Page
        className="bt-phone-surface bt-shared-detail-page bt-social-page flex flex-col items-start gap-3"
        width="wide"
      >
        <BackLink />
        <Alert tone="error">{t('social.shared.loadError')}</Alert>
        <Button onClick={() => void refetch()}>{t('common.retry')}</Button>
      </Page>
    );
  }

  if (!data) {
    return (
      <Page
        className="bt-phone-surface bt-shared-detail-page bt-social-page flex flex-col gap-4"
        width="wide"
      >
        <BackLink />
        <EmptyState
          title={t('social.shared.conglomerateUnavailableTitle')}
          description={t('social.shared.unavailableDescription')}
        />
      </Page>
    );
  }

  return (
    <Page className="bt-phone-surface bt-shared-detail-page bt-social-page" width="wide">
      <BackLink />
      <PageHead
        actions={<ItemFollowButton kind="conglomerate" subjectId={id} ownerId={data.owner.id} />}
        sub={t('social.shared.sharedByStatus', {
          username: data.owner.username,
          status:
            data.status === 'active'
              ? t('workboard.conglomerates.status.active')
              : t('workboard.conglomerates.status.draft'),
        })}
        title={data.name}
      >
        {data.description ? (
          <p className="bt-soft" style={{ marginTop: 6, maxWidth: '62ch' }}>
            {data.description}
          </p>
        ) : null}
      </PageHead>

      {data.positions.length === 0 ? (
        <EmptyState
          title={t('social.shared.noPositionsTitle')}
          description={t('social.shared.noPositionsDescription')}
        />
      ) : (
        <ul className="bt-band bt-t-rule bt-b-rule flex flex-col">
          {data.positions.map((p) => (
            <li
              key={p.kind === 'asset' ? p.assetId : p.childId}
              className="flex items-center justify-between gap-3 py-3"
            >
              {p.kind === 'asset' ? (
                <div className="min-w-0">
                  <p className="bt-row-title truncate">{p.asset.symbol}</p>
                  <p className="bt-row-sub truncate">{p.asset.name}</p>
                </div>
              ) : (
                <div className="flex min-w-0 items-center gap-2">
                  <p className="bt-row-title truncate">{p.child.name}</p>
                  <NestedBadge />
                </div>
              )}
              <span className="bt-num bt-soft shrink-0">{formatPercent(p.weightPct)}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="bt-section">
        <WhatIfSandbox conglomerateId={id} positions={data.positions} />
      </div>

      <div className="bt-section">
        <CommentThread kind="conglomerate" subjectId={id} />
      </div>
    </Page>
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
  positions: SharedSandboxConstituent[];
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<BacktestPreviewRange>('MAX');
  // Local weight overrides keyed by assetId/childId; seeded from the shared weights.
  const [weights, setWeights] = useState<Record<string, number>>(() =>
    Object.fromEntries(positions.map((p) => [constituentId(p), p.weightPct])),
  );

  // The tweak set is pinned to the CURRENT shared constituents: an un-tweaked (or
  // newly-appeared) row falls back to its shared weight, so the request always
  // covers exactly the shared basket — the server's exact-set guard is satisfied.
  const weightFor = (id: string, fallback: number) => weights[id] ?? fallback;
  const isPristine = positions.every(
    (position) => weightFor(constituentId(position), position.weightPct) === position.weightPct,
  );

  const previewPositions = useMemo(
    () =>
      positions.map((position) => {
        const id = constituentId(position);
        return { id, weight: weights[id] ?? position.weightPct };
      }),
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
    <section className="bt-panel">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="bt-band__row flex w-full items-center justify-between gap-3 text-left"
        style={{
          background: 'none',
          border: 0,
          color: 'inherit',
          cursor: 'pointer',
          font: 'inherit',
        }}
      >
        <span className="flex flex-col">
          <span className="bt-h3">{t('social.shared.sandbox.toggle')}</span>
          <span className="bt-meta">{t('social.shared.sandbox.subtitle')}</span>
        </span>
        <span aria-hidden="true" className="bt-muted flex">
          <Icon name={open ? 'chevron-up' : 'chevron-down'} size={16} />
        </span>
      </button>

      {open ? (
        <div className="bt-t-rule flex flex-col gap-4" style={{ padding: '16px 20px 18px' }}>
          <p className="bt-meta" style={{ maxWidth: '68ch' }}>
            {t('social.shared.sandbox.description')}
          </p>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <Seg
              ariaLabel={t('social.shared.sandbox.rangeAriaLabel')}
              onChange={setRange}
              options={BACKTEST_PREVIEW_RANGES.map((token) => ({
                value: token,
                label: rangeLabel(t, token),
              }))}
              value={range}
            />
            <Button
              disabled={isPristine}
              onClick={() =>
                setWeights(
                  Object.fromEntries(
                    positions.map((position) => [constituentId(position), position.weightPct]),
                  ),
                )
              }
              size="sm"
              variant="quiet"
            >
              {t('social.shared.sandbox.reset')}
            </Button>
          </div>

          <ul className="bt-band flex flex-col">
            {positions.map((position) => {
              const id = constituentId(position);
              return (
                <SandboxWeightRow
                  key={`${position.kind}:${id}`}
                  label={position.kind === 'asset' ? position.asset.symbol : position.child.name}
                  name={position.kind === 'asset' ? position.asset.name : undefined}
                  nested={position.kind === 'conglomerate'}
                  weight={weightFor(id, position.weightPct)}
                  onWeight={(weight) =>
                    setWeights((previous) => ({
                      ...previous,
                      [id]: clampWeight(weight),
                    }))
                  }
                />
              );
            })}
          </ul>

          {!allPositive ? (
            <p className="bt-gold-note" style={{ fontSize: 12 }}>
              {t('social.shared.sandbox.weightsPositiveHint')}
            </p>
          ) : preview.isError ? (
            <p className="bt-neg" style={{ fontSize: 12 }}>
              {t('social.shared.sandbox.previewError')}
            </p>
          ) : preview.isLoading ? (
            <Skeleton height="h-56" />
          ) : preview.data && chartPoints.length > 0 ? (
            <>
              <div className="bt-chart">
                <PriceChart
                  series={chartPoints}
                  showRangeToggle={false}
                  loading={preview.isFetching}
                  height={220}
                  ariaLabel={t('social.shared.sandbox.chartAriaLabel')}
                />
              </div>
              <StatStrip>
                <Stat
                  label={t('workboard.backtest.stats.totalReturn')}
                  value={formatSignedPercent(preview.data.stats.totalReturnPct)}
                />
                <Stat
                  label={t('workboard.backtest.stats.cagr')}
                  value={formatSignedPercent(preview.data.stats.cagrPct)}
                />
                <Stat
                  label={t('workboard.backtest.stats.maxDrawdown')}
                  value={formatSignedPercent(preview.data.stats.maxDrawdownPct)}
                />
                <Stat
                  label={t('workboard.backtest.stats.volatility')}
                  value={formatPercent(preview.data.stats.volatilityPct)}
                />
              </StatStrip>
            </>
          ) : (
            <p className="bt-meta">{t('social.shared.sandbox.empty')}</p>
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
  label,
  name,
  nested,
  weight,
  onWeight,
}: {
  label: string;
  name?: string;
  nested: boolean;
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
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className="bt-row-title truncate">{label}</span>
          {nested ? <NestedBadge /> : null}
        </span>
        {name ? (
          <span className="bt-row-sub truncate" title={name}>
            {name}
          </span>
        ) : null}
      </div>
      <div className="flex flex-1 items-center gap-3">
        <input
          type="range"
          min={0}
          max={100}
          step={0.5}
          value={weight}
          onChange={(e) => onWeight(Number(e.target.value))}
          aria-label={t('social.shared.sandbox.weightSliderAriaLabel', { symbol: label })}
          className="min-w-0 flex-1"
          style={{ accentColor: 'var(--bt-gold-graphic)' }}
        />
        <div className="flex items-center gap-1.5">
          <Input
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
            aria-label={t('social.shared.sandbox.weightAriaLabel', { symbol: label })}
            className="bt-num"
            style={{ minHeight: 30, padding: '3px 8px', textAlign: 'right', width: 84 }}
          />
          <span aria-hidden="true" className="bt-muted">
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
      to="/people"
      className="bt-link w-fit self-start"
      style={{ fontSize: 12.5, marginBottom: 10 }}
    >
      {t('social.shared.backToFriends')}
    </Link>
  );
}
