// Aliased: the bare `MouseEvent` name is the DOM one the popover
// document-listeners below are typed against.
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { Link, NavLink, Outlet, useLocation, useSearchParams } from 'react-router-dom';

import { useI18n } from '../../i18n';
import { Brandmark, Wordmark } from '../../components/Wordmark';
import { Disclaimer, ErrorBoundary, Skeleton, TAGLINE } from '../../ui';
import { Button, Icon, type IconName } from '../../ui/origin';
import { cx } from '../../lib/cx';
import { legalUrl, type LegalPage } from '../legal';
import { useAuth } from '../AuthContext';
import { useCompactShell, usePhoneShell } from '../hooks/useCompactShell';
import { ACTIVE_PORTFOLIO_PARAM, PortfolioSwitcher } from '../portfolio/PortfolioSwitcher';
import { useResolvedPrivacyMode, useResolvedPrivacyModeState } from '../vault/usePrivacyMode';
import { isParanoidKilledPath } from '../vault/ui/ParanoidSurfaceGate';
import { useOptionalVaultRuntime } from '../vault/VaultRuntimeContext';
import { Avatar } from './Avatar';
import {
  ASK_DOCK_ID,
  AskDock,
  toggleAskDock,
  useAskDockEligible,
  useAskDockState,
} from './askdock';
import { CmdKPalette } from './CmdKPalette';
import { CREATE_COMMANDS, commandPath, withPortfolioScope } from './commands';
import { usePreservedSearch } from './LocalNav';
import { NotificationBell } from './NotificationBell';
import { isChildActive, SECTION_NAV, useRailNavChildren, type SectionKey } from './sectionNav';
import { useDiscardUnknownCreateIntent } from './useCreateIntent';
import { useMenuKeyboard } from './useMenuKeyboard';

const VaultSyncChip = lazy(() =>
  import('../vault/ui/VaultSyncChip').then((module) => ({ default: module.VaultSyncChip })),
);

/**
 * Origin application frame (docs/redesign/REAL_APP_REDESIGN_PROMPT.md,
 * PRODUCT_BLUEPRINT.md §4): a stable left navigation rail with the five suite
 * destinations — Home · Portfolios · Workbench · Assets · People — plus the
 * persistent utilities (Ask BetterTrack, Review, Control Center), a slim
 * contextual top bar (portfolio scope, ⌘K search, Create, notifications) and a
 * mobile bottom bar.
 *
 * R2: the four sections with sub-navigation are expandable groups whose
 * children come from `sectionNav.ts` — the same table the in-page strips read.
 * A group row navigates to its section; clicking the row of the section you are
 * already in — or its chevron — opens/closes that section's tree. At most one
 * tree is open and it is always the active section's, so Home and the utility
 * destinations show everything minimized. Expanded-ness itself is sticky: it
 * rides along as you move between sections until you toggle it off. Only the
 * rail-collapse preference persists in `localStorage`.
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
  /** Destinations with sub-navigation render as an expandable rail group. */
  section?: SectionKey;
}

const SUITE_ITEMS: readonly SuiteItem[] = [
  { to: '/', icon: 'home', labelKey: 'nav.home', end: true },
  {
    to: '/portfolio',
    icon: 'portfolios',
    labelKey: 'nav.portfolios',
    also: ['/portfolios'],
    section: 'portfolio',
  },
  {
    to: '/workbench',
    icon: 'workbench',
    labelKey: 'nav.workbench',
    also: ['/workboard', '/forecast'],
    section: 'workbench',
  },
  { to: '/assets', icon: 'assets', labelKey: 'nav.assets', section: 'assets' },
  { to: '/people', icon: 'people', labelKey: 'nav.people', also: ['/social'], section: 'people' },
];

/** The section that owns the current route, if any. */
function activeSection(pathname: string): SectionKey | null {
  const hit = SUITE_ITEMS.find(
    (item) => item.section !== undefined && isDestinationActive(item, pathname),
  );
  return hit?.section ?? null;
}

const UTILITY_ITEMS: readonly SuiteItem[] = [
  { to: '/ask', icon: 'sparkles', labelKey: 'nav.ask' },
  { to: '/review', icon: 'inbox', labelKey: 'nav.review' },
  {
    to: '/control',
    icon: 'grid',
    labelKey: 'nav.controlCenter',
    also: ['/settings', '/developer'],
  },
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
      <Icon name={item.icon} size={18} />
      <span className="bt-rail-item__label">{label}</span>
    </NavLink>
  );
}

