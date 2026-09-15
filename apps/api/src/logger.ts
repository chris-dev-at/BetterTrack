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
 * `code` and `otp` were considered for the 2FA additions and REJECTED. `code`
 * appears 538 times in `apps/api/src` and `packages/<name>/src`, almost all of
 * them an error code, an HTTP status code or a currency code — redacting it
 * would blind the logs to the single most useful field they carry, to cover a
 * name the repo never uses for a credential (it uses `recoveryCode`, which IS
 * covered). `otp` appears zero times. A key policy earns its keep by being
 * precise; adding names on suspicion is how it stops being trusted.
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

  // --- 2FA recovery codes (§6.1) -----------------------------------------
  // PLAINTEXT on the way in: `authRoutes.ts` takes `body.recoveryCode` and
  // `authService.verifyTwoFactor` consumes it before it is ever hashed. Only
  // `recoveryCodeHashes` was covered, which is the one form that is safe.
  'recoveryCode',
  'recoveryCodes',

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
  // Google's service-account JSON spells it snake_case (`fcm.ts`).
  'private_key',
  // 47 uses, and every one of them holds RAW key material — `config.twoFactor
  // .encryptionKey` and `config.recordEncryption` are Buffers, which serialize
  // as `{"type":"Buffer","data":[…]}`, i.e. the bytes, in full.
  'encryptionKey',
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
 * discarding destination, best of 5 runs:
 *
 * ```
 *                                       1 KB line   300 KB batch   10k-row array
 *   no redaction at all              1.33 µs 0.21×   501 µs 0.99×   675 µs 0.80×
 *   A  legacy 9 paths (pre-#1926)    6.30 µs 1.00×   504 µs 1.00×   844 µs 1.00×
 *   A+ shipped backstop (77 paths)   6.38 µs 1.01×   505 µs 1.00×   856 µs 1.01×
 *   B  full depth-1..3 ladder (204) 112.51 µs 17.85× 587 µs 1.16× 13794 µs 16.34×
 *   C  shipped (A+ and the walk)     6.54 µs 1.04×   865 µs 1.71×  1877 µs 2.22×
 * ```
 *
 * Absolute numbers move with machine load; the ratios do not (B 15–18× on 1 KB
 * across runs, C 0.93–1.53×).
 *
 * Read the 1 KB column first: a ~1 KB request line is what the API actually
 * emits, and ~16–18× on it is exactly the "measurable p95 regression in the
 * request-log path" #1926 forbids. The 300 KB column — where the issue set its
 * 2× bar — flatters the ladder only because `JSON.stringify` of a big tree
 * dominates everything else there. The third column is the walk's OWN worst
 * case, a shape with many nodes and little text per node: C costs 2.22× there,
 * just outside the bar, against the ladder's 16.34×. That is the honest limit of
 * this design, and the answer for a call site that really must log ten thousand
 * rows is a shaped subset, not a redaction policy.
 *
 * The 68 top-level paths added to this backstop are FREE (A → A+ is 1.01× in
 * every column): pino compiles a top-level path to a censor keyed by that exact
 * key, so `_asJson` pays one property lookup it was already doing. Only the
 * depth-2 wildcards cost, which is why they stay at the original nine.
 *
 * ## What this backstop is for
 *
 * `formatters.log` sees the merge object. It does NOT see the two surfaces pino
 * redacts through its stringifiers, and both of them leaked before #1926:
 *
 *  - **child-logger bindings.** `logger.child({ token })` is formatted ONCE at
 *    creation and then emitted verbatim on every line the child writes.
 *    `formatters.bindings` is not a way in either: pino installs its own
 *    identity formatter on a child before calling `asChindings`, deliberately.
 *  - **`%o` / `%j` / `%O` interpolation**, which pino stringifies through
 *    `redactFmtSym` rather than through the merge object.
 *
 * The nine legacy wildcards covered `{ body: { password } }` in both and
 * nothing else — so `child({ token })`, `child({ apiKey })` and
 * `info('ctx %o', { password })` all went through in cleartext. Adding one
 * TOP-LEVEL path per key closes depth 1 for both surfaces at no measured cost.
 *
 * ## The residual, stated rather than implied
 *
 * A child binding nested at depth 3+ or inside an array
 * (`child({ ctx: { a: { password } } })`, `child({ items: [{ password }] })`)
 * is still NOT covered, because covering it would need the depth-2 ladder this
 * benchmark rejected. It is unreachable rather than fixed: `apps/api/src`
 * contains zero `.child(` calls, and `logger.test.ts` FAILS if one appears, so
 * the first author to add a child logger is made to read this paragraph. The
 * same carve-out is written into PROJECTPLAN §10 rather than left here.
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
const LEGACY_BACKSTOP_PATHS = [
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
 * A TOP-LEVEL path for one key — `password`, or `["set-cookie"]` for a name the
 * dot syntax cannot carry.
 *
 * Top-level paths are the cheap half of pino's redaction: the reducer turns
 * each into a censor keyed by that exact top-level key, so `_asJson` pays one
 * property lookup it was already doing. No wildcard, no selective clone, no
 * per-path walk — which is why all 68 names can be listed here while the
 * depth-2 ladder stays at the original nine. Measured at 1.00× of the 9-path
 * backstop on a 1 KB line (`bench:log-redaction`).
 */
function topLevelPath(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : `["${key}"]`;
}

const REDACTED_PATHS: string[] = [...LEGACY_BACKSTOP_PATHS, ...SECRET_KEYS.map(topLevelPath)];

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

/** What replaces a subtree the walk refuses to read, or cannot. */
const TOO_DEEP = '[Redacted: max depth]';
const CIRCULAR = '[Circular]';
const TOJSON_THREW = '[Redacted: toJSON threw]';
const UNREADABLE = '[Redacted: unreadable]';

/** Distinguishes "the getter threw" from "the property really is that value". */
const READ_FAILED = Symbol('bt.read-failed');

/** Cross-realm-safe `instanceof Error` (a worker thread's Error is not ours). */
function isError(value: object): value is Error {
  return Object.prototype.toString.call(value) === '[object Error]';
}

/**
 * Values that define their own serialization and must NOT be walked.
 *
 * `Date` and `RegExp` render as scalars; a `Buffer`'s numeric indices are not
 * keys, and walking 32 bytes of key material one element at a time would be
 * both wrong and expensive (a Buffer under a secret-named key is removed by the
 * key rule — `encryptionKey` is in the list for exactly that reason).
 *
 * `URL` is here for a different reason: its prototype `toJSON` returns `href`,
 * which carries the query string — and a provider URL's query string is where
 * an `?apikey=…` lives. It is rendered as `origin + pathname`, which keeps the
 * diagnostic value (which host, which route) and drops the query, the fragment
 * and any `user:pass@` userinfo.
 */
function opaque(node: object): { readonly value: unknown } | null {
  if (node instanceof Date || node instanceof RegExp || Buffer.isBuffer(node)) {
    return { value: node };
  }
  if (node instanceof URL) return { value: `${node.origin}${node.pathname}` };
  return null;
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
 * ## `toJSON` is a redirection, not a decoration
 *
 * A value that defines `toJSON` decides what it serializes to, so that — not
 * the value itself — is what the policy has to inspect. The walk calls it once
 * and redacts the RESULT. Skipping that step leaves three live holes, all of
 * them demonstrated before this was written:
 *
 *  - a `toJSON` can MATERIALISE a secret key the walk never saw
 *    (`class Conn { toJSON() { return { host, password: this.pw } } }`);
 *  - an OWN `toJSON` survives a rebuild and re-injects after redaction;
 *  - an Error with an own `toJSON` bypasses the whole error path.
 *
 * The cost is that an Error carrying a `toJSON` logs what its author asked for
 * rather than `type`/`message`/`stack`. That is the same thing `JSON.stringify`
 * would do, and an author who writes `toJSON` on an Error is asking for it.
 *
 * ## Clone-on-write
 *
 * A subtree containing nothing to redact is returned BY REFERENCE, so the
 * common case allocates nothing and the caller's object is never touched — a
 * logger that mutated what it logged would be a far worse bug than the one this
 * fixes. Only a branch that actually loses or changes a key is rebuilt.
 *
 * A rebuilt Error keeps its prototype and its own property descriptors, with
 * one correction that matters on V8: `stack` is an own ACCESSOR over an
 * internal slot, so copying its descriptor onto a fresh object yields
 * `undefined` and the log line gets `"stack": ""`. Accessors are therefore read
 * as VALUES and redefined as data properties — which also removes the
 * `TypeError: Invalid property descriptor` a `{ ...descriptor, value }` spread
 * throws when the descriptor is an accessor.
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
  const asOpaque = opaque(node);
  if (asOpaque) return asOpaque.value;
  if (ancestors.has(node)) return CIRCULAR;
  if (depth >= REDACT_MAX_DEPTH) return TOO_DEEP;

  ancestors.add(node);
  try {
    // `toJSON` first: what it returns is what would have been serialized, so it
    // is what the policy must see. Checked after the opaque types above, since
    // `Date` and `Buffer` both have one.
    const render = (node as { toJSON?: unknown }).toJSON;
    if (typeof render === 'function') {
      let rendered: unknown;
      try {
        rendered = (node as { toJSON: () => unknown }).toJSON();
      } catch {
        return TOJSON_THREW;
      }
      // Same depth: the rendered value stands IN PLACE OF the node, it is not a
      // child of it. A `toJSON` returning `this` is caught by `ancestors`.
      return walk(rendered, depth, ancestors);
    }

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
      // An own `__proto__` (the shape `JSON.parse` produces) is DROPPED rather
      // than copied: assigning it on `kept` would set that object's prototype
      // instead of a key, which silently loses the subtree anyway and is the
      // classic pollution primitive. Dropping it is the same outcome, stated.
      if (key === '__proto__') {
        changed = true;
        continue;
      }
      const child = readOwn(source, key);
      if (child === READ_FAILED) {
        // The object MUST be rebuilt now: returning it by reference would hand
        // pino the same throwing getter, and the exception would come out of
        // `logger.info` instead of out of the walk.
        changed = true;
        kept[key] = UNREADABLE;
        continue;
      }
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
 * Read one property, tolerating a getter that throws.
 *
 * A logged object is frequently not ours — an ORM row, a third-party error, a
 * proxy — and one hostile or merely unlucky accessor must not take down the
 * call that was only trying to log.
 */
function readOwn(source: Record<string, unknown>, key: string): unknown {
  try {
    return source[key];
  } catch {
    return READ_FAILED;
  }
}

/**
 * Rebuild an Error that lost or changed an own property, keeping it an Error.
 *
 * `message`, `stack` and `name` are own but NON-enumerable, so a `{ ...err }`
 * clone produces something `stdSerializers.err` no longer recognises and the
 * line logs as `{}`. Descriptors are therefore carried across — except that
 * ACCESSORS are read as values and redefined as data properties:
 *
 *  - V8 installs `stack` as an own accessor over an internal slot. Copying that
 *    descriptor onto a fresh object gives a getter with nothing behind it, so
 *    `clone.stack` is `undefined` and every rebuilt error logged `"stack": ""`.
 *  - `Object.defineProperty(clone, key, { ...accessorDescriptor, value })`
 *    throws `TypeError: Invalid property descriptor`, out of `logger.info`.
 *
 * `toJSON` is never carried across: an own `toJSON` that survived the rebuild
 * would re-inject whatever it likes after the redaction ran. It cannot normally
 * reach here — {@link walk} redirects through it first — but the rule is stated
 * at the copy rather than assumed at the caller.
 */
function rebuildError(node: Error, kept: Record<string, unknown>): Error {
  const clone = Object.create(Object.getPrototypeOf(node) as object) as Error;
  for (const key of Reflect.ownKeys(node)) {
    if (typeof key === 'string') {
      if (SECRET_KEY_SET.has(key) || key === '__proto__' || key === 'toJSON') continue;
      if (Object.prototype.hasOwnProperty.call(kept, key)) {
        defineData(clone, key, kept[key], isEnumerable(node, key));
        continue;
      }
    }
    const descriptor = Object.getOwnPropertyDescriptor(node, key);
    if (!descriptor) continue;
    if (descriptor.get || descriptor.set) {
      // Read it ONCE, as a value. This is the `stack` case on V8.
      let read: unknown;
      try {
        read = (node as unknown as Record<PropertyKey, unknown>)[key];
      } catch {
        read = UNREADABLE;
      }
      defineData(clone, key, read, descriptor.enumerable === true);
      continue;
    }
    Object.defineProperty(clone, key, descriptor);
  }
  return clone;
}

function isEnumerable(node: object, key: string): boolean {
  return Object.getOwnPropertyDescriptor(node, key)?.enumerable === true;
}

function defineData(target: object, key: PropertyKey, value: unknown, enumerable: boolean): void {
  Object.defineProperty(target, key, { value, enumerable, writable: true, configurable: true });
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
