import { pino, stdSerializers, type DestinationStream, type LoggerOptions } from 'pino';

import type { AppConfig } from './config/env';

/**
 * The key names that must never reach a log line (PROJECTPLAN.md §10, #1926).
 *
 * ## What this list is
 *
 * Exact, whole-key names — not prefixes, not substrings, not patterns. The
 * union of three sources, kept in one place so the policy is auditable in a
 * diff:
 *
 *  1. §10's own list (passwords, PIN, share/invite tokens, API keys, cookies
 *     and auth headers — "never logged");
 *  2. the names #1926 found passing through unredacted;
 *  3. the field names this repository actually uses, recovered by grepping
 *     every object key in `apps/api/src` and `packages/<name>/src` for one of
 *     token / secret / password / passphrase / pin / key / cookie /
 *     authorization. A policy written from memory redacts `refreshToken` and
 *     misses `refresh_token`, which is the shape the OAuth repository stores
 *     (§6.13).
 *
 * ## What it deliberately is NOT
 *
 * `hash`, `contentHash`, `requestHash`, `dedupHash`, `documentSetHash`,
 * `versionSetHash`, `codeHash`, `salt` and `nonce` are absent. None of them
 * carries a credential, and all of them are how two otherwise identical log
 * lines are told apart. `session`, `tokens`, `tokenId`, `token_type`,
 * `tokenEndpoint`, `credentialId`, `pinEnabled`, `pinSet`, `pinRequired`,
 * `seeded` and `seedIds` survive for the same reason — whole-key matching is
 * what keeps them, and `logger.test.ts` pins that with keys that are each
 * PREFIXED by a redacted one (`passwordHashedAt`, `tokenHashedAt`,
 * `passwordHash2`).
 *
 * It is also NOT the Sentry / problem-capture scrubber
 * (`services/observability/scrubber.ts`). That one folds case and `-`/`_`,
 * redacts by VALUE as well as by key (emails, `btk_…` shapes, credential query
 * parameters) and eats `session` and `sessionid` wholesale. Its bar is higher
 * because its output LEAVES the process; the trade is that it is lossy in ways
 * an operator reading `docker logs` would resent. Two policies, on purpose, and
 * neither is derived from the other.
 *
 * ## Case
 *
 * Matching is exact and case-sensitive, in both enforcement layers below. The
 * cheap normalisation available is enumeration, so the canonical HTTP spellings
 * a HAND-BUILT header object uses (`Cookie`, `Authorization`, `Set-Cookie`) are
 * listed next to the lowercase forms. Arbitrary casing (`COOKIE`, `CoOkIe`)
 * still passes through. Node lowercases inbound header names, so no real
 * request can reach that gap, and outbound headers are never logged (native
 * `fetch` only) — it is a trap for hand-assembled log payloads only.
 *
 * Case folding was considered and rejected for this policy: it would make the
 * two layers disagree with each other unless both were hand-rolled (pino's
 * redaction engine has no case-insensitive mode), and folding `-`/`_` as the
 * Sentry scrubber does would start eating `token_type` and `id_token`'s
 * neighbours. Enumeration keeps one rule — "this exact key" — that a reader can
 * check against a log line by eye.
 *
 * Exported so the test suite can pin the list itself — adding or removing a key
 * is a §10 policy change and should be visible as one in a diff — and so the
 * cost benchmark measures the real thing rather than a copy of it.
 */
export const SECRET_KEYS: readonly string[] = Object.freeze([
  // --- Passwords (§10: argon2id at rest, never logged) -------------------
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

  // --- PIN (§6.1) --------------------------------------------------------
  'pin',
  'pinHash',

  // --- Session, share, invite and OAuth tokens (§6.8, §6.13) -------------
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

  // --- Secrets and keys --------------------------------------------------
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
  // The TOTP enrolment URI embeds the shared secret in its query string.
  'otpauthUri',
  'recoveryCodeHashes',

  // --- Vault recovery material (§13.5 paranoid vaults) -------------------
  // Client-side only today; listed so the server can never start logging it.
  // `seed` collides with `liveModeService`'s `seed: true` frame flag — no live
  // frame is logged today (the call sites log `frame.assetId`, never the
  // frame), and losing a boolean diagnostic is the cheap side of that trade.
  'mnemonic',
  'seed',
  'seedPhrase',
  'passphrase',
  'oldPassphrase',
  'newPassphrase',

  // --- Headers -----------------------------------------------------------
  'cookie',
  'Cookie',
  'set-cookie',
  'Set-Cookie',
  'setCookie',
  'authorization',
  'Authorization',
]);

