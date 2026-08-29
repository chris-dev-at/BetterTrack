/**
 * The admin console's information architecture, in one place (#1406 W1, W2).
 *
 * Six operator workspaces replace the old People/Configuration/Diagnostics
 * grouping. The sidebar, the ⌘K palette and the shell's per-page width all read
 * this registry, so a destination can never exist in the palette but not in the
 * nav — or vice versa.
 *
 * Route paths are deliberately unchanged from the pre-W1 console: only the
 * grouping moved, so every bookmark still resolves.
 *
 * **W2 folds ONE workspace.** People now declares `tabs`, and its rail entry
 * collapses to a single "People" item: the tab strip on the page carries the
 * in-workspace navigation the child rows used to, so nothing became
 * unreachable. Workspaces that still list `pages` keep W1's shape — the nav
 * fold for Product & Comms and Security & API is a separate package (W7) and is
 * deliberately not smuggled in here.
 */

export interface AdminDestination {
  to: string;
  labelKey: string;
}

/**
 * One tab of a folded workspace. Each tab is a real route, so every pre-fold URL
 * keeps working and a tab is linkable, bookmarkable and back-button-correct — a
 * tab strip built on component state would have silently broken every existing
 * bookmark.
 */
export interface AdminTab extends AdminDestination {
  /**
   * Rendered in the strip but not selectable: the workspace owns the tab, the
   * package that fills it has not shipped. A visible, disabled tab is an honest
   * statement of the IA; a hidden one would make the console look finished.
   */
  comingSoon?: boolean;
  /** Catalog key explaining why it is disabled, shown on hover/focus. */
  comingSoonKey?: string;
}

export interface AdminWorkspace {
  key: string;
  labelKey: string;
  /**
   * Route the workspace label itself links to, when the workspace owns a landing
   * page. Workspaces that are still only a list of pages leave this unset and
   * render a plain heading.
   */
  to?: string;
  /**
   * Dense operator surfaces opt into a wider content column than the default
   * `max-w-5xl` (#1406 W1). Applies to the workspace landing and every page or
   * tab listed under it.
   */
  wide?: boolean;
  /** Child rows in the sidebar. Empty for a workspace whose pages became tabs. */
  pages: readonly AdminDestination[];
  /** In-workspace tab strip. Present once a workspace has been folded (W2). */
  tabs?: readonly AdminTab[];
}

export const ADMIN_WORKSPACES: readonly AdminWorkspace[] = [
  {
    key: 'overview',
    labelKey: 'admin.nav.sections.overview',
    to: '/admin',
    wide: true,
    pages: [],
  },
  {
    key: 'support',
    labelKey: 'admin.nav.sections.support',
    to: '/admin/support',
    pages: [{ to: '/admin/feedback', labelKey: 'admin.nav.feedback' }],
  },
  {
    key: 'people',
    labelKey: 'admin.nav.sections.people',
    // The workspace landing is the account list; the strip carries the rest.
    to: '/admin/users',
    wide: true,
    pages: [],
    tabs: [
      { to: '/admin/users', labelKey: 'admin.nav.users' },
      { to: '/admin/registration', labelKey: 'admin.nav.registration' },
      { to: '/admin/invites', labelKey: 'admin.nav.invites' },
      {
        to: '/admin/test-accounts',
        labelKey: 'admin.nav.testAccounts',
        comingSoon: true,
        comingSoonKey: 'admin.testAccounts.comingSoonShort',
      },
    ],
  },
  {
    key: 'operations',
    labelKey: 'admin.nav.sections.operations',
    wide: true,
    pages: [
      { to: '/admin/health', labelKey: 'admin.nav.health' },
      { to: '/admin/problems', labelKey: 'admin.nav.problems' },
      { to: '/admin/monitoring', labelKey: 'admin.nav.monitoring' },
      { to: '/admin/email', labelKey: 'admin.nav.email' },
      { to: '/admin/usage-analytics', labelKey: 'admin.nav.usageAnalytics' },
    ],
  },
  {
    key: 'product',
    labelKey: 'admin.nav.sections.product',
    pages: [
      { to: '/admin/settings', labelKey: 'admin.nav.settings' },
      { to: '/admin/feature-flags', labelKey: 'admin.nav.featureFlags' },
      { to: '/admin/ai', labelKey: 'admin.nav.ai' },
      { to: '/admin/account-defaults', labelKey: 'admin.nav.accountDefaults' },
      { to: '/admin/announcements', labelKey: 'admin.nav.announcements' },
    ],
  },
  {
    key: 'security',
    labelKey: 'admin.nav.sections.securityApi',
    pages: [
      { to: '/admin/audit', labelKey: 'admin.nav.audit' },
      { to: '/admin/security', labelKey: 'admin.nav.security' },
      { to: '/admin/oauth-apps', labelKey: 'admin.nav.oauthApps' },
      { to: '/admin/api-keys', labelKey: 'admin.nav.apiKeys' },
    ],
  },
];

