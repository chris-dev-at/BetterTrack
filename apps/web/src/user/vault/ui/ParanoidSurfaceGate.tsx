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
 * (2026-07-30) and as kill-list item 11 in docs/paranoid-design.md §8, because
 * §8's rule is that an absent surface is a documented one.
 *
 * `/portfolio/cash-flow/accounts` deliberately stays live: cash sources are
 * portfolio rows served by the vault store, not expense rows.
 */
const KILLED_EXACT_PATHS = new Set([
  '/portfolio/cash-flow',
  '/portfolio/cash-flow/transactions',
  '/portfolio/cash-flow/budgets',
  '/portfolio/cash-flow/categories',
  '/portfolio/cash-flow/rules',
]);

/** Pure route-matrix predicate shared by routing and focused tests. */
export function isParanoidKilledPath(pathname: string): boolean {
  return (
    KILLED_EXACT_PATHS.has(pathname) ||
    KILLED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
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

function safeDestination(pathname: string): string {
  if (pathname.startsWith('/people') || pathname.startsWith('/social')) return '/people';
  if (pathname.startsWith('/assets')) return '/assets';
  if (pathname.startsWith('/portfolio/cash-flow')) return '/portfolio/cash-flow/accounts';
  if (pathname.includes('/tax/print')) return '/portfolio/tax';
  return '/portfolio';
}
