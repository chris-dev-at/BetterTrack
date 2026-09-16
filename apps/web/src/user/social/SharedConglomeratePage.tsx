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
import { Button, Icon, Input, PageHead, Seg, Stat, StatStrip } from '../../ui/origin';
import { PriceChart, type ChartPoint } from '../../ui/charts';
import { useDebounce } from '../hooks/useDebounce';
import { NestedBadge } from '../workboard/ConglomeratesListPage';
import { Avatar } from '../components/Avatar';
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
 * One viewer re-weight, together with the SHARED weight it was made against.
 * `sharedAt` is what makes a refetch decidable: equal to the new shared weight,
 * the owner changed something else and the tweak stands; different, the ground
 * the viewer was standing on moved and they are told so.
 */
type SandboxTweak = { weight: number; sharedAt: number };

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
      <section className="flex flex-col gap-3">
        <Skeleton height="h-8" width="w-64" />
        <Skeleton height="h-24" />
      </section>
    );
  }

  if (isError && isConfirmedApiOutcome(error)) {
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

  if (isError) {
    return (
      <div className="flex flex-col items-start gap-3">
        <BackLink />
        <Alert tone="error">{t('social.shared.loadError')}</Alert>
        <Button onClick={() => void refetch()}>{t('common.retry')}</Button>
      </div>
    );
  }

  if (!data) {
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
    <div className="flex flex-col">
      <BackLink />
      <PageHead
        actions={<ItemFollowButton kind="conglomerate" subjectId={id} ownerId={data.owner.id} />}
        media={<Avatar iconId={data.owner.profileIcon} name={data.owner.username} size="lg" />}
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
  positions: SharedSandboxConstituent[];
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<BacktestPreviewRange>('MAX');
  // Only the constituents the viewer ACTUALLY re-weighted, keyed by
  // assetId/childId. Seeding every row from the shared weights once (the
  // pre-#1659 shape) froze the sandbox at mount: an owner-side re-weight then
  // arrived in the read-only list above while these rows — and the curve and
  // stats computed from them — still showed the weights captured at mount,
  // presented as the shared basket. An absent entry means "no opinion", so an
  // un-tweaked row simply follows its shared weight, forever.
  const [tweaks, setTweaks] = useState<Record<string, SandboxTweak>>({});
  // Rows whose SHARED weight moved while the viewer held a tweak on them. Their
  // edit is kept (never silently discarded) and the notice says the baseline
  // moved, so the two halves of the page can never disagree in silence.
  const [supersededIds, setSupersededIds] = useState<string[]>([]);
  const [syncedPositions, setSyncedPositions] = useState(positions);

  // Re-seat the tweaks on refetched shared positions, during render so the very
  // first paint after a refetch is already consistent (an effect would show one
  // frame — and issue one preview request — at the superseded weights).
  if (positions !== syncedPositions) {
    setSyncedPositions(positions);
    const shared = new Map(positions.map((p) => [constituentId(p), p.weightPct]));
    const rebased: Record<string, SandboxTweak> = {};
    const moved: string[] = [];
    for (const [id, tweak] of Object.entries(tweaks)) {
      const sharedNow = shared.get(id);
      // The constituent left the shared basket: the tweak has nothing left to
      // apply to, and dropping it here is what stops it resurrecting — silently,
      // at a weight chosen against a basket that no longer held this row — if the
      // owner adds the id back later.
      if (sharedNow === undefined) continue;
      if (sharedNow !== tweak.sharedAt) moved.push(id);
      rebased[id] = { weight: tweak.weight, sharedAt: sharedNow };
    }
    setTweaks(rebased);
    setSupersededIds((previous) => [
      ...previous.filter((id) => id in rebased),
      ...moved.filter((id) => !previous.includes(id)),
    ]);
  }

  /** Record a viewer edit, against the shared weight it was made from. */
  const setTweak = (id: string, sharedWeight: number, weight: number) => {
    const value = clampWeight(weight);
    setTweaks((previous) => {
      // Landing a row back on the weight it already shares with the basket is
      // not an opinion — dragging a slider away and back must leave the row
      // following the owner again, not frozen at a number that merely happens
      // to match today.
      if (value === sharedWeight) {
        const rest = { ...previous };
        delete rest[id];
        return rest;
      }
      return { ...previous, [id]: { weight: value, sharedAt: sharedWeight } };
    });
    // A fresh edit on a superseded row IS the acknowledgement.
    setSupersededIds((previous) => previous.filter((x) => x !== id));
  };

  const resetToShared = () => {
    setTweaks({});
    setSupersededIds([]);
  };

  // The request always covers exactly the CURRENT shared constituents: an
  // un-tweaked (or newly-appeared) row falls back to its shared weight and a
  // departed one contributes nothing, so the server's exact-set guard is
  // satisfied on every refetch without a round trip through "reset".
  const weightFor = (id: string, fallback: number) => tweaks[id]?.weight ?? fallback;
  const isPristine = positions.every(
    (position) => weightFor(constituentId(position), position.weightPct) === position.weightPct,
  );

  const supersededLabels = positions
    .filter((position) => supersededIds.includes(constituentId(position)))
    .map((position) => (position.kind === 'asset' ? position.asset.symbol : position.child.name));

  const previewPositions = useMemo(
    () =>
      positions.map((position) => {
        const id = constituentId(position);
        return { id, weight: tweaks[id]?.weight ?? position.weightPct };
      }),
    [positions, tweaks],
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
            <Button disabled={isPristine} onClick={resetToShared} size="sm" variant="quiet">
              {t('social.shared.sandbox.reset')}
            </Button>
          </div>

          {supersededLabels.length > 0 ? (
            <p className="bt-gold-note" style={{ fontSize: 12 }}>
              {t('social.shared.sandbox.sharedWeightsMoved', {
                names: supersededLabels.join(', '),
              })}
            </p>
          ) : null}

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
                  onWeight={(weight) => setTweak(id, position.weightPct, weight)}
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
