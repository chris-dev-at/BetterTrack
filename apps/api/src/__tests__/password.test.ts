import { describe, expect, it } from 'vitest';

import { createPasswordHasher } from '../services/password/passwordHasher';
import { checkPasswordPolicy } from '../services/password/passwordPolicy';
import { generateTempPassword } from '../services/password/tempPassword';

describe('passwordHasher', () => {
  const hasher = createPasswordHasher();

  it('produces argon2id hashes that verify', async () => {
    const hash = await hasher.hash('a-correct-horse-battery');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await hasher.verify(hash, 'a-correct-horse-battery')).toBe(true);
    expect(await hasher.verify(hash, 'wrong-password')).toBe(false);
  });

  it('returns false (not throw) on a malformed hash', async () => {
    expect(await hasher.verify('not-a-hash', 'whatever')).toBe(false);
  });
});

describe('checkPasswordPolicy', () => {
  it('accepts a sufficiently long, uncommon password', () => {
    expect(checkPasswordPolicy('a-perfectly-fine-passphrase').ok).toBe(true);
  });

  it('rejects passwords shorter than 10 characters', () => {
    expect(checkPasswordPolicy('short').ok).toBe(false);
  });

  it('rejects common passwords (case-insensitive)', () => {
    expect(checkPasswordPolicy('Password1').ok).toBe(false);
    expect(checkPasswordPolicy('qwertyuiop').ok).toBe(false);
  });

  it('rejects entries from the full SecLists top-10k blocklist (issue #30)', () => {
    // These are ≥ 10 chars (so they clear the length gate) and appear in the
    // full top-10k list but not in the previous curated ~140-entry seed, so a
    // rejection proves the blocklist itself — not the length rule — caught them.
    expect(checkPasswordPolicy('experienced').ok).toBe(false);
    expect(checkPasswordPolicy('enterprise').ok).toBe(false);
    // …and case-insensitively, since the policy lowercases before lookup.
    expect(checkPasswordPolicy('California').ok).toBe(false);
  });

  it('accepts a strong, uncommon passphrase', () => {
    expect(checkPasswordPolicy('correct-horse-battery-staple-47').ok).toBe(true);
  });
});

describe('generateTempPassword', () => {
  it('produces a 16-char password by default', () => {
    expect(generateTempPassword()).toHaveLength(16);
    expect(generateTempPassword()).not.toBe(generateTempPassword());
  });
});
