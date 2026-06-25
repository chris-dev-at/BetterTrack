import { useEffect, useRef } from 'react';

import { AssetSearchBox } from './AssetSearchBox';

interface CmdKPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Global ⌘K / Ctrl-K command palette (PROJECTPLAN.md §6.2, §7.3).
 * Reuses `AssetSearchBox` for all search/result logic.
 * Opened by the keyboard shortcut registered in `AppLayout`.
 * Closed by Escape, backdrop click, or a result action.
 */
export function CmdKPalette({ isOpen, onClose }: CmdKPaletteProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  function handleBackdrop(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Quick search"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[10vh] backdrop-blur-sm"
      onClick={handleBackdrop}
    >
      <div
        ref={dialogRef}
        className="w-full max-w-2xl rounded-xl border border-neutral-700 bg-neutral-900 shadow-2xl"
      >
        <div className="p-4">
          <AssetSearchBox autoFocus onAction={onClose} />
        </div>
        <div className="border-t border-neutral-800 px-4 py-2">
          <span className="text-xs text-neutral-600">
            <kbd className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-neutral-400">
              Esc
            </kbd>{' '}
            to close
          </span>
        </div>
      </div>
    </div>
  );
}
