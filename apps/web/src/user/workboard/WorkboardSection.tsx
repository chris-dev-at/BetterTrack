import { Outlet } from 'react-router-dom';

import { ComingSoon } from '../../ui';
import { SubNav, type SubNavItem } from '../components/SubNav';

/**
 * Workboard section shell (PROJECTPLAN.md §6.4, §7.2). Subnav: Overview ·
 * Conglomerates · Watchlists, plus the Coming-Soon experiments
 * (Backtests · Calculators · Comparisons · Saved Ideas).
 */
const WORKBOARD_SUBNAV: readonly SubNavItem[] = [
  { to: '/workboard', label: 'Overview', end: true },
  { to: '/workboard/conglomerates', label: 'Conglomerates' },
  { to: '/workboard/watchlist', label: 'Watchlists' },
  { to: '/workboard/backtests', label: 'Backtests', comingSoon: true },
  { to: '/workboard/calculators', label: 'Calculators', comingSoon: true },
  { to: '/workboard/comparisons', label: 'Comparisons', comingSoon: true },
  { to: '/workboard/ideas', label: 'Saved Ideas', comingSoon: true },
];

export function WorkboardLayout() {
  return (
    <div className="flex flex-col gap-6">
      <SubNav items={WORKBOARD_SUBNAV} />
      <Outlet />
    </div>
  );
}

// ─── Not-yet-built surfaces (own feature issues) ──────────────────────────────

/**
 * The dedicated watchlist view lands with the Workboard overview/watchlist split
 * (§7.3). Until then the working watchlist lives on the Workboard Overview.
 */
export function WatchlistPage() {
  return (
    <ComingSoon
      title="Watchlists"
      description="Named, multiple watchlists arrive here. For now your watchlist lives on the Workboard overview."
    />
  );
}

export function BacktestsPage() {
  return (
    <ComingSoon
      title="Backtests"
      description="Standalone backtesting across any basket of assets, beyond the conglomerate-embedded backtest."
    />
  );
}

export function CalculatorsPage() {
  return (
    <ComingSoon
      title="Calculators"
      description="Standalone invest calculators — turn a budget into an exact buy list without a saved conglomerate."
    />
  );
}

export function ComparisonsPage() {
  return (
    <ComingSoon
      title="Comparisons"
      description="Side-by-side comparison of assets and conglomerates on returns, risk and allocation."
    />
  );
}

export function SavedIdeasPage() {
  return (
    <ComingSoon
      title="Saved Ideas"
      description="Park draft baskets and investment ideas to revisit later."
    />
  );
}
