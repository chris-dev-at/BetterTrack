import { DrizzleQueryError } from 'drizzle-orm/errors';

/**
 * drizzle-orm ≥0.44 no longer lets a driver failure reach the caller as-is: the
 * session catches it and rethrows a `DrizzleQueryError` whose message is the
 * failing SQL plus its bound parameters, with the original error hung off
 * `cause`. Every refusal this API maps by SQLSTATE — the `23505` that becomes a
 * 409, the `23503` that names a foreign key, the PL/pgSQL guards that RAISE
 * with a CONSTRAINT — reads `.code`/`.constraint`/`.message` off the thrown
 * object, and the wrapper carries none of them.
 *
 * So peel the wrapper back off at the point of inspection. Only drizzle's own
 * wrapper is unwrapped: a domain error that happens to carry a `cause` is
 * returned untouched, so this can never turn a business refusal into whatever
 * it was raised from. The loop bounds the walk in case a future release nests
 * wrappers; both drivers in use (postgres.js in production, PGlite in tests)
 * put the SQLSTATE on the wrapped error.
 */
export function driverError(error: unknown): unknown {
  let current = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (!(current instanceof DrizzleQueryError) || current.cause === undefined) return current;
    current = current.cause;
  }
  return current;
}

/** True when the failure is the given Postgres SQLSTATE, wrapper or not. */
export function isDriverErrorCode(error: unknown, code: string): boolean {
  return (driverError(error) as { code?: unknown } | null)?.code === code;
}

/**
 * Ceiling on an error message copied into a durable sink — a `problems` row the
 * admin page renders, a log line. Unwrapping the drizzle wrapper is what keeps
 * the SQL and its bound parameters out of those sinks in the first place; this
 * is the backstop for everything else, since neither the `text` column nor pino
 * bounds what it is handed and a single failing write can carry a
 * megabyte-sized value.
 */
export const MAX_ERROR_MESSAGE_CHARS = 2_000;

/**
 * Cap a message at {@link MAX_ERROR_MESSAGE_CHARS}, marking the cut so a
 * truncated line is never mistaken for the whole error. Scrub BEFORE calling
 * this: cutting first would leave the tail half of an email or token in place
 * with nothing left to match it.
 */
export function truncateErrorMessage(message: string): string {
  if (message.length <= MAX_ERROR_MESSAGE_CHARS) return message;
  return `${message.slice(0, MAX_ERROR_MESSAGE_CHARS)}… [truncated]`;
}
