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
});

describe('generateTempPassword', () => {
  it('produces a 16-char password by default', () => {
    expect(generateTempPassword()).toHaveLength(16);
    expect(generateTempPassword()).not.toBe(generateTempPassword());
  });
});
