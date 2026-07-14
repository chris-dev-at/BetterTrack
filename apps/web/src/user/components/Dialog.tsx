import { useEffect } from 'react';
import type { ReactNode } from 'react';

import { useT } from '../../i18n';
import { cx } from './ui';

/**
 * Minimal accessible modal for the user app (mirrors the admin `Modal`): a dimmed
 * backdrop, centered panel, Escape-to-close and a scroll lock while open.
 * Dependency-free — used by the portfolio dialogs (PROJECTPLAN.md §6.9, §7.3).
 */
export function Dialog({
  title,
  description,
  onClose,
  children,
  footer,
  widthClassName = 'max-w-lg',
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
}) {
  const t = useT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 sm:items-center"
      onMouseDown={onClose}
    >
      {footer !== undefined ? (
        // Pinned-footer variant: a height-bounded flex column — header and footer
        // stay put while only the body scrolls.
        <div
          role="dialog"
          aria-modal="true"
          aria-label={title}
          className={cx(
            'flex max-h-[calc(100dvh-2rem)] w-full flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900 shadow-xl',
            widthClassName,
          )}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="flex shrink-0 items-start justify-between gap-4 px-6 pb-4 pt-6">
            <div>
              <h2 className="text-lg font-semibold text-neutral-100">{title}</h2>
              {description ? <p className="mt-1 text-sm text-neutral-500">{description}</p> : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('common.closeDialogAria')}
              className="-mr-1 -mt-1 shrink-0 rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500"
            >
              ✕
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-6 pb-6">{children}</div>
          <div className="shrink-0 border-t border-neutral-800 px-6 py-4">{footer}</div>
        </div>
      ) : (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={title}
          className={cx(
            'mt-12 w-full rounded-lg border border-neutral-800 bg-neutral-900 p-6 shadow-xl sm:mt-0',
            widthClassName,
          )}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-neutral-100">{title}</h2>
              {description ? <p className="mt-1 text-sm text-neutral-500">{description}</p> : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('common.closeDialogAria')}
              className="-mr-1 -mt-1 shrink-0 rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              ✕
            </button>
          </div>
          {children}
        </div>
      )}
    </div>
  );
}
