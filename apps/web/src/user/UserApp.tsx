import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, useParams, type Location } from 'react-router-dom';

import { I18nProvider, useI18n, useT } from '../i18n';
import { RealtimeProvider } from '../lib/realtime';
import { NotFoundState } from '../ui';

import { AuthProvider, useAuth } from './AuthContext';
import { VaultsProvider } from './vault/v2/ui/VaultsProvider';
import { RequireUser } from './RequireUser';
import { FirstRunGate } from './firstrun/FirstRunGate';
import { OriginShell } from './components/OriginShell';
import { AnnouncementBanner } from './components/AnnouncementBanner';
import { AuthCard, Button, Spinner, Splash } from './components/ui';
import { apiPortfolioStore } from '../lib/portfolioStore';
import { PortfolioStoreProvider } from './portfolio/PortfolioStoreProvider';
import { CashLayout, PortfolioWorkspace } from './portfolio/PortfolioWorkspace';
import { WorkbenchLayout } from './workbench/WorkbenchLayout';
import { AssetsWorkspace } from './assets/AssetsWorkspace';
import { PeopleLayout } from './people/PeopleLayout';
import { MutationFeedbackProvider, useMutationFeedback } from './hooks/useMutationFeedback';
import { ResolvedPrivacyModeProvider, usePrivacyMode } from './vault/usePrivacyMode';
import { matchControlPanel, matchesVaultEnableRequest } from './control/matchControlPanel';
import { useThemeWatcher } from './useTheme';
import { useUiScaleWatcher } from './useUiScale';

