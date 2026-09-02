import { createRef, forwardRef, useImperativeHandle, useState } from 'react';
import type { ReactNode } from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { I18nProvider, LOCALES, localizedMessage } from '../../i18n';
import { setViewportWidth } from '../../test/viewport';

vi.mock('../AuthContext', () => {
  // Stable identities: `useResource` keys its effect on these callbacks, so a
  // fresh spy per render would re-fire every read forever.
  const session = {
    status: 'authenticated',
    user: { username: 'root', email: 'admin@bettertrack.test' },
    logout: vi.fn(),
    clearSession: vi.fn(),
    requireTwoFactorSetup: vi.fn(),
  };
  return {
    useAuth: () => session,
    isAdminTwoFactorSetupRequired: () => false,
  };
});
vi.mock('../../lib/adminApi');

import { ADMIN_DESTINATIONS } from '../adminWorkspaces';
import { AdminLayout } from './AdminLayout';
import { Modal } from './Modal';

// Every CHILD ROW the six-workspace sidebar still offers (#1406 W1). Three
// workspaces have since folded and contribute none: People (W2) and Operations
// (W4) carry their pages as tabs — see ADMIN_PEOPLE_TAB_KEYS and
// ADMIN_OPERATIONS_TAB_KEYS — and Support (W3) absorbed its one row into the
// helpdesk landing itself. What remains here is Product & Comms and
// Security & API, the two workspaces no package has folded.
const ADMIN_NAV_KEYS = [
  'admin.nav.settings',
  'admin.nav.featureFlags',
  'admin.nav.ai',
  'admin.nav.accountDefaults',
  'admin.nav.announcements',
  'admin.nav.audit',
  'admin.nav.security',
  'admin.nav.oauthApps',
  'admin.nav.apiKeys',
] as const;

const ADMIN_WORKSPACE_KEYS = [
  'admin.nav.sections.overview',
  'admin.nav.sections.support',
  'admin.nav.sections.people',
  'admin.nav.sections.operations',
  'admin.nav.sections.product',
  'admin.nav.sections.securityApi',
] as const;

/** The workspaces that own a landing route, so their label is also a link. */
const ADMIN_WORKSPACE_LANDING_KEYS = [
  'admin.nav.sections.overview',
  'admin.nav.sections.support',
  // People landed here in #1406 W2: it folded, so its label is the only rail
  // entry it has, and it links at the account list.
  'admin.nav.sections.people',
  // Operations folded the same way in W4, landing on the health-and-queues
  // cockpit.
  'admin.nav.sections.operations',
] as const;

/**
 * The People workspace's pages after the W2 fold. They are no longer sidebar
 * rows — the page's tab strip carries them — but they are still real routes, so
 * their labels must still translate and they must still be reachable.
 */
const ADMIN_PEOPLE_TAB_KEYS = [
  'admin.nav.users',
  'admin.nav.registration',
  'admin.nav.invites',
  'admin.nav.testAccounts',
] as const;

/**
 * The Operations workspace's pages after the W4 fold. Same contract as the
 * People tabs above: not sidebar rows any more, still real routes, so their
 * labels must still translate and they must still be reachable.
 */
const ADMIN_OPERATIONS_TAB_KEYS = [
  'admin.nav.opsHealth',
  'admin.nav.problems',
  'admin.nav.providers',
  'admin.nav.monitoring',
  'admin.nav.email',
  'admin.nav.usageAnalytics',
  'admin.nav.marketData',
] as const;

const ADMIN_SHELL_KEYS = [
  'admin.nav.console',
  'admin.nav.loading',
  'admin.nav.language',
  'admin.palette.trigger',
  'admin.palette.shortcut',
  ...ADMIN_WORKSPACE_KEYS,
  ...ADMIN_NAV_KEYS,
  ...ADMIN_PEOPLE_TAB_KEYS,
  ...ADMIN_OPERATIONS_TAB_KEYS,
] as const;

function Bomb(): never {
  throw new Error('kaboom');
}

