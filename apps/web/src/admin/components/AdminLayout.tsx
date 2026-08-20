import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Navigate, Outlet, useLocation } from 'react-router-dom';

import { Wordmark } from '../../components/Wordmark';
import { SUPPORTED_LOCALES, useI18n, useT } from '../../i18n';
import { ErrorBoundary } from '../../ui';
import { useBodyScrollLock } from '../../ui/useBodyScrollLock';
import { useOverlayEscape } from '../../ui/overlayStack';
import { useFocusTrap } from '../../ui/useFocusTrap';
import { useAuth } from '../AuthContext';
import { ADMIN_WORKSPACES, isWideAdminPath } from '../adminWorkspaces';
import { AdminCommandPalette } from './AdminCommandPalette';
import { Button, Spinner, cx } from './ui';

// Tailwind's default `md` breakpoint. The drawer is `md:hidden`, so its state
// must retire at the exact same handoff or it can keep the desktop shell inert
// after CSS swaps the mobile chrome out.
const ADMIN_DESKTOP_MEDIA_QUERY = '(min-width: 48rem)';
const ADMIN_DESKTOP_MIN_WIDTH_PX = 768;

const NAV_LINK_BASE =
  'flex min-h-[40px] items-center rounded-md px-3 py-1.5 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400';

function navLinkClass({ isActive }: { isActive: boolean }): string {
  return cx(
    NAV_LINK_BASE,
    'font-medium',
    isActive
      ? 'bg-neutral-800 text-white'
      : 'text-neutral-400 hover:bg-neutral-800/60 hover:text-neutral-200',
  );
}

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
 * sidebar scales with content instead.
 *
 * IA (#1406 W1): six operator workspaces from `adminWorkspaces.ts` — Overview,
 * Support, People, Operations, Product & Comms, Security & API — replace the
 * old People/Configuration/Diagnostics grouping. A workspace that owns a landing
 * page renders its label as the link to it; the pages inside it stay listed
 * underneath until W2–W6 fold them into tabs. The shell also hosts the ⌘K
 * palette and gives the dense operator workspaces a wider content column.
 */
export function AdminLayout() {
  const t = useT();
  const { locale, setLocale } = useI18n();
  const { status, user, logout } = useAuth();
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
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

  // The palette is a body-level overlay. Opening it from inside the drawer would
  // leave the drawer's inert background holding the console, so the drawer
  // always retires first.
  const openPalette = useCallback(() => {
    setDrawerOpen(false);
    setPaletteOpen(true);
  }, []);

  const closePalette = useCallback(() => setPaletteOpen(false), []);

  useOverlayEscape(drawerOpen, closeDrawer, drawerRootRef);
  useBodyScrollLock(drawerOpen);

  // ⌘K / Ctrl-K anywhere in the console. Registered on the window so it works
  // from any page without every page knowing the palette exists.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (event.key !== 'k' && event.key !== 'K') return;
      event.preventDefault();
      openPalette();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [openPalette]);

  // A route change closes the palette the same way it closes the drawer, so a
  // navigation from a result never leaves the overlay hanging over the target.
  useEffect(() => {
    setPaletteOpen(false);
  }, [location.pathname]);

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

  const wide = isWideAdminPath(location.pathname);

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
      <button
        type="button"
        onClick={openPalette}
        className="flex min-h-[36px] shrink-0 items-center justify-between gap-2 rounded-md bg-neutral-950 px-3 py-1.5 text-sm text-neutral-400 ring-1 ring-inset ring-neutral-700 transition-colors hover:text-neutral-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        <span className="truncate">{t('admin.palette.trigger')}</span>
        <kbd className="rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 font-sans text-[10px] text-neutral-400">
          {t('admin.palette.shortcut')}
        </kbd>
      </button>
      <nav
        aria-label={t('admin.nav.console')}
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto"
      >
        {ADMIN_WORKSPACES.map((workspace, index) => (
          <div key={workspace.key} className="flex flex-col gap-1">
            {index > 0 ? (
              <span aria-hidden="true" className="mb-1 h-px w-full bg-neutral-800" />
            ) : null}
            {/* A workspace with a landing page carries the link on its own
                heading, so the label is never duplicated as a child row. */}
            <h2 className="text-sm font-semibold text-neutral-200">
              {workspace.to ? (
                <NavLink end to={workspace.to} className={navLinkClass}>
                  {t(workspace.labelKey)}
                </NavLink>
              ) : (
                <span className="flex min-h-[32px] items-center px-3">{t(workspace.labelKey)}</span>
              )}
            </h2>
            {workspace.pages.map((page) => (
              <NavLink
                key={page.to}
                to={page.to}
                className={(state) => cx(navLinkClass(state), 'pl-6')}
              >
                {t(page.labelKey)}
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
        <button
          type="button"
          onClick={openPalette}
          aria-label={t('admin.palette.trigger')}
          className="ml-auto inline-flex h-9 w-9 items-center justify-center rounded-md text-neutral-300 hover:bg-neutral-800 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
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
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </button>
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
        {/* Per-page width opt-in (#1406 W1): the dense operator workspaces get a
            wider column; everything else keeps the established reading width. */}
        <div className={cx('mx-auto px-4 py-8', wide ? 'max-w-7xl' : 'max-w-5xl')}>
          {/* Keyed on the route so navigating away from a failed page always
              resets the boundary (§7.1) rather than leaving it stuck. */}
          <ErrorBoundary key={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </div>
      </main>

      <AdminCommandPalette isOpen={paletteOpen} onClose={closePalette} />
    </div>
  );
}