/** Membership test for {@link redactForLog}. Exact keys, as documented above. */
const SECRET_KEY_SET: ReadonlySet<string> = new Set(SECRET_KEYS);

/**
 * The narrow declarative backstop handed to pino's own `redact` option — NOT
 * the §10 policy. {@link SECRET_KEYS} + {@link redactForLog} are the policy.
 *
 * ## Why this list is short, with the numbers that made it short (#1926)
 *
 * The obvious fix for #1926's three leak shapes was to widen these paths: add
 * every key at every depth, `@pinojs/redact` supports the wildcards
 * (`password`, `*.password`, `*.*.password`; `*` matches an array index too, so
 * `{ items: [{ password }] }` is covered by the depth-3 form). It works. It is
 * also unaffordable, because the engine's cost is LINEAR IN PATH COUNT and paid
 * on every log line — it selectively clones every branch a path can reach, then
 * walks the result once per path.
 *
 * Measured by `pnpm --filter @bettertrack/api bench:log-redaction`
 * (`src/scripts/benchLogRedaction.ts`, committed so the comparison can be re-run
 * when the Docker base reaches Node ≥ 25 and pino's `JSON.stringify` fast path
 * activates). One representative run, Node 24.14.1, `logger.info` into a
 * discarding destination, best of 5 runs of 20 000 / 200 iterations:
 *
 * ```
 *                                        1 KB request line   300 KB import batch
 *   no redaction at all                    2.55 µs  0.18×        984 µs  1.02×
 *   A backstop only (main today)          14.20 µs  1.00×        960 µs  1.00×
 *   B full depth-1..3 ladder (192 paths) 210.10 µs 14.79×       1098 µs  1.14×
 *   C shipped: backstop + walk + err      13.16 µs  0.93×       1669 µs  1.74×
 * ```
 *
 * Absolute numbers move with machine load; the ratios do not. Across five runs:
 * B costs 14.8–18.2× on 1 KB and 1.11–1.24× on 300 KB, C costs 0.93–1.53× and
 * 1.69–1.80×.
 *
 * The 300 KB column is where #1926 set its 2× bar, and the widened ladder passes
 * it — but only because `JSON.stringify` of a big tree dominates everything else
 * there. The column that decides is the other one: a ~1 KB request line is what
 * the API actually emits, and ~16× on it is exactly the "measurable p95
 * regression in the request-log path" the issue forbids. So the global wildcard
 * policy is rejected on measurement, and the redaction is done in ONE pass by
 * {@link redactForLog} instead — complete (any depth, arrays, all 64 keys) at
 * roughly parity on the hot path and 1.7–1.8× on a 300 KB line, both inside the
 * bar.
 *
 * ## What this backstop is still for
 *
 * `formatters.log` sees the merge object. It does NOT see the two surfaces
 * pino redacts through its stringifiers, so these paths — deliberately left
 * BYTE-IDENTICAL to what main ships, so #1926's "existing redaction unchanged"
 * is true by inspection — still cover:
 *
 *  - child-logger bindings (`logger.child({ … })`, formatted once at creation
 *    and then emitted verbatim on every line);
 *  - an object interpolated into the message with `%o` / `%j`.
 *
 * Neither exists in `apps/api/src` today (grepped: zero `.child(`, zero printf
 * object interpolation), which is what makes a 9-path backstop the right size.
 * If either ever appears, it inherits the old policy's reach — depth 2, the
 * shapes listed here — not the full one; `logger.test.ts` pins the backstop's
 * contents so that stays a deliberate decision.
 *
 * ## Frozen
 *
 * Because this is process-wide state backing a security guarantee: pino only
 * reads it (the tests push real log lines through this exact frozen object, so
 * a mutating engine would throw there), and freezing means nothing else can
 * quietly weaken the policy at runtime either. `paths` is declared `string[]`
 * rather than `as const` so it still satisfies pino's `redactOptions`, which
 * types it mutable; the freeze is what makes it immutable in fact.
 *
 * Kept independently of any version bump, because the code enforcing it has
 * been swapped under us repeatedly and silently: pino used `fast-redact`
 * through 9.11, `slow-redact` in 9.12–9.13, `@pinojs/redact` from 9.14,
 * `slow-redact` again in 10.0, and `@pinojs/redact` from 10.1 on.
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

Object.freeze(REDACTED_PATHS);

export const LOG_REDACTION: NonNullable<LoggerOptions['redact']> = Object.freeze({
  paths: REDACTED_PATHS,
  remove: true,
});

/**
 * How deep {@link redactForLog} walks before it stops trusting the input.
 *
 * Generous — an error `cause` chain is a handful of levels and nothing we log
 * comes close. Past it the subtree is DROPPED rather than passed through: a
 * bound that fails open is not a bound.
 */
