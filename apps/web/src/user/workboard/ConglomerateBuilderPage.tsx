import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import {
  MAX_NESTING_DEPTH,
  type ConglomerateStatus,
  type ConglomerateSummary,
  type ReplacePositionInput,
  type SearchResultItem,
} from '@bettertrack/contracts';

import { ApiError } from '../../lib/apiClient';
import {
  activateConglomerate,
  createConglomerate,
  getConglomerate,
  listConglomerates,
  replaceConglomeratePositions,
  updateConglomerate,
} from '../../lib/conglomerateApi';
import { cx } from '../../lib/cx';
import { formatPercent } from '../../lib/format';
import { useT } from '../../i18n';
import { AllocationDonut } from '../../ui/charts';
import { AssetSearchBox } from '../components/AssetSearchBox';
import { Alert, Button, Spinner } from '../components/ui';
import { useDebounce } from '../hooks/useDebounce';
import { NestedBadge, StatusBadge } from './ConglomeratesListPage';
import { SaveIdeaDialog } from './SaveIdeaDialog';
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
  positionFromConglomerate,
  positionFromSearchResult,
  roundWeight,
  sumWeights,
  WEIGHT_INPUT_STEP,
  WEIGHT_SLIDER_STEP,
  type BuilderPosition,
} from './conglomerateBuilder';
import { NlBuilderPanel } from './NlBuilderPanel';

/** Weight changes settle for this long before the live preview recomputes (§6.5). */
const PREVIEW_DEBOUNCE_MS = 500;
/** …and before the draft autosaves. */
const AUTOSAVE_DEBOUNCE_MS = 600;

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
  const t = useT();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['conglomerate', id],
    queryFn: ({ signal }) => getConglomerate(id, signal),
  });

  if (isLoading) {
    return (
      <BuilderFrame>
        <div className="grid flex-1 place-items-center">
          <Spinner label={t('workboard.builder.loading')} />
        </div>
      </BuilderFrame>
    );
  }

  if (isError || !data) {
    return (
      <BuilderFrame>
        <div className="mx-auto flex max-w-md flex-col gap-4 px-4 py-16">
          <Alert tone="error">{t('workboard.detail.loadError')}</Alert>
          <Link to="/workboard/conglomerates" className="text-sm text-sky-400 hover:underline">
            {t('workboard.detail.backToConglomeratesError')}
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
        positions: data.positions.map((p): BuilderPosition => {
          if (p.kind === 'conglomerate') {
            return {
              kind: 'conglomerate',
              refId: p.childId,
              symbol: p.child.name,
              name: p.child.name,
              weightPct: p.weightPct,
              locked: false,
            };
          }
          return {
            kind: 'asset',
            refId: p.assetId,
            symbol: p.asset.symbol,
            name: p.asset.name,
            currency: p.asset.currency,
            type: p.asset.type,
            weightPct: p.weightPct,
            locked: false,
          };
        }),
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

function positionsPayload(positions: readonly BuilderPosition[]): ReplacePositionInput[] {
  return persistablePositions(positions).map((p) =>
    p.kind === 'conglomerate'
      ? { childId: p.refId, weightPct: roundWeight(p.weightPct) }
      : { assetId: p.refId, weightPct: roundWeight(p.weightPct) },
  );
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
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const defaultName = t('workboard.builder.defaultName');

  const [name, setName] = useState(initial?.name ?? '');
  const [positions, setPositions] = useState<BuilderPosition[]>(initial?.positions ?? []);
  const [status, setStatus] = useState<ConglomerateStatus>(initial?.status ?? 'draft');
  // This basket's own id once it exists (immediately when editing, after the
  // first autosave when new) — the nest picker excludes it (self-nest, V5-P6).
  const [ownId, setOwnId] = useState<string | null>(initial?.id ?? null);
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
        const created = await createConglomerate({ name: trimmed || defaultName });
        id = created.id;
        idRef.current = id;
        setOwnId(id);
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
    [queryClient, defaultName],
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
  // A server-side nesting rejection (transitive cycle / depth cap, V5-P6) is
  // surfaced as a localized notice — the graph checks can only run server-side.
  useEffect(() => {
    if (debouncedKey === lastSavedKeyRef.current) return;
    setSaveState('saving');
    setSaveError(null);
    scheduleSave()
      .then(() => setSaveState('saved'))
      .catch((err: unknown) => {
        setSaveState('error');
        if (err instanceof ApiError) {
          if (err.code === 'NESTING_CYCLE') {
            setNotice(t('workboard.builder.errors.nestingCycle'));
          } else if (err.code === 'NESTING_TOO_DEEP') {
            setNotice(t('workboard.builder.errors.nestingTooDeep', { max: MAX_NESTING_DEPTH }));
          }
          setSaveError(err.message);
        } else {
          setSaveError(null);
        }
      });
  }, [debouncedKey, scheduleSave, t]);

  // ── Position editing ──

  const handleAddAsset = useCallback(
    (item: SearchResultItem) => {
      const check = canAddPosition(positionsRef.current, { kind: 'asset', refId: item.id });
      if (!check.ok) {
        setNotice(t(check.reason.key, check.reason.params));
        return;
      }
      setNotice(null);
      setPositions((prev) => [...prev, positionFromSearchResult(item)]);
    },
    [t],
  );

  const handleAddConglomerate = useCallback(
    (summary: ConglomerateSummary) => {
      const check = canAddPosition(
        positionsRef.current,
        { kind: 'conglomerate', refId: summary.id },
        idRef.current,
      );
      if (!check.ok) {
        setNotice(t(check.reason.key, check.reason.params));
        return;
      }
      setNotice(null);
      setPositions((prev) => [...prev, positionFromConglomerate(summary)]);
    },
    [t],
  );

  // AI draft (V5-P12): prefill the Builder with the resolved lines. It replaces
  // the current positions with the draft; the user then reviews the weights,
  // edits, and explicitly saves/activates — nothing auto-commits.
  const handleApplyDraft = useCallback((drafted: BuilderPosition[]) => {
    setNotice(null);
    setPositions(drafted);
  }, []);

  const setWeight = useCallback((refId: string, weightPct: number) => {
    setPositions((prev) =>
      prev.map((p) => (p.refId === refId ? { ...p, weightPct: clampWeight(weightPct) } : p)),
    );
  }, []);

  const toggleLock = useCallback((refId: string) => {
    setPositions((prev) => prev.map((p) => (p.refId === refId ? { ...p, locked: !p.locked } : p)));
  }, []);

  const removePosition = useCallback((refId: string) => {
    setNotice(null);
    setPositions((prev) => prev.filter((p) => p.refId !== refId));
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
      setActivateError(t('workboard.builder.activateValidationError'));
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
        err instanceof ApiError ? err.message : t('workboard.builder.activateError'),
      );
    } finally {
      setActivating(false);
    }
  }, [navigate, queryClient, scheduleSave, t]);

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
        <AddAssetsPanel
          notice={notice}
          onSelect={handleAddAsset}
          onSelectConglomerate={handleAddConglomerate}
          onApplyDraft={handleApplyDraft}
          ownId={ownId}
          positions={positions}
        />
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
  const t = useT();
  return (
    <header className="border-b border-neutral-800 bg-neutral-900/70">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Link
            to="/workboard/conglomerates"
            aria-label={t('workboard.builder.closeAriaLabel')}
            className="shrink-0 rounded px-2 py-1 text-sm text-neutral-500 hover:text-neutral-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          >
            ✕
          </Link>
          <input
            type="text"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder={t('workboard.builder.defaultName')}
            aria-label={t('workboard.builder.nameAriaLabel')}
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
                ? t('workboard.builder.activatableHint')
                : t('workboard.builder.notActivatableHint')
            }
          >
            {activating
              ? t('workboard.builder.activating')
              : status === 'active'
                ? t('workboard.builder.reactivate')
                : t('workboard.builder.activate')}
          </Button>
        </div>
      </div>
    </header>
  );
}

