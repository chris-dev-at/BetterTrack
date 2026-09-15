import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { loadConfig } from './config/env';
import { createLogger, LOG_REDACTION } from './logger';

/**
 * The §10 promise the logger carries is that a secret handed to it never
 * reaches the log line. Nothing asserted that until now, while the code
 * enforcing it was replaced under us three times across pino 9.11 → 10.3 (see
 * `LOG_REDACTION`). These tests close that gap.
 *
 * Everything here drives `createLogger` itself, not a locally rebuilt pino
 * instance — an earlier draft did the latter and stayed green when `redact:`
 * was deleted from the factory, which is precisely the regression worth
 * catching. Both directions are covered: recall (every configured path is
 * stripped) and precision (a key that merely *looks* like a secret survives, so
 * a future widening cannot quietly start eating real fields).
 */

/**
 * A deliberately NON-test config: `isTest` would set the level to `silent`, and
 * a silent logger emits nothing, which would make every assertion below pass
 * for the wrong reason. This is the `isProduction` path, level `info`.
 */
function productionConfig() {
  return loadConfig({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://logger-test',
    REDIS_URL: 'redis://logger-test',
    SESSION_SECRET: 'logger-test-session-secret-0123456789',
    BT_DATA_ENCRYPTION_KEY_ID: 'logger-test',
    BT_DATA_ENCRYPTION_KEY: 'logger-test-data-encryption-key-0123456789',
  });
}

/** Logs one payload through the real factory and returns the emitted line. */
function logOne(payload: Record<string, unknown>): Record<string, unknown> {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const raw of chunk.toString().split('\n').filter(Boolean)) {
        lines.push(JSON.parse(raw) as Record<string, unknown>);
      }
      callback();
    },
  });

  const logger = createLogger(productionConfig(), destination);
  // Guards the guard: if the level ever came back `silent`, nothing would be
  // emitted and every "the secret is gone" assertion would pass vacuously.
  expect(logger.level).toBe('info');

  logger.info(payload, 'probe');
  expect(lines).toHaveLength(1);

  const line = { ...lines[0] };
  for (const own of ['level', 'time', 'pid', 'hostname', 'msg']) delete line[own];
  return line;
}

describe('logger redaction (§10)', () => {
  it('strips the cookie and authorization headers, keeping the rest of the request', () => {
    const line = logOne({
      req: {
        headers: {
          cookie: 'bt_session=super-secret-session-id',
          authorization: 'Bearer super-secret-access-token',
          'user-agent': 'BetterTrack/1.0',
          'x-request-id': 'req-42',
        },
      },
    });

    expect(JSON.stringify(line)).not.toContain('super-secret');
    expect(line).toEqual({
      req: { headers: { 'user-agent': 'BetterTrack/1.0', 'x-request-id': 'req-42' } },
    });
  });

  it.each([
    'password',
    'currentPassword',
    'newPassword',
    'token',
    'tempPassword',
    'passwordHash',
    'tokenHash',
  ])('removes `%s` from a logged payload object', (field) => {
    const line = logOne({ body: { [field]: 'super-secret-value', email: 'user@example.com' } });

    expect(JSON.stringify(line)).not.toContain('super-secret-value');
    // `remove: true` means the key is gone, not blanked — a `"password":"[Redacted]"`
    // line would still tell a reader which requests carried one.
    expect(line).toEqual({ body: { email: 'user@example.com' } });
  });

  it('applies to any top-level key, not just a hardcoded `body`', () => {
    const line = logOne({
      credentials: { password: 'super-secret-value' },
      invite: { token: 'super-secret-value' },
      session: { id: 'keep-me' },
    });

    expect(JSON.stringify(line)).not.toContain('super-secret-value');
    expect(line).toEqual({ credentials: {}, invite: {}, session: { id: 'keep-me' } });
  });

  it('matches whole keys, not prefixes (precision, not just recall)', () => {
    // Every one of these *starts with* a redacted key. If the engine ever
    // switched from exact-key to prefix matching — or a path gained a stray
    // wildcard — these audit and diagnostic fields would start vanishing from
    // the logs, silently, with no test noticing.
    const line = logOne({
      body: {
        passwordHashedAt: '2026-01-01T00:00:00.000Z',
        tokenHashedAt: '2026-01-02T00:00:00.000Z',
        passwordHash2: 'not-a-secret-a-column-name',
      },
    });

    expect(line).toEqual({
      body: {
        passwordHashedAt: '2026-01-01T00:00:00.000Z',
        tokenHashedAt: '2026-01-02T00:00:00.000Z',
        passwordHash2: 'not-a-secret-a-column-name',
      },
    });
  });

  it('leaves an ordinary line untouched', () => {
    const line = logOne({ jobId: 'snapshot:2026-09-15', durationMs: 42 });

    expect(line).toEqual({ jobId: 'snapshot:2026-09-15', durationMs: 42 });
  });

  it('exposes the policy frozen, so nothing can weaken it at runtime', () => {
    const policy = LOG_REDACTION as { paths: string[]; remove: boolean };

    expect(Object.isFrozen(LOG_REDACTION)).toBe(true);
    expect(Object.isFrozen(policy.paths)).toBe(true);
    expect(() => policy.paths.push('*.somethingElse')).toThrow(TypeError);
    expect(policy.remove).toBe(true);
  });
});
