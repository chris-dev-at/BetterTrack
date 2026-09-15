import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { loadConfig } from './config/env';
import { createLogger, LOG_REDACTION, redactForLog, SECRET_KEYS } from './logger';

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

/**
 * A stack is only a stack if it names the error and has a frame. `typeof x ===
 * 'string'` is satisfied by `''`, which is precisely the value a rebuilt error
 * used to log — the assertion passed while the diagnostic was gone.
 */
function expectRealStack(stack: unknown, firstLine: string): void {
  expect(typeof stack).toBe('string');
  const text = stack as string;
  expect(text.split('\n')[0]).toBe(firstLine);
  expect(text).toMatch(/\n\s+at /);
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

/**
 * #1926: the three leak shapes, the error-serializer depth, and the key names
 * the policy did not know.
 *
 * Every recall case below was proven RED against the pre-#1926 policy first
 * (9 paths, depth 2 only) — the red summary is in the PR body. The precision
 * cases were green before and after on purpose: they exist to fail if the
 * widening ever starts eating an ordinary field.
 */
describe('logger redaction — the #1926 shapes', () => {
  it('removes a secret handed in at the TOP level', () => {
    const line = logOne({
      password: 'super-secret-value',
      token: 'super-secret-value',
      apiKey: 'super-secret-value',
      requestId: 'keep-me',
    });

    expect(JSON.stringify(line)).not.toContain('super-secret-value');
    expect(line).toEqual({ requestId: 'keep-me' });
  });

  it('removes a secret nested at depth 3', () => {
    const line = logOne({ outer: { inner: { password: 'super-secret-value', id: 'keep-me' } } });

    expect(JSON.stringify(line)).not.toContain('super-secret-value');
    expect(line).toEqual({ outer: { inner: { id: 'keep-me' } } });
  });

  it('removes a secret inside an array element', () => {
    const line = logOne({
      items: [{ password: 'super-secret-value' }, { id: 'keep-me' }],
    });

    expect(JSON.stringify(line)).not.toContain('super-secret-value');
    expect(line).toEqual({ items: [{}, { id: 'keep-me' }] });
  });

  it('keeps going past depth 3 — the walk is not a fixed ladder', () => {
    // Six levels down, and inside an array on the way, which is the shape a
    // fixed `*.*.key` path list would have missed by exactly one level.
    const line = logOne({
      a: { b: { c: [{ d: { refreshToken: 'super-secret-value', id: 'keep-me' } }] } },
    });

    expect(JSON.stringify(line)).not.toContain('super-secret-value');
    expect(line).toEqual({ a: { b: { c: [{ d: { id: 'keep-me' } }] } } });
  });

  it("removes `res.headers['set-cookie']`, the response side of the header pair", () => {
    const line = logOne({
      res: {
        statusCode: 200,
        headers: {
          'set-cookie': ['bt_session=super-secret-value; HttpOnly; Secure'],
          'content-type': 'application/json',
        },
      },
    });

    expect(JSON.stringify(line)).not.toContain('super-secret-value');
    expect(line).toEqual({
      res: { statusCode: 200, headers: { 'content-type': 'application/json' } },
    });
  });

  // The 15 names #1926 found passing through unredacted, plus the rest of the
  // §10 list. Each is checked at the top level AND at depth 3, because those
  // are the two reaches the old policy did not have.
  it.each([
    'accessToken',
    'refreshToken',
    'sessionToken',
    'inviteToken',
    'shareToken',
    'resetToken',
    'apiToken',
    'userPassword',
    'refreshTokenHash',
    'secret',
    'apiKey',
    'pin',
    'seedPhrase',
    'totpSecret',
    'devicePassword',
    'mnemonic',
    'seed',
    'passphrase',
    'privateKey',
    'access_token',
    'refresh_token',
    'client_secret',
    'twoFactorSecret',
    'otpauthUri',
    'botToken',
  ])('removes `%s` at the top level and at depth 3', (field) => {
    const top = logOne({ [field]: 'super-secret-value', id: 'keep-me' });
    expect(JSON.stringify(top)).not.toContain('super-secret-value');
    expect(top).toEqual({ id: 'keep-me' });

    const deep = logOne({ outer: { inner: { [field]: 'super-secret-value', id: 'keep-me' } } });
    expect(JSON.stringify(deep)).not.toContain('super-secret-value');
    expect(deep).toEqual({ outer: { inner: { id: 'keep-me' } } });
  });

  it('removes the canonical HTTP capitalisations a hand-built header object uses', () => {
    // Node lowercases inbound header names, so a real request can only produce
    // the lowercase forms — these are the spellings a payload assembled by hand
    // carries. Arbitrary casing (`COOKIE`) is still not matched; see
    // `SECRET_KEYS` in logger.ts for why exact matching is the rule.
    const line = logOne({
      req: {
        headers: {
          Cookie: 'bt_session=super-secret-value',
          Authorization: 'Bearer super-secret-value',
          'X-Request-Id': 'keep-me',
        },
      },
      res: { headers: { 'Set-Cookie': ['bt_session=super-secret-value'] } },
    });

    expect(JSON.stringify(line)).not.toContain('super-secret-value');
    expect(line).toEqual({
      req: { headers: { 'X-Request-Id': 'keep-me' } },
      res: { headers: {} },
    });
  });
});

describe('logger redaction — the error serializer (§10, #1926)', () => {
  it('strips a decorated Error without losing the error itself', () => {
    // pino's std `err` serializer copies an error's own enumerable properties
    // onto the log object, so a decorated error puts a secret at depth 3.
    const err = Object.assign(new Error('upstream refused the write'), {
      statusCode: 502,
      body: { email: 'user@example.com', password: 'super-secret-value' },
    });

    const line = logOne({ err });
    const serialized = line.err as Record<string, unknown>;

    expect(JSON.stringify(line)).not.toContain('super-secret-value');
    expect(serialized.type).toBe('Error');
    expect(serialized.message).toBe('upstream refused the write');
    expect(serialized.statusCode).toBe(502);
    expect(serialized.body).toEqual({ email: 'user@example.com' });
    // NOT `typeof stack === 'string'`: that assertion passes on '', which is
    // exactly what a rebuilt error used to log. V8 installs `stack` as an own
    // ACCESSOR over an internal slot, so copying its descriptor onto the clone
    // produced a getter with nothing behind it.
    expectRealStack(serialized.stack, 'Error: upstream refused the write');
  });

  it('strips a secret carried down a non-error `cause` chain (depth 4+)', () => {
    // A plain-object `cause` is copied wholesale by the std serializer, so this
    // lands at `err.cause.request.headers.authorization` — one level below any
    // depth-3 path list.
    const err = Object.assign(new Error('fetch failed'), {
      cause: { request: { headers: { authorization: 'Bearer super-secret-value' }, id: 'r-1' } },
    });

    const line = logOne({ err });
    const serialized = line.err as Record<string, unknown>;

    expect(JSON.stringify(line)).not.toContain('super-secret-value');
    expect(serialized.cause).toEqual({ request: { headers: {}, id: 'r-1' } });
  });

  it('strips a secret from an AggregateError member', () => {
    const member = Object.assign(new Error('member failed'), {
      body: { token: 'super-secret-value' },
    });
    const err = new AggregateError([member], 'all candidates failed');

    const line = logOne({ err });
    const serialized = line.err as Record<string, unknown>;
    const members = serialized.aggregateErrors as Record<string, unknown>[];

    expect(JSON.stringify(line)).not.toContain('super-secret-value');
    expect(members).toHaveLength(1);
    expect(members[0]!.message).toBe('member failed');
    expect(members[0]!.body).toEqual({});
  });

  it('leaves an undecorated Error completely intact', () => {
    const line = logOne({ err: new TypeError('plain failure') });
    const serialized = line.err as Record<string, unknown>;

    expect(serialized.type).toBe('TypeError');
    expect(serialized.message).toBe('plain failure');
    expectRealStack(serialized.stack, 'TypeError: plain failure');
  });

  it.each([
    [
      'a removed secret',
      () => Object.assign(new Error('secret sibling'), { password: 'super-secret-value' }),
      'Error: secret sibling',
    ],
    [
      'a nested change only',
      () => Object.assign(new Error('nested only'), { ctx: { deep: { token: 'x' } } }),
      'Error: nested only',
    ],
    [
      'a [Circular] substitution only',
      () => {
        const err = Object.assign(new Error('cyclic only'), { ctx: {} as Record<string, unknown> });
        err.ctx.self = err;
        return err;
      },
      'Error: cyclic only',
    ],
  ])('keeps a real stack when the error is rebuilt for %s', (_label, build, firstLine) => {
    // Three independent triggers for the rebuild path, because any one of them
    // used to empty the stack — the defect was in the rebuild, not in what
    // caused it.
    const serialized = logOne({ err: build() }).err as Record<string, unknown>;

    expectRealStack(serialized.stack, firstLine);
  });

  it('survives an Error carrying an enumerable getter, and redacts what it returns', () => {
    // `Object.defineProperty(clone, key, { ...accessorDescriptor, value })`
    // throws `TypeError: Invalid property descriptor` — out of `logger.info`,
    // taking the caller down instead of logging.
    const err = new Error('boom');
    Object.defineProperty(err, 'ctx', {
      enumerable: true,
      configurable: true,
      get: () => ({ apiKey: 'super-secret-value', id: 'keep-me' }),
    });

    const line = logOne({ err });
    const serialized = line.err as Record<string, unknown>;

    expect(JSON.stringify(line)).not.toContain('super-secret-value');
    expect(serialized.ctx).toEqual({ id: 'keep-me' });
    expectRealStack(serialized.stack, 'Error: boom');
  });

  it('does not let a getter that throws take down the log call', () => {
    const payload = { id: 'keep-me' } as Record<string, unknown>;
    Object.defineProperty(payload, 'hostile', {
      enumerable: true,
      configurable: true,
      get: () => {
        throw new Error('nope');
      },
    });

    expect(() => logOne({ ctx: payload, password: 'super-secret-value' })).not.toThrow();
  });

  it('never mutates what the caller handed it', () => {
    // A logger that edited the objects it logs would be a worse bug than the
    // one #1926 fixes: the decorated error is rethrown and re-logged upstream.
    const err = Object.assign(new Error('boom'), { body: { password: 'super-secret-value' } });
    const payload = { req: { headers: { cookie: 'c' } }, items: [{ token: 't' }] };

    logOne({ err, ...payload });

    expect(err.body).toEqual({ password: 'super-secret-value' });
    expect(err.message).toBe('boom');
    expect(payload.req.headers.cookie).toBe('c');
    expect(payload.items[0]!.token).toBe('t');
  });

  it('survives a self-referencing payload', () => {
    const cyclic: Record<string, unknown> = { id: 'keep-me', password: 'super-secret-value' };
    cyclic.self = cyclic;

    const line = logOne({ ctx: cyclic });

    expect(JSON.stringify(line)).not.toContain('super-secret-value');
    expect(line).toEqual({ ctx: { id: 'keep-me', self: '[Circular]' } });
  });
});

describe('logger redaction — precision (#1926)', () => {
  it('keeps the diagnostic fields that merely look like secrets', () => {
    // Each of these is either PREFIXED by a redacted key or contains one as a
    // substring. Whole-key matching is the only thing keeping them, at every
    // depth the walk now reaches.
    const ordinary = {
      passwordHashedAt: '2026-01-01T00:00:00.000Z',
      tokenHashedAt: '2026-01-02T00:00:00.000Z',
      passwordHash2: 'not-a-secret-a-column-name',
      tokenId: 'tok_1',
      token_type: 'bearer',
      tokenEndpoint: 'https://example.test/oauth/token',
      tokens: 3,
      credentialId: 'cred_1',
      pinEnabled: true,
      pinned: false,
      seeded: true,
      seedIds: ['a', 'b'],
      contentHash: 'sha256:abc',
      requestHash: 'sha256:def',
      secretsManager: 'none',
      cookies: 2,
    };

    expect(logOne({ ...ordinary })).toEqual(ordinary);
    expect(logOne({ body: { ...ordinary } })).toEqual({ body: ordinary });
    expect(logOne({ a: { b: { c: { ...ordinary } } } })).toEqual({ a: { b: { c: ordinary } } });
  });

  it('pins the key policy itself, so adding or removing one is a visible decision', () => {
    // §10 scope, in one place. A key leaving this list is a widening of what
    // reaches the logs and a key joining it can silently eat a diagnostic
    // field, so both belong in a diff a reviewer has to approve.
    expect([...SECRET_KEYS]).toEqual([
      'password',
      'currentPassword',
      'newPassword',
      'tempPassword',
      'userPassword',
      'devicePassword',
      'accountTempPassword',
      'adminPassword',
      'demoPassword',
      'passwordHash',
      'pin',
      'pinHash',
      'recoveryCode',
      'recoveryCodes',
      'token',
      'tokenHash',
      'accessToken',
      'access_token',
      'refreshToken',
      'refresh_token',
      'refreshTokenHash',
      'idToken',
      'id_token',
      'sessionToken',
      'inviteToken',
      'shareToken',
      'shareTokenHash',
      'resetToken',
      'apiToken',
      'apiTokenHash',
      'downloadToken',
      'downloadTokenHash',
      'pendingToken',
      'botToken',
      'secret',
      'secretHash',
      'secretEncrypted',
      'encryptedSecret',
      'clientSecret',
      'client_secret',
      'clientSecretHash',
      'client_secret_hash',
      'twoFactorSecret',
      'totpSecret',
      'proofSecret',
      'rawSessionSecret',
      'sessionSecrets',
      'apiKey',
      'apikey',
      'api_key',
      'privateKey',
      'private_key',
      'encryptionKey',
      'otpauthUri',
      'recoveryCodeHashes',
      'mnemonic',
      'seed',
      'seedPhrase',
      'passphrase',
      'oldPassphrase',
      'newPassphrase',
      'cookie',
      'Cookie',
      'set-cookie',
      'Set-Cookie',
      'setCookie',
      'authorization',
      'Authorization',
    ]);
    expect(Object.isFrozen(SECRET_KEYS)).toBe(true);
  });

  it('pins the narrow pino-level backstop, so shrinking it stays deliberate', () => {
    // These paths are NOT the policy (that is `redactForLog`); they are the
    // cover for child-logger bindings and `%o` interpolation, which
    // `formatters.log` never sees. Left byte-identical to pre-#1926 main.
    const policy = LOG_REDACTION as { paths: string[]; remove: boolean };

    // The nine depth-2 wildcards are the expensive half and stay exactly as
    // pre-#1926 main had them; everything after is one TOP-LEVEL path per key,
    // which the benchmark measured at 1.01x and which is what closes
    // `child({ token })` and `info('ctx %o', { password })`.
    expect(policy.paths.slice(0, 9)).toEqual([
      'req.headers.cookie',
      'req.headers.authorization',
      '*.password',
      '*.currentPassword',
      '*.newPassword',
      '*.token',
      '*.tempPassword',
      '*.passwordHash',
      '*.tokenHash',
    ]);
    expect(policy.paths.slice(9)).toEqual(
      SECRET_KEYS.map((key) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : `["${key}"]`)),
    );
    expect(policy.paths).toHaveLength(9 + SECRET_KEYS.length);
    expect(policy.remove).toBe(true);
  });
});

