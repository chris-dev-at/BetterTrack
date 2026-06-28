import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, Route, Routes, useParams } from 'react-router-dom';

import type { BacktestPreviewRange, ConglomerateDetail } from '@bettertrack/contracts';
import {
  activateConglomerate,
  createConglomerateDraft,
  getConglomerate,
  previewBacktest,
  saveConglomeratePositions,
} from '../../lib/conglomerateApi';
import { cx } from '../../lib/cx';
import { formatSignedPercent } from '../../lib/format';
import { AllocationDonut, PriceChart } from '../../ui/charts';
import type { ChartPoint, PriceRange } from '../../ui/charts/types';
import { AssetSearchBox } from '../components/AssetSearchBox';
import { Alert, Button, Spinner } from '../components/ui';
import {
  autoBalance,
  normalizeWeights,
  positionFromSearchResult,
  sumPillState,
  updatePositionWeight,
  type BuilderPosition,
} from './conglomerateBuilderMath';

const PREVIEW_DEBOUNCE_MS = 500;
const PREVIEW_RANGES = ['1Y', '3Y', '5Y', 'Max'] as const;

type PreviewStats = Awaited<ReturnType<typeof previewBacktest>>['stats'];

function positionsFromDetail(detail: ConglomerateDetail): BuilderPosition[] {
  return detail.positions.map((position) => ({
    localId: position.assetId,
    assetId: position.assetId,
    symbol: position.asset.symbol,
    name: position.asset.name,
    currency: position.asset.currency,
    weightPct: position.weightPct,
    locked: false,
  }));
}

function defaultDraftName(): string {
  return `Draft ${new Date().toISOString().slice(0, 10)}`;
}

export function ConglomeratesPage() {
  return (
    <Routes>
      <Route index element={<ConglomeratesIndex />} />
      <Route path="new" element={<ConglomerateBuilderPage mode="new" />} />
      <Route path=":id/edit" element={<ConglomerateBuilderPage mode="edit" />} />
      <Route path="*" element={<Navigate to="/conglomerates" replace />} />
    </Routes>
  );
}

function ConglomeratesIndex() {
  return (
    <section className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">Conglomerates</h1>
        <p className="mt-1 text-sm text-neutral-400">Build and tune your own weighted baskets.</p>
      </div>
      <Link
        to="/conglomerates/new"
        className={cx(
          'w-fit rounded-md bg-sky-600 px-3 py-2 text-sm font-semibold text-white',
          'hover:bg-sky-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
        )}
      >
        New Conglomerate
      </Link>
    </section>
  );
}

