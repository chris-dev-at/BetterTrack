import {
  entropyToMnemonic as bip39EntropyToMnemonic,
  mnemonicToEntropy as bip39MnemonicToEntropy,
  mnemonicToSeedWebcrypto,
} from '@scure/bip39';
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js';

import { secureRandomBytes, type RandomBytes } from '../crypto';

export const BIP39_ENTROPY_BITS = 128;
export const BIP39_ENTROPY_BYTES = BIP39_ENTROPY_BITS / 8;
export const BIP39_CHECKSUM_BITS = 4;
export const BIP39_WORD_COUNT = 12;
export const BIP39_SEED_BYTES = 64;
export const BIP39_WORDLIST_SIZE = 2048;

const CHALLENGE_RANDOM_BYTES = 1;
const BYTE_VALUE_COUNT = 256;
const MAX_CHALLENGE_RANDOM_ATTEMPTS = 128;
const ENGLISH_WORDS = new Set(englishWordlist);

export type MnemonicErrorCode =
  | 'invalid-word-count'
  | 'unknown-word'
  | 'invalid-checksum'
  | 'invalid-entropy-length';

export abstract class MnemonicError extends Error {
  abstract readonly code: MnemonicErrorCode;
}

export class MnemonicWordCountError extends MnemonicError {
  readonly code = 'invalid-word-count' as const;

  constructor(
    readonly actualWordCount: number,
    readonly expectedWordCount = BIP39_WORD_COUNT,
  ) {
    super(`Mnemonic must contain exactly ${expectedWordCount} words; received ${actualWordCount}.`);
    this.name = 'MnemonicWordCountError';
  }
}

export class MnemonicUnknownWordError extends MnemonicError {
  readonly code = 'unknown-word' as const;

  constructor(
    readonly word: string,
    readonly wordNumber: number,
  ) {
    super(`Mnemonic word ${wordNumber} is not in the English BIP39 wordlist.`);
    this.name = 'MnemonicUnknownWordError';
  }
}

export class MnemonicChecksumError extends MnemonicError {
  readonly code = 'invalid-checksum' as const;

  constructor() {
    super('Mnemonic checksum is invalid.');
    this.name = 'MnemonicChecksumError';
  }
}

export class MnemonicEntropyLengthError extends MnemonicError {
  readonly code = 'invalid-entropy-length' as const;

  constructor(
    readonly actualBytes: number,
    readonly expectedBytes = BIP39_ENTROPY_BYTES,
  ) {
    super(`Mnemonic entropy must be exactly ${expectedBytes} bytes; received ${actualBytes}.`);
    this.name = 'MnemonicEntropyLengthError';
  }
}

export interface MnemonicWordChallenge {
  /** One-based position suitable for the creation-ceremony prompt. */
  readonly wordNumber: number;
}

/**
 * Applies the BIP39 NFKD normalization and makes pasted whitespace canonical.
 * Validation remains explicit in the conversion/derivation APIs so callers can
 * normalize an in-progress entry without turning it into a valid phrase.
 */
export function normalizeMnemonic(mnemonic: string): string {
  const normalized = mnemonic.normalize('NFKD').trim().toLowerCase();
  return normalized === '' ? '' : normalized.split(/\s+/u).join(' ');
}

export function entropyToMnemonic(entropy: Uint8Array): string {
  requireEntropyLength(entropy);
  return bip39EntropyToMnemonic(entropy, englishWordlist);
}

export function mnemonicToEntropy(mnemonic: string): Uint8Array {
  const normalized = normalizeMnemonic(mnemonic);
  const words = wordsOf(normalized);
  requireWordCount(words);
  requireEnglishWords(words);

  try {
    const entropy = bip39MnemonicToEntropy(normalized, englishWordlist);
    requireEntropyLength(entropy);
    return entropy;
  } catch (cause) {
    if (cause instanceof MnemonicEntropyLengthError) throw cause;
    // With the shape and wordlist already checked, the only invalid BIP39
    // property left is its checksum. Keep that distinction stable even if the
    // dependency changes its untyped error text.
    throw new MnemonicChecksumError();
  }
}

