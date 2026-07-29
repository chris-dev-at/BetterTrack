import { useSyncExternalStore } from 'react';

/**
 * The dock is a desktop luxury. Below this width there is no room for a 380px
 * panel beside a working canvas, so the topbar toggle NAVIGATES to
 * `/people/chat` instead of opening anything — there is deliberately no mobile
 * dock (the page already has its own responsive master-detail layout).
 */
export const DOCK_MIN_WIDTH = 900;

const QUERY = `(min-width: ${DOCK_MIN_WIDTH}px)`;

/** `matchMedia` where the browser has it, the raw width where it doesn't (jsdom). */
function read(): boolean {
  if (typeof window.matchMedia === 'function') return window.matchMedia(QUERY).matches;
  return window.innerWidth >= DOCK_MIN_WIDTH;
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

/** True while the viewport is wide enough for the dock to make sense. */
export function useDockEligible(): boolean {
  return useSyncExternalStore(subscribe, read, () => true);
}
