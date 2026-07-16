/**
 * PII / secret scrubber for Sentry events (PROJECTPLAN.md §13.4 V4-P5a).
 *
 * A PURE function wired as Sentry's `beforeSend`: every event passes through
 * here before it can leave the process, so no email address, session cookie,
 * personal API key (`btk_…`), OAuth token (`bto_…`/`btr_…`/`bts_…`),
 * `Authorization` header or raw `Cookie` ever reaches the wire (the "zero PII"
 * acceptance bar). It walks the event depth-first, redacting by KEY (headers,
 * cookies, obvious secret field names) and by VALUE (emails + token-shaped
 * strings anywhere, including inside exception messages and breadcrumbs).
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

// Emails anywhere in a string. Intentionally broad — over-redaction is safe here.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// BetterTrack token shapes: personal API keys and every OAuth token/secret/id
// prefix (§6.13). base64url body, so `[A-Za-z0-9._-]`.
const BT_TOKEN_RE = /\b(?:btk|bto|btr|bts|btc)_[A-Za-z0-9._-]+/g;

// `Authorization: Bearer <token>` / `Basic <creds>` embedded in a free string.
const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;

/** Redact emails and token-shaped substrings from a free-text string. */
export function redactString(value: string): string {
  return value
    .replace(BEARER_RE, (_m, scheme: string) => `${scheme} ${REDACTED_TOKEN}`)
    .replace(BT_TOKEN_RE, REDACTED_TOKEN)
    .replace(EMAIL_RE, REDACTED_EMAIL);
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
