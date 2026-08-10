import { describe, expect, it } from 'vitest';

import {
  checkVaultPassphrase,
  generateVaultPassphrase,
  normalizeVaultPassphrase,
  pickConfirmationPositions,
  requireVaultPassphrase,
  VAULT2_PASSPHRASE_WORD_COUNT,
  VAULT2_WORDLIST,
} from './words';
import { FIXTURE_PASSPHRASE } from './testSupport';

describe('vault passphrase words', () => {
  it('exposes the full 2048-word vocabulary', () => {
    expect(VAULT2_WORDLIST).toHaveLength(2048);
    expect(new Set(VAULT2_WORDLIST).size).toBe(2048);
  });

  it('generates 12 distinct-looking valid phrases', () => {
    const first = generateVaultPassphrase();
    const second = generateVaultPassphrase();
    expect(first.split(' ')).toHaveLength(VAULT2_PASSPHRASE_WORD_COUNT);
    expect(checkVaultPassphrase(first).valid).toBe(true);
    expect(checkVaultPassphrase(second).valid).toBe(true);
    expect(first).not.toBe(second);
  });

  it('normalizes casing, padding and repeated whitespace', () => {
    expect(normalizeVaultPassphrase('  Legal   WINNER\tthank \n year  ')).toBe(
      'legal winner thank year',
    );
  });

  it('accepts the fixture phrase and reports its words', () => {
    const checked = checkVaultPassphrase(`  ${FIXTURE_PASSPHRASE.toUpperCase()} `);
    expect(checked).toMatchObject({ valid: true, passphrase: FIXTURE_PASSPHRASE });
    if (checked.valid) expect(checked.words).toHaveLength(12);
  });

  it('distinguishes the three ways a phrase can be wrong', () => {
    expect(checkVaultPassphrase('legal winner thank')).toEqual({
      valid: false,
      problem: { kind: 'word-count', count: 3 },
    });

    const unknown = checkVaultPassphrase(
      'legal winner thank year wave sausage worth useful legal winner thank zzzz',
    );
    expect(unknown).toEqual({
      valid: false,
      problem: { kind: 'unknown-words', words: ['zzzz'], positions: [11] },
    });

    // All twelve words are real, but the checksum word is wrong for them.
    expect(
      checkVaultPassphrase(
        'legal winner thank year wave sausage worth useful legal winner thank zoo',
      ),
    ).toEqual({ valid: false, problem: { kind: 'checksum' } });
  });

  it('treats an empty phrase as a word-count problem, not a crash', () => {
    expect(checkVaultPassphrase('   ')).toEqual({
      valid: false,
      problem: { kind: 'word-count', count: 0 },
    });
  });

  it('throws only from the strict wrapper', () => {
    expect(requireVaultPassphrase(FIXTURE_PASSPHRASE)).toBe(FIXTURE_PASSPHRASE);
    expect(() => requireVaultPassphrase('nope')).toThrowError(/12 valid words/u);
  });

  it('picks sorted, unique, in-range confirmation positions', () => {
    const sequence = [5, 5, 0, 11];
    let index = 0;
    const positions = pickConfirmationPositions(3, () => sequence[index++ % sequence.length]!);
    expect(positions).toEqual([0, 5, 11]);
    for (const position of positions) {
      expect(position).toBeGreaterThanOrEqual(0);
      expect(position).toBeLessThan(VAULT2_PASSPHRASE_WORD_COUNT);
    }
  });
});
