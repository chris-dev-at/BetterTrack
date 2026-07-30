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
