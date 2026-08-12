import type { VaultEntity } from '@bettertrack/contracts';

import type { RandomBytes, VaultCryptoDeps } from '../crypto';

/**
 * Shared fixtures for the Vaults v2 suites.
 *
 * The production Argon2id profile costs 64 MiB and ~0.5 s per derivation. Most
 * v2 tests assert envelope/routing/state behaviour rather than KDF strength, so
 * they inject {@link fastArgon2}; the conformance test in `crypto.test.ts`
 * deliberately does NOT, and runs the real thing.
 */

/**
 * A deterministic stand-in for Argon2id. It is a plain SHA-256 over
 * password‖salt‖params — NOT a KDF, and never reachable from app code: it can
 * only enter through the `deps.argon2` test seam.
 */
export const fastArgon2: NonNullable<VaultCryptoDeps['argon2']> = async ({
  password,
  salt,
  iterations,
  parallelism,
  memorySize,
  hashLength,
}) => {
  const material = new Uint8Array(password.length + salt.length + 12);
  material.set(password, 0);
  material.set(salt, password.length);
  new DataView(material.buffer).setUint32(password.length + salt.length, iterations, false);
  new DataView(material.buffer).setUint32(password.length + salt.length + 4, parallelism, false);
  new DataView(material.buffer).setUint32(password.length + salt.length + 8, memorySize, false);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', material));
  return digest.subarray(0, hashLength);
};

export const fastDeps: VaultCryptoDeps = { argon2: fastArgon2 };

/** A counting byte source so vector tests produce byte-identical output. */
export function deterministicBytes(start = 0): RandomBytes {
  let cursor = start;
  return (length: number) => {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      bytes[index] = (cursor + index) % 256;
    }
    cursor = (cursor + length) % 256;
    return bytes;
  };
}

/** A valid 12-word BIP-39 phrase with a correct checksum, fixed for fixtures. */
export const FIXTURE_PASSPHRASE =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';
/** A second valid phrase, used wherever "the wrong words" must be exercised. */
export const FIXTURE_OTHER_PASSPHRASE =
  'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';

export const FIXTURE_VAULT_ID = '4f6f3f1e-9f2a-4a53-9a6a-9b8f2f8c1a01';
export const FIXTURE_DEVICE_ID = '2f2f3f1e-9f2a-4a53-9a6a-9b8f2f8c1a02';
export const FIXTURE_WRITE_ID = '6f6f3f1e-9f2a-4a53-9a6a-9b8f2f8c1a03';
export const FIXTURE_WRITTEN_AT = '2026-08-08T09:00:00.000Z';

export const FIXTURE_PORTFOLIO_A = '11111111-1111-4111-8111-111111111111';
export const FIXTURE_PORTFOLIO_B = '22222222-2222-4222-8222-222222222222';

/** Build a minimal but schema-valid vault entity. */
export function entity(
  id: string,
  data: Record<string, unknown> = {},
  overrides: Partial<VaultEntity> = {},
): VaultEntity {
  return {
    id,
    rev: 1,
    editedAt: FIXTURE_WRITTEN_AT,
    editedBy: FIXTURE_DEVICE_ID,
    deletedAt: null,
    data,
    ...overrides,
  };
}