const REDACT_MAX_DEPTH = 24;

/** What replaces a subtree the walk refuses to read. */
const TOO_DEEP = '[Redacted: max depth]';
const CIRCULAR = '[Circular]';

/** Cross-realm-safe `instanceof Error` (a worker thread's Error is not ours). */
function isError(value: object): value is Error {
  return Object.prototype.toString.call(value) === '[object Error]';
}

/**
 * Remove every {@link SECRET_KEYS} key from a value, at ANY depth, without
 * mutating it. This is the §10 policy; everything else here is wiring.
 *
 * ## Why a walk rather than pino's path syntax
 *
 * See {@link LOG_REDACTION}: path-based redaction costs ~1 µs per path per log
 * line, so 64 keys × 3 depths is 16× the hot path. One walk is O(nodes) and
 * indifferent to how many key names the policy names — which is what lets the
 * policy be as long as it needs to be, and cover depth 4, 40 and arrays for
 * free.
 *
 * ## Clone-on-write
 *
 * A subtree containing nothing to redact is returned BY REFERENCE, so the
 * common case allocates nothing and the caller's object is never touched — a
 * logger that mutated what it logged would be a far worse bug than the one this
 * fixes. Only a branch that actually loses a key is rebuilt.
 *
 * Two consequences of a rebuild, both deliberate and both confined to objects
 * that genuinely carried a secret:
 *
 *  - a rebuilt plain object loses a custom `toJSON` (it becomes a plain
 *    object). Failing closed — dropping the secret and the custom shape — beats
 *    failing open;
 *  - a rebuilt Error keeps its prototype and ALL its own property descriptors
 *    (`message` and `stack` are own but non-enumerable), so it is still an
 *    Error to `stdSerializers.err` downstream. Only that is special-cased,
 *    because an Error that stopped being error-like would be logged as `{}`.
 *
 * `Date`, `RegExp` and `Buffer` are opaque: recursing them would be wrong (a
 * Buffer's numeric indices are not keys) and expensive.
 *
 * Cycles are tracked along the current PATH, not globally, so a value that
 * legitimately appears twice in one tree is not mislabelled as circular.
 *
 * Exported because a call site logging a payload whose nesting it cannot bound
 * can apply it by hand — `logger.info({ payload: redactForLog(payload) }, …)` —
 * though the factory below already applies it to every log line, so that is
 * belt-and-braces rather than a requirement.
 */
export function redactForLog<T>(value: T): T {
  return walk(value, 0, new Set<object>()) as T;
}

