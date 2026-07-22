import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { I18nProvider, useI18n } from '../i18n';
import { RealtimeProvider } from '../lib/realtime';
import { IosInstallHint } from '../ui';

import { AuthProvider, useAuth } from './AuthContext';
import { RequireUser } from './RequireUser';
import { AppLayout } from './components/AppLayout';
import { AnnouncementBanner } from './components/AnnouncementBanner';
import { Splash, Toast } from './components/ui';
import { ForcedPasswordChangePage } from './auth/ForcedPasswordChangePage';
import { ForgotPasswordPage } from './auth/ForgotPasswordPage';
import { InvitePage } from './auth/InvitePage';
import { LoginPage } from './auth/LoginPage';
import { RegisterPage } from './auth/RegisterPage';
import { ResetPasswordPage } from './auth/ResetPasswordPage';
import { PinGate } from './auth/PinGate';
import { ForecastPage } from './forecast/ForecastPage';
import { ExpensesLayout } from './expenses/ExpensesSection';
import { DashboardPage as ExpenseDashboardPage } from './expenses/DashboardPage';
import { TransactionsPage as ExpenseTransactionsPage } from './expenses/TransactionsPage';
import { BudgetsPage as ExpenseBudgetsPage } from './expenses/BudgetsPage';
import { CategoriesPage as ExpenseCategoriesPage } from './expenses/CategoriesPage';
import { RulesPage as ExpenseRulesPage } from './expenses/RulesPage';
import { ImportPage as ExpenseImportPage } from './expenses/ImportPage';
import { PortfolioPage } from './portfolio/PortfolioPage';
import { AnalyticsPage } from './portfolio/analytics/AnalyticsPage';
import { CashSourcesPage } from './portfolio/CashSourcesPage';
import { ImportPage } from './portfolio/ImportPage';
import { TaxReportPage } from './portfolio/TaxReportPage';
import { TaxReportPrintPage } from './portfolio/TaxReportPrintPage';
import { CustomAssetsPage, PortfolioLayout, TransactionsPage } from './portfolio/PortfolioSection';
import { WorkboardPage } from './workboard/WorkboardPage';
import {
  BacktestsPage,
  CalculatorsPage,
  WatchlistPage,
  WorkboardLayout,
} from './workboard/WorkboardSection';
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
import {
  AssetsLayout,
  AssetsOverviewPage,
  CommoditiesPage,
  CryptoPage,
  CustomAssetsBrowsePage,
  EtfsPage,
  StocksPage,
} from './assets/AssetsSection';
import { FriendsPage } from './social/FriendsPage';
import { SharedPortfolioPage } from './social/SharedPortfolioPage';
import { SharedConglomeratePage } from './social/SharedConglomeratePage';
import { SharedWatchlistPage } from './social/SharedWatchlistPage';
import { MySharedItemsPage } from './social/MySharedItemsPage';
import { SharedIdeaPage } from './social/SharedIdeaPage';
import { PublicSharePage } from './social/PublicSharePage';
import { PublicProfileViewPage } from './social/PublicProfileViewPage';
import { ProfileSettingsPage } from './social/ProfileSettingsPage';
import { SocialIdeasPage, SocialLayout } from './social/SocialSection';
import { ChatPage } from './social/ChatPage';
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
 * The non-admin app (PROJECTPLAN.md §6.1, §7.1, §7.2). Two app-wide auth gates
 * sit above routing: the session bootstrap (`loading`) and the forced-password-
 * change trap — while either is in effect no `user`/public route is reachable,
 * which is exactly the §6.1 guarantee that a must-change user cannot navigate
 * anywhere else until the change succeeds (sign-out aside).
 *
 * The authenticated route tree is the v2 five-section structure of §7.2 —
 * Portfolio · Workboard · Assets · Social (+ the Settings tree reached from the
 * profile menu). Each section nests under a layout that renders its subnav;
 * every not-yet-built surface resolves to a designed `ComingSoon` state, so
 * deep links never 404.
 */
