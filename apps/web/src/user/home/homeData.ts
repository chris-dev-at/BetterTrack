import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';

import type { PortfolioSummary, PortfolioTotals } from '@bettertrack/contracts';

import { usePortfolioStore } from '../portfolio/PortfolioStoreProvider';
import {
  composePortfolioFigures,
  type AdditivePortfolioFigures,
  type PortfolioFigureCoverage,
  type QualifiedPortfolioFigure,
} from '../vault/engine/composition';
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
  const store = usePortfolioStore();
  return useQuery({
    queryKey: ['portfolios'],
    queryFn: ({ signal }) => store.listPortfolios(signal),
    staleTime: PORTFOLIO_STALE_MS,
  });
}

export interface PortfolioRow {
  portfolio: PortfolioSummary;
  totals: PortfolioTotals | null;
}

interface RollupBase {
  rows: PortfolioRow[];
  loading: boolean;
}

export interface ReadyRollup extends RollupBase {
  status: 'ready';
  totalValue: QualifiedPortfolioFigure;
  invested: QualifiedPortfolioFigure;
  cash: QualifiedPortfolioFigure;
  dayChange: QualifiedPortfolioFigure;
  /**
   * Day change as a share of the *previous* total value. Computed uniformly for
   * one portfolio and for a roll-up so the figure always describes the number
   * rendered directly above it (net worth, cash included) — the portfolio
   * page's `dayChangePct` answers a different question (market value only).
   */
  dayChangePct: {
    valuePct: number | null;
    coverage: PortfolioFigureCoverage;
  };
}

export interface UnavailableRollup extends RollupBase {
  status: 'unavailable';
  /** No numeric fallback exists: an errored plain member is unavailable, never zero. */
  totalValue: null;
  invested: null;
  cash: null;
  dayChange: null;
  dayChangePct: null;
  coverage: {
    kind: 'unavailable';
    unavailablePortfolioCount: number;
  };
}

export type Rollup = ReadyRollup | UnavailableRollup;

export type HomePortfolioRead =
  | { state: 'loading' }
  | { state: 'error' }
  | {
      state: 'success';
      /** Provenance is part of the value: an old API-cache hit is not an unlocked vault read. */
      provenance:
        | { kind: 'plain' }
        | {
            kind: 'vaulted-unlocked';
            vaultId: string;
            /** Identity of the authenticated envelope set that produced these totals. */
            snapshotId: string;
            /** Synchronous E3/E6 revocation + CAS check at the composition side effect. */
            isCurrent(): boolean;
          };
      totals: PortfolioTotals;
    };

const HOME_FIGURE_KEYS = [
  'totalValueEur',
  'marketValueEur',
  'investedEur',
  'unrealizedPnlEur',
  'dayChangeEur',
  'cashEur',
] as const satisfies readonly (keyof AdditivePortfolioFigures)[];

/**
 * One `GET /portfolios/:id` per portfolio, each under the page-level
 * `['portfolio', id]` key. `useQueries` keeps the fan-out declarative and lets
 * React Query dedupe/cancel per portfolio instead of per batch.
 */
export function usePortfolioSummaries(portfolios: readonly PortfolioSummary[]) {
  const store = usePortfolioStore();
  return useQueries({
    queries: portfolios.map((portfolio) => ({
      queryKey: ['portfolio', portfolio.id],
      queryFn: ({ signal }: { signal: AbortSignal }) => store.getPortfolio(portfolio.id, signal),
      staleTime: PORTFOLIO_STALE_MS,
    })),
  });
}

/** Roll the per-portfolio summaries up into the figures every headline widget needs. */
export function useRollup(portfolios: readonly PortfolioSummary[]): Rollup {
  const results = usePortfolioSummaries(portfolios);
  return composeHomeRollup(
    portfolios,
    results.map((result, index) => homePortfolioRead(portfolios[index]!, result)),
  );
}

/**
 * A vaulted stub cannot trust this query's cached `PortfolioResponse`: the key
 * may still hold its pre-move plain response while the server refusal is in
 * flight. Until the E10 per-vault store/CAS owner can brand an authenticated
 * unlocked result, production Home therefore classifies the stub as locked.
 */
export function homePortfolioRead(
  portfolio: PortfolioSummary,
  result: {
    isError: boolean;
    data?: { totals: PortfolioTotals };
  },
): HomePortfolioRead {
  if (portfolio.vaultId != null) return { state: 'error' };
  if (result.isError) return { state: 'error' };
  if (result.data !== undefined) {
    return { state: 'success', provenance: { kind: 'plain' }, totals: result.data.totals };
  }
  return { state: 'loading' };
}

