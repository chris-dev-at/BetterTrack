/**
 * V5-P14 Q1 traceability inventory.
 *
 * ── What makes a module a V5 surface ──────────────────────────────────────
 *
 * The universe is every non-test `.tsx` module under `src/user/`, `src/admin/`
 * and `src/ui/` (SURFACE_UNIVERSE_ROOTS). A module in that universe is a V5
 * surface — and belongs in V5_SURFACE_INVENTORY — when BOTH of these hold:
 *
 *   1. V5 provenance. A PROJECTPLAN §13.5 deliverable (phases P0…P13c) created
 *      it, or changed what a user sees or can reach on it. A rename, an import
 *      fix, a formatting pass, or the V5-P14 sweep itself is not such a change.
 *   2. User-visible surface. It renders user-visible copy, or it decides which
 *      user-visible copy is reached — route registries, navigation, shells,
 *      gates and mode providers qualify, because a regression there silently
 *      removes a reviewed surface.
 *
 * Everything else in the universe is a non-V5 surface and belongs in
 * NON_V5_SURFACES with the reason it is out of scope. That classification means
 * its async-state coverage is not claimed as part of a V5 deliverable; it does
 * not promise the source file is byte-identical when Q1 localizes shared
 * primitives used by inventoried surfaces. It also does NOT mean unguarded —
 * the accompanying test scans the WHOLE universe for literal user-facing copy,
 * and the pre-V5 English-only admin pages carry a frozen debt that may only
 * shrink.
 *
 * ── Why an omission cannot hide ───────────────────────────────────────────
 *
 * The two sets are a partition, enforced against disk rather than against a
 * second hand-written list: the test enumerates the universe itself and fails,
 * naming the path, on any module that is in neither set or in both. A file that
 * nobody remembered — new or pre-existing — is therefore an explicit failure
 * instead of a silent gap. Routes get the same treatment: the test parses the
 * `<Route>` trees out of `user/UserApp.tsx` and `admin/AdminApp.tsx`, and every
 * registered path must be inventoried, exempted in NON_V5_ROUTES, or rendered
 * by a NON_SURFACE_ROUTE_ELEMENT.
 *
 * The borderline cases the predicate is meant to settle, worked through:
 *   • `ui/charts/PriceChart.tsx`, `ui/MarketStateBadge.tsx` — shared primitives,
 *     but P1's intraday/live behavior lives in them ⇒ clause 1 ⇒ inventoried.
 *   • `admin/AdminApp.tsx`, `admin/components/AdminLayout.tsx` — pre-date V5,
 *     but P2/P10/P12/P13c added their routes and nav entries ⇒ inventoried.
 *   • `user/home/widgets/**` — render copy, reached from an inventoried surface,
 *     but no §13.5 deliverable changed them ⇒ clause 1 fails ⇒ exempt.
 *   • `user/auth/GoogleButton.tsx` — P0 changed where LoginPage places it, not
 *     the button; the moved layout is reviewed on LoginPage ⇒ exempt.
 *
 * ── Reading an inventory row ──────────────────────────────────────────────
 *
 * A surface is listed once, even when it serves more than one V5 phase. The
 * accompanying test locks the component and route sets, verifies every catalog
 * root in EN and DE, and scans the listed TSX files for literal UI copy. State
 * outcomes are explicit: `unverified` records review evidence that has not yet
 * been checked against component code, `covered` is reserved for evidence that
 * the accompanying state gate verifies mechanically, `not-applicable` explains
 * why no async state exists, and `hidden-by-design` records a binding privacy
 * or capability decision rather than silently omitting a state.
 */

/** Directories under `apps/web/src` that hold user-facing TSX modules. */
export const SURFACE_UNIVERSE_ROOTS = ['user', 'admin', 'ui'] as const;

export type V5ReviewStatus = 'covered' | 'unverified' | 'not-applicable' | 'hidden-by-design';

export interface V5StateReview {
  status: V5ReviewStatus;
  evidence: string;
}

export interface V5SurfaceReview {
  id: string;
  phases: readonly string[];
  routes: readonly string[];
  components: readonly string[];
  copyRoots: readonly string[];
  copyReview: string;
  states: {
    loading: V5StateReview;
    empty: V5StateReview;
    error: V5StateReview;
  };
  tests: readonly string[];
}

const notAsync = (evidence: string): V5StateReview => ({
  status: 'not-applicable',
  evidence,
});

const covered = (evidence: string): V5StateReview => ({ status: 'covered', evidence });

const unverified = (evidence: string): V5StateReview => ({ status: 'unverified', evidence });

const hidden = (evidence: string): V5StateReview => ({
  status: 'hidden-by-design',
  evidence,
});

