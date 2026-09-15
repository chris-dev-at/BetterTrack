import type { Request, RequestHandler } from 'express';

import { ApiError } from '../errors';

/**
 * The global JSON body bound every `/api/v1` request rides (PROJECTPLAN.md §10).
 * Declared here rather than inline in `app.ts` because the unlocked restore
 * routes defer the global parser until after authentication and rate limiting.
 * The account-disable route must also fall back to this same bound for callers
 * with nothing to restore. Multiple literals would drift; one cannot.
 */
export const GLOBAL_JSON_BODY_LIMIT = '100kb';

/** Bounded plaintext expansion allowance shared by both unlocked restore routes. */
export const PARANOID_RESTORE_PLAINTEXT_FACTOR = 8;

export const paranoidRestoreJsonLimitBytes = (encryptedMaxBytes: number): number =>
  encryptedMaxBytes * PARANOID_RESTORE_PLAINTEXT_FACTOR + 64 * 1024;

/**
 * The `body-parser` (via `http-errors`) failure types that describe a request
 * the CLIENT got wrong, and the envelope each one answers with.
 *
 * Every message here is OURS. The parser's own message quotes the body — a
 * truncated JSON body surfaces as `Unexpected token 'Q', "{\"a\": QQQ"... is not
 * valid JSON`, which embeds the first bytes of what the caller sent. That string
 * must never be echoed to the client, logged, or persisted onto the admin
 * Problems page, so the type is the only thing read off the error.
 */
const BODY_PARSER_FAILURES: Readonly<
  Record<string, { status: number; code: string; message: string }>
> = {
  'entity.parse.failed': {
    status: 400,
    code: 'MALFORMED_BODY',
    message: 'The request body is not valid JSON.',
  },
  'entity.verify.failed': {
    status: 400,
    code: 'MALFORMED_BODY',
    message: 'The request body failed verification.',
  },
  'request.aborted': {
    status: 400,
    code: 'MALFORMED_BODY',
    message: 'The request body was not fully received.',
  },
  'request.size.invalid': {
    status: 400,
    code: 'MALFORMED_BODY',
    message: 'The request body length does not match its Content-Length header.',
  },
  'entity.too.large': {
    status: 413,
    code: 'PAYLOAD_TOO_LARGE',
    message: 'The request body exceeds the size limit.',
  },
  'parameters.too.many': {
    status: 413,
    code: 'PAYLOAD_TOO_LARGE',
    message: 'The request body carries too many parameters.',
  },
  'charset.unsupported': {
    status: 415,
    code: 'UNSUPPORTED_MEDIA_TYPE',
    message: 'The request body uses an unsupported charset.',
  },
  'encoding.unsupported': {
    status: 415,
    code: 'UNSUPPORTED_MEDIA_TYPE',
    message: 'The request body uses an unsupported content encoding.',
  },
};

/**
 * The error code an unlisted-but-exposable body-parser status answers with, so
 * the fallback stays consistent with the mapped types above. Anything else in
 * the 4xx band is a plain bad request.
 */
const FALLBACK_CODE_BY_STATUS: Readonly<Record<number, string>> = {
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
};

/**
 * Normalise a body-parser failure into the `{ error: { code, message } }`
 * envelope it deserves, or `null` when the error is not one.
 *
 * Without this a parse or limit failure reached the terminal handler as a plain
 * `Error`, was classified as UNEXPECTED, and became a `500 INTERNAL` plus a
 * captured Problems row — an unauthenticated caller could therefore mint
 * unlimited distinct rows (the parser's message varies with the body) and spend
 * the whole per-kind capture budget, blinding the Sentry replacement (§13.5
 * V5-P2). These are 4xx client faults and are reported as such.
 */
export function bodyParserApiError(err: unknown): ApiError | null {
  if (err instanceof ApiError || err === null || typeof err !== 'object') return null;
  const failure = err as {
    type?: unknown;
    status?: unknown;
    statusCode?: unknown;
    expose?: unknown;
  };
  // `body-parser` stamps every error it raises with a `type`; nothing else in
  // this codebase does, so it is the discriminator that keeps a genuine server
  // fault from being downgraded to a 4xx.
  if (typeof failure.type !== 'string') return null;
  const known = BODY_PARSER_FAILURES[failure.type];
  if (known) return new ApiError(known.status, known.code, known.message);
  // An unlisted but exposable 4xx (a future body-parser type) is still answered
  // honestly at its own status — never with its message, and never as a 500.
  // Anything 5xx-shaped stays unexpected and keeps its report + capture.
  const status =
    typeof failure.status === 'number'
      ? failure.status
      : typeof failure.statusCode === 'number'
        ? failure.statusCode
        : null;
  if (failure.expose !== true || status === null || status < 400 || status >= 500) return null;
  // The code follows the status, so an unlisted 413/415 keeps the same vocabulary
  // the mapped types above use rather than shipping a 413 labelled BAD_REQUEST.
  return new ApiError(
    status,
    FALLBACK_CODE_BY_STATUS[status] ?? 'BAD_REQUEST',
    'The request body could not be read.',
  );
}

/** Body-parser failures parked by {@link deferBodyParserFailure}, per request. */
const deferredFailures = new WeakMap<Request, ApiError>();

/**
 * Wrap the GLOBAL body parser so a client-side body failure does not jump
 * straight to the terminal error handler.
 *
 * That jump is the second half of the defect: `next(err)` from a parser mounted
 * at the top of the chain skips every middleware in between — including
 * `limiters.general` — so a malformed body was an unauthenticated, UNMETERED
 * request. The failure is parked here and re-raised by
 * {@link raiseDeferredBodyParserFailure}, mounted after the limiters, so the
 * refusal costs the caller exactly what any other request costs.
 *
 * A failure this normaliser does not recognise is a real fault and is passed on
 * immediately, unchanged.
 */
export function deferBodyParserFailure(parser: RequestHandler): RequestHandler {
  return (req, res, next) => {
    parser(req, res, (err?: unknown) => {
      const failure = bodyParserApiError(err);
      if (!failure) {
        next(err);
        return;
      }
      deferredFailures.set(req, failure);
      // The middleware between here and the raise point reads `req.body` (the
      // per-key request log, the usage capture): hand them the same empty body
      // a bodyless request carries rather than whatever the parser left behind.
      req.body = {};
      next();
    });
  };
}

/**
 * Raise the failure {@link deferBodyParserFailure} parked, if any. Mounted
 * after the rate limiters and before any route, so nothing ever handles a
 * request whose body could not be read.
 */
export const raiseDeferredBodyParserFailure: RequestHandler = (req, _res, next) => {
  const failure = deferredFailures.get(req);
  if (!failure) {
    next();
    return;
  }
  deferredFailures.delete(req);
  next(failure);
};
