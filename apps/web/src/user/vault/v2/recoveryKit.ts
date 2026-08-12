import { VAULT2_HEADER_FORMAT_VERSION, type VaultBackends } from '@bettertrack/contracts';

import { VaultCryptoError } from '../errors';

import { checkVaultPassphrase, normalizeVaultPassphrase } from './words';

/**
 * The v2 recovery kit (`docs/VAULTS_V2_DESIGN.md` r2 §9 / r3 §25 family 5).
 *
 * The v1 kit stored a raw vault KEY (`recovery.ts`, formatVersion 1). A v2
 * vault's content key is DERIVED from its passphrase, so the kit reverts to the
 * honest thing: the 12 words themselves, plus the cleartext locators a user
 * needs to find the right vault — name, id, backend set. Anyone holding this
 * file can open the vault, exactly as if they knew the words, which the kit
 * says in plain language.
 *
 * The format is line-oriented and fixed so both clients emit byte-identical
 * kits for identical input (the vector pins it): a title line, three `key:
 * value` locators, the words on their own line, then the warning block.
 */

export const RECOVERY_KIT_V2_FILENAME = 'bettertrack-vault-recovery.txt';
const KIT_TITLE = 'BetterTrack vault recovery kit';
const KIT_WARNING =
  'Anyone who has these twelve words can open this vault. Keep this file offline and private. If you lose both the words and this file, the vault cannot be recovered — not by you, not by BetterTrack.';

export interface RecoveryKitV2 {
  formatVersion: typeof VAULT2_HEADER_FORMAT_VERSION;
  vaultId: string;
  vaultName: string;
  backends: VaultBackends;
  /** The 12-word passphrase, canonical (NFKD, lowercase, single-spaced). */
  passphrase: string;
}

export interface RecoveryKitV2Download {
  filename: typeof RECOVERY_KIT_V2_FILENAME;
  type: 'text/plain;charset=utf-8';
  bytes: Uint8Array;
}

/** Produce the exact kit bytes; the UI owns the actual download. */
export function serializeRecoveryKitV2(input: {
  vaultId: string;
  vaultName: string;
  backends: VaultBackends;
  passphrase: string;
}): RecoveryKitV2Download {
  const passphrase = normalizeVaultPassphrase(input.passphrase);
  if (!checkVaultPassphrase(passphrase).valid) {
    throw new VaultCryptoError('recovery-kit-invalid', 'The recovery kit needs 12 valid words.');
  }
  const name = input.vaultName.trim();
  if (name.length === 0) {
    throw new VaultCryptoError('recovery-kit-invalid', 'A vault name is required.');
  }
  const text =
    `${KIT_TITLE}\n` +
    `formatVersion: ${VAULT2_HEADER_FORMAT_VERSION}\n` +
    `vaultId: ${input.vaultId}\n` +
    `vaultName: ${name}\n` +
    `backends: ${input.backends}\n` +
    `words: ${passphrase}\n\n` +
    `${KIT_WARNING}\n`;
  return {
    filename: RECOVERY_KIT_V2_FILENAME,
    type: 'text/plain;charset=utf-8',
    bytes: new TextEncoder().encode(text),
  };
}

const KIT_PATTERN = new RegExp(
  `^${KIT_TITLE}\\n` +
    `formatVersion: (\\d+)\\n` +
    `vaultId: ([0-9a-fA-F-]{36})\\n` +
    `vaultName: (.+)\\n` +
    `backends: (server|drive|both)\\n` +
    `words: ([a-z ]+)\\n\\n` +
    `${escapeRegExp(KIT_WARNING)}\\n$`,
  'u',
);

/** Parse a v2 kit. Fails closed on a wrong shape, version, or invalid words. */
export function importRecoveryKitV2(bytes: Uint8Array): RecoveryKitV2 {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new VaultCryptoError('recovery-kit-invalid', 'Recovery kit is not valid UTF-8.', {
      cause,
    });
  }
  const match = KIT_PATTERN.exec(text);
  if (match == null) {
    throw new VaultCryptoError(
      'recovery-kit-invalid',
      'Recovery kit does not have the required format.',
    );
  }
  const [, formatVersionText, vaultId, vaultName, backends, words] = match;
  if (Number(formatVersionText) !== VAULT2_HEADER_FORMAT_VERSION) {
    throw new VaultCryptoError(
      'recovery-kit-invalid',
      'Recovery kit format version is unsupported.',
    );
  }
  const passphrase = normalizeVaultPassphrase(words!);
  if (!checkVaultPassphrase(passphrase).valid) {
    throw new VaultCryptoError(
      'recovery-kit-invalid',
      'Recovery kit words are not a valid phrase.',
    );
  }
  return {
    formatVersion: VAULT2_HEADER_FORMAT_VERSION,
    vaultId: vaultId!.toLowerCase(),
    vaultName: vaultName!,
    backends: backends as VaultBackends,
    passphrase,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