export const V5_SURFACE_INVENTORY = [
  {
    id: 'p0-auth-layout',
    phases: ['P0'],
    routes: ['/login', '/register'],
    components: ['user/auth/LoginPage.tsx', 'user/auth/RegisterPage.tsx'],
    copyRoots: ['auth.login', 'auth.register', 'auth.google'],
    copyReview:
      'LoginPage/RegisterPage plus mirrored switch boxes; EN behavior retained, DE informal.',
    states: {
      loading: unverified(
        'Google/session submit progress in LoginPage.test.tsx and RegisterPage.test.tsx.',
      ),
      empty: notAsync('Credential forms have no collection-backed empty result.'),
      error: unverified(
        'Recoverable auth/Google failures remain inline and actionable in both page tests.',
      ),
    },
    tests: ['user/auth/LoginPage.test.tsx', 'user/auth/RegisterPage.test.tsx'],
  },
  {
    id: 'p0-account-defaults-and-icons',
    phases: ['P0'],
    routes: ['/admin/account-defaults', '/control/profile'],
    components: [
      'admin/pages/AccountDefaultsPage.tsx',
      'user/components/Avatar.tsx',
      'user/components/profileIcons.tsx',
      'user/control/panels/ProfileIconPicker.tsx',
      'user/control/panels/ProfilePanel.tsx',
    ],
    copyRoots: ['admin.accountDefaults', 'profile.icon'],
    copyReview: 'Kill-switch columns and curated icon picker/rendering reviewed in both catalogs.',
    states: {
      loading: unverified('Account defaults spinner; icon set is synchronous and bundled.'),
      empty: notAsync(
        'The defaults record is a required singleton; finite icons are always bundled.',
      ),
      error: unverified(
        'Account defaults exposes a localized retry; profile mutation errors stay inline.',
      ),
    },
    tests: [
      'admin/pages/AccountDefaultsPage.test.tsx',
      'user/components/Avatar.test.tsx',
      'user/control/panels/ProfilePanel.test.tsx',
    ],
  },
  {
    id: 'p0b-permission-pickers',
    phases: ['P0b', 'P13b'],
    routes: [
      '/control/api',
      '/control/oauth-apps',
      '/control/authorized-apps',
      '/oauth/authorize',
      '/admin/oauth-apps',
    ],
    components: [
      'ui/ScopePicker.tsx',
      'user/control/panels/ApiKeysPanel.tsx',
      'user/control/panels/OAuthAppsPanel.tsx',
      'user/control/panels/AuthorizedAppsPanel.tsx',
      'user/oauth/ConsentPage.tsx',
      'admin/pages/OAuthAppsPage.tsx',
    ],
    copyRoots: ['ui.scopePicker', 'settings.api', 'auth.oauthConsent', 'admin.oauthApps'],
    copyReview: 'Module rows, info points, consent copy, and first-party editor reviewed.',
    states: {
      loading: unverified('Every collection/consent read renders Skeleton or Spinner.'),
      empty: unverified('Keys, apps, grants, and first-party apps have compact empty rows/cards.'),
      error: unverified(
        'All collection failures expose localized retry; consent preserves deny/back recovery.',
      ),
    },
    tests: [
      'ui/ScopePicker.test.tsx',
      'user/oauth/ConsentPage.test.tsx',
      'admin/pages/OAuthAppsPage.test.tsx',
    ],
  },
  {
    id: 'p0c-connections-and-origin-tags',
    phases: ['P0c'],
    routes: [
      '/control/connections',
      '/portfolio/activity',
      '/portfolio/import',
      '/portfolio/cash/accounts',
      '/assets/:id',
    ],
    components: [
      'user/control/panels/ConnectionsPanel.tsx',
      'user/control/panels/SignInPanel.tsx',
      'user/portfolio/SourceBadge.tsx',
      'user/components/TransactionDialog.tsx',
      'user/portfolio/ImportPage.tsx',
      'user/portfolio/import/ImportUnderstanding.tsx',
      'user/portfolio/import/ImportReview.tsx',
      'user/portfolio/import/ImportPreviewTable.tsx',
      'user/portfolio/CashSourcesPage.tsx',
      'user/assets/capabilityTags.tsx',
    ],
    copyRoots: [
      'control.signIn',
      'settings.connections',
      'settings.password',
      'settings.security',
      'portfolio.import',
      'portfolio.sourceTag',
      'portfolio.cashSources',
      'assets.capability',
    ],
    copyReview:
      'Moved Google identity, broker-import source tags, source filters, and capability tags reviewed.',
    states: {
      loading: covered(
        'Connection, sign-in, import, and cash-source reads render progress states.',
      ),
      empty: unverified(
        'Passkeys, import previews, and cash sources distinguish genuine empty outcomes.',
      ),
      error: covered('Identity, import, and cash-source failures expose localized recovery.'),
    },
    tests: [
      'user/control/panels/ConnectionsPanel.test.tsx',
      'user/control/panels/SignInPanel.test.tsx',
      'user/portfolio/ImportPage.test.tsx',
      'user/portfolio/import/ImportWizardSteps.test.tsx',
      'user/portfolio/SourceBadge.test.tsx',
      'user/portfolio/CashSourcesPage.test.tsx',
    ],
  },
  {
    id: 'p1-performance-and-failover',
    phases: ['P1', 'P13b'],
    routes: ['/portfolio', '/portfolio/analysis', '/workbench', '/assets/:id', '/admin/health'],
    components: [
      'ui/MarketStateBadge.tsx',
      'ui/charts/LazyPriceChart.tsx',
      'ui/charts/PriceChart.tsx',
      'user/portfolio/PortfolioPage.tsx',
      'user/portfolio/analytics/AnalyticsPage.tsx',
      'user/portfolio/analytics/CompareControl.tsx',
      'user/portfolio/analytics/ContributionTable.tsx',
      'user/assets/AssetDetailPage.tsx',
      'user/workboard/WorkboardPage.tsx',
      'admin/pages/HealthPage.tsx',
    ],
    copyRoots: [
      'common.charts',
      'common.marketState',
      'portfolio.overview',
      'portfolio.analytics',
      'assets.detail',
      'assets.live',
      'workboard.overview',
      'admin.health',
      'admin.backup',
      'admin.common.duration',
    ],
    copyReview:
      'Intraday/live labels, prior-close label, dense-chart states, and failover status reviewed. #1406 W1 adds the read-only backup/restore-drill panel the Overview attention row links to, and moves the hand-built uptime string onto the localized shared duration units.',
    states: {
      loading: covered(
        'Portfolio, analytics, asset, watchlist, and health reads all render skeleton/spinner states.',
      ),
      empty: unverified(
        'No-portfolio analytics offers creation; holdings/chart/watchlist/provider absence uses compact shared empty states or neutral rows.',
      ),
      error: covered(
        'Portfolio and analytics reads retry without conflating a successful empty portfolio list with failure.',
      ),
    },
    tests: [
      'ui/MarketStateBadge.test.tsx',
      'ui/charts/PriceChart.test.tsx',
      'user/portfolio/PortfolioPage.test.tsx',
      'user/portfolio/analytics/AnalyticsPage.test.tsx',
      'user/assets/AssetDetailPage.test.tsx',
      'admin/pages/HealthPage.test.tsx',
    ],
  },
  {
    id: 'v5-admin-shell',
    phases: ['P0', 'P2', 'P10', 'P12', 'P13b', 'P13c'],
    // The shell owns no route of its own: AdminApp *is* the `/admin/*` registry
    // and AdminLayout wraps every page inside it, so each concrete route is
    // claimed by the phase surface that ships it.
    routes: [],
    components: ['admin/AdminApp.tsx', 'admin/components/AdminLayout.tsx'],
    copyRoots: ['admin.nav', 'admin.palette'],
    copyReview:
      'Console chrome every V5 admin surface is reached through: the nav entries added by P0 (Account defaults), P2 (Problems, Monitoring, Usage analytics, Feature flags), P10 (API keys), P12 (AI) and P13c (Security), plus the console title, language switch, and burger-drawer labels. The post-V5 W1 rebuild (#1406) regrouped those same entries under six operator workspaces, pointed the console index and the not-found fallback at the new Overview instead of Users, and added the shell-hosted palette trigger and shortcut. Every existing page path is unchanged.',
    states: {
      loading: unverified(
        'AdminLayout renders the localized admin.nav.loading spinner until the session resolves.',
      ),
      empty: notAsync(
        'Navigation is a fixed section list and the route table is static; neither is a collection that can come back empty.',
      ),
      error: unverified(
        'AdminApp traps session-unavailable above routing with a localized retry; an anonymous session redirects to the admin login.',
      ),
    },
    tests: ['admin/AdminApp.test.tsx', 'admin/components/AdminLayout.test.tsx'],
  },
  {
    id: 'p2-admin-operations',
    phases: ['P2', 'P13b'],
    routes: [
      '/admin/monitoring',
      '/admin/problems',
      '/admin/usage-analytics',
      '/admin/feature-flags',
    ],
    components: [
      'admin/pages/MonitoringPage.tsx',
      'admin/pages/ProblemsPage.tsx',
      'admin/pages/UsageAnalyticsPage.tsx',
      'admin/pages/FeatureFlagsPage.tsx',
    ],
    copyRoots: ['admin.monitoring', 'admin.problems', 'admin.usageAnalytics', 'admin.featureFlags'],
    copyReview: 'Zero-setup monitoring, Problems, analytics, and kill-switch copy reviewed.',
    states: {
      loading: covered('Each admin resource renders Spinner while no prior payload exists.'),
      empty: unverified(
        'Problems and analytics have explicit no-data states; fixed flag rows are not collection-empty.',
      ),
      error: covered('Refresh controls remain visible and failed initial reads expose retry.'),
    },
    tests: [
      'admin/pages/MonitoringPage.test.tsx',
      'admin/pages/ProblemsPage.test.tsx',
      'admin/pages/UsageAnalyticsPage.test.tsx',
      'admin/pages/FeatureFlagsPage.test.tsx',
    ],
  },
  {
    id: 'p3-notification-delivery',
    phases: ['P3'],
    routes: ['/control/notifications', '/control/notification-log'],
    components: [
      'user/control/panels/NotificationsPanel.tsx',
      'user/control/panels/NotificationLogPanel.tsx',
      'user/components/NotificationBell.tsx',
    ],
    copyRoots: ['settings.notifications'],
    copyReview: 'Digest cadence, quiet hours, channels, bell, and log copy reviewed.',
    states: {
      loading: covered('Panel and bell use Skeleton; paged log retains its loading row.'),
      empty: unverified('Bell/log and per-channel setup use compact empty/disabled states.'),
      error: covered('Settings load failure now includes retry; bell/log retain refresh recovery.'),
    },
    tests: [
      'user/control/panels/NotificationsPanel.test.tsx',
      'user/components/NotificationBell.test.tsx',
    ],
  },
  {
    id: 'p4-tax-v2',
    phases: ['P4'],
    routes: ['/control/defaults', '/portfolio/tax', '/portfolio/tax/print'],
    components: [
      'user/control/panels/DefaultsPanel.tsx',
      'user/control/panels/taxModeList.tsx',
      'user/settings/taxModePicker.tsx',
      'user/portfolio/PortfolioTaxSection.tsx',
      'user/portfolio/ParanoidTaxReport.tsx',
      'user/portfolio/TaxReportPage.tsx',
      'user/portfolio/TaxReportPrintPage.tsx',
      'user/portfolio/taxReportRows.tsx',
    ],
    copyRoots: ['settings.taxes', 'portfolio.taxReport', 'vaultExports.tax'],
    copyReview: 'AT/DE/custom modes, exports, print view, and disclaimer terminology reviewed.',
    states: {
      loading: covered(
        'Default, report-year, detail, and print reads expose Skeleton/loading copy.',
      ),
      empty: unverified(
        'No mode, no taxable events, and no year data are explicit compact states.',
      ),
      error: covered('Default/report reads expose retry; print has browser refresh recovery.'),
    },
    tests: [
      'user/control/panels/DefaultsPanel.test.tsx',
      'user/portfolio/TaxReportPage.test.tsx',
      'user/portfolio/TaxReportPrintPage.test.tsx',
    ],
  },
  {
    id: 'p5-market-intelligence',
    phases: ['P5'],
    routes: ['/assets/news'],
    components: [
      'user/assets/AssetsSection.tsx',
      'user/assets/NewsDigestPage.tsx',
      'user/assets/newsFeed.tsx',
      // The two home-board widgets call `marketIntelApi` directly and the widget
      // picker decides whether they are reachable at all, so P5's capability
      // gate lives in all three — clause 1 of the predicate above.
      'user/home/AddWidgetDrawer.tsx',
      'user/home/widgets/DividendsWidget.tsx',
      'user/home/widgets/NewsWidget.tsx',
    ],
    copyRoots: [
      'assets.news',
      'assets.detail.dividends',
      'assets.detail.earnings',
      'assets.detail.splits',
      'home.widgets.news',
      'home.widgets.dividends',
    ],
    copyReview:
      'Dividend, earnings, split, per-asset news, digest and roll-up truncation wording reviewed; the two home widgets and the catalog rows that offer them were reviewed for their own copy only — a capped six-row glance carries no truncation line by design.',
    states: {
      loading: unverified(
        'Digest renders skeletons; embedded blocks avoid layout churn; both home widgets render skeleton blocks.',
      ),
      empty: unverified(
        'Digest has a shared empty state; configured feeds can render no headlines; both home widgets render a terse Empty.',
      ),
      error: hidden(
        'Optional per-asset provider blocks are invisible when unconfigured by binding P5 spec; digest failure remains retryable; the catalog does not offer a widget this deployment has no capability for, and a widget already placed states its own unavailability.',
      ),
    },
    tests: [
      'user/assets/NewsDigestPage.test.tsx',
      'user/assets/AssetDetailPage.test.tsx',
      'user/home/marketIntelWidgets.test.tsx',
    ],
  },
  {
    id: 'p6-workboard-endgame',
    phases: ['P6'],
    routes: [
      '/assets/watchlists/:watchlistId',
      '/workbench/compare',
      '/workbench/blueprints',
      '/workbench/blueprints/:id',
      '/workbench/blueprints/new',
      '/workbench/blueprints/:id/edit',
      '/workbench/ideas',
      '/workbench/ideas/:ideaId',
    ],
    components: [
      'user/workboard/ComparisonPage.tsx',
      'user/workboard/ConglomeratesListPage.tsx',
      'user/workboard/ConglomerateDetailPage.tsx',
      'user/workboard/ConglomerateBuilderPage.tsx',
      'user/workboard/IdeaWorkboardPage.tsx',
      'user/workboard/IdeasListPage.tsx',
      'user/workboard/WatchlistDetailPage.tsx',
      'user/workboard/WatchlistsPage.tsx',
      'user/workboard/WorkboardSection.tsx',
    ],
    copyRoots: [
      'workboard.comparison',
      'workboard.conglomerates',
      'workboard.detail',
      'workboard.builder',
      'workboard.ideas',
      'watchlists',
    ],
    copyReview:
      'N-way comparison, nested Blueprint, and owned-watchlist management copy reviewed; malformed German singulars corrected.',
    states: {
      loading: covered(
        'Blueprint lists, nested picks, comparison execution, and watchlist detail use loading frames.',
      ),
      empty: unverified(
        'Insufficient selections, no Blueprints/ideas, no positions, and empty watchlists are explicit.',
      ),
      error: covered(
        'Blueprint-list, nested-list, comparison-execution, idea-resolution, and watchlist-detail outages retry in place; confirmed missing references stay terminal.',
      ),
    },
    tests: [
      'user/workboard/ComparisonPage.test.tsx',
      'user/workboard/ConglomerateBuilderPage.test.tsx',
      'user/workboard/ConglomerateDetailPage.test.tsx',
      'user/workboard/IdeaWorkboardPage.test.tsx',
      'user/workboard/IdeasListPage.test.tsx',
      'user/workboard/WatchlistsPage.test.tsx',
    ],
  },
  {
    id: 'p6b-forecast-and-orders',
    phases: ['P6b'],
    routes: ['/workbench/forecasts', '/workbench/calculators'],
    components: [
      'user/forecast/ForecastPage.tsx',
      'user/forecast/ProjectionChart.tsx',
      'user/forecast/ProjectionSection.tsx',
      'user/forecast/StandingOrdersSection.tsx',
      'user/forecast/StandingOrderDialog.tsx',
      'user/workboard/BudgetCalculator.tsx',
    ],
    copyRoots: ['forecast', 'workboard.calculator'],
    copyReview:
      'Projection factors, order schedules, and all calculator labels reviewed in informal DE.',
    states: {
      loading: covered(
        'Forecast prefill reads show compact progress while standalone calculators remain usable.',
      ),
      empty: unverified(
        'No portfolio, no orders, and no calculator positions have compact guidance.',
      ),
      error: covered(
        'Portfolio-list failure gates dependent sections; detail/analytics/history prefill failures retry without hiding projections, orders, or standalone calculators.',
      ),
    },
    tests: [
      'user/forecast/ForecastPage.test.tsx',
      'user/forecast/ProjectionSection.test.tsx',
      'user/forecast/StandingOrdersSection.test.tsx',
    ],
  },
  {
    id: 'p7-mirrorchain',
    phases: ['P7', 'P13'],
    routes: ['/portfolio/settings', '/people/shared'],
    components: [
      'user/portfolio/MirrorchainPanel.tsx',
      'user/portfolio/PortfolioSettingsPage.tsx',
      'user/portfolio/PortfolioSwitcher.tsx',
    ],
    copyRoots: ['mirrorchain', 'portfolio.switcher'],
    copyReview:
      'Owner/manager/member, invite, fork, transfer, and sync activity language reviewed.',
    states: {
      loading: covered('Member/activity/dialog reads render localized loading rows.'),
      empty: unverified(
        'No members/activity/invites use compact rows without exposing hidden identities.',
      ),
      error: covered(
        'Member/activity failures retain close/reopen recovery; mutations remain retryable in place.',
      ),
    },
    tests: [
      'user/portfolio/MirrorchainPanel.test.tsx',
      'user/portfolio/PortfolioSettingsPage.test.tsx',
      'user/portfolio/PortfolioSwitcher.test.tsx',
    ],
  },
  {
    id: 'p8-social-comments-and-groups',
    phases: ['P8', 'P13'],
    routes: [
      '/people',
      '/people/chat',
      '/people/shared',
      '/people/shared/:portfolioId',
      '/people/shared/conglomerates/:id',
      '/people/shared/watchlists/:watchlistId',
      '/people/shared/ideas/:ideaId',
      '/s/:token',
      '/u/:username',
    ],
    components: [
      'user/components/AudiencePicker.tsx',
      'user/social/CommentThread.tsx',
      'user/social/FriendGroupsSection.tsx',
      'user/social/FriendsPage.tsx',
      'user/social/MySharedItemsPage.tsx',
      'user/social/SharedPortfolioPage.tsx',
      'user/social/SharedConglomeratePage.tsx',
      'user/social/SharedWatchlistPage.tsx',
      'user/social/SharedIdeaPage.tsx',
      'user/social/PublicProfileViewPage.tsx',
      'user/social/PublicSharePage.tsx',
      'user/social/ChatPage.tsx',
      'user/social/chatSurface.tsx',
    ],
    copyRoots: ['sharing', 'social'],
    copyReview:
      'Groups, audience ladder, threads/reactions, shared titles, and chat copy reviewed.',
    states: {
      loading: covered(
        'Audience, MIRRORCHAIN metadata, lists, profiles, shared pages, chat, and comments expose loading states.',
      ),
      empty: unverified('Every collection has a contextual EmptyState or compact no-comments row.'),
      error: covered(
        'Fresh audience/co-member metadata gates sharing; chat and shared-item outages retry, while confirmed 401/403/404 outcomes remain privacy-indistinguishable.',
      ),
    },
    tests: [
      'user/social/CommentThread.test.tsx',
      'user/social/FriendGroupsSection.test.tsx',
      'user/social/FriendsPage.test.tsx',
      'user/social/ChatPage.test.tsx',
      'user/social/MySharedItemsPage.test.tsx',
      'user/social/SharedConglomeratePage.test.tsx',
      'user/social/SharedPortfolioPage.test.tsx',
      'user/social/SharedWatchlistPage.test.tsx',
    ],
  },
  {
    id: 'p9-cash-flow',
    phases: ['P9'],
    routes: [
      '/portfolio/cash',
      '/portfolio/cash/movements',
      '/portfolio/cash/budgets',
      '/portfolio/cash/labels',
    ],
    components: [
      'user/portfolio/cashflow/CashBudgetDialog.tsx',
      'user/portfolio/cashflow/CashBudgetsPage.tsx',
      'user/portfolio/cashflow/CashLabelsPage.tsx',
      'user/portfolio/cashflow/CashMovementTagsDialog.tsx',
      'user/portfolio/cashflow/CashMovementsPage.tsx',
      'user/portfolio/cashflow/CashOverviewPage.tsx',
      'user/portfolio/cashflow/CashRuleDialog.tsx',
      'user/portfolio/cashflow/CashRulesPage.tsx',
      'user/portfolio/cashflow/CashTagDialog.tsx',
      'user/portfolio/cashflow/CashTagsPage.tsx',
      'user/portfolio/cashflow/DisabledActionHint.tsx',
      'user/portfolio/cashflow/CashflowChart.tsx',
      'user/portfolio/cashflow/MonthPicker.tsx',
      'user/portfolio/cashflow/RecordCashButton.tsx',
      'user/portfolio/cashflow/RecordCashDialog.tsx',
      'user/portfolio/cashflow/SectionHead.tsx',
      'user/portfolio/cashflow/TagChip.tsx',
    ],
    copyRoots: ['cashflow', 'portfolio.cash'],
    copyReview:
      'Portfolio cash overview, tagged movements, labels/rules, budgets, charts, and recording dialogs reviewed after the fused-ledger replacement.',
    states: {
      loading: covered(
        'Overview, movements, budgets, tags, and rules render Skeletons; recording and editor dialogs expose pending labels.',
      ),
      empty: unverified(
        'Cash movement, budget, tag, rule, account, and zero-trend outcomes have compact EmptyState guidance.',
      ),
      error: covered(
        'Focused regressions cover overview, movement, budget, tag, rule, and recording failures without erasing usable sibling data.',
      ),
    },
    tests: [
      'user/portfolio/cashflow/CashOverviewPage.test.tsx',
      'user/portfolio/cashflow/CashMovementsPage.test.tsx',
      'user/portfolio/cashflow/CashBudgetsPage.test.tsx',
      'user/portfolio/cashflow/CashTagsPage.test.tsx',
      'user/portfolio/cashflow/CashRulesPage.test.tsx',
      'user/portfolio/cashflow/RecordCashDialog.test.tsx',
    ],
  },
  {
    id: 'p10-api-platform',
    phases: ['P10', 'P13b'],
    routes: ['/control/webhooks', '/admin/api-keys'],
    components: ['user/control/panels/WebhooksPanel.tsx', 'admin/pages/ApiKeysPage.tsx'],
    copyRoots: ['settings.api.webhooks', 'admin.apiKeys'],
    copyReview:
      'Webhook signing/delivery and key-tier/audit copy reviewed; admin page fully extracted.',
    states: {
      loading: unverified('Webhook/key/tier/audit collections render Skeleton or Spinner.'),
      empty: unverified('No subscriptions, keys, tiers, or audit rows are explicit.'),
      error: unverified('Each collection now exposes its own localized retry action.'),
    },
    tests: ['user/control/panels/WebhooksPanel.test.tsx', 'admin/pages/ApiKeysPage.test.tsx'],
  },
  {
    id: 'p12-local-ai',
    phases: ['P12', 'P13b'],
    routes: ['/admin/ai', '/portfolio/analysis', '/workbench/blueprints/new'],
    components: [
      'admin/pages/AiSettingsPage.tsx',
      'user/portfolio/analytics/AiInsightsPanel.tsx',
      'user/workboard/NlBuilderPanel.tsx',
    ],
    copyRoots: ['admin.ai', 'portfolio.analytics.ai', 'workboard.builder.ai'],
    copyReview:
      'Local-only framing, informational disclaimer, cap, and reviewed-draft wording reviewed.',
    states: {
      loading: unverified(
        'Admin load and both explicit user-triggered requests expose pending copy.',
      ),
      empty: hidden(
        'Unconfigured AI is invisible to users by binding P12 spec; admin shows Not configured.',
      ),
      error: unverified(
        'Admin retries load; insight/builder errors keep their explicit re-run actions.',
      ),
    },
    tests: [
      'admin/pages/AiSettingsPage.test.tsx',
      'user/portfolio/analytics/AiInsightsPanel.test.tsx',
      'user/workboard/NlBuilderPanel.test.tsx',
    ],
  },
  {
    id: 'v5-shared-shell-and-portfolio-entry',
    phases: ['P0', 'P0c', 'P1', 'P6b', 'P13', 'P13b'],
    routes: [
      '/',
      '/assets/custom-assets',
      '/assets/watchlists',
      '/control/:panel?',
      '/control/account',
      '/portfolio/activity',
    ],
    components: [
      'user/AuthContext.tsx',
      'user/components/AssetSearchBox.tsx',
      'user/components/CmdKPalette.tsx',
      'user/components/OriginShell.tsx',
      'user/control/ControlCenterOverlay.tsx',
      'user/control/panels/AccountPanel.tsx',
      'user/home/HomePage.tsx',
      'user/parked/ParkedPage.tsx',
      'user/portfolio/CashDialog.tsx',
      'user/portfolio/CashSourceDialog.tsx',
      'user/portfolio/CustomInvestmentDialog.tsx',
      'user/portfolio/PortfolioSection.tsx',
      'user/portfolio/PortfolioStoreProvider.tsx',
      'user/portfolio/PortfolioWorkspace.tsx',
      'user/portfolio/SetBalanceDialog.tsx',
      'user/portfolio/TransferDialog.tsx',
      'user/portfolio/ValuePointEditor.tsx',
      'user/portfolio/wizard/PortfolioWizard.tsx',
    ],
    copyRoots: ['nav', 'palette', 'control', 'home', 'parked', 'portfolio'],
    copyReview:
      'Shared V5 shell, command/search entry points, cash editors, and portfolio-store boundary reviewed.',
    states: {
      loading: covered(
        'Session, search, home, portfolio-store, wizard, and editor reads use their compact progress states.',
      ),
      empty: unverified(
        'Search, home board, parked routes, and value editors provide contextual empty guidance.',
      ),
      error: covered(
        'Session and data reads retain retry/reload actions; dialog mutations remain editable and retryable.',
      ),
    },
    tests: [
      'user/AppShell.test.tsx',
      'user/AuthContext.test.tsx',
      'user/home/HomePage.test.tsx',
      'user/portfolio/wizard/PortfolioWizard.test.tsx',
    ],
  },
  {
    id: 'p13-privacy-modes',
    phases: ['P13'],
    routes: ['/control/privacy'],
    components: [
      'user/UserApp.tsx',
      'user/control/panels/ParanoidAccountExport.tsx',
      'user/control/panels/PrivacyPanel.tsx',
      'user/control/panels/PrivacyVaultSection.tsx',
      'user/home/WidgetFrame.tsx',
      'user/home/widgets/PortfolioCardsWidget.tsx',
      'user/portfolio/LockedPortfolioStub.tsx',
      'user/portfolio/PortfolioMoveOutAction.tsx',
      'user/portfolio/UnlockedVaultPortfolio.tsx',
      'user/control/panels/VaultTransferActions.tsx',
      'user/vault/VaultAccountRoot.tsx',
      'user/vault/VaultRuntimeProvider.tsx',
      'user/vault/engine/VaultMoneyEngineProvider.tsx',
      'user/vault/ui/ParanoidEnableWizard.tsx',
      'user/vault/ui/ParanoidSurfaceGate.tsx',
      'user/vault/ui/PortfolioVaultMoveWizard.tsx',
      'user/vault/ui/PortfolioVaultSection.tsx',
      'user/vault/ui/VaultCreationCeremony.tsx',
      'user/vault/ui/VaultManager.tsx',
      'user/vault/ui/VaultRestorePicker.tsx',
      'user/vault/ui/VaultStateAction.tsx',
      'user/vault/ui/VaultUnlockDialog.tsx',
      'user/vault/ui/VaultProvidePhraseDialog.tsx',
      'user/vault/ui/VaultReceivePhrase.tsx',
      'user/vault/ui/VaultSyncChip.tsx',
      'user/vault/ui/VaultTransferQr.tsx',
      'user/vault/ui/VaultUnlockGate.tsx',
      'ui/MoneyText.tsx',
      'ui/charts/AllocationDonut.tsx',
      'ui/charts/LazyAllocationDonut.tsx',
    ],
    copyRoots: ['privacy', 'vault', 'vaultMoney', 'vaultExports', 'common.charts'],
    copyReview:
      'Discreet masking (including allocation charts), custody, media, enable/unlock/sync, QR transfer, loss, and recovery copy reviewed.',
    states: {
      loading: covered(
        'Account-mode, enable, unlock, and sync transitions expose Splash/progress/status.',
      ),
      empty: hidden(
        'Killed social/server features stay absent in paranoid mode; this is a privacy boundary, not an empty collection.',
      ),
      error: covered(
        'Mode bootstrap and vault operations provide retry, unlock, start-fresh, or disable recovery.',
      ),
    },
    tests: [
      'user/AccountModeRoot.test.tsx',
      'user/portfolio/LockedPortfolioStub.test.tsx',
      'user/portfolio/PortfolioWorkspace.test.tsx',
      'user/home/widgets/PortfolioCardsWidget.test.tsx',
      'user/control/panels/VaultTransferActions.test.tsx',
      'user/vault/ui/ParanoidEnableWizard.test.tsx',
      'user/vault/ui/PortfolioVaultMoveWizard.test.tsx',
      'user/vault/ui/PortfolioVaultSection.test.tsx',
      'user/vault/ui/VaultCreationCeremony.test.tsx',
      'user/vault/ui/VaultManager.test.tsx',
      'user/vault/ui/VaultRestorePicker.test.tsx',
      'user/vault/ui/VaultReceivePhrase.test.tsx',
      'user/vault/ui/VaultUnlockGate.test.tsx',
      'user/vault/ui/VaultSyncChip.test.tsx',
      'user/vault/ui/VaultTransferQr.test.tsx',
      'ui/MoneyText.test.tsx',
      'ui/charts/AllocationDonut.test.tsx',
    ],
  },
  {
    id: 'p13b-admin-phone-usability',
    phases: ['P13b'],
    routes: ['/admin/login', '/admin/settings', '/admin/users'],
    components: [
      'admin/pages/ForcedPasswordChangePage.tsx',
      'admin/pages/LoginPage.tsx',
      'admin/pages/SettingsPage.tsx',
      'admin/pages/TwoFactorChallengePage.tsx',
      'admin/pages/TwoFactorSetupPage.tsx',
      'admin/pages/UsersPage.tsx',
    ],
    copyRoots: [
      'auth.adminLogin',
      'auth.adminForcedPassword',
      'admin.settings',
      'admin.twoFactor',
      'admin.users',
    ],
    copyReview:
      'Phone-safe admin login/traps, the registration-mode selector, and user management reviewed in both catalogs; responsive behavior remains covered by the P13b admin-mobile gate. The registration access tokens and the approval queue this row once also covered moved to the People workspace with #1406 W1 — their copy still lives under `admin.settings.*`, but it is now reviewed on admin/pages/RegistrationPage.tsx.',
    states: {
      loading: covered('Session, settings, user, and 2FA progress stays explicit.'),
      empty: unverified('User search distinguishes an empty result from an unread one.'),
      error: covered(
        'Session and resource reads expose localized retry; form and mutation failures remain inline.',
      ),
    },
    tests: [
      'admin/AdminApp.test.tsx',
      'admin/pages/LoginPage.test.tsx',
      'admin/pages/SettingsPage.test.tsx',
      'admin/pages/UsersPage.test.tsx',
    ],
  },
  {
    id: 'p13b-installable-pwa',
    phases: ['P13b'],
    // Not a route: the affordance floats over whichever surface is on screen
    // (anti-bloat), and the standalone-window rules are shell-wide.
    routes: [],
    components: ['user/components/InstallPrompt.tsx'],
    copyRoots: ['pwa.install'],
    copyReview:
      'Install card and the iOS Add-to-Home-Screen coach mark reviewed in both catalogs; DE keeps the informal address the rest of the user app uses.',
    states: {
      loading: notAsync('Install capability is a synchronous browser fact, not a fetch.'),
      empty: notAsync('No collection: the card is silent-by-default when no install path exists.'),
      error: notAsync(
        'The native prompt owns its own failure; a rejected prompt() is swallowed and the card stays dismissed.',
      ),
    },
    tests: ['user/components/InstallPrompt.test.tsx'],
  },
  {
    id: 'p13c-admin-session-policy',
    phases: ['P13c'],
    routes: ['/admin/security'],
    components: ['admin/pages/SecuritySettingsPage.tsx'],
    copyRoots: ['admin.security'],
    copyReview:
      'Independent 6–24 h admin-session policy and no-step-up wording reviewed, plus the expiry notice the console signs out with (#1779, EN + DE).',
    states: {
      loading: covered(
        'Both resources (2FA status, session policy) render a localized Spinner while pending.',
      ),
      empty: notAsync(
        'Policy is a required singleton; 2FA method absence is an actionable setup state.',
      ),
      error: covered(
        'Both resource failures render a localized Alert with retry; the keyless writes with no factor to verify (session policy, recovery-code regenerate, email-method turn-off) route through the shared write seam, so an expired admin window signs the console out with a translated notice instead of an inline banner. The factor-verifying writes — the TOTP-disable code field and the shared enroll/confirm forms this page renders (admin/components/twoFactor.tsx: TOTP enroll + confirm, email start + confirm) — keep their own mapping, because their 401/400 is a rejected code rather than auth loss, and each pins the expiry path explicitly through admin/sessionExpiry.ts. Only range validation stays purely inline.',
      ),
    },
    tests: ['admin/pages/SecuritySettingsPage.test.tsx', 'admin/sessionExpiry.test.tsx'],
  },
] as const satisfies readonly V5SurfaceReview[];

