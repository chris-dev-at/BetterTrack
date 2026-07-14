import { Outlet } from 'react-router-dom';

import { useT } from '../../i18n';
import { ComingSoon } from '../../ui';
import { SubNav, type SubNavItem } from '../components/SubNav';

/**
 * Social section shell (PROJECTPLAN.md §6.9, §7.2, V3-P6/P8; #384, #438). Subnav
 * is Friends · Following · My items · Messages: the friend graph (with each
 * friend's shares + activity toggles), the people the caller follows (#438), the
 * unified "My items" sharing surface, and the DM chat (#349). The retired "Shared
 * with me" tab folded into Friends; the public profile is managed from a link on
 * My items. `/social` redirects to `/social/friends`.
 */
export function SocialLayout() {
  const t = useT();
  const subnav: readonly SubNavItem[] = [
    { to: '/social/friends', label: t('social.nav.friends') },
    { to: '/social/following', label: t('social.nav.following') },
    { to: '/social/my-shared', label: t('social.nav.myItems') },
    { to: '/social/chat', label: t('social.nav.messages') },
  ];
  return (
    <div className="flex flex-col gap-6">
      <SubNav items={subnav} />
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
