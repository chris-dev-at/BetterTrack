import { Outlet, useLocation } from 'react-router-dom';

import { useT } from '../../i18n';
import { useFeatureEnabled } from '../../lib/featureFlags';
import { LocalNav, type LocalNavItem } from '../components/LocalNav';
import { SubTabLink } from '../../ui/origin';
import { ACTIVE_PORTFOLIO_PARAM } from './PortfolioSwitcher';

/**
 * The portfolio workspace (PRODUCT_BLUEPRINT.md §4 "Portfolio-local
 * navigation"): one portfolio, every job around it as local tabs. Live tabs
 * mount the real feature pages; parked tabs (gold dot) render their designed
 * parking surface until their build lands. The active portfolio rides in
 * `?portfolio=<id>` and is preserved across every tab (#322).
 */
export function PortfolioWorkspace() {
  const t = useT();
  const importsEnabled = useFeatureEnabled('imports');

  const items: LocalNavItem[] = [
    { to: '/portfolio', label: t('portfolio.tabs.overview'), end: true },
    { to: '/portfolio/activity', label: t('portfolio.tabs.activity') },
    { to: '/portfolio/custom-assets', label: t('portfolio.tabs.customAssets') },
    { to: '/portfolio/cash-flow', label: t('portfolio.tabs.cashFlow') },
    { to: '/portfolio/analysis', label: t('portfolio.tabs.analysis') },
    { to: '/portfolio/tax', label: t('portfolio.tabs.tax') },
    ...(importsEnabled
      ? [{ to: '/portfolio/import', label: t('portfolio.tabs.import') } satisfies LocalNavItem]
      : []),
    { to: '/portfolio/plan', label: t('portfolio.tabs.plan'), parked: true },
    { to: '/portfolio/automate', label: t('portfolio.tabs.automate'), parked: true },
    { to: '/portfolio/files', label: t('portfolio.tabs.files'), parked: true },
    { to: '/portfolio/people', label: t('portfolio.tabs.people'), parked: true },
    { to: '/portfolio/settings', label: t('portfolio.tabs.settings'), parked: true },
  ];

  return (
    <div>
      <LocalNav
        ariaLabel={t('portfolio.section.aria')}
        items={items}
        preserveParams={[ACTIVE_PORTFOLIO_PARAM]}
      />
      <Outlet />
    </div>
  );
}

/**
 * Cash-flow area inside the portfolio workspace: hosts the expense suite
 * (V5-P9) plus the cash accounts page as one sub-tabbed region. Expense data
 * is household-scoped today; the portfolio data model grows into it later.
 */
export function CashFlowLayout() {
  const t = useT();
  const location = useLocation();

  const subtabs = [
    { to: '/portfolio/cash-flow', label: t('cashflow.tabs.overview'), end: true },
    { to: '/portfolio/cash-flow/transactions', label: t('cashflow.tabs.transactions') },
    { to: '/portfolio/cash-flow/budgets', label: t('cashflow.tabs.budgets') },
    { to: '/portfolio/cash-flow/categories', label: t('cashflow.tabs.categories') },
    { to: '/portfolio/cash-flow/rules', label: t('cashflow.tabs.rules') },
    { to: '/portfolio/cash-flow/import', label: t('cashflow.tabs.import') },
    { to: '/portfolio/cash-flow/accounts', label: t('cashflow.tabs.accounts') },
  ];

  return (
    <div>
      <nav aria-label={t('cashflow.aria')} className="bt-subtabs" style={{ marginBottom: 20 }}>
        {subtabs.map((tab) => (
          <SubTabLink end={tab.end} key={tab.to} to={tab.to}>
            {tab.label}
          </SubTabLink>
        ))}
      </nav>
      <Outlet key={location.pathname} />
    </div>
  );
}