/**
 * Why a module in the universe is NOT a V5 surface.
 *
 * - `no-v5-deliverable` — clause 1 of the predicate fails: the module is a
 *   V1–V4 surface, an Origin-redesign (#935 / R2) shell piece, or a V5-P14
 *   sweep artifact, and no §13.5 P0–P13c deliverable changed what a user sees
 *   on it. This is the arguable reason: the note names the milestone that
 *   shipped it, so a reviewer who disagrees has something concrete to argue
 *   with instead of an unwritten boundary.
 * - `no-user-copy` — clause 2 of the predicate fails: the module renders no
 *   user-visible copy of its own; its strings are caller props. The test proves
 *   this mechanically (no translation call, no literal copy), so these rows are
 *   claims the suite verifies rather than claims the author makes.
 */
export type V5ExemptionReason = 'no-v5-deliverable' | 'no-user-copy';

export interface V5SurfaceExemption {
  path: string;
  reason: V5ExemptionReason;
  note: string;
}

/**
 * The other half of the partition. Every non-test TSX module under
 * SURFACE_UNIVERSE_ROOTS that is not in V5_SURFACE_INVENTORY must be listed
 * here; the test enumerates the universe from disk and fails on anything that
 * appears in neither list, in both, or nowhere on disk.
 *
 * Listing a module here means Q1 does not claim its async states as V5 coverage.
 * Shared microcopy may still be localized for inventoried consumers. No module
 * is exempt from the literal-copy scan.
 */
