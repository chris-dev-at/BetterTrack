import { useT } from '../../i18n';
import { ComingSoon } from '../../ui';

/**
 * Portfolio workspace stub pages (PROJECTPLAN.md §7.2). The Origin redesign
 * mounts these under the PortfolioWorkspace tabs: transaction management runs
 * through the Overview's dialogs today, so Activity and Custom assets render
 * designed placeholders that point there until their dedicated ledgers build.
 */
export function TransactionsPage() {
  const t = useT();
  return (
    <ComingSoon
      title={t('portfolio.section.subnav.transactions')}
      description={t('portfolio.section.transactionsComingSoon.description')}
    />
  );
}

export function CustomAssetsPage() {
  const t = useT();
  return (
    <ComingSoon
      title={t('portfolio.section.subnav.customAssets')}
      description={t('portfolio.section.customAssetsComingSoon.description')}
    />
  );
}
