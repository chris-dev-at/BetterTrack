import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, test } from 'vitest';

import { I18nProvider } from '../../i18n';
import { ADMIN_DESTINATIONS, ADMIN_WORKSPACES } from '../adminWorkspaces';
import { WorkspaceTabs } from './WorkspaceTabs';

function renderStrip(path: string, counts?: Record<string, number>, locale: 'en' | 'de' = 'en') {
  return render(
    <I18nProvider initialLocale={locale}>
      <MemoryRouter initialEntries={[path]}>
        <WorkspaceTabs {...(counts ? { counts } : {})} />
      </MemoryRouter>
    </I18nProvider>,
  );
}

const people = ADMIN_WORKSPACES.find((workspace) => workspace.key === 'people');
const operations = ADMIN_WORKSPACES.find((workspace) => workspace.key === 'operations');

test('the People workspace is folded, and it declares its tabs', () => {
  expect(people?.tabs?.map((tab) => tab.to)).toEqual([
    '/admin/users',
    '/admin/registration',
    '/admin/invites',
    '/admin/test-accounts',
  ]);
  // Folding means the rail stops listing the child pages.
  expect(people?.pages).toEqual([]);
});

// W4 folds the SECOND workspace. Every path Operations owned before the fold is
// still one of its tabs, which is what makes the fold cost no bookmark.
test('the Operations workspace is folded, and every pre-fold path survives as a tab', () => {
  expect(operations?.tabs?.map((tab) => tab.to)).toEqual([
    '/admin/health',
    '/admin/problems',
    '/admin/providers',
    '/admin/monitoring',
    '/admin/email',
    '/admin/usage-analytics',
    '/admin/market-data',
  ]);
  expect(operations?.pages).toEqual([]);
  // The W1 page rows this workspace used to list, none of them lost.
  for (const path of [
    '/admin/health',
    '/admin/problems',
    '/admin/monitoring',
    '/admin/email',
    '/admin/usage-analytics',
  ]) {
    expect(operations?.tabs?.some((tab) => tab.to === path)).toBe(true);
  }
});

// W7 stays cut: only the two workspaces their own packages folded are folded.
test('no workspace beyond People and Operations is folded', () => {
  for (const workspace of ADMIN_WORKSPACES) {
    if (workspace.key === 'people' || workspace.key === 'operations') continue;
    expect(workspace.tabs).toBeUndefined();
  }
});

test('folding costs no reachability: every real tab stays a ⌘K destination', () => {
  const destinations = new Set(ADMIN_DESTINATIONS.map((destination) => destination.to));
  for (const tab of [...(people?.tabs ?? []), ...(operations?.tabs ?? [])]) {
    if (tab.comingSoon) continue;
    expect(destinations).toContain(tab.to);
  }
  // A placeholder is deliberately NOT a palette destination — jumping to a page
  // that only says "not built yet" is noise in a navigation palette.
  expect(destinations).not.toContain('/admin/test-accounts');
  expect(destinations).not.toContain('/admin/market-data');
});

// The strip navigates between ROUTES. Announcing it as an ARIA tablist would
// promise in-page content switching and then move the whole page instead, so it
// is a nav of links and the current one is marked `aria-current="page"`.
test('renders as navigation links, not as an ARIA tablist', () => {
  renderStrip('/admin/registration');

  const nav = screen.getByRole('navigation', { name: 'People' });
  expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  expect(screen.queryAllByRole('tab')).toHaveLength(0);

  const links = within(nav).getAllByRole('link');
  expect(links.map((link) => link.getAttribute('href'))).toEqual([
    '/admin/users',
    '/admin/registration',
    '/admin/invites',
    '/admin/test-accounts',
  ]);
  expect(within(nav).getByRole('link', { name: /Registration/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
  expect(within(nav).getByRole('link', { name: /Invites/ })).not.toHaveAttribute('aria-current');
});

test('shows a count per tab when the page has one, and nothing when it does not', () => {
  renderStrip('/admin/users', { '/admin/users': 47, '/admin/registration': 3 });

  expect(screen.getByRole('link', { name: 'Users 47' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Registration 3' })).toBeInTheDocument();
  // No count supplied for Invites: the tab renders bare rather than as a zero,
  // so an unread count can never be faked by a failed stats read.
  expect(screen.getByRole('link', { name: 'Invites' })).toBeInTheDocument();
});

test('the unshipped tab wears a "soon" chip instead of a fake count', () => {
  renderStrip('/admin/users', { '/admin/users': 47 });

  const placeholder = screen.getByRole('link', { name: /Test accounts/ });
  expect(placeholder).toHaveAccessibleName('Test accounts Soon');
  expect(placeholder).toHaveAttribute('title', 'Planned — the factory itself is a later package.');
});

test('renders nothing on a path no folded workspace owns', () => {
  const { container } = renderStrip('/admin/audit');
  expect(container).toBeEmptyDOMElement();
});

test('is localized', () => {
  renderStrip('/admin/users', undefined, 'de');

  expect(screen.getByRole('navigation', { name: 'Personen' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Registrierung' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Testkonten/ })).toHaveAccessibleName('Testkonten Bald');
});
