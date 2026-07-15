import { Outlet } from 'react-router-dom';

import { useT } from '../../i18n';
import { ComingSoon } from '../../ui';
import { SubNav, type SubNavItem } from '../components/SubNav';

/**
 * Social section shell (PROJECTPLAN.md §6.9, §7.2, V3-P6/P8; #384, #438). Subnav
 * is Friends · My items · Messages: the friend graph (with each friend's shares,
 * activity toggles and the in-row follow controls, V4-P0b), the unified "My
 * items" sharing surface, and the DM chat (#349). The retired "Shared with me"
 * and "Following" tabs both folded into Friends; the public profile is managed
 * from a link on My items. `/social` redirects to `/social/friends`.
 */
export function SocialLayout() {
  const t = useT();
  const subnav: readonly SubNavItem[] = [
    { to: '/social/friends', label: t('social.nav.friends') },
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
  const t = useT();
  return <ComingSoon title={t('social.ideas.title')} description={t('social.ideas.description')} />;
}
