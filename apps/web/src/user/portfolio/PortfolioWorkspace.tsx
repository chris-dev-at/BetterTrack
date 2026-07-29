import { Outlet, useLocation } from 'react-router-dom';

import { useT } from '../../i18n';
import { LocalNav } from '../components/LocalNav';
import { SECTION_NAV, SECTION_STRIP_CLASS, useSectionNavItems } from '../components/sectionNav';
import { SubTabLink } from '../../ui/origin';

/**
 * The portfolio workspace (PRODUCT_BLUEPRINT.md §4 "Portfolio-local
 * navigation"): one portfolio, every job around it as local tabs. Live tabs
 * mount the real feature pages; parked tabs (gold dot) render their designed
 * parking surface until their build lands. The active portfolio rides in
 * `?portfolio=<id>` and is preserved across every tab (#322).
 *
 * The tab set itself lives in `components/sectionNav.ts` — the rail's
 * Portfolios group renders the very same children, and this strip only shows
 * where the rail is hidden (≤760px).
 */
export function PortfolioWorkspace() {
  const t = useT();
  const items = useSectionNavItems('portfolio');

  return (
    <div>
      <LocalNav
        ariaLabel={t(SECTION_NAV.portfolio.ariaLabelKey)}
        className={SECTION_STRIP_CLASS}
        items={items}
        preserveParams={SECTION_NAV.portfolio.preserveParams}
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