function walk(value: unknown, depth: number, ancestors: Set<object>): unknown {
  if (value === null || typeof value !== 'object') return value;

  const node = value as object;
  if (node instanceof Date || node instanceof RegExp || Buffer.isBuffer(node)) return node;
  if (ancestors.has(node)) return CIRCULAR;
  if (depth >= REDACT_MAX_DEPTH) return TOO_DEEP;

  ancestors.add(node);
  try {
    if (Array.isArray(node)) {
      const out: unknown[] = new Array<unknown>(node.length);
      let changed = false;
      for (let i = 0; i < node.length; i += 1) {
        const child: unknown = node[i];
        const next = walk(child, depth + 1, ancestors);
        if (next !== child) changed = true;
        out[i] = next;
      }
      return changed ? out : node;
    }

    const source = node as Record<string, unknown>;
    const kept: Record<string, unknown> = {};
    let changed = false;
    for (const key of Object.keys(source)) {
      if (SECRET_KEY_SET.has(key)) {
        // `remove` semantics, matching the backstop: the key goes, not just its
        // value. A `"password":"[Redacted]"` line would still tell a reader
        // which requests carried one.
        changed = true;
        continue;
      }
      const child = source[key];
      const next = walk(child, depth + 1, ancestors);
      if (next !== child) changed = true;
      kept[key] = next;
    }
    if (!changed) return node;
    return isError(node) ? rebuildError(node, kept) : kept;
  } finally {
    ancestors.delete(node);
  }
}

/**
 * Rebuild an Error that lost or changed an own enumerable property, preserving
 * its prototype and every descriptor the walk did not touch — `message`,
 * `stack` and `name` are own but NON-enumerable, so a `{ ...err }` style clone
 * would silently produce an object `stdSerializers.err` no longer recognises.
 */
function rebuildError(node: Error, kept: Record<string, unknown>): Error {
  const clone = Object.create(Object.getPrototypeOf(node) as object) as Error;
  for (const key of Reflect.ownKeys(node)) {
    if (typeof key === 'string' && SECRET_KEY_SET.has(key)) continue;
    if (typeof key === 'string' && Object.prototype.hasOwnProperty.call(kept, key)) {
      Object.defineProperty(clone, key, {
        ...Object.getOwnPropertyDescriptor(node, key),
        value: kept[key],
      });
      continue;
    }
    Object.defineProperty(
      clone,
      key,
      Object.getOwnPropertyDescriptor(node, key) as PropertyDescriptor,
    );
  }
  return clone;
}

/**
 * pino's std error serializer, then the §10 key policy over its whole output.
 *
 * Needed because `stdSerializers.err` does not just copy `type` / `message` /
 * `stack`: it copies every own ENUMERABLE property of the error verbatim, maps
 * an `AggregateError`'s members into `aggregateErrors`, and copies a
 * non-error-like `cause` wholesale. An error decorated with a request body —
 * `Object.assign(new Error('…'), { body })` — therefore lands at
 * `err.body.password` (depth 3), and through a cause chain at
 * `err.cause.body.password` (depth 4) and deeper. 66 `logger.*({ err }, …)`
 * call sites inherit this; none of them has to know.
 *
 * pino runs serializers BEFORE the redaction stringifiers and AFTER
 * `formatters.log`, so this is the second of the two passes an error gets: the
 * walk in `formatters.log` cleans the Error object itself, this one cleans what
 * the serializer synthesised from it.
 */
function redactingErrSerializer(err: unknown): unknown {
  return redactForLog(stdSerializers.err(err as Error));
}

/**
 * Structured JSON logger (PROJECTPLAN.md §10). Cookies, auth headers and
 * password / token / secret / PIN / recovery-phrase fields are removed before
 * anything is written, at any depth and inside arrays.
 *
 * Three layers, each covering what the others cannot reach:
 *
 *  1. `formatters.log` — {@link redactForLog} over the whole merge object, the
 *     actual policy;
 *  2. `serializers.err` — the same policy over what pino's error serializer
 *     synthesises (own enumerable props, `cause`, `aggregateErrors`);
 *  3. `redact` — {@link LOG_REDACTION}, the narrow backstop for child bindings
 *     and `%o` interpolation, which neither of the other two sees.
 *
 * `destination` exists for the tests: it lets them assert the real factory —
 * wiring included — instead of a rebuilt pino instance that would keep passing
 * if the redaction were dropped from here. Production passes nothing and keeps
 * pino's default destination.
 */
export function createLogger(config: AppConfig, destination?: DestinationStream) {
  const options: LoggerOptions = {
    level: config.isTest ? 'silent' : config.isProduction ? 'info' : 'debug',
    redact: LOG_REDACTION,
    formatters: { log: redactForLog },
    serializers: { err: redactingErrSerializer },
  };
  return destination ? pino(options, destination) : pino(options);
}

export type Logger = ReturnType<typeof createLogger>;
