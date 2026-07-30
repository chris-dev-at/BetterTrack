import { useCallback, useEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';

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

function makeBackgroundInert(container: HTMLElement) {
  const changed: Array<{ element: HTMLElement; hadInert: boolean }> = [];
  let branch: HTMLElement = container;

  while (branch.parentElement) {
    const parent = branch.parentElement;
    for (const sibling of parent.children) {
      if (!(sibling instanceof HTMLElement) || sibling === branch) continue;
      const hadInert = sibling.hasAttribute('inert');
      changed.push({ element: sibling, hadInert });
      sibling.setAttribute('inert', '');
    }

    if (parent === document.body) break;
    branch = parent;
  }

  return () => {
    for (const { element, hadInert } of changed) {
      if (!hadInert) element.removeAttribute('inert');
    }
  };
}

interface FocusTrapOptions {
  active?: boolean;
  inertBackground?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  restoreFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * Dependency-free focus containment for user-app overlays. It captures the
 * opener before descendants commit, focuses the first available control (or an
 * explicit target), contains Tab/Shift+Tab, and restores the opener on close.
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
      const restoreTarget = restoreFocusRef?.current ?? openingElementRef.current;
      if (restoreTarget instanceof HTMLElement && restoreTarget.isConnected) {
        restoreTarget.focus();
      }
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
