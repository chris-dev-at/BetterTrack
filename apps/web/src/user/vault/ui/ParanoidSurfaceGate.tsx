import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import type { PrivacyMode } from '@bettertrack/contracts';

import { useResolvedPrivacyMode } from '../usePrivacyMode';

const KILLED_PREFIXES = [
  '/s',
  '/u',
  '/people/shared',
  '/people/profile',
  '/control/profile',
  '/settings/profile',
  '/portfolio/import',
  '/portfolio/cash-flow/import',
  '/portfolio/cash/import',
  '/portfolio/people',
  '/portfolio/tax/print',
  '/assets/news',
  '/social/my-shared',
  '/social/shared-with-me',
  '/social/profile',
] as const;

/**
 * The expense area (V5-P9). Its `/expenses/*` endpoints are already refused
 * server-side under the `portfolioServer` capability (the PD3b enforcement
 * registry), so these five pages are hidden rather than left to 403 into an
 * empty shell. The DATA is not killed: the expense tables are vault-classified,
 * `migration.ts` carries every category/transaction/rule/budget into the blob,
 * and the whole area returns intact on disable. Re-deriving these pages against
 * the vault store is v6 follow-up work — recorded in PROJECTPLAN §16
 * (2026-07-31, issue #729) and as kill-list item 11 in docs/paranoid-design.md
 * §8, because §8's rule is that an absent surface is a documented one.
 *
 * `/portfolio/cash-flow/accounts` deliberately stays live: cash sources are
 * portfolio rows served by the vault store, not expense rows.
 *
 * The area was renamed `/portfolio/cash` with three tabs plus setup pages
 * (V5 cash fusion phase 2 — the fused ledger's overview/movements/budgets/
 * labels read the SERVER cash endpoints, which the PD3b registry refuses for a
 * paranoid account), so the SAME kill decision covers both vocabularies: the
 * legacy names for deep links and bookmarks, the canonical names for the live
 * router. `/portfolio/cash/accounts` stays live exactly like its legacy alias.
 */
const KILLED_EXACT_PATHS = new Set([
  '/people/following',
  '/portfolio/cash-flow',
  '/portfolio/cash-flow/transactions',
  '/portfolio/cash-flow/budgets',
  '/portfolio/cash-flow/categories',
  '/portfolio/cash-flow/rules',
  '/portfolio/cash',
  '/portfolio/cash/movements',
  '/portfolio/cash/transactions',
  '/portfolio/cash/budgets',
  '/portfolio/cash/labels',
  '/portfolio/cash/tags',
  '/portfolio/cash/rules',
  '/portfolio/cash/categories',
]);

function normalizePathname(pathname: string): string {
  // React Router treats route literals case-insensitively and ignores trailing
  // separators. Apply the same equivalence before consulting the kill matrix so
  // alternate spellings cannot mount a server-disabled paranoid surface.
  return pathname.toLowerCase().replace(/\/+$/, '') || '/';
}

/** Pure route-matrix predicate shared by routing and focused tests. */
export function isParanoidKilledPath(pathname: string): boolean {
  const normalizedPathname = normalizePathname(pathname);
  return (
    KILLED_EXACT_PATHS.has(normalizedPathname) ||
    KILLED_PREFIXES.some(
      (prefix) => normalizedPathname === prefix || normalizedPathname.startsWith(`${prefix}/`),
    )
  );
}

export function ParanoidNavigationGate({ children }: { children: ReactNode }) {
  const location = useLocation();
  const mode = useResolvedPrivacyMode();
  if (mode === 'paranoid' && isParanoidKilledPath(location.pathname)) {
    return <Navigate replace to={safeDestination(location.pathname)} />;
  }
  return children;
}

/** Render server-dependent content only after mode resolution proves it safe. */
export function NormalModeOnly({
  children,
  fallback = null,
}: {
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const mode = useResolvedPrivacyMode();
  return mode === 'normal' ? children : fallback;
}

/** Render a local-vault control only for a resolved paranoid account. */
export function ParanoidModeOnly({ children }: { children: ReactNode }) {
  const mode = useResolvedPrivacyMode();
  return mode === 'paranoid' ? children : null;
}

export function surfaceAllowed(mode: PrivacyMode, surface: 'kept' | 'killed'): boolean {
  return mode === 'normal' || surface === 'kept';
}

/** Where a killed path lands. Exported so the route matrix is testable whole. */
export function safeDestination(pathname: string): string {
  const normalizedPathname = normalizePathname(pathname);
  // The Control Center is an OVERLAY: sending a killed `/control/*` deep link
  // to `/portfolio` would close the popup the user just opened, so it lands on
  // the neighbouring panel instead.
  if (normalizedPathname.startsWith('/control')) return '/control/account';
  if (normalizedPathname.startsWith('/people') || normalizedPathname.startsWith('/social')) {
    return '/people';
  }
  if (normalizedPathname.startsWith('/assets')) return '/assets';
  // Both vocabularies land on the CANONICAL accounts page — the legacy alias
  // would only bounce through the router's LegacyRedirect to the same place.
  if (
    normalizedPathname.startsWith('/portfolio/cash-flow') ||
    normalizedPathname.startsWith('/portfolio/cash')
  ) {
    return '/portfolio/cash/accounts';
  }
  if (normalizedPathname.includes('/tax/print')) return '/portfolio/tax';
  return '/portfolio';
}