/**
 * Safety-critical Home composition boundary.
 *
 * A vaulted read failure is a locked member, never a zero-valued visible one.
 * A plain read failure cannot honestly be described as locked, so the whole
 * roll-up becomes unavailable and exposes no number at all. Successful values
 * are merged only through E6's structured composition seam.
 */
export function composeHomeRollup(
  portfolios: readonly PortfolioSummary[],
  reads: readonly HomePortfolioRead[],
): Rollup {
  // Derived fresh each render rather than memoized: `useQueries` hands back a
  // new array identity every time anyway, so a memo here would never hit and
  // the arithmetic below is a handful of adds over a handful of portfolios.
  const normalizedReads = portfolios.map((portfolio, index): HomePortfolioRead => {
    const read = reads[index] ?? { state: 'loading' };
    if (read.state !== 'success') return read;
    if (portfolio.vaultId == null) {
      return read.provenance.kind === 'plain' ? read : { state: 'error' };
    }
    if (
      read.provenance.kind !== 'vaulted-unlocked' ||
      read.provenance.vaultId !== portfolio.vaultId ||
      read.provenance.snapshotId.length === 0
    ) {
      return { state: 'error' };
    }
    try {
      return read.provenance.isCurrent() ? read : { state: 'error' };
    } catch {
      return { state: 'error' };
    }
  });
  const rows = portfolios.map((portfolio, index) => ({
    portfolio,
    totals: normalizedReads[index]?.state === 'success' ? normalizedReads[index].totals : null,
  }));
  const loading = portfolios.some(
    (_, index) =>
      normalizedReads[index]?.state !== 'success' && normalizedReads[index]?.state !== 'error',
  );
  if (loading) {
    return {
      status: 'unavailable',
      rows,
      totalValue: null,
      invested: null,
      cash: null,
      dayChange: null,
      dayChangePct: null,
      loading: true,
      coverage: { kind: 'unavailable', unavailablePortfolioCount: 0 },
    };
  }
  const unavailablePortfolioCount = portfolios.filter(
    (portfolio, index) => portfolio.vaultId == null && normalizedReads[index]?.state === 'error',
  ).length;
  if (unavailablePortfolioCount > 0) {
    return {
      status: 'unavailable',
      rows,
      totalValue: null,
      invested: null,
      cash: null,
      dayChange: null,
      dayChangePct: null,
      loading,
      coverage: { kind: 'unavailable', unavailablePortfolioCount },
    };
  }

  const authoritativeRoster = portfolios.map((portfolio) =>
    portfolio.vaultId == null
      ? { portfolioId: portfolio.id, source: 'plain' as const, vaultId: null }
      : { portfolioId: portfolio.id, source: 'vaulted' as const, vaultId: portfolio.vaultId },
  );
  const members = portfolios.map((portfolio, index) => {
    const read = normalizedReads[index];
    if (read?.state === 'success') {
      return {
        state: 'visible' as const,
        portfolioId: portfolio.id,
        source: portfolio.vaultId == null ? ('plain' as const) : ('vaulted' as const),
        vaultId: portfolio.vaultId ?? null,
        value: additiveFigures(read.totals),
      };
    }
    // Loading rows are not rendered because `loading` keeps the widget on its
    // skeleton. A settled failure reaches this branch only for a vaulted stub.
    return {
      state: 'locked' as const,
      portfolioId: portfolio.id,
      vaultId: requireVaultId(portfolio),
    };
  });
  const composed = composePortfolioFigures({ authoritativeRoster, members }, HOME_FIGURE_KEYS);
  const previous = composed.totalValueEur.valueEur - composed.dayChangeEur.valueEur;

  return {
    status: 'ready',
    rows,
    totalValue: composed.totalValueEur,
    invested: composed.investedEur,
    cash: composed.cashEur,
    dayChange: composed.dayChangeEur,
    dayChangePct: {
      valuePct: previous > 0 ? (composed.dayChangeEur.valueEur / previous) * 100 : null,
      coverage: composed.dayChangeEur.coverage,
    },
    loading,
  };
}

function additiveFigures(
  totals: PortfolioTotals,
): Pick<AdditivePortfolioFigures, (typeof HOME_FIGURE_KEYS)[number]> {
  return {
    totalValueEur: totals.totalValueEur,
    marketValueEur: totals.marketValueEur,
    investedEur: totals.investedEur,
    unrealizedPnlEur: totals.unrealizedPnlEur,
    dayChangeEur: totals.dayChangeEur,
    cashEur: totals.cashEur,
  };
}

function requireVaultId(portfolio: PortfolioSummary): string {
  if (portfolio.vaultId != null) return portfolio.vaultId;
  throw new TypeError(
    `Unavailable plain portfolio ${portfolio.id} cannot be classified as locked.`,
  );
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
