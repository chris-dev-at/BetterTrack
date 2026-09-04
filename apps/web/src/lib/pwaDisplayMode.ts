import { useEffect, useMemo, useSyncExternalStore } from 'react';

import { apiBaseUrl } from './runtimeConfig';

/**
 * Display-mode facts for the installable user app (PROJECTPLAN §7.1, V5-P13b).
 *
 * The manifest ships `display: standalone`, so an installed BetterTrack runs in
 * a window with NO address bar, NO reload and — on iOS — no back button at all.
 * Everything the app does differently in that window is derived from here, so
 * there is exactly one answer to "is the browser chrome gone" rather than one
 * per component.
 *
 * Two signals, because neither alone covers the field:
 *   • `(display-mode: standalone)` — the standard, honoured by Chromium, and by
 *     WebKit from iOS 16.4 on.
 *   • `navigator.standalone` — WebKit's own, and the ONLY signal on the iOS
 *     versions below that. This row is the iOS app until a native one exists,
 *     so the legacy flag is load-bearing, not a courtesy.
 *
 * jsdom 26 ships no `matchMedia` at all (see `user/hooks/useCompactShell.ts`),
 * hence the capability guard on every read: the honest answer without it is
 * "not standalone", which is also the safe one — a false negative shows the
 * install affordance in a window that is already installed, a false positive
 * would hide chrome the user still needs.
 */

/** Presentations with no browser chrome: no address bar, no back button. */
const CHROMELESS_QUERIES = ['(display-mode: standalone)', '(display-mode: fullscreen)'] as const;

/**
 * Everything an installed window can resolve to, chrome or not — `minimal-ui`
 * keeps a back/reload affordance, so it is installed but NOT chromeless.
 */
const INSTALLED_QUERIES = [...CHROMELESS_QUERIES, '(display-mode: minimal-ui)'] as const;

/** The attribute `styles/origin.css` keys its standalone-only rules off. */
export const DISPLAY_MODE_ATTRIBUTE = 'data-bt-display-mode';

function matchesAny(queries: readonly string[]): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return queries.some((query) => window.matchMedia(query).matches);
}

/** WebKit's pre-16.4 signal, and still the truth on every iOS home-screen app. */
function iosStandalone(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** True while the app runs without browser chrome — no address bar, no back. */
export function isStandaloneDisplay(): boolean {
  return matchesAny(CHROMELESS_QUERIES) || iosStandalone();
}

/** True while the app runs from an installed window, chromeless or minimal-ui. */
export function isInstalledDisplay(): boolean {
  return matchesAny(INSTALLED_QUERIES) || iosStandalone();
}

/**
 * Watch every display-mode query at once. A window can be moved between modes
 * without a reload (Chromium's "Open in app"), so the shell must re-render.
 */
export function subscribeDisplayMode(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const lists = INSTALLED_QUERIES.map((query) => window.matchMedia(query));
  for (const list of lists) list.addEventListener('change', onChange);
  return () => {
    for (const list of lists) list.removeEventListener('change', onChange);
  };
}

/** Server render / no viewport: assume the ordinary browser tab. */
const notStandalone = () => false;

/** {@link isStandaloneDisplay} as a subscribed hook. */
export function useStandaloneDisplay(): boolean {
  return useSyncExternalStore(subscribeDisplayMode, isStandaloneDisplay, notStandalone);
}

/** {@link isInstalledDisplay} as a subscribed hook. */
export function useInstalledDisplay(): boolean {
  return useSyncExternalStore(subscribeDisplayMode, isInstalledDisplay, notStandalone);
}

/** Stamp (or clear) the root attribute the standalone-only CSS block reads. */
export function applyDisplayModeAttribute(standalone: boolean): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (standalone) root.setAttribute(DISPLAY_MODE_ATTRIBUTE, 'standalone');
  else root.removeAttribute(DISPLAY_MODE_ATTRIBUTE);
}

/**
 * True when the only possible install affordance is a coach mark.
 *
 * iOS Safari never fires `beforeinstallprompt` and exposes no programmatic
 * install, so "Share → Add to Home Screen" — described, not triggered — is the
 * whole of what an install affordance can be there. Gated on the ABSENCE of
 * `onbeforeinstallprompt` so a browser that will offer the real prompt is never
 * handed instructions instead.
 *
 * `'standalone' in navigator` is a second deliberate narrowing: it is WebKit's
 * own property, so Chrome/Firefox/Edge on iOS — which reach "Add to Home Screen"
 * through their own menus, not Safari's Share sheet — get no card rather than
 * two taps that do not exist where they are looking. Silence beats wrong
 * instructions; the browsers' own menus still install the app.
 */
