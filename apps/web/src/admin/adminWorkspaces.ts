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
 * **Every workspace that has children is folded (W2 People, W4 Operations,
 * W7c Product & Comms and Security & API).** A folded workspace declares `tabs`,
 * and its rail entry collapses to a single item: the tab strip on the page
 * carries the in-workspace navigation the child rows used to, so nothing became
 * unreachable. `pages` is the pre-fold shape and is now empty on EVERY
 * workspace; the field and the sidebar's rendering of it stay because removing
 * them is a separate change, not because a new workspace may quietly use them —
 * `WorkspaceTabs.test.tsx` asserts `pages: []` across the whole registry, so
 * re-introducing a child row fails that assertion and has to be argued for.
 *
 * **W7c is the §16 2026-09-14 ruling UN-CUTTING the fold.** The 2026-08-29
 * ruling 3 cut it as a package with a stated precondition — "the fold is proven
 * on one workspace before it is repeated" — and W2 and W4 met it twice over,
 * both merged with every pre-fold path surviving as a tab. The console now has
 * ONE navigation shape.
 *
 * **W7b's `to` is what the fold builds on, and it stays a `to`.** A landing is a
 * link; a `tabs` array is the fold. Overview and Support carry a `to` and no
 * `tabs` because they have no children to fold, which is a different thing from
 * an unfolded workspace and is asserted as such.
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
  /**
   * Child rows in the sidebar. Empty on every workspace since W7c, and pinned
   * empty by `WorkspaceTabs.test.tsx` — the console has one navigation shape,
   * and a workspace that wants page rows back must change that assertion first.
   * The field is still typed and still rendered by `AdminLayout`, so the
   * pre-fold shape remains expressible; it is not a quiet option.
   */
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
    // W7c folds the third workspace (§16 2026-09-14). Same contract as W2 and
    // W4: the landing is W7b's `to`, every W1 page row becomes a tab under its
    // OWN existing label key, and every pre-fold path stays a real route — no
    // redirect, no renamed key, no new i18n string.
    //
    // `wide` is deliberately NOT set. `isWideAdminPath` applies to a
    // workspace's landing AND every tab it owns, so setting it here would
    // re-flow all five pages from `max-w-5xl` into the dense column. Folding is
    // a navigation change; density is a per-surface decision these pages have
    // not asked for.
    key: 'product',
    labelKey: 'admin.nav.sections.product',
    to: '/admin/settings',
    pages: [],
    tabs: [
      { to: '/admin/settings', labelKey: 'admin.nav.settings' },
      { to: '/admin/feature-flags', labelKey: 'admin.nav.featureFlags' },
      { to: '/admin/ai', labelKey: 'admin.nav.ai' },
      { to: '/admin/account-defaults', labelKey: 'admin.nav.accountDefaults' },
      { to: '/admin/announcements', labelKey: 'admin.nav.announcements' },
    ],
  },
  {
    // The fourth and last fold. No `comingSoon` tab here or above: all nine of
    // these pages are real and shipped.
    key: 'security',
    labelKey: 'admin.nav.sections.securityApi',
    to: '/admin/audit',
    pages: [],
    tabs: [
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
 *
 * **A landing route carries the PAGE's name as its label and the workspace's as
 * a match key** (#1406 W7c). One route is one row — two rows for `/admin/users`
 * is the kind of noise a palette dies of — so the row has to satisfy both
 * queries at once. The label is the page name because that is what an operator
 * types and what they will see in the tab strip when they arrive; the workspace
 * name rides along in `matchKeys`, which the palette matches on but never
 * displays (it already shows the workspace as the row's `meta`).
 *
 * Without this, folding a workspace would COST reachability: the landing's only
 * label would be the workspace's, so "Settings" would stop matching
 * `/admin/settings` and "Audit" `/admin/audit` — and People and Operations
 * already carried that regression for `/admin/users` and `/admin/health`. The
 * fold's contract is that it costs no reachability, so the fix lives here in the
 * registry rather than as a special case in the palette.
 */
export const ADMIN_DESTINATIONS: readonly (AdminDestination & {
  workspaceKey: string;
  /**
   * Extra catalog keys a ⌘K query may match on, beyond the displayed label.
   * Never rendered — the palette shows `labelKey` and the workspace meta.
   */
  matchKeys?: readonly string[];
})[] = ADMIN_WORKSPACES.flatMap((workspace) => {
  // An UNFOLDED workspace's landing points at a route its own page rows already
  // list (W7b), so emitting it again would put two rows for one route in the
  // palette. The page row wins: an operator types the page name.
  const landingPage = workspace.pages.find((page) => page.to === workspace.to);
  // A FOLDED workspace has no page rows, so the landing row is the only one that
  // route gets (the tab filter below drops `tab.to === to` for the same
  // reason) — and it takes that tab's page label, with the workspace label as a
  // second thing to match on.
  const landingTab = (workspace.tabs ?? []).find((tab) => tab.to === workspace.to);
  const landing =
    workspace.to && !landingPage
      ? [
          {
            to: workspace.to,
            labelKey: landingTab?.labelKey ?? workspace.labelKey,
            ...(landingTab ? { matchKeys: [workspace.labelKey] } : {}),
            workspaceKey: workspace.key,
          },
        ]
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
