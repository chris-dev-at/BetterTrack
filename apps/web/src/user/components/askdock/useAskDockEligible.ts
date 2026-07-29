import { useSyncExternalStore } from 'react';

/**
 * The floating panel is a desktop luxury. Below this width there is no room to
 * overlay a ~400px card on a working canvas, so the rail's Ask row stays a plain
 * link to the `/ask` page instead of becoming a toggle — the route keeps working
 * everywhere, so nothing is ever unreachable.
 */
export const ASK_DOCK_MIN_WIDTH = 900;

const QUERY = `(min-width: ${ASK_DOCK_MIN_WIDTH}px)`;

/** `matchMedia` where the browser has it, the raw width where it doesn't (jsdom). */
function read(): boolean {
  if (typeof window.matchMedia === 'function') return window.matchMedia(QUERY).matches;
  return window.innerWidth >= ASK_DOCK_MIN_WIDTH;
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

/** True while the viewport is wide enough for the floating panel to make sense. */
export function useAskDockEligible(): boolean {
  return useSyncExternalStore(subscribe, read, () => true);
}
