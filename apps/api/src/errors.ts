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

export const notFound = (message = 'Not found.', code = 'NOT_FOUND') =>
  new ApiError(404, code, message);

export const conflict = (message: string, code = 'CONFLICT') => new ApiError(409, code, message);

export const tooManyRequests = (message = 'Too many requests.', code = 'RATE_LIMITED') =>
  new ApiError(429, code, message);
