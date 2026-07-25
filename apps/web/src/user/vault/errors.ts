export type VaultCryptoErrorCode =
  | 'authentication-failed'
  | 'custody-failed'
  | 'document-invalid'
  | 'envelope-invalid'
  | 'kdf-failed'
  | 'locked'
  | 'recovery-kit-invalid'
  | 'storage-failed'
  | 'unsupported-crypto'
  | 'update-required';

/** A fail-closed error raised by the browser-only paranoid vault core. */
export class VaultCryptoError extends Error {
  constructor(
    public readonly code: VaultCryptoErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'VaultCryptoError';
  }
}

export function asVaultCryptoError(
  code: VaultCryptoErrorCode,
  message: string,
  cause: unknown,
): VaultCryptoError {
  return cause instanceof VaultCryptoError ? cause : new VaultCryptoError(code, message, { cause });
}
