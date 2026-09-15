import { pino, type LoggerOptions } from 'pino';

import type { AppConfig } from './config/env';

/**
 * The §10 redaction policy: cookies, auth headers and password/token fields are
 * stripped so secrets never reach the logs.
 *
 * Exported so `logger.test.ts` can assert the policy against a real pino
 * instance rather than trusting the option object by eye — pino 10.1 replaced
 * the redaction engine (`fast-redact` → `@pinojs/redact`), and this is what
 * proves the swap kept the guarantee.
 *
 * Scope, verified in that test: `*.password` (and friends) matches a secret one
 * level below a top-level key — `{ body: { password } }` — which is the shape
 * request/response payloads arrive in. It does NOT reach a bare top-level
 * `{ password }`, a secret nested three levels deep, or one inside an array.
 * That has always been true, on pino 9 and 10 alike; widening it is a policy
 * change, not a dependency bump, so it is deliberately left alone here.
 */
export const LOG_REDACTION: NonNullable<LoggerOptions['redact']> = {
  paths: [
    'req.headers.cookie',
    'req.headers.authorization',
    '*.password',
    '*.currentPassword',
    '*.newPassword',
    '*.token',
    '*.tempPassword',
    '*.passwordHash',
    '*.tokenHash',
  ],
  remove: true,
};

/**
 * Structured JSON logger (PROJECTPLAN.md §10). Cookies, auth headers and
 * password/token fields are redacted so secrets never reach the logs.
 */
export function createLogger(config: AppConfig) {
  return pino({
    level: config.isTest ? 'silent' : config.isProduction ? 'info' : 'debug',
    redact: LOG_REDACTION,
  });
}

export type Logger = ReturnType<typeof createLogger>;
