import { safeAuthorizeContinuation } from '@bettertrack/contracts';

/**
 * Upper bound on a carried authorize request. A real `/oauth/authorize?…` URL
 * (client id, redirect URI, scopes, `state`, PKCE challenge) is a few hundred
 * characters; the cap only bounds what an anonymous caller can park in Redis
 * under a Google `state` for its 10-minute lifetime.
 */
export const MAX_AUTHORIZE_RETURN_TO_LENGTH = 4096;

/**
 * Server-side gate for the pending OAuth authorize request a Google sign-in
 * carries through its round trip (owner directive 2026-10-29; §16).
 *
 * The value arrives on the anonymous `GET /auth/google/start?returnTo=…`, so it
 * is fully attacker-controlled. It is validated with the SAME function the SPA
 * uses ({@link safeAuthorizeContinuation} in `@bettertrack/contracts`): a
 * same-origin absolute path whose path component is exactly `/oauth/authorize`
 * (or `/oauth/authorize/`), no `//` prefix, no backslash, no `#`, no control or
 * whitespace character. Anything else — an absolute URL, a protocol-relative
 * `//evil`, another internal route, a non-string (a repeated query parameter
 * parses to an array) or an over-long value — is `null`.
 *
 * Only ever concatenated onto the configured web origin (`appOrigin + value`),
 * so an accepted value cannot leave that origin.
 */
export function authorizeReturnTo(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > MAX_AUTHORIZE_RETURN_TO_LENGTH) return null;
  return safeAuthorizeContinuation(raw);
}
