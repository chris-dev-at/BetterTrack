import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

/**
 * The app's open-overlay stack, and the single document-level Escape
 * listener that serves it.
 *
 * Tab containment composes for free: `useFocusTrap` binds a React `onKeyDown`
 * to each panel, and React's synthetic bubbling already delivers the innermost
 * panel first. Escape has no such ordering primitive — an overlay that listens
 * on `document` cannot tell whether it is the one the keystroke meant. One
 * listener per overlay means every open overlay closes at once (a nested dialog
 * discards its parent), and `stopPropagation` cannot fix that: it does not
 * suppress sibling listeners registered on the *same* target.
 *
 * So delivery stays global — Escape must work even when focus has landed on a
 * non-focusable region and fallen back to `<body>` — while arbitration is
 * centralized here: exactly one overlay, the innermost open one, is asked to
 * close. The listener runs in the capture phase and stops propagation, so the
 * decision made here is the only one taken for that keystroke.
 */

interface OverlayEntry {
  getElement: () => HTMLElement | null;
  onEscape: () => void;
}

const stack: OverlayEntry[] = [];
let listening = false;

function connectedElement(entry: OverlayEntry): HTMLElement | null {
  const element = entry.getElement();
  return element !== null && element.isConnected ? element : null;
}

/**
 * The entries nothing else is nested inside. `Dialog` portals to `<body>`, so
 * a dialog-in-a-dialog is a DOM *sibling* and containment says nothing about
 * it; for those the registration order below is what decides. Containment is
 * what settles the cases DOM nesting does describe — a menu inside a dialog.
 */
function innermost(entries: OverlayEntry[]): OverlayEntry[] {
  return entries.filter((entry) => {
    const element = connectedElement(entry);
    if (element === null) return true;
    return !entries.some((other) => {
      if (other === entry) return false;
      const otherElement = connectedElement(other);
      return otherElement !== null && element.contains(otherElement);
    });
  });
}

/**
 * The one overlay an Escape keystroke belongs to.
 *
 * Focus decides first: whatever holds the caret is what the user is working in,
 * which is the reliable answer for portalled dialogs whose mount order need not
 * match their visual nesting. With focus outside every overlay (a click on a
 * non-focusable region drops it to `<body>`), the most recently opened
 * innermost overlay is the topmost one.
 */
function escapeTarget(): OverlayEntry | null {
  if (stack.length === 0) return null;

  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const holdingFocus =
    focused === null
      ? []
      : stack.filter((entry) => connectedElement(entry)?.contains(focused) === true);
  const candidates = holdingFocus.length > 0 ? holdingFocus : stack;

  return innermost(candidates).at(-1) ?? candidates.at(-1) ?? null;
}

function handleKeyDown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.defaultPrevented) return;

  const target = escapeTarget();
  if (target === null) return;

  // Topmost-only: no ancestor overlay, React handler or stray document listener
  // may act on this keystroke as well.
  event.preventDefault();
  event.stopPropagation();
  target.onEscape();
}

function register(entry: OverlayEntry) {
  stack.push(entry);
  if (!listening) {
    document.addEventListener('keydown', handleKeyDown, true);
    listening = true;
  }

  return () => {
    const index = stack.indexOf(entry);
    if (index !== -1) stack.splice(index, 1);
    if (stack.length === 0 && listening) {
      document.removeEventListener('keydown', handleKeyDown, true);
      listening = false;
    }
  };
}

/**
 * The innermost overlay still open, ignoring `exclude` (an overlay in the
 * middle of closing). Used as a deliberate focus destination when the element
 * that opened an overlay is gone by the time it closes.
 */
export function topOverlayElement(exclude?: HTMLElement | null): HTMLElement | null {
  const others = stack.filter((entry) => {
    const element = connectedElement(entry);
    return element !== null && element !== exclude;
  });

  return innermost(others).at(-1)?.getElement() ?? null;
}

/**
 * Registers an open overlay for as long as `active` holds, and routes Escape to
 * it only while it is the innermost one. `elementRef` points at the overlay's
 * own container — the panel, popover or menu — and is what nesting is judged by.
 */
export function useOverlayEscape(
  active: boolean,
  onEscape: () => void,
  elementRef: RefObject<HTMLElement | null>,
) {
  // The callback is read through a ref so that a new closure identity never
  // re-registers the entry: re-registering would move it to the top of the
  // stack and hand it an Escape that belongs to an overlay above it.
  const handlerRef = useRef(onEscape);
  useEffect(() => {
    handlerRef.current = onEscape;
  });

  useEffect(() => {
    if (!active) return;
    return register({
      getElement: () => elementRef.current,
      onEscape: () => handlerRef.current(),
    });
  }, [active, elementRef]);
}
