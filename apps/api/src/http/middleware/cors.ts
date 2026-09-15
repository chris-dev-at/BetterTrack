import type { RequestHandler } from 'express';

import {
  VAULT_HISTORY_CREATED_AT_HEADER,
  VAULT_HISTORY_MEDIUM_HEADER,
  VAULT_HISTORY_SIZE_BYTES_HEADER,
  VAULT_RETIREMENT_PROOF_PUBLIC_KEY_HEADER,
  VAULT_SERVER_CANDIDATE_EXPIRES_AT_HEADER,
  VAULT_SERVER_CANDIDATE_ID_HEADER,
  VAULT_SERVER_CANDIDATE_READBACK_HEADER,
} from '@bettertrack/contracts';

const ALLOW_METHODS = 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS';
const ALLOW_HEADERS = [
  'Content-Type',
  'X-Requested-With',
  'If-Match',
  'If-None-Match',
  VAULT_RETIREMENT_PROOF_PUBLIC_KEY_HEADER,
].join(', ');
const EXPOSE_HEADERS = [
  'Content-Disposition',
  'ETag',
  // §10 rate limiting: the 429 carries the wait as `Retry-After`. The SPA lives
  // on a DIFFERENT origin from the API in both deployment modes (§4.6), so
  // without this the header is invisible to `fetch` and the client's backoff
  // silently degrades to a fixed floor — which is how a single cooldown turned
  // into a 1 req/s poll against `/auth/me`. The body's `details.retryAfter` is
  // the belt to this suspenders; both are read (apiClient.ts).
  'Retry-After',
  VAULT_HISTORY_CREATED_AT_HEADER,
  VAULT_HISTORY_MEDIUM_HEADER,
  VAULT_HISTORY_SIZE_BYTES_HEADER,
  VAULT_SERVER_CANDIDATE_EXPIRES_AT_HEADER,
  VAULT_SERVER_CANDIDATE_ID_HEADER,
  VAULT_SERVER_CANDIDATE_READBACK_HEADER,
].join(', ');
const MAX_AGE_SECONDS = '600';

/**
 * Credentialed CORS (PROJECTPLAN.md §10). The web + admin SPAs live on their own
 * origins in both deployment modes (§4.6), so the API must opt those origins in
 * for cross-origin cookies. The allowlist is the DERIVED web/admin origins
 * (config.corsOrigins) — never a wildcard and never hardcoded — because
 * `Access-Control-Allow-Credentials: true` forbids `*`.
 *
 * Origins outside the allowlist get no CORS headers, so the browser blocks the
 * response; the strict Origin check on state-changing requests (see csrf.ts) is
 * the belt to this suspenders.
 */
export function createCorsMiddleware(allowedOrigins: readonly string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return (req, res, next) => {
    const origin = req.get('origin');
    // Vary on Origin regardless of match so shared caches never serve one
    // origin's ACAO header to another.
    res.setHeader('Vary', 'Origin');

    if (origin && allowed.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', ALLOW_METHODS);
      res.setHeader('Access-Control-Allow-Headers', ALLOW_HEADERS);
      res.setHeader('Access-Control-Expose-Headers', EXPOSE_HEADERS);
      res.setHeader('Access-Control-Max-Age', MAX_AGE_SECONDS);
    }

    // Preflight ends here: a matched origin already carries the ACA-* headers; an
    // unmatched one gets a bare 204 the browser will reject. Either way it never
    // reaches session/CSRF handling.
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  };
}
