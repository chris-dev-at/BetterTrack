import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';

import type { PortfolioSummary, PortfolioTotals } from '@bettertrack/contracts';

import { getPortfolio, listPortfolios } from '../../lib/portfolioApi';
import { SCOPE_ALL, SCOPE_SELECTED, type WidgetScope } from './config';

/**
 * Shared data layer for the Home widget board.
 *
 * Every read here deliberately uses the **same query keys as the portfolio
 * pages** (`['portfolios']`, `['portfolio', id]`) rather than a home-specific
 * composite. Two consequences we want: a Home scoped to "Main" and the Main
 * portfolio page share one cache entry (no duplicate fetch on navigation), and
 * several widgets scoped to the same portfolio collapse onto a single request
 * no matter how many of them the user places on the board.
 */

/** Mirrors the portfolio surfaces' staleness so the shared cache behaves identically. */
const PORTFOLIO_STALE_MS = 60_000;

/** The caller's active portfolios — the exact query the switcher and pages use. */
export function usePortfoliosQuery() {
  return useQuery({
    queryKey: ['portfolios'],
    queryFn: ({ signal }) => listPortfolios(signal),
    staleTime: PORTFOLIO_STALE_MS,
  });
}

export interface PortfolioRow {
  portfolio: PortfolioSummary;
  totals: PortfolioTotals | null;
}

export interface Rollup {
  rows: PortfolioRow[];
  totalValue: number;
  invested: number;
  cash: number;
  dayChange: number;
  /**
   * Day change as a share of the *previous* total value. Computed uniformly for
   * one portfolio and for a roll-up so the figure always describes the number
   * rendered directly above it (net worth, cash included) — the portfolio
   * page's `dayChangePct` answers a different question (market value only).
   */
  dayChangePct: number | null;
  loading: boolean;
}

/**
 * One `GET /portfolios/:id` per portfolio, each under the page-level
 * `['portfolio', id]` key. `useQueries` keeps the fan-out declarative and lets
 * React Query dedupe/cancel per portfolio instead of per batch.
 */
export function usePortfolioSummaries(portfolios: readonly PortfolioSummary[]) {
  return useQueries({
    queries: portfolios.map((portfolio) => ({
      queryKey: ['portfolio', portfolio.id],
      queryFn: ({ signal }: { signal: AbortSignal }) => getPortfolio(portfolio.id, signal),
      staleTime: PORTFOLIO_STALE_MS,
    })),
  });
}

/** Roll the per-portfolio summaries up into the figures every headline widget needs. */
export function useRollup(portfolios: readonly PortfolioSummary[]): Rollup {
  const results = usePortfolioSummaries(portfolios);
  // Derived fresh each render rather than memoized: `useQueries` hands back a
  // new array identity every time anyway, so a memo here would never hit and
  // the arithmetic below is a handful of adds over a handful of portfolios.
  const rows = portfolios.map((portfolio, index) => ({
    portfolio,
    totals: results[index]?.data?.totals ?? null,
  }));
  const loading = results.some((result) => result.isLoading);

  const totalValue = sum(rows, (row) => row.totals?.totalValueEur);
  const invested = sum(rows, (row) => row.totals?.investedEur);
  const cash = sum(rows, (row) => row.totals?.cashEur);
  const dayChange = sum(rows, (row) => row.totals?.dayChangeEur);
  const previous = totalValue - dayChange;

  return {
    rows,
    totalValue,
    invested,
    cash,
    dayChange,
    dayChangePct: previous > 0 ? (dayChange / previous) * 100 : null,
    loading,
  };
}

function sum(rows: readonly PortfolioRow[], pick: (row: PortfolioRow) => number | undefined) {
  return rows.reduce((total, row) => total + (pick(row) ?? 0), 0);
}

/** How a stored scope actually resolved — what the header tag has to state. */
export type ScopeMode = 'all' | 'single' | 'subset';

export interface ResolvedScope {
  /**
   * The portfolios the widget reads: every active one, exactly the scoped one, or
   * the chosen set. Always in the app's own portfolio order, never in the order the
   * ids happen to be stored in, so two widgets over the same set agree on order.
   */
  portfolios: PortfolioSummary[];
  /** The single scoped portfolio, or null for both `all` and a multi-portfolio set. */
  single: PortfolioSummary | null;
  mode: ScopeMode;
}

const ALL = (portfolios: readonly PortfolioSummary[]): ResolvedScope => ({
  portfolios: [...portfolios],
  single: null,
  mode: 'all',
});

