import { NavLink, Navigate, Outlet } from 'react-router-dom';

import { useAuth } from '../AuthContext';
import { Button, Spinner, cx } from './ui';

const NAV_ITEMS = [
  { to: '/admin/users', label: 'Users' },
  { to: '/admin/invites', label: 'Invites' },
  { to: '/admin/audit', label: 'Audit log' },
];

/**
 * Guarded shell for every `/admin/*` page. Distinct from the normal app shell
 * (PROJECTPLAN.md §6.12): no app navigation, just the admin sections. While the
 * session is resolving it shows a spinner; anonymous visitors are redirected to
 * the admin login — non-admins never reach here because the bootstrap in
 * AuthContext only marks admins as authenticated.
 */
export function AdminLayout() {
  const { status, user, logout } = useAuth();

  if (status === 'loading') {
    return (
      <div className="grid min-h-screen place-items-center bg-neutral-950">
        <Spinner label="Loading admin console…" />
      </div>
    );
  }
  if (status === 'anonymous' || !user) return <Navigate to="/admin/login" replace />;

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <header className="border-b border-neutral-800 bg-neutral-900">
        <div className="mx-auto flex max-w-5xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-6">
            <span className="text-sm font-semibold tracking-tight">
              BetterTrack <span className="text-neutral-500">Admin</span>
            </span>
            <nav className="flex gap-1">
              {NAV_ITEMS.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
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
            <span className="hidden text-neutral-400 sm:inline">{user.email}</span>
            <Button variant="ghost" onClick={() => void logout()}>
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}
