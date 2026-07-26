import { describe, expect, it } from 'vitest';

import { generateToken, hashToken, sha256Base64Url } from '../tokens';

describe('crypto token helpers', () => {
  it('hashes tokens with the SHA-256 hexadecimal public test vector', () => {
    expect(hashToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('applies the RFC 7636 S256 PKCE transform with unpadded base64url output', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

    expect(sha256Base64Url(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('generates an unpadded URL-safe 256-bit token with its matching hash', () => {
    const { token, tokenHash } = generateToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).not.toContain('=');
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(tokenHash).toBe(hashToken(token));
  });

  it('generates distinct tokens', () => {
    const first = generateToken();
    const second = generateToken();

    expect(first.token).not.toBe(second.token);
  });
});
