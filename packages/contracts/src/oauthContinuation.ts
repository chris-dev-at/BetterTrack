/**
 * The OAuth authorize continuation guard (owner directives 2026-08-07 and
 * 2026-10-29; PROJECTPLAN.md §16).
 *
 * The phone app opens `/oauth/authorize?…` in a Custom Tab. A visitor without a
 * session is bounced to the login screen, and whatever they sign in or register
 * with must come back INTO that pending authorize request — never the webapp
 * home, which would strand them outside the app that started the flow. The
 * pending request is carried as a *continuation*: the same-origin authorize URL.
 *
 * It travels through attacker-reachable channels — a `?returnTo=` query on
 * `/register` and `/login`, and the `returnTo` the SPA hands to the API's
 * `/auth/google/start` — so it is never sanitized or normalized but VALIDATED,
 * fail-closed, against one deliberately narrow rule. The SPA and the API share
 * this single implementation so the two sides of the boundary cannot drift.
 */

/** The one path a continuation may point at. Matches the SPA route. */
export const OAUTH_AUTHORIZE_PATH = '/oauth/authorize';

/** Query parameter that carries the continuation (`/register`, `/login`, Google start). */
export const OAUTH_RETURN_TO_PARAM = 'returnTo';

/** Rejected outright: anything at or below SPACE, plus DEL. */
function hasControlOrSpace(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Validate a continuation target.
 *
 * Accepted — and nothing else:
 *
 *  1. a `string` that starts with a single `/` (a same-origin ABSOLUTE PATH,
 *     never a URL: `https://evil.test`, `javascript:…` and bare relative paths
 *     all fail here);
 *  2. not starting with `//` (a protocol-relative URL is a different origin);
 *  3. containing no backslash (`/\evil.test` is normalized to `//evil.test` by
 *     several browsers), no `#`, and no control character or raw whitespace
 *     (defeats newline smuggling and parser tricks);
 *  4. whose path component — everything before the first `?` — is EXACTLY
 *     {@link OAUTH_AUTHORIZE_PATH}, optionally with one trailing slash. The
 *     comparison is case-sensitive and literal: no traversal, no percent-encoded
 *     variants, no other internal route, not even `/oauth/authorizeX`.
 *
 * The query string is deliberately NOT inspected: it carries the OAuth request
 * (`client_id`, `state`, PKCE `code_challenge`, `redirect_uri`) which must
 * survive verbatim. That is safe because nothing in this flow ever navigates to
 * a `redirect_uri` taken from the query — only to the API-validated `redirectTo`
 * returned by an explicit approve/deny on the consent screen.
 *
 * @returns the value unchanged when it is safe, else `null`.
 */
export function safeAuthorizeContinuation(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (!raw.startsWith('/')) return null;
  if (raw.startsWith('//')) return null;
  if (raw.includes('\\')) return null;
  if (raw.includes('#')) return null;
  if (hasControlOrSpace(raw)) return null;

  const queryAt = raw.indexOf('?');
  const path = queryAt === -1 ? raw : raw.slice(0, queryAt);
  if (path !== OAUTH_AUTHORIZE_PATH && path !== `${OAUTH_AUTHORIZE_PATH}/`) return null;
  return raw;
}
