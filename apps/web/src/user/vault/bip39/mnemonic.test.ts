import { webcrypto } from 'node:crypto';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  BIP39_ENTROPY_BYTES,
  BIP39_SEED_BYTES,
  BIP39_WORD_COUNT,
  MnemonicChecksumError,
  MnemonicEntropyLengthError,
  MnemonicUnknownWordError,
  MnemonicWordCountError,
  createMnemonicWordChallenge,
  deriveMnemonicSeed,
  entropyToMnemonic,
  generateMnemonic,
  mnemonicToEntropy,
  normalizeMnemonic,
  verifyMnemonicWordChallenge,
} from './mnemonic';

const ZERO_ENTROPY_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const SEVEN_F_ENTROPY_MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
});

describe('English 12-word BIP39', () => {
  it('round-trips exactly 128 bits of entropy', () => {
    const entropy = new Uint8Array(BIP39_ENTROPY_BYTES);

    expect(entropyToMnemonic(entropy)).toBe(ZERO_ENTROPY_MNEMONIC);
    expect(mnemonicToEntropy(ZERO_ENTROPY_MNEMONIC)).toEqual(entropy);
    expect(ZERO_ENTROPY_MNEMONIC.split(' ')).toHaveLength(BIP39_WORD_COUNT);
  });

  it('normalizes NFKD and pasted whitespace without weakening validation', () => {
    expect(
      normalizeMnemonic(`  ${ZERO_ENTROPY_MNEMONIC.toUpperCase().replaceAll(' ', '\n\t')}  `),
    ).toBe(ZERO_ENTROPY_MNEMONIC);
    expect(mnemonicToEntropy(`  ${ZERO_ENTROPY_MNEMONIC.replaceAll(' ', '  ')}  `)).toEqual(
      new Uint8Array(BIP39_ENTROPY_BYTES),
    );
  });

  it('pins the standard empty-passphrase mnemonic-to-seed vector', async () => {
    // TEST VECTOR: BIP39 128-bit zero entropy with the standard empty passphrase.
    const expectedSeedHex =
      '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19' +
      'a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4';

    const seed = await deriveMnemonicSeed(ZERO_ENTROPY_MNEMONIC);

    expect(seed).toHaveLength(BIP39_SEED_BYTES);
    expect(bytesToHex(seed)).toBe(expectedSeedHex);
  });

  it('pins a second published BIP39 mnemonic with the binding empty passphrase', async () => {
    // TEST VECTOR: canonical BIP39 0x7f…7f 128-bit entropy mnemonic, published
    // in the standard vector set; BetterTrack always uses the empty passphrase.
    const expectedSeedHex =
      '878386efb78845b3355bd15ea4d39ef97d179cb712b77d5c12b6be415fffeffe' +
      '5f377ba02bf3f8544ab800b955e51fbff09828f682052a20faa6addbbddfb096';

    const seed = await deriveMnemonicSeed(SEVEN_F_ENTROPY_MNEMONIC);

    expect(seed).toHaveLength(BIP39_SEED_BYTES);
    expect(bytesToHex(seed)).toBe(expectedSeedHex);
  });

  it('reports wrong count, unknown word, checksum, and entropy length distinctly', () => {
    const wrongCount = ZERO_ENTROPY_MNEMONIC.split(' ').slice(0, -1).join(' ');
    const unknownWord = ZERO_ENTROPY_MNEMONIC.replace('about', 'notaword');
    const brokenChecksum = ZERO_ENTROPY_MNEMONIC.replace('about', 'abandon');

    expect(() => mnemonicToEntropy(wrongCount)).toThrow(MnemonicWordCountError);
    expect(() => mnemonicToEntropy(unknownWord)).toThrow(MnemonicUnknownWordError);
    expect(() => mnemonicToEntropy(brokenChecksum)).toThrow(MnemonicChecksumError);
    expect(() => entropyToMnemonic(new Uint8Array(BIP39_ENTROPY_BYTES - 1))).toThrow(
      MnemonicEntropyLengthError,
    );
  });

  it('uses one 16-byte injected CSPRNG read and no time or Math.random seed', () => {
    const randomEntropy = new Uint8Array(BIP39_ENTROPY_BYTES).fill(0x7f);
    const randomBytes = vi.fn(() => randomEntropy);
    const dateNow = vi.spyOn(Date, 'now');
    const mathRandom = vi.spyOn(Math, 'random');

    try {
      expect(generateMnemonic(randomBytes)).toBe(SEVEN_F_ENTROPY_MNEMONIC);
      expect(randomBytes).toHaveBeenCalledOnce();
      expect(randomBytes).toHaveBeenCalledWith(BIP39_ENTROPY_BYTES);
      expect(dateNow).not.toHaveBeenCalled();
      expect(mathRandom).not.toHaveBeenCalled();
      expect(randomEntropy).toEqual(new Uint8Array(BIP39_ENTROPY_BYTES));
    } finally {
      dateNow.mockRestore();
      mathRandom.mockRestore();
    }
  });

  it('defaults mnemonic generation to the WebCrypto CSPRNG', () => {
    const originalCrypto = globalThis.crypto;
    const getRandomValues = vi.fn(<T extends ArrayBufferView | null>(array: T): T => {
      if (array instanceof Uint8Array) array.fill(0);
      return array;
    });
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: { getRandomValues, subtle: originalCrypto.subtle } satisfies Partial<Crypto>,
    });

    try {
      expect(generateMnemonic()).toBe(ZERO_ENTROPY_MNEMONIC);
      expect(getRandomValues).toHaveBeenCalledOnce();
      expect(getRandomValues.mock.calls[0]?.[0]).toHaveLength(BIP39_ENTROPY_BYTES);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: originalCrypto });
    }
  });
});

describe('one-word creation ceremony', () => {
  it('selects one one-based word position with unbiased rejection sampling', () => {
    const samples = [Uint8Array.of(255), Uint8Array.of(11)];
    let nextSample = 0;
    const randomBytes = vi.fn(() => samples[nextSample++] ?? Uint8Array.of(0));

    const challenge = createMnemonicWordChallenge(ZERO_ENTROPY_MNEMONIC, randomBytes);

    expect(challenge).toEqual({ wordNumber: 12 });
    expect(randomBytes).toHaveBeenCalledTimes(2);
    expect(randomBytes).toHaveBeenNthCalledWith(1, 1);
    expect(randomBytes).toHaveBeenNthCalledWith(2, 1);
    expect(samples).toEqual([Uint8Array.of(0), Uint8Array.of(0)]);
  });

  it('accepts only the selected single word and fails closed for invalid challenges', () => {
    const challenge = { wordNumber: 12 } as const;

    expect(verifyMnemonicWordChallenge(ZERO_ENTROPY_MNEMONIC, challenge, 'about')).toBe(true);
    expect(verifyMnemonicWordChallenge(ZERO_ENTROPY_MNEMONIC, challenge, ' ABOUT ')).toBe(true);
    expect(verifyMnemonicWordChallenge(ZERO_ENTROPY_MNEMONIC, challenge, 'abandon')).toBe(false);
    expect(verifyMnemonicWordChallenge(ZERO_ENTROPY_MNEMONIC, challenge, 'about abandon')).toBe(
      false,
    );
    expect(verifyMnemonicWordChallenge(ZERO_ENTROPY_MNEMONIC, { wordNumber: 0 }, 'abandon')).toBe(
      false,
    );
  });
});
