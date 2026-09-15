import { pino, type DestinationStream, type LoggerOptions } from 'pino';

import type { AppConfig } from './config/env';

/**
 * The §10 redaction policy: cookies, auth headers and password/token fields are
 * stripped so secrets never reach the logs.
 *
 * Exported so `logger.test.ts` can assert the policy against a real pino
 * instance instead of reading this object by eye. That is worth doing
 * independently of any version bump, because the code that enforces it has been
 * swapped under us repeatedly and silently: pino used `fast-redact` through
 * 9.11, `slow-redact` in 9.12–9.13, `@pinojs/redact` from 9.14, `slow-redact`
 * again in 10.0, and `@pinojs/redact` from 10.1 on. Two of those swaps have
 * already landed in this repo with nothing asserting the guarantee survived.
 *
 * Scope, verified in that test: `*.password` (and friends) matches a secret one
 * level below a top-level key — `{ body: { password } }` — which is the shape
 * request and response payloads arrive in. It does NOT reach:
 *   - a bare top-level `{ password }`;
 *   - a secret nested three or more levels deep;
 *   - a secret inside an array;
 *   - a key whose case differs. Matching is exact and case-sensitive, so a
 *     hand-built `{ req: { headers: { Cookie } } }` is not redacted. Node
 *     lowercases inbound header names, so no real request can reach that one
 *     today — it is a trap for hand-assembled log payloads only.
 *
 * All four have always been true, on every engine listed above. Widening the
 * policy is a security decision with its own blast radius, not a dependency
 * bump, so it is deliberately left alone here.
 */
const REDACTED_PATHS: string[] = [
  'req.headers.cookie',
  'req.headers.authorization',
  '*.password',
  '*.currentPassword',
  '*.newPassword',
  '*.token',
  '*.tempPassword',
  '*.passwordHash',
  '*.tokenHash',
];

/**
 * Frozen because this is process-wide state backing a security guarantee: pino
 * only reads it (the tests push real log lines through this exact frozen object,
 * so a mutating engine would throw there), and freezing means nothing else can
 * quietly weaken the policy at runtime either.
 *
 * `paths` is declared `string[]` rather than `as const` so it still satisfies
 * pino's `redactOptions`, which types it mutable; the freeze below is what makes
 * it immutable in fact.
 */
Object.freeze(REDACTED_PATHS);

export const LOG_REDACTION: NonNullable<LoggerOptions['redact']> = Object.freeze({
  paths: REDACTED_PATHS,
  remove: true,
});

/**
 * Structured JSON logger (PROJECTPLAN.md §10). Cookies, auth headers and
 * password/token fields are redacted so secrets never reach the logs.
 *
 * `destination` exists for the tests: it lets them assert the real factory —
 * wiring included — instead of a rebuilt pino instance that would keep passing
 * if `redact` were dropped from here. Production passes nothing and keeps
 * pino's default destination.
 */
export function createLogger(config: AppConfig, destination?: DestinationStream) {
  const options: LoggerOptions = {
    level: config.isTest ? 'silent' : config.isProduction ? 'info' : 'debug',
    redact: LOG_REDACTION,
  };
  return destination ? pino(options, destination) : pino(options);
}

export type Logger = ReturnType<typeof createLogger>;
