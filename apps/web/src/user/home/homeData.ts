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
import { isVaultedPortfolio } from '../portfolio/lockedPortfolio';
import { useVaultedPortfolioStores } from '../vault/useVaultedPortfolioStores';

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
 *
 * The read goes through the portfolio STORE seam rather than `portfolioApi`
 * directly (PARANOID-E6 #1416), so a future resolver-backed store can serve a
 * vaulted portfolio from its decrypted document set without this call site
 * changing. Until that store exists, a vaulted stub stays DISABLED: the server
 * cannot read a sealed vault, so the request could only ever 403, and asking is
 * itself a money read against a portfolio the user sealed. `homePortfolioRead`
 * classifies a vaulted stub from the stub alone and never consults this result,
 * so skipping the request costs the rollup nothing — the member still lands in
 * the composition as `locked` and still carries its qualifier.
 */
export function usePortfolioSummaries(portfolios: readonly PortfolioSummary[]) {
  const store = usePortfolioStore();
  return useQueries({
    queries: portfolios.map((portfolio) => ({
      queryKey: ['portfolio', portfolio.id],
      queryFn: ({ signal }: { signal: AbortSignal }) => store.getPortfolio(portfolio.id, signal),
      enabled: !isVaultedPortfolio(portfolio),
      staleTime: PORTFOLIO_STALE_MS,
    })),
  });
}

/**
 * The client-served half of the roll-up (PARANOID-E6 residual, #1416).
 *
 * One query per vaulted portfolio this device can actually open, under a key of
 * its own — deliberately NOT `['portfolio', id]`. That key belongs to the
 * server response, is shared with the portfolio page, and is what
 * `removePlaintextQueries` sweeps on lock; parking a decrypted result in it
 * would make the two indistinguishable in exactly the situation where telling
 * them apart is the whole point.
 *
 * `snapshotId` rides along because the composition boundary refuses any vaulted
 * value that cannot name the authenticated document set behind it.
 */
export function useUnlockedVaultReads(
  portfolios: readonly PortfolioSummary[],
): Map<string, HomePortfolioRead> {
  const { unlocked } = useVaultedPortfolioStores(portfolios);
  const openable = portfolios.filter((portfolio) => unlocked.has(portfolio.id));
  const results = useQueries({
    queries: openable.map((portfolio) => {
      const access = unlocked.get(portfolio.id)!;
      return {
        queryKey: ['portfolio', portfolio.id, 'vaulted-unlocked', access.vaultId],
        queryFn: ({ signal }: { signal: AbortSignal }) => access.readTotals(signal),
        staleTime: PORTFOLIO_STALE_MS,
      };
    }),
  });
  return new Map(
    openable.map((portfolio, index): [string, HomePortfolioRead] => {
      const access = unlocked.get(portfolio.id)!;
      const result = results[index];
      if (result === undefined || result.isError) return [portfolio.id, { state: 'error' }];
      if (result.data === undefined) return [portfolio.id, { state: 'loading' }];
      return [
        portfolio.id,
        {
          state: 'success',
          provenance: {
            kind: 'vaulted-unlocked',
            vaultId: access.vaultId,
            snapshotId: result.data.snapshotId,
            isCurrent: () => access.isCurrent(),
          },
          totals: result.data.totals,
        },
      ];
    }),
  );
}

/** Roll the per-portfolio summaries up into the figures every headline widget needs. */
export function useRollup(portfolios: readonly PortfolioSummary[]): Rollup {
  const results = usePortfolioSummaries(portfolios);
  const unlockedReads = useUnlockedVaultReads(portfolios);
  return composeHomeRollup(
    portfolios,
    results.map((result, index) =>
      homePortfolioRead(portfolios[index]!, result, unlockedReads.get(portfolios[index]!.id)),
    ),
  );
}

/**
 * A vaulted stub cannot trust this query's cached `PortfolioResponse`: the key
 * may still hold its pre-move plain response while the server refusal is in
 * flight. So a vaulted portfolio's readability is decided entirely by
 * `clientRead` — the resolver-backed result, or nothing.
 *
 * That third argument is the ONLY way a vaulted member becomes readable, and it
 * arrives from a store that issues no server money request. A LOCKED vault
 * supplies none, and lands on `error` exactly as it always has: no request was
 * made for it, and none could have succeeded.
 */
export function homePortfolioRead(
  portfolio: PortfolioSummary,
  result: {
    isError: boolean;
    data?: { totals: PortfolioTotals };
  },
  clientRead?: HomePortfolioRead,
): HomePortfolioRead {
  if (portfolio.vaultId != null) return clientRead ?? { state: 'error' };
  // A plain portfolio is the server's to answer. A client read handed in for
  // one would be a resolution against a portfolio that names no vault, and
  // trusting it here would let a mismatched map entry overwrite a real total.
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
  // A qualifier needs something to qualify. When EVERY member is locked there is
  // no visible value to add, so the composed figures would come back as 0 — not
  // because the money is zero, but because none of it could be read. Rendering
  // "0,00 € + 1 locked portfolio" states a balance the client has no basis for,
  // which is the silent-zero failure the qualifier exists to prevent. A mixed
  // scope still composes normally: there, the qualifier genuinely qualifies a
  // real subtotal.
  //
  // REDUNDANT BY SEAM (#1514): composePortfolioFigures now upholds this itself
  // and answers an all-locked scope with a typed `unavailable` result, handled
  // below. This guard is kept deliberately — Home's own contract does not
  // depend on the seam's, and removing it belongs to the wiring epic, not here.
  if (members.length > 0 && members.every((member) => member.state === 'locked')) {
    return {
      status: 'unavailable',
      rows,
      totalValue: null,
      invested: null,
      cash: null,
      dayChange: null,
      dayChangePct: null,
      loading,
      coverage: { kind: 'unavailable', unavailablePortfolioCount: members.length },
    };
  }

  const composed = composePortfolioFigures({ authoritativeRoster, members }, HOME_FIGURE_KEYS);
  if (composed.kind === 'unavailable') {
    // Unreachable behind the guard above, and kept as the honest answer if the
    // seam ever widens what it refuses to put a number on.
    return {
      status: 'unavailable',
      rows,
      totalValue: null,
      invested: null,
      cash: null,
      dayChange: null,
      dayChangePct: null,
      loading,
      coverage: { kind: 'unavailable', unavailablePortfolioCount: members.length },
    };
  }
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
 * The portfolios a widget instance is allowed to see, applied BEFORE
 * {@link resolveWidgetScope} so a vaulted portfolio can never reach a widget
 * that has no way to account for it (§14, PARANOID-E6 #1416).
 *
 * The server cannot read a sealed vault. A widget that simply drops those
 * members would still render its total with full confidence, and a contribution
 * that is missing reads to a user as zero — a real balance. So the rule is
 * inverted from the usual default: a widget sees vaulted portfolios only by
 * declaring `handlesVaultedPortfolios`, which is a claim that it either
 * qualifies the total through the composition boundary or fails closed to
 * "unavailable". Everything else keeps them out of scope.
 *
 * Kept here rather than inline in `HomePage` so the rule has exactly one
 * definition and can be asserted directly.
 */
export function portfoliosVisibleToWidget(
  portfolios: readonly PortfolioSummary[],
  definition: { handlesVaultedPortfolios?: boolean },
): readonly PortfolioSummary[] {
  if (definition.handlesVaultedPortfolios === true) return portfolios;
  return portfolios.filter((portfolio) => !isVaultedPortfolio(portfolio));
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
