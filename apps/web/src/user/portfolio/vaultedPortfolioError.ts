import type { TranslateFn } from '../../i18n';
import { ApiError } from '../../lib/apiClient';

export const VAULTED_PORTFOLIO_ERROR_CODE = 'VAULTED_PORTFOLIO' as const;

/** Localized copy for the E2 boundary while E8 still exposes locked affordances. */
export function vaultedPortfolioErrorMessage(error: unknown, t: TranslateFn): string | null {
  return error instanceof ApiError && error.code === VAULTED_PORTFOLIO_ERROR_CODE
    ? t('portfolio.vaultedPortfolioUnavailable')
    : null;
}
