import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';

import { I18nProvider, useI18n } from '../i18n';
import { RealtimeProvider } from '../lib/realtime';

import { AuthProvider, useAuth } from './AuthContext';
import { RequireUser } from './RequireUser';
import { OriginShell } from './components/OriginShell';
import { AnnouncementBanner } from './components/AnnouncementBanner';
import { Splash, Toast } from './components/ui';
import { ForcedPasswordChangePage } from './auth/ForcedPasswordChangePage';
import { ForgotPasswordPage } from './auth/ForgotPasswordPage';
import { InvitePage } from './auth/InvitePage';
import { LoginPage } from './auth/LoginPage';
import { RegisterPage } from './auth/RegisterPage';
import { ResetPasswordPage } from './auth/ResetPasswordPage';
import { PinGate } from './auth/PinGate';
import { VaultRuntimeProvider } from './vault/VaultRuntimeProvider';
import { ForecastPage } from './forecast/ForecastPage';
import { DashboardPage as ExpenseDashboardPage } from './expenses/DashboardPage';
import { TransactionsPage as ExpenseTransactionsPage } from './expenses/TransactionsPage';
import { BudgetsPage as ExpenseBudgetsPage } from './expenses/BudgetsPage';
import { CategoriesPage as ExpenseCategoriesPage } from './expenses/CategoriesPage';
import { RulesPage as ExpenseRulesPage } from './expenses/RulesPage';
import { ImportPage as ExpenseImportPage } from './expenses/ImportPage';
import { PortfolioPage } from './portfolio/PortfolioPage';
import { PortfolioSettingsPage } from './portfolio/PortfolioSettingsPage';
import { AnalyticsPage } from './portfolio/analytics/AnalyticsPage';
import { CashSourcesPage } from './portfolio/CashSourcesPage';
import { ImportPage } from './portfolio/ImportPage';
import { TaxReportPage } from './portfolio/TaxReportPage';
import { TaxReportPrintPage } from './portfolio/TaxReportPrintPage';
import { CustomAssetsPage, TransactionsPage } from './portfolio/PortfolioSection';
import { CashFlowLayout, PortfolioWorkspace } from './portfolio/PortfolioWorkspace';
import { WorkbenchLayout } from './workbench/WorkbenchLayout';
import { WorkboardPage } from './workboard/WorkboardPage';
import { BacktestsPage, CalculatorsPage, WatchlistPage } from './workboard/WorkboardSection';
import { ComparisonPage } from './workboard/ComparisonPage';
import { AlertsPage } from './workboard/AlertsPage';
import { ConglomeratesListPage } from './workboard/ConglomeratesListPage';
import { ConglomerateDetailPage } from './workboard/ConglomerateDetailPage';
import { ConglomerateBuilderPage } from './workboard/ConglomerateBuilderPage';
import { IdeasListPage } from './workboard/IdeasListPage';
import { IdeaWorkboardPage } from './workboard/IdeaWorkboardPage';
import { ConsentPage } from './oauth/ConsentPage';
import { DeleteAccountPage } from './settings/DeleteAccountPage';
import { SearchPage } from './assets/SearchPage';
import { AssetDetailPage } from './assets/AssetDetailPage';
import { NewsDigestPage } from './assets/NewsDigestPage';
import { AssetsOverviewPage } from './assets/AssetsSection';
import { AssetsWorkspace } from './assets/AssetsWorkspace';
import { PeopleLayout } from './people/PeopleLayout';
import { FriendsPage } from './social/FriendsPage';
import { SharedPortfolioPage } from './social/SharedPortfolioPage';
import { SharedConglomeratePage } from './social/SharedConglomeratePage';
import { SharedWatchlistPage } from './social/SharedWatchlistPage';
import { MySharedItemsPage } from './social/MySharedItemsPage';
import { SharedIdeaPage } from './social/SharedIdeaPage';
import { PublicSharePage } from './social/PublicSharePage';
import { PublicProfileViewPage } from './social/PublicProfileViewPage';
import { ProfileSettingsPage } from './social/ProfileSettingsPage';
import { ChatPage } from './social/ChatPage';
import { HomePage } from './home/HomePage';
import { AskPage, ControlCenterPage, PrivacyPage, ReviewPage } from './hub/HubPages';
import { ParkedPage } from './parked/ParkedPage';
import {
  AccountSettingsPage,
  ApiAccessPage,
  BackupsPage,
  ConnectionsPage,
  ImportsExportsPage,
  NewPortfolioDefaultsPage,
  NotificationSettingsPage,
  SecuritySettingsPage,
  SettingsLayout,
} from './settings/SettingsSection';

