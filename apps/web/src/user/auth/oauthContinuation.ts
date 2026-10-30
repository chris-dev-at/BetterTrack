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
 * The same continuation now also rides the Google round trip (owner directive
 * 2026-10-29): the login and register screens hand it to the API's
 * `/auth/google/start?returnTo=…`, the API binds it to the single-use Google
 * `state` it issues, and the callback lands the browser back on it (or on
 * `/login?returnTo=…` / `/register?google=connected&returnTo=…`). A passkey
 * sign-in never leaves the page, so it simply navigates on to it.
 *
 * **Security (§10, open-redirect class).** A continuation arrives as a plain
 * query parameter (`/register?returnTo=…`, `/login?returnTo=…`), i.e. fully
 * attacker-controlled. It is therefore not sanitized or normalized but
 * *validated*, fail-closed, against one deliberately narrow rule — see
 * {@link safeAuthorizeContinuation}; the API re-validates with the very same
 * function before it stores or redirects to anything.
 */

import { OAUTH_RETURN_TO_PARAM, safeAuthorizeContinuation } from '@bettertrack/contracts';

// The guard itself lives in `@bettertrack/contracts` so the SPA and the API's
// `/auth/google/start` validate a continuation with ONE implementation — the
// two sides of the boundary cannot drift (owner directive 2026-10-29).
export {
  OAUTH_AUTHORIZE_PATH,
  OAUTH_RETURN_TO_PARAM,
  safeAuthorizeContinuation,
} from '@bettertrack/contracts';

/**
 * Optional hint on the authorize URL itself. The mobile app's "Create account"
 * button appends `screen=register` so the tab opens on the registration form
 * with the authorize continuation already attached. Any other value — or none —
 * keeps today's login-first behavior.
 */
export const OAUTH_SCREEN_PARAM = 'screen';
export const OAUTH_SCREEN_REGISTER = 'register';

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

/**
 * The authorize request to hand to a round trip that LEAVES the SPA — Google
 * sign-in goes through two full-page redirects, so router state cannot carry
 * it. `null` when `raw` is not a safe continuation (the caller then starts a
 * plain web sign-in, exactly as before). The `screen` hint is stripped for the
 * same reason as in {@link registerPathForAuthorize}: coming back with it would
 * bounce a failed sign-in straight onto the register form.
 */
export function authorizeReturnTarget(raw: string | null | undefined): string | null {
  const continuation = safeAuthorizeContinuation(raw);
  return continuation === null ? null : withoutScreenHint(continuation);
}

/**
 * The continuation a page URL carries in `?returnTo=` (`/login`, `/register`),
 * or `null`. Exactly ONE occurrence is honoured: a repeated parameter is
 * ambiguous (parsers disagree on which value wins, and the API's
 * `/auth/google/start` parses it to an array and refuses it), so the SPA
 * refuses it too, fail-closed, instead of silently picking the first.
 */
export function continuationFromSearch(search: URLSearchParams | string): string | null {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const values = params.getAll(OAUTH_RETURN_TO_PARAM);
  return values.length === 1 ? safeAuthorizeContinuation(values[0]) : null;
}