export const NON_V5_SURFACES = [
  {
    path: 'admin/AuthContext.tsx',
    reason: 'no-user-copy',
    note: 'V1 admin session provider; holds state, renders nothing.',
  },
  {
    path: 'admin/components/AdminCommandPalette.tsx',
    reason: 'no-v5-deliverable',
    note: 'Post-V5 admin rebuild W1 (#1406) ⌘K palette; localized and tested in its own feature change.',
  },
  {
    path: 'admin/components/LiveRefreshControl.tsx',
    reason: 'no-v5-deliverable',
    note: 'Post-V5 admin rebuild W4 (#1406): the Operations cockpit’s cadence picker and refresh button; localized and tested in its own feature change.',
  },
  {
    path: 'admin/components/WorkspaceTabs.tsx',
    reason: 'no-v5-deliverable',
    note: 'Post-V5 admin rebuild W2 (#1406): the tab strip of a folded workspace — People since W2, Operations since W4; localized and tested in its own feature change.',
  },
  {
    path: 'admin/components/EmailLogTable.tsx',
    reason: 'no-v5-deliverable',
    note: 'V2 email-log table (#187).',
  },
  {
    path: 'admin/components/Modal.tsx',
    reason: 'no-user-copy',
    note: 'P13b made this V1 frame phone-safe, but heading/body remain caller props and it owns no copy.',
  },
  {
    path: 'admin/components/twoFactor.tsx',
    reason: 'no-v5-deliverable',
    note: 'V4 admin-2FA form parts (#450).',
  },
  {
    path: 'admin/components/ui.tsx',
    reason: 'no-v5-deliverable',
    note: 'V1 admin control kit (#11); Q1 localized shared Spinner/CopyField defaults only.',
  },
  {
    path: 'admin/pages/AnnouncementsPage.tsx',
    reason: 'no-v5-deliverable',
    note: 'V4-P5 announcement composer (#519); still English-only.',
  },
  {
    path: 'admin/pages/AuditPage.tsx',
    reason: 'no-v5-deliverable',
    note: 'V1 admin audit log (#11); still English-only.',
  },
  {
    path: 'admin/pages/EmailPage.tsx',
    reason: 'no-v5-deliverable',
    note: 'V1 SMTP diagnostics (#81); still English-only.',
  },
  {
    path: 'admin/pages/InvitesPage.tsx',
    reason: 'no-v5-deliverable',
    note: 'V1 invite management (#11); still English-only.',
  },
  {
    path: 'admin/pages/MarketDataPage.tsx',
    reason: 'no-v5-deliverable',
    note: 'Post-V5 admin rebuild W4 (#1406): the Operations workspace’s placeholder for the W5 financial-data inspector.',
  },
  {
    path: 'admin/pages/OverviewPage.tsx',
    reason: 'no-v5-deliverable',
    note: 'Post-V5 admin rebuild W1 (#1406) operator Overview; localized and tested in its own feature change.',
  },
  {
    path: 'admin/pages/ProvidersPage.tsx',
    reason: 'no-v5-deliverable',
    note: 'Post-V5 admin rebuild W4 (#1406): per-capability breaker and market-cache signals; localized and tested in its own feature change.',
  },
  {
    path: 'admin/pages/RegistrationPage.tsx',
    reason: 'no-v5-deliverable',
    note: 'Post-V5 admin rebuild W1 (#1406): the approval queue and access tokens, re-housed out of the V5 settings page into the People workspace.',
  },
  {
    path: 'admin/pages/SupportPage.tsx',
    reason: 'no-v5-deliverable',
    note: 'Post-V5 admin rebuild W3 (#1406): the split-pane helpdesk workspace, which replaced both the W1 Support landing and the separate #1316 feedback inbox.',
  },
  {
    path: 'admin/support/SupportInbox.tsx',
    reason: 'no-v5-deliverable',
    note: 'Post-V5 admin rebuild W3 (#1406): the helpdesk queue pane — filters, keyboard navigation and paging over the admin feedback routes.',
  },
  {
    path: 'admin/support/SupportThread.tsx',
    reason: 'no-v5-deliverable',
    note: 'Post-V5 admin rebuild W3 (#1406): the helpdesk conversation pane — replies, the FEEDBACK-7 status controls, and submitter context.',
  },
  {
    path: 'admin/pages/TestAccountsPage.tsx',
    reason: 'no-v5-deliverable',
    note: 'Post-V5 admin rebuild W2 (#1406): the People workspace’s placeholder for the W6 test-account factory.',
  },
  {
    path: 'admin/pages/UserDetailPage.tsx',
    reason: 'no-v5-deliverable',
    note: 'V2 admin user detail (#265); still English-only.',
  },
  {
    path: 'ui/ComingSoon.tsx',
    reason: 'no-v5-deliverable',
    note: 'V2 Coming-Soon placeholder frame.',
  },
  {
    path: 'ui/Disclaimer.tsx',
    reason: 'no-user-copy',
    note: 'V3 disclaimer frame; the notice itself is a caller prop.',
  },
  {
    path: 'ui/EmptyState.tsx',
    reason: 'no-user-copy',
    note: 'V1 empty-state frame; title, body and action are caller props.',
  },
  {
    path: 'ui/ErrorBoundary.tsx',
    reason: 'no-v5-deliverable',
    note: 'V2 route-level error boundary (#207).',
  },
  {
    path: 'ui/NotFoundState.tsx',
    reason: 'no-v5-deliverable',
    note: 'Shared not-found state created by the V5-P14 sweep itself (#1013), not by a P0-P13c deliverable.',
  },
  {
    path: 'ui/Skeleton.tsx',
    reason: 'no-v5-deliverable',
    note: 'V1 skeleton and spinner primitives (#64).',
  },
  {
    path: 'ui/Spinner.tsx',
    reason: 'no-v5-deliverable',
    note: 'V1 loading primitive (#64), promoted to the shared UI layer by #1263.',
  },
  {
    path: 'ui/StatCard.tsx',
    reason: 'no-user-copy',
    note: 'V1 stat tile; label and value are caller props.',
  },
  {
    path: 'ui/charts/Sparkline.tsx',
    reason: 'no-v5-deliverable',
    note: 'V1 sparkline renderer (#20); Q1 localized its shared accessibility fallback.',
  },
  {
    path: 'ui/origin/components.tsx',
    reason: 'no-v5-deliverable',
    note: 'Origin-redesign shell primitives (#935); the redesign is not a §13.5 phase.',
  },
  {
    path: 'ui/origin/icons.tsx',
    reason: 'no-user-copy',
    note: 'Origin-redesign icon set (#935); SVG paths only.',
  },
  {
    path: 'user/RequireUser.tsx',
    reason: 'no-v5-deliverable',
    note: 'V1 authenticated-route guard.',
  },
  {
    path: 'user/assets/AssetsWorkspace.tsx',
    reason: 'no-v5-deliverable',
    note: 'Origin-redesign assets workspace chrome (#935).',
  },
  {
    path: 'user/assets/SearchPage.tsx',
    reason: 'no-v5-deliverable',
    note: 'V1 §6.2 search page (#71).',
  },
  {
    path: 'user/auth/ForcedPasswordChangePage.tsx',
    reason: 'no-v5-deliverable',
    note: 'V1 forced password change.',
  },
  {
    path: 'user/auth/ForgotPasswordPage.tsx',
    reason: 'no-v5-deliverable',
    note: 'V2 password-reset request (#282).',
  },
  {
    path: 'user/auth/GoogleButton.tsx',
    reason: 'no-v5-deliverable',
    note: 'V4-P4 Google sign-in button (#513); V5-P0 moved where LoginPage places it, not the button.',
  },
  { path: 'user/auth/InvitePage.tsx', reason: 'no-v5-deliverable', note: 'V1 invite acceptance.' },
  {
    path: 'user/auth/OAuthAccountChooser.tsx',
    reason: 'no-v5-deliverable',
    note: 'V4 OAuth account memory and PIN re-auth chooser.',
  },
  { path: 'user/auth/PinGate.tsx', reason: 'no-v5-deliverable', note: 'V2 PIN gate (#111).' },
  {
    path: 'user/auth/ResetPasswordPage.tsx',
    reason: 'no-v5-deliverable',
    note: 'V2 password reset (#282).',
  },
  {
    path: 'user/components/AlertDialog.tsx',
    reason: 'no-v5-deliverable',
    note: 'V3-P10b alert editor (#345).',
  },
  {
    path: 'user/components/AlertList.tsx',
    reason: 'no-v5-deliverable',
    note: 'V3-P10b alert list (#345).',
  },
  {
    path: 'user/components/AnnouncementBanner.tsx',
    reason: 'no-v5-deliverable',
    note: 'V4-P5 announcement banner (#519).',
  },
  {
    path: 'user/components/AuthFigures.tsx',
    reason: 'no-v5-deliverable',
    note: 'Origin-redesign R2 auth artwork.',
  },
  {
    path: 'user/components/AsyncReadState.tsx',
    reason: 'no-v5-deliverable',
    note: 'Shared async-state primitive created by the V5-P14 sweep itself, not by a P0-P13c deliverable.',
  },
  {
    path: 'user/components/Dialog.tsx',
    reason: 'no-v5-deliverable',
    note: 'V1 dialog frame (#77).',
  },
  {
    path: 'user/components/FeedbackDialog.tsx',
    reason: 'no-v5-deliverable',
    note: 'Owner-ordered FEEDBACK-3 web reporter (#1317), added outside the §13.5 P0–P13c plan.',
  },
  {
    path: 'user/components/FreshStartNotice.tsx',
    reason: 'no-v5-deliverable',
    note: 'PARANOID E9 §17 one-time fresh-start notice, outside the §13.5 P0–P13c plan.',
  },
  {
    path: 'user/components/LocalNav.tsx',
    reason: 'no-v5-deliverable',
    note: 'Origin-redesign local nav strip (#935).',
  },
  {
    path: 'user/components/PinInput.tsx',
    reason: 'no-v5-deliverable',
    note: 'V2 segmented PIN inputs (#287); Q1 localized its per-digit accessibility suffix.',
  },
  {
    path: 'user/components/askdock/AskDock.tsx',
    reason: 'no-v5-deliverable',
    note: 'Origin-redesign R2 ask dock.',
  },
  { path: 'user/components/ui.tsx', reason: 'no-v5-deliverable', note: 'V1 user control kit.' },
  {
    path: 'user/control/panels/AppearancePanel.tsx',
    reason: 'no-v5-deliverable',
    note: 'Board #68 theme + interface-scale panel; post-V5, and every string is catalogued.',
  },
  {
    path: 'user/control/panels/DeleteAccountPanel.tsx',
    reason: 'no-v5-deliverable',
    note: 'V4-P2c account deletion, re-housed by the R2 Control Center.',
  },
  {
    path: 'user/control/panels/FeedbackPanel.tsx',
    reason: 'no-v5-deliverable',
    note: 'Owner-ordered FEEDBACK-3 Settings entry (#1317), added outside the §13.5 P0–P13c plan.',
  },
  {
    path: 'user/control/panels/SessionsPanel.tsx',
    reason: 'no-v5-deliverable',
    note: 'V2 session list, re-housed by the R2 Control Center.',
  },
  {
    path: 'user/control/panels/TrustedDevicesPanel.tsx',
    reason: 'no-v5-deliverable',
    note: 'Post-V5 mobile-parity remembered-device manager (#1391).',
  },
  {
    path: 'user/control/panels/panelKit.tsx',
    reason: 'no-user-copy',
    note: 'R2 Control Center panel primitives; every string is caller-supplied.',
  },
  {
    path: 'user/firstrun/FirstRunFigures.tsx',
    reason: 'no-v5-deliverable',
    note: 'Origin-redesign R2 first-run artwork.',
  },
  {
    path: 'user/firstrun/FirstRunGate.tsx',
    reason: 'no-user-copy',
    note: 'V4 first-run routing gate; decides where to land, renders no copy.',
  },
  {
    path: 'user/firstrun/WelcomePage.tsx',
    reason: 'no-v5-deliverable',
    note: 'V4 first-run wizard, rebuilt by R2.',
  },
  {
    path: 'user/firstrun/steps/DoneStep.tsx',
    reason: 'no-v5-deliverable',
    note: 'V4 first-run step (done).',
  },
  {
    path: 'user/firstrun/steps/PreferencesStep.tsx',
    reason: 'no-v5-deliverable',
    note: 'V4 first-run step (preferences).',
  },
  {
    path: 'user/firstrun/steps/ProfileStep.tsx',
    reason: 'no-v5-deliverable',
    note: 'V4 first-run step (profile).',
  },
  {
    path: 'user/firstrun/steps/PublicProfileStep.tsx',
    reason: 'no-v5-deliverable',
    note: 'V4 first-run step (public profile).',
  },
  {
    path: 'user/firstrun/steps/SecurityStep.tsx',
    reason: 'no-v5-deliverable',
    note: 'V4 first-run step (security).',
  },
  {
    path: 'user/firstrun/steps/TaxStep.tsx',
    reason: 'no-v5-deliverable',
    note: 'V4 first-run step (tax residency).',
  },
  {
    path: 'user/firstrun/steps/VerifyEmailStep.tsx',
    reason: 'no-v5-deliverable',
    note: 'V4 first-run step (email verification).',
  },
  {
    path: 'user/home/widgets/aggregateSafety.tsx',
    reason: 'no-v5-deliverable',
    note: 'PARANOID-E6 (#1416) home-board completeness guard; renders the shared unavailable outcome from the catalog.',
  },
  {
    path: 'user/home/widgets/AlertsWidget.tsx',
    reason: 'no-v5-deliverable',
    note: 'Origin-redesign R2 home-board widget (alerts).',
  },
  {
    path: 'user/home/widgets/AllocationWidget.tsx',
    reason: 'no-v5-deliverable',
    note: 'Origin-redesign R2 home-board widget (allocation).',
  },
  {
    path: 'user/home/widgets/AssetSpotlightWidget.tsx',
    reason: 'no-v5-deliverable',
    note: 'Origin-redesign R2 home-board widget (asset spotlight).',
  },
  {
    path: 'user/home/widgets/AttentionWidget.tsx',
    reason: 'no-v5-deliverable',
    note: 'Origin-redesign R2 home-board widget (attention).',
  },
  {
    path: 'user/home/widgets/CashBalancesWidget.tsx',
    reason: 'no-v5-deliverable',
    note: 'Origin-redesign R2 home-board widget (cash balances).',
  },
  {
    path: 'user/home/widgets/CashflowChartWidget.tsx',
    reason: 'no-v5-deliverable',
    note: 'Origin-redesign R2 home-board widget (cash-flow chart).',
  },
  {
    path: 'user/home/widgets/QuickCashWidget.tsx',
    reason: 'no-v5-deliverable',
    note: 'Origin-redesign R3 quick-cash home widget; the V5 cash surface it calls is reviewed separately.',
  },
  {
    path: 'user/home/widgets/ConcentrationWidget.tsx',
    reason: 'no-v5-deliverable',
    note: 'Origin-redesign R2 home-board widget (concentration).',
  },
  {
    path: 'user/home/widgets/LiquidityWidget.tsx',
    reason: 'no-v5-deliverable',
    note: 'Origin-redesign R2 home-board widget (liquidity).',
  },
  {
    path: 'user/home/widgets/NetWorthHistoryWidget.tsx',
    reason: 'no-v5-deliverable',
    note: 'Origin-redesign R2 home-board widget (net-worth history).',
  },
  {
    path: 'user/home/widgets/NetWorthWidget.tsx',
    reason: 'no-v5-deliverable',
    note: 'Origin-redesign R2 home-board widget (net worth).',
  },
  {
    path: 'user/home/widgets/PerformanceChartWidget.tsx',
    reason: 'no-v5-deliverable',
    note: 'Origin-redesign R2 home-board widget (performance chart).',
  },
  {
    path: 'user/home/widgets/RecentTransactionsWidget.tsx',
    reason: 'no-v5-deliverable',
    note: 'Origin-redesign R2 home-board widget (recent transactions).',
  },
  {
    path: 'user/home/widgets/ShortcutsWidget.tsx',
    reason: 'no-v5-deliverable',
    note: 'Origin-redesign R2 home-board widget (shortcuts).',
  },
  {
    path: 'user/home/widgets/TodayChangeWidget.tsx',
    reason: 'no-v5-deliverable',
    note: 'Origin-redesign R2 home-board widget (today change).',
  },
  {
    path: 'user/home/widgets/TopMoversWidget.tsx',
    reason: 'no-v5-deliverable',
    note: 'Origin-redesign R2 home-board widget (top movers).',
  },
  {
    path: 'user/home/widgets/UpcomingWidget.tsx',
    reason: 'no-v5-deliverable',
    note: 'Origin-redesign R2 home-board widget (upcoming).',
  },
  {
    path: 'user/home/widgets/WatchlistWidget.tsx',
    reason: 'no-v5-deliverable',
    note: 'Origin-redesign R2 home-board widget (watchlist).',
  },
  {
    path: 'user/hub/HubPages.tsx',
    reason: 'no-v5-deliverable',
    note: 'Origin-redesign hub pages — Ask, Review, Developer platform (#935).',
  },
  {
    path: 'user/hooks/useMutationFeedback.tsx',
    reason: 'no-v5-deliverable',
    note: 'Shared toast channel created by the post-V5 UX audit (#1077); callers own its localized copy.',
  },
  {
    path: 'user/people/PeopleLayout.tsx',
    reason: 'no-v5-deliverable',
    note: 'Origin-redesign people workspace chrome (#935).',
  },
  {
    path: 'user/portfolio/PortfolioIconChip.tsx',
    reason: 'no-user-copy',
    note: 'R2 portfolio icon chip; glyph only.',
  },
  {
    path: 'user/portfolio/wizard/ParkedRow.tsx',
    reason: 'no-v5-deliverable',
    note: 'R2 portfolio-wizard parked row.',
  },
  {
    path: 'user/portfolio/wizard/steps/SetupStep.tsx',
    reason: 'no-v5-deliverable',
    note: 'R2 portfolio-wizard setup panel — the name/icon/book steps collapsed onto one screen (2026-07-31).',
  },
  {
    path: 'user/settings/DeleteAccountPage.tsx',
    reason: 'no-v5-deliverable',
    note: 'V4-P2c self-service account deletion.',
  },
  {
    path: 'user/social/ChatPopoutButton.tsx',
    reason: 'no-v5-deliverable',
    note: 'R2 chat pop-out control.',
  },
  {
    path: 'user/social/ChatWindowPage.tsx',
    reason: 'no-v5-deliverable',
    note: 'R2 popped-out chat window; it runs the inventoried chatSurface panes.',
  },
  {
    path: 'user/social/FollowButton.tsx',
    reason: 'no-v5-deliverable',
    note: 'V3 person-follow control.',
  },
  {
    path: 'user/social/FollowingPage.tsx',
    reason: 'no-v5-deliverable',
    note: 'V3 person/item follow collection restored by the post-V5 UX audit (#1073).',
  },
  {
    path: 'user/social/ItemFollowButton.tsx',
    reason: 'no-v5-deliverable',
    note: 'V3 item-follow control.',
  },
  {
    path: 'user/social/SharedPeople.tsx',
    reason: 'no-v5-deliverable',
    note: 'V3 shared-with list.',
  },
  {
    path: 'user/workbench/WorkbenchLayout.tsx',
    reason: 'no-v5-deliverable',
    note: 'Origin-redesign workbench chrome (#935).',
  },
  {
    path: 'user/workboard/AlertsPage.tsx',
    reason: 'no-v5-deliverable',
    note: 'V3-P10b alerts page (#345).',
  },
  {
    path: 'user/workboard/BacktestPanel.tsx',
    reason: 'no-v5-deliverable',
    note: 'V1 backtest panel.',
  },
  {
    path: 'user/workboard/SaveIdeaDialog.tsx',
    reason: 'no-v5-deliverable',
    note: 'V4-P9 save-idea dialog (#530).',
  },
] as const satisfies readonly V5SurfaceExemption[];

