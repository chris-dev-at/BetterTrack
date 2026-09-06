/**
 * PII / secret scrubber for Sentry events (PROJECTPLAN.md §13.4 V4-P5a).
 *
 * A PURE function wired as Sentry's `beforeSend`: every event passes through
 * here before it can leave the process, so no email address, session cookie,
 * personal API key (`btk_…`), OAuth token (`bto_…`/`btr_…`/`bts_…`),
 * `Authorization` header or raw `Cookie` ever reaches the wire (the "zero PII"
 * acceptance bar). It walks the event depth-first, redacting by KEY (headers,
 * cookies, obvious secret field names) and by VALUE (emails — plain or
 * URL-encoded — token-shaped strings and credential-bearing query parameters
 * anywhere, including inside exception messages and breadcrumbs).
 *
 * The value rules carry the whole bar for the §13.5 V5-P2 problem capture,
 * whose provider path stores a thrown fetch/axios message verbatim: that
 * message routinely embeds the full request URL, so `?apikey=…` and a
 * percent-encoded address in a query string must fall to the same pass.
 *
 * It is deliberately dependency-free and Sentry-type-free so it can be unit
 * tested in isolation against plain objects (the colocated `scrubber.test.ts`).
 */

/** A Sentry-event-shaped value: any JSON tree. Scrubbing never assumes a shape. */
export type ScrubbableValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ScrubbableValue[]
  | { [key: string]: ScrubbableValue };

export const REDACTED = '[redacted]';
export const REDACTED_EMAIL = '[redacted-email]';
export const REDACTED_TOKEN = '[redacted-token]';
export const REDACTED_ID = '[redacted-id]';

/**
 * Object keys whose VALUE is wholesale-redacted regardless of content — headers
 * and fields that carry a credential by definition. Compared case-insensitively,
 * with `-`/`_` folded so `access-token`, `access_token` and `accessToken` all
 * match (`session id` etc. are covered by the collapsed form too).
 */
const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  'authorization',
  'proxyauthorization',
  'cookie',
  'cookies',
  'setcookie',
  'xapikey',
  'xauthtoken',
  'apikey',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'sessiontoken',
  'sessionid',
  'session',
  'password',
  'passwd',
  'secret',
  'clientsecret',
  'pin',
]);

const normalizeKey = (key: string): string => key.toLowerCase().replace(/[-_\s]/g, '');

