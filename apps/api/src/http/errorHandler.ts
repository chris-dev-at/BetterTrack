import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

import { ApiError } from '../errors';
import type { Logger } from '../logger';

/**
 * Terminal error middleware → the `{ error: { code, message, details? } }`
 * envelope (PROJECTPLAN.md §8). Unexpected errors are logged (message only, no
 * bodies/tokens) and surfaced as an opaque 500.
 */
export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (err, _req, res, _next) => {
    if (err instanceof ApiError) {
      res.status(err.statusCode).json({
        error: {
          code: err.code,
          message: err.message,
          ...(err.details !== undefined ? { details: err.details } : {}),
        },
      });
      return;
    }

    if (err instanceof ZodError) {
      res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid request.', details: err.flatten() },
      });
      return;
    }

    logger.error(
      { err: err instanceof Error ? err.message : 'unknown' },
      'Unhandled request error',
    );
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error.' } });
  };
}