function AdminTestApp({
  initialPath,
  initialLocale = 'en',
  invitesElement = <p>Invites page</p>,
  usersElement = <Bomb />,
}: {
  initialPath: string;
  initialLocale?: string;
  invitesElement?: ReactNode;
  usersElement?: ReactNode;
}) {
  return (
    <I18nProvider initialLocale={initialLocale}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route element={<AdminLayout />}>
            <Route path="/admin/users" element={usersElement} />
            <Route path="/admin/users/:userId" element={<p>User 360</p>} />
            <Route path="/admin/test-accounts" element={<p>Test accounts page</p>} />
            <Route path="/admin/registration" element={<p>Registration page</p>} />
            <Route path="/admin/invites" element={invitesElement} />
            <Route path="/admin/health" element={<p>Health page</p>} />
            {/* The rest of the Operations tabs, so the W4 fold's rail cue can
                be checked on every path the workspace owns. */}
            <Route path="/admin/problems" element={<p>Problems page</p>} />
            <Route path="/admin/providers" element={<p>Providers page</p>} />
            <Route path="/admin/monitoring" element={<p>Monitoring page</p>} />
            <Route path="/admin/email" element={<p>Email page</p>} />
            <Route path="/admin/usage-analytics" element={<p>Usage page</p>} />
            <Route path="/admin/market-data" element={<p>Market data page</p>} />
            {/* A narrow workspace, for the content-width test. */}
            <Route path="/admin/settings" element={<p>Settings page</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </I18nProvider>
  );
}

function renderAdmin(initialPath: string, initialLocale = 'en') {
  return render(<AdminTestApp initialPath={initialPath} initialLocale={initialLocale} />);
}

interface AdminOverlayPageHandle {
  closeModal: () => void;
  openModal: () => void;
}

const AdminOverlayPage = forwardRef<AdminOverlayPageHandle, { dismissable: boolean }>(
  function AdminOverlayPage({ dismissable }, ref) {
    const [modalOpen, setModalOpen] = useState(false);
    useImperativeHandle(
      ref,
      () => ({
        closeModal: () => setModalOpen(false),
        openModal: () => setModalOpen(true),
      }),
      [],
    );

    return (
      <>
        <p>Invites page</p>
        {modalOpen ? (
          <Modal
            dismissable={dismissable}
            onClose={() => setModalOpen(false)}
            title="Layered admin modal"
          >
            <button type="button">Modal action</button>
          </Modal>
        ) : null}
      </>
    );
  },
);

function stubDesktopBreakpoint() {
  let matches = false;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const list = {
    get matches() {
      return matches;
    },
    media: '(min-width: 48rem)',
    addEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    },
  } as MediaQueryList;
  const matchMedia = vi.fn(() => list);

  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: matchMedia,
  });

  return {
    enterDesktop() {
      matches = true;
      const event = { matches, media: list.media } as MediaQueryListEvent;
      for (const listener of listeners) listener(event);
    },
    matchMedia,
  };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: undefined,
  });
});

test('the admin shell starts with a hidden skip link that focuses main content', async () => {
  const user = userEvent.setup();
  const { container } = renderAdmin('/admin/invites');

  const skipLink = screen.getByRole('link', { name: 'Skip to main content' });
  const main = screen.getByRole('main');
  const firstFocusable = container.querySelector<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
  );

  expect(skipLink).toHaveAttribute('href', '#main-content');
  expect(skipLink).toHaveClass('sr-only');
  expect(main).toHaveAttribute('id', 'main-content');
  expect(firstFocusable).toBe(skipLink);

  await user.click(skipLink);
  expect(main).toHaveFocus();
});

test('a page that throws renders the error boundary fallback while the admin chrome survives', () => {
  renderAdmin('/admin/users');

  expect(screen.getByRole('alert')).toBeInTheDocument();
  expect(screen.getByText('Something went wrong.')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'People' })).toBeInTheDocument();
  expect(screen.getByText('admin@bettertrack.test')).toBeInTheDocument();
});

test('navigating to a different route clears a stuck error boundary', async () => {
  renderAdmin('/admin/users');

  expect(screen.getByRole('alert')).toBeInTheDocument();

  // W4 folded Operations: the rail row that reaches the health page is now
  // the workspace label, not a per-page child row.
  await userEvent.setup().click(screen.getByRole('link', { name: 'Operations' }));

  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByText('Health page')).toBeInTheDocument();
});

test('the admin nav is a vertical sidebar — no horizontal scroll, no wrap', () => {
  renderAdmin('/admin/health');

  const nav = screen.getByRole('navigation', { name: 'Admin console' });
  expect(nav.className).not.toContain('overflow-x-auto');
  expect(nav.className).not.toContain('flex-wrap');
  expect(nav.className).toContain('flex-col');

  // The sharp console's rail geometry (#1406 W2): a 34 px row carrying a 2 px
  // leading edge bar, coloured only while the row is the active one so
  // activating an item never nudges its label sideways.
  const active = screen.getByRole('link', { name: 'Operations' });
  expect(active.className).toContain('min-h-[34px]');
  expect(active.className).toContain('border-l-2');
  expect(active.className).toContain('border-l-sky-500');

  const idle = screen.getByRole('link', { name: 'People' });
  expect(idle.className).toContain('min-h-[34px]');
  expect(idle.className).toContain('border-l-transparent');
  expect(idle.className).not.toContain('border-l-sky-500');
});

