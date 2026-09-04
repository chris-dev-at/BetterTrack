import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';

import { InstallPrompt } from './InstallPrompt';

/**
 * The affordance's whole contract (§7.1, V5-P13b): it appears only where an
 * install is actually possible, it is dismissible, the dismissal sticks, and an
 * installed app never sees it again.
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

function stubNavigator(patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    Object.defineProperty(navigator, key, { configurable: true, writable: true, value });
  }
}

const IOS_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15';

/** The Chromium event, in the shape the component actually reads. */
function fireBeforeInstallPrompt(): { prompt: ReturnType<typeof vi.fn> } {
  const prompt = vi.fn(() => Promise.resolve());
  const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), { prompt });
  window.dispatchEvent(event);
  return { prompt };
}

function renderPrompt() {
  return render(
    <I18nProvider initialLocale="en">
      <InstallPrompt />
    </I18nProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  stubMatchMedia([]);
});

afterEach(() => {
  localStorage.clear();
  Reflect.deleteProperty(window, 'matchMedia');
  Reflect.deleteProperty(window, 'onbeforeinstallprompt');
  for (const key of ['standalone', 'userAgent', 'maxTouchPoints']) {
    Reflect.deleteProperty(navigator, key);
  }
  vi.restoreAllMocks();
});

describe('InstallPrompt', () => {
  it('renders nothing until a browser offers an install path', () => {
    renderPrompt();
    expect(screen.queryByTestId('pwa-install-prompt')).not.toBeInTheDocument();
  });

  it('captures beforeinstallprompt and triggers the native prompt on user action', async () => {
    const user = userEvent.setup();
    renderPrompt();

    const { prompt } = fireBeforeInstallPrompt();
    expect(await screen.findByTestId('pwa-install-prompt')).toBeInTheDocument();
    expect(screen.getByText('Install BetterTrack')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Install' }));
    expect(prompt).toHaveBeenCalledTimes(1);
    // The native sheet owns the decision from here, so the card steps aside.
    expect(screen.queryByTestId('pwa-install-prompt')).not.toBeInTheDocument();
  });

  it('suppresses the browser mini-infobar so only one affordance is on screen', () => {
    renderPrompt();
    const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      prompt: vi.fn(() => Promise.resolve()),
    });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('dismisses on request, and the dismissal survives a remount', async () => {
    const user = userEvent.setup();
    const first = renderPrompt();
    fireBeforeInstallPrompt();
    await screen.findByTestId('pwa-install-prompt');

    await user.click(screen.getByTestId('pwa-install-dismiss'));
    expect(screen.queryByTestId('pwa-install-prompt')).not.toBeInTheDocument();
    first.unmount();

    // A reload is a remount plus a fresh event: the card must stay away.
    renderPrompt();
    fireBeforeInstallPrompt();
    expect(screen.queryByTestId('pwa-install-prompt')).not.toBeInTheDocument();
  });

  it('shows the Add-to-Home-Screen coach mark on iOS, where no event ever fires', async () => {
    stubNavigator({ userAgent: IOS_AGENT, standalone: false, maxTouchPoints: 5 });
    renderPrompt();

    expect(await screen.findByTestId('pwa-install-prompt')).toBeInTheDocument();
    expect(screen.getByText('Tap Share, then “Add to Home Screen”.')).toBeInTheDocument();
    // Nothing to call: iOS exposes no programmatic install.
    expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument();
  });

  it('stays away on iOS once the app already runs from the home screen', () => {
    stubNavigator({ userAgent: IOS_AGENT, standalone: true, maxTouchPoints: 5 });
    renderPrompt();
    expect(screen.queryByTestId('pwa-install-prompt')).not.toBeInTheDocument();
  });

  it('stays away in a standalone window even when the event fires', () => {
    stubMatchMedia(['(display-mode: standalone)']);
    renderPrompt();
    fireBeforeInstallPrompt();
    expect(screen.queryByTestId('pwa-install-prompt')).not.toBeInTheDocument();
  });

  it('hides permanently once the app reports itself installed', async () => {
    renderPrompt();
    fireBeforeInstallPrompt();
    await screen.findByTestId('pwa-install-prompt');

    window.dispatchEvent(new Event('appinstalled'));
    await waitFor(() => expect(screen.queryByTestId('pwa-install-prompt')).not.toBeInTheDocument());
    expect(localStorage.getItem('bt.pwa.install')).toBe('installed');
  });

  /**
   * ANTI-BLOAT (owner, binding). The card must never take space from the page
   * it floats over. This pins the class that carries the rule; that the class
   * is `position: fixed` is asserted against the stylesheet itself in
   * `styles/origin.test.ts`.
   */
  it('carries the out-of-flow class rather than occupying primary layout', async () => {
    renderPrompt();
    fireBeforeInstallPrompt();
    expect(await screen.findByTestId('pwa-install-prompt')).toHaveClass('bt-install-prompt');
  });
});
