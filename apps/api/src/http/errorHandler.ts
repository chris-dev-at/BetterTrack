import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

import { driverError, truncateErrorMessage } from '../data/driverError';
import { ApiError, EnvelopeApiError } from '../errors';
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
  const reportUnexpected = (err: unknown) => {
    // Log the DRIVER failure, not drizzle's wrapper: since 0.44 a wrapped query
    // error's message is the failing SQL plus every bound parameter, so logging
    // it verbatim would write the row's contents into the log — which pino's
    // key-based `redact` cannot help with, the value being one string. Capped
    // for the same reason. `report` still gets the error as thrown: the problem
    // service unwraps it itself and wants the cause chain intact.
    const cause = driverError(err);
    logger.error(
      { err: cause instanceof Error ? truncateErrorMessage(cause.message) : 'unknown' },
      'Unhandled request error',
    );
    report?.(err);
  };

  return (err, _req, res, next) => {
    if (!res.headersSent) {
      res.removeHeader('ETag');
      res.removeHeader('Last-Modified');

      if (err instanceof ApiError) {
        // `EnvelopeApiError` contributes top-level members beside `error` (the
        // Vaults v2 CAS contract's `currentVersion`, design r2 §15). Spread FIRST
        // so `error` always wins — an envelope can add fields, never rewrite the
        // error itself.
        res.status(err.statusCode).json({
          ...(err instanceof EnvelopeApiError ? err.envelope : {}),
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

      reportUnexpected(err);
      res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error.' } });
      return;
    }

    if (!(err instanceof ApiError) && !(err instanceof ZodError)) {
      reportUnexpected(err);
    }

    next(err);
  };
}
