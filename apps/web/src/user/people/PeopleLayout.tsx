import { Suspense } from 'react';
import { Outlet } from 'react-router-dom';

import { useT } from '../../i18n';
import { LocalNav } from '../components/LocalNav';
import { SECTION_NAV, useSectionNavItems } from '../components/sectionNav';

/**
 * People destination (PRODUCT_BLUEPRINT.md §4): who works with the data —
 * friends and follows, chat, shared items and the public profile; Teams and
 * Approvals are parked collaboration surfaces.
 *
 * Tab set: `components/sectionNav.ts` (shared with the rail's People group).
 */
export function PeopleLayout() {
  const t = useT();
  const items = useSectionNavItems('people');

  return (
    <div className="bt-phone-surface bt-people-layout">
      <LocalNav ariaLabel={t(SECTION_NAV.people.ariaLabelKey)} items={items} />
      <Suspense fallback={null}>
        <Outlet />
      </Suspense>
    </div>
  );
}
