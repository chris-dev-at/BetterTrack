import { Outlet } from 'react-router-dom';

import { ComingSoon } from '../../ui';
import { SubNav, type SubNavItem } from '../components/SubNav';

/**
 * Social section shell (PROJECTPLAN.md §6.9, §7.2, V3-P6/P8; #384). Subnav is
 * exactly Friends · My items · Messages: the friend graph (with each friend's
 * shares + activity toggles), the unified "My items" sharing surface, and the DM
 * chat (#349). The retired "Shared with me" tab folded into Friends; the public
 * profile is managed from a link on My items. `/social` redirects to
 * `/social/friends`.
 */
const SOCIAL_SUBNAV: readonly SubNavItem[] = [
  { to: '/social/friends', label: 'Friends' },
  { to: '/social/my-shared', label: 'My items' },
  { to: '/social/chat', label: 'Messages' },
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
