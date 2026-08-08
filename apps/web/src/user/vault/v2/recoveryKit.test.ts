import { describe, expect, it } from 'vitest';

import {
  importRecoveryKitV2,
  RECOVERY_KIT_V2_FILENAME,
  serializeRecoveryKitV2,
} from './recoveryKit';
import { FIXTURE_PASSPHRASE, FIXTURE_VAULT_ID } from './testSupport';

describe('vault v2 recovery kit (r3 §25 family 5)', () => {
  const input = {
    vaultId: FIXTURE_VAULT_ID,
    vaultName: 'Drive vault',
    backends: 'drive' as const,
    passphrase: FIXTURE_PASSPHRASE,
  };

  it('round-trips through serialize/import', () => {
    const kit = serializeRecoveryKitV2(input);
    expect(kit.filename).toBe(RECOVERY_KIT_V2_FILENAME);
    const text = new TextDecoder().decode(kit.bytes);
    expect(text).toContain('formatVersion: 2');
    expect(text).toContain(`vaultId: ${FIXTURE_VAULT_ID}`);
    expect(text).toContain('backends: drive');
    expect(text).toContain(`words: ${FIXTURE_PASSPHRASE}`);

    const imported = importRecoveryKitV2(kit.bytes);
    expect(imported).toEqual({
      formatVersion: 2,
      vaultId: FIXTURE_VAULT_ID,
      vaultName: 'Drive vault',
      backends: 'drive',
      passphrase: FIXTURE_PASSPHRASE,
    });
  });

  it('normalizes the words on the way in', () => {
    const kit = serializeRecoveryKitV2({
      ...input,
      passphrase: `  ${FIXTURE_PASSPHRASE.toUpperCase()}  `,
    });
    expect(new TextDecoder().decode(kit.bytes)).toContain(`words: ${FIXTURE_PASSPHRASE}`);
  });

  it('refuses an invalid phrase and a blank name', () => {
    expect(() => serializeRecoveryKitV2({ ...input, passphrase: 'not real words' })).toThrowError(
      /12 valid words/u,
    );
    expect(() => serializeRecoveryKitV2({ ...input, vaultName: '   ' })).toThrowError(/name/u);
  });

  it('fails closed on a damaged kit', () => {
    expect(() => importRecoveryKitV2(new TextEncoder().encode('nope'))).toThrowError(
      /required format/u,
    );
  });
});
