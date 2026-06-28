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

export const notFound = (message = 'Not found.', code = 'NOT_FOUND') =>
  new ApiError(404, code, message);

export const conflict = (message: string, code = 'CONFLICT') => new ApiError(409, code, message);

export const tooManyRequests = (message = 'Too many requests.', code = 'RATE_LIMITED') =>
  new ApiError(429, code, message);

/**
 * An upstream data provider failed and we have no cached value to serve in its
 * place (PROJECTPLAN.md §5.1 stale-while-revalidate degrades to this only when
 * there is no last-known-good copy at all).
 */
export const badGateway = (
  message = 'Market data is temporarily unavailable.',
  code = 'UPSTREAM_UNAVAILABLE',
) => new ApiError(502, code, message);
