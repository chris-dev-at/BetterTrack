import { VAULT_KEY_BYTES } from '../crypto';
import { VaultKeyCoreError } from './errors';

export function requireKey(key: Uint8Array, name: string): void {
  if (!(key instanceof Uint8Array) || key.length !== VAULT_KEY_BYTES) {
    throw new VaultKeyCoreError('invalid-key-material', `${name} must be 256 bits.`);
  }
}

/** Rejects the all-zero sentinel produced when volatile K_c custody is wiped. */
export function requireContentKey(contentKey: Uint8Array): void {
  requireKey(contentKey, 'Content key');
  let aggregate = 0;
  for (const byte of contentKey) aggregate |= byte;
  if (aggregate === 0) {
    throw new VaultKeyCoreError('invalid-key-material', 'Content key must not be all zero.');
  }
}