/**
 * The app-wide query cache. Exported so tests that mount {@link UserApp} more
 * than once can `clear()` it between cases — the client is a module singleton,
 * so without that a `staleTime`d response from one case is still served to the
 * next one.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Individual reads retain their deliberately chosen staleness and polling;
      // these guardrails only apply when a new query forgets to declare them.
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const ForcedPasswordChangePage = lazy(() =>
  import('./auth/ForcedPasswordChangePage').then((m) => ({ default: m.ForcedPasswordChangePage })),
);
const ControlCenterOverlay = lazy(() =>
  import('./control/ControlCenterOverlay').then((m) => ({ default: m.ControlCenterOverlay })),
);
const ForgotPasswordPage = lazy(() =>
  import('./auth/ForgotPasswordPage').then((m) => ({ default: m.ForgotPasswordPage })),
);
const InvitePage = lazy(() => import('./auth/InvitePage').then((m) => ({ default: m.InvitePage })));
const LoginPage = lazy(() => import('./auth/LoginPage').then((m) => ({ default: m.LoginPage })));
const RegisterPage = lazy(() =>
  import('./auth/RegisterPage').then((m) => ({ default: m.RegisterPage })),
);
const ResetPasswordPage = lazy(() =>
  import('./auth/ResetPasswordPage').then((m) => ({ default: m.ResetPasswordPage })),
);
const PinGate = lazy(() => import('./auth/PinGate').then((m) => ({ default: m.PinGate })));
const WelcomePage = lazy(() =>
  import('./firstrun/WelcomePage').then((m) => ({ default: m.WelcomePage })),
);
const ForecastPage = lazy(() =>
  import('./forecast/ForecastPage').then((m) => ({ default: m.ForecastPage })),
);
const CashOverviewPage = lazy(() =>
  import('./portfolio/cashflow/CashOverviewPage').then((m) => ({ default: m.CashOverviewPage })),
);
const CashMovementsPage = lazy(() =>
  import('./portfolio/cashflow/CashMovementsPage').then((m) => ({
    default: m.CashMovementsPage,
  })),
);
const CashBudgetsPage = lazy(() =>
  import('./portfolio/cashflow/CashBudgetsPage').then((m) => ({ default: m.CashBudgetsPage })),
);
const CashLabelsPage = lazy(() =>
  import('./portfolio/cashflow/CashLabelsPage').then((m) => ({ default: m.CashLabelsPage })),
);
const PortfolioPage = lazy(() =>
  import('./portfolio/PortfolioPage').then((m) => ({ default: m.PortfolioPage })),
);
const PortfolioSettingsPage = lazy(() =>
  import('./portfolio/PortfolioSettingsPage').then((m) => ({ default: m.PortfolioSettingsPage })),
);
const AnalyticsPage = lazy(() =>
  import('./portfolio/analytics/AnalyticsPage').then((m) => ({ default: m.AnalyticsPage })),
);
const CashSourcesPage = lazy(() =>
  import('./portfolio/CashSourcesPage').then((m) => ({ default: m.CashSourcesPage })),
);
const ImportPage = lazy(() =>
  import('./portfolio/ImportPage').then((m) => ({ default: m.ImportPage })),
);
const TaxReportPage = lazy(() =>
  import('./portfolio/TaxReportPage').then((m) => ({ default: m.TaxReportPage })),
);
const TaxReportPrintPage = lazy(() =>
  import('./portfolio/TaxReportPrintPage').then((m) => ({ default: m.TaxReportPrintPage })),
);
const CustomAssetsPage = lazy(() =>
  import('./portfolio/PortfolioSection').then((m) => ({ default: m.CustomAssetsPage })),
);
const TransactionsPage = lazy(() =>
  import('./portfolio/PortfolioSection').then((m) => ({ default: m.TransactionsPage })),
);
const WorkboardPage = lazy(() =>
  import('./workboard/WorkboardPage').then((m) => ({ default: m.WorkboardPage })),
);
const BacktestsPage = lazy(() =>
  import('./workboard/WorkboardSection').then((m) => ({ default: m.BacktestsPage })),
);
const CalculatorsPage = lazy(() =>
  import('./workboard/WorkboardSection').then((m) => ({ default: m.CalculatorsPage })),
);
const WatchlistPage = lazy(() =>
  import('./workboard/WorkboardSection').then((m) => ({ default: m.WatchlistPage })),
);
const WatchlistDetailPage = lazy(() =>
  import('./workboard/WatchlistDetailPage').then((m) => ({ default: m.WatchlistDetailPage })),
);
const ComparisonPage = lazy(() =>
  import('./workboard/ComparisonPage').then((m) => ({ default: m.ComparisonPage })),
);
const AlertsPage = lazy(() =>
  import('./workboard/AlertsPage').then((m) => ({ default: m.AlertsPage })),
);
const ConglomeratesListPage = lazy(() =>
  import('./workboard/ConglomeratesListPage').then((m) => ({
    default: m.ConglomeratesListPage,
  })),
);
const ConglomerateDetailPage = lazy(() =>
  import('./workboard/ConglomerateDetailPage').then((m) => ({
    default: m.ConglomerateDetailPage,
  })),
);
const ConglomerateBuilderPage = lazy(() =>
  import('./workboard/ConglomerateBuilderPage').then((m) => ({
    default: m.ConglomerateBuilderPage,
  })),
);
const IdeasListPage = lazy(() =>
  import('./workboard/IdeasListPage').then((m) => ({ default: m.IdeasListPage })),
);
const IdeaWorkboardPage = lazy(() =>
  import('./workboard/IdeaWorkboardPage').then((m) => ({ default: m.IdeaWorkboardPage })),
);
const ConsentPage = lazy(() =>
  import('./oauth/ConsentPage').then((m) => ({ default: m.ConsentPage })),
);
const DeleteAccountPage = lazy(() =>
  import('./settings/DeleteAccountPage').then((m) => ({ default: m.DeleteAccountPage })),
);
const SearchPage = lazy(() =>
  import('./assets/SearchPage').then((m) => ({ default: m.SearchPage })),
);
const AssetDetailPage = lazy(() =>
  import('./assets/AssetDetailPage').then((m) => ({ default: m.AssetDetailPage })),
);
const NewsDigestPage = lazy(() =>
  import('./assets/NewsDigestPage').then((m) => ({ default: m.NewsDigestPage })),
);
const AssetsOverviewPage = lazy(() =>
  import('./assets/AssetsSection').then((m) => ({ default: m.AssetsOverviewPage })),
);
const FriendsPage = lazy(() =>
  import('./social/FriendsPage').then((m) => ({ default: m.FriendsPage })),
);
const FollowingPage = lazy(() =>
  import('./social/FollowingPage').then((m) => ({ default: m.FollowingPage })),
);
const SharedPortfolioPage = lazy(() =>
  import('./social/SharedPortfolioPage').then((m) => ({ default: m.SharedPortfolioPage })),
);
const SharedConglomeratePage = lazy(() =>
  import('./social/SharedConglomeratePage').then((m) => ({ default: m.SharedConglomeratePage })),
);
const SharedWatchlistPage = lazy(() =>
  import('./social/SharedWatchlistPage').then((m) => ({ default: m.SharedWatchlistPage })),
);
const MySharedItemsPage = lazy(() =>
  import('./social/MySharedItemsPage').then((m) => ({ default: m.MySharedItemsPage })),
);
const SharedIdeaPage = lazy(() =>
  import('./social/SharedIdeaPage').then((m) => ({ default: m.SharedIdeaPage })),
);
const PublicSharePage = lazy(() =>
  import('./social/PublicSharePage').then((m) => ({ default: m.PublicSharePage })),
);
const PublicProfileViewPage = lazy(() =>
  import('./social/PublicProfileViewPage').then((m) => ({ default: m.PublicProfileViewPage })),
);
const ChatPage = lazy(() => import('./social/ChatPage').then((m) => ({ default: m.ChatPage })));
const ChatWindowPage = lazy(() =>
  import('./social/ChatWindowPage').then((m) => ({ default: m.ChatWindowPage })),
);
const HomePage = lazy(() => import('./home/HomePage').then((m) => ({ default: m.HomePage })));
const AskPage = lazy(() => import('./hub/HubPages').then((m) => ({ default: m.AskPage })));
const DeveloperPlatformPage = lazy(() =>
  import('./hub/HubPages').then((m) => ({ default: m.DeveloperPlatformPage })),
);
const ReviewPage = lazy(() => import('./hub/HubPages').then((m) => ({ default: m.ReviewPage })));
const ParkedPage = lazy(() =>
  import('./parked/ParkedPage').then((m) => ({ default: m.ParkedPage })),
);
const VaultAccountRoot = lazy(() =>
  import('./vault/VaultAccountRoot').then((m) => ({ default: m.VaultAccountRoot })),
);
const VaultHowItWorksPage = lazy(() =>
  import('./vault/v2/ui/VaultHowItWorksPage').then((m) => ({ default: m.VaultHowItWorksPage })),
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
 * The page the Control Center popup opens over when it is reached cold — a
 * bookmark, a pasted link, a fresh tab, an email link. The popup always needs a
 * real page behind it, and Home is the one destination that is always there.
 */
