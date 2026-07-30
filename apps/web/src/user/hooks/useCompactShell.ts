import { useSyncExternalStore } from 'react';

/**
 * The width at or below which the shell drops its navigation rail and hands
 * primary navigation to the bottom bar. Must stay in lockstep with the
 * `@media (max-width: 760px)` block in `styles/origin.css` that sets
 * `.bt-rail { display: none }` — the rail's own contents are only reachable
 * above this width.
 */
export const COMPACT_SHELL_MAX_WIDTH = 760;

const QUERY = `(max-width: ${COMPACT_SHELL_MAX_WIDTH}px)`;

/** `matchMedia` where the browser evaluates it, the raw width where it doesn't (jsdom). */
function read(): boolean {
  if (typeof window.matchMedia === 'function') return window.matchMedia(QUERY).matches;
  return window.innerWidth <= COMPACT_SHELL_MAX_WIDTH;
}

function subscribe(listener: () => void): () => void {
  if (typeof window.matchMedia === 'function') {
    const list = window.matchMedia(QUERY);
    list.addEventListener('change', listener);
    return () => list.removeEventListener('change', listener);
  }
  window.addEventListener('resize', listener);
  return () => window.removeEventListener('resize', listener);
}

/**
 * True while the rail is hidden and the compact (phone) chrome is in charge.
 * Rail-only utilities must render somewhere else when this is true, or they are
 * unreachable on a phone.
 */
export function useCompactShell(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}
