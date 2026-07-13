import { Outlet } from 'react-router-dom';

import { useT } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import { ComingSoon } from '../../ui';
import { SubNav, type SubNavItem } from '../components/SubNav';
import { ACTIVE_PORTFOLIO_PARAM, PortfolioSwitcher } from './PortfolioSwitcher';

/**
 * Portfolio section shell (PROJECTPLAN.md §6.8, §7.2). Hosts the portfolio
 * switcher placeholder and the section subnav above every portfolio route.
 */
function portfolioSubNav(t: TranslateFn): readonly SubNavItem[] {
  return [
    { to: '/portfolio', label: t('portfolio.section.subnav.overview'), end: true },
    { to: '/portfolio/transactions', label: t('portfolio.section.subnav.transactions') },
    { to: '/portfolio/custom-assets', label: t('portfolio.section.subnav.customAssets') },
    { to: '/portfolio/cash', label: t('portfolio.section.subnav.cash') },
    { to: '/portfolio/tax', label: t('portfolio.section.subnav.tax') },
  ];
}

export function PortfolioLayout() {
  const t = useT();
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <PortfolioSwitcher />
      </div>
      {/* The active portfolio lives only in `?portfolio=<id>` (PortfolioSwitcher);
          carry it across the subnav so opening Transactions / Custom Assets keeps
          the selection instead of silently reverting to the default (#322). */}
      <SubNav items={portfolioSubNav(t)} preserveParams={[ACTIVE_PORTFOLIO_PARAM]} />
      <Outlet />
    </div>
  );
}

// ─── Not-yet-built surfaces (own feature issues) ──────────────────────────────

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
