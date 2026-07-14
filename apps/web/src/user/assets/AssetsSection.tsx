import { Outlet } from 'react-router-dom';

import { useT } from '../../i18n';
import { ComingSoon } from '../../ui';
import { SubNav, type SubNavItem } from '../components/SubNav';

/**
 * Assets section shell (PROJECTPLAN.md §6.3, §7.2). Subnav: Overview · Search,
 * plus the Coming-Soon category browsers
 * (Stocks · ETFs · Crypto · Commodities · Custom Assets).
 */
export function AssetsLayout() {
  const t = useT();
  const subnav: readonly SubNavItem[] = [
    { to: '/assets', label: t('assets.nav.overview'), end: true },
    { to: '/assets/search', label: t('assets.nav.search') },
    { to: '/assets/stocks', label: t('assets.nav.stocks'), comingSoon: true },
    { to: '/assets/etfs', label: t('assets.nav.etfs'), comingSoon: true },
    { to: '/assets/crypto', label: t('assets.nav.crypto'), comingSoon: true },
    { to: '/assets/commodities', label: t('assets.nav.commodities'), comingSoon: true },
    { to: '/assets/custom', label: t('assets.nav.customAssets'), comingSoon: true },
  ];
  return (
    <div className="flex flex-col gap-6">
      <SubNav items={subnav} />
      <Outlet />
    </div>
  );
}

// ─── Not-yet-built surfaces (own feature issues) ──────────────────────────────

export function AssetsOverviewPage() {
  const t = useT();
  return (
    <ComingSoon
      title={t('assets.comingSoon.overview.title')}
      description={t('assets.comingSoon.overview.description')}
      icon="🔍"
    />
  );
}

export function StocksPage() {
  const t = useT();
  return (
    <ComingSoon title={t('assets.nav.stocks')} description={t('assets.comingSoon.stocks')} />
  );
}

export function EtfsPage() {
  const t = useT();
  return <ComingSoon title={t('assets.nav.etfs')} description={t('assets.comingSoon.etfs')} />;
}

export function CryptoPage() {
  const t = useT();
  return <ComingSoon title={t('assets.nav.crypto')} description={t('assets.comingSoon.crypto')} />;
}

export function CommoditiesPage() {
  const t = useT();
  return (
    <ComingSoon
      title={t('assets.nav.commodities')}
      description={t('assets.comingSoon.commodities')}
    />
  );
}

export function CustomAssetsBrowsePage() {
  const t = useT();
  return (
    <ComingSoon
      title={t('assets.nav.customAssets')}
      description={t('assets.comingSoon.customAssets')}
    />
  );
}
