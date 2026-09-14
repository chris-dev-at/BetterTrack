import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { I18nProvider } from '../../i18n';

vi.mock('../vault/VaultRuntimeContext', () => ({
  useOptionalVaultRuntime: () => ({ lock: vi.fn() }),
}));

import { StandaloneBack } from './OriginShell';

/**
 * The topbar's own back button (§7.1, V5-P13b). An installed window has no
 * browser back at all on iOS, so this control is the only way back — and at
 * history index 0 there is nothing behind it, which is why it must not render
 * there at all.
 *
 * `BrowserRouter`, deliberately: the whole question is what the router writes
 * into `window.history.state`, and a `MemoryRouter` never touches it.
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
 * Boots at `/`, which immediately `<Navigate replace>`s to `/login` — the shape
 * of `RequireUser` and the first-run gate. That mints a FRESH `location.key`
 * while the history index stays at 0, which is exactly what a `key !== 'default'`
 * test reads as "there is something behind us".
 */
function renderBootRedirect() {
  window.history.replaceState(null, '', '/');
  return render(
    <I18nProvider initialLocale="en">
      <BrowserRouter>
        <StandaloneBack />
        <Routes>
          <Route element={<Navigate replace to="/login" />} path="/" />
          <Route element={<Link to="/portfolio">continue</Link>} path="/login" />
          <Route element={<p>portfolio</p>} path="/portfolio" />
        </Routes>
      </BrowserRouter>
    </I18nProvider>,
  );
}

const backButton = () => screen.queryByRole('button', { name: 'Back' });

beforeEach(() => {
  stubMatchMedia(['(display-mode: standalone)']);
});

afterEach(() => {
  Reflect.deleteProperty(window, 'matchMedia');
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
});

test('no back button on the entry the app booted on, even after a boot-time replace', async () => {
  renderBootRedirect();

  // The redirect has landed: a fresh location key, still history index 0.
  expect(await screen.findByText('continue')).toBeInTheDocument();
  expect(window.location.pathname).toBe('/login');
  expect((window.history.state as { idx?: number } | null)?.idx).toBe(0);
  // A control whose navigate(-1) has nothing to go back to would either do
  // nothing or walk the user out of the app — in a chromeless window, on the
  // very first screen.
  expect(backButton()).toBeNull();
});

test('the back button appears after a real in-app navigation, and goes back', async () => {
  const user = userEvent.setup();
  renderBootRedirect();

  await user.click(await screen.findByText('continue'));
  expect(await screen.findByText('portfolio')).toBeInTheDocument();

  const back = backButton();
  expect(back).not.toBeNull();

  await user.click(back!);
  await waitFor(() => expect(screen.getByText('continue')).toBeInTheDocument());
  // Back at the boot entry, so the affordance retires again.
  await waitFor(() => expect(backButton()).toBeNull());
});

test('an ordinary browser tab never grows one — it has its own', async () => {
  stubMatchMedia([]);
  const user = userEvent.setup();
  renderBootRedirect();

  await user.click(await screen.findByText('continue'));
  expect(await screen.findByText('portfolio')).toBeInTheDocument();
  expect(backButton()).toBeNull();
});
