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
 * Router segments whose per-request id names an asset the ACCOUNT ITSELF holds
 * or owns, with no portfolio attribution attached that could be checked:
 *  - `assets` — the unlocked client engine issues one quote/history/daily-close
 *    read per holding, so the catalog ids it asks for ARE a holdings roster;
 *  - `custom-assets` — every row beneath it is the user's own private object
 *    (a car, a house, an unlisted stock), so its id identifies a holding
 *    directly, on the one asset class where it matters most.
 *
 * This is a CLASSIFICATION of routers, not a list of routes: it is what decides
 * whether a request's recorded id is vault-sensitive, so adding a route under
 * one of these segments — or a `PATCH`/`DELETE` beside the reads — cannot
 * silently reopen the hole the suppression exists to close (#1896).
 */
const VAULT_SENSITIVE_ASSET_SEGMENTS = new Set(['assets', 'custom-assets']);

/**
 * Whether this request's ids are vault-sensitive and unattributed. Any method
 * counts: a `DELETE /custom-assets/:id` names the same private object a `GET`
 * does, and the writes were exactly what the earlier GET-only predicate missed.
 *
 * Only requests BELOW the segment root qualify — `GET /custom-assets` (the
 * collection) and `POST /custom-assets` name no existing asset, while
 * `/custom-assets/:id…`, `/assets/:id…` and the batch reads `/assets/quotes`
 * and `/assets/sparklines` all do.
 *
 * Accepted trade: the literal sub-routes that name no id — `/custom-assets/
 * recategorization`, `/custom-assets/vault-snapshots` — are suppressed too.
 * That costs a vaulted account's feature counter a few hits; carving them out
 * would mean maintaining a route allow-list, which is the fragile shape this
 * classification deliberately replaced.
 */
export function isVaultSensitiveUnattributedAssetRequest(path: string): boolean {
  const segments = policySegments(path);
  const segment = segments[0]?.toLowerCase();
  return (
    segment !== undefined && VAULT_SENSITIVE_ASSET_SEGMENTS.has(segment) && segments.length >= 2
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
