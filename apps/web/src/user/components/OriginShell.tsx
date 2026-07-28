import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';

import { useI18n } from '../../i18n';
import { Brandmark, Wordmark } from '../../components/Wordmark';
import { Disclaimer, ErrorBoundary, TAGLINE } from '../../ui';
import { Button, Icon, type IconName } from '../../ui/origin';
import { cx } from '../../lib/cx';
import { legalUrl, type LegalPage } from '../legal';
import { useAuth } from '../AuthContext';
import { PortfolioSwitcher } from '../portfolio/PortfolioSwitcher';
import { CmdKPalette } from './CmdKPalette';
import { NotificationBell } from './NotificationBell';

/**
 * Origin application frame (docs/redesign/REAL_APP_REDESIGN_PROMPT.md,
 * PRODUCT_BLUEPRINT.md §4): a stable left navigation rail with the five suite
 * destinations — Home · Portfolios · Workbench · Assets · People — plus the
 * persistent utilities (Ask BetterTrack, Review, Control Center), a slim
 * contextual top bar (portfolio scope, ⌘K search, Create, notifications) and a
 * mobile bottom bar. The rail collapses to the app mark; preference persists.
 */

const RAIL_STORAGE_KEY = 'bt.rail';

interface SuiteItem {
  to: string;
  icon: IconName;
  labelKey: string;
  /** Match descendant paths too (default true). */
  end?: boolean;
  /** Legacy prefixes that should also light this destination up. */
  also?: readonly string[];
}

const SUITE_ITEMS: readonly SuiteItem[] = [
  { to: '/', icon: 'home', labelKey: 'nav.home', end: true },
  { to: '/portfolio', icon: 'portfolios', labelKey: 'nav.portfolios', also: ['/portfolios'] },
  { to: '/workbench', icon: 'workbench', labelKey: 'nav.workbench', also: ['/workboard', '/forecast'] },
  { to: '/assets', icon: 'assets', labelKey: 'nav.assets' },
  { to: '/people', icon: 'people', labelKey: 'nav.people', also: ['/social'] },
];

const UTILITY_ITEMS: readonly SuiteItem[] = [
  { to: '/ask', icon: 'sparkles', labelKey: 'nav.ask' },
  { to: '/review', icon: 'inbox', labelKey: 'nav.review' },
  { to: '/control', icon: 'grid', labelKey: 'nav.controlCenter', also: ['/settings', '/developer'] },
];

const LEGAL_LINKS: ReadonlyArray<{ page: LegalPage; labelKey: string }> = [
  { page: 'terms', labelKey: 'footer.terms' },
  { page: 'privacy', labelKey: 'footer.privacy' },
  { page: 'impressum', labelKey: 'footer.impressum' },
  { page: 'cookies', labelKey: 'footer.cookies' },
];

