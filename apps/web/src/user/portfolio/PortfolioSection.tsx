import { Link, useLocation } from 'react-router-dom';

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
  const { search } = useLocation();
  return (
    <ComingSoon
      title={t('portfolio.section.subnav.transactions')}
      description={t('portfolio.section.transactionsComingSoon.description')}
      cta={
        <Link className="bt-btn bt-btn--primary" to={{ pathname: '/portfolio', search }}>
          {t('portfolio.section.transactionsComingSoon.cta')}
        </Link>
      }
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
