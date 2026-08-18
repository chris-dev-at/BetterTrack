import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import {
  PARANOID_CLIENT_ROUTE_DECISIONS,
  type ParanoidClientRouteRule,
  type PrivacyMode,
} from '@bettertrack/contracts';

import { useResolvedPrivacyMode } from '../usePrivacyMode';

const KILLED_CLIENT_ROUTE_RULES: readonly ParanoidClientRouteRule[] =
  PARANOID_CLIENT_ROUTE_DECISIONS.flatMap((decision) => decision.clientRoutes);

function normalizePathname(pathname: string): string {
  // React Router treats route literals case-insensitively and ignores trailing
  // separators. Apply the same equivalence before consulting the kill matrix so
  // alternate spellings cannot mount a server-disabled paranoid surface.
  return pathname.toLowerCase().replace(/\/+$/, '') || '/';
}

function matchingKilledRoute(pathname: string): ParanoidClientRouteRule | undefined {
  const normalizedPathname = normalizePathname(pathname);
  return KILLED_CLIENT_ROUTE_RULES.find((rule) =>
    rule.match === 'exact'
      ? normalizedPathname === rule.path
      : normalizedPathname === rule.path || normalizedPathname.startsWith(`${rule.path}/`),
  );
}

/** Pure route-matrix predicate shared by routing and focused tests. */
export function isParanoidKilledPath(pathname: string): boolean {
  return matchingKilledRoute(pathname) !== undefined;
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

/**
 * Where a killed path lands. Exported so the route matrix is testable whole.
 * Both cash vocabularies deliberately land directly on the canonical accounts
 * page instead of bouncing through the router's legacy redirect.
 */
export function safeDestination(pathname: string): string {
  return matchingKilledRoute(pathname)?.destination ?? '/portfolio';
}