// Emails anywhere in a string, including the URL-encoded form (`%40`) a provider
// error message carries when the address travelled in a query string.
// Intentionally broad — over-redaction is safe here.
//
// The leading lookbehind is a REDOS GUARD, not a matching rule. Without it the
// local-part `+` rescans from every offset inside one unbroken run of email
// characters: on a long run with no `@` behind it, each of the n start offsets
// backtracks over the whole tail, so the scan is O(n²) — 50k chars took ~1.5s
// and 200k took ~24s, which is how an oversized message (a provider blob, or
// the same message again inside the captured stack) stalled the capture path.
// Anchoring to a run BOUNDARY leaves the accepted language untouched: a match
// starting mid-run always has a counterpart starting at that run's first
// character, whose local part merely extends further left, and the whole match
// is replaced wholesale either way. Redundant start offsets are all it removes.
const EMAIL_RE = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// A query-string parameter whose NAME says it carries a credential:
// `?apikey=…`, `&access_token=…`, `?client_secret=…`. Key-based redaction only
// ever saw object keys, so a secret that travelled inside a URL — which is
// exactly what a fetch/axios provider error embeds in its message — survived
// every other rule (an `apikey=` value is not `bt*_`-shaped and not an email).
// The name is matched loosely so `x-api-key`, `apiKey` and `sig` all land.
//
// Split into a SHAPE and a NAME TEST on purpose. Written as the single pattern
// it used to be — `[?&][^?&=\s]*(?:key|token|…)[^?&=\s]*=` — the two unbounded
// runs around the alternation make the scan catastrophic: every keyword
// occurrence the engine reaches by backtracking re-runs the second run to the
// end of the parameter looking for an `=`. `'?' + 'key'.repeat(32_000)` (96 KB)
// took ~1.5 s and a quarter-MB JSON-ish blob ~2.9 s on the API's event loop,
// which the ops cockpit then paid up to 25 times per admin page load (#1853) —
// the same O(n²) shape `EMAIL_RE` above was already given a guard for.
//
// Below, both runs exclude the character that must follow them (`=` for the
// name, `&`/whitespace/quotes for the value), so each has exactly ONE possible
// end and nothing backtracks. The accepted language is unchanged: "a `?`/`&`
// parameter whose name contains a credential word" is now decided by testing
// the matched name, which is a plain scan of a short string.
const QUERY_PARAM_RE = /([?&])([^?&=\s]*)=([^&\s"'<>]*)/g;
const SECRET_PARAM_NAME_RE = /key|token|secret|password|passwd|pwd|auth|credential|signature|sig/i;

/**
 * Replace the VALUE of every credential-named query parameter, keeping the name.
 *
 * Hand-rolled rather than a `.replace` because a non-secret parameter must not
 * consume its own value: the one-pattern form never matched `?foo=…` at all, so
 * a credential parameter sitting inside that value (`?foo=1?apikey=…`) was
 * still found, and swallowing it here would be a silent under-redaction. On a
 * non-secret name the scan resumes just past its `=` — still forward progress,
 * so the walk stays linear.
 */
function redactQuerySecrets(value: string): string {
  QUERY_PARAM_RE.lastIndex = 0;
  let out = '';
  let copied = 0;
  let match: RegExpExecArray | null;
  while ((match = QUERY_PARAM_RE.exec(value)) !== null) {
    const [whole, lead = '', name = ''] = match;
    if (!SECRET_PARAM_NAME_RE.test(name)) {
      QUERY_PARAM_RE.lastIndex = match.index + lead.length + name.length + 1;
      continue;
    }
    out += `${value.slice(copied, match.index)}${lead}${name}=${REDACTED_TOKEN}`;
    copied = match.index + whole.length;
  }
  return copied === 0 ? value : out + value.slice(copied);
}

// BetterTrack token shapes: personal API keys, every OAuth token/secret/id
// prefix (§6.13) and the outbound-webhook signing secret (`whsec_…`, §6.13
// V5-P10) — the one credential shape the scrubber did not know, so it reached
// problem titles and the per-key request log verbatim. base64url body, so
// `[A-Za-z0-9._-]`.
const BT_TOKEN_RE = /\b(?:btk|bto|btr|bts|btc|whsec)_[A-Za-z0-9._-]+/g;

// `Authorization: Bearer <token>` / `Basic <creds>` embedded in a free string.
const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;

/**
 * Redact emails, token-shaped substrings and credential-bearing query
 * parameters from a free-text string. The parameter NAME is kept so the message
 * still reads ("…?apikey=[redacted-token]") — only its value goes.
 */
export function redactString(value: string): string {
  return redactQuerySecrets(
    value
      .replace(BEARER_RE, (_m, scheme: string) => `${scheme} ${REDACTED_TOKEN}`)
      .replace(BT_TOKEN_RE, REDACTED_TOKEN),
  ).replace(EMAIL_RE, REDACTED_EMAIL);
}

// Canonical UUIDs (v1–v5 and the nil UUID) anywhere in a string.
//
// An error message very often names the row it failed on — "portfolio
// 550e8400-… not found" — and that identifier is a user's object, not
// diagnostic information. The operator needs to know WHICH surface is failing
// and WHY, which survives redaction intact.
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * {@link redactString} plus object identifiers — the pass the OPERATIONAL
 * surfaces share (#1847).
 *
 * The dead-letter/breaker panel (`scrubOpsError`) and the Problems capture
 * render the SAME failure text, so a rule that lives in only one of them makes
 * the two surfaces disagree about the same string: `notifications.dispatch`
 * failing on "no recipient for user 550e8400-…" showed `[redacted-id]` in the
 * ops cockpit and the raw user id in the Problems row written from it. One
 * implementation, both callers.
 *
 * Kept OUT of {@link redactString} on purpose: that function is also the
 * per-value pass for the captured context tree and the per-key request log,
 * where an id (a BullMQ job id, our own scheduling handle) is the one thing
 * that makes two identical error strings distinguishable.
 */
export function redactIdentifiers(value: string): string {
  return redactString(value).replace(UUID_RE, REDACTED_ID);
}

/**
 * How much of one free-text string the value rules are ever asked to read.
 *
 * The rules are linear, but linear is not free, and two paths hand them strings
 * that originate OUTSIDE our code and that nothing bounds at write time: a
 * thrown provider message carrying an upstream HTML error page (the Problems
 * capture) and a dead-lettered `failedReason` (the ops cockpit, up to 25 rows
 * per admin page load, on every live-refresh tick). Both run on the API's
 * single event loop, so one oversized string is a product-wide stall, not an
 * admin-console one (#1853).
 *
 * Deliberately far ABOVE every surface's own cap — a captured message is cut to
 * 2 000 chars, an ops string to 300 — so this bound never shortens text a
 * caller would have kept. It only declines to READ a tail nothing renders.
 */
export const SCRUB_INPUT_MAX_CHARS = 16_000;

/**
 * Characters a value rule's match can never span: the query rules key off
 * `?`/`&`/`=`, and every other rule's run stops at whitespace or at one of the
 * quoting characters its value class already excludes. Cutting at one of these
 * therefore cannot split a credential in half.
 */
const SCRUB_CUT_SEPARATORS: ReadonlySet<string> = new Set([
  ...' \t\n\r\f\v',
  ...'?&=,;',
  ...'"\'<>',
]);

/** How far the cut may walk back to reach one of them. */
const SCRUB_CUT_BACKOFF_CHARS = 512;

/**
 * Bound a free-text string to {@link SCRUB_INPUT_MAX_CHARS} BEFORE it is
 * scrubbed, cutting at a separator so no half credential is kept.
 *
 * Order matters in both directions, which is why this is a separate step rather
 * than a plain `slice` at either call site. Scrubbing the raw string first is
 * what let one message stall the loop; cutting blindly first is what
 * {@link redactString}'s callers were warned against, because the kept half of
 * an address or a token matches nothing. Walking back to a separator resolves
 * it: the cut lands BETWEEN tokens, so the tail that goes takes the whole token
 * with it and what stays is still scrubbed in full.
 *
 * If a single unbroken run is longer than the backoff window the cut lands
 * inside it. What survives is then a run PREFIX, and every credential shape we
 * know is matched from its left edge — `btk_…`, `Bearer …` and a query value
 * whose `name=` is retained all still fall to the rules. The callers' own caps
 * (300 and 2 000 chars) also sit an order of magnitude below this bound, so the
 * region around the cut is discarded before anything renders it.
 */
export function boundScrubInput(value: string): string {
  if (value.length <= SCRUB_INPUT_MAX_CHARS) return value;
  const floor = Math.max(0, SCRUB_INPUT_MAX_CHARS - SCRUB_CUT_BACKOFF_CHARS);
  for (let i = SCRUB_INPUT_MAX_CHARS; i > floor; i -= 1) {
    if (SCRUB_CUT_SEPARATORS.has(value[i - 1]!)) return value.slice(0, i - 1);
  }
  return value.slice(0, SCRUB_INPUT_MAX_CHARS);
}

function scrub(value: ScrubbableValue): ScrubbableValue {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value !== null && typeof value === 'object') {
    const out: { [key: string]: ScrubbableValue } = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = SENSITIVE_KEYS.has(normalizeKey(key)) ? REDACTED : scrub(child);
    }
    return out;
  }
  return value;
}

/**
 * Return a deep-scrubbed copy of a Sentry event. Never mutates the input. The
 * whole tree is walked, so credentials survive nowhere — request headers/cookies,
 * `event.user`, `extra`, `contexts`, breadcrumbs and exception messages included.
 * Returns `null` for a nullish input so it composes as a `beforeSend` (returning
 * null drops the event).
 */
export function scrubEvent<T>(event: T | null | undefined): T | null {
  if (!event) return null;
  return scrub(event as ScrubbableValue) as T;
}