// The regression the fold introduced and this pins shut: `NavLink end` marks
// People only on `/admin/users`, so three of its four tabs and the whole People
// 360 detail route left the rail with NOTHING highlighted. A fold that costs the
// "where am I" cue is not free.
test.each([
  ['/admin/registration'],
  ['/admin/invites'],
  ['/admin/test-accounts'],
  ['/admin/users/user-1'],
])('the folded People rail entry stays marked on %s', (path) => {
  render(<AdminTestApp initialPath={path} usersElement={<p>Users page</p>} />);

  const people = screen.getByRole('link', { name: 'People' });
  expect(people.className).toContain('border-l-sky-500');

  // Control: an unrelated workspace's row must NOT light up on the same path,
  // so "everything is active" cannot pass this test.
  expect(screen.getByRole('link', { name: 'Operations' }).className).toContain(
    'border-l-transparent',
  );
});

// W4 folds the second workspace, so the same cue must hold for it: every
// Operations tab has to leave the Operations rail entry marked, or the fold
// costs the "where am I" cue exactly as it would have for People.
test.each([
  ['/admin/problems'],
  ['/admin/providers'],
  ['/admin/monitoring'],
  ['/admin/email'],
  ['/admin/usage-analytics'],
  ['/admin/market-data'],
])('the folded Operations rail entry stays marked on %s', (path) => {
  render(<AdminTestApp initialPath={path} usersElement={<p>Users page</p>} />);

  const operations = screen.getByRole('link', { name: 'Operations' });
  expect(operations.className).toContain('border-l-sky-500');

  // Control: People must NOT light up on the same path, so "everything is
  // active" cannot pass this test.
  expect(screen.getByRole('link', { name: 'People' }).className).toContain('border-l-transparent');
});

test('a workspace that is not folded keeps exact-match highlighting', () => {
  render(<AdminTestApp initialPath="/admin/settings" usersElement={<p>Users page</p>} />);

  expect(screen.getByRole('link', { name: 'Settings' }).className).toContain('border-l-sky-500');
  expect(screen.getByRole('link', { name: 'People' }).className).toContain('border-l-transparent');
});

test('every admin shell key is available in every supported locale', () => {
  for (const locale of Object.values(LOCALES)) {
    for (const key of ADMIN_SHELL_KEYS) {
      expect(localizedMessage(locale.code, key)).not.toBe(key);
    }
  }
});

test.each(['en', 'de'] as const)('every navigation entry resolves through %s', (locale) => {
  renderAdmin('/admin/invites', locale);

  for (const key of ADMIN_NAV_KEYS) {
    expect(screen.getByRole('link', { name: localizedMessage(locale, key) })).toBeInTheDocument();
  }
  for (const key of ADMIN_WORKSPACE_KEYS) {
    expect(
      screen.getByRole('heading', { name: localizedMessage(locale, key) }),
    ).toBeInTheDocument();
  }
  // A workspace that owns a landing page is reachable, not just a caption.
  for (const key of ADMIN_WORKSPACE_LANDING_KEYS) {
    expect(screen.getByRole('link', { name: localizedMessage(locale, key) })).toBeInTheDocument();
  }
});

test('the sidebar offers the six operator workspaces in their decided order', () => {
  renderAdmin('/admin/invites');

  const nav = screen.getByRole('navigation', { name: 'Admin console' });
  const headings = within(nav)
    .getAllByRole('heading')
    .map((heading) => heading.textContent);

  expect(headings).toEqual([
    'Overview',
    'Support',
    'People',
    'Operations',
    'Product & Comms',
    'Security & API',
  ]);
});

