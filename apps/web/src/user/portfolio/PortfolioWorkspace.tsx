import { Outlet, useLocation } from 'react-router-dom';

import { useT } from '../../i18n';
import { LocalNav, usePreservedSearch } from '../components/LocalNav';
import { SECTION_NAV, useSectionNavItems } from '../components/sectionNav';
import { SubTabLink } from '../../ui/origin';
import { ACTIVE_PORTFOLIO_PARAM } from './PortfolioSwitcher';

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
        items={items}
        preserveParams={SECTION_NAV.portfolio.preserveParams}
      />
      <Outlet />
    </div>
  );
}

/**
 * CASH, inside the portfolio workspace (V5 cash fusion; restructured on the
 * owner's call, 2026-07-31).
 *
 * THREE TABS, because only three of these are questions about money:
 *
 *   Overview   how much do I have, and where?
 *   Movements  where did it go?
 *   Budgets    am I on track?
 *
 * It had SEVEN. Tags, Rules, Cash accounts and the parked importer are all
 * SETUP — each visited once and then never again — and putting them beside the
 * three real questions made the area read as a pile of settings rather than a
 * place to look at your money. They did not go away: accounts hang off the
 * balance strip on Overview, tags and rules merged into one "Labels" page
 * (a tag is the label, a rule is how it gets applied — two halves of one idea)
 * linked from Movements, and the parked importer keeps its URL but leaves the
 * navigation until there is something behind it.
 *
 * Every tab is scoped to the SAME active portfolio, so `?portfolio=<id>` is
 * preserved across them exactly like every other section's local nav (#322).
 *
 * The i18n keys stay under the legacy `cashflow.*` namespace: they are internal
 * identifiers, and renaming ~110 of them during a redesign buys nothing a
 * reader can see while risking a raw key on screen.
 */
export function CashLayout() {
  const t = useT();
  const location = useLocation();
  const search = usePreservedSearch([ACTIVE_PORTFOLIO_PARAM]);

  const subtabs = [
    { to: '/portfolio/cash', label: t('cashflow.tabs.overview'), end: true },
    { to: '/portfolio/cash/movements', label: t('cashflow.tabs.movements') },
    { to: '/portfolio/cash/budgets', label: t('cashflow.tabs.budgets') },
  ];

  return (
    <div>
      <nav aria-label={t('cashflow.aria')} className="bt-subtabs" style={{ marginBottom: 20 }}>
        {subtabs.map((tab) => (
          <SubTabLink
            end={tab.end}
            key={tab.to}
            to={search ? { pathname: tab.to, search } : tab.to}
          >
            {tab.label}
          </SubTabLink>
        ))}
      </nav>
      <Outlet key={location.pathname} />
    </div>
  );
}