/**
 * Route elements that are not surfaces of their own, so the routes rendering
 * them need no inventory row. Each is a mechanical class rather than a
 * judgement: redirects render no copy at all, and the two placeholder elements
 * are themselves classified modules whose copy is reviewed where they live.
 */
export const NON_SURFACE_ROUTE_ELEMENTS: Readonly<Record<string, string>> = {
  LegacyRedirect: 'Forwards an old path to its current one; renders no copy.',
  Navigate: 'react-router redirect; renders no copy.',
  ParkedPage: 'Coming-Soon placeholder; the component is inventoried under the shared V5 shell.',
  NotFoundState: 'Shared not-found state, exempted in NON_V5_SURFACES with its own focused test.',
};

/** Why a registered route needs no inventory row of its own. */
export type V5RouteExemptionReason = 'no-v5-deliverable' | 'inventoried-component';

export interface V5RouteExemption {
  path: string;
  reason: V5RouteExemptionReason;
  note: string;
}

/**
 * Registered routes that are not V5 surfaces. `inventoried-component` means the
 * route renders a component that IS in the inventory — a second entry point or
 * deep link into a reviewed surface — so its copy and states are covered there.
 */
export const NON_V5_ROUTES = [
  {
    path: '/account/delete',
    reason: 'no-v5-deliverable',
    note: 'V4-P2c self-service account deletion.',
  },
  {
    path: '/admin',
    reason: 'no-v5-deliverable',
    note: 'Post-V5 admin rebuild W1 (#1406): the console index stopped redirecting to Users and now lands on the operator Overview.',
  },
  {
    path: '/admin/announcements',
    reason: 'no-v5-deliverable',
    note: 'V4-P5 announcement composer.',
  },
  { path: '/admin/audit', reason: 'no-v5-deliverable', note: 'V1 admin audit log.' },
  { path: '/admin/email', reason: 'no-v5-deliverable', note: 'V1 SMTP diagnostics.' },
  {
    path: '/admin/feedback',
    reason: 'no-v5-deliverable',
    note: 'Post-V5 admin rebuild W3 (#1406): the #1316 inbox URL, kept as a redirect into the Support workspace that replaced it.',
  },
  { path: '/admin/invites', reason: 'no-v5-deliverable', note: 'V1 invite management.' },
  {
    path: '/admin/registration',
    reason: 'no-v5-deliverable',
    note: 'Post-V5 admin rebuild W1 (#1406): the People workspace’s approval queue and access tokens.',
  },
  {
    path: '/admin/support',
    reason: 'no-v5-deliverable',
    note: 'Post-V5 admin rebuild W3 (#1406): the split-pane helpdesk — inbox left, thread right, both addressed by query parameters.',
  },
  {
    path: '/admin/market-data',
    reason: 'no-v5-deliverable',
    note: 'Post-V5 admin rebuild W4 (#1406): the Operations tab that holds W5’s place; a placeholder, not the inspector.',
  },
  {
    path: '/admin/providers',
    reason: 'no-v5-deliverable',
    note: 'Post-V5 admin rebuild W4 (#1406): per-capability circuit-breaker and market-cache signals, split out of the health page.',
  },
  {
    path: '/admin/test-accounts',
    reason: 'no-v5-deliverable',
    note: 'Post-V5 admin rebuild W2 (#1406): the People workspace tab that holds W6’s place; a placeholder, not the factory.',
  },
  { path: '/admin/users/:userId', reason: 'no-v5-deliverable', note: 'V2 admin user detail.' },
  {
    path: '/ask',
    reason: 'no-v5-deliverable',
    note: 'Origin-redesign Ask hub; a parked workspace.',
  },
  {
    path: '/assets',
    reason: 'inventoried-component',
    note: 'AssetsOverviewPage lives in the inventoried user/assets/AssetsSection.tsx (P5).',
  },
  { path: '/assets/search', reason: 'no-v5-deliverable', note: 'V1 §6.2 search page.' },
  {
    path: '/chat-window',
    reason: 'no-v5-deliverable',
    note: 'R2 popped-out chat window over the inventoried chatSurface panes.',
  },
  {
    path: '/chat-window/:userId',
    reason: 'no-v5-deliverable',
    note: 'R2 popped-out chat, deep-linked to a partner.',
  },
  {
    path: '/chat-window/c/:conversationId',
    reason: 'no-v5-deliverable',
    note: 'R2 popped-out chat, deep-linked to a conversation.',
  },
  {
    path: '/developer',
    reason: 'no-v5-deliverable',
    note: 'Origin-redesign developer hub (#935).',
  },
  { path: '/forgot-password', reason: 'no-v5-deliverable', note: 'V2 password-reset request.' },
  { path: '/invite/:token', reason: 'no-v5-deliverable', note: 'V1 invite acceptance.' },
  {
    path: '/people/chat/:userId',
    reason: 'inventoried-component',
    note: 'Deep link into the inventoried ChatPage (P8).',
  },
  {
    path: '/people/chat/c/:conversationId',
    reason: 'inventoried-component',
    note: 'Deep link into the inventoried ChatPage (P8).',
  },
  {
    path: '/people/following',
    reason: 'no-v5-deliverable',
    note: 'V3 person/item follow collection restored by the post-V5 UX audit (#1073).',
  },
  { path: '/reset/:token', reason: 'no-v5-deliverable', note: 'V2 password reset.' },
  {
    path: '/review',
    reason: 'no-v5-deliverable',
    note: 'Origin-redesign Review hub; a parked workspace.',
  },
  { path: '/welcome', reason: 'no-v5-deliverable', note: 'V4 first-run wizard.' },
  { path: '/workbench/alerts', reason: 'no-v5-deliverable', note: 'V3-P10b alerts page.' },
  {
    path: '/workbench/backtests',
    reason: 'inventoried-component',
    note: 'BacktestsPage lives in the inventoried user/workboard/WorkboardSection.tsx (P6).',
  },
] as const satisfies readonly V5RouteExemption[];

