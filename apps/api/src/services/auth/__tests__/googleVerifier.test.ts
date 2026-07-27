import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
  type JWTPayload,
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
  sub?: unknown;
  email?: unknown;
  emailVerified?: unknown;
  name?: unknown;
  /** Relative string ('5m') or an ABSOLUTE unix-seconds expiry (for the expired case). */
  expiresIn?: string | number;
  issuedAt?: number;
}

function claimedOrDefault(
  claims: TokenClaims,
  key: 'sub' | 'email' | 'emailVerified' | 'name',
  fallback: unknown,
): unknown {
  return Object.hasOwn(claims, key) ? claims[key] : fallback;
}

async function signIdToken(
  claims: TokenClaims = {},
  signingKey: KeyLike = privateKey,
): Promise<string> {
  const payload = {
    sub: claimedOrDefault(claims, 'sub', 'google-sub-abc'),
    email: claimedOrDefault(claims, 'email', 'user@example.com'),
    email_verified: claimedOrDefault(claims, 'emailVerified', true),
    ...(Object.hasOwn(claims, 'name') ? { name: claims.name } : {}),
  } as JWTPayload;
  let jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(claims.iss ?? 'https://accounts.google.com')
    .setAudience(claims.aud ?? CLIENT_ID);
  jwt = jwt.setIssuedAt(claims.issuedAt);
  jwt = jwt.setExpirationTime(claims.expiresIn ?? '5m');
  return jwt.sign(signingKey);
}

/** A `fetch` stand-in that returns a token-endpoint response carrying `idToken`. */
function fakeTokenFetch(responseBody: unknown, ok = true, status = ok ? 200 : 400): typeof fetch {
  return (async () =>
    ({
      ok,
      status,
      json: async () => responseBody,
    }) as unknown as Response) as unknown as typeof fetch;
}

function verifierForResponse(responseBody: unknown, ok = true, status?: number) {
  return createGoogleVerifier({
    clientId: CLIENT_ID,
    clientSecret: 'secret',
    fetchImpl: fakeTokenFetch(responseBody, ok, status),
    keyResolver,
  });
}

function verifierFor(idToken: unknown, ok = true) {
  return verifierForResponse(idToken === null ? {} : { id_token: idToken }, ok);
}

