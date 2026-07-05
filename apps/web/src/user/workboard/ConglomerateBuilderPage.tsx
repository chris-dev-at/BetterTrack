import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import type { ConglomerateStatus, SearchResultItem } from '@bettertrack/contracts';

import { ApiError } from '../../lib/apiClient';
import {
  activateConglomerate,
  createConglomerate,
  getConglomerate,
  replaceConglomeratePositions,
  updateConglomerate,
} from '../../lib/conglomerateApi';
import { cx } from '../../lib/cx';
import { AllocationDonut } from '../../ui/charts';
import { AssetSearchBox } from '../components/AssetSearchBox';
import { Alert, Button, Spinner } from '../components/ui';
import { useDebounce } from '../hooks/useDebounce';
import { StatusBadge } from './ConglomeratesListPage';
import {
  ACTIVE_SUM,
  autoBalance,
  canActivate,
  canAddPosition,
  clampWeight,
  isSumValid,
  MAX_POSITIONS,
  normalize,
  persistablePositions,
  positionFromSearchResult,
  roundWeight,
  sumWeights,
  WEIGHT_INPUT_STEP,
  WEIGHT_SLIDER_STEP,
  type BuilderPosition,
} from './conglomerateBuilder';

/** Weight changes settle for this long before the live preview recomputes (§6.5). */
const PREVIEW_DEBOUNCE_MS = 500;
/** …and before the draft autosaves. */
const AUTOSAVE_DEBOUNCE_MS = 600;
/** Name a `new` draft is created under before the user provides one. */
const DEFAULT_NAME = 'Untitled conglomerate';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

// ─── Route entry ─────────────────────────────────────────────────────────────

/**
 * The Conglomerate **Builder** (PROJECTPLAN.md §6.5, §7.2) — the full-screen
 * create/edit experience mounted at `/workboard/conglomerates/new` and
 * `…/:id/edit`. `/new` starts from a blank basket; `/:id/edit` loads the draft
 * (or active) Conglomerate first, then hands its positions to the same Builder.
 */
export function ConglomerateBuilderPage() {
  const { id } = useParams<{ id: string }>();
  if (id) return <EditBuilderLoader id={id} />;
  return <Builder initial={null} />;
}

function EditBuilderLoader({ id }: { id: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['conglomerate', id],
    queryFn: ({ signal }) => getConglomerate(id, signal),
  });

  if (isLoading) {
    return (
      <BuilderFrame>
        <div className="grid flex-1 place-items-center">
          <Spinner label="Loading the Builder…" />
        </div>
      </BuilderFrame>
    );
  }

  if (isError || !data) {
    return (
      <BuilderFrame>
        <div className="mx-auto flex max-w-md flex-col gap-4 px-4 py-16">
          <Alert tone="error">
            Could not load this Conglomerate. It may not exist or the server is temporarily
            unavailable.
          </Alert>
          <Link to="/workboard/conglomerates" className="text-sm text-sky-400 hover:underline">
            ← Back to Conglomerates
          </Link>
        </div>
      </BuilderFrame>
    );
  }

  return (
    <Builder
      key={id}
      initial={{
        id: data.id,
        name: data.name,
        status: data.status,
        positions: data.positions.map((p) => ({
          assetId: p.assetId,
          symbol: p.asset.symbol,
          name: p.asset.name,
          currency: p.asset.currency,
          type: p.asset.type,
          weightPct: p.weightPct,
          locked: false,
        })),
      }}
    />
  );
}

interface BuilderInitial {
  id: string;
  name: string;
  status: ConglomerateStatus;
  positions: BuilderPosition[];
}

// ─── Snapshot helpers (autosave diffing) ─────────────────────────────────────

interface PayloadPosition {
  assetId: string;
  weightPct: number;
}

function positionsPayload(positions: readonly BuilderPosition[]): PayloadPosition[] {
  return persistablePositions(positions).map((p) => ({
    assetId: p.assetId,
    weightPct: roundWeight(p.weightPct),
  }));
}

function positionsKey(positions: readonly BuilderPosition[]): string {
  return JSON.stringify(positionsPayload(positions));
}

function snapshotKey(name: string, positions: readonly BuilderPosition[]): string {
  return JSON.stringify({ name: name.trim(), positions: positionsPayload(positions) });
}

function hasMeaningfulContent(name: string, positions: readonly BuilderPosition[]): boolean {
  return name.trim().length > 0 || positions.length > 0;
}

// ─── Builder ─────────────────────────────────────────────────────────────────

