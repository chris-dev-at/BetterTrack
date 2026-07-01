import { Outlet } from 'react-router-dom';

import { ComingSoon } from '../../ui';
import { SubNav, type SubNavItem } from '../components/SubNav';

/**
 * Social section shell (PROJECTPLAN.md §6.9, §7.2). Subnav: Friends · Shared
 * With Me · My Shared Items, plus the Coming-Soon pages (Ideas · My Public
 * Profile). `/social` redirects to `/social/friends`.
 */
const SOCIAL_SUBNAV: readonly SubNavItem[] = [
  { to: '/social/friends', label: 'Friends' },
  { to: '/social/shared-with-me', label: 'Shared With Me' },
  { to: '/social/my-shared', label: 'My Shared Items' },
  { to: '/social/ideas', label: 'Ideas', comingSoon: true },
  { to: '/social/profile', label: 'My Public Profile', comingSoon: true },
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

export function FriendsPage() {
  return (
    <ComingSoon
      title="Friends"
      description="Send friend requests by username or email, accept or decline incoming ones, and manage your friends list."
      icon="🫂"
    />
  );
}

export function SharedWithMePage() {
  return (
    <ComingSoon
      title="Shared With Me"
      description="Read-only portfolios your friends have shared with you."
    />
  );
}

export function MySharedItemsPage() {
  return (
    <ComingSoon
      title="My Shared Items"
      description="Everything you're currently sharing with friends, with a quick toggle to stop sharing."
    />
  );
}

export function SocialIdeasPage() {
  return (
    <ComingSoon
      title="Ideas"
      description="A lightweight feed of investment ideas shared between friends."
    />
  );
}

export function PublicProfilePage() {
  return (
    <ComingSoon
      title="My Public Profile"
      description="An optional public page others can view and follow."
    />
  );
}
