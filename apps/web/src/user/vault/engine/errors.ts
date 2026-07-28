import { VaultCryptoError } from '../errors';
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
