import { createPortal } from 'react-dom';
import { useEffect } from 'react';
import type { CSSProperties, ReactNode, RefObject } from 'react';

import { useT } from '../../i18n';
import { cx } from './ui';
import { useOverlayEscape } from './overlayStack';
import { useFocusTrap } from './useFocusTrap';

/**
 * Minimal accessible modal for the user app (mirrors the admin `Modal`): a dimmed
 * backdrop, centered panel, Escape-to-close and a scroll lock while open.
 * Dependency-free — used by the portfolio dialogs (PROJECTPLAN.md §6.9, §7.3).
 *
 * Reskinned onto the Origin overlay language (styles/origin.css): the `bt-scrim`
 * backdrop sits under a transparent scroll layer that owns the click-outside, so
 * the exact mousedown/Escape/aria behavior is preserved while the panel picks up
 * `bt-dialog__panel` / `__head` / `__body`. The panel's own `width` is neutralised
 * to `100%` so the caller's `widthClassName` max-width keeps governing the size.
 */
export function Dialog({
  title,
  description,
  onClose,
  children,
  footer,
  widthClassName = 'max-w-lg',
  dismissable = true,
  restoreFocusRef,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  /**
   * Pinned footer (#378 transaction form). When provided, the body scrolls
   * within a height-bounded panel and this stays fixed at the bottom — the
   * Total + primary CTA never scroll out of reach. Omitted → the classic
   * single-column panel that grows with its content.
   */
  footer?: ReactNode;
  /** Tailwind max-width for the panel. Defaults to `max-w-lg`. */
  widthClassName?: string;
  /** Disable every incidental close affordance until a one-time value is acknowledged. */
  dismissable?: boolean;
  /**
   * A trigger outside this dialog to return focus to, for flows where one
   * dialog replaces another and the element that opened this one is already
   * gone by the time it closes.
   */
  restoreFocusRef?: RefObject<HTMLElement | null>;
}) {
  const t = useT();
  const { containerRef, onKeyDown } = useFocusTrap<HTMLDivElement>({
    inertBackground: true,
    restoreFocusRef,
  });

  // Escape goes through the shared overlay stack: a dialog opened from inside
  // another dialog closes alone, leaving its parent — and the context the user
  // is halfway through — standing.
  useOverlayEscape(dismissable, onClose, containerRef);

  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  // Pinned-footer variant: a height-bounded flex column (bt-dialog__panel is one
  // already) so header and footer stay put while only the body scrolls. Plain
  // variant: a block panel that grows with its content and lets the overlay
  // scroll — the pre-reskin behavior, kept byte-for-byte.
  const panelStyle: CSSProperties =
    footer !== undefined
      ? { width: '100%', maxHeight: 'calc(100dvh - 2rem)' }
      : { width: '100%', maxHeight: 'none', display: 'block' };

  const head = (
    <div className="bt-dialog__head shrink-0" style={{ alignItems: 'flex-start' }}>
      <div>
        <h2 className="bt-dialog__title">{title}</h2>
        {description ? <p className="bt-meta mt-1">{description}</p> : null}
      </div>
      {dismissable ? (
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.closeDialogAria')}
          className="bt-btn bt-btn--quiet bt-btn--sm bt-btn--icon shrink-0"
        >
          ✕
        </button>
      ) : null}
    </div>
  );

  // Portalled to <body> for the same reason ODialog is: `position: fixed` here
  // resolves against the nearest ancestor that is a containing block for it, and
  // the topbar's `backdrop-filter` makes the topbar one — so a dialog opened from
  // the portfolio switcher (which lives in the topbar) laid itself out inside
  // that strip instead of over the page. The root carries `bt-app` so the app's
  // ink, type scale and focus ring still apply outside the shell.
  return createPortal(
    <div className="bt-app bt-dialog-root">
      <div className="bt-scrim" aria-hidden="true" />
      <div
        className="fixed inset-0 z-[71] flex items-start justify-center overflow-y-auto p-4 sm:items-center"
        onMouseDown={() => {
          if (dismissable) onClose();
        }}
      >
        <div
          ref={containerRef}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          tabIndex={-1}
          className={cx(
            'bt-dialog__panel w-full',
            footer === undefined && 'mt-12 sm:mt-0',
            widthClassName,
          )}
          style={panelStyle}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={onKeyDown}
        >
          {head}
          <div className={cx('bt-dialog__body', footer !== undefined && 'flex-1')}>{children}</div>
          {footer !== undefined ? (
            <div className="bt-t-rule shrink-0 px-5 py-3.5">{footer}</div>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
