import { randomUUID } from 'node:crypto';

import type { ErrorRequestHandler, Request } from 'express';
import { ZodError } from 'zod';

import { driverError, truncateErrorMessage } from '../data/driverError';
import { ApiError, EnvelopeApiError } from '../errors';
import type { Logger } from '../logger';
import { normalizeRoutePath } from '../services/security/routePath';

import { bodyParserApiError } from './bodyLimits';

/**
 * The request facts a report carries. Written to the captured problem's context
 * AND to the log line, so a row on the admin Problems page and the container log
 * can be tied together by `requestId` — without which the largest error class
 * (an unhandled 500) arrives identifying nothing but its own message.
 *
 * A type alias rather than an interface on purpose: it is handed to
 * `ProblemService.captureError`, whose context parameter is an index-signature
 * type that only a type alias satisfies implicitly.
 */
export type ErrorRequestContext = {
  method: string;
  /** Parameterised route template (`/api/v1/portfolios/:id`) — never raw ids. */
  route: string;
  status: number;
  requestId: string;
};

/** Reports an unexpected error to error tracking (Sentry) and the DB capture. */
export type ErrorReporter = (err: unknown, context: ErrorRequestContext) => void;

/**
 * A path segment that is an IDENTITY rather than a route word: a uuid, a hash,
 * a numeric id, a token body. Only used on the fallback path below.
 */
const ID_SEGMENT_RE = /^(?:\d+|[0-9a-f][0-9a-f-]{7,}|[A-Za-z0-9._~-]{20,})$/i;

/**
 * Derive a LOW-cardinality, id-free route template for the failed request.
 *
 * `req.route.path` is the matched pattern (`/:id`) and is never restored by the
 * router, but `req.baseUrl` IS — by the time an error reaches the app-level
 * handler it has been rewound to `''`, so the mount prefix cannot be read off
 * it. The prefix is therefore taken from `req.originalUrl`, dropping exactly as
 * many trailing segments as the matched pattern contributes.
 *
 * Nothing matched (an error thrown before routing, or a 404 path) falls back to
 * masking id-shaped segments — the template must never carry a concrete id,
 * because it enters the fold key and would split one broken endpoint into a row
 * per id.
 */
export function requestRouteTemplate(req: Request): string {
  const rawPath = (req.originalUrl || req.url || '/').split('?', 1)[0]!;
  // Mask the URL segments unconditionally: the prefix can itself carry a mount
  // parameter (`/portfolios/<uuid>/…`) that the matched pattern says nothing
  // about, and a concrete id must not survive on either half.
  const segments = rawPath
    .split('/')
    .filter(Boolean)
    .map((segment) => (ID_SEGMENT_RE.test(segment) ? ':id' : segment));
  const pattern = typeof req.route?.path === 'string' ? req.route.path : null;
  const matched = pattern === null ? [] : pattern.split('/').filter(Boolean);
  if (pattern !== null && matched.length <= segments.length) {
    const prefix = segments.slice(0, segments.length - matched.length);
    return normalizeRoutePath(`/${[...prefix, ...matched].join('/')}`);
  }
  return normalizeRoutePath(`/${segments.join('/')}`);
}

/**
 * Terminal error middleware → the `{ error: { code, message, details? } }`
 * envelope (PROJECTPLAN.md §8). Unexpected errors are logged (message only, no
 * bodies/tokens) and surfaced as an opaque 500. Those same unexpected errors —
 * the ones that become a 500 — are also reported to error tracking (§13.4
 * V4-P5a); expected `ApiError`/`ZodError` outcomes are normal control flow and
 * are never reported. `report` is a no-op when Sentry is disabled.
 */
export function createErrorHandler(logger: Logger, report?: ErrorReporter): ErrorRequestHandler {
  const reportUnexpected = (err: unknown, context: ErrorRequestContext) => {
    // Log the DRIVER failure, not drizzle's wrapper: since 0.44 a wrapped query
    // error's message is the failing SQL plus every bound parameter, so logging
    // it verbatim would write the row's contents into the log — which pino's
    // key-based `redact` cannot help with, the value being one string. Capped
    // for the same reason. `report` still gets the error as thrown: the problem
    // service unwraps it itself and wants the cause chain intact.
    const cause = driverError(err);
    logger.error(
      { err: cause instanceof Error ? truncateErrorMessage(cause.message) : 'unknown', ...context },
      'Unhandled request error',
    );
    report?.(err, context);
  };

  return (err, req, res, next) => {
    // One id per report, in the log line AND in the captured row: the capture is
    // fire-and-forget and carries no trace context of its own, so this is what
    // lets an operator move from a row on the Problems page to the log for the
    // request that produced it.
    const contextFor = (): ErrorRequestContext => ({
      method: req.method,
      route: requestRouteTemplate(req),
      // Before the response is sent `res.statusCode` is still the default 200 —
      // the status this path is ABOUT to write is 500.
      status: res.headersSent ? res.statusCode : 500,
      requestId: randomUUID(),
    });

    // A body-parser failure (truncated JSON, a body over the bound, an encoding
    // we do not speak) is a CLIENT fault that used to arrive here as a plain
    // `Error` and leave as a 500 — wrong status, 5xx metric pollution, and a
    // captured Problems row whose message quoted the body. Normalised first so
    // it travels the ordinary `ApiError` path: right status, no report, no
    // capture. `ApiError`/`ZodError` are never candidates, so their handling
    // below is untouched.
    const effective = bodyParserApiError(err) ?? err;

    if (!res.headersSent) {
      res.removeHeader('ETag');
      res.removeHeader('Last-Modified');

      if (effective instanceof ApiError) {
        // `EnvelopeApiError` contributes top-level members beside `error` (the
        // Vaults v2 CAS contract's `currentVersion`, design r2 §15). Spread FIRST
        // so `error` always wins — an envelope can add fields, never rewrite the
        // error itself.
        res.status(effective.statusCode).json({
          ...(effective instanceof EnvelopeApiError ? effective.envelope : {}),
          error: {
            code: effective.code,
            message: effective.message,
            ...(effective.details !== undefined ? { details: effective.details } : {}),
          },
        });
        return;
      }

      if (effective instanceof ZodError) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request.',
            details: effective.flatten(),
          },
        });
        return;
      }

      reportUnexpected(err, contextFor());
      res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error.' } });
      return;
    }

    if (!(effective instanceof ApiError) && !(effective instanceof ZodError)) {
      reportUnexpected(err, contextFor());
    }

    next(err);
  };
}
