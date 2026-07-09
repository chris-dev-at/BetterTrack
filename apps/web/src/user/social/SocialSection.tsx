import { Outlet } from 'react-router-dom';

import { useT } from '../../i18n';
import { ComingSoon } from '../../ui';
import { SubNav, type SubNavItem } from '../components/SubNav';

/**
 * Social section shell (PROJECTPLAN.md §6.9, §7.2, V3-P6). Subnav: Friends ·
 * Shared With Me · My Shared Items · My Public Profile (now live), plus the
 * Coming-Soon Ideas page. `/social` redirects to `/social/friends`.
 */
const SOCIAL_SUBNAV: readonly SubNavItem[] = [
  { to: '/social/friends', label: 'Friends' },
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

/**
 * The chat destination (issue #349). The friend cards + friend overview link here
 * already; until #349 ships it renders a calm placeholder rather than a dead link,
 * so the chat entry points are present but gracefully inert.
 */
export function ChatPlaceholderPage() {
  const t = useT();
  return <ComingSoon title={t('social.chat.title')} description={t('social.chat.body')} />;
}
