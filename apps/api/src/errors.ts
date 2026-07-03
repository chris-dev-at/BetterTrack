/**
 * Transport-agnostic application error. The HTTP error handler maps these to
 * the `{ error: { code, message, details? } }` envelope (PROJECTPLAN.md §8).
 */
export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (message: string, code = 'BAD_REQUEST', details?: unknown) =>
  new ApiError(400, code, message, details);

export const unauthorized = (message = 'Authentication required.', code = 'UNAUTHENTICATED') =>
  new ApiError(401, code, message);

export const forbidden = (message: string, code = 'FORBIDDEN') => new ApiError(403, code, message);

/**
 * A correctly-authenticated login against a non-active (disabled) account.
 * Distinct from the generic `INVALID_CREDENTIALS` (401) and only ever thrown
 * *after* the password is verified correct, so it leaks no user-existence
 * signal to an attacker guessing passwords (PROJECTPLAN.md §6.1, §16).
 */
export const accountDisabled = (
  message = 'This account has been suspended. Please contact the administrator.',
) => new ApiError(403, 'ACCOUNT_DISABLED', message);

/**
 * An admin-kind session reaching a user-app endpoint (PROJECTPLAN.md §3, §5.5,
 * §10). Admin accounts administer the system in their own admin area and have
 * no personal portfolio/workboard/social surface; the message points them back
 * there rather than 404-ing (an authenticated admin already knows the admin
 * area exists, so this leaks nothing). The reverse — a user-kind session on an
 * `/api/v1/admin/*` route — stays a bare 404 (see `requireAdmin`), so a
 * non-admin learns nothing about the admin surface (§6.12).
 */
export const adminAccountKind = (
  message = 'Administrator accounts have no personal workspace — sign in through the admin area to manage the system.',
) => new ApiError(403, 'ADMIN_ACCOUNT_KIND', message);

export const notFound = (message = 'Not found.', code = 'NOT_FOUND') =>
  new ApiError(404, code, message);

export const conflict = (message: string, code = 'CONFLICT') => new ApiError(409, code, message);

/**
 * A well-formed request the server understood but cannot process as a data
 * state rather than a syntax error (PROJECTPLAN.md §8) — e.g. a backtest whose
 * positions share no overlapping price history in the requested window. Distinct
 * from a 400 (which signals a malformed request the client should fix) so the
 * SPA can surface the engine's explanation instead of a validation hint.
 */
export const unprocessable = (message: string, code = 'UNPROCESSABLE') =>
  new ApiError(422, code, message);

/**
 * Progressive rate-limit rejection (PROJECTPLAN.md §10). `retryAfterSeconds` is
 * surfaced both in the body (`details.retryAfter`) and — set by the caller — as
 * the `Retry-After` header the SPA reads to tell the user how long to wait.
 */
export const tooManyRequests = (
  retryAfterSeconds?: number,
  message = 'Too many requests. Please slow down.',
) =>
  new ApiError(
    429,
    'RATE_LIMITED',
    message,
    retryAfterSeconds !== undefined ? { retryAfter: retryAfterSeconds } : undefined,
  );

/**
 * An upstream data provider failed and we have no cached value to serve in its
 * place (PROJECTPLAN.md §5.1 stale-while-revalidate degrades to this only when
 * there is no last-known-good copy at all).
 */
export const badGateway = (
  message = 'Market data is temporarily unavailable.',
  code = 'UPSTREAM_UNAVAILABLE',
) => new ApiError(502, code, message);
