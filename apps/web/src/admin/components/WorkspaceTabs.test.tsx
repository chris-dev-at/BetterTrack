import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, test } from 'vitest';

import { I18nProvider } from '../../i18n';
import { ADMIN_DESTINATIONS, ADMIN_WORKSPACES, isWideAdminPath } from '../adminWorkspaces';
import { TAP_TARGET } from './tokens';
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
const product = ADMIN_WORKSPACES.find((workspace) => workspace.key === 'product');
const security = ADMIN_WORKSPACES.find((workspace) => workspace.key === 'security');

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

// W7c folds the last two (§16 2026-09-14). This assertion is the one that
// pinned the CUT — "no workspace beyond People and Operations is folded" — and
// it is UPDATED, not deleted: the inventory stays pinned, only its expected
// value changed. A seventh workspace that quietly declares `tabs` still has to
// come through here, and so does one that quietly drops them.
test('exactly four workspaces are folded, and the two childless ones are not', () => {
  const folded = ADMIN_WORKSPACES.filter((workspace) => workspace.tabs !== undefined).map(
    (workspace) => workspace.key,
  );
  expect(folded).toEqual(['people', 'operations', 'product', 'security']);

  // Overview and Support are single-destination workspaces: they have no child
  // pages to fold, which is a different thing from an unfolded workspace. They
  // declare no `tabs` AND no `pages`, so neither shape can drift into them
  // unnoticed.
  for (const key of ['overview', 'support']) {
    const workspace = ADMIN_WORKSPACES.find((entry) => entry.key === key);
    expect(workspace?.tabs, key).toBeUndefined();
    expect(workspace?.pages, key).toEqual([]);
  }

  // One navigation shape across the console: nothing lists child rows any more.
  for (const workspace of ADMIN_WORKSPACES) {
    expect(workspace.pages, workspace.key).toEqual([]);
  }
});

// The third fold. Every path Product & Comms listed as a W1 page row is still
// one of its tabs, in the order the rail listed them — that is what makes the
// fold cost no bookmark and no muscle memory.
test('the Product & Comms workspace is folded, and every pre-fold path survives as a tab', () => {
  expect(product?.tabs?.map((tab) => tab.to)).toEqual([
    '/admin/settings',
    '/admin/feature-flags',
    '/admin/ai',
    '/admin/account-defaults',
    '/admin/announcements',
  ]);
  expect(product?.pages).toEqual([]);
  // The landing W7b gave it is the first tab, not a seventh destination.
  expect(product?.to).toBe('/admin/settings');
  // The W1 page rows, none of them lost — named individually so a dropped page
  // fails by name rather than as an array diff.
  for (const path of [
    '/admin/settings',
    '/admin/feature-flags',
    '/admin/ai',
    '/admin/account-defaults',
    '/admin/announcements',
  ]) {
    expect(
      product?.tabs?.some((tab) => tab.to === path),
      path,
    ).toBe(true);
  }
  // Every tab reuses the page row's OWN catalog key: the fold renames nothing,
  // so no new i18n key was needed for the strip.
  expect(product?.tabs?.map((tab) => tab.labelKey)).toEqual([
    'admin.nav.settings',
    'admin.nav.featureFlags',
    'admin.nav.ai',
    'admin.nav.accountDefaults',
    'admin.nav.announcements',
  ]);
  // All five pages are real and shipped — no placeholder tab in this fold.
  expect(product?.tabs?.some((tab) => tab.comingSoon)).toBe(false);
});

test('the Security & API workspace is folded, and every pre-fold path survives as a tab', () => {
  expect(security?.tabs?.map((tab) => tab.to)).toEqual([
    '/admin/audit',
    '/admin/security',
    '/admin/oauth-apps',
    '/admin/api-keys',
  ]);
  expect(security?.pages).toEqual([]);
  expect(security?.to).toBe('/admin/audit');
  for (const path of ['/admin/audit', '/admin/security', '/admin/oauth-apps', '/admin/api-keys']) {
    expect(
      security?.tabs?.some((tab) => tab.to === path),
      path,
    ).toBe(true);
  }
  expect(security?.tabs?.map((tab) => tab.labelKey)).toEqual([
    'admin.nav.audit',
    'admin.nav.security',
    'admin.nav.oauthApps',
    'admin.nav.apiKeys',
  ]);
  expect(security?.tabs?.some((tab) => tab.comingSoon)).toBe(false);
});

