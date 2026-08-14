import { useCallback, useEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';

import { topOverlayElement } from './overlayStack';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'iframe',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[contenteditable="true"]',
  '[tabindex]',
].join(',');

function isInClosedDetails(element: HTMLElement) {
  const closedDetails = element.closest('details:not([open])');
  return (
    closedDetails !== null &&
    !(element.tagName === 'SUMMARY' && element.parentElement === closedDetails)
  );
}

function isRendered(element: HTMLElement) {
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    const style = getComputedStyle(current);
    if (
      current.hidden ||
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse'
    ) {
      return false;
    }
  }

  return true;
}

function isInInertSubtree(element: HTMLElement) {
  return element.closest('[inert]') !== null;
}

function isInAriaHiddenSubtree(element: HTMLElement) {
  return element.closest('[aria-hidden="true"]') !== null;
}

function isGroupedRadio(element: HTMLElement): element is HTMLInputElement {
  return element instanceof HTMLInputElement && element.type === 'radio' && element.name !== '';
}

function normalizeRadioGroups(elements: HTMLElement[]) {
  const groupsByForm = new Map<
    HTMLFormElement | null,
    Map<string, { checked: HTMLInputElement | undefined; first: HTMLInputElement }>
  >();

  for (const element of elements) {
    if (!isGroupedRadio(element)) continue;

    let groupsByName = groupsByForm.get(element.form);
    if (!groupsByName) {
      groupsByName = new Map();
      groupsByForm.set(element.form, groupsByName);
    }

    const group = groupsByName.get(element.name);
    if (group) {
      if (element.checked) group.checked = element;
    } else {
      groupsByName.set(element.name, {
        checked: element.checked ? element : undefined,
        first: element,
      });
    }
  }

  const radioStops = new Set<HTMLElement>();
  for (const groupsByName of groupsByForm.values()) {
    for (const group of groupsByName.values()) {
      radioStops.add(group.checked ?? group.first);
    }
  }

  return elements.filter((element) => !isGroupedRadio(element) || radioStops.has(element));
}

function focusableDescendants(container: HTMLElement) {
  const candidates = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.matches(':disabled') &&
      isRendered(element) &&
      !isInInertSubtree(element) &&
      !isInAriaHiddenSubtree(element) &&
      !isInClosedDetails(element),
  );

  return normalizeRadioGroups(candidates).sort((left, right) => {
    const leftTabIndex = left.tabIndex;
    const rightTabIndex = right.tabIndex;

    if (leftTabIndex === rightTabIndex) return 0;
    if (leftTabIndex === 0) return 1;
    if (rightTabIndex === 0) return -1;
    return leftTabIndex - rightTabIndex;
  });
}

function currentActiveElement() {
  if (typeof document === 'undefined') return null;
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

/** Focuses a node the document cannot otherwise reach, without altering layout. */
function focusProgrammatically(element: HTMLElement) {
  if (element.tabIndex < 0 && !element.hasAttribute('tabindex')) {
    element.setAttribute('tabindex', '-1');
  }
  element.focus();
}

/**
 * Hands focus back after an overlay closes, in descending order of intent:
 * the caller's stable trigger, the element that had focus when the overlay
 * opened, the overlay still open underneath, and finally the page's main
 * region.
 *
 * The last two rungs are what keeps a closing overlay from dropping focus onto
 * `<body>` when its opener is gone — which happens whenever one overlay hands
 * off to another (the opener unmounts with the overlay that owned it) or an
 * item unmounts as it is activated. Silently giving up there is exactly the
 * "focused element left with nowhere to go" the trap exists to prevent.
 */
export function restoreFocusTo(
  candidates: Array<HTMLElement | null | undefined>,
  { exclude }: { exclude?: HTMLElement | null } = {},
) {
  for (const candidate of candidates) {
    if (candidate instanceof HTMLElement && candidate.isConnected) {
      candidate.focus();
      return;
    }
  }

  const overlayBelow = topOverlayElement(exclude);
  if (overlayBelow !== null) {
    focusProgrammatically(overlayBelow);
    return;
  }

  const main = document.querySelector<HTMLElement>('main');
  if (main !== null) focusProgrammatically(main);
}

/**
 * How many open overlays currently hold each element inert.
 *
 * "Remove only what I added" is not enough on its own: two *sibling* overlays
 * (a portalled dialog and a portalled palette above it) inert the very same
 * background elements, and whichever closes first would drop the attribute and
 * bring the page live under the one still open. Counting the holds means the
 * attribute survives until the last overlay releases it. An element the app
 * marked inert itself is never counted, so it is never removed.
 */
const inertHolds = new WeakMap<HTMLElement, number>();

/** Takes an inert hold on `element`, or `null` if the app already owns one. */
function holdInert(element: HTMLElement): (() => void) | null {
  const holds = inertHolds.get(element) ?? 0;
  if (holds === 0 && element.hasAttribute('inert')) return null;

  inertHolds.set(element, holds + 1);
  element.setAttribute('inert', '');

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (inertHolds.get(element) ?? 1) - 1;
    if (remaining > 0) {
      inertHolds.set(element, remaining);
      return;
    }
    inertHolds.delete(element);
    element.removeAttribute('inert');
  };
}

