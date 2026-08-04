import { useSyncExternalStore } from 'react';

/**
 * The width at or below which the shell drops its navigation rail and hands
 * primary navigation to the bottom bar. Must stay in lockstep with the
 * `@media (max-width: 760px)` block in `styles/origin.css` that sets
 * `.bt-rail { display: none }` — the rail's own contents are only reachable
 * above this width.
 */
export const COMPACT_SHELL_MAX_WIDTH = 760;

/**
 * The width at or below which the topbar wraps and the portfolio switcher takes
 * the second row for itself. Must stay in lockstep with the
 * `@media (max-width: 480px)` block in `styles/origin.css` that gives
 * `.bt-topbar > .bt-portfolio-switcher { flex: 0 0 100% }`.
 *
 * The shell MOVES the switcher to the end of the topbar's children below this
 * width rather than reordering it in CSS: flex `order` is visual-only, so an
 * `order`-based second row left sequential keyboard focus jumping from the
 * wrapped switcher back UP to the first row's search and utilities
 * (WCAG 1.3.2 / 2.4.3). Two sources of truth would reopen that hole inside the
 * width band where they disagree, hence the lockstep — `styles/origin.test.ts`
 * pins this constant against the stylesheet's literal.
 */
export const PHONE_SHELL_MAX_WIDTH = 480;

/**
 * `matchMedia` where the browser evaluates it, the raw width where it doesn't.
 * The fallback is load-bearing, not defensive: jsdom 26 ships no `matchMedia`,
 * and the component tests drive these breakpoints by defining
 * `window.innerWidth` and dispatching `resize` — a `matchMedia`-only store
 * would silently report "desktop" in every one of them.
 */
function createBreakpointStore(maxWidth: number) {
  const query = `(max-width: ${maxWidth}px)`;

  return {
    read(): boolean {
      if (typeof window.matchMedia === 'function') return window.matchMedia(query).matches;
      return window.innerWidth <= maxWidth;
    },
    subscribe(listener: () => void): () => void {
      if (typeof window.matchMedia === 'function') {
        const list = window.matchMedia(query);
        list.addEventListener('change', listener);
        return () => list.removeEventListener('change', listener);
      }
      window.addEventListener('resize', listener);
      return () => window.removeEventListener('resize', listener);
    },
  };
}

const compactStore = createBreakpointStore(COMPACT_SHELL_MAX_WIDTH);
const phoneStore = createBreakpointStore(PHONE_SHELL_MAX_WIDTH);

/** Server render: no viewport to measure, so assume the roomy layout. */
const serverSnapshot = () => false;

/**
 * True while the rail is hidden and the compact (phone) chrome is in charge.
 * Rail-only utilities must render somewhere else when this is true, or they are
 * unreachable on a phone.
 */
export function useCompactShell(): boolean {
  return useSyncExternalStore(compactStore.subscribe, compactStore.read, serverSnapshot);
}

/**
 * True while the topbar wraps onto two rows ({@link PHONE_SHELL_MAX_WIDTH}).
 * Chrome that CSS moves onto the wrapped row must be moved in the DOM too, so
 * document order and visual order stay the same sequence.
 */
export function usePhoneShell(): boolean {
  return useSyncExternalStore(phoneStore.subscribe, phoneStore.read, serverSnapshot);
}
