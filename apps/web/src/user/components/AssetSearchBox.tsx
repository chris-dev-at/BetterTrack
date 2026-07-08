import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import type { ConglomerateSummary, SearchResultItem } from '@bettertrack/contracts';
import { ApiError } from '../../lib/apiClient';
import {
  getConglomerate,
  listConglomerates,
  replaceConglomeratePositions,
} from '../../lib/conglomerateApi';
import { cx } from '../../lib/cx';
import { listPortfolios } from '../../lib/portfolioApi';
import { searchAssets } from '../../lib/searchApi';
import { addToWorkboard, listWorkboard } from '../../lib/workboardApi';
import { EmptyState, Skeleton } from '../../ui';
import { useDebounce } from '../hooks/useDebounce';
import {
  ACTIVE_SUM,
  canAddPosition,
  normalize,
  persistablePositions,
  positionFromSearchResult,
  roundWeight,
  type BuilderPosition,
} from '../workboard/conglomerateBuilder';
import { TransactionDialog, type TransactionDialogAsset } from './TransactionDialog';

const DEBOUNCE_MS = 300;
/** Owner directive (#248 §3 / §13.2 V2-P1): search works from a single character. */
const MIN_CHARS = 1;
/** Mirror the server-side quote/search cache TTL (PROJECTPLAN.md §6.2, 60 req/min/user). */
const SEARCH_STALE_MS = 30_000;
/** When the API answers `enriching: true` (§6.2), poll for the enriched catalog rows. */
const ENRICH_POLL_MS = 1_500;
const ENRICH_TIMEOUT_MS = 10_000;

// Search only ever returns catalog/provider (market) assets — a user's custom
// off-market assets are not in the search index, so `type: 'custom'` can never
// reach this badge. The former `custom` entry was dead (identical to the neutral
// fallback below) and is dropped so no CUSTOM slice lingers in an asset-type map
// (V3-P2, issue #325).
const TYPE_BADGE: Record<string, string> = {
  stock: 'bg-sky-900/60 text-sky-300',
  etf: 'bg-violet-900/60 text-violet-300',
  index: 'bg-orange-900/60 text-orange-300',
  fx: 'bg-emerald-900/60 text-emerald-300',
  commodity: 'bg-amber-900/60 text-amber-300',
  crypto: 'bg-pink-900/60 text-pink-300',
};

export interface AssetSearchBoxProps {
  /** Called after any per-result action fires — lets a palette close itself. */
  onAction?: () => void;
  /**
   * Picker mode (PROJECTPLAN.md §7.3 — "used by … buy dialogs"). When provided,
   * each result is a single button that returns the chosen asset instead of the
   * default Workboard / Conglomerate / Portfolio navigation actions.
   */
  onSelect?: (item: SearchResultItem) => void;
  /** Auto-focus the input on mount (useful in the ⌘K palette). */
  autoFocus?: boolean;
  placeholder?: string;
}

/**
 * Debounced search box + results list (PROJECTPLAN.md §6.2, §7.3 `AssetSearchBox`).
 * Reused by the `/search` page, the ⌘K palette, the Conglomerate Builder, and
 * buy dialogs. Self-contained: owns the query state and TanStack Query fetch.
 */
