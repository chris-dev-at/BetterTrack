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
    ],
    copyReview:
      'Intraday/live labels, prior-close label, dense-chart states, and failover status reviewed.',
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
    copyRoots: ['admin.nav'],
    copyReview:
      'Console chrome every V5 admin surface is reached through: the section nav entries added by P0 (Account defaults), P2 (Problems, Monitoring, Usage analytics, Feature flags), P10 (API keys), P12 (AI) and P13c (Security), plus the console title, language switch, and burger-drawer labels.',
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
    ],
    copyRoots: [
      'assets.news',
      'assets.detail.dividends',
      'assets.detail.earnings',
      'assets.detail.splits',
    ],
    copyReview: 'Dividend, earnings, split, per-asset news, and digest wording reviewed.',
    states: {
      loading: unverified('Digest renders skeletons; embedded blocks avoid layout churn.'),
      empty: unverified(
        'Digest has a shared empty state; configured feeds can render no headlines.',
      ),
      error: hidden(
        'Optional per-asset provider blocks are invisible when unconfigured by binding P5 spec; digest failure remains retryable.',
      ),
    },
    tests: ['user/assets/NewsDigestPage.test.tsx', 'user/assets/AssetDetailPage.test.tsx'],
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
    phases: ['P7'],
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
    phases: ['P8'],
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
    routes: ['/control/privacy', '/vault/how-it-works'],
    components: [
      'user/UserApp.tsx',
      'user/control/panels/ParanoidAccountExport.tsx',
      'user/control/panels/PrivacyPanel.tsx',
      'user/control/panels/PrivacyVaultSection.tsx',
      'user/vault/VaultAccountRoot.tsx',
      'user/vault/VaultRuntimeProvider.tsx',
      'user/vault/engine/VaultMoneyEngineProvider.tsx',
      'user/vault/ui/ParanoidEnableWizard.tsx',
      'user/vault/ui/ParanoidSurfaceGate.tsx',
      'user/vault/ui/VaultSyncChip.tsx',
      'user/vault/ui/VaultUnlockGate.tsx',
      // Vaults v2 (docs/VAULTS_V2_DESIGN.md §4): per-portfolio vault UX.
      'user/vault/v2/ui/CreateVaultWizard.tsx',
      'user/vault/v2/ui/LockedPortfolioRow.tsx',
      'user/vault/v2/ui/MoveIntoVaultDialog.tsx',
      'user/vault/v2/ui/MoveOutOfVaultDialog.tsx',
      'user/vault/v2/ui/PortfolioVaultSection.tsx',
      'user/vault/v2/ui/VaultHowItWorksPage.tsx',
      'user/vault/v2/ui/VaultKeyDiagram.tsx',
      'user/vault/v2/ui/VaultQrImportDialog.tsx',
      'user/vault/v2/ui/VaultQrShareDialog.tsx',
      'user/vault/v2/ui/VaultUnlockDialog.tsx',
      'user/vault/v2/ui/VaultsProvider.tsx',
      'ui/MoneyText.tsx',
      'ui/charts/AllocationDonut.tsx',
      'ui/charts/LazyAllocationDonut.tsx',
    ],
    copyRoots: ['privacy', 'vault', 'vaultMoney', 'vaultExports', 'common.charts'],
    copyReview:
      'Discreet masking (including allocation charts), custody, media, enable/unlock/sync, loss, and recovery copy reviewed.',
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
      'user/vault/ui/ParanoidEnableWizard.test.tsx',
      'user/vault/ui/VaultUnlockGate.test.tsx',
      'user/vault/ui/VaultSyncChip.test.tsx',
      'user/vault/v2/ui/PortfolioVaultSection.test.tsx',
      'user/vault/v2/ui/CreateVaultWizard.test.tsx',
      'user/vault/v2/ui/VaultQrShareDialog.test.tsx',
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
      'Phone-safe admin login/traps, registration settings, and user management reviewed in both catalogs; responsive behavior remains covered by the P13b admin-mobile gate.',
    states: {
      loading: covered('Session, settings, user, token, request, and 2FA progress stays explicit.'),
      empty: unverified(
        'User search, registration tokens, and approval requests distinguish empty results.',
      ),
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
    id: 'p13c-admin-session-policy',
    phases: ['P13c'],
    routes: ['/admin/security'],
    components: ['admin/pages/SecuritySettingsPage.tsx'],
    copyRoots: ['admin.security'],
    copyReview: 'Independent 6–24 h admin-session policy and no-step-up wording reviewed.',
    states: {
      loading: unverified('2FA and session-policy resources render localized Spinner states.'),
      empty: notAsync(
        'Policy is a required singleton; 2FA method absence is an actionable setup state.',
      ),
      error: unverified('Both resource failures expose retry; save validation remains inline.'),
    },
    tests: ['admin/pages/SecuritySettingsPage.test.tsx'],
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
    path: 'user/control/panels/SessionsPanel.tsx',
    reason: 'no-v5-deliverable',
    note: 'V2 session list, re-housed by the R2 Control Center.',
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
    path: 'user/home/AddWidgetDrawer.tsx',
    reason: 'no-v5-deliverable',
    note: 'Origin-redesign R2 widget picker.',
  },
  {
    path: 'user/home/WidgetFrame.tsx',
    reason: 'no-v5-deliverable',
    note: 'Origin-redesign R2 widget frame.',
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
    path: 'user/home/widgets/DividendsWidget.tsx',
    reason: 'no-v5-deliverable',
    note: 'Origin-redesign R2 home-board widget (dividends).',
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
    path: 'user/home/widgets/NewsWidget.tsx',
    reason: 'no-v5-deliverable',
    note: 'Origin-redesign R2 home-board widget (news).',
  },
  {
    path: 'user/home/widgets/PerformanceChartWidget.tsx',
    reason: 'no-v5-deliverable',
    note: 'Origin-redesign R2 home-board widget (performance chart).',
  },
  {
    path: 'user/home/widgets/PortfolioCardsWidget.tsx',
    reason: 'no-v5-deliverable',
    note: 'Origin-redesign R2 home-board widget (portfolio cards).',
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
    path: '/admin/announcements',
    reason: 'no-v5-deliverable',
    note: 'V4-P5 announcement composer.',
  },
  { path: '/admin/audit', reason: 'no-v5-deliverable', note: 'V1 admin audit log.' },
  { path: '/admin/email', reason: 'no-v5-deliverable', note: 'V1 SMTP diagnostics.' },
  { path: '/admin/invites', reason: 'no-v5-deliverable', note: 'V1 invite management.' },
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
    component: 'user/vault/v2/ui/VaultsProvider.tsx',
    read: 'VaultsProvider.directory',
    states: ['loading', 'error'],
    reason:
      'The Vaults v2 provider wraps the whole app so it can render neither a spinner nor an error; it projects the read outcome as `status`, and PortfolioVaultSection renders both states from it (asserted in PortfolioVaultSection.test.tsx).',
    delegatedTo: 'PortfolioVaultSection',
  },
  {
    component: 'user/social/chatSurface.tsx',
    read: 'ChipShareShortcut.audienceQuery',
    states: ['loading', 'error'],
    reason:
      'The privacy-sensitive shortcut is intentionally absent unless the owner audience read succeeds; loading, forbidden, and absent remain indistinguishable.',
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
    read: 'DividendIntelSection.calendar',
    states: ['loading', 'error'],
    reason:
      'Binding P5 keeps the optional portfolio dividend block absent while capability is unresolved or unavailable, including request failure.',
  },
  {
    component: 'user/portfolio/PortfolioPage.tsx',
    read: 'DividendIntelSection.projection',
    states: ['loading', 'error'],
    reason:
      'Binding P5 keeps the optional portfolio dividend block absent while capability is unresolved or unavailable, including request failure.',
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
    read: 'RailGroup.children',
    states: ['loading', 'error'],
    reason:
      'The navigation helper deliberately defaults runtime feature flags to enabled while they load or fail; server route guards remain the authoritative kill-switch boundary.',
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
    component: 'user/home/HomePage.tsx',
    read: 'HomeBoard.$destructured',
    states: ['loading', 'error'],
    reason:
      'AccountModeRoot resolves the same account-scoped privacy query before the authenticated home board can mount.',
    delegatedTo: 'AccountModeRoot',
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
    component: 'user/vault/v2/ui/VaultsProvider.tsx',
    site: 'VaultsProvider.useSyncExternalStore',
    note: 'Subscribes to the in-memory vault keyring, which is synchronous local state — no request, so there is nothing to load or fail.',
  },
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
    component: 'user/control/panels/NotificationsPanel.tsx',
    site: 'WebPushRow.useEffect',
    note: 'Reads the browser web-push permission/subscription state on mount.',
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
 */