/**
 * Resolve a stored scope against the live portfolio list.
 *
 * Three forms, one degradation rule. `'all'` takes everything; a bare id takes that
 * portfolio; {@link SCOPE_SELECTED} takes the ids in `scopeIds`. In every case an id
 * that no longer names a live portfolio (archived, deleted, belonged to another
 * account) is **dropped** and whatever remains is kept — and if nothing remains the
 * widget falls back to all portfolios rather than rendering an empty box the user
 * cannot account for.
 *
 * Nothing here writes: the stored setting survives untouched, so un-archiving a
 * portfolio silently restores its place in the set without the user re-picking it.
 *
 * A set that currently happens to cover every portfolio still resolves as `subset`,
 * not `all`. The two mean different things going forward — a new portfolio joins an
 * `all` widget and does *not* join a chosen set — and the header tag has to say
 * which one the user is looking at.
 */
export function resolveScope(
  portfolios: readonly PortfolioSummary[],
  scope: WidgetScope | undefined,
  scopeIds?: readonly string[],
): ResolvedScope {
  if (scope === SCOPE_SELECTED) {
    if (scopeIds === undefined || scopeIds.length === 0) return ALL(portfolios);
    const wanted = new Set(scopeIds);
    const chosen = portfolios.filter((portfolio) => wanted.has(portfolio.id));
    if (chosen.length === 0) return ALL(portfolios);
    return { portfolios: chosen, single: chosen.length === 1 ? chosen[0]! : null, mode: 'subset' };
  }
  if (scope !== undefined && scope !== SCOPE_ALL) {
    const match = portfolios.find((portfolio) => portfolio.id === scope);
    if (match) return { portfolios: [match], single: match, mode: 'single' };
  }
  return ALL(portfolios);
}

/** Memoized {@link resolveScope} for use inside widget components. */
export function useResolvedScope(
  portfolios: readonly PortfolioSummary[],
  scope: WidgetScope | undefined,
  scopeIds?: readonly string[],
): ResolvedScope {
  return useMemo(() => resolveScope(portfolios, scope, scopeIds), [portfolios, scope, scopeIds]);
}

/**
 * Resolve one widget instance's scope, honouring what its type actually
 * supports:
 *
 *  - an unscoped type always spans every portfolio;
 *  - a type that cannot aggregate (`allowsAll: false`) always lands on exactly
 *    one portfolio, chosen by the same rule the portfolio switcher uses — the
 *    named one, else the default, else the first — so it is never empty and its
 *    tag always names what is on screen;
 *  - everything else follows {@link resolveScope}.
 */
export function resolveWidgetScope(
  portfolios: readonly PortfolioSummary[],
  settings: { scope?: WidgetScope; scopeIds?: readonly string[] },
  options: { supportsScope: boolean; allowsAll: boolean },
): ResolvedScope {
  if (!options.supportsScope) return ALL(portfolios);
  if (!options.allowsAll) {
    // A type that cannot aggregate ignores a chosen set the same way it ignores
    // "all": it needs exactly one portfolio, so the set's first live member is the
    // honest reading of what the user picked.
    const single = pickSinglePortfolio(portfolios, settings);
    return { portfolios: single ? [single] : [], single, mode: 'single' };
  }
  return resolveScope(portfolios, settings.scope, settings.scopeIds);
}

/**
 * The named portfolio, else the default, else the first, else null.
 *
 * Intentionally a local copy of `resolveActivePortfolio` from the portfolio
 * switcher rather than an import: that module also pulls the switcher's dialogs
 * and the whole mirrorchain panel, and Home has no business shipping any of it
 * for a six-line rule. If the rule ever changes, both must change together.
 */
function pickSinglePortfolio(
  portfolios: readonly PortfolioSummary[],
  settings: { scope?: WidgetScope; scopeIds?: readonly string[] },
): PortfolioSummary | null {
  const { scope, scopeIds } = settings;
  const named =
    scope === SCOPE_SELECTED
      ? (scopeIds?.find((id) => portfolios.some((portfolio) => portfolio.id === id)) ?? null)
      : scope !== undefined && scope !== SCOPE_ALL
        ? scope
        : null;
  return (
    (named !== null ? portfolios.find((portfolio) => portfolio.id === named) : undefined) ??
    portfolios.find((portfolio) => portfolio.isDefault) ??
    portfolios[0] ??
    null
  );
}
