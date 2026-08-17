import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyTheme,
  bootTheme,
  readThemeSetting,
  resolveTheme,
  subscribeSystemTheme,
  systemTheme,
  THEME_CANVAS,
  THEME_STORAGE_KEY,
  writeThemeSetting,
} from './theme';

/**
 * jsdom ships no `matchMedia`, which is exactly the shape of "a platform with
 * no opinion" this module has to survive — so it is installed per test rather
 * than globally, and the tests that want it absent simply do not install it.
 */
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
    list,
    /** Fire a real OS-level preference change at every subscriber. */
    flip(next: boolean) {
      list.matches = next;
      for (const listener of listeners) listener({ matches: next } as MediaQueryListEvent);
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

function clearMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: undefined,
  });
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-bt-theme');
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((meta) => meta.remove());
});

afterEach(() => {
  clearMatchMedia();
});

describe('theme setting storage', () => {
  it('defaults to system when nothing is stored', () => {
    expect(readThemeSetting()).toBe('system');
  });

  it('round-trips an explicit pin', () => {
    writeThemeSetting('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(readThemeSetting()).toBe('light');

    writeThemeSetting('dark');
    expect(readThemeSetting()).toBe('dark');
  });

  /**
   * `system` is the ABSENCE of a pin, not a third stored string: writing it
   * removes the key, so a browser that later gains an OS preference is followed
   * rather than being held at whatever was true the day the user chose it.
   */
  it('stores system by removing the key', () => {
    writeThemeSetting('light');
    writeThemeSetting('system');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(readThemeSetting()).toBe('system');
  });

  it('treats a corrupt stored value as system', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'sepia');
    expect(readThemeSetting()).toBe('system');
  });

  /** Private mode throws on access; a themeless app still has to render. */
  it('falls back to system when storage throws', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });

    expect(readThemeSetting()).toBe('system');
    expect(() => writeThemeSetting('dark')).not.toThrow();

    getItem.mockRestore();
    setItem.mockRestore();
  });
});

describe('resolving system', () => {
  it('reads the platform preference', () => {
    stubPrefersLight(true);
    expect(systemTheme()).toBe('light');

    stubPrefersLight(false);
    expect(systemTheme()).toBe('dark');
  });

  /**
   * The app is dark-first, and both "no matchMedia" (jsdom, old browsers) and
   * "matchMedia that does not know the query" report the same thing. Asking the
   * LIGHT question means no-opinion lands on dark in both cases instead of
   * flipping the whole app to a theme nobody asked for.
   */
  it('falls back to dark where the platform cannot answer', () => {
    clearMatchMedia();
    expect(systemTheme()).toBe('dark');
  });

  it('survives a matchMedia that throws', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn(() => {
        throw new Error('nope');
      }),
    });
    expect(systemTheme()).toBe('dark');
  });

  it('honours a pin over the platform preference', () => {
    stubPrefersLight(true);
    expect(resolveTheme('system')).toBe('light');
    expect(resolveTheme('dark')).toBe('dark');
    expect(resolveTheme('light')).toBe('light');
  });
});

describe('applying a theme', () => {
  it('stamps the attribute the stylesheet keys off', () => {
    applyTheme('light');
    expect(document.documentElement.getAttribute('data-bt-theme')).toBe('light');

    applyTheme('dark');
    expect(document.documentElement.getAttribute('data-bt-theme')).toBe('dark');
  });

  /**
   * `index.html` ships a media-scoped `theme-color` pair as the no-JS fallback
   * and the UA uses the FIRST one whose media matches — so an explicit pin that
   * disagrees with the OS would otherwise paint the browser chrome in the other
   * theme. Writing every meta makes whichever one it picks correct.
   */
  it('repaints every theme-color meta, media-scoped ones included', () => {
    for (const media of [null, '(prefers-color-scheme: dark)', '(prefers-color-scheme: light)']) {
      const meta = document.createElement('meta');
      meta.name = 'theme-color';
      meta.content = '#000000';
      if (media) meta.setAttribute('media', media);
      document.head.append(meta);
    }

    applyTheme('light');
    const contents = [...document.head.querySelectorAll('meta[name="theme-color"]')].map((meta) =>
      meta.getAttribute('content'),
    );
    expect(contents).toEqual([THEME_CANVAS.light, THEME_CANVAS.light, THEME_CANVAS.light]);
  });

  it('boots the stored theme', () => {
    stubPrefersLight(false);
    writeThemeSetting('light');
    bootTheme();
    expect(document.documentElement.getAttribute('data-bt-theme')).toBe('light');
  });

  it('boots the platform theme when there is no pin', () => {
    stubPrefersLight(true);
    bootTheme();
    expect(document.documentElement.getAttribute('data-bt-theme')).toBe('light');
  });
});

describe('watching the platform preference', () => {
  it('notifies on a real OS change and unsubscribes cleanly', () => {
    const media = stubPrefersLight(false);
    const listener = vi.fn();

    const unsubscribe = subscribeSystemTheme(listener);
    expect(media.listenerCount).toBe(1);

    media.flip(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(systemTheme()).toBe('light');

    unsubscribe();
    expect(media.listenerCount).toBe(0);
    media.flip(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('is a no-op where matchMedia is absent', () => {
    clearMatchMedia();
    const unsubscribe = subscribeSystemTheme(vi.fn());
    expect(() => unsubscribe()).not.toThrow();
  });
});