export const V5_ASYNC_READ_SITE_BASELINE = 184;

/** Ratchet this downward whenever #739 removes a read site or missing state. */
export const V5_ASYNC_STATE_DEBT_CEILING = { readSites: 0, stateGaps: 0 } as const;

export const V5_ASYNC_STATE_DEBT: V5AsyncStateDebtLedger = {};

/**
 * Pre-V5 async-state debt, deliberately deferred to v6 by #1026. This is a
 * separate source-verified ledger: zero V5 debt must never make these older
 * offenders disappear from the review record. The reason each component is
 * outside the V5 deliverable lives beside it in NON_V5_SURFACES.
 */
export const DEFERRED_NON_V5_ASYNC_READ_SITE_BASELINE = 55;

export const DEFERRED_NON_V5_ASYNC_STATE_DEBT_CEILING = {
  readSites: 42,
  stateGaps: 63,
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
    'PerformanceChartWidget.combined': ['error'],
    'PerformanceChartWidget.historyQuery': ['error'],
  },
  'user/home/widgets/PortfolioCardsWidget.tsx': {
    'PortfolioCardsWidget.histories': ['loading', 'error'],
    'PortfolioCardsWidget.summaries': ['loading', 'error'],
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
  'admin/pages/InvitesPage.tsx': 14,
  'admin/pages/UserDetailPage.tsx': 46,
};
