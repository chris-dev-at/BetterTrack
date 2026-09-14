import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import { DISPLAY_MODE_ATTRIBUTE } from '../../lib/pwaDisplayMode';

vi.mock('../AuthContext', () => {
  const session = {
    status: 'authenticated',
    user: { username: 'root', email: 'admin@bettertrack.test' },
    logout: vi.fn(),
    clearSession: vi.fn(),
    requireTwoFactorSetup: vi.fn(),
  };
  return { useAuth: () => session, isAdminTwoFactorSetupRequired: () => false };
});
vi.mock('../../lib/adminApi');

import { AdminLayout, AdminStandaloneBack } from './AdminLayout';

/**
 * The console's standalone-window handling (§7.1, V5-P13b, #1891).
 *
 * `index.html` is served to BOTH origins, so the console inherits
 * `apple-mobile-web-app-capable` and installs from an iPhone with no manifest at
 * all — while every piece of standalone handling lived in the user app: the
 * display-mode stamp, the status-bar compensation it keys, and the shell's own
 * back button. Installed, the console's burger sat under the translucent status
 * bar and a drill-down was a one-way trip.
 *
 * `BrowserRouter`, deliberately: the whole question for the back button is what
 * the router writes into `window.history.state`, and a `MemoryRouter` never
 * touches it.
 */

function stubMatchMedia(matching: readonly string[]): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: matching.includes(query),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
}

/**
 * Boots at `/admin`, which immediately `<Navigate replace>`s — the shape of
 * every boot-time redirect. That mints a FRESH `location.key` while the history
 * index stays at 0, which is exactly what a `key !== 'default'` test would
 * misread as "there is something behind us".
 */
function renderBootRedirect() {
  window.history.replaceState(null, '', '/admin');
  return render(
    <I18nProvider initialLocale="en">
      <BrowserRouter>
        <AdminStandaloneBack />
        <Routes>
          <Route element={<Navigate replace to="/admin/users" />} path="/admin" />
          <Route element={<Link to="/admin/problems">continue</Link>} path="/admin/users" />
          <Route element={<p>problems</p>} path="/admin/problems" />
        </Routes>
      </BrowserRouter>
    </I18nProvider>,
  );
}

function renderConsoleShell(path = '/admin/users') {
  window.history.replaceState(null, '', path);
  return render(
    <I18nProvider initialLocale="en">
      <BrowserRouter>
        <Routes>
          <Route element={<AdminLayout />}>
            <Route element={<p>Users page</p>} path="/admin/users" />
          </Route>
        </Routes>
      </BrowserRouter>
    </I18nProvider>,
  );
}

const backButton = () => screen.queryByTestId('admin-standalone-back');

beforeEach(() => {
  stubMatchMedia(['(display-mode: standalone)']);
});

afterEach(() => {
  Reflect.deleteProperty(window, 'matchMedia');
  document.documentElement.removeAttribute(DISPLAY_MODE_ATTRIBUTE);
  window.history.replaceState(null, '', '/admin');
  vi.restoreAllMocks();
});

test('stamps the display mode on the admin origin, so the console CSS can see it', async () => {
  renderConsoleShell();

  await waitFor(() =>
    expect(document.documentElement.getAttribute(DISPLAY_MODE_ATTRIBUTE)).toBe('standalone'),
  );
});

test('leaves the attribute off in an ordinary console tab', async () => {
  stubMatchMedia([]);
  renderConsoleShell();

  expect(await screen.findByText('Users page')).toBeInTheDocument();
  expect(document.documentElement.hasAttribute(DISPLAY_MODE_ATTRIBUTE)).toBe(false);
});

test('no back button on the entry the console booted on, even after a boot-time replace', async () => {
  renderBootRedirect();

  expect(await screen.findByText('continue')).toBeInTheDocument();
  expect(window.location.pathname).toBe('/admin/users');
  expect((window.history.state as { idx?: number } | null)?.idx).toBe(0);
  // At index 0 `navigate(-1)` either does nothing or walks the operator out of
  // the app — in a window with no address bar and, on iOS, no back button.
  expect(backButton()).not.toBeInTheDocument();
});

test('renders the back affordance once the console has somewhere to go back to', async () => {
  const user = userEvent.setup();
  renderBootRedirect();

  await user.click(await screen.findByText('continue'));

  expect(await screen.findByText('problems')).toBeInTheDocument();
  const back = backButton();
  expect(back).toBeInTheDocument();
  expect(back).toHaveAttribute('aria-label', 'Back');

  await user.click(back!);
  expect(await screen.findByText('continue')).toBeInTheDocument();
});

test('renders no back affordance in an ordinary console tab, where the browser has one', async () => {
  stubMatchMedia([]);
  const user = userEvent.setup();
  renderBootRedirect();

  await user.click(await screen.findByText('continue'));

  expect(await screen.findByText('problems')).toBeInTheDocument();
  expect(backButton()).not.toBeInTheDocument();
});

test('hangs the back affordance in the mobile top bar, ahead of the burger', async () => {
  const user = userEvent.setup();
  window.history.replaceState(null, '', '/admin/users');
  render(
    <I18nProvider initialLocale="en">
      <BrowserRouter>
        <Routes>
          <Route element={<AdminLayout />}>
            <Route element={<Link to="/admin/problems">to problems</Link>} path="/admin/users" />
            <Route element={<p>Problems page</p>} path="/admin/problems" />
          </Route>
        </Routes>
      </BrowserRouter>
    </I18nProvider>,
  );

  // A real router navigation, because the history index the affordance reads is
  // written by the router itself — a hand-rolled `pushState` writes no index.
  await user.click(await screen.findByText('to problems'));
  expect(await screen.findByText('Problems page')).toBeInTheDocument();

  const back = await screen.findByTestId('admin-standalone-back');
  const topbar = document.getElementById('admin-topbar');
  expect(topbar, 'the console must still name its mobile top bar').not.toBeNull();
  expect(topbar!.contains(back)).toBe(true);
  // The burger is the only way into console navigation below 768px, so the back
  // button takes the leading slot rather than pushing it along the bar.
  expect(topbar!.firstElementChild).toBe(back);
});
