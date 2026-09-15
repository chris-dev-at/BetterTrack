import { useSyncExternalStore } from 'react';

import { useAiCapability } from '../../../lib/aiApi';

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

/**
 * True when the floating AI panel should exist AT ALL: the viewport is wide
 * enough for it, AND the capability read says a local AI provider is configured
 * (§6.18 — with none, EVERY AI surface disappears, this one included).
 *
 * The shell keys both decisions off this one hook: the rail's Ask row stays a
 * plain link to `/ask` instead of becoming a toggle, and the panel is not
 * mounted — so a persisted "open" panel cannot come back with AI switched off.
 * Availability is deliberately treated as unavailable while the capability read
 * is loading or failed, exactly like the other AI surfaces.
 */
export function useAskDockAvailable(): boolean {
  const wideEnough = useAskDockEligible();
  const capability = useAiCapability();
  return wideEnough && capability.data?.available === true;
}