const CONTROL_COLD_BACKGROUND: Location = {
  pathname: '/',
  search: '',
  hash: '',
  state: null,
  key: 'default',
};

/**
 * Paths that must never be remembered as the page behind the popup, because
 * they do not STAY — each one navigates away as soon as it renders, and a
 * background that navigates takes the popup's own URL with it.
 *
 * Two families:
 *
 *  - the legacy paths whose entire job is to redirect INTO the popup. Used as a
 *    background, the redirect that opened the popup sits underneath it and
 *    fires again on the next render — a loop, not a background. Keep in sync
 *    with the `LegacyRedirect to="/control/…"` routes below.
 *  - the public gates. `/login` renders while a session is being established
 *    and then leaves; if it were the background, signing in from a legacy
 *    `/settings/*` link would open the popup over a login screen that
 *    immediately redirects, replacing `/control/…` in the URL and closing the
 *    popup that just opened.
 */
const NEVER_A_BACKGROUND: readonly RegExp[] = [
  /^\/settings(?:\/|$)/,
  /^\/people\/profile\/?$/,
  /^\/developer\/webhooks\/?$/,
  // Two hops: `/social/profile` → `/people/profile` → `/control/profile`.
  /^\/social\/profile\/?$/,
  /^\/(?:login|register|forgot-password|welcome)\/?$/,
  /^\/(?:reset|invite)\//,
  /^\/oauth\/authorize\/?$/,
  /^\/account\/delete\/?$/,
];

function isTransientLocation(pathname: string): boolean {
  return NEVER_A_BACKGROUND.some((pattern) => pattern.test(pathname));
}

