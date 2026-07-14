import type { TranslateFn } from '../../i18n';

/**
 * Translated display names for the asset-type / catalog-category slugs
 * (PROJECTPLAN.md §6.3, V3-P2 taxonomy). Shared by the owner's Portfolio
 * overview and the friend-shared portfolio view so allocation group names
 * never drift between the two surfaces.
 */
export function assetTypeLabels(t: TranslateFn): Record<string, string> {
  return {
    stock: t('portfolio.overview.assetType.stock'),
    etf: t('portfolio.overview.assetType.etf'),
    index: t('portfolio.overview.assetType.index'),
    fx: t('portfolio.overview.assetType.fx'),
    commodity: t('portfolio.overview.assetType.commodity'),
    crypto: t('portfolio.overview.assetType.crypto'),
    cash_like: t('portfolio.overview.assetType.cashLike'),
    other: t('portfolio.overview.assetType.other'),
  };
}
