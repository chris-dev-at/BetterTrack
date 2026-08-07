/**
 * Light / dark theme (board #68 item 2, owner 2026-08-07: "tell webdev to
 * implement white mode" — the mobile app ships both, the web follows).
 *
 * Three states, not two. "System" is a real, persistent choice that keeps
 * tracking `prefers-color-scheme` for as long as it is selected; Dark and Light
 * are explicit pins that survive the OS changing its mind. A two-state toggle
 * cannot express "follow my Mac", which is what most people actually want, and
 * silently becomes a pin the first time it is touched.
 *
 * The choice is per DEVICE and never synced, exactly like `uiScale.ts`: which
 * theme is right depends on the room and the panel, not on the account. The
 * same login is correctly dark on a laptop at night and light on the desk
 * monitor at noon.
 *
 * ── How it is painted ────────────────────────────────────────────────────
 *
 * `document.documentElement` always carries `data-bt-theme` (`dark` | `light`).
 * `styles/origin.css` holds dark in `:root` and overrides only the differing
 * tokens under `:root[data-bt-theme='light']`, so a component never asks which
 * theme is on — it reads tokens, and the tokens are already right. Nothing here
 * knows what a colour looks like beyond {@link THEME_CANVAS}, which exists only
 * because the browser's own chrome (`theme-color`) is painted outside CSS.
 *
 * The attribute is stamped by the inline boot script in `index.html` BEFORE the
 * bundle loads, not from a React effect: mounting first and theming afterwards
 * flashes the wrong canvas on every single page load. This module is the same
 * logic in typed form for everything after that first paint, and
 * `styles/themeTokens.test.ts` pins the two copies against each other so the
 * inline script can never drift from it.
 */

/** Per-device, never synced: the theme answers "which room is this?". */
export const THEME_STORAGE_KEY = 'bt.ui.theme';

/** What the user picked. `system` keeps following `prefers-color-scheme`. */
export type ThemeSetting = 'system' | 'dark' | 'light';

/** What is actually painted once `system` has been resolved. */
export type ResolvedTheme = 'dark' | 'light';

export const THEME_SETTINGS: readonly ThemeSetting[] = ['system', 'dark', 'light'];

/**
 * The canvas colour each theme paints, mirroring `--bt-bg` in `origin.css`.
 *
 * Duplicated out of CSS on purpose: the browser UI colour (`theme-color`) has
 * to be set before any stylesheet has been parsed, so it cannot be read back
 * out of a custom property at the moment it is needed. `themeTokens.test.ts`
 * asserts both values against the stylesheet, so the duplication cannot rot.
 */
export const THEME_CANVAS: Readonly<Record<ResolvedTheme, string>> = {
  dark: '#090c10',
  light: '#f1f2f3',
};

/** The media query that decides `system`. */
const LIGHT_QUERY = '(prefers-color-scheme: light)';

/**
 * What the platform is asking for right now.
 *
 * Dark on anything that cannot answer. jsdom ships no `matchMedia` at all, and
 * a browser that does not know the query reports `matches: false` for both
 * polarities — asking the LIGHT question means "no opinion" lands on the app's
 * dark-first default in both cases, instead of flipping the whole app to a
 * theme nobody asked for.
 */
export function systemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark';
  try {
    return window.matchMedia(LIGHT_QUERY).matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/** The stored choice, or `system` when there is none (or storage is unavailable). */
export function readThemeSetting(): ThemeSetting {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    return raw === 'dark' || raw === 'light' ? raw : 'system';
  } catch {
    return 'system';
  }
}

/** Persist the choice. A storage failure only costs the next page load. */
export function writeThemeSetting(setting: ThemeSetting): void {
  try {
    if (setting === 'system') localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, setting);
  } catch {
    // Private mode / storage disabled — the session still renders themed.
  }
}

/** The theme actually painted for a given choice. */
export function resolveTheme(setting: ThemeSetting): ResolvedTheme {
  return setting === 'system' ? systemTheme() : setting;
}

/**
 * Paint the theme.
 *
 * Two writes and nothing else: the attribute the stylesheet keys off, and the
 * browser-chrome colour the stylesheet cannot reach. Every other consequence of
 * a theme lives in `origin.css`, so there is exactly one place that knows what
 * a theme LOOKS like.
 *
 * `color-scheme` is deliberately NOT set here — it is a token in both `:root`
 * blocks, so native widgets (scrollbars, date pickers, form controls, the
 * overscroll gutter) follow the attribute along with everything else.
 */
export function applyTheme(theme: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-bt-theme', theme);

  // Every `theme-color` meta gets the same value rather than the first one:
  // `index.html` ships a media-scoped pair as the no-JS fallback, and the UA
  // picks the first whose media matches. Writing them all means whichever it
  // picks is the theme actually on screen — including when an explicit pin
  // disagrees with the OS, which is precisely the case the media pair gets
  // wrong on its own.
  const canvas = THEME_CANVAS[theme];
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    meta.setAttribute('content', canvas);
  }
}

/**
 * Watch the platform preference. The listener fires only on a real change, and
 * only matters while the setting is `system` — the caller decides that, because
 * unsubscribing on every pin/unpin would churn the listener for no gain.
 */
export function subscribeSystemTheme(listener: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  try {
    const list = window.matchMedia(LIGHT_QUERY);
    list.addEventListener('change', listener);
    return () => list.removeEventListener('change', listener);
  } catch {
    return () => {};
  }
}

/**
 * Apply the stored theme. Called from the entry module as a correction to the
 * inline boot script — normally a no-op that re-stamps the value already there,
 * and the safety net for the one case the inline script cannot cover (it was
 * skipped, blocked by CSP, or the document was restored from bfcache with a
 * stale attribute).
 */
export function bootTheme(): void {
  applyTheme(resolveTheme(readThemeSetting()));
}