/** Async read states that the inventory gate verifies at each hook call site. */
export type V5AsyncReadState = 'loading' | 'error';

/**
 * A read may deliberately delegate or suppress one of its states, but that is
 * a code-review decision rather than an inference the AST gate is allowed to
 * make. Keep every such decision here, tied to one stable read-site name.
 */
export interface V5AsyncReadExemption {
  component: string;
  read: string;
  states: readonly V5AsyncReadState[];
  reason: string;
  delegatedTo?: string;
}

export const V5_ASYNC_READ_EXEMPTIONS = [
  {
    component: 'user/social/chatSurface.tsx',
    read: 'ChipShareShortcut.audienceQuery',
    states: ['loading', 'error'],
    reason:
      'The privacy-sensitive shortcut is intentionally absent unless the owner audience read succeeds; loading, forbidden, and absent remain indistinguishable.',
  },
  {
    component: 'user/social/chatSurface.tsx',
    read: 'ChipShareShortcut.groupsQuery',
    states: ['loading', 'error'],
    reason:
      'The group roster decides whether the shortcut may exist at all: an unresolved or failed read cannot tell an already-admitted group member from an excluded one, so the shortcut stays absent exactly as it does for an unresolved audience read — a spinner or error card inside the chat bubble would advertise a prompt the client cannot yet justify. The full-fidelity path stays the AudiencePicker, which observes the same query key and renders that read’s own states.',
    delegatedTo: 'AudiencePicker',
  },
  {
    component: 'user/components/CmdKPalette.tsx',
    read: 'CmdKPalette.capabilities',
    states: ['loading', 'error'],
    reason:
      'The deploy-time capability bootstrap defaults to "offered", so an unresolved or failed read leaves the palette exactly as it was — there is no state to draw, and the server stays the real boundary.',
  },
  {
    component: 'user/workboard/WorkboardPage.tsx',
    read: 'UpcomingEarningsZone.data',
    states: ['loading', 'error'],
    reason:
      'Binding P5 keeps the optional earnings zone absent while capability is unresolved or unavailable, including request failure.',
  },
  {
    component: 'user/portfolio/PortfolioPage.tsx',
    read: 'DividendIntelSection.marketIntel',
    states: ['loading', 'error'],
    reason:
      'The deploy-time capability bootstrap defaults to "offered", so an unresolved or failed read leaves the dividend block exactly as the two intel reads decide — there is no state of its own to draw, and the server stays the real boundary.',
  },
  {
    component: 'user/portfolio/PortfolioPage.tsx',
    read: 'DividendIntelSection.calendar',
    states: ['loading', 'error'],
    reason:
      'Binding P5 draws no calendar rows while this optional read is in flight or has failed; #1681 only lets the projection stand beside it, and neither read speaks for the other.',
  },
  {
    component: 'user/portfolio/PortfolioPage.tsx',
    read: 'DividendIntelSection.projection',
    states: ['loading', 'error'],
    reason:
      'Binding P5 draws no projected total while this optional read is in flight or has failed. Only a resolved "available: false" — this portfolio could not be computed (#1616, #1681) — is explained in copy; an unsettled read says nothing about the portfolio and must not claim it did.',
  },
  {
    component: 'user/portfolio/PortfolioPage.tsx',
    read: 'PortfolioPage.holdingTransactionQueries',
    states: ['loading', 'error'],
    reason:
      "Each dynamic result is mapped to its holding row; HoldingTransactions renders that row's skeleton, retryable failure, empty state, or ledger.",
    delegatedTo: 'HoldingTransactions',
  },
  {
    component: 'user/portfolio/analytics/AnalyticsPage.tsx',
    read: 'AnalyticsPage.balanceQuery',
    states: ['loading', 'error'],
    reason:
      'The money twin behind the performance curve’s scrub tooltip (board #68 item 4) is a pure enhancement of a chart that draws without it: until it lands, and if it never does, the tooltip renders an em dash for the balance. Blocking or alarming the whole graph on it would be a regression of the read it decorates.',
  },
  {
    component: 'user/portfolio/MirrorchainPanel.tsx',
    read: 'MemberSheet.activityQuery',
    states: ['loading', 'error'],
    reason:
      'MemberSheet passes the complete query to ActivitySection, which renders loading, failure, and empty outcomes in the activity block.',
    delegatedTo: 'ActivitySection',
  },
  {
    component: 'user/portfolio/MirrorchainPanel.tsx',
    read: 'useMirrorInvites.$return',
    states: ['loading', 'error'],
    reason:
      'The shared hook returns the complete query to MirrorInvitesSection, which renders loading and classifies terminal versus retryable failures in Social requests.',
    delegatedTo: 'MirrorInvitesSection',
  },
  {
    component: 'user/assets/AssetDetailPage.tsx',
    read: 'DividendsSection.data',
    states: ['loading', 'error'],
    reason:
      'Binding P5 keeps the optional dividend block absent while capability is unresolved or unavailable, including request failure.',
  },
  {
    component: 'user/assets/AssetDetailPage.tsx',
    read: 'EarningsSection.data',
    states: ['loading', 'error'],
    reason:
      'Binding P5 keeps the optional earnings block absent while capability is unresolved or unavailable, including request failure.',
  },
  {
    component: 'user/assets/AssetDetailPage.tsx',
    read: 'NewsSection.data',
    states: ['loading', 'error'],
    reason:
      'Binding P5 keeps the optional news block absent while capability is unresolved or unavailable, including request failure.',
  },
  {
    component: 'user/assets/AssetDetailPage.tsx',
    read: 'SplitsSection.data',
    states: ['loading', 'error'],
    reason:
      'Binding P5 keeps the optional splits block absent while capability is unresolved or unavailable, including request failure.',
  },
  {
    component: 'user/forecast/ForecastPage.tsx',
    read: 'usePortfolioPrefill.portfoliosQuery',
    states: ['loading', 'error'],
    reason:
      'usePortfolioPrefill returns the portfolio-list flags and retry to ForecastPage, which renders both states.',
    delegatedTo: 'ForecastPage',
  },
  {
    component: 'user/forecast/ForecastPage.tsx',
    read: 'usePortfolioPrefill.portfolioQuery',
    states: ['loading', 'error'],
    reason:
      'usePortfolioPrefill folds the detail flags into its returned prefill flags and retry rendered by ForecastPage.',
    delegatedTo: 'ForecastPage',
  },
  {
    component: 'user/forecast/ForecastPage.tsx',
    read: 'usePortfolioPrefill.analyticsQuery',
    states: ['loading', 'error'],
    reason:
      'usePortfolioPrefill selects this normal-mode read as modeQuery and returns its flags to ForecastPage.',
    delegatedTo: 'ForecastPage',
  },
  {
    component: 'user/forecast/ForecastPage.tsx',
    read: 'usePortfolioPrefill.historyQuery',
    states: ['loading', 'error'],
    reason:
      'usePortfolioPrefill selects this paranoid-mode read as modeQuery and returns its flags to ForecastPage.',
    delegatedTo: 'ForecastPage',
  },
  {
    component: 'user/portfolio/analytics/AiInsightsPanel.tsx',
    read: 'AiInsightsPanel.capability',
    states: ['loading', 'error'],
    reason:
      'The binding P12 capability gate deliberately renders no AI surface until availability is confirmed; loading and failure are therefore indistinguishable from disabled AI.',
  },
  {
    component: 'user/workboard/NlBuilderPanel.tsx',
    read: 'NlBuilderPanel.capability',
    states: ['loading', 'error'],
    reason:
      'The binding P12 capability gate deliberately renders no AI surface until availability is confirmed; loading and failure are therefore indistinguishable from disabled AI.',
  },
  {
    component: 'user/components/OriginShell.tsx',
    read: 'RailAskToggle.available',
    states: ['loading', 'error'],
    reason:
      'The binding P12 capability gate deliberately renders no AI surface until availability is confirmed; while the read is loading or failed the rail row stays a plain link to /ask, which is the same row a disabled provider gets.',
  },
  {
    component: 'user/components/OriginShell.tsx',
    read: 'AskDockMount.available',
    states: ['loading', 'error'],
    reason:
      'The binding P12 capability gate deliberately renders no AI surface until availability is confirmed; loading and failure are therefore indistinguishable from disabled AI, and the floating panel simply is not mounted.',
  },
  {
    component: 'user/parked/ParkedPage.tsx',
    read: 'AiGatedParked.capability',
    states: ['loading', 'error'],
    reason:
      'The binding P12 capability gate decides only whether the parked /ask page may advertise the shipped AI features; unresolved and failed reads fall back to the copy that claims nothing, so there is no state of its own to draw.',
  },
  {
    component: 'user/components/OriginShell.tsx',
    read: 'RailGroup.children',
    states: ['loading', 'error'],
    reason:
      'The navigation helper deliberately defaults runtime feature flags to enabled while they load or fail; server route guards remain the authoritative kill-switch boundary.',
  },
  {
    component: 'user/components/OriginShell.tsx',
    read: 'OriginShell.vaultsQuery',
    states: ['loading', 'error'],
    reason:
      'The global chip is absent until the cleartext vault directory is known; the Privacy manager owns its retryable loading/error states, so shell chrome never paints a false sync result.',
    delegatedTo: 'VaultManager',
  },
  {
    component: 'user/components/OriginShell.tsx',
    read: 'OriginShell.vaultStates',
    states: ['loading', 'error'],
    reason:
      'The chip waits for a complete endpoint-state set instead of omitting a vault or guessing its action; each vault state has loading/retry UI in the Privacy manager.',
    delegatedTo: 'VaultManagerRow',
  },
  {
    component: 'user/portfolio/PortfolioWorkspace.tsx',
    read: 'PortfolioWorkspace.items',
    states: ['loading', 'error'],
    reason:
      'The navigation helper deliberately defaults runtime feature flags to enabled while they load or fail; server route guards remain the authoritative kill-switch boundary.',
  },
  {
    component: 'user/control/panels/PrivacyPanel.tsx',
    read: 'PrivacyPanel.privacy',
    states: ['loading', 'error'],
    reason:
      'AccountModeRoot resolves the same account-scoped privacy query before the authenticated Control Center can mount.',
    delegatedTo: 'AccountModeRoot',
  },
  {
    component: 'user/vault/ui/PortfolioVaultSection.tsx',
    read: 'PortfolioVaultSection.vaultsQuery',
    states: ['error'],
    reason:
      'Most accounts own no vault, so an unreachable vault directory must not sprout a vault error on every portfolio settings page; the move-in entry stays absent and the Privacy manager owns the retryable error state for the same read.',
    delegatedTo: 'VaultManager',
  },
  {
    component: 'user/vault/ui/VaultManager.tsx',
    read: 'VaultManager.endpointQueries',
    states: ['loading', 'error'],
    reason:
      'Every dynamic endpoint query is passed to its matching VaultManagerRow, which renders a disabled loading action or a retry action in the exact vault row.',
    delegatedTo: 'VaultManagerRow',
  },
  {
    component: 'user/home/HomePage.tsx',
    read: 'HomeBoard.$destructured',
    states: ['loading', 'error'],
    reason:
      'AccountModeRoot resolves the same account-scoped privacy query before the authenticated home board can mount.',
    delegatedTo: 'AccountModeRoot',
  },
  {
    component: 'user/control/panels/ConnectionsPanel.tsx',
    read: 'ConnectionsPanel.vaultConfigs',
    states: ['loading', 'error'],
    reason:
      'This read decides whether the Drive-connections group EXISTS (an account with no vault has nothing to bind one to), so the group is deliberately absent while it is unresolved or failing rather than flashing a titled skeleton — and an error card at accounts that should never see the group would be worse than its absence. Once it resolves with a vault, DriveAccountsSection observes the very same query key and renders that read’s skeleton and load-error itself.',
    delegatedTo: 'DriveAccountsSection',
  },
  {
    component: 'user/forecast/ProjectionSection.tsx',
    read: 'ProjectionSection.marketIntel',
    states: ['loading', 'error'],
    reason:
      'The deploy-time capability bootstrap defaults to "offered", so an unresolved or failed read leaves the dividend factor gated on the projection read alone (#1681) — there is no state of its own to draw, and the server stays the real boundary.',
  },
  {
    component: 'user/control/panels/NotificationsPanel.tsx',
    read: 'useRoutableTypes.marketIntel',
    states: ['loading', 'error'],
    reason:
      'The deploy-time capability bootstrap defaults to "offered" (#1699), so an unresolved or failed read leaves every notification row exactly where it was — a skeleton or an error card over the delivery matrix would report a bootstrap failure as a settings failure, and the server refuses an unconfigured type either way.',
  },
  {
    component: 'user/home/AddWidgetDrawer.tsx',
    read: 'AddWidgetDrawer.capabilities',
    states: ['loading', 'error'],
    reason:
      'The deploy-time capability bootstrap defaults to "offered" (#1699), so an unresolved or failed read leaves the catalog exactly as it was — a skeleton or an error card inside the widget picker would replace a working catalog with a state about a bootstrap the user never asked for, and the widget itself still states its own unavailability if a deployment loses the capability later.',
  },
] as const satisfies readonly V5AsyncReadExemption[];

