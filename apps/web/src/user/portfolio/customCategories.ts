import type { CustomAssetCategory } from '@bettertrack/contracts';

import type { TranslateFn } from '../../i18n';

/**
 * Human labels for the §6.9 / V3-P2 custom-investment categories — the catalog
 * taxonomy shared by the create dialog ({@link CustomInvestmentDialog}) and the
 * per-asset editor ({@link ValuePointEditor}), so both stay in lockstep.
 */
export function customCategoryLabels(t: TranslateFn): Record<CustomAssetCategory, string> {
  return {
    stock: t('portfolio.customInvestment.category.stock'),
    etf: t('portfolio.customInvestment.category.etf'),
    crypto: t('portfolio.customInvestment.category.crypto'),
    commodity: t('portfolio.customInvestment.category.commodity'),
    cash_like: t('portfolio.customInvestment.category.cashLike'),
    other: t('portfolio.customInvestment.category.other'),
  };
}
