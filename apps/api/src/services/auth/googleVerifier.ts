import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

/**
 * The subset of Google ID-token (OIDC) claims the sign-in flow acts on (§13.4
 * V4-P4b). `sub` is the stable Google user id; `emailVerified` gates the
 * link-by-email path — an unverified email NEVER links to an existing account.
 */
export interface GoogleClaims {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
}

/**
 * Server-side Google authorization-code verifier. The single network-touching
 * seam of the Google flow: it exchanges the code for tokens and returns the
 * VERIFIED ID-token claims (signature + `iss`/`aud`/`exp` all checked). Injected
 * so the auth service — and its tests — never touch the network (a stub returns
 * canned claims). PROJECTPLAN.md §13.4 V4-P4b requires exactly this shape.
 */
export interface GoogleTokenVerifier {
  exchangeAndVerify(input: { code: string; redirectUri: string }): Promise<GoogleClaims>;
}

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';
// Google issues tokens under either form; accept both (documented on both sides).
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export interface CreateGoogleVerifierDeps {
  clientId: string;
  clientSecret: string;
  /** Test seam: override the fetch used for the token exchange. */
  fetchImpl?: typeof fetch;
  /**
   * Test seam: override the JWKS key resolver (defaults to Google's remote,
   * cached JWKS). A unit test passes a local key so the `iss`/`aud`/`exp` checks
   * run against a signed token with no network.
   */
  keyResolver?: JWTVerifyGetKey;
}

/**
 * The production verifier: a form-encoded POST to Google's token endpoint, then
 * a jose signature+claims verification of the returned `id_token` against
 * Google's rotating JWKS (cached by `createRemoteJWKSet`). Every failure throws
 * — the caller maps that to a friendly redirect, never leaking token details.
 */
export function createGoogleVerifier(deps: CreateGoogleVerifierDeps): GoogleTokenVerifier {
  const jwks = deps.keyResolver ?? createRemoteJWKSet(new URL(GOOGLE_JWKS_URI));
  const doFetch = deps.fetchImpl ?? fetch;

  return {
    async exchangeAndVerify({ code, redirectUri }) {
      const res = await doFetch(GOOGLE_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          code,
          client_id: deps.clientId,
          client_secret: deps.clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }).toString(),
      });
      if (!res.ok) {
        throw new Error(`Google token exchange failed (${res.status})`);
      }
      const json = (await res.json()) as { id_token?: unknown };
      if (typeof json.id_token !== 'string' || json.id_token.length === 0) {
        throw new Error('Google token response missing id_token');
      }
      // jose checks the signature against Google's JWKS and rejects a bad
      // `iss`/`aud`/`exp` before we ever read a claim.
      const { payload } = await jwtVerify(json.id_token, jwks, {
        issuer: GOOGLE_ISSUERS,
        audience: deps.clientId,
      });
      const sub = typeof payload.sub === 'string' ? payload.sub : '';
      const email = typeof payload.email === 'string' ? payload.email : '';
      if (!sub || !email) throw new Error('Google ID token missing sub/email');
      // Google may serialize email_verified as a boolean or a "true"/"false" string.
      const emailVerified = payload.email_verified === true || payload.email_verified === 'true';
      const name = typeof payload.name === 'string' ? payload.name : undefined;
      return { sub, email, emailVerified, name };
    },
  };
}