/**
 * The declared boundary of the async-read analysis.
 *
 * Issue #1025 scopes this gate to reads made through "`useQuery` / `useResource`
 * and the established wrappers". Inventoried surfaces also load asynchronously
 * without any of those — an effect that awaits a promise into `useState`, or a
 * `useSyncExternalStore` subscription. Analysing those is deliberately NOT built
 * here (remediation belongs to parent #739), but leaving them unlisted is how a
 * scope limit turns into a silent gap. So the gate enumerates them off the same
 * code, requires each one to appear below with a written note, prints them
 * beside the offender list, and fails on any site that is new or gone.
 *
 * These rows carry no claim about the state UI at each site. They record what
 * the analysis does not look at, and why that is a spec limit rather than an
 * oversight.
 */
export interface V5NonHookAsyncSite {
  component: string;
  /** `<scope>.<mechanism>`, numbered when a scope has several. */
  site: string;
  note: string;
}

export const V5_NON_HOOK_ASYNC_BOUNDARY = [
  {
    component: 'admin/pages/LoginPage.tsx',
    site: 'LoginPage.useEffect',
    note: 'Fetches the API build marker for the footer; a failure is swallowed by design.',
  },
  {
    component: 'user/AuthContext.tsx',
    site: 'AuthProvider.useEffect',
    note: 'Session bootstrap with its own retry/outage state machine, not a rendered read.',
  },
  {
    component: 'user/auth/LoginPage.tsx',
    site: 'LoginPage.useEffect',
    note: 'Probes registration mode and Google availability to decide which controls exist.',
  },
  {
    component: 'user/auth/RegisterPage.tsx',
    site: 'RegisterPage.useEffect#1',
    note: 'Registration info behind the page’s own pending/error phase union.',
  },
  {
    component: 'user/auth/RegisterPage.tsx',
    site: 'RegisterPage.useEffect#2',
    note: 'Resolves the pending Google ticket on a ?google=connected landing.',
  },
  {
    component: 'user/components/TransactionDialog.tsx',
    site: 'TransactionDialog.useEffect#1',
    note: 'Daily closes for the linked asset, driving price/date auto-fill.',
  },
  {
    component: 'user/components/TransactionDialog.tsx',
    site: 'TransactionDialog.useEffect#2',
    note: 'Debounced cash preview for the linked cash row.',
  },
  {
    component: 'user/control/panels/ConnectionsPanel.tsx',
    site: 'useDriveAuthorization.useSyncExternalStore',
    note: 'Drive authorization snapshot from the vault connection controller.',
  },
  {
    component: 'user/control/panels/ConnectionsPanel.tsx',
    site: 'useRegistryAuthorization.useSyncExternalStore',
    note: 'Per-connection GIS authorization snapshot; every state is rendered in the Drive identity row.',
  },
  {
    component: 'user/control/panels/NotificationsPanel.tsx',
    site: 'WebPushRow.useEffect',
    note: 'Reads the browser web-push permission/subscription state on mount.',
  },
  {
    component: 'user/control/panels/VaultTransferActions.tsx',
    site: 'VaultTransferActions.useEffect',
    note: 'Loads registered vault configs and renders explicit loading, error, and empty branches.',
  },
  {
    component: 'user/forecast/StandingOrdersSection.tsx',
    site: 'useVaultStandingOrderMaterialization.useSyncExternalStore',
    note: 'Observes the latest successful scan already retained by the vault engine; the Forecast surface starts no request at this subscription boundary.',
  },
  {
    component: 'user/portfolio/CashDialog.tsx',
    site: 'CashDialog.useEffect',
    note: 'Debounced cash preview against the active store.',
  },
  {
    component: 'user/portfolio/ParanoidTaxReport.tsx',
    site: 'ParanoidTaxReport.useEffect',
    note: 'Paranoid-mode portfolio list from the local vault store, with its own status union.',
  },
  {
    component: 'user/portfolio/ParanoidTaxReport.tsx',
    site: 'ParanoidYearTable.useEffect',
    note: 'Client-side tax derivation, with its own pending/error/ready status union.',
  },
  {
    component: 'user/portfolio/cashflow/RecordCashDialog.tsx',
    site: 'RecordCashDialog.useEffect',
    note: 'Debounced auto-tag rule preview; a failed preview is a courtesy, never surfaced.',
  },
  {
    component: 'user/social/chatSurface.tsx',
    site: 'ChatThreadPane.useEffect',
    note: 'Marks the open thread read — a write, with no rendered state of its own.',
  },
  {
    component: 'user/workboard/ConglomerateBuilderPage.tsx',
    site: 'Builder.useEffect',
    note: 'Debounced autosave; its saving/error states belong to the builder, not to a read.',
  },
] as const satisfies readonly V5NonHookAsyncSite[];

/**
 * Frozen V5 async-state debt. The AST gate prints the concrete line-numbered
 * form of every row, rejects any new row, and rejects stale rows after a fix so
 * this list must shrink alongside #739 remediation.
 */
export interface V5AsyncStateDebt {
  component: string;
  read: string;
  states: readonly V5AsyncReadState[];
}

export type V5AsyncStateDebtLedger = Readonly<
  Record<string, Readonly<Record<string, readonly V5AsyncReadState[]>>>
>;

/**
 * Exact anti-shrinkage baseline; #1147 adds the reviewed on-demand holding
 * read, board #68 item 4 the Analysis money twin behind the scrub tooltip.
 *
 * 184 → 183 with the 2026-08-19 removal of the per-portfolio vault v2 surface
 * (PROJECTPLAN §16): its `VaultsProvider.directory` read is gone. That read is
 * also the cause of #1372 — it fired unconditionally above the router, so an
 * anonymous public share issued a protected `GET /vaults`, took the 401 through
 * the shared unauthorized-session handling, and had its own share query cleared.
 *
 * 183 → 181 with the #1406 W1 admin IA: the approval queue and the registration
 * access tokens moved off SettingsPage into the People workspace's own page, so
 * two reads left the inventoried V5 surface. Neither read was dropped — both are
 * re-analyzed under the deferred non-V5 ledger, with their states still observed.
 *
 * 181 → 182 with the W1 review: HealthPage gained the read-only backup/restore
 * drill panel the Overview's attention row links to. It observes both its
 * loading and its error state, so the zero-debt ceiling below is unaffected.
 *
 * 184 → 185 with the E5 review (PR #1460, F1): ConnectionsPanel hoists the vault
 * config read that decides whether the Drive-connections group has an audience
 * at all. It is one request, not a second — the group's own section observes the
 * same query key — and it is exempted above rather than added to the debt: an
 * absent group is the designed answer while it is unresolved or failing.
 *
 * 185 → 203 with paranoid E8: the shell directory/chip (2), fail-closed
 * portfolio workspace (1), locked stubs/switcher/cards (6), Vault manager (6,
 * including the deferred-action notice that still shows the vault's live next
 * step) and the move-in section on portfolio settings (2) join the reviewed
 * surface. Every read handles both states directly or delegates them to the
 * exact row that owns the retry action. The +18 is disjoint from E5's
 * ConnectionsPanel read above, which E8 does not touch.
 *
 * 203 → 204 with the E6 store resolver (#1416). Exactly one NEW read site:
 * `PortfolioMoveOutAction`'s own endpoint-state fallback, needed because the
 * unlocked in-place view offers move-out without already holding that state
 * (the locked stub still passes its own down, so the stub path gained nothing).
 * It handles both states directly — an UNKNOWN custody state must not be
 * rendered as a locked one — and the debt ceiling stays at zero. The move-out
 * wizard's vault-config read only MOVED files with the extraction; it is the
 * same single read under the same query key.
 *
 * 204 → 206 with the import wizard (#964, §16 2026-07-31). Exactly two NEW read
 * sites, both on the import surface: `ImportPage`'s cash-tag read, which names
 * the rule-tag ids a staged cash row was pre-tagged with (the ids are on the
 * wire, the labels are not), and `ImportReview`'s catalog search, which is how a
 * user pins an unresolved row to an asset. Both join the page's existing
 * `AsyncReadState` group — the tag read as a fourth classified reference read,
 * the search rendering its own loading and empty states inline beside the input
 * it belongs to — so the debt ceiling stays at zero.
 *
 * 206 → 207 with the deep-link state reconciliation (#1526). Exactly one NEW
 * read site: `VaultAccessAction`'s own endpoint-state read, which is what lets a
 * URL-addressed `?action=` be checked against the live vault state instead of
 * being trusted — a locked-out vault deep-linked to `unlock` must not render a
 * live password form. It handles both states itself (a "checking" line while the
 * state loads, a retryable error card when it cannot be read) rather than
 * offering an action nobody verified, so the debt ceiling stays at zero.
 *
 * 207 → 209 with the admin rebuild W4 (#1406). Two NEW read sites, both on
 * `HealthPage`, which W4 turns into the Operations cockpit's landing: the
 * queue/schedule/dead-letter projection, and the public deploy marker that lets
 * the page answer "is my merge live?" with a commit rather than an API version
 * that never changes. Both join the page's existing `AsyncReadState` group, and
 * the queue read carries its own explicit empty AND unavailable states — an
 * idle queue set and a process that cannot see the queues are drawn
 * differently, on purpose. The debt ceiling stays at zero.
 *
 * 209 → 210 with the V5-P8 comment-thread bound (#1613): `CommentThread` splits
 * its ONE unbounded thread read into two — a cheap collapsed summary (count +
 * item reactions, always read) and a paged thread read that only runs, and only
 * polls, while the section is expanded. Both carry loading and error states, and
 * the paged read draws its own empty thread, so the debt ceiling stays at zero.
 *
 * 210 → 211 with the V5-P5 market-intel visibility fix (#1661): `CmdKPalette`
 * reads the deploy-time capability bootstrap so an unconfigured arc has no
 * palette row leading into it. It deliberately draws no loading or error state —
 * the read defaults to "offered", so an unresolved or failed fetch leaves the
 * palette exactly as it was — which is recorded as an exemption above rather
 * than as debt, so the ceiling stays at zero.
 *
 * 215 → 219 with the V5-P5 roll-up honesty pass (#1699): the two market-intel
 * home widgets join the inventory with one digest/calendar read each (both
 * already draw skeletons, a terse unavailable state and an empty state), the
 * widget catalog gains the deploy-capability read that decides whether it offers
 * them at all, and the notifications panel gains the same capability read for
 * its two opt-in market rows. The two capability reads deliberately draw no
 * loading or error state of their own — the bootstrap defaults to "offered", so
 * an unresolved or failed fetch leaves both surfaces exactly as they were — and
 * are recorded as exemptions above rather than as debt, so the ceiling stays at
 * zero.
 *
 * 219 → 220 with the V5-P8 chat chip group rung (#1726): `ChipShareShortcut`
 * resolves the shared group's live roster so a recipient the server already
 * admits through the `group` rung is not falsely prompted. Like the audience
 * read beside it the shortcut is simply absent while that roster is unresolved
 * or failing, recorded as an exemption above, so the ceiling stays at zero.
 *
 * 220 → 223 with the V5-P12 AI-surface gate (#1700): the AI capability read now
 * also decides whether the rail's Ask row is a toggle (`RailAskToggle`), whether
 * the floating panel is mounted at all (`AskDockMount`) and whether the parked
 * `/ask` page advertises the shipped AI features (`AiGatedParked`). All three
 * are the §6.18 gate — an unresolved or failed read is treated exactly like
 * "no provider configured", so there is no loading or error state to draw — and
 * are recorded as exemptions above rather than as debt; the ceiling stays zero.
 */
export const V5_ASYNC_READ_SITE_BASELINE = 223;

/** Ratchet this downward whenever #739 removes a read site or missing state. */
export const V5_ASYNC_STATE_DEBT_CEILING = { readSites: 0, stateGaps: 0 } as const;

export const V5_ASYNC_STATE_DEBT: V5AsyncStateDebtLedger = {};

/**
 * Pre-V5 async-state debt, deliberately deferred to v6 by #1026. This is a
 * separate source-verified ledger: zero V5 debt must never make these older
 * offenders disappear from the review record. The reason each component is
 * outside the V5 deliverable lives beside it in NON_V5_SURFACES.
 */