/**
 * Folding must not re-flow a page. `isWideAdminPath` applies to a workspace's
 * landing AND every tab it owns, so a stray `wide: true` on either of the two
 * newly folded workspaces would silently move all nine pages out of the default
 * `max-w-5xl` reading column into the dense one.
 */
test('the newly folded workspaces are not wide, so no page silently re-flows', () => {
  expect(product?.wide).toBeUndefined();
  expect(security?.wide).toBeUndefined();
  for (const tab of [...(product?.tabs ?? []), ...(security?.tabs ?? [])]) {
    expect(isWideAdminPath(tab.to), tab.to).toBe(false);
  }
});

test('folding costs no reachability: every real tab stays a ⌘K destination', () => {
  const destinations = new Set(ADMIN_DESTINATIONS.map((destination) => destination.to));
  for (const workspace of ADMIN_WORKSPACES) {
    for (const tab of workspace.tabs ?? []) {
      if (tab.comingSoon) continue;
      expect(destinations, tab.to).toContain(tab.to);
    }
  }
  // A placeholder is deliberately NOT a palette destination — jumping to a page
  // that only says "not built yet" is noise in a navigation palette.
  expect(destinations).not.toContain('/admin/test-accounts');
  expect(destinations).not.toContain('/admin/market-data');
});

/**
 * The reachability regression the fold would otherwise introduce (#1406 W7c).
 *
 * A folded workspace's LANDING route is emitted once, and before this it took
 * the workspace's label — so `/admin/users` was "People", `/admin/health` was
 * "Health & queues", and folding the other two would have made `/admin/settings`
 * "Product & Comms" and `/admin/audit` "Security & API". A ⌘K query for the
 * page's own name would then have stopped matching it: a reachability cost the
 * fold's contract says it must not have.
 *
 * The row now carries the PAGE name as its label and the workspace name in
 * `matchKeys`, so one route stays one row and both queries find it.
 */