const queryClient = new QueryClient();

/**
 * Legacy-path redirect that preserves the query string (the active portfolio
 * rides in `?portfolio=`), so pre-redesign deep links land on the same content
 * inside the new structure. `withSplat` appends the route's own `/*` remainder
 * — pass it ONLY on splat routes: `useParams()` also inherits the app-mount
 * `/*` splat from App.tsx, which must never be re-appended.
 */
function LegacyRedirect({ to, withSplat = false }: { to: string; withSplat?: boolean }) {
  const location = useLocation();
  const params = useParams();
  const splat = withSplat ? params['*'] : undefined;
  const target = splat ? `${to.replace(/\/$/, '')}/${splat}` : to;
  return <Navigate replace to={{ pathname: target, search: location.search }} />;
}

/**
 * The non-admin app (PROJECTPLAN.md §6.1, §7.1; docs/redesign/PRODUCT_BLUEPRINT.md).
 * Two app-wide auth gates sit above routing: the session bootstrap (`loading`)
 * and the forced-password-change trap — while either is in effect no
 * `user`/public route is reachable (§6.1); the PIN gate wraps the app the same
 * way, so deep links resolve only after the PIN clears.
 *
 * The authenticated tree is the Origin suite structure (redesign): **Home ·
 * Portfolio · Workbench · Assets · People** plus the utility destinations
 * (Ask, Review, Control Center) and the Developer platform. Every legacy §7.2
 * path redirects into the new structure with its search params intact; every
 * parked surface renders a designed `ParkedPage`, so deep links never 404 and
 * the full product structure is visible today.
 */