export function supportsHomeScreenCoachMark(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  if ('onbeforeinstallprompt' in window) return false;
  // iPadOS 13+ reports a desktop Macintosh UA; its touch points give it away.
  const agent = navigator.userAgent;
  const isIos =
    /iPad|iPhone|iPod/u.test(agent) ||
    (/Macintosh/u.test(agent) && (navigator.maxTouchPoints ?? 0) > 1);
  return isIos && 'standalone' in navigator;
}

/**
 * The origins that ARE this app, and must therefore never be handed to another
 * browser.
 *
 * The page origin is only half of it: BetterTrack ships split-origin
 * (`window.__BT__.apiOrigin`, §7.1 and `lib/apiClient.ts`), and the API origin
 * carries top-level navigations the app performs deliberately — Google sign-in
 * and Google linking both assign `${apiBaseUrl()}/auth/google/start` to the
 * whole window (`lib/userApi.ts`). Escaping those would finish the OAuth round
 * trip in the real browser, where an installed iOS PWA cannot see the session
 * cookie it just set — sign-in would be impossible from the installed app.
 */
export function sameAppOrigins(pageOrigin: string): readonly string[] {
  const origins = new Set<string>([pageOrigin]);
  try {
    origins.add(new URL(apiBaseUrl(), pageOrigin).origin);
  } catch {
    // A malformed injected apiOrigin leaves the page origin as the only answer,
    // which is the conservative one: more links escape, none are swallowed.
  }
  return [...origins];
}

/**
 * The absolute URL an anchor must be sent to the real browser with, or `null`
 * when it may be followed in place.
 *
 * Standalone windows have no address bar and no back button, so an in-place
 * navigation to another origin strands the user inside a page they cannot leave
 * — the app is simply gone until they force-quit it. The app's own origins are
 * untouched ({@link sameAppOrigins}), and so is anything that already escapes or
 * opts out: an explicit `target` (including `_self`, the per-anchor "follow this
 * in place"), a download, or a scheme (`mailto:`, `tel:`) the OS hands to
 * another app anyway.
 */
export function standaloneEscapeHref(
  anchor: HTMLAnchorElement,
  origin: string,
  appOrigins: readonly string[] = sameAppOrigins(origin),
): string | null {
  const target = anchor.getAttribute('target');
  if (target !== null && target !== '') return null;
  if (anchor.hasAttribute('download')) return null;
  if (anchor.getAttribute('href') === null) return null;

  let url: URL;
  try {
    url = new URL(anchor.href, origin);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (appOrigins.includes(url.origin)) return null;
  return url.href;
}

/**
 * While `active`, open cross-origin links in the real browser instead of inside
 * the chromeless window. See {@link standaloneEscapeHref} for what qualifies.
 */
export function useStandaloneExternalLinks(active: boolean): void {
  // The injected runtime config is written before the bundle loads and never
  // changes afterwards, so the app's origins are resolved once per activation
  // rather than on every click.
  const appOrigins = useMemo(
    () => (typeof window === 'undefined' ? [] : sameAppOrigins(window.location.origin)),
    [],
  );

  useEffect(() => {
    if (!active || typeof document === 'undefined') return;

    const onClick = (event: MouseEvent): void => {
      // Modified clicks and secondary buttons are the browser's own affordances
      // for choosing where a link opens; never take those over.
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      // `closest('a')` also matches an SVG `<a>`, whose `href` is an
      // `SVGAnimatedString` rather than a resolved URL. Narrow by instance so
      // only real HTML anchors are read — deliberately, not by accident.
      const anchor = (event.target as Element | null)?.closest?.('a');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const href = standaloneEscapeHref(anchor, window.location.origin, appOrigins);
      if (href === null) return;

      event.preventDefault();
      window.open(href, '_blank', 'noopener,noreferrer');
    };

    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [active, appOrigins]);
}

/**
 * True when there is a real entry behind the current one in THIS window's
 * history, so a back affordance has somewhere to go.
 *
 * react-router's `location.key !== 'default'` is NOT that answer: `'default'`
 * marks only the initial location OBJECT, and any boot-time redirect
 * (`RequireUser`'s `<Navigate to="/login" replace>`, the first-run gate, the
 * switcher's replace-mode `setSearchParams`) mints a fresh key while the history
 * index stays at 0. The index is what the router itself writes into
 * `window.history.state`, so read it from there: at 0 a `navigate(-1)` either
 * does nothing or walks the user out of the app entirely.
 */
export function canNavigateBack(): boolean {
  if (typeof window === 'undefined') return false;
  const index = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof index === 'number' && index > 0;
}
