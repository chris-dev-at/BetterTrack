import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
  type KeyLike,
} from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import { createGoogleVerifier, GOOGLE_JWKS_URI, GOOGLE_TOKEN_ENDPOINT } from '../googleVerifier';

/**
 * Unit test of the real jose-based verifier (§13.4 V4-P4b acceptance: "the ID
 * token is verified (iss, aud, exp)"). We sign tokens with a LOCAL RSA key and
 * resolve them through an injected local JWKS, so the `iss`/`aud`/`exp`/signature
 * checks run with zero network. The token-endpoint fetch is stubbed to hand back
 * whichever id_token the case wants to verify.
 */
const CLIENT_ID = '123.apps.googleusercontent.com';
const KID = 'test-key-1';

let privateKey: KeyLike;
let keyResolver: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const jwk = (await exportJWK(pair.publicKey)) as JWK;
  jwk.kid = KID;
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  keyResolver = createLocalJWKSet({ keys: [jwk] });
});

interface TokenClaims {
  iss?: string;
  aud?: string;
  sub?: string;
  email?: string;
  emailVerified?: boolean;
  /** Relative string ('5m') or an ABSOLUTE unix-seconds expiry (for the expired case). */
  expiresIn?: string | number;
  issuedAt?: number;
}

async function signIdToken(claims: TokenClaims): Promise<string> {
  let jwt = new SignJWT({
    email: claims.email ?? 'user@example.com',
    email_verified: claims.emailVerified ?? true,
  })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(claims.iss ?? 'https://accounts.google.com')
    .setAudience(claims.aud ?? CLIENT_ID)
    .setSubject(claims.sub ?? 'google-sub-abc');
  jwt = jwt.setIssuedAt(claims.issuedAt);
  jwt = jwt.setExpirationTime(claims.expiresIn ?? '5m');
  return jwt.sign(privateKey);
}

/** A `fetch` stand-in that returns a token-endpoint response carrying `idToken`. */
function fakeTokenFetch(idToken: string | null, ok = true): typeof fetch {
  return (async () =>
    ({
      ok,
      status: ok ? 200 : 400,
      json: async () => (idToken === null ? {} : { id_token: idToken }),
    }) as unknown as Response) as unknown as typeof fetch;
}

function verifierFor(idToken: string | null, ok = true) {
  return createGoogleVerifier({
    clientId: CLIENT_ID,
    clientSecret: 'secret',
    fetchImpl: fakeTokenFetch(idToken, ok),
    keyResolver,
  });
}

describe('googleVerifier — ID-token verification (§13.4 V4-P4b)', () => {
  it('accepts a well-formed token and returns the normalized claims', async () => {
    const token = await signIdToken({
      sub: 'sub-1',
      email: 'Alice@Example.com',
      emailVerified: true,
    });
    const claims = await verifierFor(token).exchangeAndVerify({ code: 'c', redirectUri: 'r' });
    expect(claims).toEqual({
      sub: 'sub-1',
      email: 'Alice@Example.com',
      emailVerified: true,
      name: undefined,
    });
  });

  it('surfaces email_verified=false without linking authority', async () => {
    const token = await signIdToken({ emailVerified: false });
    const claims = await verifierFor(token).exchangeAndVerify({ code: 'c', redirectUri: 'r' });
    expect(claims.emailVerified).toBe(false);
  });

  it('rejects a token from the wrong issuer', async () => {
    const token = await signIdToken({ iss: 'https://evil.example.com' });
    await expect(
      verifierFor(token).exchangeAndVerify({ code: 'c', redirectUri: 'r' }),
    ).rejects.toThrow();
  });

  it('rejects a token minted for a different audience (client id)', async () => {
    const token = await signIdToken({ aud: 'someone-else.apps.googleusercontent.com' });
    await expect(
      verifierFor(token).exchangeAndVerify({ code: 'c', redirectUri: 'r' }),
    ).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    // Issued and expired well in the past (absolute unix-seconds exp in 1970).
    const token = await signIdToken({ issuedAt: 1000, expiresIn: 2000 });
    await expect(
      verifierFor(token).exchangeAndVerify({ code: 'c', redirectUri: 'r' }),
    ).rejects.toThrow();
  });

  it('rejects when the token endpoint returns no id_token', async () => {
    await expect(
      verifierFor(null).exchangeAndVerify({ code: 'c', redirectUri: 'r' }),
    ).rejects.toThrow(/missing id_token/);
  });

  it('rejects when the token exchange itself fails (non-2xx)', async () => {
    await expect(
      verifierFor(null, false).exchangeAndVerify({ code: 'c', redirectUri: 'r' }),
    ).rejects.toThrow(/token exchange failed/);
  });
});