export function ConglomerateBuilderPage({ mode }: { mode: 'new' | 'edit' }) {
  const { id } = useParams();
  const [draftId, setDraftId] = useState<string | null>(mode === 'edit' ? (id ?? null) : null);
  const [title, setTitle] = useState(defaultDraftName);
  const [positions, setPositions] = useState<BuilderPosition[]>([]);
  const [previewRange, setPreviewRange] = useState<BacktestPreviewRange>('1Y');
  const [normalizeError, setNormalizeError] = useState<string | null>(null);
  const [activateError, setActivateError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [previewState, setPreviewState] = useState<{
    loading: boolean;
    series: ChartPoint[];
    stats: PreviewStats | null;
    notice: string | null;
  }>({ loading: false, series: [], stats: null, notice: null });
  const hydratedRef = useRef(false);
  const createdRef = useRef(false);

  const editQuery = useQuery({
    queryKey: ['conglomerate', draftId],
    queryFn: ({ signal }) => getConglomerate(draftId!, signal),
    enabled: mode === 'edit' && draftId !== null,
  });

  const createMutation = useMutation({
    mutationFn: () => createConglomerateDraft(title),
    onSuccess: (detail) => {
      setDraftId(detail.id);
      setTitle(detail.name);
      setPositions(positionsFromDetail(detail));
      hydratedRef.current = true;
      setSaveState('saved');
    },
    onError: () => setSaveState('error'),
  });

  const saveMutation = useMutation({
    mutationFn: (nextPositions: BuilderPosition[]) =>
      saveConglomeratePositions(
        draftId!,
        nextPositions.map((position) => ({
          assetId: position.assetId,
          weightPct: position.weightPct,
        })),
      ),
    onMutate: () => setSaveState('saving'),
    onSuccess: () => setSaveState('saved'),
    onError: () => setSaveState('error'),
  });

  const activateMutation = useMutation({
    mutationFn: () => activateConglomerate(draftId!),
    onSuccess: () => {
      setActivateError(null);
      setSaveState('saved');
    },
    onError: (error) => {
      setActivateError(error instanceof Error ? error.message : 'Activation failed.');
    },
  });

  useEffect(() => {
    if (mode !== 'new' || createdRef.current) return;
    createdRef.current = true;
    setSaveState('saving');
    createMutation.mutate();
  }, [createMutation, mode]);

  useEffect(() => {
    if (mode !== 'edit' || !editQuery.data || hydratedRef.current) return;
    setTitle(editQuery.data.name);
    setPositions(positionsFromDetail(editQuery.data));
    hydratedRef.current = true;
    setSaveState('saved');
  }, [editQuery.data, mode]);

  useEffect(() => {
    if (!draftId || !hydratedRef.current) return;
    saveMutation.mutate(positions);
  }, [draftId, positions]);

  useEffect(() => {
    if (!hydratedRef.current || positions.length === 0) {
      setPreviewState({ loading: false, series: [], stats: null, notice: null });
      return;
    }

    const controller = new AbortController();
    setPreviewState((current) => ({ ...current, loading: true }));
    const handle = window.setTimeout(() => {
      previewBacktest(
        previewRange,
        positions.map((position) => ({
          assetId: position.assetId,
          weightPct: position.weightPct,
        })),
        controller.signal,
      )
        .then((result) => {
          setPreviewState({
            loading: false,
            series: result.series.map((point) => ({ time: point.date, value: point.value })),
            stats: result.stats,
            notice: result.notice,
          });
        })
        .catch((error) => {
          if (error instanceof DOMException && error.name === 'AbortError') return;
          setPreviewState({
            loading: false,
            series: [],
            stats: null,
            notice: 'Preview failed. Adjust weights or try again.',
          });
        });
    }, PREVIEW_DEBOUNCE_MS);

    return () => {
      controller.abort();
      window.clearTimeout(handle);
    };
  }, [positions, previewRange]);

  const sumState = useMemo(() => sumPillState(positions), [positions]);
  const canActivate = draftId !== null && sumState.valid && positions.length > 0;

  function addPosition(item: Parameters<typeof positionFromSearchResult>[0]) {
    setNormalizeError(null);
    setActivateError(null);
    setPositions((current) => {
      if (current.some((position) => position.assetId === item.id)) return current;
      return [...current, positionFromSearchResult(item)];
    });
  }

  function changeWeight(localId: string, weightPct: number) {
    setNormalizeError(null);
    setActivateError(null);
    setPositions((current) => updatePositionWeight(current, localId, weightPct));
  }

  function toggleLocked(localId: string) {
    setNormalizeError(null);
    setPositions((current) =>
      current.map((position) =>
        position.localId === localId ? { ...position, locked: !position.locked } : position,
      ),
    );
  }

  function removePosition(localId: string) {
    setNormalizeError(null);
    setActivateError(null);
    setPositions((current) => current.filter((position) => position.localId !== localId));
  }

  function handleAutoBalance() {
    setNormalizeError(null);
    setActivateError(null);
    setPositions((current) => autoBalance(current));
  }

  function handleNormalize() {
    setActivateError(null);
    const result = normalizeWeights(positions);
    setNormalizeError(result.error);
    setPositions(result.positions);
  }

  if (mode === 'edit' && !id) return <Navigate to="/conglomerates" replace />;
  if (editQuery.isLoading) return <Spinner label="Loading Builder..." />;
  if (editQuery.isError) return <Alert tone="error">Could not load this Conglomerate.</Alert>;

  return (
    <section className="flex min-h-[calc(100vh-10rem)] flex-col gap-5" aria-label="Builder">
      <header className="flex flex-col gap-3 border-b border-neutral-800 pb-4 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="w-full bg-transparent text-2xl font-semibold text-neutral-100 outline-none focus:ring-2 focus:ring-sky-400"
            aria-label="Conglomerate name"
          />
          <p className="mt-1 text-sm text-neutral-500">
            {draftId ? `ID ${draftId}` : 'Creating draft...'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill state={saveState} />
          <Button onClick={() => activateMutation.mutate()} disabled={!canActivate}>
            {activateMutation.isPending ? 'Activating...' : 'Activate'}
          </Button>
        </div>
      </header>

      {normalizeError ? <Alert tone="error">{normalizeError}</Alert> : null}
      {activateError ? <Alert tone="error">{activateError}</Alert> : null}

      <div className="grid flex-1 gap-5 lg:grid-cols-[minmax(16rem,0.85fr)_minmax(24rem,1.4fr)_minmax(20rem,1fr)]">
        <aside className="flex flex-col gap-3 border-r border-neutral-800 pr-0 lg:pr-5">
          <h2 className="text-sm font-semibold uppercase text-neutral-500">Add assets</h2>
          <AssetSearchBox
            onSelect={addPosition}
            placeholder="Search assets to add..."
            autoFocus={mode === 'new'}
          />
        </aside>

        <main className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-neutral-100">Positions</h2>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={handleAutoBalance}>
                Auto-balance
              </Button>
              <Button variant="ghost" onClick={handleNormalize}>
                Normalize
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            {positions.length === 0 ? (
              <div className="rounded-md border border-dashed border-neutral-800 p-6 text-sm text-neutral-500">
                Add an asset from search to start the basket.
              </div>
            ) : (
              positions.map((position) => (
                <WeightRow
                  key={position.localId}
                  position={position}
                  onChangeWeight={changeWeight}
                  onToggleLocked={toggleLocked}
                  onRemove={removePosition}
                />
              ))
            )}
          </div>

          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-neutral-800 pt-4">
            <SumPill valid={sumState.valid} label={sumState.label} />
            <p className="text-xs text-neutral-500">
              Drafts save any total. Activation requires 100.0% within 0.01%.
            </p>
          </footer>
        </main>

        <aside className="flex min-w-0 flex-col gap-4 border-l border-neutral-800 pl-0 lg:pl-5">
          <h2 className="text-lg font-semibold text-neutral-100">Live preview</h2>
          <AllocationDonut
            data={positions.map((position) => ({
              label: position.symbol,
              value: position.weightPct,
            }))}
            size={180}
          />
          {previewState.notice ? <Alert tone="info">{previewState.notice}</Alert> : null}
          <PriceChart
            series={previewState.series}
            range={previewRange as unknown as PriceRange}
            ranges={PREVIEW_RANGES as unknown as readonly PriceRange[]}
            onRangeChange={(range) => {
              if (PREVIEW_RANGES.includes(range as BacktestPreviewRange)) {
                setPreviewRange(range as BacktestPreviewRange);
              }
            }}
            loading={previewState.loading}
            height={220}
            ariaLabel="Backtest preview"
          />
          <StatsStrip stats={previewState.stats} />
        </aside>
      </div>
    </section>
  );
}

function StatusPill({ state }: { state: 'idle' | 'saving' | 'saved' | 'error' }) {
  const label =
    state === 'saving'
      ? 'Draft - saving'
      : state === 'error'
        ? 'Draft - save failed'
        : state === 'saved'
          ? 'Draft — saved'
          : 'Draft';
  return (
    <span
      className={cx(
        'rounded-md px-2.5 py-1 text-xs font-medium ring-1 ring-inset',
        state === 'error'
          ? 'bg-red-950 text-red-300 ring-red-800'
          : 'bg-neutral-900 text-neutral-300 ring-neutral-700',
      )}
    >
      {label}
    </span>
  );
}

function SumPill({ valid, label }: { valid: boolean; label: string }) {
  return (
    <span
      className={cx(
        'rounded-md px-3 py-1.5 text-sm font-semibold tabular-nums ring-1 ring-inset',
        valid
          ? 'bg-emerald-950 text-emerald-300 ring-emerald-800'
          : 'bg-amber-950 text-amber-300 ring-amber-800',
      )}
    >
      {label}
    </span>
  );
}

function WeightRow({
  position,
  onChangeWeight,
  onToggleLocked,
  onRemove,
}: {
  position: BuilderPosition;
  onChangeWeight: (localId: string, weightPct: number) => void;
  onToggleLocked: (localId: string) => void;
  onRemove: (localId: string) => void;
}) {
  return (
    <div className="grid gap-3 rounded-md bg-neutral-900 p-3 ring-1 ring-inset ring-neutral-800 md:grid-cols-[minmax(10rem,1fr)_7rem_minmax(10rem,1fr)_auto_auto] md:items-center">
      <div className="min-w-0">
        <p className="truncate font-mono text-sm font-semibold text-neutral-100">
          {position.symbol}
        </p>
        <p className="truncate text-xs text-neutral-500">
          {position.name} · {position.currency}
        </p>
      </div>
      <input
        type="number"
        min="0"
        max="100"
        step="0.001"
        value={position.weightPct}
        onChange={(event) => onChangeWeight(position.localId, Number(event.target.value))}
        aria-label={`${position.symbol} weight input`}
        className="w-full rounded-md bg-neutral-950 px-2 py-1.5 text-sm tabular-nums text-neutral-100 ring-1 ring-inset ring-neutral-700 focus:outline-none focus:ring-2 focus:ring-sky-400"
      />
      <input
        type="range"
        min="0"
        max="100"
        step="0.5"
        value={position.weightPct}
        onChange={(event) => onChangeWeight(position.localId, Number(event.target.value))}
        aria-label={`${position.symbol} weight slider`}
        className="w-full accent-sky-500"
      />
      <button
        type="button"
        onClick={() => onToggleLocked(position.localId)}
        aria-label={`${position.locked ? 'Unlock' : 'Lock'} ${position.symbol}`}
        aria-pressed={position.locked}
        className={cx(
          'rounded-md px-2 py-1.5 text-sm ring-1 ring-inset focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
          position.locked
            ? 'bg-sky-950 text-sky-300 ring-sky-800'
            : 'bg-neutral-950 text-neutral-400 ring-neutral-700 hover:text-neutral-100',
        )}
      >
        {position.locked ? 'Locked' : 'Lock'}
      </button>
      <button
        type="button"
        onClick={() => onRemove(position.localId)}
        aria-label={`Remove ${position.symbol}`}
        className="rounded-md px-2 py-1.5 text-sm text-neutral-500 ring-1 ring-inset ring-neutral-700 hover:bg-red-950 hover:text-red-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        Remove
      </button>
    </div>
  );
}

function StatsStrip({ stats }: { stats: PreviewStats | null }) {
  const items = [
    { label: 'Return', value: stats ? formatSignedPercent(stats.totalReturnPct) : '-' },
    { label: 'CAGR', value: stats?.cagrPct == null ? '-' : formatSignedPercent(stats.cagrPct) },
    { label: 'Drawdown', value: stats ? formatSignedPercent(stats.maxDrawdownPct) : '-' },
  ];

  return (
    <div className="grid grid-cols-3 gap-2">
      {items.map((item) => (
        <div
          key={item.label}
          className="rounded-md bg-neutral-900 p-3 ring-1 ring-inset ring-neutral-800"
        >
          <p className="text-xs text-neutral-500">{item.label}</p>
          <p className="mt-1 text-sm font-semibold text-neutral-100">{item.value}</p>
        </div>
      ))}
    </div>
  );
}