function href(location: Location): string {
  return `${location.pathname}${location.search}${location.hash}`;
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
  const location = useLocation();

  /**
   * The Control Center is a POPUP, not a page (owner): `/control/:panel` must
   * open ON TOP of whatever the user is looking at instead of replacing it with
   * a blank canvas — which is what a route element did, since a route element
   * renders *instead of* the page.
   *
   * So while the popup is open the route tree below renders against the last
   * non-popup location, and the popup is rendered beside it. `<Routes location>`
   * also publishes that location as the LocationContext, so the page behind
   * keeps its own `useLocation`, its `?portfolio=` search params and its active
   * nav states — it does not just stay painted, it stays *itself*.
   *
   * The background is REMEMBERED rather than carried in link state: every route
   * into the popup — the rail, ⌘K, the account menu, a legacy `/settings/*`
   * redirect, a bookmark — then opens over the page it was opened from, with no
   * per-link ceremony that a future call site could forget.
   */
  const control = matchControlPanel(location.pathname);
  const background = useRef<Location>(CONTROL_COLD_BACKGROUND);
  // Only a page an authenticated session is actually looking at can be the page
  // behind the popup: anything rendered while the session is still resolving is
  // a gate on its way somewhere else.
  if (status === 'authenticated' && control === null && !isTransientLocation(location.pathname)) {
    background.current = location;
  }
  const pageLocation = control === null ? location : background.current;

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
    <>
      <UserRoutes location={pageLocation} />
      {/* The popup lives OUTSIDE the route tree, so it needs the guard the tree
          gives its pages: only a fully authenticated session may see account
          settings. First run is handled by its own gate inside the tree, which
          navigates to /welcome and closes the popup with it. */}
      {control !== null && status === 'authenticated' ? (
        // The page behind stays painted while the overlay's chunk arrives, so a
        // null fallback would read as "the click did nothing". `bt-cc` is the
        // popup's own centering layer (fixed, click-through), which puts the
        // spinner exactly where the panel is about to appear.
        <Suspense
          fallback={
            <div className="bt-cc">
              <Spinner />
            </div>
          }
        >
          <ControlCenterOverlay closeTo={href(background.current)} panel={control.panel} />
        </Suspense>
      ) : null}
    </>
  );
}

/**
 * A chrome-free route's own loading boundary. These pages render OUTSIDE
 * `OriginShell`, so without one a cold chunk would suspend all the way up to
 * the app-level boundary and flash the whole tree — providers included — to
 * `Splash`. Contained here, only the route area waits.
 */
function FullScreenRoute({ page }: { page: ReactNode }) {
  return <Suspense fallback={<Splash />}>{page}</Suspense>;
}

