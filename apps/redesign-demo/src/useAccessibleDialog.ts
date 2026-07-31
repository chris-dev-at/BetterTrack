import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react';

type DialogEntry = {
  id: symbol;
  element: HTMLElement | null;
};

type BackgroundLock = {
  count: number;
  inert: boolean;
  ariaHidden: string | null;
};

const dialogStack: DialogEntry[] = [];
const backgroundLocks = new Map<HTMLElement, BackgroundLock>();
let recentInvokingElement: HTMLElement | null = null;
let recentInvokingElementAt = 0;
let explicitInvokingElement: HTMLElement | null = null;
let explicitInvokingElementAt = 0;

export function rememberAccessibleDialogTrigger(element: HTMLElement) {
  explicitInvokingElement = element;
  explicitInvokingElementAt = Date.now();
  recentInvokingElement = element;
  recentInvokingElementAt = Date.now();
}

if (typeof document !== 'undefined') {
  document.addEventListener(
    'focusin',
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target === document.body) return;
      if (dialogStack.some((entry) => entry.element?.contains(target))) return;
      recentInvokingElement = target;
      recentInvokingElementAt = Date.now();
    },
    true,
  );
}

const focusableSelector = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'object',
  'embed',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function topmostDialog() {
  return dialogStack.at(-1);
}

function isFocusable(element: HTMLElement) {
  if (element.tabIndex < 0) return false;
  if (element.closest('[inert], [aria-hidden="true"]')) return false;
  if (element.getAttribute('hidden') !== null) return false;
  return element.getClientRects().length > 0;
}

function focusableElements(dialog: HTMLElement) {
  return Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter(isFocusable);
}

function lockElement(element: HTMLElement) {
  const existing = backgroundLocks.get(element);
  if (existing) {
    existing.count += 1;
    return;
  }

  backgroundLocks.set(element, {
    count: 1,
    inert: element.inert,
    ariaHidden: element.getAttribute('aria-hidden'),
  });
  element.inert = true;
  element.setAttribute('aria-hidden', 'true');
}

function unlockElement(element: HTMLElement) {
  const lock = backgroundLocks.get(element);
  if (!lock) return;
  lock.count -= 1;
  if (lock.count > 0) return;

  element.inert = lock.inert;
  if (lock.ariaHidden === null) {
    element.removeAttribute('aria-hidden');
  } else {
    element.setAttribute('aria-hidden', lock.ariaHidden);
  }
  backgroundLocks.delete(element);
}

function lockBackground(dialog: HTMLElement) {
  const locked: HTMLElement[] = [];
  let branch = dialog.closest<HTMLElement>('[data-accessible-dialog-layer]') ?? dialog;

  while (branch.parentElement) {
    const parent = branch.parentElement;
    Array.from(parent.children).forEach((sibling) => {
      if (sibling === branch || !(sibling instanceof HTMLElement)) return;
      lockElement(sibling);
      locked.push(sibling);
    });
    if (parent === document.body) break;
    branch = parent;
  }

  return () => {
    locked.reverse().forEach(unlockElement);
  };
}

export type AccessibleDialogOptions = {
  open: boolean;
  onClose: () => void;
  initialFocusSelector?: string;
  restoreFocus?: boolean;
};

/**
 * Supplies the behavior ARIA's modal-dialog pattern cannot provide on its own:
 * initial focus, a topmost-only focus trap, Escape handling, inert background,
 * and focus restoration to the invoking control.
 */
export function useAccessibleDialog<T extends HTMLElement>({
  open,
  onClose,
  initialFocusSelector,
  restoreFocus = true,
}: AccessibleDialogOptions): RefObject<T | null> {
  const dialogRef = useRef<T>(null);
  const idRef = useRef(Symbol('accessible-dialog'));
  const closeRef = useRef(onClose);
  const initialFocusSelectorRef = useRef(initialFocusSelector);
  const restoreFocusRef = useRef(restoreFocus);
  const invokingElementRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    closeRef.current = onClose;
    initialFocusSelectorRef.current = initialFocusSelector;
    restoreFocusRef.current = restoreFocus;
  });

  useLayoutEffect(() => {
    if (!open) return undefined;

    const dialog = dialogRef.current;
    if (!dialog) return undefined;

    const activeElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (
      activeElement &&
      activeElement !== document.body &&
      !dialog.contains(activeElement) &&
      activeElement.isConnected
    ) {
      invokingElementRef.current = activeElement;
      recentInvokingElement = activeElement;
      recentInvokingElementAt = Date.now();
    } else if (
      !invokingElementRef.current &&
      explicitInvokingElement?.isConnected &&
      !dialog.contains(explicitInvokingElement) &&
      Date.now() - explicitInvokingElementAt < 1500
    ) {
      invokingElementRef.current = explicitInvokingElement;
    } else if (
      !invokingElementRef.current &&
      recentInvokingElement?.isConnected &&
      !dialog.contains(recentInvokingElement) &&
      Date.now() - recentInvokingElementAt < 1500
    ) {
      // React StrictMode replays layout effects after `inert` has already moved focus
      // to the document body. Preserve the trigger captured by the first pass.
      invokingElementRef.current = recentInvokingElement;
    }
    const invokingElement = invokingElementRef.current;
    const entry: DialogEntry = { id: idRef.current, element: dialog };
    dialogStack.push(entry);
    const unlockBackground = lockBackground(dialog);

    const focusInitialElement = window.requestAnimationFrame(() => {
      if (topmostDialog()?.id !== entry.id) return;
      const requested = initialFocusSelectorRef.current
        ? dialog.querySelector<HTMLElement>(initialFocusSelectorRef.current)
        : null;
      (requested && isFocusable(requested) ? requested : dialog).focus({
        preventScroll: true,
      });
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (topmostDialog()?.id !== entry.id) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeRef.current();
        return;
      }

      if (event.key !== 'Tab') return;
      const focusable = focusableElements(dialog);
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }

      const active = document.activeElement;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };

    const onFocusIn = (event: FocusEvent) => {
      if (topmostDialog()?.id !== entry.id) return;
      if (event.target instanceof Node && dialog.contains(event.target)) return;
      const target = focusableElements(dialog)[0] ?? dialog;
      target.focus({ preventScroll: true });
    };

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn, true);

    return () => {
      window.cancelAnimationFrame(focusInitialElement);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
      const stackIndex = dialogStack.findIndex((candidate) => candidate.id === entry.id);
      if (stackIndex >= 0) dialogStack.splice(stackIndex, 1);
      unlockBackground();

      if (!restoreFocusRef.current || !invokingElement?.isConnected) return;
      let attempts = 0;
      const restore = () => {
        attempts += 1;
        if (!invokingElement.isConnected) return;
        if (!invokingElement.closest('[inert]')) {
          invokingElement.focus({ preventScroll: true });
          return;
        }
        if (attempts < 3) window.requestAnimationFrame(restore);
      };
      window.requestAnimationFrame(restore);
    };
  }, [open]);

  return dialogRef;
}

export function useDialogStepFocus(
  open: boolean,
  step: string | number,
  headingRef: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return undefined;
    const frame = window.requestAnimationFrame(() => {
      headingRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [headingRef, open, step]);
}