test.each(['en', 'de'] as const)(
  'the folded People workspace is ONE rail link with no child rows in %s',
  (locale) => {
    renderAdmin('/admin/invites', locale);

    const nav = screen.getByRole('navigation', {
      name: localizedMessage(locale, 'admin.nav.console'),
    });

    // Exactly one People entry — `getByRole` throws on a second — and it opens
    // the workspace landing, the account list.
    const people = within(nav).getByRole('link', {
      name: localizedMessage(locale, 'admin.nav.sections.people'),
    });
    expect(people).toHaveAttribute('href', '/admin/users');

    // The workspace's own column holds that link and nothing else: the pages
    // that used to sit under it are the page's tab strip now.
    const column = people.closest('div')!;
    expect(within(column).getAllByRole('link')).toEqual([people]);

    // Control, same query: Operations has NOT folded (that is W7's package), so
    // its column still carries child rows. Without this, "one link in the
    // column" could just mean the query never sees child rows at all. Its label
    // is a heading rather than a link because that workspace has no landing
    // route of its own — only folded workspaces put a link on the label.
    const operations = within(nav).getByRole('heading', {
      name: localizedMessage(locale, 'admin.nav.sections.operations'),
    });
    expect(within(operations.closest('div')!).getAllByRole('link').length).toBeGreaterThan(1);

    for (const key of ADMIN_PEOPLE_TAB_KEYS) {
      expect(
        within(nav).queryByRole('link', { name: localizedMessage(locale, key) }),
      ).not.toBeInTheDocument();
    }
  },
);

test('the fold costs no reachability — every People tab is still a destination', () => {
  const paths = ADMIN_DESTINATIONS.map((destination) => destination.to);

  // The landing carries /admin/users; the two folded pages stay addressable in
  // their own right, so ⌘K can still reach what the rail stopped listing.
  expect(paths).toContain('/admin/users');
  expect(paths).toContain('/admin/registration');
  expect(paths).toContain('/admin/invites');
  // …and each is attributed to People, so the palette groups them correctly.
  for (const to of ['/admin/users', '/admin/registration', '/admin/invites']) {
    expect(ADMIN_DESTINATIONS.find((destination) => destination.to === to)?.workspaceKey).toBe(
      'people',
    );
  }
  // The coming-soon tab is deliberately NOT a destination: the palette
  // navigates, and navigating to a placeholder is noise.
  expect(paths).not.toContain('/admin/test-accounts');
});

test.each(['en', 'de'] as const)(
  'the folded People tabs are still reachable through ⌘K in %s',
  async (locale) => {
    const user = userEvent.setup();
    renderAdmin('/admin/invites', locale);

    await user.keyboard('{Meta>}k{/Meta}');
    const palette = await screen.findByRole('dialog', {
      name: localizedMessage(locale, 'admin.palette.title'),
    });

    // Anchored: a folded tab's row also carries "People" as its workspace meta,
    // so an unanchored needle would match three rows and prove nothing.
    for (const key of [
      'admin.nav.registration',
      'admin.nav.invites',
      // /admin/users rides in on the workspace label itself.
      'admin.nav.sections.people',
    ] as const) {
      expect(
        within(palette).getByRole('option', {
          name: new RegExp(`^${localizedMessage(locale, key)}`),
        }),
      ).toBeInTheDocument();
    }
  },
);

test('⌘K opens the command palette from anywhere in the console', async () => {
  const user = userEvent.setup();
  renderAdmin('/admin/invites');

  expect(screen.queryByRole('dialog', { name: 'Admin command palette' })).not.toBeInTheDocument();

  await user.keyboard('{Meta>}k{/Meta}');

  const palette = await screen.findByRole('dialog', { name: 'Admin command palette' });
  expect(within(palette).getByRole('combobox')).toHaveFocus();

  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog', { name: 'Admin command palette' })).not.toBeInTheDocument();
});

test('the sidebar trigger opens the same palette', async () => {
  const user = userEvent.setup();
  renderAdmin('/admin/invites');

  await user.click(screen.getAllByRole('button', { name: /Search or jump to/ })[0]!);

  expect(await screen.findByRole('dialog', { name: 'Admin command palette' })).toBeInTheDocument();
});

test('only the dense operator workspaces widen the content column', () => {
  const { container: wide } = renderAdmin('/admin/health');
  expect(wide.querySelector('main > div')?.className).toContain('max-w-7xl');

  // A folded workspace's TABS inherit the workspace's density (#1406 W2):
  // People is wide, so its Invites tab is wide too.
  const { container: foldedTab } = renderAdmin('/admin/invites');
  expect(foldedTab.querySelector('main > div')?.className).toContain('max-w-7xl');

  const { container: standard } = renderAdmin('/admin/settings');
  expect(standard.querySelector('main > div')?.className).toContain('max-w-5xl');
});

