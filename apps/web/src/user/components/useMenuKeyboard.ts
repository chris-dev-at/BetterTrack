import { useCallback, useEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';

import { useOverlayEscape } from '../../ui/overlayStack';
import { restoreFocusTo } from '../../ui/useFocusTrap';

const MENU_ITEM_SELECTOR = [
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="menuitemcheckbox"]',
].join(',');

/**
 * Every item the roving `tabIndex` covers.
 *
 * `aria-disabled` items stay in — they remain focusable by design (a blueprint
 * that is mid-mutation keeps the caret rather than dumping it on `<body>`), so
 * leaving them out would let one keep `tabIndex=0` while the roving index moved
 * on, giving the menu two tab stops. Only natively `disabled` controls, which
 * cannot hold focus at all, are excluded. Activation is blocked separately, by
 * the item itself.
 */
function menuItems(menu: HTMLElement) {
  return Array.from(menu.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR)).filter(
    (item) => !item.matches(':disabled'),
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
  /** The item this hook last focused — as opposed to one the user moved to. */
  const autoFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) {
      autoFocusedRef.current = null;
      return;
    }

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

    // Async items (watchlists, conglomerates) arrive after the menu opened, so
    // this re-runs on `focusVersion`. Focus this hook placed itself may move on
    // to the item that has since become first; an item the *user* roved to
    // stays put, and the pass only re-normalizes the single tab stop around it.
    //
    // Only a menu *item* counts as user-held. Anything else focused inside the
    // container is not part of the roving model, so treating it as a holder
    // would silently cancel the opening focus this hook owes the menu — which
    // is exactly what the switcher's filter field used to do before it moved to
    // disclosure semantics (see PortfolioSwitcher). A menu's contents are items.
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const userHeld =
      focused !== null &&
      focused !== autoFocusedRef.current &&
      menu.contains(focused) &&
      items.includes(focused)
        ? focused
        : null;
    const target = userHeld ?? selected ?? items[0]!;

    for (const item of items) item.tabIndex = item === target ? 0 : -1;
    if (userHeld === null) {
      target.focus();
      autoFocusedRef.current = target;
    }
  }, [focusVersion, initialFocus, open]);

  const closeAndRestoreFocus = useCallback(() => {
    onClose();
    // The trigger normally survives; when it does not (the whole row unmounted
    // with the item that was activated) the ladder finds the next deliberate
    // destination instead of leaving focus on a detached node.
    restoreFocusTo([triggerRef.current], { exclude: menuRef.current });
  }, [onClose, triggerRef]);

  // Escape is arbitrated globally so that it still works when focus sits on a
  // non-focusable part of the popover, yet only ever closes the innermost open
  // overlay — a menu inside a dialog closes without discarding the dialog.
  useOverlayEscape(open, closeAndRestoreFocus, menuRef);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    // Defensive: no menu on this pattern contains a text field any more (the one
    // that did is a disclosure now), but the handler is bound to the container,
    // so were one ever added, Home/End would move the caret rather than being
    // stolen by the roving model.
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
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
  }, []);

  return { closeAndRestoreFocus, menuRef, onKeyDown };
}
