import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, test } from 'vitest';

import { SubNav, type SubNavItem } from './SubNav';

// The Settings subnav is the widest (seven entries) — the case that used to
// wrap into several rows at phone widths before the responsive pass.
const ITEMS: readonly SubNavItem[] = [
  { to: '/settings/account', label: 'Account' },
  { to: '/settings/notifications', label: 'Notifications' },
  { to: '/settings/security', label: 'Security' },
  { to: '/settings/imports', label: 'Imports & Exports', comingSoon: true },
  { to: '/settings/connections', label: 'Connections', comingSoon: true },
  { to: '/settings/backups', label: 'Backups', comingSoon: true },
  { to: '/settings/api', label: 'API Access', comingSoon: true },
];

function renderNav() {
  return render(
    <MemoryRouter initialEntries={['/settings/account']}>
      <SubNav items={ITEMS} />
    </MemoryRouter>,
  );
}

test('every item renders as a resolvable tab link', () => {
  renderNav();
  for (const item of ITEMS) {
    expect(screen.getByRole('link', { name: new RegExp(item.label) })).toHaveAttribute(
      'href',
      item.to,
    );
  }
});

test('preserveParams carries the named search param across tab links (V3-P0 #322)', () => {
  const items: readonly SubNavItem[] = [
    { to: '/portfolio', label: 'Overview', end: true },
    { to: '/portfolio/transactions', label: 'Transactions' },
    { to: '/portfolio/custom-assets', label: 'Custom Assets' },
  ];
  render(
    <MemoryRouter initialEntries={['/portfolio?portfolio=pf-2&stray=x']}>
      <SubNav items={items} preserveParams={['portfolio']} />
    </MemoryRouter>,
  );
  // Every tab keeps the active portfolio in its href, so navigating to
  // Transactions / Custom Assets no longer drops the selection to the default.
  expect(screen.getByRole('link', { name: 'Transactions' })).toHaveAttribute(
    'href',
    '/portfolio/transactions?portfolio=pf-2',
  );
  expect(screen.getByRole('link', { name: 'Custom Assets' })).toHaveAttribute(
    'href',
    '/portfolio/custom-assets?portfolio=pf-2',
  );
  // Only the named key travels — unrelated params never leak between sections.
  expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute(
    'href',
    '/portfolio?portfolio=pf-2',
  );
});

test('the strip scrolls horizontally instead of wrapping at narrow widths', () => {
  renderNav();
  const nav = screen.getByRole('navigation', { name: 'Section' });
  // Horizontal scroll + hidden scrollbar, and crucially NOT flex-wrap — so many
  // tabs stay on one swipeable line rather than stacking into rows.
  expect(nav.className).toContain('overflow-x-auto');
  expect(nav.className).toContain('no-scrollbar');
  expect(nav.className).not.toContain('flex-wrap');
});

test('tabs keep their label on one line with a ≥40px tap target', () => {
  renderNav();
  const tab = screen.getByRole('link', { name: 'Account' });
  expect(tab.className).toContain('whitespace-nowrap');
  expect(tab.className).toContain('min-h-[40px]');
  // flex-none keeps each tab at its natural width so it can scroll off-screen
  // rather than being squeezed to illegibility.
  expect(tab.className).toContain('flex-none');
});