describe('logger redaction — cost guard (#1926)', () => {
  it('redacts a 300 KB payload, secret included, inside a bounded wall clock', () => {
    // ~350 KB of import-batch-shaped rows with one secret buried at depth 5
    // inside an array. Measured at ~1.3 ms/op on the development machine; the
    // bound below is ~75× that, so it does not flake on a loaded CI runner but
    // still fails loudly if the redaction ever goes quadratic in payload size.
    const rows = Array.from({ length: 900 }, (_, i) => ({
      idx: i,
      id: `c1b2a3d4-e5f6-4a7b-8c9d-${String(i).padStart(12, '0')}`,
      symbol: `SYM${i % 500}.DE`,
      name: `Instrument number ${i} with a reasonably long human readable name`,
      quantity: `${i}.000000`,
      note: 'imported from broker CSV, column mapping v3, deduplicated on (symbol, bookedAt)',
      meta: { source: 'csv', row: i, credentials: { apiKey: 'super-secret-value' } },
    }));
    const payload = { job: 'imports.apply', body: { rows } };
    expect(JSON.stringify(payload).length).toBeGreaterThan(300_000);

    const written: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        written.push(chunk.toString());
        callback();
      },
    });
    const logger = createLogger(productionConfig(), destination);
    expect(logger.level).toBe('info');

    const iterations = 20;
    const started = Date.now();
    for (let i = 0; i < iterations; i += 1) logger.info(payload, 'probe');
    const elapsed = Date.now() - started;

    expect(written).toHaveLength(iterations);
    expect(written.join('')).not.toContain('super-secret-value');
    expect(elapsed).toBeLessThan(iterations * 100);
  });
});

