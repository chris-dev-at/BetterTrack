import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Suspense, lazy, useEffect } from 'react';
import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';

import { I18nProvider, useI18n, useT } from '../i18n';
import { RealtimeProvider } from '../lib/realtime';
import { NotFoundState } from '../ui';

import { AuthProvider, useAuth } from './AuthContext';
import { RequireUser } from './RequireUser';
import { FirstRunGate } from './firstrun/FirstRunGate';
import { OriginShell } from './components/OriginShell';
import { AnnouncementBanner } from './components/AnnouncementBanner';
import { AuthCard, Button, Splash, Toast } from './components/ui';
import { ForcedPasswordChangePage } from './auth/ForcedPasswordChangePage';
import { ForgotPasswordPage } from './auth/ForgotPasswordPage';
import { InvitePage } from './auth/InvitePage';
import { LoginPage } from './auth/LoginPage';
import { RegisterPage } from './auth/RegisterPage';
import { ResetPasswordPage } from './auth/ResetPasswordPage';
import { PinGate } from './auth/PinGate';
import { VaultRuntimeProvider } from './vault/VaultRuntimeProvider';
import { VaultMoneyEngineProvider } from './vault/engine/VaultMoneyEngineProvider';
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
import { ChatPage } from './social/ChatPage';
import { ChatWindowPage } from './social/ChatWindowPage';
import { HomePage } from './home/HomePage';
import { AskPage, DeveloperPlatformPage, ReviewPage } from './hub/HubPages';
import { ControlCenterOverlay } from './control/ControlCenterOverlay';
import { ParkedPage } from './parked/ParkedPage';

/**
 * The app-wide query cache. Exported so tests that mount {@link UserApp} more
 * than once can `clear()` it between cases — the client is a module singleton,
 * so without that a `staleTime`d response from one case is still served to the
 * next one.
 */
export const queryClient = new QueryClient();

/**
 * First-run setup (`/welcome`). Lazy: a wizard that most sessions never open
 * has no business in the main bundle, and it pulls in the QR renderer.
 */
