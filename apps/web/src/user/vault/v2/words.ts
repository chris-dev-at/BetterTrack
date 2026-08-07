import { generateMnemonic, validateMnemonic } from '@scure/bip39';
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js';

import { VaultCryptoError } from '../errors';

/**
 * The per-vault 12-word passphrase (`docs/VAULTS_V2_DESIGN.md` §1/§2).
 *
 * The words are drawn from the BIP-39 English list purely because it is a
 * stable, audited, cross-platform 2048-word vocabulary with a built-in checksum
 * — the mobile client (P4) can reproduce it from any BIP-39 library, and the
 * checksum turns most manual-entry typos into a local error instead of a
 * "wrong passphrase" round trip.
 *
 * It is NOT used as a BIP-39 seed. The phrase is fed to Argon2id as a UTF-8
 * passphrase exactly like the v1 typed passphrase was; there is no PBKDF2 seed
 * derivation, no derivation path, and no wallet compatibility claim.
 *
 * 12 words = 128 bits of entropy + a 4-bit checksum.
 */
export const VAULT2_PASSPHRASE_WORD_COUNT = 12;
const VAULT2_PASSPHRASE_ENTROPY_BITS = 128;

/** The 2048-word vocabulary, exposed for manual-entry autocomplete. */
export const VAULT2_WORDLIST: readonly string[] = englishWordlist;

const WORDLIST_SET: ReadonlySet<string> = new Set(englishWordlist);

/**
 * Generate one vault passphrase. Entropy comes from `@scure/bip39`, which reads
 * the platform CSPRNG; there is no seeded or test-injectable variant on purpose,
 * so no build path can produce a predictable vault passphrase.
 */
export function generateVaultPassphrase(): string {
  return generateMnemonic(englishWordlist, VAULT2_PASSPHRASE_ENTROPY_BITS);
}

/**
 * Normalize user input into the canonical phrase the KDF sees: NFKD, lowercase,
 * single-space separated, no surrounding whitespace. Manual entry, QR import and
 * generation must all agree here or the same words derive different keys.
 */
export function normalizeVaultPassphrase(value: string): string {
  return value.normalize('NFKD').toLowerCase().trim().split(/\s+/u).filter(Boolean).join(' ');
}

export type VaultPassphraseProblem =
  | { kind: 'word-count'; count: number }
  | { kind: 'unknown-words'; words: string[]; positions: number[] }
  | { kind: 'checksum' };

export type VaultPassphraseCheck =
  | { valid: true; passphrase: string; words: string[] }
  | { valid: false; problem: VaultPassphraseProblem };

/**
 * Validate a typed or scanned phrase without throwing. The three failures are
 * kept distinct because the UI says something different for each: wrong number
 * of words, a word that is not in the list (with its positions, so the field can
 * highlight it), or the right words in an order the checksum rejects.
 */
export function checkVaultPassphrase(value: string): VaultPassphraseCheck {
  const passphrase = normalizeVaultPassphrase(value);
  const words = passphrase === '' ? [] : passphrase.split(' ');

  if (words.length !== VAULT2_PASSPHRASE_WORD_COUNT) {
    return { valid: false, problem: { kind: 'word-count', count: words.length } };
  }

  const unknown: string[] = [];
  const positions: number[] = [];
  words.forEach((word, index) => {
    if (!WORDLIST_SET.has(word)) {
      unknown.push(word);
      positions.push(index);
    }
  });
  if (unknown.length > 0) {
    return { valid: false, problem: { kind: 'unknown-words', words: unknown, positions } };
  }

  if (!validateMnemonic(passphrase, englishWordlist)) {
    return { valid: false, problem: { kind: 'checksum' } };
  }
  return { valid: true, passphrase, words };
}

/** Throwing wrapper for call sites that have already validated interactively. */
export function requireVaultPassphrase(value: string): string {
  const checked = checkVaultPassphrase(value);
  if (!checked.valid) {
    throw new VaultCryptoError('kdf-failed', 'The vault passphrase is not 12 valid words.');
  }
  return checked.passphrase;
}

/**
 * Positions the "confirm your words" step asks the user to retype. Random, so a
 * user who screenshots one confirmation cannot learn which slots are checked.
 */
export function pickConfirmationPositions(
  count = 3,
  random: (max: number) => number = (max) => Math.floor(Math.random() * max),
): number[] {
  const picked = new Set<number>();
  let guard = 0;
  while (picked.size < Math.min(count, VAULT2_PASSPHRASE_WORD_COUNT) && guard < 200) {
    picked.add(random(VAULT2_PASSPHRASE_WORD_COUNT));
    guard += 1;
  }
  return [...picked].sort((left, right) => left - right);
}