function Builder({ initial }: { initial: BuilderInitial | null }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [name, setName] = useState(initial?.name ?? '');
  const [positions, setPositions] = useState<BuilderPosition[]>(initial?.positions ?? []);
  const [status, setStatus] = useState<ConglomerateStatus>(initial?.status ?? 'draft');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [activateError, setActivateError] = useState<string | null>(null);
  const [activating, setActivating] = useState(false);

  // Latest state, readable inside the async save chain without re-subscribing.
  const nameRef = useRef(name);
  nameRef.current = name;
  const positionsRef = useRef(positions);
  positionsRef.current = positions;

  // Persistence bookkeeping: the id (null until the first save creates the draft)
  // and what the server currently holds, so autosave only writes real diffs.
  const idRef = useRef<string | null>(initial?.id ?? null);
  const savedNameRef = useRef<string>(initial?.name ?? '');
  const savedPositionsKeyRef = useRef<string>(positionsKey(initial?.positions ?? []));
  const lastSavedKeyRef = useRef<string>(
    snapshotKey(initial?.name ?? '', initial?.positions ?? []),
  );
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());

  /** Persist name + positions to the draft, creating it on the first write (§6.5). */
  const persistSnapshot = useCallback(
    async (rawName: string, currentPositions: readonly BuilderPosition[]) => {
      const trimmed = rawName.trim();
      const payload = positionsPayload(currentPositions);

      let id = idRef.current;
      if (!id) {
        const created = await createConglomerate({ name: trimmed || DEFAULT_NAME });
        id = created.id;
        idRef.current = id;
        savedNameRef.current = created.name;
        savedPositionsKeyRef.current = JSON.stringify([]);
        setStatus(created.status);
        void queryClient.invalidateQueries({ queryKey: ['conglomerates'] });
      }

      if (trimmed && trimmed !== savedNameRef.current) {
        const updated = await updateConglomerate(id, { name: trimmed });
        savedNameRef.current = updated.name;
      }

      const payloadKey = JSON.stringify(payload);
      if (payloadKey !== savedPositionsKeyRef.current) {
        await replaceConglomeratePositions(id, payload);
        savedPositionsKeyRef.current = payloadKey;
      }
    },
    [queryClient],
  );

  /**
   * Serialised save: each call chains after the previous one and, when it runs,
   * drains to the *latest* state — so overlapping edits collapse into the right
   * final write instead of racing. Resolves once the current snapshot is stored.
   */
  const scheduleSave = useCallback((): Promise<void> => {
    const next = saveChainRef.current.then(async () => {
      const currentName = nameRef.current;
      const currentPositions = positionsRef.current;
      const key = snapshotKey(currentName, currentPositions);
      if (key === lastSavedKeyRef.current) return;
      if (!hasMeaningfulContent(currentName, currentPositions)) return;
      await persistSnapshot(currentName, currentPositions);
      lastSavedKeyRef.current = key;
    });
    saveChainRef.current = next.catch(() => {});
    return next;
  }, [persistSnapshot]);

  const currentKey = useMemo(() => snapshotKey(name, positions), [name, positions]);
  const debouncedKey = useDebounce(currentKey, AUTOSAVE_DEBOUNCE_MS);

  // Autosave whenever the debounced snapshot diverges from what's stored.
  useEffect(() => {
    if (debouncedKey === lastSavedKeyRef.current) return;
    setSaveState('saving');
    setSaveError(null);
    scheduleSave()
      .then(() => setSaveState('saved'))
      .catch((err: unknown) => {
        setSaveState('error');
        setSaveError(err instanceof ApiError ? err.message : null);
      });
  }, [debouncedKey, scheduleSave]);

  // ── Position editing ──

  const handleAddAsset = useCallback((item: SearchResultItem) => {
    const check = canAddPosition(positionsRef.current, item.id);
    if (!check.ok) {
      setNotice(check.reason);
      return;
    }
    setNotice(null);
    setPositions((prev) => [...prev, positionFromSearchResult(item)]);
  }, []);

  const setWeight = useCallback((assetId: string, weightPct: number) => {
    setPositions((prev) =>
      prev.map((p) => (p.assetId === assetId ? { ...p, weightPct: clampWeight(weightPct) } : p)),
    );
  }, []);

  const toggleLock = useCallback((assetId: string) => {
    setPositions((prev) =>
      prev.map((p) => (p.assetId === assetId ? { ...p, locked: !p.locked } : p)),
    );
  }, []);

  const removePosition = useCallback((assetId: string) => {
    setNotice(null);
    setPositions((prev) => prev.filter((p) => p.assetId !== assetId));
  }, []);

  const handleAutoBalance = useCallback(() => {
    setNotice(null);
    setPositions((prev) => autoBalance(prev));
  }, []);

  const handleNormalize = useCallback(() => {
    const result = normalize(positionsRef.current);
    if (!result.ok) {
      setNotice(result.error);
      return;
    }
    setNotice(null);
    setPositions(result.positions);
  }, []);

  // ── Activate ──

  const activatable = canActivate(positions);

  const handleActivate = useCallback(async () => {
    setActivateError(null);
    if (!canActivate(positionsRef.current)) {
      setActivateError(
        'Weights must sum to 100% (±0.01) with every position above 0 before activating.',
      );
      return;
    }
    setActivating(true);
    try {
      await scheduleSave(); // flush the latest edits before flipping status
      const id = idRef.current;
      if (!id) throw new Error('The draft has not been saved yet.');
      const detail = await activateConglomerate(id);
      setStatus(detail.status);
      void queryClient.invalidateQueries({ queryKey: ['conglomerates'] });
      void queryClient.invalidateQueries({ queryKey: ['conglomerate', id] });
      navigate(`/workboard/conglomerates/${id}`);
    } catch (err) {
      setActivateError(
        err instanceof ApiError
          ? err.message
          : 'Could not activate this Conglomerate. Please try again.',
      );
    } finally {
      setActivating(false);
    }
  }, [navigate, queryClient, scheduleSave]);

  // ── Live preview (debounced) ──

  const previewPositions = useDebounce(positions, PREVIEW_DEBOUNCE_MS);

  return (
    <BuilderFrame>
      <BuilderHeader
        name={name}
        onNameChange={setName}
        status={status}
        saveState={saveState}
        saveError={saveError}
        activatable={activatable}
        activating={activating}
        onActivate={() => void handleActivate()}
      />

      {activateError ? (
        <div className="mx-auto w-full max-w-7xl px-4 pt-4">
          <Alert tone="error">{activateError}</Alert>
        </div>
      ) : null}

      <div className="mx-auto grid w-full max-w-7xl flex-1 grid-cols-1 gap-6 px-4 py-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)_minmax(0,22rem)]">
        <AddAssetsPanel notice={notice} onSelect={handleAddAsset} />
        <PositionsPanel
          positions={positions}
          onWeight={setWeight}
          onToggleLock={toggleLock}
          onRemove={removePosition}
          onAutoBalance={handleAutoBalance}
          onNormalize={handleNormalize}
        />
        <LivePreviewPanel positions={previewPositions} />
      </div>
    </BuilderFrame>
  );
}