// #1316 adds one fully handled post-V5 admin feedback read. It increases the
// analyzed non-V5 read universe without adding any deferred state debt.
//
// 56 → 69 with the post-V5 admin rebuild W1 (#1406): the operator Overview (8),
// the People workspace's Registration page (3) and the ⌘K palette (2). Two of the
// Registration reads are the approval-queue and access-token reads that moved off
// the inventoried SettingsPage, so the pair is re-analyzed here rather than lost.
// The Overview reads the approval-queue SIZE off `/admin/stats` rather than
// listing the queue (W1 review M5), which is why it holds eight reads and not
// nine. Every one of the thirteen observes both its loading and its error state,
// which is why the debt ceiling below is unchanged.
// E8 moves PortfolioCardsWidget's two reads into the P13 reviewed inventory.
//
// 67 → 74 with the admin rebuild W2 (#1406). Seven new reads, all analyzed:
//   • People 360 (+4) — the single-account GET that REPLACED the
//     download-the-whole-list read, plus the Access, Sharing, Support and Notes
//     tab reads. The page went from one read to five and from one screen to six,
//     and every one of the five renders `AsyncReadState`.
//   • Registration (+1), Invites (+1), Test accounts (+1) — one `/admin/stats`
//     read each, feeding the workspace tab strip's counts. The counts are
//     decorative by construction: while the read is in flight or failed the
//     strip renders its tabs with no chip rather than a zero, so a failed count
//     can never be mistaken for "nothing is waiting".
// The debt ceiling below is unchanged: none of the seven adds a state gap.
//
// 74 → 75 with the Trusted devices read (#1391). It renders `AsyncReadState`
// for both loading and error, so it adds no state gap either.
//
// 75 → 79 with the admin rebuild W3 (#1406), which is a net +4: one read left
// and five arrived.
//   • −1 — FeedbackPage's list read. The W1 inbox was replaced by the Support
//     workspace and its file deleted, so the read is gone rather than moved.
//   • +1 SupportInbox — the queue read, now filterable and paged.
//   • +1 SupportPage — the standing "waiting on you" count, asked unfiltered so
//     the attention number does not change when the operator searches.
//   • +1 SupportThread — the single-submission GET that makes `?thread=` a
//     shareable link even when the reader's filters exclude that row.
//   • +1 Conversation — the thread's messages.
//   • +1 SubmitterAside — the submitter's other submissions, reusing W2's
//     `/admin/users/:id/support` projection rather than adding a route.
// None of the five adds a state gap: each renders `AsyncReadState` for both
// loading and error at its own read site, and the attention count says
// "unavailable" rather than rendering a failed read as a confident zero. The
// debt ceiling below is therefore unchanged.
//
// 79 → 81 with the admin rebuild W4 (#1406), on top of W3. Both new reads
// belong to the Operations workspace's Providers tab: the per-capability
// breaker projection and the health read that carries the failover
// attribution beside it. Each renders `AsyncReadState` for loading and
// error, and the empty case is explicit in both directions — a provider
// nobody has called lists no capabilities and says so, rather than
// reporting a healthy breaker that does not exist. The debt ceiling below
// is unchanged: neither adds a state gap. (The cockpit's own two new reads
// — queues and the deploy version — land on HealthPage, which is inside the
// reviewed V5 inventory, not this ledger.)
// 81 → 79 with #1699: the news and dividends home widgets leave this deferred
// ledger for the reviewed V5-P5 inventory, taking their one read each with them.
export const DEFERRED_NON_V5_ASYNC_READ_SITE_BASELINE = 79;

// PARANOID-E6 (#1416) pays down one gap: PerformanceChartWidget's single-portfolio
// `historyQuery` now renders `UnavailableHomeAggregate` on isError, so its error
// state is observed and the read leaves the deferred ledger.
export const DEFERRED_NON_V5_ASYNC_STATE_DEBT_CEILING = {
  readSites: 39,
  stateGaps: 58,
} as const;

export const DEFERRED_NON_V5_ASYNC_STATE_DEBT: V5AsyncStateDebtLedger = {
  'user/assets/AssetsWorkspace.tsx': {
    'AssetsWorkspace.items': ['loading', 'error'],
  },
  'user/components/AnnouncementBanner.tsx': {
    'AnnouncementBanner.data': ['loading', 'error'],
  },
  'user/firstrun/FirstRunFigures.tsx': {
    'PreferencesFigure.settings': ['loading', 'error'],
    'PublicProfileFigure.profile': ['loading', 'error'],
    'SecurityFigure.twoFactor': ['loading', 'error'],
    'TaxFigure.settings': ['loading', 'error'],
    'VerifyEmailFigure.link': ['loading', 'error'],
  },
  'user/firstrun/steps/PreferencesStep.tsx': {
    'PreferencesStep.settings': ['loading', 'error'],
  },
  'user/firstrun/steps/PublicProfileStep.tsx': {
    'PublicProfileStep.profile': ['loading', 'error'],
  },
  'user/firstrun/steps/SecurityStep.tsx': {
    'SecurityStep.twoFactor': ['loading', 'error'],
  },
  'user/firstrun/steps/TaxStep.tsx': {
    'TaxStep.settings': ['loading', 'error'],
  },
  'user/firstrun/steps/VerifyEmailStep.tsx': {
    'VerifyEmailStep.link': ['loading', 'error'],
  },
  'user/home/widgets/AlertsWidget.tsx': {
    'AlertsWidget.alertsQuery': ['error'],
  },
  'user/home/widgets/AllocationWidget.tsx': {
    'AllocationWidget.results': ['error'],
  },
  'user/home/widgets/AssetSpotlightWidget.tsx': {
    'AssetSpotlightWidget.historyQuery': ['error'],
    'AssetSpotlightWidget.quoteQuery': ['loading', 'error'],
  },
  'user/home/widgets/AttentionWidget.tsx': {
    'AttentionWidget.notificationsQuery': ['error'],
  },
  'user/home/widgets/CashBalancesWidget.tsx': {
    'CashBalancesWidget.merged': ['error'],
  },
  'user/home/widgets/CashflowChartWidget.tsx': {
    'CashflowChartWidget.combined': ['error'],
  },
  'user/home/widgets/ConcentrationWidget.tsx': {
    'ConcentrationWidget.results': ['error'],
  },
  'user/home/widgets/LiquidityWidget.tsx': {
    'LiquidityWidget.results': ['error'],
  },
  'user/home/widgets/NetWorthHistoryWidget.tsx': {
    'NetWorthHistoryWidget.combined': ['error'],
  },
  'user/home/widgets/NetWorthWidget.tsx': {
    'NetWorthWidget.rollup': ['error'],
  },
  'user/home/widgets/PerformanceChartWidget.tsx': {
    // `historyQuery`'s error row was paid down by PARANOID-E6 (#1416): the
    // single-portfolio branch now renders `UnavailableHomeAggregate` on
    // isError, so the read is observed rather than deferred.
    'PerformanceChartWidget.combined': ['error'],
  },
  'user/home/widgets/QuickCashWidget.tsx': {
    'QuickCashWidget.sourcesQuery': ['error'],
  },
  'user/home/widgets/RecentTransactionsWidget.tsx': {
    'RecentTransactionsWidget.merged': ['error'],
  },
  'user/home/widgets/TodayChangeWidget.tsx': {
    'TodayChangeWidget.rollup': ['error'],
  },
  'user/home/widgets/TopMoversWidget.tsx': {
    'TopMoversWidget.results': ['error'],
  },
  'user/home/widgets/UpcomingWidget.tsx': {
    'UpcomingWidget.ordersQuery': ['error'],
  },
  'user/home/widgets/WatchlistWidget.tsx': {
    'WatchlistSettings.listsQuery': ['loading', 'error'],
    'WatchlistWidget.itemsQuery': ['error'],
    'WatchlistWidget.listsQuery': ['error'],
    'WatchlistWidget.quoteQuery': ['loading', 'error'],
  },
  'user/people/PeopleLayout.tsx': {
    'PeopleLayout.items': ['loading', 'error'],
  },
  'user/settings/DeleteAccountPage.tsx': {
    'DeleteAccountPage.twoFactor': ['loading', 'error'],
  },
  'user/social/FollowButton.tsx': {
    'FollowButton.followingQuery': ['error'],
    'useFollowingEntry.followingQuery': ['loading', 'error'],
  },
  'user/social/ItemFollowButton.tsx': {
    'ItemFollowButton.followsQuery': ['error'],
  },
  'user/workbench/WorkbenchLayout.tsx': {
    'WorkbenchLayout.items': ['loading', 'error'],
  },
};

/**
 * Frozen literal-copy debt, by file. These pre-V5 admin pages were never
 * localized; #739 requires non-V5 surfaces to be preserved, so the debt is
 * recorded rather than paid here. These counts include JSX expression and
 * template literals (the P13b review closed that former scanner blind spot).
 * The test asserts each file stays at or below its budget and that no other file
 * may join the map — so the debt can only shrink, and new hardcoded copy anywhere
 * in the universe fails.
 */
export const LEGACY_LITERAL_COPY: Readonly<Record<string, number>> = {
  'admin/pages/AnnouncementsPage.tsx': 36,
  'admin/pages/AuditPage.tsx': 13,
  'admin/pages/EmailPage.tsx': 21,
  // 14 → 0 and 46 → 0 with the admin rebuild W2 (#1406). Both pages were
  // rewritten and are now fully catalogued in EN + DE — InvitesPage was the
  // console's last untranslated surface. The budgets are dropped to zero rather
  // than deleted so the ratchet still names them: a single hardcoded string
  // reappearing in either file now fails the suite instead of quietly
  // re-spending a budget nobody is watching.
  'admin/pages/InvitesPage.tsx': 0,
  'admin/pages/UserDetailPage.tsx': 0,
};

/**
 * Object-literal property names whose string value reaches the user as copy.
 *
 * The JSX scanner above only sees what a `.tsx` module renders as JSX, so a
 * sentence assembled as `{ error: 'price must be greater than 0.' }` — or one
 * living in a plain `.ts` helper — passed every gate (V5-P14, #1745; the blind
 * spot `docs/i18n.md` describes as (a) and (b)). These are the sinks the
 * non-JSX scanner reads: a literal parked on one of them is copy until proven
 * otherwise, and the proof is a catalog key, not a comment.
 */
export const USER_FACING_SINK_PROPERTIES = [
  'description',
  'error',
  'hint',
  'label',
  'message',
  'notice',
  'placeholder',
  'reason',
  'subtitle',
  'title',
] as const;

/**
 * Frozen non-JSX sink debt, by file — the ratchet for
 * {@link USER_FACING_SINK_PROPERTIES}, seeded at the count that survived
 * #1745's fixes. Read it exactly like {@link LEGACY_LITERAL_COPY}: a file may
 * only ever go DOWN, no file may join the map, and a literal on a sink in any
 * other module fails the suite.
 *
 * What is recorded here, and why it is not simply localized:
 *
 * - `user/vault/**` — English `message:` fields on internal error objects.
 *   They are diagnostic codes, not rendered sentences: the UI dispatches the
 *   accompanying `code` through `vaultStoreErrorKey` / `errorCopy.ts`, which
 *   `registry.test.ts` proves carries EN + DE copy for every member. #1745
 *   leaves them alone by scope.
 * - `ui/charts/fixtures.ts` — sample-series `label`s (ticker symbols and
 *   "Cash") in demo fixtures; they name instruments, not UI copy.
 * - the three `error:`-keyed tone maps (`ImportPreviewTable`, admin `ui.tsx`,
 *   `ProblemsPage`) — the value is a palette token (`red`, `neg`), which the
 *   property name alone cannot distinguish from a sentence. Recorded rather
 *   than special-cased, so the gate keeps no silent exceptions.
 *
 * Those last two groups (the 7 fixture labels and the 3 tone tokens) are
 * **terminal, not reducible**: they are not copy, so nothing will ever localize
 * them away. The ratchet therefore has a permanent floor of 10 — it is a
 * "must not grow" guard for them, and a real burn-down only for the
 * `user/vault/**` rows above.
 */
export const LEGACY_SINK_COPY: Readonly<Record<string, number>> = {
  'admin/components/ui.tsx': 1,
  'admin/pages/ProblemsPage.tsx': 1,
  'ui/charts/fixtures.ts': 7,
  'user/portfolio/import/ImportPreviewTable.tsx': 1,
  'user/vault/drive/driveDataHome.ts': 17,
  'user/vault/drive/gisTokenClient.ts': 4,
  'user/vault/engine/errors.ts': 2,
  'user/vault/engine/paranoidPortfolioStore.ts': 2,
  'user/vault/media/driveConnection.ts': 1,
  'user/vault/media/driveMigration.ts': 5,
  'user/vault/media/mediaSwitcher.ts': 6,
  'user/vault/media/replicatedDataHome.ts': 2,
  'user/vault/portfolioStoreResolver.ts': 3,
  'user/vault/restore.ts': 7,
  'user/vault/serverBlobDataHome.ts': 1,
  'user/vault/standingOrders/materialize.ts': 6,
};
