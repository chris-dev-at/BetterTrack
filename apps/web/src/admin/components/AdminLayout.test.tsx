import { createRef, forwardRef, useImperativeHandle, useState } from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { I18nProvider, LOCALES, localizedMessage } from '../../i18n';
import { setViewportWidth } from '../../test/viewport';

vi.mock('../AuthContext', () => ({
  useAuth: () => ({
    status: 'authenticated',
    user: { username: 'root', email: 'admin@bettertrack.test' },
    logout: vi.fn(),
  }),
}));

import { AdminLayout } from './AdminLayout';
import { Modal } from './Modal';

const ADMIN_NAV_KEYS = [
  'admin.nav.users',
  'admin.nav.invites',
  'admin.nav.settings',
  'admin.nav.featureFlags',
  'admin.nav.ai',
  'admin.nav.accountDefaults',
  'admin.nav.announcements',
  'admin.nav.oauthApps',
  'admin.nav.apiKeys',
  'admin.nav.health',
  'admin.nav.problems',
  'admin.nav.monitoring',
  'admin.nav.usageAnalytics',
  'admin.nav.email',
  'admin.nav.audit',
  'admin.nav.security',
] as const;

const ADMIN_SHELL_KEYS = [
  'admin.nav.console',
  'admin.nav.loading',
  'admin.nav.language',
  'admin.nav.sections.people',
  'admin.nav.sections.configuration',
  'admin.nav.sections.diagnostics',
  ...ADMIN_NAV_KEYS,
] as const;

function Bomb(): never {
  throw new Error('kaboom');
}

function AdminTestApp({
  initialPath,
  initialLocale = 'en',
}: {
  initialPath: string;
  initialLocale?: string;
}) {
  return (
    <I18nProvider initialLocale={initialLocale}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route element={<AdminLayout />}>
            <Route path="/admin/users" element={<Bomb />} />
            <Route path="/admin/invites" element={<p>Invites page</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </I18nProvider>
  );
}

function renderAdmin(initialPath: string, initialLocale = 'en') {
  return render(<AdminTestApp initialPath={initialPath} initialLocale={initialLocale} />);
}

interface AdminOverlayFixtureHandle {
  closeModal: () => void;
  openModal: () => void;
}

const AdminOverlayFixture = forwardRef<AdminOverlayFixtureHandle, { dismissable: boolean }>(
  function AdminOverlayFixture({ dismissable }, ref) {
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
        <AdminTestApp initialPath="/admin/invites" />
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
  expect(screen.getByRole('link', { name: 'Invites' })).toBeInTheDocument();
  expect(screen.getByText('admin@bettertrack.test')).toBeInTheDocument();
});

test('navigating to a different route clears a stuck error boundary', async () => {
  renderAdmin('/admin/users');

  expect(screen.getByRole('alert')).toBeInTheDocument();

  await userEvent.setup().click(screen.getByRole('link', { name: 'Invites' }));

  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByText('Invites page')).toBeInTheDocument();
});

test('the admin nav is a vertical sidebar — no horizontal scroll, no wrap', () => {
  renderAdmin('/admin/invites');

  const nav = screen.getByRole('navigation', { name: 'Admin console' });
  expect(nav.className).not.toContain('overflow-x-auto');
  expect(nav.className).not.toContain('flex-wrap');
  expect(nav.className).toContain('flex-col');

  const link = screen.getByRole('link', { name: 'Invites' });
  expect(link.className).toContain('min-h-[40px]');
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
  for (const key of [
    'admin.nav.sections.people',
    'admin.nav.sections.configuration',
    'admin.nav.sections.diagnostics',
  ]) {
    expect(
      screen.getByRole('heading', { name: localizedMessage(locale, key) }),
    ).toBeInTheDocument();
  }
});

test('the compact language control re-renders the admin shell immediately', async () => {
  const user = userEvent.setup();
  renderAdmin('/admin/invites');

  const language = screen.getByRole('combobox', { name: 'Console language' });
  expect(language).toHaveValue('en');

  await user.selectOptions(language, 'de');

  expect(screen.getByRole('combobox', { name: 'Sprache der Konsole' })).toHaveValue('de');
  expect(screen.getByRole('navigation', { name: 'Admin-Konsole' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Konfiguration' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Nutzer' })).toBeInTheDocument();
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
  const fixture = createRef<AdminOverlayFixtureHandle>();
  const previousOverflow = document.body.style.overflow;
  render(<AdminOverlayFixture dismissable ref={fixture} />);

  await user.click(screen.getByRole('button', { name: 'Open admin menu' }));
  act(() => fixture.current?.openModal());

  expect(screen.getByRole('dialog', { name: 'Layered admin modal' })).toBeInTheDocument();
  expect(screen.getByRole('dialog', { name: 'Admin menu' })).toBeInTheDocument();

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
  const fixture = createRef<AdminOverlayFixtureHandle>();
  render(<AdminOverlayFixture dismissable={false} ref={fixture} />);

  await user.click(screen.getByRole('button', { name: 'Open admin menu' }));
  act(() => fixture.current?.openModal());

  await user.keyboard('{Escape}');

  expect(screen.getByRole('dialog', { name: 'Layered admin modal' })).toBeInTheDocument();
  expect(screen.getByRole('dialog', { name: 'Admin menu' })).toBeInTheDocument();

  act(() => fixture.current?.closeModal());
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

test('navigating from inside the drawer closes it', async () => {
  setViewportWidth(390);
  const user = userEvent.setup();
  renderAdmin('/admin/invites');

  await user.click(screen.getByRole('button', { name: 'Open admin menu' }));
  const drawer = screen.getByRole('dialog', { name: 'Admin menu' });

  // Click the "Users" link inside the drawer (both drawer and desktop sidebar
  // render one; scope to the drawer so this exercises the drawer's own link).
  await user.click(within(drawer).getByRole('link', { name: 'Users' }));

  expect(screen.queryByRole('dialog', { name: 'Admin menu' })).not.toBeInTheDocument();
});
