import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';

import { useI18n } from '../../i18n';
import { Wordmark } from '../../components/Wordmark';
import { Disclaimer, ErrorBoundary, TAGLINE } from '../../ui';
import { legalUrl, type LegalPage } from '../legal';
import { CmdKPalette } from './CmdKPalette';
import { NotificationBell } from './NotificationBell';
import { ProfileMenu } from './ProfileMenu';
import { cx } from './ui';

/**
 * Authenticated app shell (PROJECTPLAN.md §7.1, §7.2). The header is the final
 * v2 five-tab structure — **wordmark · Portfolio · Workboard · Assets · Social ·
 * 🔔 · profile icon** — and never grows beyond it; deeper tools live in each
 * section's `SubNav`. Hosts the global ⌘K / Ctrl-K search palette (§6.2)
 * reachable from any route.
 */
const NAV_ITEMS = [
  { to: '/portfolio', labelKey: 'nav.portfolio' },
  { to: '/workboard', labelKey: 'nav.workboard' },
  { to: '/forecast', labelKey: 'nav.forecast' },
  { to: '/expenses', labelKey: 'nav.expenses' },
  { to: '/assets', labelKey: 'nav.assets' },
  { to: '/social', labelKey: 'nav.social' },
] as const;

/**
 * The legal document set on the product site (ask #31 / Play launch). Each page
 * lives at `/<page>/` (EN) with a `/<page>/de/` variant; {@link legalUrl}
 * (shared with the register-form consent notice) builds the actual URL.
 */
const LEGAL_LINKS: ReadonlyArray<{ page: LegalPage; labelKey: string }> = [
  { page: 'terms', labelKey: 'footer.terms' },
  { page: 'privacy', labelKey: 'footer.privacy' },
  { page: 'impressum', labelKey: 'footer.impressum' },
  { page: 'cookies', labelKey: 'footer.cookies' },
];

export function AppLayout() {
  const { t, locale } = useI18n();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const location = useLocation();

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
          <div className="flex min-w-0 items-center gap-4 sm:gap-6">
            <Wordmark edition="Web" className="shrink-0 text-xl" />
            <nav
              aria-label={t('nav.primary')}
              className="no-scrollbar flex min-w-0 gap-1 overflow-x-auto"
            >
              {NAV_ITEMS.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    cx(
                      'flex-none whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors',
                      isActive
                        ? 'bg-neutral-800 text-white'
                        : 'text-neutral-400 hover:bg-neutral-800/60 hover:text-neutral-200',
                    )
                  }
                >
                  {t(item.labelKey)}
                </NavLink>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <button
              type="button"
              onClick={openPalette}
              aria-label={t('nav.openSearch')}
              className={cx(
                'hidden items-center gap-2 rounded-md px-3 py-1.5 text-xs text-neutral-500 sm:flex',
                'ring-1 ring-inset ring-neutral-700 hover:bg-neutral-800 hover:text-neutral-300',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
              )}
            >
              {t('common.search')}
              <kbd className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-neutral-500">
                ⌘K
              </kbd>
            </button>
            <NotificationBell />
            <ProfileMenu />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">
        {/* Keyed on the route so navigating away from a failed page always
            resets the boundary (§7.1) rather than leaving it stuck. */}
        <ErrorBoundary key={location.pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
      <footer className="mx-auto max-w-6xl px-4 pb-8">
        <Disclaimer>{TAGLINE}</Disclaimer>
        <nav
          aria-label={t('footer.legal')}
          className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-neutral-600"
        >
          {LEGAL_LINKS.map((link, index) => (
            <span key={link.page} className="flex items-center gap-x-2">
              {index > 0 ? <span aria-hidden="true">·</span> : null}
              <a
                href={legalUrl(link.page, locale)}
                target="_blank"
                rel="noreferrer"
                className="transition-colors hover:text-neutral-400"
              >
                {t(link.labelKey)}
              </a>
            </span>
          ))}
        </nav>
      </footer>
      <CmdKPalette isOpen={paletteOpen} onClose={closePalette} />
    </div>
  );
}