const WelcomePage = lazy(() =>
  import('./firstrun/WelcomePage').then((m) => ({ default: m.WelcomePage })),
);

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
  const t = useT();
  const { status, retrySession } = useAuth();

  if (status === 'loading') return <Splash />;
  if (status === 'session-unavailable') {
    return (
      <AuthCard subtitle={t('auth.common.sessionUnavailableTitle')}>
        <div className="flex flex-col gap-4">
          <p className="bt-soft text-sm">{t('auth.common.sessionUnavailableBody')}</p>
          <Button onClick={retrySession}>{t('common.retry')}</Button>
        </div>
      </AuthCard>
    );
  }
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
        {/* First-run setup reaches an account from wherever it lands, in every
            registration mode (§6.12) — one gate for the whole authenticated
            tree rather than a redirect bolted onto the signup screens. It
            self-exempts /welcome and the OAuth authorize flow. */}
        <Route element={<FirstRunGate />}>
          {/* OAuth consent (§6.13 part 2) — standalone card outside the shell. */}
          <Route path="oauth/authorize" element={<ConsentPage />} />
          {/* Self-service account deletion (§13.4 V4-P2c, #362). */}
          <Route path="account/delete" element={<DeleteAccountPage />} />
          {/* First-run setup — a full-screen gate canvas outside the shell chrome.
            Registration lands here; ⌘K "Run setup again" re-opens it any time. */}
          <Route
            path="welcome"
            element={
              <Suspense fallback={<Splash />}>
                <WelcomePage />
              </Suspense>
            }
          />
          {/* The Blueprint Builder is a full-screen surface (§6.5) outside the
            shell chrome; legacy Conglomerate paths redirect here. */}
          <Route path="workbench/blueprints/new" element={<ConglomerateBuilderPage />} />
          <Route path="workbench/blueprints/:id/edit" element={<ConglomerateBuilderPage />} />
          {/* Print-to-PDF tax report (§13.5 V5-P4b) — chrome-free document. */}
          <Route path="portfolio/tax/print" element={<TaxReportPrintPage />} />
          {/* Popped-out friend chat (R2) — a chrome-free second-screen window.
            Deep-linkable and refresh-safe: the open thread is in the URL. */}
          <Route path="chat-window" element={<ChatWindowPage />} />
          <Route path="chat-window/c/:conversationId" element={<ChatWindowPage />} />
          <Route path="chat-window/:userId" element={<ChatWindowPage />} />
          <Route element={<OriginShell />}>
            {/* ── Home: the scoped command center ── */}
            <Route index element={<HomePage />} />

            {/* ── Portfolio workspace ── */}
            <Route path="portfolio" element={<PortfolioWorkspace />}>
              <Route index element={<PortfolioPage />} />
              <Route path="activity" element={<TransactionsPage />} />
              {/* Custom assets are user-scoped (`/api/v1/custom-assets`), not a
                  portfolio's own list, so they live under Assets now. */}
              <Route path="custom-assets" element={<LegacyRedirect to="/assets/custom-assets" />} />
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
              <Route path="custom-assets" element={<CustomAssetsPage />} />
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
              {/* Public-profile SETTINGS live in the Control Center panel now
                  (the account menu, this rail tab and ⌘K all point here); the
                  public profile VIEW is still `/u/:username`. */}
              <Route path="profile" element={<LegacyRedirect to="/control/profile" />} />
              <Route path="teams" element={<ParkedPage page="teams" />} />
              <Route path="approvals" element={<ParkedPage page="approvals" />} />
            </Route>

            {/* ── Suite utilities ── */}
            <Route path="ask" element={<AskPage />} />
            <Route path="review" element={<ReviewPage />} />
            {/* The Control Center is an OVERLAY (R2): `/control` opens it on the
              default panel, `/control/:panel` deep-links one. `control/data`
              is declared as its own page — a static segment outranks the
              dynamic `:panel`, so Data management keeps its full page. */}
            <Route path="control/data" element={<ParkedPage page="dataManagement" />} />
            {/* ONE route node for the overlay: `/control` and `/control/:panel`
              matching separate nodes would remount the dialog on every panel
              switch and replay its entrance animation. */}
            <Route path="control/:panel?" element={<ControlCenterOverlay />} />

            {/* ── Developer platform ── */}
            <Route path="developer" element={<DeveloperPlatformPage />} />
            <Route path="developer/webhooks" element={<LegacyRedirect to="/control/webhooks" />} />
            <Route path="developer/mcp" element={<ParkedPage page="mcp" />} />
            <Route path="developer/logs" element={<ParkedPage page="developerLogs" />} />
            <Route path="developer/oauth-apps" element={<ParkedPage page="oauthApps" />} />

            {/* ── Retired `/settings/*` shell → Control Center panels ──
              Every legacy settings path redirects onto its panel WITH the
              query string intact: the Google OAuth callback lands the browser
              on `/settings/connections?google=linked|error=…` (apps/api), and
              ConnectionsPage reads exactly those params. */}
            <Route path="settings" element={<LegacyRedirect to="/control" />} />
            <Route path="settings/account" element={<LegacyRedirect to="/control/account" />} />
            <Route
              path="settings/notifications"
              element={<LegacyRedirect to="/control/notifications" />}
            />
            {/* Security split into Sign-in (credentials) + Sessions (devices +
                app lock); the legacy path lands on the credentials half. */}
            <Route path="settings/security" element={<LegacyRedirect to="/control/sign-in" />} />
            {/* Public profile moved into the Control Center (owner order). */}
            <Route path="settings/profile" element={<LegacyRedirect to="/control/profile" />} />
            <Route path="settings/taxes" element={<LegacyRedirect to="/control/defaults" />} />
            <Route
              path="settings/connections"
              element={<LegacyRedirect to="/control/connections" />}
            />
            <Route path="settings/api" element={<LegacyRedirect to="/control/api" />} />
            {/* Imports/exports and backups were Coming-Soon stubs; the parked
              Data management page is the surface that now covers them. */}
            <Route path="settings/imports" element={<LegacyRedirect to="/control/data" />} />
            <Route path="settings/backups" element={<LegacyRedirect to="/control/data" />} />
            <Route path="settings/*" element={<LegacyRedirect to="/control" />} />

            {/* The portfolio list/tree destination is the switcher for now. */}
            <Route path="portfolios" element={<LegacyRedirect to="/portfolio" />} />

            {/* ── Legacy section redirects (search params preserved) ── */}
            <Route path="workboard" element={<LegacyRedirect to="/workbench" />} />
            <Route
              path="workboard/watchlist"
              element={<LegacyRedirect to="/assets/watchlists" />}
            />
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
            {/* This stays beneath the existing authenticated/onboarding gates,
                so signed-out visitors still resolve through RequireUser. */}
            <Route path="*" element={<NotFoundState homeTo="/" />} />
          </Route>
        </Route>
      </Route>
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
      <VaultMoneyEngineProvider>{children}</VaultMoneyEngineProvider>
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
