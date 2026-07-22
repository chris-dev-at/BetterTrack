import { useEffect } from 'react';
import type { ReactNode } from 'react';

/**
 * Minimal accessible modal: a dimmed backdrop, centered panel, Escape-to-close,
 * and a scroll lock while open. Deliberately dependency-free.
 */
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
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
      className="safe-pt-4 safe-pb-4 fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 px-4 sm:items-center"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="mt-4 w-full max-w-md rounded-lg border border-neutral-800 bg-neutral-900 p-5 shadow-xl sm:mt-0 sm:p-6"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-lg font-semibold text-neutral-100">{title}</h2>
        {children}
      </div>
    </div>
  );
}
