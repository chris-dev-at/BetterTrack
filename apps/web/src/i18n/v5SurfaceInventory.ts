/**
 * V5-P14 Q1 traceability inventory.
 *
 * A surface is listed once, even when it serves more than one V5 phase. The
 * accompanying test locks the component and route sets, verifies every catalog
 * root in EN and DE, and scans the listed TSX files for literal UI copy. State
 * outcomes are explicit: `covered` points to the implementation/test evidence,
 * `not-applicable` explains why no async state exists, and `hidden-by-design`
 * records a binding privacy/capability decision rather than silently omitting a
 * state.
 */

export type V5ReviewStatus = 'covered' | 'not-applicable' | 'hidden-by-design';

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
      loading: covered(
        'Google/session submit progress in LoginPage.test.tsx and RegisterPage.test.tsx.',
      ),
      empty: notAsync('Credential forms have no collection-backed empty result.'),
      error: covered(
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
      loading: covered('Account defaults spinner; icon set is synchronous and bundled.'),
      empty: notAsync(
        'The defaults record is a required singleton; finite icons are always bundled.',
      ),
      error: covered(
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
    phases: ['P0b'],
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
      loading: covered('Every collection/consent read renders Skeleton or Spinner.'),
      empty: covered('Keys, apps, grants, and first-party apps have compact empty rows/cards.'),
      error: covered(
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
      '/portfolio/cash-flow/accounts',
      '/assets/:id',
    ],
    components: [
      'user/control/panels/ConnectionsPanel.tsx',
      'user/portfolio/SourceBadge.tsx',
      'user/components/TransactionDialog.tsx',
      'user/portfolio/CashSourcesPage.tsx',
      'user/assets/capabilityTags.tsx',
    ],
    copyRoots: [
      'settings.connections',
      'portfolio.sourceTag',
      'portfolio.cashSources',
      'assets.capability',
    ],
    copyReview: 'Google/Drive rows, source labels/filters, and capability tags reviewed.',
    states: {
      loading: covered('Connection and cash-source reads render compact skeletons.'),
      empty: covered(
        'Cash sources have a creation empty state; unsupported capability tags stay absent.',
      ),
      error: covered('Google/Drive and cash-source reads expose localized retry actions.'),
    },
    tests: [
      'user/control/panels/ConnectionsPanel.test.tsx',
      'user/portfolio/SourceBadge.test.tsx',
      'user/portfolio/CashSourcesPage.test.tsx',
    ],
  },
  {
    id: 'p1-performance-and-failover',
    phases: ['P1'],
    routes: ['/portfolio', '/portfolio/analysis', '/workbench', '/assets/:id', '/admin/health'],
    components: [
      'ui/MarketStateBadge.tsx',
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
      empty: covered(
        'Holdings/chart/watchlist/provider absence uses compact shared empty states or neutral rows.',
      ),
      error: covered(
        'Primary reads offer retry/refresh; optional provider blocks keep their established capability behavior.',
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
    id: 'p2-admin-operations',
    phases: ['P2'],
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
      empty: covered(
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
      empty: covered('Bell/log and per-channel setup use compact empty/disabled states.'),
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
      'user/portfolio/TaxReportPage.tsx',
      'user/portfolio/TaxReportPrintPage.tsx',
    ],
    copyRoots: ['settings.taxes', 'portfolio.taxReport', 'vaultExports.tax'],
    copyReview: 'AT/DE/custom modes, exports, print view, and disclaimer terminology reviewed.',
    states: {
      loading: covered(
        'Default, report-year, detail, and print reads expose Skeleton/loading copy.',
      ),
      empty: covered('No mode, no taxable events, and no year data are explicit compact states.'),
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
      loading: covered('Digest renders skeletons; embedded blocks avoid layout churn.'),
      empty: covered('Digest has a shared empty state; configured feeds can render no headlines.'),
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
      'user/workboard/WatchlistsPage.tsx',
      'user/workboard/WorkboardSection.tsx',
    ],
    copyRoots: [
      'workboard.comparison',
      'workboard.conglomerates',
      'workboard.detail',
      'workboard.builder',
      'workboard.ideas',
    ],
    copyReview:
      'N-way comparison and nested Blueprint copy reviewed; malformed German singulars corrected.',
    states: {
      loading: covered('All routed reads use Skeleton/loading frames.'),
      empty: covered(
        'Insufficient selections, no Blueprints/ideas, and no positions are explicit.',
      ),
      error: covered('List/detail/idea errors expose retry; comparison offers parameter recovery.'),
    },
    tests: [
      'user/workboard/ComparisonPage.test.tsx',
      'user/workboard/ConglomerateBuilderPage.test.tsx',
      'user/workboard/ConglomerateDetailPage.test.tsx',
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
      'user/forecast/ProjectionSection.tsx',
      'user/forecast/StandingOrdersSection.tsx',
      'user/forecast/StandingOrderDialog.tsx',
      'user/workboard/BudgetCalculator.tsx',
    ],
    copyRoots: ['forecast', 'workboard.calculator'],
    copyReview:
      'Projection factors, order schedules, and all calculator labels reviewed in informal DE.',
    states: {
      loading: covered('Prefill/order reads show disabled progress or Skeleton rows.'),
      empty: covered('No portfolio, no orders, and no calculator positions have compact guidance.'),
      error: covered(
        'Standing-order load now retries; optional projection factors degrade to editable local inputs.',
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
      empty: covered(
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
        'Lists, profiles, shared pages, chat, and comment count expose skeleton/loading states.',
      ),
      empty: covered('Every collection has a contextual EmptyState or compact no-comments row.'),
      error: covered(
        'Recoverable reads now retry; confirmed 401/403/404 outcomes remain privacy-indistinguishable.',
      ),
    },
    tests: [
      'user/social/CommentThread.test.tsx',
      'user/social/FriendGroupsSection.test.tsx',
      'user/social/FriendsPage.test.tsx',
      'user/social/MySharedItemsPage.test.tsx',
      'user/social/SharedConglomeratePage.test.tsx',
      'user/social/SharedPortfolioPage.test.tsx',
      'user/social/SharedWatchlistPage.test.tsx',
    ],
  },
  {
    id: 'p9-expenses',
    phases: ['P9'],
    routes: [
      '/portfolio/cash-flow',
      '/portfolio/cash-flow/transactions',
      '/portfolio/cash-flow/budgets',
      '/portfolio/cash-flow/categories',
      '/portfolio/cash-flow/rules',
      '/portfolio/cash-flow/import',
    ],
    components: [
      'user/expenses/DashboardPage.tsx',
      'user/expenses/TransactionsPage.tsx',
      'user/expenses/BudgetsPage.tsx',
      'user/expenses/CategoriesPage.tsx',
      'user/expenses/RulesPage.tsx',
      'user/expenses/ImportPage.tsx',
      'user/expenses/TransactionDialog.tsx',
      'user/expenses/BudgetDialog.tsx',
      'user/expenses/CategoryDialog.tsx',
      'user/expenses/RuleDialog.tsx',
    ],
    copyRoots: ['expenses', 'cashflow'],
    copyReview: 'Dashboard, bank import, rules, categories, budgets, and dialogs reviewed.',
    states: {
      loading: covered('All six routed reads render Skeletons; dialogs expose pending labels.'),
      empty: covered(
        'All expense collections and zero-trend results have compact EmptyState guidance.',
      ),
      error: covered(
        'P14 focused regressions cover dashboard, transaction, budget, category, and rule retries.',
      ),
    },
    tests: [
      'user/expenses/DashboardBudgets.test.tsx',
      'user/expenses/TransactionsPage.test.tsx',
      'user/expenses/BudgetsPage.test.tsx',
      'user/expenses/CategoriesPage.test.tsx',
      'user/expenses/RulesPage.test.tsx',
      'user/expenses/ImportPage.test.tsx',
    ],
  },
  {
    id: 'p10-api-platform',
    phases: ['P10'],
    routes: ['/control/webhooks', '/admin/api-keys'],
    components: ['user/control/panels/WebhooksPanel.tsx', 'admin/pages/ApiKeysPage.tsx'],
    copyRoots: ['settings.api.webhooks', 'admin.apiKeys'],
    copyReview:
      'Webhook signing/delivery and key-tier/audit copy reviewed; admin page fully extracted.',
    states: {
      loading: covered('Webhook/key/tier/audit collections render Skeleton or Spinner.'),
      empty: covered('No subscriptions, keys, tiers, or audit rows are explicit.'),
      error: covered('Each collection now exposes its own localized retry action.'),
    },
    tests: ['user/control/panels/WebhooksPanel.test.tsx', 'admin/pages/ApiKeysPage.test.tsx'],
  },
  {
    id: 'p12-local-ai',
    phases: ['P12'],
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
      loading: covered('Admin load and both explicit user-triggered requests expose pending copy.'),
      empty: hidden(
        'Unconfigured AI is invisible to users by binding P12 spec; admin shows Not configured.',
      ),
      error: covered(
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
    phases: ['P0', 'P0c', 'P1', 'P6b', 'P13'],
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
      empty: covered(
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
      'user/control/panels/PrivacyPanel.tsx',
      'user/vault/VaultRuntimeProvider.tsx',
      'user/vault/engine/VaultMoneyEngineProvider.tsx',
      'user/vault/ui/ParanoidEnableWizard.tsx',
      'user/vault/ui/ParanoidSurfaceGate.tsx',
      'user/vault/ui/VaultSyncChip.tsx',
      'user/vault/ui/VaultUnlockGate.tsx',
      'ui/MoneyText.tsx',
      'ui/charts/AllocationDonut.tsx',
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
      'ui/MoneyText.test.tsx',
      'ui/charts/AllocationDonut.test.tsx',
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
      loading: covered('2FA and session-policy resources render localized Spinner states.'),
      empty: notAsync(
        'Policy is a required singleton; 2FA method absence is an actionable setup state.',
      ),
      error: covered('Both resource failures expose retry; save validation remains inline.'),
    },
    tests: ['admin/pages/SecuritySettingsPage.test.tsx'],
  },
] as const satisfies readonly V5SurfaceReview[];
