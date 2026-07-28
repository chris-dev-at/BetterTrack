import { useEffect, useRef } from 'react';

import { AssetSearchBox } from './AssetSearchBox';
import { useT } from '../../i18n';

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
  const t = useT();
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
      aria-label={t('common.quickSearchAria')}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[10vh] backdrop-blur-sm"
      onClick={handleBackdrop}
    >
      <div
        ref={dialogRef}
        className="bt-dialog__panel w-full max-w-2xl" style={{ maxHeight: 'none' }}
      >
        <div className="p-4">
          <AssetSearchBox autoFocus onAction={onClose} />
        </div>
        <div className="bt-t-rule px-4 py-2">
          <span className="text-xs bt-muted">
            <kbd className="bt-kbd">
              {t('common.escKey')}
            </kbd>{' '}
            {t('common.escToClose')}
          </span>
        </div>
      </div>
    </div>
  );
}
