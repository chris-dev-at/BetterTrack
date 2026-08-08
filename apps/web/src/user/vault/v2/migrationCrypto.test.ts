import { webcrypto } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import { bytesToBase64 } from '../bytes';

import {
  deriveMigrationContentKey,
  deriveMigrationDeviceId,
  deriveMigrationIv,
  deriveMigrationVaultId,
  deriveMigrationWriteId,
  migrationDocId,
} from './migrationCrypto';

beforeEach(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
});

const VK = Uint8Array.from({ length: 32 }, (_, index) => (index * 7 + 1) & 0xff);

describe('migration crypto (r3 §18)', () => {
  it('derives K_c deterministically from the legacy vault key', async () => {
    const first = await deriveMigrationContentKey(VK);
    const second = await deriveMigrationContentKey(VK);
    expect(first).toHaveLength(32);
    expect(bytesToBase64(first)).toBe(bytesToBase64(second));

    // A different legacy key yields a different K_c.
    const other = await deriveMigrationContentKey(new Uint8Array(32).fill(9));
    expect(bytesToBase64(other)).not.toBe(bytesToBase64(first));
  });

  it('refuses a legacy key that is not 256 bits', async () => {
    await expect(deriveMigrationContentKey(new Uint8Array(16))).rejects.toMatchObject({
      code: 'kdf-failed',
    });
  });

  it('derives a distinct 96-bit IV per doc id, stable across runs', async () => {
    const kc = await deriveMigrationContentKey(VK);
    const commonIv = await deriveMigrationIv(kc, 'common');
    const portfolioIv = await deriveMigrationIv(kc, 'p.11111111-1111-4111-8111-111111111111');
    expect(commonIv).toHaveLength(12);
    expect(bytesToBase64(commonIv)).not.toBe(bytesToBase64(portfolioIv));
    // Deterministic: the same (K_c, docId) always gives the same IV.
    expect(bytesToBase64(await deriveMigrationIv(kc, 'common'))).toBe(bytesToBase64(commonIv));
  });

  it('derives a fixed device id and per-doc write ids', async () => {
    const kc = await deriveMigrationContentKey(VK);
    const deviceId = await deriveMigrationDeviceId(kc);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
    expect(deviceId).toMatch(uuid);
    expect(await deriveMigrationDeviceId(kc)).toBe(deviceId);

    const commonWrite = await deriveMigrationWriteId(kc, 'common');
    const portfolioWrite = await deriveMigrationWriteId(kc, 'p.abc');
    expect(commonWrite).toMatch(uuid);
    expect(commonWrite).not.toBe(portfolioWrite);
    expect(commonWrite).not.toBe(deviceId);
  });

  it('derives the successor vault id from the scope id, before any unlock', async () => {
    const id = await deriveMigrationVaultId('user-42');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(await deriveMigrationVaultId('user-42')).toBe(id);
    expect(await deriveMigrationVaultId('user-43')).not.toBe(id);
  });

  it('names doc ids the way the IV/writeId derivations expect', () => {
    expect(migrationDocId({ kind: 'common' })).toBe('common');
    expect(migrationDocId({ kind: 'header' })).toBe('header');
    expect(migrationDocId({ kind: 'portfolio', portfolioId: 'p1' })).toBe('p.p1');
    expect(() => migrationDocId({ kind: 'portfolio' })).toThrowError();
  });
});