function isDestinationActive(item: SuiteItem, pathname: string): boolean {
  if (item.end) return pathname === item.to;
  const prefixes = [item.to, ...(item.also ?? [])];
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function RailItem({
  item,
  pathname,
  collapsed,
  label,
}: {
  item: SuiteItem;
  pathname: string;
  collapsed: boolean;
  label: string;
}) {
  const active = isDestinationActive(item, pathname);
  return (
    <NavLink
      aria-current={active ? 'page' : undefined}
      className={cx('bt-rail-item', active && 'is-active')}
      title={collapsed ? label : undefined}
      to={item.to}
    >
      <Icon name={item.icon} size={17} />
      <span className="bt-rail-item__label">{label}</span>
    </NavLink>
  );
}

/**
 * Brand block: full wordmark + Web signature while the rail is expanded, the
 * compact app mark while collapsed. Both are rendered; CSS picks one, so the
 * media-query auto-collapse below 1180px works without React knowing.
 */
function RailBrand() {
  return (
    <Link className="bt-rail__brand" to="/">
      <span className="bt-rail__brand-full">
        <Wordmark className="text-[17px]" edition="Web" />
      </span>
      <span className="bt-rail__brand-mini">
        <Brandmark className="text-[15px]" />
      </span>
    </Link>
  );
}

function AccountMenu({ collapsed }: { collapsed: boolean }) {
  const { t } = useI18n();
  const { user, logout, toggleDiscreetMode } = useAuth();
  const [open, setOpen] = useState(false);
  const [discreetError, setDiscreetError] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const discreet = user?.discreetMode === true;
  const name = user?.username ?? user?.email ?? '·';

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="relative" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t('nav.accountMenu')}
        className="bt-rail__account"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span aria-hidden className="bt-avatar">
          {name.charAt(0).toUpperCase()}
        </span>
        <span className="bt-rail__account-name">{name}</span>
        <Icon className="bt-rail__account-more" name="more" size={15} />
      </button>

      {open ? (
        <div
          aria-label={t('nav.account')}
          className="bt-popover"
          role="menu"
          style={{ bottom: 'calc(100% + 6px)', left: 0, right: collapsed ? 'auto' : 0 }}
        >
          {user ? (
            <div style={{ padding: '7px 9px 9px' }}>
              <p className="bt-row-title" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {user.username}
              </p>
              <p className="bt-row-sub" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {user.email}
              </p>
            </div>
          ) : null}
          <div className="bt-menu-rule" />
          <Link className="bt-menu-item" onClick={() => setOpen(false)} role="menuitem" to="/people/profile">
            <Icon name="user" size={15} />
            {t('nav.myProfile')}
          </Link>
          <Link
            className="bt-menu-item"
            onClick={() => setOpen(false)}
            role="menuitem"
            to="/settings/account"
          >
            <Icon name="settings" size={15} />
            {t('nav.settings')}
          </Link>
          <button
            aria-checked={discreet}
            className="bt-menu-item"
            onClick={async () => {
              setDiscreetError(false);
              try {
                await toggleDiscreetMode();
              } catch {
                setDiscreetError(true);
              }
            }}
            role="menuitemcheckbox"
            type="button"
          >
            <Icon name={discreet ? 'eye-off' : 'eye'} size={15} />
            <span style={{ flex: 1 }}>{t('nav.discreetMode')}</span>
            <span aria-hidden className={cx('bt-dot', discreet && 'bt-dot--gold')} />
          </button>
          {discreetError ? (
            <p className="bt-field__error" role="alert" style={{ padding: '2px 9px 6px' }}>
              {t('nav.discreetModeError')}
            </p>
          ) : null}
          <div className="bt-menu-rule" />
          <button
            className="bt-menu-item"
            onClick={() => {
              setOpen(false);
              void logout();
            }}
            role="menuitem"
            type="button"
          >
            <Icon name="logout" size={15} />
            {t('nav.logout')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function CreateMenu() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const items: ReadonlyArray<{ to: string; icon: IconName; labelKey: string }> = [
    { to: '/portfolio/activity?create=trade', icon: 'assets', labelKey: 'create.trade' },
    { to: '/portfolio/cash-flow?create=transaction', icon: 'cash', labelKey: 'create.cashFlow' },
    { to: '/portfolio/cash?create=transfer', icon: 'wallet', labelKey: 'create.transfer' },
    { to: '/workbench/blueprints/new', icon: 'layers', labelKey: 'create.blueprint' },
    { to: '/assets/watchlists?create=1', icon: 'star', labelKey: 'create.watchlist' },
    { to: '/workbench/alerts?create=1', icon: 'bell', labelKey: 'create.alert' },
    { to: '/workbench/ideas?create=1', icon: 'sparkles', labelKey: 'create.idea' },
    { to: '/portfolios?create=1', icon: 'portfolios', labelKey: 'create.portfolio' },
  ];

  return (
    <div className="relative" ref={rootRef}>
      <Button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t('create.button')}
        icon="plus"
        onClick={() => setOpen((value) => !value)}
        variant="primary"
      >
        <span className="bt-hide-below-sm">{t('create.button')}</span>
      </Button>
      {open ? (
        <div
          aria-label={t('create.button')}
          className="bt-popover"
          role="menu"
          style={{ top: 'calc(100% + 6px)', right: 0 }}
        >
          {items.map((item) => (
            <Link
              className="bt-menu-item"
              key={item.to}
              onClick={() => setOpen(false)}
              role="menuitem"
              to={item.to}
            >
              <Icon name={item.icon} size={15} />
              {t(item.labelKey)}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function OriginShell() {
  const { t, locale } = useI18n();
  const location = useLocation();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(RAIL_STORAGE_KEY) === 'collapsed';
    } catch {
      return false;
    }
  });

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, []);

  function toggleRail() {
    setCollapsed((value) => {
      const next = !value;
      try {
        localStorage.setItem(RAIL_STORAGE_KEY, next ? 'collapsed' : 'expanded');
      } catch {
        // Preference persistence is best-effort only.
      }
      return next;
    });
  }

  const { pathname } = location;
  const portfolioScoped =
    pathname === '/portfolio' || pathname.startsWith('/portfolio/') || pathname === '/portfolios';

  return (
    <div className="bt-app">
      <div className="bt-shell" data-rail={collapsed ? 'collapsed' : 'expanded'}>
        <aside className="bt-rail">
          <RailBrand />
          <nav aria-label={t('nav.primary')} className="bt-rail__group">
            {SUITE_ITEMS.map((item) => (
              <RailItem
                collapsed={collapsed}
                item={item}
                key={item.to}
                label={t(item.labelKey)}
                pathname={pathname}
              />
            ))}
          </nav>
          <div className="bt-rail__rule" />
          <nav aria-label={t('nav.utilities')} className="bt-rail__group">
            {UTILITY_ITEMS.map((item) => (
              <RailItem
                collapsed={collapsed}
                item={item}
                key={item.to}
                label={t(item.labelKey)}
                pathname={pathname}
              />
            ))}
          </nav>
          <div className="bt-rail__spacer" />
          <AccountMenu collapsed={collapsed} />
        </aside>

        <div className="bt-main">
          <header className="bt-topbar">
            <Button
              aria-label={collapsed ? t('nav.expandRail') : t('nav.collapseRail')}
              className="bt-hide-below-md"
              icon="collapse"
              iconOnly
              onClick={toggleRail}
              size="sm"
              variant="quiet"
            />
            <span className="bt-hide-above-md">
              <RailBrand />
            </span>
            {portfolioScoped ? <PortfolioSwitcher /> : null}
            <div className="bt-topbar__spacer" />
            <button
              aria-label={t('nav.openSearch')}
              className="bt-btn bt-btn--sm bt-hide-below-sm"
              onClick={openPalette}
              type="button"
            >
              <Icon name="search" size={14} />
              {t('common.search')}
              <kbd className="bt-kbd">⌘K</kbd>
            </button>
            <Button
              aria-label={t('nav.openSearch')}
              className="bt-hide-above-sm"
              icon="search"
              iconOnly
              onClick={openPalette}
              size="sm"
              variant="quiet"
            />
            <CreateMenu />
            <NotificationBell />
          </header>

          <main className="bt-canvas">
            <ErrorBoundary key={pathname}>
              <Outlet />
            </ErrorBoundary>
            <footer style={{ marginTop: 56 }}>
              <Disclaimer>{TAGLINE}</Disclaimer>
              <nav
                aria-label={t('footer.legal')}
                className="bt-meta"
                style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px', marginTop: 6 }}
              >
                {LEGAL_LINKS.map((link) => (
                  <a
                    href={legalUrl(link.page, locale)}
                    key={link.page}
                    rel="noreferrer"
                    style={{ color: 'var(--bt-faint)', textDecoration: 'none' }}
                    target="_blank"
                  >
                    {t(link.labelKey)}
                  </a>
                ))}
              </nav>
            </footer>
          </main>
        </div>
      </div>

      {/* Mobile primary nav — CSS-hidden on desktop (display:none removes it
          from the a11y tree there), so the duplicate landmark name is fine. */}
      <nav aria-label={t('nav.primary')} className="bt-bottombar">
        {SUITE_ITEMS.map((item) => {
          const active = isDestinationActive(item, pathname);
          return (
            <NavLink
              aria-current={active ? 'page' : undefined}
              className={cx(active && 'is-active')}
              key={item.to}
              to={item.to}
            >
              <Icon name={item.icon} size={19} />
              {t(item.labelKey)}
            </NavLink>
          );
        })}
      </nav>

      <CmdKPalette isOpen={paletteOpen} onClose={closePalette} />
    </div>
  );
}
