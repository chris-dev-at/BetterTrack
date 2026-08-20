export type VaultKeyCoreErrorCode =
  | 'authentication-failed'
  | 'document-invalid'
  | 'envelope-invalid'
  | 'fingerprint-mismatch'
  | 'invalid-key-material'
  | 'rotation-failed'
  | 'slot-invalid'
  | 'unsupported-crypto'
  | 'update-required';

/** Fail-closed error for the per-vault seed/key/document core. */
export class VaultKeyCoreError extends Error {
  constructor(
    public readonly code: VaultKeyCoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'VaultKeyCoreError';
  }
}

export function asVaultKeyCoreError(
  code: VaultKeyCoreErrorCode,
  message: string,
  cause: unknown,
): VaultKeyCoreError {
  return cause instanceof VaultKeyCoreError
    ? cause
    : new VaultKeyCoreError(code, message, { cause });
}
