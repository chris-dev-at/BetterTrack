import { Outlet } from 'react-router-dom';

import { ComingSoon } from '../../ui';
import { SubNav, type SubNavItem } from '../components/SubNav';
import { ACTIVE_PORTFOLIO_PARAM, PortfolioSwitcher } from './PortfolioSwitcher';

/**
 * Portfolio section shell (PROJECTPLAN.md §6.8, §7.2). Hosts the portfolio
 * switcher placeholder and the section subnav above every portfolio route.
 */
const PORTFOLIO_SUBNAV: readonly SubNavItem[] = [
  { to: '/portfolio', label: 'Overview', end: true },
  { to: '/portfolio/transactions', label: 'Transactions' },
  { to: '/portfolio/custom-assets', label: 'Custom Assets' },
];

export function PortfolioLayout() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <PortfolioSwitcher />
      </div>
      {/* The active portfolio lives only in `?portfolio=<id>` (PortfolioSwitcher);
          carry it across the subnav so opening Transactions / Custom Assets keeps
          the selection instead of silently reverting to the default (#322). */}
      <SubNav items={PORTFOLIO_SUBNAV} preserveParams={[ACTIVE_PORTFOLIO_PARAM]} />
      <Outlet />
    </div>
  );
}

// ─── Not-yet-built surfaces (own feature issues) ──────────────────────────────

export function TransactionsPage() {
  return (
    <ComingSoon
      title="Transactions"
      description="The full transaction ledger — every buy and sell, editable, with realized P/L — lands with the Portfolio phase."
    />
  );
}

export function CustomAssetsPage() {
  return (
    <ComingSoon
      title="Custom Assets"
      description="Track real estate, vehicles, collectibles and other unlisted holdings with a value-points editor."
    />
  );
}