function SavePill({ state, error }: { state: SaveState; error: string | null }) {
  const t = useT();
  const base =
    'inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset';
  if (state === 'saving') {
    return (
      <span className={cx(base, 'bg-neutral-800 text-neutral-300 ring-neutral-700')}>
        {t('workboard.builder.saving')}
      </span>
    );
  }
  if (state === 'error') {
    return (
      <span
        className={cx(base, 'bg-red-950/60 text-red-300 ring-red-800')}
        title={error ?? undefined}
      >
        {t('workboard.builder.saveFailed')}
      </span>
    );
  }
  if (state === 'saved') {
    return (
      <span className={cx(base, 'bg-emerald-950/60 text-emerald-300 ring-emerald-800')}>
        {t('workboard.builder.draftSaved')}
      </span>
    );
  }
  return (
    <span className={cx(base, 'bg-neutral-800 text-neutral-500 ring-neutral-700')}>
      {t('workboard.builder.draftIdle')}
    </span>
  );
}

// ─── Left: add assets ────────────────────────────────────────────────────────

function AddAssetsPanel({
  notice,
  onSelect,
  onSelectConglomerate,
  onApplyDraft,
  ownId,
  positions,
}: {
  notice: string | null;
  onSelect: (item: SearchResultItem) => void;
  onSelectConglomerate: (summary: ConglomerateSummary) => void;
  onApplyDraft: (positions: BuilderPosition[]) => void;
  ownId: string | null;
  positions: BuilderPosition[];
}) {
  const t = useT();
  return (
    <section aria-labelledby="add-assets-heading" className="flex flex-col gap-3">
      <h2
        id="add-assets-heading"
        className="text-sm font-semibold uppercase tracking-wide text-neutral-400"
      >
        {t('workboard.builder.addAssetsHeading')}
      </h2>
      <p className="text-xs text-neutral-500">{t('workboard.builder.addAssetsHint')}</p>
      {notice ? <Alert tone="error">{notice}</Alert> : null}
      <AssetSearchBox onSelect={onSelect} placeholder={t('workboard.builder.searchPlaceholder')} />
      <NlBuilderPanel onApply={onApplyDraft} />
      <NestConglomeratePanel onSelect={onSelectConglomerate} ownId={ownId} positions={positions} />
    </section>
  );
}

