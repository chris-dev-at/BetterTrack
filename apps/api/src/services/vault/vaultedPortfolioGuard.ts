import type { RequestHandler } from 'express';

import { forbidden } from '../../errors';
import { PARANOID_MODE_ERROR_CODE } from '../account/paranoidEnforcement';
import { normalizeRoutePath } from '../security/routePath';

/**
 * Vaults v2 (`docs/VAULTS_V2_DESIGN.md` §3) — the PORTFOLIO-scoped kill rail at
 * the HTTP boundary, the exact analogue of `createParanoidRouteGuard()` one
 * layer up.
 *
 * Why a route guard and not only service bindings: the account-level registry
 * binds the portfolio/cash/tax services with the subject `userIdFirst`, because
 * for a paranoid ACCOUNT the user id is the whole question. A vaulted portfolio
 * on an otherwise NORMAL account cannot be decided from the user id — the
 * portfolio id is the subject, and it arrives as a path parameter rather than
 * as a uniform first argument. Guarding the path is therefore the only place
 * that is complete: every route below carries `{portfolioId}` in its path, so a
 * new one inherits the rail without registering anything.
 *
 * Below HTTP the `portfolioIdFirst` service bindings carry the same rule (see
 * `invokeServiceSubject`), which is what covers jobs and internal callers.
 */

/** A path segment position that names a portfolio, per mounted route prefix. */
interface PortfolioPathRule {
  /** Mount-relative path prefix segments that must match literally. */
  readonly prefix: readonly string[];
  /** Zero-based index of the `{portfolioId}` segment in the full path. */
  readonly index: number;
}

/**
 * Every mounted surface that names a portfolio in its PATH. Derived by reading
 * the real route table; the completeness test re-derives it and fails if a new
 * `{portfolioId}` route appears that no rule covers.
 */
export const VAULTED_PORTFOLIO_PATH_RULES: readonly PortfolioPathRule[] = [
  { prefix: ['portfolios'], index: 1 },
  { prefix: ['analytics', 'portfolios'], index: 2 },
  { prefix: ['social', 'shared'], index: 2 },
  { prefix: ['vaults'], index: 3 },
];

/**
 * Routes that stay reachable for a VAULTED portfolio, with the binding reason.
 * Anything else that names a vaulted portfolio is refused with the same
 * `PARANOID_MODE` code the account-level rail uses — the client already knows
 * that code and renders the locked state from it.
 */
export const VAULTED_PORTFOLIO_KEPT_ROUTES: readonly {
  readonly method: string;
  readonly path: string;
  readonly reason: string;
}[] = [
  {
    method: 'DELETE',
    path: '/portfolios/{portfolioId}/vault',
    reason: 'Leave is the ONLY way out of a vault; killing it would strand the portfolio forever.',
  },
  {
    method: 'POST',
    path: '/portfolios/{portfolioId}/vault',
    reason:
      'Join owns its own refusal (409 VAULT_PORTFOLIO_ALREADY_VAULTED, and API_KEY_FORBIDDEN for a bearer). A blanket PARANOID_MODE here would replace both with a vaguer answer while refusing exactly the same request.',
  },
  {
    method: 'DELETE',
    path: '/portfolios/{portfolioId}',
    reason:
      'Deleting the portfolio row is metadata, reads no content, and must stay available — the vault blob dies with it by FK cascade.',
  },
  {
    method: 'PATCH',
    path: '/portfolios/{portfolioId}/alias',
    reason:
      'The alias IS the vaulted-portfolio surface: it writes one cleartext label column and nothing else, and it refuses a normal portfolio itself. Killing it would leave a locked row permanently stuck with whatever name it had at join time.',
  },
  {
    method: 'POST',
    path: '/portfolios/{portfolioId}/archive',
    reason: 'Archive/restore only move the portfolio row between two list states.',
  },
  {
    method: 'POST',
    path: '/portfolios/{portfolioId}/restore',
    reason: 'Archive/restore only move the portfolio row between two list states.',
  },
  {
    method: 'GET',
    path: '/vaults/{vaultId}/portfolios/{portfolioId}',
    reason: 'The ciphertext sync surface IS the vaulted portfolio’s data home.',
  },
  {
    method: 'PUT',
    path: '/vaults/{vaultId}/portfolios/{portfolioId}',
    reason: 'The ciphertext sync surface IS the vaulted portfolio’s data home.',
  },
];

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function keptRouteMatches(method: string, segments: readonly string[]): boolean {
  const upper = method.toUpperCase();
  return VAULTED_PORTFOLIO_KEPT_ROUTES.some((route) => {
    if (route.method !== upper && !(upper === 'HEAD' && route.method === 'GET')) return false;
    const expected = normalizeRoutePath(route.path).split('/').filter(Boolean);
    if (expected.length !== segments.length) return false;
    return expected.every(
      (segment, index) =>
        (segment.startsWith('{') && segment.endsWith('}')) || segment === segments[index],
    );
  });
}

/**
 * Extract the portfolio id a request names in its PATH, or null. Exported so
 * the completeness test can assert the rules against the real route table
 * rather than trusting this file's comment.
 */
export function vaultedPortfolioIdInPath(path: string): string | null {
  const segments = normalizeRoutePath(path).split('/').filter(Boolean);
  for (const rule of VAULTED_PORTFOLIO_PATH_RULES) {
    if (rule.prefix.every((segment, index) => segments[index] === segment)) {
      const candidate = segments[rule.index];
      if (candidate && UUID_SEGMENT.test(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The portfolio id a request names in its BODY, for the two creation surfaces
 * that take it there instead of in the path (`POST /imports` multipart,
 * `POST /standing-orders`). Read defensively: only a string that looks like a
 * uuid is considered, and an absent/garbage value simply falls through to the
 * route's own validation.
 */
function vaultedPortfolioIdInBody(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const value = (body as { portfolioId?: unknown }).portfolioId;
  return typeof value === 'string' && UUID_SEGMENT.test(value) ? value : null;
}

export interface VaultedPortfolioGuardDeps {
  /**
   * OWNER-SCOPED on purpose. A foreign portfolio id must resolve to `false` so
   * the request falls through to the route's own ownership check and 404s —
   * answering `403 PARANOID_MODE` for someone else's portfolio would turn this
   * guard into a membership oracle for ids the caller does not own.
   */
  isPortfolioVaulted(userId: string, portfolioId: string): Promise<boolean>;
}

export function createVaultedPortfolioRouteGuard(deps: VaultedPortfolioGuardDeps): RequestHandler {
  return (req, _res, next) => {
    const userId = req.authUser?.id;
    if (!userId) {
      next();
      return;
    }
    const segments = normalizeRoutePath(req.path).split('/').filter(Boolean);
    if (keptRouteMatches(req.method, segments)) {
      next();
      return;
    }
    const portfolioId = vaultedPortfolioIdInPath(req.path) ?? vaultedPortfolioIdInBody(req.body);
    if (!portfolioId) {
      next();
      return;
    }
    deps.isPortfolioVaulted(userId, portfolioId).then((vaulted) => {
      if (!vaulted) {
        next();
        return;
      }
      next(
        forbidden(
          'This portfolio lives in a vault; its data is client-encrypted and the server cannot read it.',
          PARANOID_MODE_ERROR_CODE,
        ),
      );
    }, next);
  };
}