/** Every path a workspace owns: its landing, its pages, and its tabs. */
function pathsOf(workspace: AdminWorkspace): string[] {
  return [
    ...(workspace.to ? [workspace.to] : []),
    ...workspace.pages.map((page) => page.to),
    ...(workspace.tabs ?? []).map((tab) => tab.to),
  ];
}

/**
 * Every reachable console destination, workspace landings first. Tabs are
 * included so ⌘K can still reach Registration and Invites now that the rail no
 * longer lists them — the fold must not cost reachability. A coming-soon tab is
 * excluded: the palette navigates, and navigating to a placeholder is noise.
 */
export const ADMIN_DESTINATIONS: readonly (AdminDestination & { workspaceKey: string })[] =
  ADMIN_WORKSPACES.flatMap((workspace) => {
    const landing = workspace.to
      ? [{ to: workspace.to, labelKey: workspace.labelKey, workspaceKey: workspace.key }]
      : [];
    const pages = workspace.pages.map((page) => ({ ...page, workspaceKey: workspace.key }));
    const tabs = (workspace.tabs ?? [])
      // The landing already covers the first tab's route.
      .filter((tab) => !tab.comingSoon && tab.to !== workspace.to)
      .map((tab) => ({ to: tab.to, labelKey: tab.labelKey, workspaceKey: workspace.key }));
    return [...landing, ...pages, ...tabs];
  });

const WIDE_PATHS = new Set(ADMIN_WORKSPACES.filter((workspace) => workspace.wide).flatMap(pathsOf));

/**
 * Detail routes that inherit their workspace's width. A nested route does NOT
 * inherit density automatically (a parent's shape is not its child's), so the
 * few that genuinely need it are named: People 360 is a six-tab dense surface
 * and reads badly in the narrow reading column.
 */
const WIDE_PREFIXES = ['/admin/users/'];

/**
 * Whether a console path renders in the wide content column. Matched on the
 * exact registered path, plus the explicitly-named detail prefixes above.
 */
export function isWideAdminPath(pathname: string): boolean {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (WIDE_PATHS.has(normalized)) return true;
  return WIDE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/** The workspace a path belongs to, for the palette's result grouping. */
export function adminWorkspaceLabelKey(to: string): string | undefined {
  return ADMIN_WORKSPACES.find((workspace) => pathsOf(workspace).includes(to))?.labelKey;
}

/**
 * Whether a FOLDED workspace's rail entry should read as active for this path.
 *
 * `NavLink`'s own matching cannot express this. With `end` the People entry
 * highlights only on `/admin/users`, so three of its four tabs and the whole
 * People 360 detail route would leave the rail with nothing marked — the fold
 * was supposed to cost no navigation cue, and that would have been the cost.
 * Without `end` a prefix match would be wrong in the other direction, since
 * `/admin/registration` is not under `/admin/users` at all.
 *
 * So: a folded workspace owns a path when it equals one of the workspace's own
 * paths, or sits underneath one of them (the `/admin/users/:id` detail view).
 */
export function adminWorkspaceOwnsPath(workspace: AdminWorkspace, pathname: string): boolean {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return pathsOf(workspace).some(
    (path) => normalized === path || normalized.startsWith(`${path}/`),
  );
}

/**
 * The workspace whose tab strip owns this path, if any. The People pages read
 * this to render one shared strip instead of each page hand-listing its
 * siblings — a list that would drift the moment a tab is added.
 */
export function adminWorkspaceForTab(pathname: string): AdminWorkspace | undefined {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return ADMIN_WORKSPACES.find((workspace) =>
    (workspace.tabs ?? []).some((tab) => tab.to === normalized),
  );
}
