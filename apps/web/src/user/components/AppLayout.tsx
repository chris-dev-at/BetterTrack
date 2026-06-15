import { NavLink, Outlet } from 'react-router-dom';

import { useAuth } from '../AuthContext';
import { Button, cx } from './ui';

/**
 * Minimal authenticated app shell (PROJECTPLAN.md §7.1, §7.2). A placeholder in
 * this issue: it frames the `user` routes with primary navigation and sign-out
 * so the guarded pages render behind the guard. The real chrome (⌘K palette,
 * notification bell, market strip) arrives with the feature pages.
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

  return (
    <div className="min-h-screen bg-[#0b0e14] text-neutral-100">
      <header className="border-b border-neutral-800 bg-neutral-900">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-6">
            <span className="text-sm font-semibold tracking-tight">BetterTrack</span>
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
            {user ? <span className="hidden text-neutral-400 sm:inline">{user.email}</span> : null}
            <Button variant="ghost" onClick={() => void logout()}>
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}
