import { Outlet } from 'react-router-dom';

import { useT } from '../../i18n';
import { LocalNav, type LocalNavItem } from '../components/LocalNav';

/**
 * Assets destination (PRODUCT_BLUEPRINT.md §4): research the ingredients —
 * search, watchlists, news; Discover, Events and the Screener are parked.
 * Asset detail pages render below this layout at `/assets/:id`.
 */
export function AssetsWorkspace() {
  const t = useT();

  const items: LocalNavItem[] = [
    { to: '/assets', label: t('assets.tabs.overview'), end: true },
    { to: '/assets/search', label: t('assets.tabs.search') },
    { to: '/assets/watchlists', label: t('assets.tabs.watchlists') },
    { to: '/assets/news', label: t('assets.tabs.news') },
    { to: '/assets/discover', label: t('assets.tabs.discover'), parked: true },
    { to: '/assets/events', label: t('assets.tabs.events'), parked: true },
    { to: '/assets/screener', label: t('assets.tabs.screener'), parked: true },
  ];

  return (
    <div>
      <LocalNav ariaLabel={t('assets.aria')} items={items} />
      <Outlet />
    </div>
  );
}
