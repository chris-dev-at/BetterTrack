import { Suspense } from 'react';
import { Outlet } from 'react-router-dom';

import { useT } from '../../i18n';
import { Skeleton } from '../../ui';
import { LocalNav } from '../components/LocalNav';
import { SECTION_NAV, useSectionNavItems } from '../components/sectionNav';

/**
 * Workbench (PRODUCT_BLUEPRINT.md §4): the possibility space — everything here
 * is a draft or a tool until explicitly applied to a portfolio. Blueprints are
 * the renamed Conglomerates; Studio is the parked visual scenario builder.
 *
 * Tab set: `components/sectionNav.ts` (shared with the rail's Workbench group).
 */
export function WorkbenchLayout() {
  const t = useT();
  const items = useSectionNavItems('workbench');

  return (
    <div className="bt-phone-surface bt-family-workspace bt-workbench-workspace">
      <LocalNav ariaLabel={t(SECTION_NAV.workbench.ariaLabelKey)} items={items} />
      {/* Skeleton, not `null` (§7.1): the layout and its LocalNav stay put and
          only the page area waits, so a cold page still says it is loading. */}
      <Suspense fallback={<Skeleton className="rounded-md" height="h-64" />}>
        <Outlet />
      </Suspense>
    </div>
  );
}
