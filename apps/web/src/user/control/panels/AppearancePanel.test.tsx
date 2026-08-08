import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { I18nProvider } from '../../../i18n';
import { bootTheme, THEME_STORAGE_KEY } from '../../theme';
import { __resetThemeStoreForTests, useThemeWatcher } from '../../useTheme';
import { AppearancePanel } from './AppearancePanel';

/**
 * The Appearance panel is the only place the theme is user-visible, so this
 * suite covers the three things a theme control can get wrong: reporting a
 * state it is not in, forgetting a choice on reload, and treating "System" as a
 * starting value rather than a standing instruction.
 */

/** jsdom has no `matchMedia`; the OS preference is driven through this stub. */
function stubPrefersLight(matches: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const list = {
    matches,
    media: '(prefers-color-scheme: light)',
    addEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    },
  };
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn(() => list),
  });
  return {
    flip(next: boolean) {
      list.matches = next;
      for (const listener of listeners) listener({ matches: next } as MediaQueryListEvent);
    },
  };
}

function renderPanel() {
  return render(
    <I18nProvider>
      <AppearancePanel />
    </I18nProvider>,
  );
}

/**
 * The panel plus the watcher the app root mounts beside it (`UserApp`). The
 * two are separate in production — the panel is throwaway, the subscription is
 * not — so the reaction to an OS flip is only real when both are present.
 */
function ThemeWatcherHost() {
  useThemeWatcher();
  return <AppearancePanel />;
}

const themeOption = (name: RegExp) => screen.getByRole('button', { name });
const rootTheme = () => document.documentElement.getAttribute('data-bt-theme');

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-bt-theme');
  stubPrefersLight(false);
  __resetThemeStoreForTests();
});

afterEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: undefined,
  });
});

describe('Appearance — theme control', () => {
  test('offers exactly three states and starts on System', () => {
    renderPanel();

    const group = screen.getByRole('group', { name: 'Theme' });
    const options = within(group).getAllByRole('button');
    expect(options.map((option) => option.textContent)).toEqual(['System (Dark)', 'Dark', 'Light']);
    expect(options[0]).toHaveAttribute('aria-pressed', 'true');
  });

  test('names what System currently resolves to', () => {
    stubPrefersLight(true);
    __resetThemeStoreForTests();
    renderPanel();

    expect(themeOption(/^System \(Light\)$/)).toHaveAttribute('aria-pressed', 'true');
  });

  test('pins Light: stamps the root, persists, and moves the pressed state', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(themeOption(/^Light$/));

    expect(rootTheme()).toBe('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(themeOption(/^Light$/)).toHaveAttribute('aria-pressed', 'true');
    expect(themeOption(/^Dark$/)).toHaveAttribute('aria-pressed', 'false');
  });

  test('pins Dark even while the OS asks for light', async () => {
    stubPrefersLight(true);
    __resetThemeStoreForTests();
    const user = userEvent.setup();
    renderPanel();

    await user.click(themeOption(/^Dark$/));

    expect(rootTheme()).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  /**
   * `system` is stored as the ABSENCE of a pin, so returning to it has to clear
   * the key — otherwise the next boot reads a stale pin and the app stops
   * following the OS forever.
   */
  test('returning to System clears the pin and re-follows the OS', async () => {
    stubPrefersLight(true);
    __resetThemeStoreForTests();
    const user = userEvent.setup();
    renderPanel();

    await user.click(themeOption(/^Dark$/));
    expect(rootTheme()).toBe('dark');

    await user.click(themeOption(/^System/));

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(rootTheme()).toBe('light');
  });

  test('restores a stored pin on a fresh mount', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    __resetThemeStoreForTests();
    renderPanel();

    expect(themeOption(/^Light$/)).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('Appearance — reacting to the system', () => {
  /**
   * The watcher lives on the app root, so the reaction is exercised through the
   * same module store the panel reads. A machine that goes light at sunrise
   * must repaint without a reload.
   */
  test('repaints when the OS preference flips while on System', () => {
    const media = stubPrefersLight(false);
    __resetThemeStoreForTests();
    // The app boot stamps the root before React mounts; the watcher's job is
    // only what happens AFTER that, so model the boot rather than assert that
    // rendering a panel paints the document.
    bootTheme();
    render(
      <I18nProvider>
        <ThemeWatcherHost />
      </I18nProvider>,
    );
    expect(rootTheme()).toBe('dark');

    act(() => media.flip(true));

    expect(rootTheme()).toBe('light');
    expect(themeOption(/^System \(Light\)$/)).toHaveAttribute('aria-pressed', 'true');
  });

  test('ignores an OS flip while a pin is in force', async () => {
    const media = stubPrefersLight(false);
    __resetThemeStoreForTests();
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <ThemeWatcherHost />
      </I18nProvider>,
    );

    await user.click(themeOption(/^Dark$/));
    act(() => media.flip(true));

    expect(rootTheme()).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });
});

describe('Appearance — interface scale', () => {
  /** Moved here from Account: both rows answer "which screen is this?". */
  test('keeps the interface-size row on this panel', () => {
    renderPanel();
    expect(screen.getByRole('combobox', { name: 'Interface size' })).toBeInTheDocument();
  });
});
