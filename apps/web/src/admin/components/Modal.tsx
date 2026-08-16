import { createPortal } from 'react-dom';
import { useEffect, useId, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';

import { useBodyScrollLock } from '../../ui/useBodyScrollLock';
import { useOverlayEscape } from '../../ui/overlayStack';

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
  // Native Tab navigation exposes one stop per named radio group, scoped to its form owner.
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

/**
 * Minimal accessible modal: a dimmed backdrop, centered panel, Escape-to-close,
 * and a scroll lock while open. Deliberately dependency-free.
 */
export function Modal({
  title,
  onClose,
  children,
  dismissable = true,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Disable Escape and backdrop dismissal until the caller acknowledges a one-time value. */
  dismissable?: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // Capture this during the initial render, before React commits descendants
  // with autoFocus. A passive or layout effect would see the modal field instead
  // of the control that opened the dialog.
  const openingElementRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const onCloseRef = useRef(onClose);
  const dismissableRef = useRef(dismissable);
  const titleId = useId();

  onCloseRef.current = onClose;
  dismissableRef.current = dismissable;

  useOverlayEscape(
    true,
    () => {
      if (dismissableRef.current) onCloseRef.current();
    },
    dialogRef,
  );
  useBodyScrollLock();

  useEffect(() => {
    const dialog = dialogRef.current;
    const focusable = dialog ? focusableDescendants(dialog) : [];
    (focusable[0] ?? dialog)?.focus();

    return () => {
      const openingElement = openingElementRef.current;
      if (openingElement instanceof HTMLElement && openingElement.isConnected) {
        openingElement.focus();
      }
    };
  }, []);

  const onDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;

    const dialog = dialogRef.current;
    if (!dialog) return;

    const focusable = focusableDescendants(dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }

    // Positive tabindex values are ordered across the entire document, not just
    // this dialog. Drive every Tab transition from the dialog's own sequence so
    // a background positive-tabindex control cannot become the next stop.
    const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
    const nextIndex = event.shiftKey
      ? activeIndex <= 0
        ? focusable.length - 1
        : activeIndex - 1
      : activeIndex === -1 || activeIndex === focusable.length - 1
        ? 0
        : activeIndex + 1;

    event.preventDefault();
    focusable[nextIndex]!.focus();
  };

  // Admin pages render inside the shell's <main>, which the mobile drawer
  // makes inert while it is open. Keep a later Modal outside that inert branch
  // so it can take focus and correctly become the top Escape target.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 text-neutral-100 sm:items-center"
      onMouseDown={() => {
        if (dismissable) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="mt-12 w-full max-w-md rounded-lg border border-neutral-800 bg-neutral-900 p-6 shadow-xl sm:mt-0"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onDialogKeyDown}
      >
        <h2 id={titleId} className="mb-4 text-lg font-semibold text-neutral-100">
          {title}
        </h2>
        {children}
      </div>
    </div>,
    document.body,
  );
}
