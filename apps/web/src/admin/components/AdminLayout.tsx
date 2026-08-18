import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Navigate, Outlet, useLocation } from 'react-router-dom';

import { Wordmark } from '../../components/Wordmark';
import { SUPPORTED_LOCALES, useI18n, useT } from '../../i18n';
import { ErrorBoundary } from '../../ui';
import { useBodyScrollLock } from '../../ui/useBodyScrollLock';
import { useOverlayEscape } from '../../ui/overlayStack';
import { useFocusTrap } from '../../ui/useFocusTrap';
import { useAuth } from '../AuthContext';
import { Button, Spinner, cx } from './ui';

type NavItem = { to: string; labelKey: string };
type NavSection = { key: string; labelKey: string; items: NavItem[] };

// Tailwind's default `md` breakpoint. The drawer is `md:hidden`, so its state
// must retire at the exact same handoff or it can keep the desktop shell inert
// after CSS swaps the mobile chrome out.
const ADMIN_DESKTOP_MEDIA_QUERY = '(min-width: 48rem)';
const ADMIN_DESKTOP_MIN_WIDTH_PX = 768;

/**
 * Light IA regroup (§13.4 V4-P0d): the grown admin surface, ordered into sane
 * sections — People, Configuration, Diagnostics — shown as three groups in the
 * vertical sidebar. Structural tidy only; the deep redesign stays V6-1.
 */
