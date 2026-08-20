/**
 * The admin console's information architecture, in one place (#1406 W1).
 *
 * Six operator workspaces replace the old People/Configuration/Diagnostics
 * grouping. The sidebar, the ⌘K palette and the shell's per-page width all read
 * this registry, so a destination can never exist in the palette but not in the
 * nav — or vice versa.
 *
 * Route paths are deliberately unchanged from the pre-W1 console: only the
 * grouping moved, so every bookmark still resolves. W2–W6 fold each workspace's
 * pages into tabs on one workspace page; until then they stay listed here.
 */

export interface AdminDestination {
  to: string;
  labelKey: string;
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
   * `max-w-5xl` (#1406 W1). Applies to the workspace landing and every page
   * listed under it.
   */
  wide?: boolean;
  pages: readonly AdminDestination[];
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
    pages: [
      { to: '/admin/users', labelKey: 'admin.nav.users' },
      { to: '/admin/registration', labelKey: 'admin.nav.registration' },
      { to: '/admin/invites', labelKey: 'admin.nav.invites' },
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

/** Every reachable console destination, workspace landings first. */
export const ADMIN_DESTINATIONS: readonly (AdminDestination & { workspaceKey: string })[] =
  ADMIN_WORKSPACES.flatMap((workspace) => [
    ...(workspace.to
      ? [{ to: workspace.to, labelKey: workspace.labelKey, workspaceKey: workspace.key }]
      : []),
    ...workspace.pages.map((page) => ({ ...page, workspaceKey: workspace.key })),
  ]);

const WIDE_PATHS = new Set(
  ADMIN_WORKSPACES.filter((workspace) => workspace.wide).flatMap((workspace) => [
    ...(workspace.to ? [workspace.to] : []),
    ...workspace.pages.map((page) => page.to),
  ]),
);

/**
 * Whether a console path renders in the wide content column. Matched on the
 * exact registered path — a nested detail route (`/admin/users/:id`) inherits
 * nothing, because its parent's density is not automatically its own.
 */
export function isWideAdminPath(pathname: string): boolean {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return WIDE_PATHS.has(normalized);
}

/** The workspace a path belongs to, for the palette's result grouping. */
export function adminWorkspaceLabelKey(to: string): string | undefined {
  return ADMIN_WORKSPACES.find(
    (workspace) => workspace.to === to || workspace.pages.some((page) => page.to === to),
  )?.labelKey;
}