/**
 * Endpoint-override plumbing (§13.4 V4-P11, #520). The three new deps are strictly
 * additive: with `tokenEndpoint`/`jwksUri` unset the verifier hits the exact
 * production Google constants; set, only the URL moves — the same signed-token
 * verification runs. The e2e fake IdP relies on this to run the flow network-free.
 */
describe('googleVerifier — endpoint overrides are additive (§13.4 V4-P11, #520)', () => {
  /** A `fetch` stand-in that records the URL it was called with and returns a token. */
  function capturingTokenFetch(idToken: string): { fetch: typeof fetch; urls: string[] } {
    const urls: string[] = [];
    const fetchImpl = (async (url: unknown) => {
      urls.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => ({ id_token: idToken }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    return { fetch: fetchImpl, urls };
  }

  it('exports the real Google constants as the defaults', () => {
    expect(GOOGLE_TOKEN_ENDPOINT).toBe('https://oauth2.googleapis.com/token');
    expect(GOOGLE_JWKS_URI).toBe('https://www.googleapis.com/oauth2/v3/certs');
  });

  it('exchanges at the production token endpoint when no override is set', async () => {
    const token = await signIdToken({ sub: 'sub-default' });
    const { fetch: fetchImpl, urls } = capturingTokenFetch(token);
    await createGoogleVerifier({
      clientId: CLIENT_ID,
      clientSecret: 'secret',
      fetchImpl,
      keyResolver,
    }).exchangeAndVerify({ code: 'c', redirectUri: 'r' });
    expect(urls).toEqual([GOOGLE_TOKEN_ENDPOINT]);
  });

  it('exchanges at the overridden token endpoint when one is provided', async () => {
    const token = await signIdToken({ sub: 'sub-override' });
    const { fetch: fetchImpl, urls } = capturingTokenFetch(token);
    const override = 'https://fake-idp.test/token';
    await createGoogleVerifier({
      clientId: CLIENT_ID,
      clientSecret: 'secret',
      fetchImpl,
      keyResolver,
      tokenEndpoint: override,
    }).exchangeAndVerify({ code: 'c', redirectUri: 'r' });
    expect(urls).toEqual([override]);
  });

  it('still verifies signature/iss/aud/exp unchanged with the endpoints overridden', async () => {
    const token = await signIdToken({ sub: 'sub-1', email: 'a@b.com', emailVerified: true });
    const { fetch: fetchImpl } = capturingTokenFetch(token);
    const verifier = createGoogleVerifier({
      clientId: CLIENT_ID,
      clientSecret: 'secret',
      fetchImpl,
      keyResolver,
      tokenEndpoint: 'https://fake-idp.test/token',
      jwksUri: 'https://fake-idp.test/jwks',
    });
    // A wrong-audience token is still rejected — only the URLs moved.
    const badAud = await signIdToken({ aud: 'someone-else.apps.googleusercontent.com' });
    const { fetch: badFetch } = capturingTokenFetch(badAud);
    await expect(
      createGoogleVerifier({
        clientId: CLIENT_ID,
        clientSecret: 'secret',
        fetchImpl: badFetch,
        keyResolver,
        tokenEndpoint: 'https://fake-idp.test/token',
      }).exchangeAndVerify({ code: 'c', redirectUri: 'r' }),
    ).rejects.toThrow();
    // A well-formed token still passes.
    const claims = await verifier.exchangeAndVerify({ code: 'c', redirectUri: 'r' });
    expect(claims).toEqual({
      sub: 'sub-1',
      email: 'a@b.com',
      emailVerified: true,
      name: undefined,
    });
  });
});