test('the compact language control re-renders the admin shell immediately', async () => {
  const user = userEvent.setup();
  renderAdmin('/admin/invites');

  const language = screen.getByRole('combobox', { name: 'Console language' });
  expect(language).toHaveValue('en');

  await user.selectOptions(language, 'de');

  expect(screen.getByRole('combobox', { name: 'Sprache der Konsole' })).toHaveValue('de');
  expect(screen.getByRole('navigation', { name: 'Admin-Konsole' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Produkt & Kommunikation' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Personen' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Abmelden' })).toBeInTheDocument();
});

test('the burger button opens an inert-background drawer and cleans up on Escape', async () => {
  setViewportWidth(390);
  const user = userEvent.setup();
  const previousOverflow = document.body.style.overflow;
  renderAdmin('/admin/invites');

  const burger = screen.getByRole('button', { name: 'Open admin menu' });
  const main = screen.getByRole('main');
  expect(burger).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('dialog', { name: 'Admin menu' })).not.toBeInTheDocument();

  await user.click(burger);

  const drawer = screen.getByRole('dialog', { name: 'Admin menu' });
  expect(drawer).toBeInTheDocument();
  expect(within(drawer).getByRole('button', { name: 'Close admin menu' })).toBeInTheDocument();
  expect(main).toHaveAttribute('inert');
  expect(burger.closest('[inert]')).not.toBeNull();
  expect(drawer.closest('[inert]')).toBeNull();
  expect(document.body.style.overflow).toBe('hidden');

  await user.keyboard('{Escape}');

  expect(screen.queryByRole('dialog', { name: 'Admin menu' })).not.toBeInTheDocument();
  expect(main).not.toHaveAttribute('inert');
  expect(burger.closest('[inert]')).toBeNull();
  expect(burger).toHaveFocus();
  expect(document.body.style.overflow).toBe(previousOverflow);
});

test('Escape closes an admin Modal above the drawer before closing the drawer', async () => {
  setViewportWidth(390);
  const user = userEvent.setup();
  const page = createRef<AdminOverlayPageHandle>();
  const previousOverflow = document.body.style.overflow;
  render(
    <AdminTestApp
      initialPath="/admin/invites"
      invitesElement={<AdminOverlayPage dismissable ref={page} />}
    />,
  );

  await user.click(screen.getByRole('button', { name: 'Open admin menu' }));
  act(() => page.current?.openModal());

  const modal = screen.getByRole('dialog', { name: 'Layered admin modal' });
  expect(modal).toBeInTheDocument();
  expect(screen.getByRole('dialog', { name: 'Admin menu' })).toBeInTheDocument();
  expect(screen.getByText('Invites page').closest('main')).not.toBeNull();
  expect(screen.getByRole('main')).toHaveAttribute('inert');
  expect(modal.closest('main')).toBeNull();
  expect(modal.closest('[inert]')).toBeNull();
  expect(screen.getByRole('button', { name: 'Modal action' })).toHaveFocus();

  await user.keyboard('{Escape}');

  await waitFor(() => {
    expect(screen.queryByRole('dialog', { name: 'Layered admin modal' })).not.toBeInTheDocument();
  });
  expect(screen.getByRole('dialog', { name: 'Admin menu' })).toBeInTheDocument();
  expect(document.body.style.overflow).toBe('hidden');

  await user.keyboard('{Escape}');

  expect(screen.queryByRole('dialog', { name: 'Admin menu' })).not.toBeInTheDocument();
  expect(document.body.style.overflow).toBe(previousOverflow);
});

test('a non-dismissable admin Modal consumes Escape without closing the drawer beneath it', async () => {
  setViewportWidth(390);
  const user = userEvent.setup();
  const page = createRef<AdminOverlayPageHandle>();
  render(
    <AdminTestApp
      initialPath="/admin/invites"
      invitesElement={<AdminOverlayPage dismissable={false} ref={page} />}
    />,
  );

  await user.click(screen.getByRole('button', { name: 'Open admin menu' }));
  act(() => page.current?.openModal());

  const modal = screen.getByRole('dialog', { name: 'Layered admin modal' });
  expect(screen.getByRole('main')).toHaveAttribute('inert');
  expect(modal.closest('[inert]')).toBeNull();
  expect(screen.getByRole('button', { name: 'Modal action' })).toHaveFocus();

  await user.keyboard('{Escape}');

  expect(screen.getByRole('dialog', { name: 'Layered admin modal' })).toBeInTheDocument();
  expect(screen.getByRole('dialog', { name: 'Admin menu' })).toBeInTheDocument();

  act(() => page.current?.closeModal());
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog', { name: 'Admin menu' })).not.toBeInTheDocument();
});

test('crossing into the desktop breakpoint closes the drawer, releases inert, and focuses main', async () => {
  setViewportWidth(767);
  const desktopBreakpoint = stubDesktopBreakpoint();
  const user = userEvent.setup();
  const { container } = renderAdmin('/admin/invites');

  const burger = screen.getByRole('button', { name: 'Open admin menu' });
  await user.click(burger);

  const main = screen.getByRole('main');
  const mobileHeader = burger.closest('header')!;
  const desktopSidebar = container.querySelector<HTMLElement>('aside')!;
  const drawer = screen.getByRole('dialog', { name: 'Admin menu' });
  expect(drawer).toBeInTheDocument();
  expect(drawer.contains(document.activeElement)).toBe(true);
  expect(main).toHaveAttribute('inert');
  expect(desktopSidebar).toHaveAttribute('inert');
  expect(desktopBreakpoint.matchMedia).toHaveBeenCalledWith('(min-width: 48rem)');

  act(() => {
    // Model the CSS breakpoint before matchMedia notifies React: the mobile
    // burger is already display:none while the desktop shell becomes visible.
    mobileHeader.style.display = 'none';
    desktopSidebar.style.display = 'block';
    desktopBreakpoint.enterDesktop();
  });

  await waitFor(() => {
    expect(screen.queryByRole('dialog', { name: 'Admin menu' })).not.toBeInTheDocument();
  });
  expect(main).not.toHaveAttribute('inert');
  expect(desktopSidebar).not.toHaveAttribute('inert');
  expect(main).toHaveFocus();
  expect(document.body).not.toHaveFocus();
});

test('crossing the desktop breakpoint beneath a Modal preserves its focus and scroll locks', async () => {
  setViewportWidth(767);
  const desktopBreakpoint = stubDesktopBreakpoint();
  const user = userEvent.setup();
  const page = createRef<AdminOverlayPageHandle>();
  const previousOverflow = document.body.style.overflow;
  const { container } = render(
    <AdminTestApp
      initialPath="/admin/invites"
      invitesElement={<AdminOverlayPage dismissable ref={page} />}
    />,
  );

  const burger = screen.getByRole('button', { name: 'Open admin menu' });
  await user.click(burger);
  act(() => page.current?.openModal());

  const modal = screen.getByRole('dialog', { name: 'Layered admin modal' });
  const modalAction = screen.getByRole('button', { name: 'Modal action' });
  const main = screen.getByRole('main');
  const mobileHeader = burger.closest('header')!;
  const desktopSidebar = container.querySelector<HTMLElement>('aside')!;
  expect(modalAction).toHaveFocus();
  expect(document.body.style.overflow).toBe('hidden');

  act(() => {
    mobileHeader.style.display = 'none';
    desktopSidebar.style.display = 'block';
    desktopBreakpoint.enterDesktop();
  });

  await waitFor(() => {
    expect(screen.queryByRole('dialog', { name: 'Admin menu' })).not.toBeInTheDocument();
  });
  expect(modal).toBeInTheDocument();
  expect(main).not.toHaveAttribute('inert');
  expect(modalAction).toHaveFocus();
  expect(document.body.style.overflow).toBe('hidden');

  await user.tab();
  expect(modalAction).toHaveFocus();

  act(() => page.current?.closeModal());
  await waitFor(() => {
    expect(screen.queryByRole('dialog', { name: 'Layered admin modal' })).not.toBeInTheDocument();
  });
  expect(document.body.style.overflow).toBe(previousOverflow);
  expect(main).toHaveFocus();
  expect(document.body).not.toHaveFocus();
});

test('navigating from inside the drawer closes it', async () => {
  setViewportWidth(390);
  const user = userEvent.setup();
  render(<AdminTestApp initialPath="/admin/invites" usersElement={<p>Users page</p>} />);

  await user.click(screen.getByRole('button', { name: 'Open admin menu' }));
  const drawer = screen.getByRole('dialog', { name: 'Admin menu' });

  // Click the folded "People" link inside the drawer (both drawer and desktop
  // sidebar render one; scope to the drawer so this exercises the drawer's own
  // link) — it must both navigate to the account list and retire the drawer.
  await user.click(within(drawer).getByRole('link', { name: 'People' }));

  expect(screen.queryByRole('dialog', { name: 'Admin menu' })).not.toBeInTheDocument();
  expect(screen.getByText('Users page')).toBeInTheDocument();
});
