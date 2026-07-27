export const VAULT_MONEY_ERROR_CODES = [
  'VAULT_LOCKED',
  'VAULT_CORRUPT',
  'VAULT_UNSUPPORTED_VERSION',
  'VAULT_UNSUPPORTED_ENTITY',
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
