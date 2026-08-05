import { Suspense } from 'react';
import { Outlet } from 'react-router-dom';

import { useT } from '../../i18n';
import { LocalNav } from '../components/LocalNav';
import { SECTION_NAV, useSectionNavItems } from '../components/sectionNav';

/**
 * Assets destination (PRODUCT_BLUEPRINT.md §4): research the ingredients —
 * search, watchlists, news; Discover, Events and the Screener are parked.
 * Asset detail pages render below this layout at `/assets/:id`.
 *
 * Tab set: `components/sectionNav.ts` (shared with the rail's Assets group).
 */
export function AssetsWorkspace() {
  const t = useT();
  const items = useSectionNavItems('assets');

  return (
    <div className="bt-phone-surface bt-assets-workspace">
      <LocalNav ariaLabel={t(SECTION_NAV.assets.ariaLabelKey)} items={items} />
      <Suspense fallback={null}>
        <Outlet />
      </Suspense>
    </div>
  );
}