function UserShell() {
  const { status } = useAuth();

  if (status === 'loading') return <Splash />;
  if (status === 'password-change-required') return <ForcedPasswordChangePage />;
  // PIN gate wraps the whole app while a PIN-enabled account hasn't been
  // unlocked this browsing session (§6.1) — the trap sits above routing.
  if (status === 'pin-required') return <PinGate />;

  return (
    <Routes>
      <Route path="login" element={<LoginPage />} />
      <Route path="register" element={<RegisterPage />} />
      <Route path="forgot-password" element={<ForgotPasswordPage />} />
      <Route path="reset/:token" element={<ResetPasswordPage />} />
      <Route path="invite/:token" element={<InvitePage />} />
      {/* Public share link (§14, V3-P5): a logged-out, read-only view. */}
      <Route path="s/:token" element={<PublicSharePage />} />
      {/* Public profile (§14, V3-P6): the opt-in, username-slugged public page. */}
      <Route path="u/:username" element={<PublicProfileViewPage />} />
      <Route element={<RequireUser />}>
        {/* OAuth consent (§6.13 part 2) — standalone card outside the shell. */}
        <Route path="oauth/authorize" element={<ConsentPage />} />
        {/* Self-service account deletion (§13.4 V4-P2c, #362). */}
        <Route path="account/delete" element={<DeleteAccountPage />} />
        {/* The Blueprint Builder is a full-screen surface (§6.5) outside the
            shell chrome; legacy Conglomerate paths redirect here. */}
        <Route path="workbench/blueprints/new" element={<ConglomerateBuilderPage />} />
        <Route path="workbench/blueprints/:id/edit" element={<ConglomerateBuilderPage />} />
        {/* Print-to-PDF tax report (§13.5 V5-P4b) — chrome-free document. */}
        <Route path="portfolio/tax/print" element={<TaxReportPrintPage />} />
        <Route element={<OriginShell />}>
          {/* ── Home: the scoped command center ── */}
          <Route index element={<HomePage />} />

          {/* ── Portfolio workspace ── */}
          <Route path="portfolio" element={<PortfolioWorkspace />}>
            <Route index element={<PortfolioPage />} />
            <Route path="activity" element={<TransactionsPage />} />
            <Route path="custom-assets" element={<CustomAssetsPage />} />
            <Route path="cash-flow" element={<CashFlowLayout />}>
              <Route index element={<ExpenseDashboardPage />} />
              <Route path="transactions" element={<ExpenseTransactionsPage />} />
              <Route path="budgets" element={<ExpenseBudgetsPage />} />
              <Route path="categories" element={<ExpenseCategoriesPage />} />
              <Route path="rules" element={<ExpenseRulesPage />} />
              <Route path="import" element={<ExpenseImportPage />} />
              <Route path="accounts" element={<CashSourcesPage />} />
            </Route>
            <Route path="analysis" element={<AnalyticsPage />} />
            <Route path="tax" element={<TaxReportPage />} />
            <Route path="import" element={<ImportPage />} />
            {/* Parked portfolio jobs (PRODUCT_BLUEPRINT §4) — reserved tabs. */}
            <Route path="plan" element={<ParkedPage page="portfolioPlan" />} />
            <Route path="automate" element={<ParkedPage page="automate" />} />
            <Route path="files" element={<ParkedPage page="portfolioFiles" />} />
            <Route path="people" element={<ParkedPage page="portfolioPeople" />} />
            <Route path="settings" element={<PortfolioSettingsPage />} />
            {/* Parked deep surfaces reached from their parent workspaces. */}
            <Route path="events" element={<ParkedPage page="portfolioEvents" />} />
            <Route path="structure" element={<ParkedPage page="portfolioStructure" />} />
            <Route path="health" element={<ParkedPage page="dataHealth" />} />
            <Route path="private-markets" element={<ParkedPage page="privateMarkets" />} />
            <Route path="rebalance" element={<ParkedPage page="rebalance" />} />
            {/* Legacy §7.2 portfolio paths. */}
            <Route path="transactions" element={<LegacyRedirect to="/portfolio/activity" />} />
            <Route path="analytics" element={<LegacyRedirect to="/portfolio/analysis" />} />
            <Route path="cash" element={<LegacyRedirect to="/portfolio/cash-flow/accounts" />} />
          </Route>

          {/* ── Workbench (the possibility space) ── */}
          <Route path="workbench" element={<WorkbenchLayout />}>
            <Route index element={<WorkboardPage />} />
            <Route path="studio" element={<ParkedPage page="studio" />} />
            <Route path="forecasts" element={<ForecastPage />} />
            <Route path="blueprints" element={<ConglomeratesListPage />} />
            <Route path="blueprints/:id" element={<ConglomerateDetailPage />} />
            <Route path="backtests" element={<BacktestsPage />} />
            <Route path="compare" element={<ComparisonPage />} />
            <Route path="ideas" element={<IdeasListPage />} />
            <Route path="ideas/:ideaId" element={<IdeaWorkboardPage />} />
            <Route path="calculators" element={<CalculatorsPage />} />
            <Route path="alerts" element={<AlertsPage />} />
          </Route>

          {/* ── Assets (research) ── */}
          <Route path="assets" element={<AssetsWorkspace />}>
            <Route index element={<AssetsOverviewPage />} />
            <Route path="search" element={<SearchPage />} />
            <Route path="watchlists" element={<WatchlistPage />} />
            <Route path="news" element={<NewsDigestPage />} />
            <Route path="discover" element={<ParkedPage page="discover" />} />
            <Route path="events" element={<ParkedPage page="assetEvents" />} />
            <Route path="screener" element={<ParkedPage page="screener" />} />
            {/* Legacy category stubs fold into Discover. */}
            <Route path="stocks" element={<LegacyRedirect to="/assets/discover" />} />
            <Route path="etfs" element={<LegacyRedirect to="/assets/discover" />} />
            <Route path="crypto" element={<LegacyRedirect to="/assets/discover" />} />
            <Route path="commodities" element={<LegacyRedirect to="/assets/discover" />} />
            <Route path="custom" element={<LegacyRedirect to="/assets/discover" />} />
            <Route path=":id" element={<AssetDetailPage />} />
          </Route>

          {/* ── People (collaboration) ── */}
          <Route path="people" element={<PeopleLayout />}>
            <Route index element={<FriendsPage />} />
            <Route path="chat" element={<ChatPage />} />
            {/* Deep-link by conversation id — declared before :userId (#362). */}
            <Route path="chat/c/:conversationId" element={<ChatPage />} />
            <Route path="chat/:userId" element={<ChatPage />} />
            <Route path="shared" element={<MySharedItemsPage />} />
            <Route path="shared/conglomerates/:id" element={<SharedConglomeratePage />} />
            <Route path="shared/watchlists/:watchlistId" element={<SharedWatchlistPage />} />
            <Route path="shared/ideas/:ideaId" element={<SharedIdeaPage />} />
            <Route path="shared/:portfolioId" element={<SharedPortfolioPage />} />
            <Route path="profile" element={<ProfileSettingsPage />} />
            <Route path="teams" element={<ParkedPage page="teams" />} />
            <Route path="approvals" element={<ParkedPage page="approvals" />} />
          </Route>

          {/* ── Suite utilities ── */}
          <Route path="ask" element={<AskPage />} />
          <Route path="review" element={<ReviewPage />} />
          <Route path="control" element={<ControlCenterPage />} />
          <Route path="control/privacy" element={<PrivacyPage />} />
          <Route path="control/data" element={<ParkedPage page="dataManagement" />} />

          {/* ── Developer platform (full build in the Control Center pass) ── */}
          <Route path="developer" element={<Navigate replace to="/settings/api" />} />
          <Route path="developer/webhooks" element={<Navigate replace to="/settings/api" />} />
          <Route path="developer/mcp" element={<ParkedPage page="mcp" />} />
          <Route path="developer/logs" element={<ParkedPage page="developerLogs" />} />
          <Route path="developer/oauth-apps" element={<ParkedPage page="oauthApps" />} />

          {/* ── Settings (Control Center pages) ── */}
          <Route path="settings" element={<SettingsLayout />}>
            <Route index element={<Navigate to="/settings/account" replace />} />
            <Route path="account" element={<AccountSettingsPage />} />
            <Route path="notifications" element={<NotificationSettingsPage />} />
            <Route path="security" element={<SecuritySettingsPage />} />
            <Route path="taxes" element={<NewPortfolioDefaultsPage />} />
            <Route path="imports" element={<ImportsExportsPage />} />
            <Route path="connections" element={<ConnectionsPage />} />
            <Route path="backups" element={<BackupsPage />} />
            <Route path="api" element={<ApiAccessPage />} />
          </Route>

          {/* The portfolio list/tree destination is the switcher for now. */}
          <Route path="portfolios" element={<LegacyRedirect to="/portfolio" />} />

          {/* ── Legacy section redirects (search params preserved) ── */}
          <Route path="workboard" element={<LegacyRedirect to="/workbench" />} />
          <Route path="workboard/watchlist" element={<LegacyRedirect to="/assets/watchlists" />} />
          <Route path="workboard/alerts" element={<LegacyRedirect to="/workbench/alerts" />} />
          <Route
            path="workboard/backtests"
            element={<LegacyRedirect to="/workbench/backtests" />}
          />
          <Route
            path="workboard/calculators"
            element={<LegacyRedirect to="/workbench/calculators" />}
          />
          <Route
            path="workboard/comparisons"
            element={<LegacyRedirect to="/workbench/compare" />}
          />
          <Route
            path="workboard/conglomerates/*"
            element={<LegacyRedirect to="/workbench/blueprints" withSplat />}
          />
          <Route
            path="workboard/ideas/*"
            element={<LegacyRedirect to="/workbench/ideas" withSplat />}
          />
          <Route path="forecast" element={<LegacyRedirect to="/workbench/forecasts" />} />
          <Route
            path="expenses/*"
            element={<LegacyRedirect to="/portfolio/cash-flow" withSplat />}
          />
          <Route path="social" element={<LegacyRedirect to="/people" />} />
          <Route path="social/friends" element={<LegacyRedirect to="/people" />} />
          <Route path="social/chat/*" element={<LegacyRedirect to="/people/chat" withSplat />} />
          <Route path="social/my-shared" element={<LegacyRedirect to="/people/shared" />} />
          <Route
            path="social/shared-with-me/*"
            element={<LegacyRedirect to="/people/shared" withSplat />}
          />
          <Route path="social/ideas" element={<LegacyRedirect to="/workbench/ideas" />} />
          <Route path="social/profile" element={<LegacyRedirect to="/people/profile" />} />
          <Route path="following" element={<LegacyRedirect to="/people" />} />
        </Route>
      </Route>
      {/* Unknown paths fall back home (which the guard sends to /login if anon). */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/**
 * Realtime gateway socket (§4.5, V3-P7a): live only for a fully authenticated
 * session — anonymous/loading/locked states run without a socket, and every
 * surface keeps its poll/refetch behavior either way.
 */
function RealtimeRoot({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  return <RealtimeProvider enabled={status === 'authenticated'}>{children}</RealtimeProvider>;
}

function VaultRuntimeRoot({ children }: { children: ReactNode }) {
  const { status, user } = useAuth();
  return (
    <VaultRuntimeProvider
      authenticated={status === 'authenticated'}
      userId={status === 'authenticated' ? user?.id : null}
    >
      {children}
    </VaultRuntimeProvider>
  );
}

/** Renders the global 429 toast while it's active (§7.4). Fixed-position overlay — no layout impact. */
function RateLimitToastPortal() {
  const { rateLimitBanner, clearRateLimitBanner } = useAuth();
  if (!rateLimitBanner) return null;
  return <Toast onDismiss={clearRateLimitBanner}>{rateLimitBanner}</Toast>;
}

/**
 * Admin-composed announcements banner (§13.4 V4-P5b) — a stacked, dismissible
 * banner mounted just above the app shell. Rendered only while a session is
 * fully authenticated; silent when nothing's active for the caller.
 */
function AnnouncementBannerRoot() {
  const { status } = useAuth();
  return <AnnouncementBanner enabled={status === 'authenticated'} />;
}

/**
 * Follow the authenticated user's stored UI language (§13.3 V3-P1): whenever the
 * signed-in `me` carries a locale, switch the runtime to it. Renders nothing.
 */
function LocaleSync() {
  const { user } = useAuth();
  const { setLocale } = useI18n();
  const locale = user?.locale;
  useEffect(() => {
    if (locale) setLocale(locale);
  }, [locale, setLocale]);
  return null;
}

export function UserApp() {
  return (
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <VaultRuntimeRoot>
            <LocaleSync />
            <RateLimitToastPortal />
            <RealtimeRoot>
              <AnnouncementBannerRoot />
              <UserShell />
            </RealtimeRoot>
          </VaultRuntimeRoot>
        </AuthProvider>
      </QueryClientProvider>
    </I18nProvider>
  );
}
