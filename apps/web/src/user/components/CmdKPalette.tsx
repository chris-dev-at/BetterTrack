import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { AssetSearchBox } from './AssetSearchBox';
import { useT } from '../../i18n';
import { Icon } from '../../ui/origin';
import { filterCommands, type CommandEntry, type CommandGroup } from './commands';

interface CmdKPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

const GROUP_LABEL_KEY: Record<CommandGroup, string> = {
  navigate: 'palette.goTo',
  create: 'palette.create',
  control: 'palette.control',
};

const GROUP_ORDER: readonly CommandGroup[] = ['navigate', 'create', 'control'];

/**
 * Global ⌘K / Ctrl-K command palette (PROJECTPLAN.md §6.2; PRODUCT_BLUEPRINT.md
 * §4 "Global search / command menu"). One input, two result layers: the typed
 * query filters the universal command registry (every destination — parked
 * surfaces included — creation intents and Control Center entries) AND runs
 * the full asset search through `AssetSearchBox`, so "vwce" finds the ETF
 * while "paranoid" finds Privacy modes. Closed by Escape, backdrop click, or
 * any action.
 */
export function CmdKPalette({ isOpen, onClose }: CmdKPaletteProps) {
  const t = useT();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');

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

  // A fresh open starts from a clean command filter (AssetSearchBox owns its
  // own input state and mounts fresh per open, so both start empty together).
  useEffect(() => {
    if (isOpen) setQuery('');
  }, [isOpen]);

  const commands = useMemo(() => filterCommands(query, t), [query, t]);
  const grouped = useMemo(() => {
    const byGroup = new Map<CommandGroup, CommandEntry[]>();
    for (const command of commands) {
      const list = byGroup.get(command.group);
      if (list) list.push(command);
      else byGroup.set(command.group, [command]);
    }
    return GROUP_ORDER.filter((group) => byGroup.has(group)).map((group) => ({
      group,
      entries: byGroup.get(group)!.slice(0, 5),
    }));
  }, [commands]);

  if (!isOpen) return null;

  function handleBackdrop(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('common.quickSearchAria')}
      className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]"
      style={{ background: 'var(--bt-scrim)', backdropFilter: 'blur(4px)' }}
      onClick={handleBackdrop}
    >
      <div
        ref={dialogRef}
        className="bt-dialog__panel w-full max-w-2xl"
        style={{ maxHeight: '76vh' }}
      >
        <div className="p-4" style={{ overflowY: 'auto' }}>
          <AssetSearchBox autoFocus onAction={onClose} onQueryChange={setQuery} />

          {grouped.length > 0 ? (
            <nav aria-label={t('palette.commandsAria')} className="mt-4 flex flex-col gap-4">
              {grouped.map(({ group, entries }) => (
                <div key={group}>
                  <p className="bt-label" style={{ marginBottom: 4 }}>
                    {t(GROUP_LABEL_KEY[group])}
                  </p>
                  <ul className="bt-band flex flex-col">
                    {entries.map((entry) => (
                      <li key={`${entry.group}:${entry.to}`}>
                        <Link
                          className="bt-menu-item"
                          onClick={onClose}
                          style={{ minHeight: 36 }}
                          to={entry.to}
                        >
                          <Icon name={entry.icon} size={15} />
                          <span style={{ flex: 1 }}>{t(entry.labelKey)}</span>
                          {entry.parked ? (
                            <span
                              aria-label={t('common.parked')}
                              className="bt-dot bt-dot--gold"
                              role="img"
                              title={t('common.parked')}
                            />
                          ) : null}
                          <Icon name="arrow-right" size={13} style={{ color: 'var(--bt-faint)' }} />
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </nav>
          ) : null}
        </div>
        <div className="bt-t-rule px-4 py-2">
          <span className="bt-meta">
            <kbd className="bt-kbd">{t('common.escKey')}</kbd> {t('common.escToClose')}
          </span>
        </div>
      </div>
    </div>
  );
}
