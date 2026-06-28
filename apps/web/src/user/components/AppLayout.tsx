import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';

import { Wordmark } from '../../components/Wordmark';
import { useAuth } from '../AuthContext';
import { CmdKPalette } from './CmdKPalette';
import { Button, cx } from './ui';

/**
 * Authenticated app shell (PROJECTPLAN.md §7.1, §7.2).
 * Hosts the global ⌘K / Ctrl-K search palette (§6.2) reachable from any route.
 */
const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/search', label: 'Search' },
  { to: '/workboard', label: 'Workboard' },
  { to: '/conglomerates', label: 'Conglomerates' },
  { to: '/portfolio', label: 'Portfolio' },
  { to: '/settings', label: 'Settings' },
];

export function AppLayout() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const isBuilderRoute =
    location.pathname === '/conglomerates/new' ||
    /^\/conglomerates\/[^/]+\/edit$/.test(location.pathname);

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);

  // Register the ⌘K / Ctrl-K global shortcut
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPaletteOpen((open) => !open);
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, []);

  return (
    <div className="min-h-screen bg-[#0b0e14] text-neutral-100">
      <header className="border-b border-neutral-800 bg-neutral-900">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-6">
            <Wordmark edition="Webapp" className="text-sm" />
            <nav className="flex flex-wrap gap-1">
              {NAV_ITEMS.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    cx(
                      'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                      isActive
                        ? 'bg-neutral-800 text-white'
                        : 'text-neutral-400 hover:bg-neutral-800/60 hover:text-neutral-200',
                    )
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <button
              type="button"
              onClick={openPalette}
              aria-label="Open search (⌘K)"
              className={cx(
                'hidden items-center gap-2 rounded-md px-3 py-1.5 text-xs text-neutral-500 sm:flex',
                'ring-1 ring-inset ring-neutral-700 hover:bg-neutral-800 hover:text-neutral-300',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
              )}
            >
              Search
              <kbd className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-neutral-500">
                ⌘K
              </kbd>
            </button>
            {user ? <span className="hidden text-neutral-400 sm:inline">{user.email}</span> : null}
            <Button variant="ghost" onClick={() => void logout()}>
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main className={cx('mx-auto px-4 py-8', isBuilderRoute ? 'max-w-none' : 'max-w-6xl')}>
        <Outlet />
      </main>
      <CmdKPalette isOpen={paletteOpen} onClose={closePalette} />
    </div>
  );
}
