import { VaultCryptoError } from '../errors';
import { EndpointKeystoreError } from '../keystore';
import { VaultPortfolioStoreError } from '../vaultPortfolioStore';

export const VAULT_MONEY_ERROR_CODES = [
  'VAULT_LOCKED',
  'VAULT_CORRUPT',
  'VAULT_DATA_UNAVAILABLE',
  'VAULT_UNSUPPORTED_VERSION',
  'VAULT_UNSUPPORTED_ENTITY',
  'VAULT_OPERATION_UNSUPPORTED',
  'VAULT_INVALID_OWNERSHIP',
  'PORTFOLIO_NOT_FOUND',
  'MARKET_DATA_MISSING',
  'MARKET_DATA_INVALID',
  'MARKET_DATA_UNAVAILABLE',
  'MARKET_DATA_UNSUPPORTED',
  'TAX_MODE_UNSUPPORTED',
  'TAX_PARAMETERS_INVALID',
  'TAX_DATA_INVALID',
  'OPERATION_ABORTED',
] as const;

export type VaultMoneyErrorCode = (typeof VAULT_MONEY_ERROR_CODES)[number];

export interface VaultMoneyFailure {
  code: VaultMoneyErrorCode;
  message: string;
  retryable: boolean;
  details?: Readonly<Record<string, unknown>>;
}

export type VaultMoneyOutcome<T> = { ok: true; value: T } | { ok: false; error: VaultMoneyFailure };

/** Internal typed exception; public engine methods convert it to an outcome. */
export class VaultMoneyEngineError extends Error {
  constructor(
    public readonly failure: VaultMoneyFailure,
    options?: ErrorOptions,
  ) {
    super(failure.message, options);
    this.name = 'VaultMoneyEngineError';
  }
}

export function moneyFailure(
  code: VaultMoneyErrorCode,
  message: string,
  options: {
    retryable?: boolean;
    details?: Readonly<Record<string, unknown>>;
    cause?: unknown;
  } = {},
): VaultMoneyEngineError {
  return new VaultMoneyEngineError(
    {
      code,
      message,
      retryable: options.retryable ?? false,
      ...(options.details === undefined ? {} : { details: options.details }),
    },
    options.cause === undefined ? undefined : { cause: options.cause },
  );
}

export function asMoneyFailure(cause: unknown): VaultMoneyFailure {
  if (cause instanceof VaultMoneyEngineError) return cause.failure;
  if (cause instanceof EndpointKeystoreError) return keystoreFailure(cause);
  if (cause instanceof VaultPortfolioStoreError) return storeFailure(cause);
  if (cause instanceof VaultCryptoError) return cryptoFailure(cause);
  if (cause instanceof DOMException && cause.name === 'AbortError') {
    return {
      code: 'OPERATION_ABORTED',
      message: 'The client money operation was aborted.',
      retryable: true,
    };
  }
  return {
    code: 'VAULT_CORRUPT',
    message: 'The decrypted vault could not be processed safely.',
    retryable: false,
  };
}

function keystoreFailure(cause: EndpointKeystoreError): VaultMoneyFailure {
  switch (cause.code) {
    case 'phrase-locked':
    case 'session-ended':
    case 'locked-out':
      return typedFailure('VAULT_LOCKED', cause.message, true);
    case 'verification-failed':
    case 'crypto-failed':
    case 'storage-invalid':
      return typedFailure('VAULT_CORRUPT', cause.message, false);
    // `vault-header-unavailable` (E7, #1451): the authenticated header envelope
    // could not be fetched, or came back as something other than bytes. That is
    // a transport/availability failure, not corruption — the ciphertext is
    // untouched and the next attempt may well succeed — so it must not be
    // reported as VAULT_CORRUPT, which is final and alarming. Unavailable and
    // retryable is the honest reading, and it keeps the figure UNKNOWN rather
    // than quietly absent.
    case 'vault-header-unavailable':
    case 'vault-not-stored':
    case 'device-password-required':
    case 'device-password-not-configured':
    case 'device-password-invalid':
    case 'wrong-password':
    case 'acknowledgment-required':
    case 'custody-failed':
    case 'custody-unavailable':
      // The two custody codes belong here rather than with corruption: device
      // custody is an OPT-IN convenience over an otherwise intact vault, so a
      // browser refusing to hold — or hand back — the device key breaks the
      // "keep unlocked" promise, never the ciphertext. Calling that VAULT_CORRUPT
      // would be a false alarm about the user's money data.
      return typedFailure('VAULT_DATA_UNAVAILABLE', cause.message, true);
  }
}

function storeFailure(cause: VaultPortfolioStoreError): VaultMoneyFailure {
  switch (cause.code) {
    case 'VAULT_LOCKED':
      return typedFailure('VAULT_LOCKED', cause.message, true);
    case 'VAULT_DATA_UNAVAILABLE':
      return typedFailure('VAULT_DATA_UNAVAILABLE', cause.message, true);
    case 'VAULT_OPERATION_ABORTED':
      return typedFailure('OPERATION_ABORTED', cause.message, true);
    case 'VAULT_OPERATION_UNAVAILABLE':
    case 'VAULT_LAST_ACTIVE_PORTFOLIO':
      return typedFailure('VAULT_OPERATION_UNSUPPORTED', cause.message, false);
    case 'VAULT_CORRUPT':
    case 'VAULT_DATA_INVALID':
    case 'VAULT_ENTITY_NOT_FOUND':
      return typedFailure('VAULT_CORRUPT', cause.message, false);
  }
}

function cryptoFailure(cause: VaultCryptoError): VaultMoneyFailure {
  switch (cause.code) {
    case 'locked':
      return typedFailure('VAULT_LOCKED', cause.message, true);
    case 'custody-failed':
    case 'kdf-failed':
    case 'storage-failed':
      return typedFailure('VAULT_DATA_UNAVAILABLE', cause.message, true);
    case 'update-required':
      return typedFailure('VAULT_UNSUPPORTED_VERSION', cause.message, false);
    case 'unsupported-crypto':
      return typedFailure('VAULT_OPERATION_UNSUPPORTED', cause.message, false);
    case 'authentication-failed':
    case 'document-invalid':
    case 'envelope-invalid':
    case 'recovery-kit-invalid':
      return typedFailure('VAULT_CORRUPT', cause.message, false);
  }
}

function typedFailure(
  code: VaultMoneyErrorCode,
  message: string,
  retryable: boolean,
): VaultMoneyFailure {
  return { code, message, retryable };
}
