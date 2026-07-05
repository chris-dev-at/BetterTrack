import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { decryptSecret, encryptSecret } from '../../crypto/secretBox';
import {
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  generateRecoveryCode,
  generateRecoveryCodes,
  generateTotpCode,
  generateTotpSecret,
  normalizeRecoveryCode,
  RECOVERY_CODE_COUNT,
  TOTP_STEP_SECONDS,
  verifyTotp,
} from '../totp';

describe('base32 (RFC 4648)', () => {
  it('round-trips arbitrary bytes', () => {
    for (let i = 0; i < 20; i += 1) {
      const buf = randomBytes(1 + i);
      expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
    }
  });

  it('matches known RFC 4648 vectors', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar');
  });
});

describe('TOTP (RFC 6238)', () => {
  const secret = generateTotpSecret();
  const now = 1_700_000_000_000; // fixed instant

  it('verifies the code generated for the same instant', () => {
    expect(verifyTotp(secret, generateTotpCode(secret, now), now)).toBe(true);
  });

  it('accepts a code from the adjacent step (±30 s clock skew)', () => {
    const prev = generateTotpCode(secret, now - TOTP_STEP_SECONDS * 1000);
    const next = generateTotpCode(secret, now + TOTP_STEP_SECONDS * 1000);
    expect(verifyTotp(secret, prev, now)).toBe(true);
    expect(verifyTotp(secret, next, now)).toBe(true);
  });

  it('rejects a code two steps away (outside the skew window)', () => {
    const stale = generateTotpCode(secret, now - 2 * TOTP_STEP_SECONDS * 1000);
    expect(verifyTotp(secret, stale, now)).toBe(false);
  });

  it('rejects a wrong or malformed code', () => {
    const right = generateTotpCode(secret, now);
    const wrong = right === '000000' ? '111111' : '000000';
    expect(verifyTotp(secret, wrong, now)).toBe(false);
    expect(verifyTotp(secret, '12345', now)).toBe(false); // too short
    expect(verifyTotp(secret, 'abcdef', now)).toBe(false); // non-numeric
    expect(verifyTotp(secret, '', now)).toBe(false);
  });

  it('builds an otpauth URI carrying the secret + issuer', () => {
    const uri = buildOtpauthUri({ secret, accountName: 'jane@x.test', issuer: 'BetterTrack' });
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain('issuer=BetterTrack');
  });
});

describe('recovery codes', () => {
  it('generates a full formatted batch of distinct codes', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
    for (const code of codes) expect(code).toMatch(/^[a-z0-9]{4}(-[a-z0-9]{4})+$/);
  });

  it('normalizes formatting/case so entry variations match', () => {
    const code = generateRecoveryCode();
    const messy = ` ${code.toUpperCase().replace(/-/g, ' ')} `;
    expect(normalizeRecoveryCode(messy)).toBe(normalizeRecoveryCode(code));
  });
});

describe('secretBox (AES-256-GCM)', () => {
  const key = randomBytes(32);

  it('round-trips a secret and never stores plaintext', () => {
    const secret = generateTotpSecret();
    const envelope = encryptSecret(secret, key);
    expect(envelope).not.toContain(secret);
    expect(decryptSecret(envelope, key)).toBe(secret);
  });

  it('produces a distinct envelope each time (random IV)', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    expect(encryptSecret(secret, key)).not.toBe(encryptSecret(secret, key));
  });

  it('fails to decrypt with the wrong key or a tampered envelope', () => {
    const envelope = encryptSecret('JBSWY3DPEHPK3PXP', key);
    expect(() => decryptSecret(envelope, randomBytes(32))).toThrow();
    expect(() => decryptSecret(`${envelope}x`, key)).toThrow();
  });
});
