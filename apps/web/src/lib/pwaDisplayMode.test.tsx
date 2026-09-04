import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DISPLAY_MODE_ATTRIBUTE,
  applyDisplayModeAttribute,
  isInstalledDisplay,
  isStandaloneDisplay,
  standaloneEscapeHref,
  subscribeDisplayMode,
  supportsHomeScreenCoachMark,
  useStandaloneExternalLinks,
} from './pwaDisplayMode';

/**
 * jsdom 26 ships no `matchMedia`, so every case installs the one it needs and
 * removes it again — which also exercises the capability guard the module
 * carries for exactly that environment.
 */
function stubMatchMedia(matching: readonly string[]): Array<{ query: string; listeners: number }> {
  const lists: Array<{ query: string; listeners: number }> = [];
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => {
      const entry = { query, listeners: 0 };
      lists.push(entry);
      return {
        matches: matching.includes(query),
        media: query,
        addEventListener: () => {
          entry.listeners += 1;
        },
        removeEventListener: () => {
          entry.listeners -= 1;
        },
      };
    },
  });
  return lists;
}

function stubNavigator(patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    Object.defineProperty(navigator, key, { configurable: true, writable: true, value });
  }
}

afterEach(() => {
  Reflect.deleteProperty(window, 'matchMedia');
  Reflect.deleteProperty(window, 'onbeforeinstallprompt');
  for (const key of ['standalone', 'userAgent', 'maxTouchPoints']) {
    Reflect.deleteProperty(navigator, key);
  }
  document.documentElement.removeAttribute(DISPLAY_MODE_ATTRIBUTE);
  vi.restoreAllMocks();
});

describe('display-mode detection', () => {
  it('reads a chromeless window as standalone, and an ordinary tab as not', () => {
    stubMatchMedia(['(display-mode: standalone)']);
    expect(isStandaloneDisplay()).toBe(true);
    expect(isInstalledDisplay()).toBe(true);

    stubMatchMedia([]);
    expect(isStandaloneDisplay()).toBe(false);
    expect(isInstalledDisplay()).toBe(false);
  });

  it('counts minimal-ui as installed but NOT as chromeless', () => {
    // It keeps a back/reload affordance, so the shell must not grow its own —
    // but it is an installed window, so nothing may offer to install it again.
    stubMatchMedia(['(display-mode: minimal-ui)']);
    expect(isStandaloneDisplay()).toBe(false);
    expect(isInstalledDisplay()).toBe(true);
  });

  it('honours navigator.standalone, the only signal iOS below 16.4 gives', () => {
    stubMatchMedia([]);
    stubNavigator({ standalone: true });
    expect(isStandaloneDisplay()).toBe(true);
    expect(isInstalledDisplay()).toBe(true);
  });

  it('reports an ordinary tab when the environment has no matchMedia at all', () => {
    expect(window.matchMedia).toBeUndefined();
    expect(isStandaloneDisplay()).toBe(false);
    expect(subscribeDisplayMode(() => {})).toBeTypeOf('function');
  });

  it('subscribes to every display-mode query and unsubscribes from all of them', () => {
    const lists = stubMatchMedia([]);
    const unsubscribe = subscribeDisplayMode(() => {});
    expect(lists.map((entry) => entry.query)).toEqual([
      '(display-mode: standalone)',
      '(display-mode: fullscreen)',
      '(display-mode: minimal-ui)',
    ]);
    expect(lists.every((entry) => entry.listeners === 1)).toBe(true);

    unsubscribe();
    expect(lists.every((entry) => entry.listeners === 0)).toBe(true);
  });

  it('stamps and clears the root attribute the standalone CSS block reads', () => {
    applyDisplayModeAttribute(true);
    expect(document.documentElement.getAttribute(DISPLAY_MODE_ATTRIBUTE)).toBe('standalone');
    applyDisplayModeAttribute(false);
    expect(document.documentElement.hasAttribute(DISPLAY_MODE_ATTRIBUTE)).toBe(false);
  });
});

