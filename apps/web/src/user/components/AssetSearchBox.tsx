import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import type { SearchResultItem } from '@bettertrack/contracts';
import { cx } from '../../lib/cx';
import { searchAssets } from '../../lib/searchApi';
import { addToWorkboard } from '../../lib/workboardApi';
import { EmptyState, Skeleton } from '../../ui';
import { useDebounce } from '../hooks/useDebounce';

const DEBOUNCE_MS = 300;
const MIN_CHARS = 2;
/** Mirror the server-side quote/search cache TTL (PROJECTPLAN.md §6.2, 60 req/min/user). */
const SEARCH_STALE_MS = 30_000;

const TYPE_BADGE: Record<string, string> = {
  stock: 'bg-sky-900/60 text-sky-300',
  etf: 'bg-violet-900/60 text-violet-300',
  index: 'bg-orange-900/60 text-orange-300',
  fx: 'bg-emerald-900/60 text-emerald-300',
  commodity: 'bg-amber-900/60 text-amber-300',
  crypto: 'bg-pink-900/60 text-pink-300',
  custom: 'bg-neutral-800 text-neutral-400',
};

export interface AssetSearchBoxProps {
  /** Called after any per-result action fires — lets a palette close itself. */
  onAction?: () => void;
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
  autoFocus = false,
  placeholder = 'Search stocks, ETFs, indices…',
}: AssetSearchBoxProps) {
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounce(query.trim(), DEBOUNCE_MS);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  /** Per-result workboard state: 'idle' | 'pending' | 'done' | 'error'. */
  const [wbState, setWbState] = useState<Record<string, 'idle' | 'pending' | 'done' | 'error'>>({});

  const enabled = debouncedQuery.length >= MIN_CHARS;

  const { data, isFetching, isError } = useQuery({
    queryKey: ['search', debouncedQuery],
    queryFn: ({ signal }) => searchAssets(debouncedQuery, signal),
    enabled,
    staleTime: SEARCH_STALE_MS,
    retry: false,
  });

  const results: SearchResultItem[] = data?.results ?? [];

  async function handleAddToWorkboard(item: SearchResultItem) {
    if (wbState[item.id] === 'pending' || wbState[item.id] === 'done') return;
    setWbState((s) => ({ ...s, [item.id]: 'pending' }));
    try {
      await addToWorkboard(item.id);
      setWbState((s) => ({ ...s, [item.id]: 'done' }));
      onAction?.();
    } catch {
      setWbState((s) => ({ ...s, [item.id]: 'error' }));
    }
  }

  function handleConglomerate(item: SearchResultItem) {
    void item;
    navigate('/conglomerates');
    onAction?.();
  }

  function handlePortfolio(item: SearchResultItem) {
    void item;
    navigate('/portfolio');
    onAction?.();
  }

  const showSkeleton = isFetching && results.length === 0;
  const showEmpty = enabled && !isFetching && !isError && results.length === 0;
  const showError = isError && !isFetching;
  const showHint = !enabled && query.length > 0;

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

      {showHint ? (
        <p className="px-1 text-xs text-neutral-500">
          Type at least {MIN_CHARS} characters to search.
        </p>
      ) : null}

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

      {results.length > 0 ? (
        <ul className="flex flex-col gap-1" role="list" aria-label="Search results">
          {results.map((item) => (
            <ResultRow
              key={item.id}
              item={item}
              wbStatus={wbState[item.id] ?? 'idle'}
              onWorkboard={() => void handleAddToWorkboard(item)}
              onConglomerate={() => handleConglomerate(item)}
              onPortfolio={() => handlePortfolio(item)}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

interface ResultRowProps {
  item: SearchResultItem;
  wbStatus: 'idle' | 'pending' | 'done' | 'error';
  onWorkboard: () => void;
  onConglomerate: () => void;
  onPortfolio: () => void;
}

function ResultRow({ item, wbStatus, onWorkboard, onConglomerate, onPortfolio }: ResultRowProps) {
  const badgeClass = TYPE_BADGE[item.type] ?? 'bg-neutral-800 text-neutral-400';

  return (
    <li className="group flex flex-col gap-2 rounded-md bg-neutral-900 px-3 py-2.5 hover:bg-neutral-800/80 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="flex min-w-0 flex-col">
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
      </div>

      <div className="flex shrink-0 gap-1.5">
        <ActionButton
          onClick={onWorkboard}
          disabled={wbStatus === 'pending' || wbStatus === 'done'}
          aria-label={`Add ${item.symbol} to Workboard`}
        >
          {wbStatus === 'pending'
            ? '…'
            : wbStatus === 'done'
              ? 'Watchlisted ✓'
              : wbStatus === 'error'
                ? 'Retry Workboard'
                : '→ Workboard'}
        </ActionButton>

        <ActionButton onClick={onConglomerate} aria-label={`Add ${item.symbol} to a Conglomerate`}>
          → Conglomerate
        </ActionButton>

        <ActionButton onClick={onPortfolio} aria-label={`Record a buy for ${item.symbol}`}>
          → Portfolio
        </ActionButton>
      </div>
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