async function rejectionMessage(task: Promise<unknown>): Promise<string> {
  try {
    await task;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('Expected the verifier to reject');
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

  it('accepts both documented Google issuer forms', async () => {
    for (const issuer of ['https://accounts.google.com', 'accounts.google.com']) {
      const token = await signIdToken({ iss: issuer, sub: issuer });
      const claims = await verifierFor(token).exchangeAndVerify({ code: 'c', redirectUri: 'r' });
      expect(claims.sub).toBe(issuer);
    }
  });

  it('surfaces email_verified=false without linking authority', async () => {
    const token = await signIdToken({ emailVerified: false });
    const claims = await verifierFor(token).exchangeAndVerify({ code: 'c', redirectUri: 'r' });
    expect(claims.emailVerified).toBe(false);
  });

  it('normalizes only boolean true and string true as verified email claims', async () => {
    const cases: Array<{ value: unknown; expected: boolean }> = [
      { value: true, expected: true },
      { value: false, expected: false },
      { value: 'true', expected: true },
      { value: 'false', expected: false },
      { value: 'TRUE', expected: false },
      { value: 1, expected: false },
      { value: null, expected: false },
    ];

    for (const { value, expected } of cases) {
      const token = await signIdToken({ emailVerified: value });
      const claims = await verifierFor(token).exchangeAndVerify({ code: 'c', redirectUri: 'r' });
      expect(claims.emailVerified).toBe(expected);
    }
  });

  it('returns an optional name only when its verified claim is a string', async () => {
    const namedToken = await signIdToken({ name: 'Alice' });
    await expect(
      verifierFor(namedToken).exchangeAndVerify({ code: 'c', redirectUri: 'r' }),
    ).resolves.toMatchObject({ name: 'Alice' });

    for (const name of [null, 42, { display: 'Alice' }]) {
      const token = await signIdToken({ name });
      const claims = await verifierFor(token).exchangeAndVerify({ code: 'c', redirectUri: 'r' });
      expect(claims.name).toBeUndefined();
    }
  });

  it('rejects missing, blank, and wrong-typed required identity claims', async () => {
    const invalidClaims: TokenClaims[] = [
      { sub: undefined, email: 'user@example.com' },
      { sub: '', email: 'user@example.com' },
      { sub: '   ', email: 'user@example.com' },
      { sub: 42, email: 'user@example.com' },
      { sub: 'google-sub-abc', email: undefined },
      { sub: 'google-sub-abc', email: '' },
      { sub: 'google-sub-abc', email: '   ' },
      { sub: 'google-sub-abc', email: false },
    ];

    for (const claims of invalidClaims) {
      const token = await signIdToken(claims);
      await expect(
        verifierFor(token).exchangeAndVerify({ code: 'c', redirectUri: 'r' }),
      ).rejects.toThrow('Google ID token missing sub/email');
    }
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

  it('rejects a token signed by an untrusted local key', async () => {
    const untrustedPair = await generateKeyPair('RS256');
    const token = await signIdToken({}, untrustedPair.privateKey);
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

  it('rejects unsafe exchange responses without leaking sensitive values', async () => {
    const authorizationCode = 'authorization-code-should-not-leak';
    const clientSecret = 'client-secret-should-not-leak';
    const responseBody = 'response-body-should-not-leak';
    const tokenContents = 'id-token-should-not-leak';
    const assertSafeError = (message: string) => {
      for (const sensitiveValue of [authorizationCode, clientSecret, responseBody, tokenContents]) {
        expect(message).not.toContain(sensitiveValue);
      }
    };

    const non2xxError = await rejectionMessage(
      createGoogleVerifier({
        clientId: CLIENT_ID,
        clientSecret,
        fetchImpl: fakeTokenFetch(
          { error_description: responseBody, id_token: tokenContents },
          false,
          401,
        ),
        keyResolver,
      }).exchangeAndVerify({ code: authorizationCode, redirectUri: 'r' }),
    );
    expect(non2xxError).toBe('Google token exchange failed (401)');
    assertSafeError(non2xxError);

    const malformedJsonError = await rejectionMessage(
      createGoogleVerifier({
        clientId: CLIENT_ID,
        clientSecret,
        fetchImpl: (async () =>
          new Response(`{\"id_token\":\"${tokenContents}`, {
            headers: { 'content-type': 'application/json' },
          })) as typeof fetch,
        keyResolver,
      }).exchangeAndVerify({ code: authorizationCode, redirectUri: 'r' }),
    );
    expect(malformedJsonError).toBe('Google token response missing id_token');
    assertSafeError(malformedJsonError);

    for (const malformedResponse of [
      { error_description: responseBody },
      { id_token: '', error_description: responseBody },
      { id_token: { tokenContents }, error_description: responseBody },
      null,
    ]) {
      const error = await rejectionMessage(
        createGoogleVerifier({
          clientId: CLIENT_ID,
          clientSecret,
          fetchImpl: fakeTokenFetch(malformedResponse),
          keyResolver,
        }).exchangeAndVerify({ code: authorizationCode, redirectUri: 'r' }),
      );
      expect(error).toBe('Google token response missing id_token');
      assertSafeError(error);
    }
  });
});

/**
 * Endpoint-override plumbing (§13.4 V4-P11, #520). The three new deps are strictly
 * additive: with `tokenEndpoint`/`jwksUri` unset the verifier hits the exact
 * production Google constants; set, only the URL moves — the same signed-token
 * verification runs. The e2e fake IdP relies on this to run the flow network-free.
 */
describe('googleVerifier — endpoint overrides are additive (§13.4 V4-P11, #520)', () => {
  /** A `fetch` stand-in that records the request and returns a token. */
  function capturingTokenFetch(idToken: string): {
    fetch: typeof fetch;
    calls: Array<{ url: string; init: RequestInit | undefined }>;
  } {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        json: async () => ({ id_token: idToken }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    return { fetch: fetchImpl, calls };
  }

  it('exports the real Google constants as the defaults', () => {
    expect(GOOGLE_TOKEN_ENDPOINT).toBe('https://oauth2.googleapis.com/token');
    expect(GOOGLE_JWKS_URI).toBe('https://www.googleapis.com/oauth2/v3/certs');
  });

  it('exchanges at the production token endpoint when no override is set', async () => {
    const token = await signIdToken({ sub: 'sub-default' });
    const { fetch: fetchImpl, calls } = capturingTokenFetch(token);
    await createGoogleVerifier({
      clientId: CLIENT_ID,
      clientSecret: 'secret',
      fetchImpl,
      keyResolver,
    }).exchangeAndVerify({ code: 'c', redirectUri: 'r' });
    expect(calls.map(({ url }) => url)).toEqual([GOOGLE_TOKEN_ENDPOINT]);
  });

  it('exchanges at the overridden token endpoint when one is provided', async () => {
    const token = await signIdToken({ sub: 'sub-override' });
    const { fetch: fetchImpl, calls } = capturingTokenFetch(token);
    const override = 'https://fake-idp.test/token';
    await createGoogleVerifier({
      clientId: CLIENT_ID,
      clientSecret: 'secret',
      fetchImpl,
      keyResolver,
      tokenEndpoint: override,
    }).exchangeAndVerify({ code: 'c', redirectUri: 'r' });
    expect(calls.map(({ url }) => url)).toEqual([override]);
  });

  it('exchanges one exact form-encoded POST without losing reserved characters', async () => {
    const token = await signIdToken({ sub: 'sub-form' });
    const { fetch: fetchImpl, calls } = capturingTokenFetch(token);
    const code = 'code +/?&=:#%';
    const redirectUri = 'https://app.test/google/callback?next=/portfolio&from=a+b';
    const clientSecret = 'secret +/?&=:#%';

    await createGoogleVerifier({
      clientId: CLIENT_ID,
      clientSecret,
      fetchImpl,
      keyResolver,
    }).exchangeAndVerify({ code, redirectUri });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error('Expected a token-exchange request');
    expect(call).toMatchObject({
      url: GOOGLE_TOKEN_ENDPOINT,
      init: {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
        },
      },
    });
    const expected = new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }).toString();
    expect(call.init?.body).toBe(expected);
    expect([...new URLSearchParams(expected).keys()].sort()).toEqual(
      ['code', 'client_id', 'client_secret', 'redirect_uri', 'grant_type'].sort(),
    );
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
