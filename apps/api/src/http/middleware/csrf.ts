import type { RequestHandler } from 'express';

import { forbidden } from '../../errors';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defense for state-changing requests (PROJECTPLAN.md §10), two layers:
 *
 *  1. Custom header — every mutation must carry `X-Requested-With: BetterTrack`.
 *     A custom header on a cross-site request forces a CORS preflight, which our
 *     allowlist (createCorsMiddleware) only clears for the web/admin origins, so
 *     a hostile page can't even send it.
 *  2. Strict Origin check — when an `Origin` header is present it MUST be one of
 *     the derived allowed origins (config.corsOrigins). Browsers always attach
 *     Origin to cross-origin (and non-GET) fetches, so a forged cross-site
 *     mutation is rejected outright. Requests with no Origin (same-origin form
 *     posts, server-to-server, tests) fall back to layer 1.
 *
 * The allowlist is passed in so origins stay derived from topology, never inlined.
 */
export function createCsrfGuard(allowedOrigins: readonly string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return (req, _res, next) => {
    // Bearer (API-key) requests carry no cookies, so CSRF does not apply — the
    // header/Origin checks guard cookie-authenticated mutations only (§6.13).
    if (req.apiKey || SAFE_METHODS.has(req.method)) {
      next();
      return;
    }
    if (req.get('x-requested-with') !== 'BetterTrack') {
      next(forbidden('Missing or invalid X-Requested-With header.', 'CSRF_HEADER_REQUIRED'));
      return;
    }
    const origin = req.get('origin');
    if (origin && !allowed.has(origin)) {
      next(forbidden('Request origin is not allowed.', 'CSRF_ORIGIN_REJECTED'));
      return;
    }
    next();
  };
}
