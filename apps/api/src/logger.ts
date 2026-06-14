import { pino } from 'pino';

import type { AppConfig } from './config/env';

/**
 * Structured JSON logger (PROJECTPLAN.md §10). Cookies, auth headers and
 * password/token fields are redacted so secrets never reach the logs.
 */
export function createLogger(config: AppConfig) {
  return pino({
    level: config.isTest ? 'silent' : config.isProduction ? 'info' : 'debug',
    redact: {
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
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;
