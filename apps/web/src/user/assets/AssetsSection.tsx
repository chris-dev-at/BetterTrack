import { Outlet } from 'react-router-dom';

import { ComingSoon } from '../../ui';
import { SubNav, type SubNavItem } from '../components/SubNav';

/**
 * Assets section shell (PROJECTPLAN.md §6.3, §7.2). Subnav: Overview · Search,
 * plus the Coming-Soon category browsers
 * (Stocks · ETFs · Crypto · Commodities · Custom Assets).
 */
const ASSETS_SUBNAV: readonly SubNavItem[] = [
  { to: '/assets', label: 'Overview', end: true },
  { to: '/assets/search', label: 'Search' },
  { to: '/assets/stocks', label: 'Stocks', comingSoon: true },
  { to: '/assets/etfs', label: 'ETFs', comingSoon: true },
  { to: '/assets/crypto', label: 'Crypto', comingSoon: true },
  { to: '/assets/commodities', label: 'Commodities', comingSoon: true },
  { to: '/assets/custom', label: 'Custom Assets', comingSoon: true },
];

export function AssetsLayout() {
  return (
    <div className="flex flex-col gap-6">
      <SubNav items={ASSETS_SUBNAV} />
      <Outlet />
    </div>
  );
}

// ─── Not-yet-built surfaces (own feature issues) ──────────────────────────────

export function AssetsOverviewPage() {
  return (
    <ComingSoon
      title="Assets Overview"
      description="A calm entry point — search, recently viewed assets and catalog counts. Use Search to look up any asset today."
      icon="🔍"
    />
  );
}

export function StocksPage() {
  return <ComingSoon title="Stocks" description="Browse and filter the stock catalog." />;
}

export function EtfsPage() {
  return <ComingSoon title="ETFs" description="Browse and filter the ETF catalog." />;
}

export function CryptoPage() {
  return <ComingSoon title="Crypto" description="Browse and filter the crypto catalog." />;
}

export function CommoditiesPage() {
  return (
    <ComingSoon title="Commodities" description="Browse and filter the commodities catalog." />
  );
}

export function CustomAssetsBrowsePage() {
  return (
    <ComingSoon
      title="Custom Assets"
      description="Browse the custom assets you've created across your portfolios."
    />
  );
}
