import { useCallback, useEffect, useRef, useState } from 'react';
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
 * sections — People, Configuration, Diagnostics — shown as three groups in the
 * vertical sidebar. Structural tidy only; the deep redesign stays V6-1.
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
 *
 * Layout (issue #522): a persistent vertical left sidebar on desktop, an
 * off-canvas drawer behind a burger button on small viewports. The horizontal
 * top nav was clipping once the V4-P0d IA regroup landed more sections; a
 * sidebar scales with content instead. The full mobile sweep stays V5-P13b and
 * the deep admin redesign stays V6-1.
 */
export function AdminLayout() {
  const t = useT();
  const { status, user, logout } = useAuth();
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const burgerRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
  }, []);

  // Close the drawer whenever navigation lands on a new admin route. Uses the
  // pathname as the effect key so the setter only runs on real transitions.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  // While the drawer is open: lock body scroll, close on Escape, and trap Tab
  // inside the drawer. Focus jumps to the first focusable on open and restores
  // to the burger button on close so the keyboard path never leaves the sidebar.
  useEffect(() => {
    if (!drawerOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const focusables = () =>
      drawerRef.current
        ? Array.from(
            drawerRef.current.querySelectorAll<HTMLElement>(
              'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ),
          )
        : [];

    focusables()[0]?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeDrawer();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !drawerRef.current?.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      // Restore focus to the burger so the tab order continues from the trigger.
      burgerRef.current?.focus();
    };
  }, [drawerOpen, closeDrawer]);

  if (status === 'loading') {
    return (
      <div className="grid min-h-screen place-items-center bg-neutral-950">
        <Spinner label="Loading admin console…" />
      </div>
    );
  }
  if (status === 'anonymous' || !user) return <Navigate to="/admin/login" replace />;

  const renderSidebar = (variant: 'desktop' | 'drawer') => (
    <div className="flex h-full min-h-0 flex-col gap-4 bg-neutral-900 p-4">
      <div className="flex shrink-0 items-center justify-between gap-2 px-2">
        <Wordmark edition="Admin" className="text-xl" />
        {variant === 'drawer' ? (
          <button
            type="button"
            onClick={closeDrawer}
            aria-label={t('admin.nav.closeMenu')}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md text-neutral-300 hover:bg-neutral-800 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="6" y1="18" x2="18" y2="6" />
            </svg>
          </button>
        ) : null}
      </div>
      <nav aria-label="Admin" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
        {NAV_SECTIONS.map((section, index) => (
          <div key={section.key} className="flex flex-col gap-1">
            {index > 0 ? (
              <span aria-hidden="true" className="mb-1 h-px w-full bg-neutral-800" />
            ) : null}
            {section.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  cx(
                    'flex min-h-[40px] items-center rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
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
      <div className="flex shrink-0 flex-col gap-2 border-t border-neutral-800 pt-4">
        <span className="truncate px-2 text-sm text-neutral-400">{user.email}</span>
        <Button variant="ghost" className="justify-start" onClick={() => void logout()}>
          Sign out
        </Button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 md:flex">
      {/* Mobile-only top bar: burger + wordmark. Hidden at md+ where the sidebar
          is persistent. */}
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-neutral-800 bg-neutral-900 px-4 py-3 md:hidden">
        <button
          ref={burgerRef}
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label={t('admin.nav.openMenu')}
          aria-expanded={drawerOpen}
          aria-controls="admin-sidebar"
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-neutral-300 hover:bg-neutral-800 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="4" y1="6" x2="20" y2="6" />
            <line x1="4" y1="12" x2="20" y2="12" />
            <line x1="4" y1="18" x2="20" y2="18" />
          </svg>
        </button>
        <Wordmark edition="Admin" className="text-lg" />
      </header>

      {/* Persistent desktop sidebar. Sticky so it stays visible while the main
          column scrolls; the nav itself scrolls if its section list overflows. */}
      <aside
        id="admin-sidebar"
        className="hidden w-64 shrink-0 border-r border-neutral-800 md:sticky md:top-0 md:block md:h-screen"
      >
        {renderSidebar('desktop')}
      </aside>

      {/* Mobile drawer: backdrop + slide-in panel. Rendered only while open so
          the focus trap and body-scroll lock stay scoped to the visible dialog. */}
      {drawerOpen ? (
        <div className="fixed inset-0 z-40 md:hidden" role="presentation">
          <div className="absolute inset-0 bg-black/70" onClick={closeDrawer} aria-hidden="true" />
          <div
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label={t('admin.nav.menu')}
            className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-neutral-800 shadow-xl"
          >
            {renderSidebar('drawer')}
          </div>
        </div>
      ) : null}

      <main className="min-w-0 flex-1">
        <div className="mx-auto max-w-5xl px-4 py-8">
          {/* Keyed on the route so navigating away from a failed page always
              resets the boundary (§7.1) rather than leaving it stuck. */}
          <ErrorBoundary key={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </div>
      </main>
    </div>
  );
}