/** The authenticated route tree, rendered at `location` (see {@link UserShell}). */
function UserRoutes({ location }: { location: Location }) {
  return (
    <Routes location={location}>
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
          <Route path="oauth/authorize" element={<FullScreenRoute page={<ConsentPage />} />} />
          {/* Self-service account deletion (§13.4 V4-P2c, #362). */}
          <Route path="account/delete" element={<FullScreenRoute page={<DeleteAccountPage />} />} />
          {/* First-run setup — a full-screen gate canvas outside the shell chrome.
            Registration lands here; ⌘K "Run setup again" re-opens it any time. */}
          <Route path="welcome" element={<FullScreenRoute page={<WelcomePage />} />} />
          {/* The Blueprint Builder is a full-screen surface (§6.5) outside the
            shell chrome; legacy Conglomerate paths redirect here. */}
          <Route
            path="workbench/blueprints/new"
            element={<FullScreenRoute page={<ConglomerateBuilderPage />} />}
          />
          <Route
            path="workbench/blueprints/:id/edit"
            element={<FullScreenRoute page={<ConglomerateBuilderPage />} />}
          />
          {/* Print-to-PDF tax report (§13.5 V5-P4b) — chrome-free document. */}
          <Route
            path="portfolio/tax/print"
            element={<FullScreenRoute page={<TaxReportPrintPage />} />}
          />
          {/* Popped-out friend chat (R2) — a chrome-free second-screen window.
            Deep-linkable and refresh-safe: the open thread is in the URL. */}
          <Route path="chat-window" element={<FullScreenRoute page={<ChatWindowPage />} />} />
          <Route
            path="chat-window/c/:conversationId"
            element={<FullScreenRoute page={<ChatWindowPage />} />}
          />
          <Route
            path="chat-window/:userId"
            element={<FullScreenRoute page={<ChatWindowPage />} />}
          />
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
              {/* CASH — three tabs, plus two setup pages reached from them
                  rather than from the tab strip (see `CashLayout`). */}
              <Route path="cash" element={<CashLayout />}>
                <Route index element={<CashOverviewPage />} />
                <Route path="movements" element={<CashMovementsPage />} />
                <Route path="budgets" element={<CashBudgetsPage />} />
                {/* Tags and rules on ONE page: a tag is the label, a rule is how
                    it gets applied automatically. Linked from Movements. */}
                <Route path="labels" element={<CashLabelsPage />} />
                {/* Account management, linked from the Overview balance strip. */}
                <Route path="accounts" element={<CashSourcesPage />} />
                {/* Bank-statement import is parked: it posted to the retired
                    `/expenses/import/*` endpoints and is being rebuilt on the
                    portfolio cash ledger (V5 cash fusion phase 2). Off the tab
                    strip until there is something behind it — a permanently
                    empty tab is noise — but the URL still resolves. */}
                <Route path="import" element={<ParkedPage page="cashImport" />} />
                {/* Pre-rework tab names, kept resolvable (search preserved). */}
                <Route path="tags" element={<LegacyRedirect to="/portfolio/cash/labels" />} />
                <Route path="rules" element={<LegacyRedirect to="/portfolio/cash/labels" />} />
                <Route
                  path="transactions"
                  element={<LegacyRedirect to="/portfolio/cash/movements" />}
                />
                <Route path="categories" element={<LegacyRedirect to="/portfolio/cash/labels" />} />
              </Route>
              {/* The whole area moved from `cash-flow` to `cash` (owner,
                  2026-07-31). `withSplat` carries the sub-path, so every
                  bookmark and every link in an old email still lands. */}
              <Route
                path="cash-flow/*"
                element={<LegacyRedirect to="/portfolio/cash" withSplat />}
              />
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
              {/* `/portfolio/cash` used to redirect to the accounts page. It is
                  now the Cash area's own index, declared above — the redirect
                  would have shadowed the real route. */}
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
              <Route path="watchlists/:watchlistId" element={<WatchlistDetailPage />} />
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
              <Route path="following" element={<FollowingPage />} />
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
            {/* The Control Center is an OVERLAY (R2) and is NOT a route: the
              shell matches `/control` / `/control/:panel` itself and renders the
              popup over the page behind it (see UserShell). `control/data` is a
              real page and stays a route — `matchControlPanel` excludes that
              segment, exactly as a static route segment used to outrank the
              dynamic `:panel`. */}
            <Route path="control/data" element={<ParkedPage page="dataManagement" />} />

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
            {/* Vaults v2 explainer (docs/VAULTS_V2_DESIGN.md §4). Deliberately
                reachable in every privacy mode: a locked user needs it most. */}
            <Route path="vault/how-it-works" element={<VaultHowItWorksPage />} />
            <Route path="expenses/*" element={<LegacyRedirect to="/portfolio/cash" withSplat />} />
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
            <Route path="following" element={<LegacyRedirect to="/people/following" />} />
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

/**
 * Resolve the account mode before any money route mounts. The default normal
 * branch contains only the API adapter; the heavy vault module loads when the
 * account IS paranoid, or when a normal account explicitly asks to set the
 * vault up (`/control/privacy?enable=1` — {@link matchesVaultEnableRequest}).
 *
 * Swapping branches replaces the whole authenticated subtree, so the trigger
 * list is deliberately that short. Merely OPENING Control Center → Privacy is
 * not on it: the panel reads the runtime optionally and loads its own chunk
 * behind the overlay's boundary, so a normal session keeps its shell, its
 * socket, its query cache and the page behind the popup.
 *
 * The enable request is the one case that must swap, and it has to: the
 * wizard commits, flips the cached mode and then finishes its automatic first
 * unlock on the runtime it captured, while THIS gate has already replaced the
 * wizard with `VaultUnlockGate` (see the hand-off note there). That only works
 * while the runtime lives above the swap — a panel-local provider would be
 * unmounted (and locked) by its own success, and the user would be asked for
 * the passphrase they had just created. Requesting it through the URL is what
 * lets the request survive the swap it causes.
 *
 * Once loaded the vault root stays mounted for this login, so a disable (mode
 * flips back to normal) cannot pull the runtime out midway through it either.
 */
export function AccountModeRoot({ children }: { children: ReactNode }) {
  const t = useT();
  const location = useLocation();
  const { status, user } = useAuth();
  const privacy = usePrivacyMode(
    status === 'authenticated',
    status === 'authenticated' ? (user?.id ?? null) : null,
  );
  // State, not a ref: a render React throws away (StrictMode, an interrupted
  // concurrent render) must not leave the vault chunk latched for a session
  // that never asked for it.
  const [vaultLoaded, setVaultLoaded] = useState(false);
  const wantsVault =
    status === 'authenticated' &&
    (privacy.privacyMode === 'paranoid' ||
      matchesVaultEnableRequest(location.pathname, location.search));
  if (wantsVault && !vaultLoaded) setVaultLoaded(true);
  if (status !== 'authenticated' && vaultLoaded) setVaultLoaded(false);

  if (status !== 'authenticated') {
    return (
      <ResolvedPrivacyModeProvider mode="normal">
        <PortfolioStoreProvider store={apiPortfolioStore}>{children}</PortfolioStoreProvider>
      </ResolvedPrivacyModeProvider>
    );
  }
  if (privacy.isPending) return <Splash />;
  if (privacy.isError || privacy.privacyMode == null) {
    return (
      <AuthCard subtitle={t('vault.gate.unavailableTitle')}>
        <div className="flex flex-col gap-4">
          <p className="bt-soft text-sm">{t('vault.gate.unavailableBody')}</p>
          <Button onClick={() => void privacy.refetch()}>{t('common.retry')}</Button>
        </div>
      </AuthCard>
    );
  }
  if (wantsVault || vaultLoaded) {
    return <VaultAccountRoot privacy={privacy}>{children}</VaultAccountRoot>;
  }
  return (
    <ResolvedPrivacyModeProvider accountId={user?.id ?? null} mode="normal">
      <PortfolioStoreProvider store={apiPortfolioStore}>{children}</PortfolioStoreProvider>
    </ResolvedPrivacyModeProvider>
  );
}

/**
 * Hands the global 429 notice (§7.4) to the shared feedback channel, which is
 * the single owner of the app's one toast slot. Renders nothing itself.
 *
 * This used to render its own `Toast`. Two independent renderers of the same
 * fixed, non-stacking `.bt-toast` position meant a rate-limited action taken
 * while a mutation notice was still up left two `role="alert"` nodes, with the
 * later-mounted mutation toast covering the rate-limit error. Routing through
 * `MutationFeedbackProvider` makes "one notice at a time" structural.
 *
 * The banner is released as soon as it has been handed over: the notice's
 * lifetime now belongs to the channel, and clearing here keeps an identical
 * repeat 429 a real state change — otherwise the second one would set the same
 * string, skip this effect, and silently show nothing.
 */
function RateLimitToastBridge() {
  const { rateLimitBanner, clearRateLimitBanner } = useAuth();
  const feedback = useMutationFeedback();
  useEffect(() => {
    if (!rateLimitBanner) return;
    feedback.rateLimit(rateLimitBanner);
    clearRateLimitBanner();
  }, [rateLimitBanner, clearRateLimitBanner, feedback]);
  return null;
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

/** Keeps an automatic interface scale correct as the window resizes. */
function UiScaleWatcher() {
  useUiScaleWatcher();
  return null;
}

/** Keeps a `system` theme following the OS as it flips (board #68). */
function ThemeWatcher() {
  useThemeWatcher();
  return null;
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
        <MutationFeedbackProvider>
          <AuthProvider>
            <UiScaleWatcher />
            <ThemeWatcher />
            <LocaleSync />
            <RateLimitToastBridge />
            <Suspense fallback={<Splash />}>
              <AccountModeRoot>
                {/* Vaults v2: mounted once, above the router, because the
                    in-memory keyring must survive navigation — rebuilding it
                    would silently relock every vault. */}
                <VaultsProvider>
                  <RealtimeRoot>
                    <AnnouncementBannerRoot />
                    <UserShell />
                  </RealtimeRoot>
                </VaultsProvider>
              </AccountModeRoot>
            </Suspense>
          </AuthProvider>
        </MutationFeedbackProvider>
      </QueryClientProvider>
    </I18nProvider>
  );
}