/** Generates the one supported phrase shape from exactly one 128-bit CSPRNG read. */
export function generateMnemonic(randomBytes: RandomBytes = secureRandomBytes): string {
  const entropy = randomBytes(BIP39_ENTROPY_BYTES);
  try {
    requireEntropyLength(entropy);
    return entropyToMnemonic(entropy);
  } finally {
    if (entropy instanceof Uint8Array) entropy.fill(0);
  }
}

export async function deriveMnemonicSeed(mnemonic: string): Promise<Uint8Array> {
  const normalized = normalizeMnemonic(mnemonic);
  const entropy = mnemonicToEntropy(normalized);
  entropy.fill(0);

  // Do not add Argon2id here: the random phrase already carries 128 bits of
  // entropy, and standard BIP39 PBKDF2 keeps recovery interoperable. Argon2id
  // belongs only to the low-entropy, human-chosen endpoint device password.
  const seed = await mnemonicToSeedWebcrypto(normalized, '');
  if (seed.length !== BIP39_SEED_BYTES) {
    seed.fill(0);
    throw new Error('BIP39 seed derivation returned an invalid length.');
  }
  return seed;
}

/** Selects exactly one of the twelve positions with unbiased CSPRNG sampling. */
export function createMnemonicWordChallenge(
  mnemonic: string,
  randomBytes: RandomBytes = secureRandomBytes,
): MnemonicWordChallenge {
  const entropy = mnemonicToEntropy(mnemonic);
  entropy.fill(0);
  return { wordNumber: sampleWordNumber(randomBytes) };
}

/** Verifies only the word selected by the challenge; it never accepts a phrase. */
export function verifyMnemonicWordChallenge(
  mnemonic: string,
  challenge: MnemonicWordChallenge,
  answer: string,
): boolean {
  if (
    !Number.isInteger(challenge.wordNumber) ||
    challenge.wordNumber < 1 ||
    challenge.wordNumber > BIP39_WORD_COUNT
  ) {
    return false;
  }

  const normalized = normalizeMnemonic(mnemonic);
  const words = wordsOf(normalized);
  try {
    requireWordCount(words);
    requireEnglishWords(words);
    const entropy = bip39MnemonicToEntropy(normalized, englishWordlist);
    entropy.fill(0);
  } catch {
    return false;
  }

  const normalizedAnswer = answer.normalize('NFKD').trim().toLowerCase();
  if (normalizedAnswer === '' || /\s/u.test(normalizedAnswer)) return false;
  return normalizedAnswer === words[challenge.wordNumber - 1];
}

function wordsOf(normalizedMnemonic: string): string[] {
  return normalizedMnemonic === '' ? [] : normalizedMnemonic.split(' ');
}

function requireWordCount(words: readonly string[]): void {
  if (words.length !== BIP39_WORD_COUNT) {
    throw new MnemonicWordCountError(words.length);
  }
}

function requireEnglishWords(words: readonly string[]): void {
  for (const [index, word] of words.entries()) {
    if (!ENGLISH_WORDS.has(word)) {
      throw new MnemonicUnknownWordError(word, index + 1);
    }
  }
}

function requireEntropyLength(entropy: Uint8Array): void {
  if (!(entropy instanceof Uint8Array) || entropy.length !== BIP39_ENTROPY_BYTES) {
    throw new MnemonicEntropyLengthError(
      entropy instanceof Uint8Array ? entropy.length : Number.NaN,
    );
  }
}

function sampleWordNumber(randomBytes: RandomBytes): number {
  const unbiasedLimit = BYTE_VALUE_COUNT - (BYTE_VALUE_COUNT % BIP39_WORD_COUNT);
  for (let attempt = 0; attempt < MAX_CHALLENGE_RANDOM_ATTEMPTS; attempt += 1) {
    const sample = randomBytes(CHALLENGE_RANDOM_BYTES);
    try {
      if (!(sample instanceof Uint8Array) || sample.length !== CHALLENGE_RANDOM_BYTES) {
        throw new Error('Mnemonic challenge CSPRNG returned an invalid length.');
      }
      const value = sample[0];
      if (value != null && value < unbiasedLimit) return (value % BIP39_WORD_COUNT) + 1;
    } finally {
      if (sample instanceof Uint8Array) sample.fill(0);
    }
  }
  throw new Error('Mnemonic challenge CSPRNG failed to produce an unbiased sample.');
}
