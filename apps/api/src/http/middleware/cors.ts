import type { RequestHandler } from 'express';

const ALLOW_METHODS = 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS';
const ALLOW_HEADERS = 'Content-Type, X-Requested-With';
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
