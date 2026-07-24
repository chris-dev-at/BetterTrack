import type { VaultDocumentV1 } from '@bettertrack/contracts';

import { bytesToBase64 } from './bytes';
import type { RandomBytes, VaultCryptoDeps } from './crypto';

export const VECTOR_KEY_ID = '018f0000-0000-7000-8000-00000000000a';
export const VECTOR_DEVICE_ID = '018f0000-0000-7000-8000-00000000000b';
export const VECTOR_WRITE_ID = '018f0000-0000-7000-8000-00000000000c';

export const vaultVectorDocument: VaultDocumentV1 = {
  schemaVersion: 1,
  entities: {
    portfolio: [
      {
        id: VECTOR_KEY_ID,
        rev: 1,
        editedAt: '2026-07-24T10:00:00.000Z',
        editedBy: VECTOR_DEVICE_ID,
        deletedAt: null,
        data: { name: 'Vector portfolio' },
      },
    ],
  },
  mergeLog: [],
};

/** Deterministic only for public test vectors — never use outside tests. */
export function deterministicRandom(start = 0): RandomBytes {
  let next = start;
  return (length) => Uint8Array.from({ length }, () => next++ & 0xff);
}

/** Fast deterministic Argon2 seam used by vectors while production imports hash-wasm Argon2id. */
export const vectorKdf: VaultCryptoDeps = {
  async argon2({ password, salt, iterations, parallelism, memorySize, hashLength }) {
    if (iterations !== 3 || parallelism !== 1 || memorySize !== 65536) {
      throw new Error('unexpected Argon2id vector parameters');
    }
    const seed = `${bytesToBase64(password)}:${bytesToBase64(salt)}`;
    return Uint8Array.from(
      { length: hashLength },
      (_, index) => seed.charCodeAt(index % seed.length) ^ index,
    );
  },
};
