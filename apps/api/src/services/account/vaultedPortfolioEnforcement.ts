import type { RequestHandler } from 'express';

import { VAULTED_PORTFOLIO_TRANSITION_CARVEOUT_REGISTRY } from './paranoidEnforcement';
import type { VaultedPortfolioGuard } from './vaultedPortfolioGuard';

export * from './vaultedPortfolioGuard';
export { VAULTED_PORTFOLIO_TRANSITION_CARVEOUT_REGISTRY };
export {
  VAULTED_PORTFOLIO_FEATURE_REGISTRY,
  vaultedPortfolioFeatureForCapability,
  type VaultedPortfolioBoundaryEvidence,
  type VaultedPortfolioFeatureId,
  type VaultedPortfolioFeatureRegistryEntry,
  type VaultedPortfolioJobMode,
  type VaultedPortfolioMatrixPolicy,
  type VaultedPortfolioTransitionCarveout,
} from './paranoidEnforcement';

interface PortfolioTargetRequest {
  readonly method: string;
  readonly path: string;
  readonly params?: unknown;
  readonly query?: unknown;
  readonly body?: unknown;
  readonly valid?: {
    readonly params?: unknown;
    readonly query?: unknown;
    readonly body?: unknown;
  };
}

export interface VaultedPortfolioRequestTarget {
  readonly portfolioId: string;
  readonly source: 'path' | 'params' | 'query' | 'body';
}

/**
 * Per-asset market reads carry no portfolio id. The unlocked client engine
 * issues quote and daily-close/history reads per holding, so their asset ids
 * form a holdings roster when any portfolio on the account is vaulted.
 */
export function isVaultSensitiveUnattributedAssetRead(method: string, path: string): boolean {
  if (method.toUpperCase() !== 'GET') return false;
  const pathname = path.split('?', 1)[0]!.replace(/\/+$/, '');
  return (
    /^\/api\/v1\/assets\/quotes$/i.test(pathname) ||
    /^\/api\/v1\/assets\/[^/]+(?:\/(?:quote|history|daily-closes))?$/i.test(pathname) ||
    /^\/assets\/quotes$/i.test(pathname) ||
    /^\/assets\/[^/]+(?:\/(?:quote|history|daily-closes))?$/i.test(pathname)
  );
}

/** Preserve the target segment while comparing Express's literals case-insensitively. */
function policySegments(path: string): string[] {
  const pathname = path.split('?', 1)[0]!.replace(/\/+$/, '') || '/';
  const segments = pathname.split('/').filter(Boolean);
  if (segments[0]?.toLowerCase() === 'api' && segments[1]?.toLowerCase() === 'v1') {
    return segments.slice(2);
  }
  return segments;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * This middleware runs before route Zod parsing. Invalid ids must fall through
 * to the ordinary request validator instead of reaching a PostgreSQL uuid
 * comparison first (which would turn a contract 400 into a database 500).
 */
function portfolioUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value : null;
}

function directPortfolioId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { portfolioId?: unknown; kind?: unknown; subjectId?: unknown };
  return (
    portfolioUuid(candidate.portfolioId) ??
    (candidate.kind === 'portfolio' ? portfolioUuid(candidate.subjectId) : null)
  );
}

/** Explicit exit-door allowlist. No other route beneath `/portfolios/:id/vault` is exempt. */
export function isVaultedPortfolioTransitionCarveout(method: string, path: string): boolean {
  const segments = policySegments(path);
  if (
    (segments.length !== 4 && segments.length !== 5) ||
    segments[0]?.toLowerCase() !== 'portfolios' ||
    segments[2]?.toLowerCase() !== 'vault' ||
    (segments.length === 5 && segments[3]?.toLowerCase() !== 'move-out')
  ) {
    return false;
  }
  const operation = segments.slice(3).join('/').toLowerCase();
  const normalizedMethod = method.toUpperCase();
  return VAULTED_PORTFOLIO_TRANSITION_CARVEOUT_REGISTRY.some(
    (entry) => entry.method === normalizedMethod && entry.operation === operation,
  );
}

/**
 * Best-effort HTTP target extraction. This is defense in depth only: indirect
 * ids and races still require the service/repository guard around the action.
 */
export function vaultedPortfolioTargetForRequest(
  request: PortfolioTargetRequest,
): VaultedPortfolioRequestTarget | null {
  if (isVaultedPortfolioTransitionCarveout(request.method, request.path)) return null;

  const segments = policySegments(request.path);
  if (segments[0]?.toLowerCase() === 'portfolios' && segments.length >= 2) {
    const portfolioId = portfolioUuid(segments[1]);
    if (portfolioId) return { portfolioId, source: 'path' };
  }
  if (
    segments[0]?.toLowerCase() === 'analytics' &&
    segments[1]?.toLowerCase() === 'portfolios' &&
    segments.length >= 3
  ) {
    const portfolioId = portfolioUuid(segments[2]);
    if (portfolioId) return { portfolioId, source: 'path' };
  }
  if (
    segments.length === 3 &&
    segments[0]?.toLowerCase() === 'social' &&
    segments[1]?.toLowerCase() === 'shared'
  ) {
    const portfolioId = portfolioUuid(segments[2]);
    if (portfolioId) return { portfolioId, source: 'path' };
  }
  if (
    segments[0]?.toLowerCase() === 'social' &&
    ['audience', 'items', 'item-follows'].includes(segments[1]?.toLowerCase() ?? '') &&
    segments[2]?.toLowerCase() === 'portfolio' &&
    segments.length >= 4
  ) {
    const portfolioId = portfolioUuid(segments[3]);
    if (portfolioId) return { portfolioId, source: 'path' };
  }

  const candidates = [
    ['params', request.valid?.params],
    ['query', request.valid?.query],
    ['body', request.valid?.body],
    ['params', request.params],
    ['query', request.query],
    ['body', request.body],
  ] as const;
  for (const [source, value] of candidates) {
    const portfolioId = directPortfolioId(value);
    if (portfolioId) return { portfolioId, source };
  }
  return null;
}

/** Global request-level defense in depth; authoritative enforcement stays below HTTP. */
export function createVaultedPortfolioRouteGuard(
  guard: Pick<VaultedPortfolioGuard, 'assertOwnedPortfolioAllowed'>,
): RequestHandler {
  return (request, _response, next) => {
    if (!request.authUser) {
      next();
      return;
    }
    const target = vaultedPortfolioTargetForRequest(request);
    if (!target) {
      next();
      return;
    }
    guard.assertOwnedPortfolioAllowed(request.authUser.id, target.portfolioId).then(
      () => next(),
      (error: unknown) => next(error),
    );
  };
}
