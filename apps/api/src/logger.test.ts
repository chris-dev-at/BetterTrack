import { Writable } from 'node:stream';

import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import { LOG_REDACTION } from './logger';

/**
 * The §10 promise the logger carries is that a secret handed to it never
 * reaches the log line. pino 10.1 swapped the engine behind `redact`
 * (`fast-redact` → `@pinojs/redact`), so the promise is asserted here against a
 * real pino instance and the real policy object from `logger.ts` — not against
 * a hand-copied list, which would keep passing while the shipped config drifts.
 *
 * Both directions are covered on purpose: recall (every configured path is
 * stripped) and precision (a key that merely *looks* like a secret survives, so
 * a future widening of the paths cannot quietly start eating real fields).
 */
function captureLines() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      callback();
    },
  });
  // `level: 'debug'` mirrors a non-production deploy, the noisiest configuration
  // the policy has to hold for.
  const logger = pino({ level: 'debug', redact: LOG_REDACTION }, stream);
  return { lines, logger };
}

/** Logs one payload and returns the emitted line without pino's own fields. */
function logOne(payload: Record<string, unknown>): Record<string, unknown> {
  const { lines, logger } = captureLines();
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

  it('keeps fields that only look like secrets (precision, not just recall)', () => {
    const line = logOne({
      body: {
        passwordPolicy: 'min-12-chars',
        passwordless: true,
        tokenCount: 7,
        tokenExpiresAt: '2026-01-01T00:00:00.000Z',
        hashedAt: 'never-a-secret',
      },
    });

    expect(line).toEqual({
      body: {
        passwordPolicy: 'min-12-chars',
        passwordless: true,
        tokenCount: 7,
        tokenExpiresAt: '2026-01-01T00:00:00.000Z',
        hashedAt: 'never-a-secret',
      },
    });
  });

  it('leaves an ordinary line untouched', () => {
    const line = logOne({ jobId: 'snapshot:2026-09-15', durationMs: 42 });

    expect(line).toEqual({ jobId: 'snapshot:2026-09-15', durationMs: 42 });
  });
});