export function AssetSearchBox({
  onAction,
  onSelect,
  autoFocus = false,
  placeholder = 'Search stocks, ETFs, indices…',
}: AssetSearchBoxProps) {
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounce(query.trim(), DEBOUNCE_MS);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Picker mode (the Builder, buy-dialog asset pick) never shows the direct
  // actions below, so it never needs their supporting data.
  const withDirectActions = !onSelect;

  /** Per-result workboard state: 'idle' | 'pending' | 'done' | 'error'. */
  const [wbState, setWbState] = useState<Record<string, 'idle' | 'pending' | 'done' | 'error'>>({});
  const [portfolioAsset, setPortfolioAsset] = useState<SearchResultItem | null>(null);
  const [conglomeratePickerFor, setConglomeratePickerFor] = useState<string | null>(null);
  const [conglomerateAddState, setConglomerateAddState] = useState<
    Record<string, { status: 'pending' | 'done' | 'error'; message?: string }>
  >({});

  const enabled = debouncedQuery.length >= MIN_CHARS;

  /** Flips true once a background enrichment poll has run for `ENRICH_TIMEOUT_MS` without settling. */
  const [enrichTimedOut, setEnrichTimedOut] = useState(false);

  const { data, isFetching, isError } = useQuery({
    queryKey: ['search', debouncedQuery],
    queryFn: ({ signal }) => searchAssets(debouncedQuery, signal),
    enabled,
    staleTime: SEARCH_STALE_MS,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.enriching === true && !enrichTimedOut ? ENRICH_POLL_MS : false,
  });

  // The user's current watchlist membership, so the icon is state-aware from
  // the first render — not only after a click in this session (§13.2).
  const workboardQuery = useQuery({
    queryKey: ['workboard'],
    queryFn: ({ signal }) => listWorkboard(signal),
    enabled: withDirectActions,
    staleTime: SEARCH_STALE_MS,
  });
  const watchedIds = useMemo(
    () => new Set((workboardQuery.data?.items ?? []).map((i) => i.assetId)),
    [workboardQuery.data],
  );

  // Resolved lazily: only fetched once a Portfolio action is actually used.
  const portfoliosQuery = useQuery({
    queryKey: ['portfolios'],
    queryFn: ({ signal }) => listPortfolios(signal),
    enabled: withDirectActions && portfolioAsset !== null,
    staleTime: 60_000,
  });
  const defaultPortfolioId = useMemo(() => {
    const list = portfoliosQuery.data?.portfolios ?? [];
    return (list.find((p) => p.isDefault) ?? list[0])?.id ?? null;
  }, [portfoliosQuery.data]);

  const conglomeratesQuery = useQuery({
    queryKey: ['conglomerates'],
    queryFn: ({ signal }) => listConglomerates(signal),
    enabled: withDirectActions && conglomeratePickerFor !== null,
    staleTime: 30_000,
  });

  useEffect(() => {
    setEnrichTimedOut(false);
    if (data?.enriching !== true) return;
    const timer = setTimeout(() => setEnrichTimedOut(true), ENRICH_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [debouncedQuery, data?.enriching]);

  const results: SearchResultItem[] = data?.results ?? [];
  const isEnriching = data?.enriching === true && !enrichTimedOut;

  /** Idle | pending | done | error, merging the fetched membership with any in-flight click. */
  function workboardStatusFor(item: SearchResultItem): 'idle' | 'pending' | 'done' | 'error' {
    const local = wbState[item.id];
    if (local === 'pending' || local === 'error') return local;
    if (local === 'done' || watchedIds.has(item.id)) return 'done';
    return 'idle';
  }

  async function handleAddToWorkboard(item: SearchResultItem) {
    if (workboardStatusFor(item) !== 'idle') return;
    setWbState((s) => ({ ...s, [item.id]: 'pending' }));
    try {
      await addToWorkboard(item.id);
      setWbState((s) => ({ ...s, [item.id]: 'done' }));
      void queryClient.invalidateQueries({ queryKey: ['workboard'] });
    } catch (err) {
      // Already on the watchlist (e.g. a stale membership snapshot, or a
      // double-click race): reflect membership, never surface an error (§13.2).
      if (err instanceof ApiError && err.code === 'ALREADY_WATCHING') {
        setWbState((s) => ({ ...s, [item.id]: 'done' }));
        void queryClient.invalidateQueries({ queryKey: ['workboard'] });
        return;
      }
      setWbState((s) => ({ ...s, [item.id]: 'error' }));
    }
  }

  function handleConglomerate(item: SearchResultItem) {
    setConglomeratePickerFor((current) => (current === item.id ? null : item.id));
  }

  async function handleAddToConglomerate(item: SearchResultItem, target: ConglomerateSummary) {
    setConglomerateAddState((s) => ({ ...s, [item.id]: { status: 'pending' } }));
    try {
      const detail = await getConglomerate(target.id);
      const positions: BuilderPosition[] = detail.positions.map((p) => ({
        assetId: p.assetId,
        symbol: p.asset.symbol,
        name: p.asset.name,
        currency: p.asset.currency,
        type: p.asset.type,
        weightPct: p.weightPct,
        locked: false,
      }));
      const check = canAddPosition(positions, item.id);
      if (!check.ok) {
        setConglomerateAddState((s) => ({
          ...s,
          [item.id]: { status: 'error', message: check.reason },
        }));
        return;
      }
      // Give the new position a fair share of the pie, then normalize (§6.5)
      // the existing positions to fill the remainder — preserving their
      // relative weights instead of flattening everything to an equal split.
      const newPosition: BuilderPosition = {
        ...positionFromSearchResult(item),
        weightPct: roundWeight(ACTIVE_SUM / (positions.length + 1)),
        locked: true,
      };
      let balanced: BuilderPosition[];
      if (positions.length === 0) {
        balanced = [{ ...newPosition, locked: false, weightPct: ACTIVE_SUM }];
      } else {
        const result = normalize([...positions, newPosition]);
        balanced = result.ok ? result.positions : [...positions, newPosition];
      }
      await replaceConglomeratePositions(
        target.id,
        persistablePositions(balanced).map((p) => ({ assetId: p.assetId, weightPct: p.weightPct })),
      );
      setConglomerateAddState((s) => ({
        ...s,
        [item.id]: { status: 'done', message: target.name },
      }));
      void queryClient.invalidateQueries({ queryKey: ['conglomerates'] });
      void queryClient.invalidateQueries({ queryKey: ['conglomerate', target.id] });
    } catch {
      setConglomerateAddState((s) => ({
        ...s,
        [item.id]: { status: 'error', message: 'Could not add to that conglomerate.' },
      }));
    }
  }

  function handlePortfolio(item: SearchResultItem) {
    setPortfolioAsset(item);
  }

  function handleOpenAsset(item: SearchResultItem) {
    navigate(`/assets/${item.id}`);
    onAction?.();
  }

  function handleCreateConglomerate() {
    navigate('/workboard/conglomerates/new');
    onAction?.();
  }

  const showSkeleton = isFetching && data === undefined;
  const showEmpty = enabled && !isFetching && !isError && results.length === 0 && !isEnriching;
  const showError = isError && !isFetching;
  const showSearching = enabled && !showSkeleton && isEnriching;

  return (
    <div className="flex flex-col gap-3">
      <input
        ref={inputRef}
        autoFocus={autoFocus}
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={placeholder}
        aria-label="Search assets"
        className={cx(
          'w-full rounded-md bg-neutral-950 px-4 py-3 text-sm text-neutral-100',
          'ring-1 ring-inset ring-neutral-700 placeholder:text-neutral-600',
          'focus:outline-none focus:ring-2 focus:ring-sky-500',
        )}
      />

      {showSkeleton ? (
        <ul className="flex flex-col gap-2" aria-label="Loading results" aria-busy="true">
          {Array.from({ length: 4 }, (_, i) => (
            <li key={i} className="flex items-center gap-3 rounded-md bg-neutral-900 p-3">
              <Skeleton variant="block" width="w-16" height="h-4" />
              <Skeleton variant="line" width="w-40" height="h-4" />
            </li>
          ))}
        </ul>
      ) : null}

      {showError ? (
        <p
          role="alert"
          className="rounded-md border border-red-800 bg-red-950/60 px-3 py-2 text-sm text-red-300"
        >
          Search failed. Please try again.
        </p>
      ) : null}

      {showEmpty ? (
        <EmptyState
          icon="🔍"
          title="No results found"
          description={`Nothing matched "${debouncedQuery}". Try a different symbol or name.`}
        />
      ) : null}

      {showSearching ? (
        <p role="status" aria-live="polite" className="px-1 text-xs text-neutral-500">
          Searching the market for more results…
        </p>
      ) : null}

      {results.length > 0 ? (
        <ul className="flex flex-col gap-1" role="list" aria-label="Search results">
          {results.map((item) =>
            onSelect ? (
              <SelectRow key={item.id} item={item} onSelect={() => onSelect(item)} />
            ) : (
              <ResultRow
                key={item.id}
                item={item}
                wbStatus={workboardStatusFor(item)}
                onWorkboard={() => void handleAddToWorkboard(item)}
                onOpen={() => handleOpenAsset(item)}
                onConglomerate={() => handleConglomerate(item)}
                conglomeratePickerOpen={conglomeratePickerFor === item.id}
                conglomerates={conglomeratesQuery.data?.conglomerates ?? []}
                conglomeratesLoading={conglomeratesQuery.isLoading}
                conglomerateAddState={conglomerateAddState[item.id]}
                onPickConglomerate={(target) => void handleAddToConglomerate(item, target)}
                onCloseConglomeratePicker={() => setConglomeratePickerFor(null)}
                onCreateConglomerate={handleCreateConglomerate}
                onPortfolio={() => handlePortfolio(item)}
              />
            ),
          )}
        </ul>
      ) : null}

      {portfolioAsset && defaultPortfolioId ? (
        <TransactionDialog
          portfolioId={defaultPortfolioId}
          asset={toTransactionAsset(portfolioAsset)}
          onClose={() => setPortfolioAsset(null)}
          onSubmitted={() => onAction?.()}
        />
      ) : null}
    </div>
  );
}

function toTransactionAsset(item: SearchResultItem): TransactionDialogAsset {
  return { id: item.id, symbol: item.symbol, name: item.name, currency: item.currency };
}

interface ResultRowProps {
  item: SearchResultItem;
  wbStatus: 'idle' | 'pending' | 'done' | 'error';
  onWorkboard: () => void;
  onOpen: () => void;
  onConglomerate: () => void;
  conglomeratePickerOpen: boolean;
  conglomerates: ConglomerateSummary[];
  conglomeratesLoading: boolean;
  conglomerateAddState: { status: 'pending' | 'done' | 'error'; message?: string } | undefined;
  onPickConglomerate: (target: ConglomerateSummary) => void;
  onCloseConglomeratePicker: () => void;
  onCreateConglomerate: () => void;
  onPortfolio: () => void;
}

function ResultRow({
  item,
  wbStatus,
  onWorkboard,
  onOpen,
  onConglomerate,
  conglomeratePickerOpen,
  conglomerates,
  conglomeratesLoading,
  conglomerateAddState,
  onPickConglomerate,
  onCloseConglomeratePicker,
  onCreateConglomerate,
  onPortfolio,
}: ResultRowProps) {
  const badgeClass = TYPE_BADGE[item.type] ?? 'bg-neutral-800 text-neutral-400';
  const conglomerateRef = useRef<HTMLDivElement>(null);
  usePopoverDismiss(conglomeratePickerOpen, onCloseConglomeratePicker, conglomerateRef);

  return (
    <li className="group relative flex flex-col gap-2 rounded-md bg-neutral-900 px-3 py-2.5 hover:bg-neutral-800/80 sm:flex-row sm:items-center">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${item.symbol} — ${item.name}`}
        className="flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-semibold text-neutral-100">{item.symbol}</span>
          <span className={cx('rounded px-1.5 py-0.5 text-xs font-medium', badgeClass)}>
            {item.type}
          </span>
        </div>
        <span className="truncate text-xs text-neutral-400">
          {item.name}
          {item.exchange ? <> · {item.exchange}</> : null}
          {' · '}
          <span className="text-neutral-500">{item.currency}</span>
        </span>
      </button>

      <div className="flex shrink-0 items-center gap-1.5">
        <WatchlistControl item={item} status={wbStatus} onAdd={onWorkboard} />

        <div className="relative" ref={conglomerateRef}>
          <ActionButton
            onClick={onConglomerate}
            aria-label={`Add ${item.symbol} to a Conglomerate`}
          >
            → Conglomerate
          </ActionButton>

          {conglomeratePickerOpen ? (
            <ConglomeratePicker
              item={item}
              conglomerates={conglomerates}
              isLoading={conglomeratesLoading}
              addState={conglomerateAddState}
              onPick={onPickConglomerate}
              onClose={onCloseConglomeratePicker}
              onCreateNew={onCreateConglomerate}
            />
          ) : null}
        </div>

        <ActionButton onClick={onPortfolio} aria-label={`Record a buy for ${item.symbol}`}>
          → Portfolio
        </ActionButton>
      </div>
    </li>
  );
}

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

/**
 * State-aware watchlist toggle (§13.2): filled once the asset is on the
 * watchlist, a second click never surfaces the `ALREADY_WATCHING` error, and
 * the caret is the multiple-watchlists-ready affordance — a stub picker naming
 * the one V1 list, ready to grow without a UI rework once lists ship.
 */
function WatchlistControl({
  item,
  status,
  onAdd,
}: {
  item: SearchResultItem;
  status: 'idle' | 'pending' | 'done' | 'error';
  onAdd: () => void;
}) {
  const [listPickerOpen, setListPickerOpen] = useState(false);
  const added = status === 'done';
  const containerRef = useRef<HTMLDivElement>(null);
  usePopoverDismiss(listPickerOpen, () => setListPickerOpen(false), containerRef);

  return (
    <div className="relative flex items-center" ref={containerRef}>
      <button
        type="button"
        onClick={onAdd}
        disabled={status === 'pending'}
        aria-pressed={added}
        aria-label={
          added
            ? `${item.symbol} is on your watchlist`
            : status === 'error'
              ? `Retry adding ${item.symbol} to your watchlist`
              : `Add ${item.symbol} to watchlist`
        }
        title={added ? 'On your watchlist' : 'Add to watchlist'}
        className={cx(
          'rounded p-1.5 transition-colors',
          added ? 'text-sky-400' : 'text-neutral-500 hover:bg-neutral-700 hover:text-neutral-100',
          status === 'error' && 'text-red-400',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
          'disabled:cursor-not-allowed disabled:opacity-60',
        )}
      >
        <BookmarkIcon filled={added} />
      </button>

      <button
        type="button"
        onClick={() => setListPickerOpen((o) => !o)}
        aria-label={`Choose a watchlist for ${item.symbol}`}
        aria-haspopup="menu"
        aria-expanded={listPickerOpen}
        className="rounded p-0.5 text-xs text-neutral-600 hover:text-neutral-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        ▾
      </button>

      {listPickerOpen ? (
        <div
          role="menu"
          aria-label={`Watchlists for ${item.symbol}`}
          className="absolute right-0 top-full z-10 mt-1 w-48 rounded-md border border-neutral-700 bg-neutral-900 p-2 text-xs shadow-xl"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onAdd();
              setListPickerOpen(false);
            }}
            className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-neutral-200 hover:bg-neutral-800"
          >
            General
            {added ? <span className="text-sky-400">✓</span> : null}
          </button>
          <p className="mt-1 px-2 text-neutral-600">More lists coming soon.</p>
        </div>
      ) : null}
    </div>
  );
}

/** Filled/outline bookmark, mirroring the chain glyph style in `TransactionDialog`. */
function BookmarkIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
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

/** Picker for "→ Conglomerate" (§13.2): pick one of the caller's Conglomerates to add this asset to. */
function ConglomeratePicker({
  item,
  conglomerates,
  isLoading,
  addState,
  onPick,
  onClose,
  onCreateNew,
}: {
  item: SearchResultItem;
  conglomerates: ConglomerateSummary[];
  isLoading: boolean;
  addState: { status: 'pending' | 'done' | 'error'; message?: string } | undefined;
  onPick: (target: ConglomerateSummary) => void;
  onClose: () => void;
  onCreateNew: () => void;
}) {
  const pending = addState?.status === 'pending';

  return (
    <div
      role="menu"
      aria-label={`Add ${item.symbol} to a conglomerate`}
      className="absolute right-0 top-full z-10 mt-1 w-64 rounded-md border border-neutral-700 bg-neutral-900 p-2 shadow-xl"
    >
      <div className="flex items-center justify-between px-1 pb-1">
        <span className="text-xs font-medium text-neutral-400">Add to conglomerate</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded p-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
        >
          ✕
        </button>
      </div>

      {isLoading ? (
        <p className="px-1 py-2 text-xs text-neutral-500">Loading…</p>
      ) : conglomerates.length === 0 ? (
        <p className="px-1 py-2 text-xs text-neutral-500">You don't have any conglomerates yet.</p>
      ) : (
        <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
          {conglomerates.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                role="menuitem"
                onClick={() => onPick(c)}
                disabled={pending}
                className="w-full rounded px-2 py-1.5 text-left text-sm text-neutral-200 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {c.name}
              </button>
            </li>
          ))}
        </ul>
      )}

      {addState?.status === 'done' ? (
        <p className="mt-1 px-1 text-xs text-emerald-400">Added to {addState.message}.</p>
      ) : null}
      {addState?.status === 'error' ? (
        <p className="mt-1 px-1 text-xs text-red-400">{addState.message}</p>
      ) : null}

      <button
        type="button"
        onClick={onCreateNew}
        className="mt-1 w-full rounded px-2 py-1.5 text-left text-xs text-sky-400 hover:bg-neutral-800"
      >
        + Create new conglomerate
      </button>
    </div>
  );
}

/** A single-action result row for picker mode (`onSelect`). The whole row is the button. */
function SelectRow({ item, onSelect }: { item: SearchResultItem; onSelect: () => void }) {
  const badgeClass = TYPE_BADGE[item.type] ?? 'bg-neutral-800 text-neutral-400';
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-label={`Select ${item.symbol}`}
        className={cx(
          'flex w-full items-center gap-3 rounded-md bg-neutral-900 px-3 py-2.5 text-left',
          'transition-colors hover:bg-neutral-800/80',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
        )}
      >
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-semibold text-neutral-100">{item.symbol}</span>
            <span className={cx('rounded px-1.5 py-0.5 text-xs font-medium', badgeClass)}>
              {item.type}
            </span>
          </div>
          <span className="truncate text-xs text-neutral-400">
            {item.name}
            {item.exchange ? <> · {item.exchange}</> : null}
            {' · '}
            <span className="text-neutral-500">{item.currency}</span>
          </span>
        </div>
        <span aria-hidden="true" className="shrink-0 text-xs text-sky-400">
          Select →
        </span>
      </button>
    </li>
  );
}

function ActionButton({
  children,
  disabled,
  onClick,
  'aria-label': ariaLabel,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
  'aria-label'?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cx(
        'rounded px-2 py-1 text-xs font-medium transition-colors',
        'text-neutral-400 hover:bg-neutral-700 hover:text-neutral-100',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
        'disabled:cursor-not-allowed disabled:opacity-50',
      )}
    >
      {children}
    </button>
  );
}
