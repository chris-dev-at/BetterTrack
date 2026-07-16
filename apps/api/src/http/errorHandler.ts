import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

import { ApiError } from '../errors';
import type { Logger } from '../logger';

/** Reports an unexpected error to error tracking (Sentry). Never throws. */
export type ErrorReporter = (err: unknown) => void;

/**
 * Terminal error middleware → the `{ error: { code, message, details? } }`
 * envelope (PROJECTPLAN.md §8). Unexpected errors are logged (message only, no
 * bodies/tokens) and surfaced as an opaque 500. Those same unexpected errors —
 * the ones that become a 500 — are also reported to error tracking (§13.4
 * V4-P5a); expected `ApiError`/`ZodError` outcomes are normal control flow and
 * are never reported. `report` is a no-op when Sentry is disabled.
 */
export function createErrorHandler(logger: Logger, report?: ErrorReporter): ErrorRequestHandler {
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
    report?.(err);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error.' } });
  };
}
