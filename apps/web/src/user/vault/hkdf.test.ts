import { webcrypto } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import { hkdfSha256, uuidFromBytes } from './hkdf';

beforeEach(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
});

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

const fromHex = (value: string): Uint8Array =>
  Uint8Array.from(value.match(/../gu)!.map((pair) => parseInt(pair, 16)));

describe('hkdfSha256 — RFC 5869 pins', () => {
  it('reproduces RFC 5869 test case 1 (SHA-256, salted)', async () => {
    const okm = await hkdfSha256(
      new Uint8Array(22).fill(0x0b),
      fromHex('f0f1f2f3f4f5f6f7f8f9'),
      42,
      fromHex('000102030405060708090a0b0c'),
    );
    expect(hex(okm)).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    );
  });

  it('reproduces RFC 5869 test case 3 (SHA-256, empty salt and info — the r3 salt mode)', async () => {
    const okm = await hkdfSha256(new Uint8Array(22).fill(0x0b), new Uint8Array(0), 42);
    expect(hex(okm)).toBe(
      '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8',
    );
  });

  it('separates domains by info string alone', async () => {
    const ikm = new Uint8Array(32).fill(7);
    const left = await hkdfSha256(ikm, new TextEncoder().encode('btv2-migration-v1'), 32);
    const right = await hkdfSha256(ikm, new TextEncoder().encode('btv2-header-mac-v1'), 32);
    expect(hex(left)).not.toBe(hex(right));
    // Deterministic: the same inputs always derive the same bytes.
    expect(hex(await hkdfSha256(ikm, new TextEncoder().encode('btv2-migration-v1'), 32))).toBe(
      hex(left),
    );
  });

  it('refuses empty key material and out-of-range lengths', async () => {
    await expect(hkdfSha256(new Uint8Array(0), new Uint8Array(0), 32)).rejects.toMatchObject({
      code: 'kdf-failed',
    });
    await expect(
      hkdfSha256(new Uint8Array(32).fill(1), new Uint8Array(0), 0),
    ).rejects.toMatchObject({ code: 'kdf-failed' });
  });
});

describe('uuidFromBytes', () => {
  it('emits RFC 4122 v4-shaped ids deterministically', () => {
    const bytes = Uint8Array.from({ length: 16 }, (_, index) => index);
    const id = uuidFromBytes(bytes);
    expect(id).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    // The input is not mutated.
    expect(bytes[6]).toBe(6);
    expect(bytes[8]).toBe(8);
  });

  it('refuses anything but 16 bytes', () => {
    expect(() => uuidFromBytes(new Uint8Array(15))).toThrowError();
  });
});