const NAV_SECTIONS: NavSection[] = [
  {
    key: 'people',
    labelKey: 'admin.nav.sections.people',
    items: [
      { to: '/admin/users', labelKey: 'admin.nav.users' },
      { to: '/admin/invites', labelKey: 'admin.nav.invites' },
      { to: '/admin/feedback', labelKey: 'admin.nav.feedback' },
    ],
  },
  {
    key: 'config',
    labelKey: 'admin.nav.sections.configuration',
    items: [
      { to: '/admin/settings', labelKey: 'admin.nav.settings' },
      { to: '/admin/feature-flags', labelKey: 'admin.nav.featureFlags' },
      { to: '/admin/ai', labelKey: 'admin.nav.ai' },
      { to: '/admin/account-defaults', labelKey: 'admin.nav.accountDefaults' },
      { to: '/admin/announcements', labelKey: 'admin.nav.announcements' },
      { to: '/admin/oauth-apps', labelKey: 'admin.nav.oauthApps' },
      { to: '/admin/api-keys', labelKey: 'admin.nav.apiKeys' },
    ],
  },
  {
    key: 'diagnostics',
    labelKey: 'admin.nav.sections.diagnostics',
    items: [
      { to: '/admin/health', labelKey: 'admin.nav.health' },
      { to: '/admin/problems', labelKey: 'admin.nav.problems' },
      { to: '/admin/monitoring', labelKey: 'admin.nav.monitoring' },
      { to: '/admin/usage-analytics', labelKey: 'admin.nav.usageAnalytics' },
      { to: '/admin/email', labelKey: 'admin.nav.email' },
      { to: '/admin/audit', labelKey: 'admin.nav.audit' },
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
  const { locale, setLocale } = useI18n();
  const { status, user, logout } = useAuth();
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const burgerRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const drawerRestoreFocusRef = useRef<HTMLElement>(null);
  const { containerRef: drawerRootRef, onKeyDown: onDrawerKeyDown } = useFocusTrap<HTMLDivElement>({
    active: drawerOpen,
    inertBackground: true,
    restoreFocusRef: drawerRestoreFocusRef,
  });

  const openDrawer = useCallback(() => {
    drawerRestoreFocusRef.current = burgerRef.current;
    setDrawerOpen(true);
  }, []);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
  }, []);

  useOverlayEscape(drawerOpen, closeDrawer, drawerRootRef);
  useBodyScrollLock(drawerOpen);

  // Close the drawer whenever navigation lands on a new admin route. Uses the
  // pathname as the effect key so the setter only runs on real transitions.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  // CSS hides the mobile drawer at `md`, but hidden markup would still own the
  // focus trap and its inert holds. Close it as the desktop sidebar takes over
  // so resizing or rotating a device can never strand the visible shell inert.
  useEffect(() => {
    if (!drawerOpen) return;

    if (typeof window.matchMedia === 'function') {
      const desktop = window.matchMedia(ADMIN_DESKTOP_MEDIA_QUERY);
      const closeOnDesktop = (event: MediaQueryListEvent) => {
        if (event.matches) {
          drawerRestoreFocusRef.current = mainRef.current;
          closeDrawer();
        }
      };

      if (desktop.matches) {
        drawerRestoreFocusRef.current = mainRef.current;
        closeDrawer();
      }
      desktop.addEventListener('change', closeOnDesktop);
      return () => desktop.removeEventListener('change', closeOnDesktop);
    }

    const closeOnDesktop = () => {
      if (window.innerWidth >= ADMIN_DESKTOP_MIN_WIDTH_PX) {
        drawerRestoreFocusRef.current = mainRef.current;
        closeDrawer();
      }
    };

    closeOnDesktop();
    window.addEventListener('resize', closeOnDesktop);
    return () => window.removeEventListener('resize', closeOnDesktop);
  }, [drawerOpen, closeDrawer]);

  if (status === 'loading') {
    return (
      <div className="grid min-h-screen place-items-center bg-neutral-950">
        <Spinner label={t('admin.nav.loading')} />
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
      <nav
        aria-label={t('admin.nav.console')}
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto"
      >
        {NAV_SECTIONS.map((section, index) => (
          <div key={section.key} className="flex flex-col gap-1">
            {index > 0 ? (
              <span aria-hidden="true" className="mb-1 h-px w-full bg-neutral-800" />
            ) : null}
            <h2 className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-neutral-400">
              {t(section.labelKey)}
            </h2>
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
                {t(item.labelKey)}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      <div className="flex shrink-0 flex-col gap-2 border-t border-neutral-800 pt-4">
        <select
          aria-label={t('admin.nav.language')}
          className="h-8 rounded-md bg-neutral-950 px-2 text-sm text-neutral-200 ring-1 ring-inset ring-neutral-700 focus:outline-none focus:ring-2 focus:ring-sky-400"
          onChange={(event) => setLocale(event.target.value)}
          value={locale}
        >
          {SUPPORTED_LOCALES.map((definition) => (
            <option key={definition.code} value={definition.code}>
              {definition.label}
            </option>
          ))}
        </select>
        <span className="truncate px-2 text-sm text-neutral-400">{user.email}</span>
        <Button variant="ghost" className="justify-start" onClick={() => void logout()}>
          {t('auth.common.signOut')}
        </Button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 md:flex">
      <a
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-sky-500 focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-white focus:outline-none focus:ring-2 focus:ring-white"
        href="#main-content"
        onClick={() => document.getElementById('main-content')?.focus()}
      >
        {t('accessibility.skipToContent')}
      </a>
      {/* Mobile-only top bar: burger + wordmark. Hidden at md+ where the sidebar
          is persistent. */}
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-neutral-800 bg-neutral-900 px-4 py-3 md:hidden">
        <button
          ref={burgerRef}
          type="button"
          onClick={openDrawer}
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
        <div
          className="fixed inset-0 z-40 md:hidden"
          onKeyDown={onDrawerKeyDown}
          ref={drawerRootRef}
          role="presentation"
          tabIndex={-1}
        >
          <div className="absolute inset-0 bg-black/70" onClick={closeDrawer} aria-hidden="true" />
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t('admin.nav.menu')}
            className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-neutral-800 shadow-xl"
          >
            {renderSidebar('drawer')}
          </div>
        </div>
      ) : null}

      <main ref={mainRef} id="main-content" className="min-w-0 flex-1" tabIndex={-1}>
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
