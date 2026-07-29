import { Outlet } from 'react-router-dom';

import { useT } from '../../i18n';
import { LocalNav, type LocalNavItem } from '../components/LocalNav';

/**
 * People destination (PRODUCT_BLUEPRINT.md §4): who works with the data —
 * friends and follows, chat, shared items and the public profile; Teams and
 * Approvals are parked collaboration surfaces.
 */
export function PeopleLayout() {
  const t = useT();

  const items: LocalNavItem[] = [
    { to: '/people', label: t('people.tabs.friends'), end: true },
    { to: '/people/chat', label: t('people.tabs.chat') },
    { to: '/people/shared', label: t('people.tabs.shared') },
    { to: '/people/profile', label: t('people.tabs.profile') },
    { to: '/people/teams', label: t('people.tabs.teams'), parked: true },
    { to: '/people/approvals', label: t('people.tabs.approvals'), parked: true },
  ];

  return (
    <div>
      <LocalNav ariaLabel={t('people.aria')} items={items} />
      <Outlet />
    </div>
  );
}
