import { NavLink, Navigate, Outlet, useLocation } from 'react-router-dom';

import { Wordmark } from '../../components/Wordmark';
import { useT } from '../../i18n';
import { ErrorBoundary } from '../../ui';
import { useAuth } from '../AuthContext';
import { Button, Spinner, cx } from './ui';

/** `labelKey` runs through i18n (new entries); `label` is a legacy literal. */
type NavItem = { to: string; label?: string; labelKey?: string };

/**
 * Light IA regroup (§13.4 V4-P0d): the grown admin surface, ordered into sane
 * sections — People, Configuration, Diagnostics — with the section boundaries
 * shown as subtle dividers in the horizontal nav. Structural tidy only; the deep
 * redesign stays V6-1.
 */
const NAV_SECTIONS: Array<{ key: string; items: NavItem[] }> = [
  {
    key: 'people',
    items: [
      { to: '/admin/users', label: 'Users' },
      { to: '/admin/invites', label: 'Invites' },
    ],
  },
  {
    key: 'config',
    items: [
      { to: '/admin/settings', label: 'Settings' },
      { to: '/admin/account-defaults', label: 'Account defaults' },
      { to: '/admin/announcements', label: 'Announcements' },
      { to: '/admin/oauth-apps', label: 'OAuth apps' },
    ],
  },
  {
    key: 'diagnostics',
    items: [
      { to: '/admin/health', labelKey: 'admin.nav.health' },
      { to: '/admin/email', label: 'Email' },
      { to: '/admin/audit', label: 'Audit log' },
      { to: '/admin/security', labelKey: 'admin.nav.security' },
    ],
  },
];

/**
 * Guarded shell for every `/admin/*` page. Distinct from the normal app shell
 * (PROJECTPLAN.md §6.12): no app navigation, just the admin sections. While the
 * session is resolving it shows a spinner; anonymous visitors are redirected to
 * the admin login — non-admins never reach here because the bootstrap in
 * AuthContext only marks admins as authenticated.
 */
export function AdminLayout() {
  const t = useT();
  const { status, user, logout } = useAuth();
  const location = useLocation();

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
          <div className="flex min-w-0 items-center gap-6">
            <Wordmark edition="Admin" className="shrink-0 text-xl" />
            <nav
              aria-label="Admin"
              className="no-scrollbar flex min-w-0 items-center gap-1 overflow-x-auto"
            >
              {NAV_SECTIONS.map((section, index) => (
                <div key={section.key} className="flex items-center gap-1">
                  {index > 0 ? (
                    <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-neutral-700" />
                  ) : null}
                  {section.items.map((item) => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      className={({ isActive }) =>
                        cx(
                          'flex min-h-[40px] flex-none items-center whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                          isActive
                            ? 'bg-neutral-800 text-white'
                            : 'text-neutral-400 hover:bg-neutral-800/60 hover:text-neutral-200',
                        )
                      }
                    >
                      {item.labelKey ? t(item.labelKey) : item.label}
                    </NavLink>
                  ))}
                </div>
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
        {/* Keyed on the route so navigating away from a failed page always
            resets the boundary (§7.1) rather than leaving it stuck. */}
        <ErrorBoundary key={location.pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}