function UserShell() {
  const { status } = useAuth();

  if (status === 'loading') return <Splash />;
  if (status === 'password-change-required') return <ForcedPasswordChangePage />;
  // PIN gate wraps the whole app while a PIN-enabled account hasn't been
  // unlocked this browsing session (§6.1) — the trap sits above routing, so no
  // /pin URL is needed and deep links resolve only after the PIN clears.
  if (status === 'pin-required') return <PinGate />;

  return (
    <Routes>
      <Route path="login" element={<LoginPage />} />
      {/* Public self-serve registration (§6.12, §13.4 V4-P4a): reflects the
          active registration mode; a closed instance renders a closed notice. */}
      <Route path="register" element={<RegisterPage />} />
      <Route path="forgot-password" element={<ForgotPasswordPage />} />
      <Route path="reset/:token" element={<ResetPasswordPage />} />
      <Route path="invite/:token" element={<InvitePage />} />
      {/* Public share link (§14, V3-P5): a logged-out, read-only view. */}
      <Route path="s/:token" element={<PublicSharePage />} />
      {/* Public profile (§14, V3-P6): the opt-in, username-slugged public page.
          Logged-out and read-only; a not-opted-in / unknown user 404s in the API,
          which the page renders as a friendly "not available". */}
      <Route path="u/:username" element={<PublicProfileViewPage />} />
      <Route element={<RequireUser />}>
        {/* OAuth consent (§6.13 part 2) — a full-screen, standalone card outside
            the AppLayout chrome. Sitting under RequireUser gives login-then-
            consent for free: an anonymous visit is bounced to /login with the
            full `/oauth/authorize?…` URL (path + query) preserved, so the user
            lands back here with state + PKCE intact after signing in. */}
        <Route path="oauth/authorize" element={<ConsentPage />} />
        {/* Self-service account deletion (§13.4 V4-P2c, #362) — the stable public
            deletion URL Google Play requires. A standalone full-screen card;
            an anonymous visit bounces to /login and lands back here. */}
        <Route path="account/delete" element={<DeleteAccountPage />} />
        {/* The Conglomerate Builder is a full-screen surface (§6.5) — it sits
            outside the AppLayout chrome/subnav rather than inside the Workboard
            section. Both `/new` and `/:id/edit` render the same Builder. */}
        <Route path="workboard/conglomerates/new" element={<ConglomerateBuilderPage />} />
        <Route path="workboard/conglomerates/:id/edit" element={<ConglomerateBuilderPage />} />
        {/* Print-to-PDF view of one portfolio+year tax report (§13.5 V5-P4b,
            #583) — a chrome-free document outside the AppLayout, opened from the
            Tax report's per-year "Print / PDF" action. */}
        <Route path="portfolio/tax/print" element={<TaxReportPrintPage />} />
        <Route element={<AppLayout />}>
          {/* Home → Portfolio (§6.8, §7.2). */}
          <Route index element={<Navigate to="/portfolio" replace />} />

          {/* ── Portfolio ── */}
          <Route path="portfolio" element={<PortfolioLayout />}>
            <Route index element={<PortfolioPage />} />
            <Route path="analytics" element={<AnalyticsPage />} />
            <Route path="transactions" element={<TransactionsPage />} />
            <Route path="custom-assets" element={<CustomAssetsPage />} />
            <Route path="cash" element={<CashSourcesPage />} />
            <Route path="tax" element={<TaxReportPage />} />
            {/* Broker CSV import (§13.4 V4-P8): upload → preview → apply. */}
            <Route path="import" element={<ImportPage />} />
          </Route>

          {/* ── Workboard ── */}
          <Route path="workboard" element={<WorkboardLayout />}>
            <Route index element={<WorkboardPage />} />
            <Route path="watchlist" element={<WatchlistPage />} />
            <Route path="alerts" element={<AlertsPage />} />
            <Route path="conglomerates" element={<ConglomeratesListPage />} />
            <Route path="conglomerates/:id" element={<ConglomerateDetailPage />} />
            <Route path="backtests" element={<BacktestsPage />} />
            <Route path="calculators" element={<CalculatorsPage />} />
            <Route path="comparisons" element={<ComparisonPage />} />
            <Route path="ideas" element={<IdeasListPage />} />
            <Route path="ideas/:ideaId" element={<IdeaWorkboardPage />} />
          </Route>

          {/* ── Forecast (§13.5 V5-P6b arc (c)) ── */}
          <Route path="forecast" element={<ForecastPage />} />

          {/* ── Expenses (§13.5 V5-P9) — a NEW top-level area, separate from
              portfolio money. Foundation: transactions + category manager. ── */}
          <Route path="expenses" element={<ExpensesLayout />}>
            <Route index element={<ExpenseDashboardPage />} />
            <Route path="transactions" element={<ExpenseTransactionsPage />} />
            <Route path="budgets" element={<ExpenseBudgetsPage />} />
            <Route path="categories" element={<ExpenseCategoriesPage />} />
            <Route path="rules" element={<ExpenseRulesPage />} />
            <Route path="import" element={<ExpenseImportPage />} />
          </Route>

          {/* ── Assets ── */}
          <Route path="assets" element={<AssetsLayout />}>
            <Route index element={<AssetsOverviewPage />} />
            <Route path="search" element={<SearchPage />} />
            <Route path="news" element={<NewsDigestPage />} />
            <Route path="stocks" element={<StocksPage />} />
            <Route path="etfs" element={<EtfsPage />} />
            <Route path="crypto" element={<CryptoPage />} />
            <Route path="commodities" element={<CommoditiesPage />} />
            <Route path="custom" element={<CustomAssetsBrowsePage />} />
            <Route path=":id" element={<AssetDetailPage />} />
          </Route>

          {/* ── Social ── */}
          <Route path="social" element={<SocialLayout />}>
            <Route index element={<Navigate to="/social/friends" replace />} />
            <Route path="friends" element={<FriendsPage />} />
            {/* The standalone "Shared with me" tab was retired (#384): it folded
                into the Friends overview. The old index path redirects there;
                the read-only item detail routes below stay — they're the deep
                links a friend's shared item opens to. */}
            <Route path="shared-with-me" element={<Navigate to="/social/friends" replace />} />
            <Route path="shared-with-me/conglomerates/:id" element={<SharedConglomeratePage />} />
            <Route
              path="shared-with-me/watchlists/:watchlistId"
              element={<SharedWatchlistPage />}
            />
            <Route path="shared-with-me/ideas/:ideaId" element={<SharedIdeaPage />} />
            <Route path="shared-with-me/:portfolioId" element={<SharedPortfolioPage />} />
            {/* The standalone Following page was retired (V4-P0b): following now
                lives in the Friends tab (in-row follow + alert switches, and the
                followed-items collection). The old path redirects there. */}
            <Route path="following" element={<Navigate to="/social/friends" replace />} />
            <Route path="my-shared" element={<MySharedItemsPage />} />
            <Route path="ideas" element={<SocialIdeasPage />} />
            <Route path="profile" element={<ProfileSettingsPage />} />
            {/* Friend chat (§13.3 V3-P8): a master-detail conversation list +
                thread. The friend cards/overview deep-link to /social/chat/:userId
                (the friend's id); /social/chat opens the list with no thread. */}
            <Route path="chat" element={<ChatPage />} />
            {/* Deep-link by conversation id — the only route to a thread whose
                partner deleted their account (#362); declared before :userId. */}
            <Route path="chat/c/:conversationId" element={<ChatPage />} />
            <Route path="chat/:userId" element={<ChatPage />} />
          </Route>

          {/* ── Settings (reached from the profile menu) ── */}
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

          {/* Legacy top-level /following → the Friends tab (V4-P0b retirement). */}
          <Route path="following" element={<Navigate to="/social/friends" replace />} />
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

/** Renders the global 429 toast while it's active (§7.4). Fixed-position overlay — no layout impact. */
function RateLimitToastPortal() {
  const { rateLimitBanner, clearRateLimitBanner } = useAuth();
  if (!rateLimitBanner) return null;
  return <Toast onDismiss={clearRateLimitBanner}>{rateLimitBanner}</Toast>;
}

/**
 * Admin-composed announcements banner (§13.4 V4-P5b) — a stacked, dismissible
 * banner mounted just above the app shell. Rendered only while a session is
 * fully authenticated; silent when nothing's active for the caller. Sitting
 * outside AppLayout keeps it visible on the auth screens' peer routes too —
 * but the query is gated on the auth status so anonymous pages fire no fetch.
 */
function AnnouncementBannerRoot() {
  const { status } = useAuth();
  return <AnnouncementBanner enabled={status === 'authenticated'} />;
}

/**
 * Follow the authenticated user's stored UI language (§13.3 V3-P1): whenever the
 * signed-in `me` carries a locale, switch the runtime to it. The language picker
 * also flips the runtime instantly and persists server-side, so a `me` refetch
 * just re-affirms the same choice. Renders nothing.
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
          <LocaleSync />
          <RateLimitToastPortal />
          <RealtimeRoot>
            <AnnouncementBannerRoot />
            <UserShell />
          </RealtimeRoot>
          {/* iOS Safari "Add to Home Screen" nudge (§13.5 V5-P13b) — self-gates
              to iOS Safari, non-standalone visitors and hides itself after
              dismissal. No-op on every other platform. */}
          <IosInstallHint />
        </AuthProvider>
      </QueryClientProvider>
    </I18nProvider>
  );
}
