/**
 * App-native registration inside the OAuth authorize flow (owner directive
 * 2026-08-07; PROJECTPLAN.md §6.13 part 2, §13.4 V4-P2b).
 *
 * The phone app opens `/oauth/authorize?…` in a Custom Tab. A visitor without a
 * session is bounced to `/login`, and until now "create an account" was simply
 * absent there: registering from the tab landed in the WEBAPP, stranding the
 * user outside the app that started the flow. The fix is a *continuation*: the
 * pending authorize request is carried into the register page and, once the
 * account exists (201, session cookie set), the browser goes straight back into
 * that same authorize request → consent → `redirect_uri` → the app.
 *
 * Everything in this module is pure so the security-relevant part — deciding
 * whether a continuation is safe to navigate to — is unit-testable on its own
 * (see `oauthContinuation.test.ts`).
 *
 * **Security (§10, open-redirect class).** A continuation arrives as a plain
 * query parameter (`/register?returnTo=…`), i.e. fully attacker-controlled. It
 * is therefore not sanitized or normalized but *validated*, fail-closed, against
 * one deliberately narrow rule — see {@link safeAuthorizeContinuation}.
 */

/** The one path a continuation may point at. Matches the SPA route. */
export const OAUTH_AUTHORIZE_PATH = '/oauth/authorize';

/** Query parameter that carries the continuation into `/register`. */
export const OAUTH_RETURN_TO_PARAM = 'returnTo';

/**
 * Optional hint on the authorize URL itself. The mobile app's "Create account"
 * button appends `screen=register` so the tab opens on the registration form
 * with the authorize continuation already attached. Any other value — or none —
 * keeps today's login-first behavior.
 */
export const OAUTH_SCREEN_PARAM = 'screen';
export const OAUTH_SCREEN_REGISTER = 'register';

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
 * returned by an explicit approve/deny (see `ConsentPage`).
 *
 * @returns the value unchanged when it is safe, else `null`.
 */
export function safeAuthorizeContinuation(raw: string | null | undefined): string | null {
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

/**
 * Drop the `screen` hint from an authorize URL, leaving everything else byte
 * identical (a URL without the hint is returned untouched — no re-encoding).
 *
 * Load-bearing, not cosmetic: the register page's "back to sign in" path leads
 * to the authorize URL, which bounces an anonymous visitor to `/login`, which
 * honours `screen=register` by redirecting to `/register`. Keeping the hint
 * would make those two screens ping-pong forever.
 */
export function withoutScreenHint(continuation: string): string {
  const queryAt = continuation.indexOf('?');
  if (queryAt === -1) return continuation;
  const params = new URLSearchParams(continuation.slice(queryAt + 1));
  if (!params.has(OAUTH_SCREEN_PARAM)) return continuation;
  params.delete(OAUTH_SCREEN_PARAM);
  const query = params.toString();
  const path = continuation.slice(0, queryAt);
  return query ? `${path}?${query}` : path;
}

/**
 * Does this authorize URL ask to open on the registration form? Unknown or
 * absent hints answer `false`, i.e. today's login-first behavior. Runs the
 * guard first, so a hint on an unsafe value is never honoured.
 */
export function wantsRegisterScreen(raw: string | null | undefined): boolean {
  const continuation = safeAuthorizeContinuation(raw);
  if (continuation === null) return false;
  const queryAt = continuation.indexOf('?');
  if (queryAt === -1) return false;
  return (
    new URLSearchParams(continuation.slice(queryAt + 1)).get(OAUTH_SCREEN_PARAM) ===
    OAUTH_SCREEN_REGISTER
  );
}

/**
 * The register-page URL that continues into `authorizeUrl` after a successful
 * registration. Returns the plain `/register` when the value is not a safe
 * authorize continuation, so an unusable hint degrades to normal registration
 * rather than to a broken link.
 */
export function registerPathForAuthorize(raw: string | null | undefined): string {
  const continuation = safeAuthorizeContinuation(raw);
  if (continuation === null) return '/register';
  const target = withoutScreenHint(continuation);
  return `/register?${OAUTH_RETURN_TO_PARAM}=${encodeURIComponent(target)}`;
}
