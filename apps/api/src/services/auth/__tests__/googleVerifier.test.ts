import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
  type KeyLike,
} from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import { createGoogleVerifier } from '../googleVerifier';

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