// ─── Frame + header ──────────────────────────────────────────────────────────

function BuilderFrame({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen flex-col bg-[#0b0e14] text-neutral-100">{children}</div>;
}

function BuilderHeader({
  name,
  onNameChange,
  status,
  saveState,
  saveError,
  activatable,
  activating,
  onActivate,
}: {
  name: string;
  onNameChange: (value: string) => void;
  status: ConglomerateStatus;
  saveState: SaveState;
  saveError: string | null;
  activatable: boolean;
  activating: boolean;
  onActivate: () => void;
}) {
  return (
    <header className="border-b border-neutral-800 bg-neutral-900/70">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Link
            to="/workboard/conglomerates"
            aria-label="Close the Builder"
            className="shrink-0 rounded px-2 py-1 text-sm text-neutral-500 hover:text-neutral-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          >
            ✕
          </Link>
          <input
            type="text"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="Untitled conglomerate"
            aria-label="Conglomerate name"
            className="min-w-0 flex-1 rounded-md bg-transparent px-2 py-1.5 text-lg font-semibold text-neutral-100 ring-1 ring-inset ring-transparent placeholder:text-neutral-600 hover:ring-neutral-700 focus:outline-none focus:ring-2 focus:ring-sky-500"
          />
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <StatusBadge status={status} />
          <SavePill state={saveState} error={saveError} />
          <Button
            variant="primary"
            onClick={onActivate}
            disabled={!activatable || activating}
            title={
              activatable
                ? 'Active = your live, validated basket used by the calculator; must sum to 100%.'
                : 'Weights must sum to 100% (±0.01) before activating.'
            }
          >
            {activating ? 'Activating…' : status === 'active' ? 'Re-activate' : 'Activate'}
          </Button>
        </div>
      </div>
    </header>
  );
}

function SavePill({ state, error }: { state: SaveState; error: string | null }) {
  const base =
    'inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset';
  if (state === 'saving') {
    return (
      <span className={cx(base, 'bg-neutral-800 text-neutral-300 ring-neutral-700')}>Saving…</span>
    );
  }
  if (state === 'error') {
    return (
      <span
        className={cx(base, 'bg-red-950/60 text-red-300 ring-red-800')}
        title={error ?? undefined}
      >
        Save failed
      </span>
    );
  }
  if (state === 'saved') {
    return (
      <span className={cx(base, 'bg-emerald-950/60 text-emerald-300 ring-emerald-800')}>
        Draft — saved
      </span>
    );
  }
  return (
    <span className={cx(base, 'bg-neutral-800 text-neutral-500 ring-neutral-700')}>Draft</span>
  );
}

// ─── Left: add assets ────────────────────────────────────────────────────────

function AddAssetsPanel({
  notice,
  onSelect,
}: {
  notice: string | null;
  onSelect: (item: SearchResultItem) => void;
}) {
  return (
    <section aria-labelledby="add-assets-heading" className="flex flex-col gap-3">
      <h2
        id="add-assets-heading"
        className="text-sm font-semibold uppercase tracking-wide text-neutral-400"
      >
        Add assets
      </h2>
      <p className="text-xs text-neutral-500">Search and click a result to add it at weight 0.</p>
      {notice ? <Alert tone="error">{notice}</Alert> : null}
      <AssetSearchBox onSelect={onSelect} placeholder="Search stocks, ETFs, indices…" />
    </section>
  );
}

// ─── Center: positions ───────────────────────────────────────────────────────

function PositionsPanel({
  positions,
  onWeight,
  onToggleLock,
  onRemove,
  onAutoBalance,
  onNormalize,
}: {
  positions: BuilderPosition[];
  onWeight: (assetId: string, weightPct: number) => void;
  onToggleLock: (assetId: string) => void;
  onRemove: (assetId: string) => void;
  onAutoBalance: () => void;
  onNormalize: () => void;
}) {
  return (
    <section aria-labelledby="positions-heading" className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2
          id="positions-heading"
          className="text-sm font-semibold uppercase tracking-wide text-neutral-400"
        >
          Positions
        </h2>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onAutoBalance} disabled={positions.length === 0}>
            Auto-balance
          </Button>
          <Button variant="secondary" onClick={onNormalize} disabled={positions.length === 0}>
            Normalize
          </Button>
        </div>
      </div>

      {positions.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-800 bg-neutral-900/30 p-8 text-center text-sm text-neutral-500">
          No positions yet. Search on the left and click an asset to add it.
        </div>
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Conglomerate positions">
          {positions.map((position) => (
            <WeightRow
              key={position.assetId}
              position={position}
              onWeight={(w) => onWeight(position.assetId, w)}
              onToggleLock={() => onToggleLock(position.assetId)}
              onRemove={() => onRemove(position.assetId)}
            />
          ))}
        </ul>
      )}

      <PositionsFooter positions={positions} />
    </section>
  );
}

