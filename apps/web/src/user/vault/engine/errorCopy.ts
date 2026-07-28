import type { VaultMoneyErrorCode, VaultMoneyFailure } from './errors';

const ERROR_KEYS: Record<VaultMoneyErrorCode, string> = {
  VAULT_LOCKED: 'vaultMoney.error.locked',
  VAULT_CORRUPT: 'vaultMoney.error.corrupt',
  VAULT_DATA_UNAVAILABLE: 'vaultMoney.error.unavailable',
  VAULT_UNSUPPORTED_VERSION: 'vaultMoney.error.unsupported',
  VAULT_UNSUPPORTED_ENTITY: 'vaultMoney.error.unsupported',
  VAULT_OPERATION_UNSUPPORTED: 'vaultMoney.error.unsupported',
  VAULT_INVALID_OWNERSHIP: 'vaultMoney.error.corrupt',
  PORTFOLIO_NOT_FOUND: 'vaultMoney.error.portfolioNotFound',
  MARKET_DATA_MISSING: 'vaultMoney.error.marketData',
  MARKET_DATA_INVALID: 'vaultMoney.error.marketData',
  MARKET_DATA_UNAVAILABLE: 'vaultMoney.error.marketData',
  MARKET_DATA_UNSUPPORTED: 'vaultMoney.error.marketData',
  TAX_MODE_UNSUPPORTED: 'vaultMoney.error.tax',
  TAX_PARAMETERS_INVALID: 'vaultMoney.error.tax',
  TAX_DATA_INVALID: 'vaultMoney.error.tax',
  OPERATION_ABORTED: 'vaultMoney.error.aborted',
};

/** i18n key for one typed client money failure — user-facing, never the raw message. */
export function vaultMoneyErrorKey(failure: Pick<VaultMoneyFailure, 'code'>): string {
  return ERROR_KEYS[failure.code] ?? 'vaultMoney.error.generic';
}