describe('home-screen coach mark support', () => {
  it('is offered on iOS WebKit, where beforeinstallprompt never fires', () => {
    stubNavigator({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15',
      standalone: false,
      maxTouchPoints: 5,
    });
    expect(supportsHomeScreenCoachMark()).toBe(true);
  });

  it('is offered on an iPadOS device masquerading as a Macintosh', () => {
    stubNavigator({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
      standalone: false,
      maxTouchPoints: 5,
    });
    expect(supportsHomeScreenCoachMark()).toBe(true);
  });

  it('is withheld on a desktop Mac and on any browser that will prompt for itself', () => {
    stubNavigator({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
      standalone: false,
      maxTouchPoints: 0,
    });
    expect(supportsHomeScreenCoachMark()).toBe(false);

    // Chromium: instructions would be wrong, it fires the real event.
    Object.defineProperty(window, 'onbeforeinstallprompt', {
      configurable: true,
      writable: true,
      value: null,
    });
    stubNavigator({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15',
      standalone: false,
      maxTouchPoints: 5,
    });
    expect(supportsHomeScreenCoachMark()).toBe(false);
  });
});

describe('standalone external-link escape', () => {
  function anchor(html: string): HTMLAnchorElement {
    const host = document.createElement('div');
    host.innerHTML = html;
    return host.firstElementChild as HTMLAnchorElement;
  }

  // jsdom's own origin, so a root-relative href resolves to it exactly as it
  // would in the browser.
  const origin = window.location.origin;

  it('sends a cross-origin link out to the real browser', () => {
    expect(standaloneEscapeHref(anchor('<a href="https://example.com/x">x</a>'), origin)).toBe(
      'https://example.com/x',
    );
  });

  it('leaves same-origin routing, explicit targets, downloads and OS schemes alone', () => {
    expect(standaloneEscapeHref(anchor(`<a href="${origin}/portfolio">p</a>`), origin)).toBeNull();
    expect(standaloneEscapeHref(anchor('<a href="/portfolio">p</a>'), origin)).toBeNull();
    expect(
      standaloneEscapeHref(anchor('<a href="https://example.com" target="_blank">x</a>'), origin),
    ).toBeNull();
    expect(
      standaloneEscapeHref(anchor('<a href="https://example.com" download>x</a>'), origin),
    ).toBeNull();
    expect(standaloneEscapeHref(anchor('<a href="mailto:a@b.c">m</a>'), origin)).toBeNull();
    expect(standaloneEscapeHref(anchor('<a>no href</a>'), origin)).toBeNull();
  });
});

describe('useStandaloneExternalLinks', () => {
  function Harness({ active }: { active: boolean }) {
    useStandaloneExternalLinks(active);
    return (
      <div>
        <a href="https://example.com/docs">external</a>
        <a href="/portfolio">internal</a>
      </div>
    );
  }

  it('sends an external link to the real browser while the chrome is absent', async () => {
    const open = vi.fn();
    Object.defineProperty(window, 'open', { configurable: true, writable: true, value: open });
    const user = userEvent.setup();

    const { getByText } = render(<Harness active />);
    await user.click(getByText('external'));
    expect(open).toHaveBeenCalledWith('https://example.com/docs', '_blank', 'noopener,noreferrer');

    // Same-origin routing is the app itself and must never be handed away.
    open.mockClear();
    await user.click(getByText('internal'));
    expect(open).not.toHaveBeenCalled();
  });

  it('does nothing in an ordinary browser tab, which has its own way back', async () => {
    const open = vi.fn();
    Object.defineProperty(window, 'open', { configurable: true, writable: true, value: open });
    const user = userEvent.setup();

    const { getByText } = render(<Harness active={false} />);
    await user.click(getByText('external'));
    expect(open).not.toHaveBeenCalled();
  });
});