test('a landing route keeps its own page name, and answers to the workspace name too', () => {
  for (const [to, labelKey, workspaceLabelKey] of [
    ['/admin/users', 'admin.nav.users', 'admin.nav.sections.people'],
    ['/admin/health', 'admin.nav.opsHealth', 'admin.nav.sections.operations'],
    ['/admin/settings', 'admin.nav.settings', 'admin.nav.sections.product'],
    ['/admin/audit', 'admin.nav.audit', 'admin.nav.sections.securityApi'],
  ] as const) {
    const rows = ADMIN_DESTINATIONS.filter((destination) => destination.to === to);
    // One route, one row: two rows for `/admin/settings` is the kind of noise a
    // palette dies of.
    expect(rows, to).toHaveLength(1);
    expect(rows[0]!.labelKey, to).toBe(labelKey);
    expect(rows[0]!.matchKeys, to).toEqual([workspaceLabelKey]);
  }

  // Overview and Support fold nothing, so their landing is the workspace itself
  // and there is no second name to carry.
  for (const to of ['/admin', '/admin/support']) {
    const row = ADMIN_DESTINATIONS.find((destination) => destination.to === to);
    expect(row?.matchKeys, to).toBeUndefined();
  }

  // No duplicate anywhere in the registry, not just on the four landings.
  const paths = ADMIN_DESTINATIONS.map((destination) => destination.to);
  expect(paths).toHaveLength(new Set(paths).size);
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

// The example path had to MOVE for W7c: `/admin/audit` was the path no folded
// workspace owned, and it is now the Security & API landing tab — the test would
// have started asserting the opposite of what it means. Overview owns `/admin`
// and folds nothing, so it is the honest example now.
test('renders nothing on a path no folded workspace owns', () => {
  const { container } = renderStrip('/admin');
  expect(container).toBeEmptyDOMElement();
  // Control: the path that used to be the example DOES render a strip now, so
  // "renders nothing" cannot pass by the component being broken outright.
  expect(renderStrip('/admin/audit').container).not.toBeEmptyDOMElement();
});

test('is localized', () => {
  renderStrip('/admin/users', undefined, 'de');

  expect(screen.getByRole('navigation', { name: 'Personen' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Registrierung' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Testkonten/ })).toHaveAccessibleName('Testkonten Bald');
});

/**
 * The strip itself on the two newly folded workspaces (#1406 W7c). Same
 * contract as People above: a `nav` of LINKS, never an ARIA tablist, with the
 * current route marked `aria-current="page"` — announcing "tab 2 of 5" and then
 * navigating the whole page away is a promise the control does not keep.
 */
test('the Product & Comms strip is a five-link nav, not a tablist', () => {
  renderStrip('/admin/ai');

  const nav = screen.getByRole('navigation', { name: 'Product & Comms' });
  expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  expect(screen.queryAllByRole('tab')).toHaveLength(0);

  const links = within(nav).getAllByRole('link');
  expect(links.map((link) => link.getAttribute('href'))).toEqual([
    '/admin/settings',
    '/admin/feature-flags',
    '/admin/ai',
    '/admin/account-defaults',
    '/admin/announcements',
  ]);
  expect(within(nav).getByRole('link', { name: 'AI' })).toHaveAttribute('aria-current', 'page');
  expect(within(nav).getByRole('link', { name: 'Settings' })).not.toHaveAttribute('aria-current');
});

test('the Security & API strip is a four-link nav, not a tablist', () => {
  renderStrip('/admin/api-keys');

  const nav = screen.getByRole('navigation', { name: 'Security & API' });
  expect(screen.queryByRole('tablist')).not.toBeInTheDocument();

  const links = within(nav).getAllByRole('link');
  expect(links.map((link) => link.getAttribute('href'))).toEqual([
    '/admin/audit',
    '/admin/security',
    '/admin/oauth-apps',
    '/admin/api-keys',
  ]);
  expect(within(nav).getByRole('link', { name: 'API keys' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

// Every one of the nine newly folded paths renders ITS OWN workspace's strip —
// asserted per path, so a page that silently stopped owning a tab (or that was
// dropped from the registry) fails by name rather than by an array diff.
test.each([
  ['/admin/settings', 'Product & Comms'],
  ['/admin/feature-flags', 'Product & Comms'],
  ['/admin/ai', 'Product & Comms'],
  ['/admin/account-defaults', 'Product & Comms'],
  ['/admin/announcements', 'Product & Comms'],
  ['/admin/audit', 'Security & API'],
  ['/admin/security', 'Security & API'],
  ['/admin/oauth-apps', 'Security & API'],
  ['/admin/api-keys', 'Security & API'],
])('%s renders the %s strip with itself marked current', (path, workspace) => {
  renderStrip(path);

  const nav = screen.getByRole('navigation', { name: workspace });
  const current = within(nav)
    .getAllByRole('link')
    .filter((link) => link.hasAttribute('aria-current'));
  expect(current).toHaveLength(1);
  expect(current[0]).toHaveAttribute('href', path);
});

/**
 * The phone tap-target floor's OPT-IN (§13.5 V5-P13b, #1756). The strip adds up
 * to five navigation links to nine pages that had none, and
 * `ADMIN_TAP_TARGET_SELECTORS` in `e2e/mobile-overflow.spec.ts` finds them by
 * the `admin-tap-target` marker alone — a cell that stops carrying it is not
 * measured rather than measured and failed, which is the silent half of the
 * failure. jsdom applies no CSS, so what a component test can prove is that
 * every cell opts in; the rendered 44 px is measured for real by the gate at
 * 390×844 and 360×800.
 */
test('every strip cell carries the marker the phone gate measures', () => {
  renderStrip('/admin/settings');

  const links = within(screen.getByRole('navigation', { name: 'Product & Comms' })).getAllByRole(
    'link',
  );
  expect(links).toHaveLength(5);
  for (const link of links) {
    expect(link.className, link.getAttribute('href') ?? '').toContain(TAP_TARGET);
  }
});

test('the newly folded strips are localized too', () => {
  renderStrip('/admin/oauth-apps', undefined, 'de');

  expect(screen.getByRole('navigation', { name: 'Sicherheit & API' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Audit-Protokoll' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'OAuth-Apps' })).toHaveAttribute('aria-current', 'page');
});