/**
 * Nest one of the user's own conglomerates as a constituent (V5-P6). Folded
 * away by default (anti-bloat): a compact disclosure listing the other
 * baskets; already-added ones and the basket itself are excluded. Transitive
 * cycle / depth-cap rejections come from the server on save.
 */
function NestConglomeratePanel({
  onSelect,
  ownId,
  positions,
}: {
  onSelect: (summary: ConglomerateSummary) => void;
  ownId: string | null;
  positions: BuilderPosition[];
}) {
  const t = useT();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['conglomerates'],
    queryFn: ({ signal }) => listConglomerates(signal),
  });

  const nested = new Set(positions.filter((p) => p.kind === 'conglomerate').map((p) => p.refId));
  const candidates = (data?.conglomerates ?? []).filter((c) => c.id !== ownId && !nested.has(c.id));

  return (
    <details className="rounded-lg border border-neutral-800 bg-neutral-900/30">
      <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium text-neutral-300 hover:text-neutral-100">
        {t('workboard.builder.nestConglomerateHeading')}
      </summary>
      <div className="flex flex-col gap-2 border-t border-neutral-800 p-3">
        <p className="text-xs text-neutral-500">{t('workboard.builder.nestConglomerateHint')}</p>
        {isLoading ? (
          <Spinner label={t('workboard.builder.loading')} />
        ) : isError ? (
          <Alert tone="error">{t('workboard.builder.nestConglomerateLoadError')}</Alert>
        ) : candidates.length === 0 ? (
          <p className="text-xs text-neutral-500">{t('workboard.builder.nestConglomerateEmpty')}</p>
        ) : (
          <ul
            className="flex flex-col gap-1"
            aria-label={t('workboard.builder.nestConglomerateListAriaLabel')}
          >
            {candidates.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onSelect(c)}
                  aria-label={t('workboard.builder.nestConglomerateAddAriaLabel', {
                    name: c.name,
                  })}
                  className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm text-neutral-200 hover:bg-neutral-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
                >
                  <span className="min-w-0 truncate" title={c.name}>
                    {c.name}
                  </span>
                  <span className="shrink-0 text-xs text-neutral-500">
                    {c.positionCount === 1
                      ? t('workboard.conglomerates.positionCountOne', { count: c.positionCount })
                      : t('workboard.conglomerates.positionCountOther', {
                          count: c.positionCount,
                        })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
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
  onWeight: (refId: string, weightPct: number) => void;
  onToggleLock: (refId: string) => void;
  onRemove: (refId: string) => void;
  onAutoBalance: () => void;
  onNormalize: () => void;
}) {
  const t = useT();
  return (
    <section aria-labelledby="positions-heading" className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2
          id="positions-heading"
          className="text-sm font-semibold uppercase tracking-wide text-neutral-400"
        >
          {t('workboard.builder.positionsHeading')}
        </h2>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onAutoBalance} disabled={positions.length === 0}>
            {t('workboard.builder.autoBalance')}
          </Button>
          <Button variant="secondary" onClick={onNormalize} disabled={positions.length === 0}>
            {t('workboard.builder.normalize')}
          </Button>
        </div>
      </div>

      {positions.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-800 bg-neutral-900/30 p-8 text-center text-sm text-neutral-500">
          {t('workboard.builder.noPositionsMessage')}
        </div>
      ) : (
        <ul
          className="flex flex-col gap-2"
          aria-label={t('workboard.builder.positionsListAriaLabel')}
        >
          {positions.map((position) => (
            <WeightRow
              key={`${position.kind}:${position.refId}`}
              position={position}
              onWeight={(w) => onWeight(position.refId, w)}
              onToggleLock={() => onToggleLock(position.refId)}
              onRemove={() => onRemove(position.refId)}
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
  const t = useT();
  const { symbol, name, weightPct, locked } = position;
  const [draft, setDraft] = useState(String(weightPct));

  useEffect(() => {
    if (draft === '' || Number(draft) === weightPct) return;
    setDraft(String(weightPct));
  }, [weightPct, draft]);

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-neutral-800 bg-neutral-900/40 p-3 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2">
          <span className="truncate font-mono text-sm font-semibold text-neutral-100">
            {symbol}
          </span>
          {position.kind === 'conglomerate' ? <NestedBadge /> : null}
        </span>
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
          aria-label={t('workboard.builder.weightSliderAriaLabel', { symbol })}
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
            aria-label={t('workboard.builder.weightAriaLabel', { symbol })}
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
          aria-label={
            locked
              ? t('workboard.builder.unlockAriaLabel', { symbol })
              : t('workboard.builder.lockAriaLabel', { symbol })
          }
          title={locked ? t('workboard.builder.lockedTitle') : t('workboard.builder.lockTitle')}
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
          aria-label={t('workboard.builder.removeAriaLabel', { symbol })}
          className="rounded px-2 py-1 text-sm text-neutral-500 hover:bg-neutral-800 hover:text-red-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          ✕
        </button>
      </div>
    </li>
  );
}

function PositionsFooter({ positions }: { positions: BuilderPosition[] }) {
  const t = useT();
  return (
    <div className="flex items-center justify-between rounded-lg border border-neutral-800 bg-neutral-900/60 px-4 py-3">
      <span className="text-xs text-neutral-500">
        {t('workboard.builder.positionsCount', { count: positions.length, max: MAX_POSITIONS })}
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
  const t = useT();
  const sum = sumWeights(positions);
  const valid = isSumValid(positions);
  const remaining = roundWeight(ACTIVE_SUM - sum);

  if (valid) {
    return (
      <span
        role="status"
        className="inline-flex items-center rounded-full bg-emerald-950/60 px-3 py-1 text-sm font-semibold text-emerald-300 ring-1 ring-inset ring-emerald-800"
      >
        {formatPercent(ACTIVE_SUM)}
      </span>
    );
  }

  const tail =
    remaining >= 0
      ? t('workboard.builder.sumRemainingLeft', { value: formatPercent(remaining) })
      : t('workboard.builder.sumRemainingOver', { value: formatPercent(Math.abs(remaining)) });
  return (
    <span
      role="status"
      className="inline-flex items-center rounded-full bg-amber-950/60 px-3 py-1 text-sm font-semibold text-amber-300 ring-1 ring-inset ring-amber-800"
    >
      {formatPercent(sum)} — {tail}
    </span>
  );
}

// ─── Right: live preview ─────────────────────────────────────────────────────

function LivePreviewPanel({ positions }: { positions: BuilderPosition[] }) {
  const t = useT();
  const [saveIdeaOpen, setSaveIdeaOpen] = useState(false);
  const live = persistablePositions(positions);
  const hasNested = live.some((p) => p.kind === 'conglomerate');
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
        {t('workboard.builder.livePreviewHeading')}
      </h2>

      <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
        <AllocationDonut
          data={donutData}
          size={180}
          title={t('workboard.detail.allocationChartTitle')}
        />
      </div>

      <dl className="grid grid-cols-3 gap-2">
        <Stat label={t('workboard.builder.statPositions')} value={String(live.length)} />
        <Stat label={t('workboard.builder.statTotalWeight')} value={formatPercent(total)} />
        <Stat
          label={t('workboard.builder.statLargest')}
          value={largest ? `${largest.symbol} ${formatPercent(largest.weightPct)}` : '—'}
        />
      </dl>

      <div
        aria-label={t('workboard.builder.backtestPreviewAriaLabel')}
        className="rounded-lg border border-dashed border-neutral-800 bg-neutral-900/30 p-6 text-center text-sm text-neutral-500"
      >
        {t('workboard.builder.backtestPreviewText')}
      </div>

      {/* Save the (unsaved) ad-hoc basket as an idea (V4-P9): an idea keeps the
          weighted set verbatim, so a basket can be parked without persisting a
          conglomerate. Default backtest params; tune them after reopening.
          An ad-hoc idea holds asset weights only, so a basket with nested
          conglomerates (V5-P6) can't be parked this way — save the basket
          itself instead. */}
      <Button
        variant="secondary"
        onClick={() => setSaveIdeaOpen(true)}
        disabled={live.length === 0 || hasNested}
        title={hasNested ? t('workboard.builder.saveIdeaNestedHint') : undefined}
      >
        {t('workboard.ideas.save.action')}
      </Button>

      {saveIdeaOpen ? (
        <SaveIdeaDialog
          state={{
            source: {
              kind: 'adhoc',
              positions: live
                .filter((p) => p.kind === 'asset')
                .map((p) => ({ assetId: p.refId, weight: p.weightPct })),
            },
            range: '5Y',
            benchmark: null,
            mode: 'clip',
            rebalance: 'none',
          }}
          onClose={() => setSaveIdeaOpen(false)}
        />
      ) : null}
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
