import { Outlet } from 'react-router-dom';

import { ComingSoon } from '../../ui';
import { SubNav, type SubNavItem } from '../components/SubNav';

/**
 * Social section shell (PROJECTPLAN.md §6.9, §7.2, V3-P6/P8). Subnav: Friends ·
 * Messages · Shared With Me · My Shared Items · My Public Profile (all live),
 * plus the Coming-Soon Ideas page. `/social` redirects to `/social/friends`.
 */
const SOCIAL_SUBNAV: readonly SubNavItem[] = [
  { to: '/social/friends', label: 'Friends' },
  { to: '/social/chat', label: 'Messages' },
  { to: '/social/shared-with-me', label: 'Shared With Me' },
  { to: '/social/my-shared', label: 'My Shared Items' },
  { to: '/social/profile', label: 'My Public Profile' },
  { to: '/social/ideas', label: 'Ideas', comingSoon: true },
];

export function SocialLayout() {
  return (
    <div className="flex flex-col gap-6">
      <SubNav items={SOCIAL_SUBNAV} />
      <Outlet />
    </div>
  );
}

// ─── Not-yet-built surfaces (own feature issues) ──────────────────────────────

export function SocialIdeasPage() {
  return (
    <ComingSoon
      title="Ideas"
      description="A lightweight feed of investment ideas shared between friends."
    />
  );
}
