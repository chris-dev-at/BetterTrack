import { useCallback, useEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';

const MENU_ITEM_SELECTOR = [
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="menuitemcheckbox"]',
].join(',');

function menuItems(menu: HTMLElement) {
  return Array.from(menu.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR)).filter(
    (item) => !item.matches(':disabled') && item.getAttribute('aria-disabled') !== 'true',
  );
}

function focusMenuItem(items: HTMLElement[], item: HTMLElement) {
  for (const candidate of items) candidate.tabIndex = candidate === item ? 0 : -1;
  item.focus();
}

interface MenuKeyboardOptions {
  open: boolean;
  onClose: () => void;
  triggerRef: RefObject<HTMLElement | null>;
  initialFocus?: 'first' | 'selected';
  focusVersion?: unknown;
}

/** Complete keyboard interaction and roving focus for disclosure menus. */
export function useMenuKeyboard<T extends HTMLElement = HTMLDivElement>({
  open,
  onClose,
  triggerRef,
  initialFocus = 'first',
  focusVersion,
}: MenuKeyboardOptions) {
  const menuRef = useRef<T>(null);

  useEffect(() => {
    if (!open) return;

    const menu = menuRef.current;
    if (!menu) return;

    const items = menuItems(menu);
    if (items.length === 0) return;

    const selected =
      initialFocus === 'selected'
        ? items.find(
            (item) =>
              item.getAttribute('aria-checked') === 'true' ||
              item.getAttribute('aria-current') === 'true',
          )
        : undefined;
    focusMenuItem(items, selected ?? items[0]!);
  }, [focusVersion, initialFocus, open]);

  const closeAndRestoreFocus = useCallback(() => {
    onClose();
    const trigger = triggerRef.current;
    if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
  }, [onClose, triggerRef]);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeAndRestoreFocus();
        return;
      }

      if (
        event.key !== 'ArrowDown' &&
        event.key !== 'ArrowUp' &&
        event.key !== 'Home' &&
        event.key !== 'End'
      ) {
        return;
      }

      const menu = menuRef.current;
      if (!menu) return;
      const items = menuItems(menu);
      if (items.length === 0) return;

      event.preventDefault();
      const activeIndex = items.indexOf(document.activeElement as HTMLElement);
      let nextIndex: number;
      if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = items.length - 1;
      else if (event.key === 'ArrowDown') {
        nextIndex = activeIndex < 0 || activeIndex === items.length - 1 ? 0 : activeIndex + 1;
      } else {
        nextIndex = activeIndex <= 0 ? items.length - 1 : activeIndex - 1;
      }

      focusMenuItem(items, items[nextIndex]!);
    },
    [closeAndRestoreFocus],
  );

  return { closeAndRestoreFocus, menuRef, onKeyDown };
}
