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
 * **W2 folded People; W4 folds Operations.** A folded workspace declares
 * `tabs`, and its rail entry collapses to a single item: the tab strip on the
 * page carries the in-workspace navigation the child rows used to, so nothing
 * became unreachable. Workspaces that still list `pages` keep W1's shape — the
 * nav fold for Product & Comms and Security & API was CUT as a package (W7,
 * §16 2026-08-29) and is deliberately not smuggled in here.
 *
 * **W7b gives the two unfolded workspaces a `to`, and nothing else.** Their rail
 * labels were headings that navigated nowhere, which made two of the six
 * workspaces dead ends. A `to` pointing at the workspace's own first page fixes
 * that with no new route and, crucially, no `tabs`: a `to` is a link, a `tabs`
 * array is the fold, and only the second one is the cut package. The assertion
 * in `WorkspaceTabs.test.tsx` that no third workspace declares `tabs` stays
 * green and stays the guard.
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
    // W3 folded the workspace: the helpdesk IS the Support page, so the
    // separate `/admin/feedback` row is gone and its URL redirects here. One
    // live inbox, not two.
    to: '/admin/support',
    // A split pane needs the room: a queue column plus a conversation does not
    // fit the narrow reading column.
    wide: true,
    pages: [],
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
    // W4 folds the second workspace. The landing is the health-and-queues
    // cockpit; every pre-fold path stays a real route, so nothing that was
    // bookmarked before the fold stopped resolving — the same contract W2 kept
    // when it folded People.
    key: 'operations',
    labelKey: 'admin.nav.sections.operations',
    to: '/admin/health',
    wide: true,
    pages: [],
    tabs: [
      { to: '/admin/health', labelKey: 'admin.nav.opsHealth' },
      { to: '/admin/problems', labelKey: 'admin.nav.problems' },
      { to: '/admin/providers', labelKey: 'admin.nav.providers' },
      { to: '/admin/monitoring', labelKey: 'admin.nav.monitoring' },
      { to: '/admin/email', labelKey: 'admin.nav.email' },
      { to: '/admin/usage-analytics', labelKey: 'admin.nav.usageAnalytics' },
      {
        // W5 (financial-data integrity) lives here as a tab — the §16 ruling of
        // 2026-08-29. W4 ships the tab and a page that states the shape and the
        // guardrails; the inspector itself is a later package.
        to: '/admin/market-data',
        labelKey: 'admin.nav.marketData',
        comingSoon: true,
        comingSoonKey: 'admin.marketData.comingSoonShort',
      },
    ],
  },
  {
    key: 'product',
    labelKey: 'admin.nav.sections.product',
    // A landing, NOT a fold (W7b): the label links at the workspace's first page
    // so the rail entry is reachable, while the page rows below stay exactly as
    // W1 left them.
    to: '/admin/settings',
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
    // Same as Product & Comms above: a landing on its own first page, no fold.
    to: '/admin/audit',
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
    // An UNFOLDED workspace's landing points at a route its own page rows
    // already list (W7b), so emitting it again would put two rows for
    // `/admin/settings` in the palette — one labelled "Settings", one labelled
    // "Product & Comms". The page row wins: an operator types the page name.
    // A folded workspace keeps its landing entry, because there are no page rows
    // to carry it (the same reason the tab filter below drops `tab.to === to`).
    const landing =
      workspace.to && !workspace.pages.some((page) => page.to === workspace.to)
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
 * The workspace label for a LIVE pathname — what every console page's eyebrow
 * resolves against (W7b), so "where am I" is answered from this registry rather
 * than hand-written once per page and left to drift the next time a page moves
 * workspace.
 *
 * Exact match first, then the LONGEST owning prefix. The longest-prefix rule is
 * load-bearing, not defensive: Overview owns `/admin`, so a plain
 * `startsWith` would let it claim every console route. `/admin/users/:id`
 * resolves to People because `/admin/users` is a longer match than `/admin`.
 */
export function adminWorkspaceLabelKeyForPath(pathname: string): string | undefined {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  const exact = adminWorkspaceLabelKey(normalized);
  if (exact) return exact;

  let best: AdminWorkspace | undefined;
  let bestLength = 0;
  for (const workspace of ADMIN_WORKSPACES) {
    for (const path of pathsOf(workspace)) {
      if (normalized.startsWith(`${path}/`) && path.length > bestLength) {
        best = workspace;
        bestLength = path.length;
      }
    }
  }
  return best?.labelKey;
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