/**
 * One editable position (§6.5): symbol/name, a 0.001-precision number input and
 * a 0–100 slider (step 0.5) kept in sync, a lock toggle, and remove. The number
 * field keeps a local draft string so decimals can be typed without the parsed
 * value fighting the caret; it re-syncs when the weight changes elsewhere
 * (slider, auto-balance, normalize).
 */
export function WeightRow({
  position,
  onWeight,
  onToggleLock,
  onRemove,
}: {
  position: BuilderPosition;
  onWeight: (weightPct: number) => void;
  onToggleLock: () => void;
  onRemove: () => void;
}) {
  const { symbol, name, weightPct, locked } = position;
  const [draft, setDraft] = useState(String(weightPct));

  useEffect(() => {
    if (draft === '' || Number(draft) === weightPct) return;
    setDraft(String(weightPct));
  }, [weightPct, draft]);

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-neutral-800 bg-neutral-900/40 p-3 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="font-mono text-sm font-semibold text-neutral-100">{symbol}</span>
        <span className="truncate text-xs text-neutral-500" title={name}>
          {name}
        </span>
      </div>

      <div className="flex flex-1 items-center gap-3">
        <input
          type="range"
          min={0}
          max={100}
          step={WEIGHT_SLIDER_STEP}
          value={weightPct}
          onChange={(e) => onWeight(Number(e.target.value))}
          aria-label={`Weight slider for ${symbol}`}
          className="min-w-0 flex-1 accent-sky-500"
        />
        <div className="flex items-center gap-1">
          <input
            type="number"
            min={0}
            max={100}
            step={WEIGHT_INPUT_STEP}
            value={draft}
            onChange={(e) => {
              const raw = e.target.value;
              setDraft(raw);
              if (raw === '') return;
              const parsed = Number(raw);
              if (Number.isFinite(parsed)) onWeight(parsed);
            }}
            aria-label={`Weight for ${symbol}`}
            className="w-20 rounded-md bg-neutral-950 px-2 py-1.5 text-right text-sm tabular-nums text-neutral-100 ring-1 ring-inset ring-neutral-700 focus:outline-none focus:ring-2 focus:ring-sky-500"
          />
          <span aria-hidden="true" className="text-sm text-neutral-500">
            %
          </span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onToggleLock}
          aria-pressed={locked}
          aria-label={`${locked ? 'Unlock' : 'Lock'} ${symbol}`}
          title={locked ? 'Locked — untouched by auto-balance / normalize' : 'Lock this weight'}
          className={cx(
            'rounded px-2 py-1 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
            locked
              ? 'bg-amber-950/60 text-amber-300 ring-1 ring-inset ring-amber-800'
              : 'text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200',
          )}
        >
          {locked ? '🔒' : '🔓'}
        </button>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${symbol}`}
          className="rounded px-2 py-1 text-sm text-neutral-500 hover:bg-neutral-800 hover:text-red-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          ✕
        </button>
      </div>
    </li>
  );
}

function PositionsFooter({ positions }: { positions: BuilderPosition[] }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-neutral-800 bg-neutral-900/60 px-4 py-3">
      <span className="text-xs text-neutral-500">
        {positions.length} / {MAX_POSITIONS} positions
      </span>
      <SumPill positions={positions} />
    </div>
  );
}

/**
 * The live sum pill (§6.5): green "100.0%" when Σ = 100 ± 0.01, otherwise amber
 * with the remaining "% left" (or "% over" when past 100).
 */
export function SumPill({ positions }: { positions: BuilderPosition[] }) {
  const sum = sumWeights(positions);
  const valid = isSumValid(positions);
  const remaining = roundWeight(ACTIVE_SUM - sum);

  if (valid) {
    return (
      <span
        role="status"
        className="inline-flex items-center rounded-full bg-emerald-950/60 px-3 py-1 text-sm font-semibold text-emerald-300 ring-1 ring-inset ring-emerald-800"
      >
        100.0%
      </span>
    );
  }

  const tail =
    remaining >= 0 ? `${remaining.toFixed(1)}% left` : `${Math.abs(remaining).toFixed(1)}% over`;
  return (
    <span
      role="status"
      className="inline-flex items-center rounded-full bg-amber-950/60 px-3 py-1 text-sm font-semibold text-amber-300 ring-1 ring-inset ring-amber-800"
    >
      {sum.toFixed(1)}% — {tail}
    </span>
  );
}

// ─── Right: live preview ─────────────────────────────────────────────────────

function LivePreviewPanel({ positions }: { positions: BuilderPosition[] }) {
  const live = persistablePositions(positions);
  const donutData = live.map((p) => ({ label: p.symbol, value: p.weightPct }));
  const total = sumWeights(positions);
  const largest = live.reduce<BuilderPosition | null>(
    (max, p) => (max === null || p.weightPct > max.weightPct ? p : max),
    null,
  );

  return (
    <section aria-labelledby="preview-heading" className="flex flex-col gap-3">
      <h2
        id="preview-heading"
        className="text-sm font-semibold uppercase tracking-wide text-neutral-400"
      >
        Live preview
      </h2>

      <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
        <AllocationDonut data={donutData} size={180} title="Conglomerate allocation" />
      </div>

      <dl className="grid grid-cols-3 gap-2">
        <Stat label="Positions" value={String(live.length)} />
        <Stat label="Total weight" value={`${total.toFixed(1)}%`} />
        <Stat
          label="Largest"
          value={largest ? `${largest.symbol} ${largest.weightPct.toFixed(1)}%` : '—'}
        />
      </dl>

      <div
        aria-label="Backtest preview (coming soon)"
        className="rounded-lg border border-dashed border-neutral-800 bg-neutral-900/30 p-6 text-center text-sm text-neutral-500"
      >
        Backtest preview — coming with the backtest panel.
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-3">
      <dt className="text-xs text-neutral-500">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-semibold text-neutral-100" title={value}>
        {value}
      </dd>
    </div>
  );
}
