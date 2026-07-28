import { describe, expect, it } from 'vitest';

import {
  createSecretBoxKeyring,
  decryptSecret,
  encryptSecret,
  secretEnvelopeKeyId,
} from '../secretBox';

const ACTIVE_KEY = Buffer.alloc(32, 0x11);
const PREVIOUS_KEY = Buffer.alloc(32, 0x22);
const LEGACY_KEY = Buffer.alloc(32, 0x33);

function keyring() {
  return createSecretBoxKeyring({
    active: { id: 'current_2026', key: ACTIVE_KEY },
    previous: [{ id: 'previous_2025', key: PREVIOUS_KEY }],
    legacyKeys: [LEGACY_KEY],
  });
}

describe('secretBox versioned envelopes', () => {
  it('writes v2 with a public key id and reads active and previous keys', () => {
    const current = encryptSecret('current secret', keyring());
    expect(current.split('.').slice(0, 2)).toEqual(['v2', 'current_2026']);
    expect(secretEnvelopeKeyId(current)).toBe('current_2026');
    expect(decryptSecret(current, keyring())).toBe('current secret');

    const previousWriter = createSecretBoxKeyring({
      active: { id: 'previous_2025', key: PREVIOUS_KEY },
    });
    const previous = encryptSecret('previous secret', previousWriter);
    expect(decryptSecret(previous, keyring())).toBe('previous secret');
  });

  it('reads legacy v1 envelopes using ordered legacy candidates', () => {
    const legacy = encryptSecret('legacy secret', LEGACY_KEY);
    expect(legacy.startsWith('v1.')).toBe(true);
    expect(secretEnvelopeKeyId(legacy)).toBeNull();
    expect(decryptSecret(legacy, keyring())).toBe('legacy secret');
  });

  it('fails closed for unknown ids, wrong keys, malformed data, and tampering', () => {
    const envelope = encryptSecret('protected', keyring());

    const withoutCurrent = createSecretBoxKeyring({
      active: { id: 'different', key: PREVIOUS_KEY },
    });
    expect(() => decryptSecret(envelope, withoutCurrent)).toThrow('unknown key');

    const wrongCurrent = createSecretBoxKeyring({
      active: { id: 'current_2026', key: PREVIOUS_KEY },
    });
    expect(() => decryptSecret(envelope, wrongCurrent)).toThrow('authentication failed');

    const parts = envelope.split('.');
    const ciphertext = parts[4]!;
    parts[4] = `${ciphertext[0] === 'A' ? 'B' : 'A'}${ciphertext.slice(1)}`;
    expect(() => decryptSecret(parts.join('.'), keyring())).toThrow('authentication failed');

    expect(() => decryptSecret('v2.current_2026.not-valid.*.data', keyring())).toThrow(
      'malformed envelope',
    );
    expect(() => decryptSecret('not-an-envelope', keyring())).toThrow('malformed envelope');
  });

  it('authenticates the key id even when two ids resolve to the same key bytes', () => {
    const ring = createSecretBoxKeyring({
      active: { id: 'active', key: ACTIVE_KEY },
      previous: [{ id: 'alias', key: ACTIVE_KEY }],
    });
    const envelope = encryptSecret('protected', ring);
    const relabelled = envelope.replace('v2.active.', 'v2.alias.');
    expect(() => decryptSecret(relabelled, ring)).toThrow('authentication failed');
  });
});
