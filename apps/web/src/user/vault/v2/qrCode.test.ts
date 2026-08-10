import { describe, expect, it } from 'vitest';

import {
  formatQrCode,
  generateQrCode,
  isValidQrCode,
  normalizeQrCode,
  VAULT2_QR_CODE_ALPHABET,
  VAULT2_QR_CODE_LENGTH,
} from './qrCode';

describe('QR one-time code (r3 §19 — 8-char Crockford base32)', () => {
  it('maps 40 bits bijectively onto 8 alphabet characters', () => {
    expect(generateQrCode(() => new Uint8Array(5))).toBe('00000000');
    expect(generateQrCode(() => new Uint8Array(5).fill(0xff))).toBe('ZZZZZZZZ');
    // 0x08 0x52 0x9D 0x16 0x3E → 00001 00001 01001 01001 11010 00101 10001 11110
    expect(generateQrCode(() => Uint8Array.from([0x08, 0x52, 0x9d, 0x16, 0x3e]))).toBe('1199T5HY');
  });

  it('draws every character from the Crockford alphabet, which omits I, L, O, U', () => {
    expect(VAULT2_QR_CODE_ALPHABET).toHaveLength(32);
    for (const banned of ['I', 'L', 'O', 'U']) {
      expect(VAULT2_QR_CODE_ALPHABET).not.toContain(banned);
    }
    for (let trial = 0; trial < 64; trial += 1) {
      const code = generateQrCode();
      expect(code).toHaveLength(VAULT2_QR_CODE_LENGTH);
      for (const char of code) expect(VAULT2_QR_CODE_ALPHABET).toContain(char);
    }
  });

  it('normalizes human entry per Crockford: case, separators, I/L→1, O→0', () => {
    expect(normalizeQrCode('1199-t5hy')).toBe('1199T5HY');
    expect(normalizeQrCode('  Il99 T5HY ')).toBe('1199T5HY');
    expect(normalizeQrCode('o199t5hy')).toBe('0199T5HY');
    expect(normalizeQrCode('1199T5HY')).toBe('1199T5HY');
  });

  it('refuses wrong lengths and out-of-alphabet characters', () => {
    expect(normalizeQrCode('1199T5H')).toBeNull();
    expect(normalizeQrCode('1199T5HYA')).toBeNull();
    expect(normalizeQrCode('1199T5HU')).toBeNull(); // U is not in the alphabet
    expect(normalizeQrCode('1199T5H!')).toBeNull();
    expect(isValidQrCode('')).toBe(false);
    expect(isValidQrCode('xxxx-yyyy')).toBe(true);
  });

  it('formats for the reveal screen as XXXX-XXXX', () => {
    expect(formatQrCode('1199t5hy')).toBe('1199-T5HY');
    expect(() => formatQrCode('nope')).toThrowError();
  });
});
