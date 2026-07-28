import { describe, expect, it } from 'vitest';

import { VaultCryptoError } from '../errors';
import { VaultPortfolioStoreError } from '../vaultPortfolioStore';
import { asMoneyFailure, type VaultMoneyErrorCode } from './errors';

describe('vault money failure mapping', () => {
  it.each([
    [new VaultPortfolioStoreError('VAULT_LOCKED', 'boundary'), 'VAULT_LOCKED', true],
    [
      new VaultPortfolioStoreError('VAULT_DATA_UNAVAILABLE', 'boundary'),
      'VAULT_DATA_UNAVAILABLE',
      true,
    ],
    [new VaultPortfolioStoreError('VAULT_CORRUPT', 'boundary'), 'VAULT_CORRUPT', false],
    [
      new VaultPortfolioStoreError('VAULT_OPERATION_UNAVAILABLE', 'boundary'),
      'VAULT_OPERATION_UNSUPPORTED',
      false,
    ],
    [new VaultCryptoError('locked', 'boundary'), 'VAULT_LOCKED', true],
    [new VaultCryptoError('storage-failed', 'boundary'), 'VAULT_DATA_UNAVAILABLE', true],
    [new VaultCryptoError('custody-failed', 'boundary'), 'VAULT_DATA_UNAVAILABLE', true],
    [new VaultCryptoError('document-invalid', 'boundary'), 'VAULT_CORRUPT', false],
    [new VaultCryptoError('update-required', 'boundary'), 'VAULT_UNSUPPORTED_VERSION', false],
    [new VaultCryptoError('unsupported-crypto', 'boundary'), 'VAULT_OPERATION_UNSUPPORTED', false],
  ] satisfies Array<readonly [Error, VaultMoneyErrorCode, boolean]>)(
    'maps %s to %s with retryable=%s',
    (cause, code, retryable) => {
      expect(asMoneyFailure(cause)).toEqual({ code, message: 'boundary', retryable });
    },
  );
});