/**
 * The Ask BetterTrack utility row (R2). On a wide viewport it TOGGLES the
 * floating AI panel instead of navigating — same icon, same label, same
 * `bt-rail-item` styling as its neighbours, with `aria-expanded` carrying the
 * state and an open panel lighting the row the way an active route would.
 * Narrow viewports fall through to the plain link, because the panel doesn't
 * exist there and `/ask` must stay reachable from the rail either way.
 */
function RailAskToggle({
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
  const { open } = useAskDockState();
  const eligible = useAskDockEligible();

  if (!eligible) {
    return <RailItem collapsed={collapsed} item={item} label={label} pathname={pathname} />;
  }

  const active = open || isDestinationActive(item, pathname);
  return (
    <button
      aria-controls={ASK_DOCK_ID}
      aria-expanded={open}
      className={cx('bt-rail-item', active && 'is-active')}
      onClick={toggleAskDock}
      title={collapsed ? label : undefined}
      type="button"
    >
      <Icon name={item.icon} size={18} />
      <span className="bt-rail-item__label">{label}</span>
    </button>
  );
}

/**
 * An expandable suite destination: the row itself links to the section root,
 * the chevron beside it toggles the tree without navigating, and the children
 * are the section's own tabs (`sectionNav.ts`), portfolio scope included.
 *
 * The children and the chevron are always rendered; CSS removes them whenever
 * the rail is narrow — the explicit collapsed state *and* the ≤1180px
 * auto-collapse — so the media-query collapse keeps working without React
 * knowing about it (same contract as {@link RailBrand}).
 */
function RailGroup({
  item,
  section,
  pathname,
  collapsed,
  expanded,
  label,
  onToggle,
}: {
  item: SuiteItem;
  section: SectionKey;
  pathname: string;
  collapsed: boolean;
  expanded: boolean;
  label: string;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  // The tree renders the curated vital pages; "is a child page open?" is
  // answered against the FULL set, so the group row never claims
  // aria-current="page" while a strip-only page (Tax, Analysis…) is open.
  const children = useRailNavChildren(section);
  const search = usePreservedSearch(SECTION_NAV[section].preserveParams);
  const active = isDestinationActive(item, pathname);
  const childActive =
    !collapsed && SECTION_NAV[section].children.some((child) => isChildActive(child, pathname));
  // Clicking the row of the ALREADY-SELECTED section ONLY toggles its dropdown
  // (owner) — it does not yank you from, say, Cash flow back to Overview; the
  // tree's own "Overview" child is how you get there. Any other row navigates,
  // and the tree opens or not per the shell's sticky expansion preference.
  const onRowClick = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (!active) return;
    event.preventDefault();
    onToggle();
  };
  const panelId = `bt-rail-group-${section}`;

  return (
    <div className={cx('bt-rail-group', expanded && 'is-open')}>
      <div className={cx('bt-rail-item', 'bt-rail-item--group', active && 'is-active')}>
        {/* A plain Link, not a NavLink: the row's own `also`-aware active state
            drives the surface, and "current" belongs to the open child whenever
            one matches (NavLink would force aria-current="page" here too). */}
        <Link
          aria-current={active && !childActive ? 'page' : undefined}
          className="bt-rail-item__link"
          onClick={onRowClick}
          title={collapsed ? label : undefined}
          to={item.to}
        >
          <Icon name={item.icon} size={18} />
          <span className="bt-rail-item__label">{label}</span>
        </Link>
        <button
          aria-controls={panelId}
          aria-expanded={expanded}
          aria-label={
            expanded
              ? t('nav.collapseSection', { section: label })
              : t('nav.expandSection', { section: label })
          }
          className="bt-rail-item__chevron"
          onClick={onToggle}
          type="button"
        >
          <Icon name="chevron-right" size={13} />
        </button>
      </div>
      <div className="bt-rail-group__children" id={panelId}>
        <div className="bt-rail-group__list">
          {children.map((child) => (
            <NavLink
              className={({ isActive }) => cx('bt-rail-child', isActive && 'is-active')}
              end={child.end}
              key={child.to}
              to={search ? { pathname: child.to, search } : child.to}
            >
              <span className="bt-rail-child__label">{t(child.labelKey)}</span>
              {child.parked ? (
                <span
                  aria-label={t('common.parked')}
                  className="bt-dot bt-dot--gold"
                  role="img"
                  title={t('common.parked')}
                />
              ) : null}
            </NavLink>
          ))}
        </div>
      </div>
    </div>
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

/**
 * The account / organization switcher — a PERSISTENT utility (see
 * docs/redesign/PRODUCT_BLUEPRINT.md §4), i.e. reachable at every width like
 * Create and Notifications. It renders at the foot of the rail on desktop
 * (`placement="rail"`, the documented lower-left position) and, once the rail is
 * hidden, as a compact avatar trigger in the topbar (`placement="topbar"`).
 * Exactly ONE instance is ever mounted — the shell picks the placement from
 * {@link useCompactShell} rather than rendering both and hiding one in CSS, so
 * "Account menu" stays a single, unambiguous accessible control.
 *
 * Exported for OriginShell.account.test.tsx only — nothing else may mount it.
 */
export function AccountMenu({
  collapsed,
  placement = 'rail',
}: {
  collapsed: boolean;
  placement?: 'rail' | 'topbar';
}) {
  const inTopbar = placement === 'topbar';
  const { t } = useI18n();
  const { user, logout, toggleDiscreetMode } = useAuth();
  const privacyMode = useResolvedPrivacyMode();
  const vault = useOptionalVaultRuntime();
  const [open, setOpen] = useState(false);
  const [discreetError, setDiscreetError] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const discreet = user?.discreetMode === true;
  const name = user?.username ?? user?.email ?? '·';
  const closeMenu = useCallback(() => setOpen(false), []);
  const {
    closeAndRestoreFocus,
    menuRef,
    onKeyDown: onMenuKeyDown,
  } = useMenuKeyboard({
    open,
    onClose: closeMenu,
    triggerRef,
  });

  // Escape is arbitrated by the shared overlay stack inside `useMenuKeyboard`;
  // only the click-away belongs to this shell.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        closeAndRestoreFocus();
      }
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [closeAndRestoreFocus, open]);

  return (
    <div className="relative" ref={rootRef}>
      <button
        ref={triggerRef}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t('nav.accountMenu')}
        className={inTopbar ? 'bt-topbar__account' : 'bt-rail__account'}
        data-testid={inTopbar ? 'topbar-account-trigger' : undefined}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        {/* The account row wears the user's real public-profile icon (owner) —
            the same curated avatar every social surface shows, so the rail and
            the profile can never disagree. */}
        <Avatar iconId={user?.profileIcon} name={name} size="sm" />
        {/* The topbar trigger is the avatar alone — a phone topbar has no room
            for the name, and the menu itself repeats it in the header row. */}
        {inTopbar ? null : (
          <>
            <span className="bt-rail__account-name">{name}</span>
            <Icon className="bt-rail__account-more" name="more" size={15} />
          </>
        )}
      </button>

      {open ? (
        <div
          ref={menuRef}
          aria-label={t('nav.account')}
          className="bt-popover"
          onKeyDown={onMenuKeyDown}
          role="menu"
          // The rail sits at the foot of the viewport, so its menu rises; the
          // topbar's hangs down from the trigger and is right-anchored.
          style={
            inTopbar
              ? { top: 'calc(100% + 6px)', right: 0 }
              : { bottom: 'calc(100% + 6px)', left: 0, right: collapsed ? 'auto' : 0 }
          }
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
          {privacyMode !== 'paranoid' ? (
            <Link
              className="bt-menu-item"
              onClick={closeAndRestoreFocus}
              role="menuitem"
              to="/people/profile"
            >
              <Icon name="user" size={15} />
              {t('nav.myProfile')}
            </Link>
          ) : null}
          <Link
            className="bt-menu-item"
            onClick={closeAndRestoreFocus}
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
          {privacyMode === 'paranoid' ? (
            <button
              className="bt-menu-item"
              onClick={() => {
                closeAndRestoreFocus();
                void vault?.lock();
              }}
              role="menuitem"
              type="button"
            >
              <Icon name="lock" size={15} />
              {t('vault.lock.action')}
            </button>
          ) : null}
          <div className="bt-menu-rule" />
          <button
            className="bt-menu-item"
            onClick={() => {
              closeAndRestoreFocus();
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

/**
 * The global "+ Create" menu. Every entry here starts a real flow on its
 * destination (#1071) — an entry whose destination cannot run the flow does not
 * belong in the menu at all.
 *
 * Exported for OriginShell.create.test.tsx only — nothing else may mount it.
 */
export function CreateMenu() {
  const { t } = useI18n();
  const paranoid = useResolvedPrivacyMode() === 'paranoid';
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => setOpen(false), []);
  const {
    closeAndRestoreFocus,
    menuRef,
    onKeyDown: onMenuKeyDown,
  } = useMenuKeyboard({
    open,
    onClose: closeMenu,
    triggerRef,
  });

  // Escape is arbitrated by the shared overlay stack inside `useMenuKeyboard`;
  // only the click-away belongs to this shell.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        closeAndRestoreFocus();
      }
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [closeAndRestoreFocus, open]);

  // Portfolio-scoped create actions must open on the portfolio the user is
  // looking at, not the default one (see `withPortfolioScope`) — the shell is
  // the one surface these links leave from, so it is where the scope is added.
  const [searchParams] = useSearchParams();
  const activePortfolioId = searchParams.get(ACTIVE_PORTFOLIO_PARAM);

  // ONE list, shared with the ⌘K palette (`CREATE_COMMANDS`): the menu keeping
  // its own copy is how an entry could point at a destination that ran no flow
  // (#1071). The cash ledger is a surface paranoid mode kills, so its entry
  // would only bounce off `ParanoidNavigationGate` — dropped here exactly as
  // the palette drops it.
  const items = CREATE_COMMANDS.filter(
    (item) => !paranoid || !isParanoidKilledPath(commandPath(item.to)),
  );

  return (
    <div className="relative" ref={rootRef}>
      <Button
        ref={triggerRef}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t('create.button')}
        data-testid="global-create-trigger"
        icon="plus"
        onClick={() => setOpen((value) => !value)}
        variant="primary"
      >
        <span className="bt-hide-below-sm">{t('create.button')}</span>
      </Button>
      {open ? (
        <div
          ref={menuRef}
          aria-label={t('create.button')}
          className="bt-popover"
          onKeyDown={onMenuKeyDown}
          role="menu"
          style={{ top: 'calc(100% + 6px)', right: 0 }}
        >
          {items.map((item) => (
            <Link
              className="bt-menu-item"
              key={item.labelKey}
              onClick={closeAndRestoreFocus}
              role="menuitem"
              to={item.scoped ? withPortfolioScope(item.to, activePortfolioId) : item.to}
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

/**
 * The suite section a path belongs to — `/portfolio/cash/labels` → `portfolio`,
 * `/` → `home`. Every route inside one section shares a mounted layout, so this
 * is the granularity at which the shell's loading boundary is allowed to reset.
 */
function sectionKey(pathname: string): string {
  return pathname.split('/')[1] || 'home';
}

export function OriginShell() {
  const { t, locale } = useI18n();
  useDiscardUnknownCreateIntent();
  const privacy = useResolvedPrivacyModeState();
  const location = useLocation();
  const { pathname } = location;
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The rail is display:none at this width, so anything that lives only inside
  // it has to be rendered elsewhere (see the topbar's AccountMenu).
  const compactShell = useCompactShell();
  // Narrower still, the topbar wraps and the switcher owns the second row — so
  // the shell MOVES it to the end of the header's children (see below).
  const phoneShell = usePhoneShell();
  // The shell root lets the ⌘K guard distinguish an ordinary blocking modal
  // from the Control Center, above which the body-portalled palette may open.
  const shellRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(RAIL_STORAGE_KEY) === 'collapsed';
    } catch {
      return false;
    }
  });
  // At most ONE tree is open, and it is always the active section's.
  const [openGroup, setOpenGroup] = useState<SectionKey | null>(null);
  // Whether trees are shown expanded — a sticky preference that RIDES ALONG on
  // navigation (owner): leave an expanded section and the next one you select
  // is expanded too; leave a closed one and the next stays closed. Closed on a
  // first visit; only an explicit toggle changes it. A ref, not state: it never
  // needs to trigger a render of its own, and keeping it out of the navigation
  // effect's deps is what stops a toggle from re-running that effect.
  const expandedPrefRef = useRef(false);

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);

  useEffect(() => {
    const section = activeSection(pathname);
    setOpenGroup(section !== null && expandedPrefRef.current ? section : null);
  }, [pathname]);

  const toggleGroup = useCallback(
    (section: SectionKey) => {
      const next = openGroup === section ? null : section;
      expandedPrefRef.current = next !== null;
      setOpenGroup(next);
    },
    [openGroup],
  );

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        // A regular modal makes the shell inert and owns the shortcut. Control
        // Center now does the same for accessibility, but the palette is an
        // intentional layer above that hub. Permit that one live body-level
        // overlay; a nested modal makes the Control Center inert too and keeps
        // the shortcut blocked. An open palette can always be closed.
        const shell = shellRef.current;
        const controlCenter = document.querySelector<HTMLElement>('.bt-cc-root');
        const liveControlCenter =
          controlCenter !== null && controlCenter.closest('[inert]') === null;
        if (
          !paletteOpen &&
          shell !== null &&
          shell.closest('[inert]') !== null &&
          !liveControlCenter
        ) {
          return;
        }
        setPaletteOpen((open) => !open);
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [paletteOpen]);

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

  const portfolioScoped =
    pathname === '/portfolio' || pathname.startsWith('/portfolio/') || pathname === '/portfolios';
  /**
   * Rendered in exactly ONE topbar slot per width — never both, never reordered
   * in CSS. Above {@link PHONE_SHELL_MAX_WIDTH} it sits beside the brand, on the
   * one header row; at or below it the header wraps and the switcher takes the
   * full second row, so it has to be the header's LAST child there too. Flex
   * `order` moves pixels only: leaving the switcher first in the DOM sent Tab
   * from the second row back up to the first (WCAG 1.3.2 / 2.4.3). Same
   * JS-at-the-breakpoint move the AccountMenu makes at the rail's width.
   */
  const portfolioSwitcher = portfolioScoped ? <PortfolioSwitcher /> : null;

  return (
    <div className="bt-app" ref={shellRef}>
      <a
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-[var(--bt-surface)] focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-[var(--bt-text)] focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-[var(--bt-gold)]"
        href="#main-content"
        onClick={() => document.getElementById('main-content')?.focus()}
      >
        {t('accessibility.skipToContent')}
      </a>
      <div className="bt-shell" data-rail={collapsed ? 'collapsed' : 'expanded'}>
        <aside className="bt-rail" hidden={compactShell}>
          <RailBrand />
          {/* The suite section scrolls on its own when an open tree outgrows
              the viewport — it may push the utilities down only until the
              bottom stack's guaranteed gap, never off screen. */}
          <nav aria-label={t('nav.primary')} className="bt-rail__group bt-rail__group--suite">
            {SUITE_ITEMS.map((item) => {
              const { section } = item;
              return section === undefined ? (
                <RailItem
                  collapsed={collapsed}
                  item={item}
                  key={item.to}
                  label={t(item.labelKey)}
                  pathname={pathname}
                />
              ) : (
                <RailGroup
                  collapsed={collapsed}
                  expanded={openGroup === section}
                  item={item}
                  key={item.to}
                  label={t(item.labelKey)}
                  onToggle={() => toggleGroup(section)}
                  pathname={pathname}
                  section={section}
                />
              );
            })}
          </nav>
          <div className="bt-rail__rule" />
          <nav aria-label={t('nav.utilities')} className="bt-rail__group">
            {UTILITY_ITEMS.map((item) => {
              // Ask BetterTrack is the floating panel's trigger, not a link.
              const Row = item.to === '/ask' ? RailAskToggle : RailItem;
              return (
                <Row
                  collapsed={collapsed}
                  item={item}
                  key={item.to}
                  label={t(item.labelKey)}
                  pathname={pathname}
                />
              );
            })}
          </nav>
          <div className="bt-rail__spacer" />
          {/* The collapse control lives at the foot of the rail it controls —
              icon-only in both states (owner), the label lives in aria/title. */}
          <button
            aria-label={collapsed ? t('nav.expandRail') : t('nav.collapseRail')}
            className="bt-rail-item bt-rail-item--toggle"
            onClick={toggleRail}
            title={collapsed ? t('nav.expandRail') : t('nav.collapseRail')}
            type="button"
          >
            <Icon name="collapse" size={17} />
          </button>
          {/* Rail-hidden widths render this in the topbar instead — see below. */}
          {compactShell ? null : (
            <>
              <div className="bt-rail__rule" />
              <AccountMenu collapsed={collapsed} />
            </>
          )}
        </aside>

        <div className="bt-main">
          <header className="bt-topbar">
            <span className="bt-topbar__brand-slot bt-hide-above-md">
              <RailBrand />
            </span>
            {phoneShell ? null : portfolioSwitcher}
            <div className="bt-topbar__spacer" />
            {/* Reads as the search field it stands in for (owner: "looks like an
                input instead of a button"). Semantically still a button —
                the real typing happens in the palette it opens. */}
            <button
              aria-keyshortcuts="Meta+K Control+K"
              aria-label={t('nav.openSearch')}
              className="bt-searchfield bt-topbar__search bt-hide-below-sm"
              onClick={openPalette}
              type="button"
            >
              <Icon name="search" size={15} />
              <span className="bt-searchfield__text">{t('palette.triggerLabel')}</span>
              <kbd className="bt-kbd">⌘K</kbd>
            </button>
            <Button
              aria-label={t('nav.openSearch')}
              className="bt-topbar__search bt-hide-above-sm"
              icon="search"
              iconOnly
              onClick={openPalette}
              size="sm"
              variant="quiet"
            />
            <div className="bt-topbar__actions">
              {privacy.privacyMode === 'paranoid' && privacy.mediaState != null ? (
                <Suspense fallback={null}>
                  <VaultSyncChip media={privacy.mediaState} />
                </Suspense>
              ) : null}
              <CreateMenu />
              <NotificationBell />
              {/* Below the rail's breakpoint the rail — and with it My profile,
                  Settings, Discreet mode and Logout — is display:none, which left
                  a phone with no way to reach any of them, not even to sign out.
                  The account menu moves here instead so it stays persistent. */}
              {compactShell ? <AccountMenu collapsed={false} placement="topbar" /> : null}
            </div>
            {/* The wrapped second row — last in the DOM because it is last on
                screen. See `portfolioSwitcher` above. */}
            {phoneShell ? portfolioSwitcher : null}
          </header>

          <main id="main-content" className="bt-canvas" tabIndex={-1}>
            {/* The error boundary only needs navigation to CLEAR a crash, never
                to remount healthy children.

                The Suspense boundary is keyed by SECTION, not by pathname.
                react-router runs navigation inside `startTransition`, and a
                transition into an already-mounted boundary keeps the old page
                painted until the chunk lands — so ARRIVING in a section needs a
                fresh boundary for the shell to commit its new navigation state
                right away. Keying on the full pathname would do that too, and
                would also remount the persistent section layout (its LocalNav,
                its scroll, its state) on every step INSIDE the section, which
                is the remount this key exists to avoid. Steps within a section
                stay inside that layout's own boundary. */}
            <ErrorBoundary resetKey={pathname}>
              {/* A skeleton, not `null` (§7.1): arriving in a cold section is
                  the one boundary with nothing else on screen to explain the
                  wait, and `role="status"` announces it. */}
              <Suspense
                fallback={<Skeleton className="rounded-md" height="h-64" />}
                key={sectionKey(pathname)}
              >
                <Outlet />
              </Suspense>
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
                    className="bt-footer-link"
                    href={legalUrl(link.page, locale)}
                    key={link.page}
                    rel="noreferrer"
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
      <nav aria-label={t('nav.primary')} className="bt-bottombar" hidden={!compactShell}>
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
              <span className="bt-bottombar__label">{t(item.labelKey)}</span>
            </NavLink>
          );
        })}
      </nav>

      {/* Non-modal floating AI panel: mounted at the shell root so it overlays
          the canvas without the page losing interactivity (see AskDock). */}
      <AskDock />

      <CmdKPalette isOpen={paletteOpen} onClose={closePalette} />
    </div>
  );
}
