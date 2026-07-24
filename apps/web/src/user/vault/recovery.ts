import { VAULT_FORMAT_VERSION } from '@bettertrack/contracts';

import { base64ToBytes, bytesToBase64, zeroBytes } from './bytes';
import { VaultCryptoError } from './errors';

export const RECOVERY_KIT_FILENAME = 'bettertrack-recovery-kit.txt';
const KIT_TITLE = 'BetterTrack recovery kit';
const KIT_INSTRUCTIONS =
  'Keep this file offline and private. It unlocks matching BetterTrack vault blobs without your passphrase. Lost passphrase and recovery kit means lost data.';

export interface RecoveryKit {
  keyId: string;
  vaultKey: Uint8Array;
  formatVersion: number;
}

export interface RecoveryKitDownload {
  filename: typeof RECOVERY_KIT_FILENAME;
  type: 'text/plain;charset=utf-8';
  bytes: Uint8Array;
}

/** Produces the exact plaintext recovery-kit bytes; the UI owns the actual download. */
export function serializeRecoveryKit(kit: RecoveryKit): RecoveryKitDownload {
  validateRecoveryKit(kit);
  const text = `${KIT_TITLE}\nformatVersion: ${kit.formatVersion}\nkeyId: ${kit.keyId}\nvaultKey: ${bytesToBase64(kit.vaultKey)}\n\n${KIT_INSTRUCTIONS}\n`;
  return {
    filename: RECOVERY_KIT_FILENAME,
    type: 'text/plain;charset=utf-8',
    bytes: new TextEncoder().encode(text),
  };
}

export function importRecoveryKit(bytes: Uint8Array, expectedKeyId?: string): RecoveryKit {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new VaultCryptoError('recovery-kit-invalid', 'Recovery kit is not valid UTF-8.', {
      cause,
    });
  }
  const match =
    /^BetterTrack recovery kit\nformatVersion: (\d+)\nkeyId: ([0-9a-f-]{36})\nvaultKey: ([A-Za-z0-9+/=]+)\n\nKeep this file offline and private\. It unlocks matching BetterTrack vault blobs without your passphrase\. Lost passphrase and recovery kit means lost data\.\n$/i.exec(
      text,
    );
  if (match == null) {
    throw new VaultCryptoError(
      'recovery-kit-invalid',
      'Recovery kit does not have the required format.',
    );
  }
  const [, formatVersionText, rawKeyId, rawVaultKey] = match;
  if (formatVersionText == null || rawKeyId == null || rawVaultKey == null) {
    throw new VaultCryptoError(
      'recovery-kit-invalid',
      'Recovery kit does not have the required format.',
    );
  }
  const formatVersion = Number(formatVersionText);
  if (formatVersion !== VAULT_FORMAT_VERSION) {
    throw new VaultCryptoError(
      'recovery-kit-invalid',
      'Recovery kit format version is unsupported.',
    );
  }
  const keyId = rawKeyId.toLowerCase();
  if (expectedKeyId != null && keyId !== expectedKeyId.toLowerCase()) {
    throw new VaultCryptoError(
      'recovery-kit-invalid',
      'Recovery kit does not match this vault key id.',
    );
  }
  const vaultKey = base64ToBytes(rawVaultKey, 'recovery-kit-invalid');
  try {
    validateRecoveryKit({ formatVersion, keyId, vaultKey });
    return { formatVersion, keyId, vaultKey: vaultKey.slice() };
  } finally {
    zeroBytes(vaultKey);
  }
}

function validateRecoveryKit(kit: RecoveryKit): void {
  if (kit.formatVersion !== VAULT_FORMAT_VERSION) {
    throw new VaultCryptoError(
      'recovery-kit-invalid',
      'Recovery kit format version is unsupported.',
    );
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(kit.keyId)
  ) {
    throw new VaultCryptoError('recovery-kit-invalid', 'Recovery kit key id is invalid.');
  }
  if (kit.vaultKey.length !== 32) {
    throw new VaultCryptoError('recovery-kit-invalid', 'Recovery kit vault key must be 256 bits.');
  }
}