function makeBackgroundInert(container: HTMLElement) {
  const releases: Array<() => void> = [];
  let branch: HTMLElement = container;

  while (branch.parentElement) {
    const parent = branch.parentElement;
    for (const sibling of parent.children) {
      if (!(sibling instanceof HTMLElement) || sibling === branch) continue;
      const release = holdInert(sibling);
      if (release !== null) releases.push(release);
    }

    if (parent === document.body) break;
    branch = parent;
  }

  return () => {
    for (const release of releases) release();
  };
}

interface FocusTrapOptions {
  active?: boolean;
  inertBackground?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  /**
   * A trigger that outlives this overlay, for flows where one overlay replaces
   * another (create-group → invite step): the opener captured at mount is a
   * control in the *retiring* overlay, so it is already detached by the time
   * the survivor closes. Pass the stable element and restoration keeps working
   * across the handoff.
   */
  restoreFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * Dependency-free focus containment for app overlays. It captures the
 * opener before descendants commit, focuses the first available control (or an
 * explicit target), contains Tab/Shift+Tab, and restores focus on close — to
 * the opener, or down the {@link restoreFocusTo} ladder when the opener is gone.
 */
export function useFocusTrap<T extends HTMLElement>({
  active = true,
  inertBackground = false,
  initialFocusRef,
  restoreFocusRef,
}: FocusTrapOptions = {}) {
  const containerRef = useRef<T>(null);
  const openingElementRef = useRef<HTMLElement | null>(active ? currentActiveElement() : null);
  const wasActiveRef = useRef(active);

  if (active && !wasActiveRef.current) {
    openingElementRef.current = currentActiveElement();
  }
  wasActiveRef.current = active;

  useEffect(() => {
    if (!active) return;

    const container = containerRef.current;
    if (!container) return;

    const restoreBackground = inertBackground ? makeBackgroundInert(container) : undefined;
    const explicitInitial = initialFocusRef?.current;
    const initial =
      explicitInitial && container.contains(explicitInitial)
        ? explicitInitial
        : (focusableDescendants(container)[0] ?? container);
    initial.focus();

    return () => {
      restoreBackground?.();
      restoreFocusTo([restoreFocusRef?.current, openingElementRef.current], { exclude: container });
    };
  }, [active, inertBackground, initialFocusRef, restoreFocusRef]);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab' || event.defaultPrevented) return;

    const container = containerRef.current;
    if (!container) return;

    const focusable = focusableDescendants(container);
    if (focusable.length === 0) {
      event.preventDefault();
      event.stopPropagation();
      container.focus();
      return;
    }

    const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
    const nextIndex = event.shiftKey
      ? activeIndex <= 0
        ? focusable.length - 1
        : activeIndex - 1
      : activeIndex === -1 || activeIndex === focusable.length - 1
        ? 0
        : activeIndex + 1;

    event.preventDefault();
    event.stopPropagation();
    focusable[nextIndex]!.focus();
  }, []);

  return { containerRef, onKeyDown };
}
