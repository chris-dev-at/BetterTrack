import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import type { SearchResultItem } from '@bettertrack/contracts';
import { searchAssets } from '../../lib/searchApi';
import { useDebounce } from '../hooks/useDebounce';

/**
 * The one asset-search fetch (PROJECTPLAN.md §6.2), shared by every surface that
 * searches the catalog: the rich {@link AssetSearchBox} (assets page, Builder,
 * buy dialogs) and the leaner ⌘K palette results list. Both debounce, cache and
 * poll for enrichment identically because they run this hook — the palette only
 * renders differently, it does not search differently.
 */

const DEBOUNCE_MS = 300;
/** Owner directive (#248 §3 / §13.2 V2-P1): search works from a single character. */
export const ASSET_SEARCH_MIN_CHARS = 1;
/** Mirror the server-side quote/search cache TTL (PROJECTPLAN.md §6.2, 60 req/min/user). */
const SEARCH_STALE_MS = 30_000;
/** When the API answers `enriching: true` (§6.2), poll for the enriched catalog rows. */
const ENRICH_POLL_MS = 1_500;
const ENRICH_TIMEOUT_MS = 10_000;

export interface AssetSearchState {
  /** The debounced, trimmed query the results belong to. */
  query: string;
  /** True once the query is long enough to search — below that nothing is fetched. */
  enabled: boolean;
  results: SearchResultItem[];
  /** A request is in flight (initial load or a background refetch). */
  isFetching: boolean;
  isError: boolean;
  /** A background provider search is still widening the catalog (§6.2). */
  isEnriching: boolean;
  /** True once a response for the current query key has landed (skeleton gate). */
  hasLoaded: boolean;
}

/**
 * Debounced catalog search for `rawQuery`. Pass `enabled: false` to park the
 * fetch entirely (a closed palette must not search).
 */
export function useAssetSearch(
  rawQuery: string,
  options?: { enabled?: boolean },
): AssetSearchState {
  const debouncedQuery = useDebounce(rawQuery.trim(), DEBOUNCE_MS);
  const enabled = (options?.enabled ?? true) && debouncedQuery.length >= ASSET_SEARCH_MIN_CHARS;

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

  useEffect(() => {
    setEnrichTimedOut(false);
    if (data?.enriching !== true) return;
    const timer = setTimeout(() => setEnrichTimedOut(true), ENRICH_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [debouncedQuery, data?.enriching]);

  return {
    query: debouncedQuery,
    enabled,
    results: data?.results ?? [],
    isFetching,
    isError,
    isEnriching: data?.enriching === true && !enrichTimedOut,
    hasLoaded: data !== undefined,
  };
}