describe('redactForLog \u2014 the escape hatch a call site can apply by hand', () => {
  it('returns the same reference when there is nothing to redact', () => {
    // Clone-on-write is what keeps the walk affordable on every ordinary line.
    const payload = { jobId: 'snapshot:2026-09-15', counts: { sent: 3, deferred: 1 } };

    expect(redactForLog(payload)).toBe(payload);
  });

  it('drops a subtree it refuses to read rather than passing it through', () => {
    // Fail closed: past the depth bound the subtree is replaced, never emitted
    // unredacted. 30 levels, with the secret below the bound.
    let nested: Record<string, unknown> = { password: 'super-secret-value' };
    for (let i = 0; i < 30; i += 1) nested = { level: i, child: nested };
    const walked = JSON.stringify(redactForLog(nested));

    expect(walked).not.toContain('super-secret-value');
    expect(walked).toContain('[Redacted: max depth]');
  });
});

describe('logger redaction — toJSON, prototypes and opaque values (#1926 review)', () => {
  it('redacts what `toJSON` RENDERS, not the object that defines it', () => {
    // The walk cannot see a key `toJSON` materialises out of a private field —
    // and `toJSON` is what actually gets serialized, so it is what the policy
    // has to inspect.
    class Connection {
      constructor(
        readonly host: string,
        private readonly pw: string,
      ) {}
      toJSON() {
        return { host: this.host, password: this.pw };
      }
    }

    expect(logOne({ c: new Connection('db', 'super-secret-value') })).toEqual({
      c: { host: 'db' },
    });
    expect(logOne({ a: { b: { c: new Connection('db', 'super-secret-value') } } })).toEqual({
      a: { b: { c: { host: 'db' } } },
    });
  });

  it('does not let an OWN `toJSON` re-inject after the redaction ran', () => {
    // The object is rebuilt (it lost `password`), and an own `toJSON` carried
    // onto the rebuilt copy would run afterwards and put the secret back.
    const leaky = {
      id: 'keep-me',
      password: 'super-secret-value',
      toJSON() {
        return { id: 'keep-me', token: 'super-secret-value' };
      },
    };

    const line = logOne({ a: { b: leaky } });

    expect(JSON.stringify(line)).not.toContain('super-secret-value');
    expect(line).toEqual({ a: { b: { id: 'keep-me' } } });
  });

  it('redacts a prototype `toJSON` on an object with nothing else to redact', () => {
    // Nothing on the instance is a secret key, so clone-on-write returns it by
    // reference — and the prototype's `toJSON` then renders one.
    class Conn {
      host = 'db';
      constructor(private readonly pw = 'super-secret-value') {}
      toJSON() {
        return { host: this.host, apiKey: this.pw };
      }
    }

    const line = logOne({ a: { b: new Conn() } });

    expect(JSON.stringify(line)).not.toContain('super-secret-value');
    expect(line).toEqual({ a: { b: { host: 'db' } } });
  });

  it('applies the policy to an Error that defines its own `toJSON`', () => {
    const err = Object.assign(new Error('x'), {
      password: 'super-secret-value',
      toJSON() {
        return { stage: 'upload', apiKey: 'super-secret-value' };
      },
    });

    const line = logOne({ err });

    expect(JSON.stringify(line)).not.toContain('super-secret-value');
    expect(line).toEqual({ err: { stage: 'upload' } });
  });

  it('renders a URL without its query string', () => {
    // `URL.prototype.toJSON` returns `href`, and a provider URL's query string
    // is exactly where an `?apikey=…` lives. Origin + pathname keeps the
    // diagnostic value and drops the credential, the fragment and any userinfo.
    const line = logOne({
      a: { b: { target: new URL('https://api.example.test/v8/quote?apikey=super-secret-value') } },
    });

    expect(JSON.stringify(line)).not.toContain('super-secret-value');
    expect(line).toEqual({ a: { b: { target: 'https://api.example.test/v8/quote' } } });
  });

  it('survives a `toJSON` that throws, rather than taking the log call down', () => {
    const hostile = {
      toJSON() {
        throw new Error('nope');
      },
    };

    expect(logOne({ ctx: hostile })).toEqual({ ctx: '[Redacted: toJSON threw]' });
  });

  it('leaves Date, RegExp and Buffer to their own serialization', () => {
    // The walk must not recurse them: a Buffer's numeric indices are not keys,
    // and walking 32 bytes of key material one element at a time would be both
    // wrong and expensive. `redactForLog` is asserted directly here because
    // what a Buffer finally LOOKS like in a line is pino's business, not this
    // policy's — its redaction engine has mangled a Buffer to "[unable to
    // serialize…]" since long before #1926, with or without this diff.
    const at = new Date('2026-09-15T08:00:00.000Z');
    const blob = Buffer.from('ab');
    const re = /^bt_/u;
    const payload = { at, blob, re, password: 'super-secret-value' };

    const walked = redactForLog(payload) as Record<string, unknown>;

    expect(walked.at).toBe(at);
    expect(walked.blob).toBe(blob);
    expect(walked.re).toBe(re);
    expect(walked.password).toBeUndefined();
    // And a Date still reaches the line as its ISO string.
    expect(logOne({ at })).toEqual({ at: '2026-09-15T08:00:00.000Z' });
  });

  it('drops an own `__proto__` key without polluting Object.prototype', () => {
    // The shape `JSON.parse` produces. Assigning it onto the rebuilt object
    // would set that object's PROTOTYPE rather than a key — the classic
    // pollution primitive — so the subtree is dropped outright.
    const parsed = JSON.parse(
      '{"__proto__":{"password":"super-secret-value","polluted":"yes"},"id":"keep-me"}',
    ) as Record<string, unknown>;

    const line = logOne({ p: parsed });

    expect(JSON.stringify(line)).not.toContain('super-secret-value');
    expect(line).toEqual({ p: { id: 'keep-me' } });
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('logger redaction — the backstop surfaces (#1926 review)', () => {
  it('redacts a child logger`s top-level bindings', () => {
    // Bindings are formatted ONCE at `.child()` time and emitted verbatim on
    // every line after, so `formatters.log` never sees them. Only the pino-level
    // backstop covers this, which is why it carries a top-level path per key.
    const written: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        written.push(chunk.toString());
        callback();
      },
    });
    const child = createLogger(productionConfig(), destination).child({
      token: 'super-secret-value',
      apiKey: 'super-secret-value',
      encryptionKey: 'super-secret-value',
      recoveryCodes: ['super-secret-value'],
      svc: 'jobs',
    });

    child.info({ id: 'keep-me' }, 'probe');
    const line = JSON.parse(written.join('').trim()) as Record<string, unknown>;

    expect(written.join('')).not.toContain('super-secret-value');
    expect(line.svc).toBe('jobs');
    expect(line.id).toBe('keep-me');
  });

  it('redacts an object interpolated into the message with %o / %j', () => {
    const written: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        written.push(chunk.toString());
        callback();
      },
    });
    const logger = createLogger(productionConfig(), destination);

    logger.info('ctx %o', { password: 'super-secret-value', id: 'keep-me' });
    logger.info('ctx %j', { apiKey: 'super-secret-value', id: 'keep-me' });

    expect(written.join('')).not.toContain('super-secret-value');
    expect(written.join('')).toContain('keep-me');
  });

  it('holds the residual carve-out closed: no child loggers exist in apps/api/src', () => {
    // A child binding nested at depth 3+ or inside an array is NOT covered —
    // covering it needs the depth-2 ladder the benchmark rejected. The hole is
    // unreachable rather than fixed, and this is what keeps it unreachable: add
    // a `.child(` and read `LOG_REDACTION` before deleting this assertion.
    const root = import.meta.dirname;
    // `logger.ts` names the call in prose (it documents this very carve-out),
    // and this file creates one deliberately to prove depth-1 bindings are
    // covered. Everything else in `apps/api/src` is production code.
    const exempt = new Set([join(root, 'logger.ts'), join(root, 'logger.test.ts')]);
    const offenders: string[] = [];
    const visit = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          visit(full);
        } else if (
          entry.name.endsWith('.ts') &&
          !exempt.has(full) &&
          readFileSync(full, 'utf8').includes('.child(')
        ) {
          offenders.push(full.slice(root.length + 1));
        }
      }
    };
    visit(root);

    expect(offenders).toEqual([]);
  });
});
