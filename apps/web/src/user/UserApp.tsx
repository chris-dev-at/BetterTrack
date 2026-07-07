import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { RealtimeProvider } from '../lib/realtime';

import { AuthProvider, useAuth } from './AuthContext';
import { RequireUser } from './RequireUser';
import { AppLayout } from './components/AppLayout';
import { Splash, Toast } from './components/ui';
import { ForcedPasswordChangePage } from './auth/ForcedPasswordChangePage';
import { ForgotPasswordPage } from './auth/ForgotPasswordPage';
import { InvitePage } from './auth/InvitePage';
import { LoginPage } from './auth/LoginPage';
import { ResetPasswordPage } from './auth/ResetPasswordPage';
import { PinGate } from './auth/PinGate';
import { PortfolioPage } from './portfolio/PortfolioPage';
import { CustomAssetsPage, PortfolioLayout, TransactionsPage } from './portfolio/PortfolioSection';
import { WorkboardPage } from './workboard/WorkboardPage';
import {
  BacktestsPage,
  CalculatorsPage,
  ComparisonsPage,
  SavedIdeasPage,
  WatchlistPage,
  WorkboardLayout,
} from './workboard/WorkboardSection';
import { AlertsPage } from './workboard/AlertsPage';
import { ConglomeratesListPage } from './workboard/ConglomeratesListPage';
import { ConglomerateDetailPage } from './workboard/ConglomerateDetailPage';
import { ConglomerateBuilderPage } from './workboard/ConglomerateBuilderPage';
import { ConsentPage } from './oauth/ConsentPage';
import { SearchPage } from './assets/SearchPage';
import { AssetDetailPage } from './assets/AssetDetailPage';
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
import { SharedWithMePage } from './social/SharedWithMePage';
import { SharedPortfolioPage } from './social/SharedPortfolioPage';
import { SharedConglomeratePage } from './social/SharedConglomeratePage';
import { SharedWatchlistPage } from './social/SharedWatchlistPage';
import { MySharedItemsPage } from './social/MySharedItemsPage';
import { PublicProfilePage, SocialIdeasPage, SocialLayout } from './social/SocialSection';
import {
  AccountSettingsPage,
  ApiAccessPage,
  BackupsPage,
  ConnectionsPage,
  ImportsExportsPage,
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

  if (status === 'loading') return <Splash label="Loading…" />;
  if (status === 'password-change-required') return <ForcedPasswordChangePage />;
  // PIN gate wraps the whole app while a PIN-enabled account hasn't been
  // unlocked this browsing session (§6.1) — the trap sits above routing, so no
  // /pin URL is needed and deep links resolve only after the PIN clears.
  if (status === 'pin-required') return <PinGate />;

  return (
    <Routes>
      <Route path="login" element={<LoginPage />} />
      <Route path="forgot-password" element={<ForgotPasswordPage />} />
      <Route path="reset/:token" element={<ResetPasswordPage />} />
      <Route path="invite/:token" element={<InvitePage />} />
      <Route element={<RequireUser />}>
        {/* OAuth consent (§6.13 part 2) — a full-screen, standalone card outside
            the AppLayout chrome. Sitting under RequireUser gives login-then-
            consent for free: an anonymous visit is bounced to /login with the
            full `/oauth/authorize?…` URL (path + query) preserved, so the user
            lands back here with state + PKCE intact after signing in. */}
        <Route path="oauth/authorize" element={<ConsentPage />} />
        {/* The Conglomerate Builder is a full-screen surface (§6.5) — it sits
            outside the AppLayout chrome/subnav rather than inside the Workboard
            section. Both `/new` and `/:id/edit` render the same Builder. */}
        <Route path="workboard/conglomerates/new" element={<ConglomerateBuilderPage />} />
        <Route path="workboard/conglomerates/:id/edit" element={<ConglomerateBuilderPage />} />
        <Route element={<AppLayout />}>
          {/* Home → Portfolio (§6.8, §7.2). */}
          <Route index element={<Navigate to="/portfolio" replace />} />

          {/* ── Portfolio ── */}
          <Route path="portfolio" element={<PortfolioLayout />}>
            <Route index element={<PortfolioPage />} />
            <Route path="transactions" element={<TransactionsPage />} />
            <Route path="custom-assets" element={<CustomAssetsPage />} />
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
            <Route path="comparisons" element={<ComparisonsPage />} />
            <Route path="ideas" element={<SavedIdeasPage />} />
          </Route>

          {/* ── Assets ── */}
          <Route path="assets" element={<AssetsLayout />}>
            <Route index element={<AssetsOverviewPage />} />
            <Route path="search" element={<SearchPage />} />
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
            <Route path="shared-with-me" element={<SharedWithMePage />} />
            <Route path="shared-with-me/conglomerates/:id" element={<SharedConglomeratePage />} />
            <Route path="shared-with-me/watchlists/:userId" element={<SharedWatchlistPage />} />
            <Route path="shared-with-me/:portfolioId" element={<SharedPortfolioPage />} />
            <Route path="my-shared" element={<MySharedItemsPage />} />
            <Route path="ideas" element={<SocialIdeasPage />} />
            <Route path="profile" element={<PublicProfilePage />} />
          </Route>

          {/* ── Settings (reached from the profile menu) ── */}
          <Route path="settings" element={<SettingsLayout />}>
            <Route index element={<Navigate to="/settings/account" replace />} />
            <Route path="account" element={<AccountSettingsPage />} />
            <Route path="notifications" element={<NotificationSettingsPage />} />
            <Route path="security" element={<SecuritySettingsPage />} />
            <Route path="imports" element={<ImportsExportsPage />} />
            <Route path="connections" element={<ConnectionsPage />} />
            <Route path="backups" element={<BackupsPage />} />
            <Route path="api" element={<ApiAccessPage />} />
          </Route>
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

export function UserApp() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RateLimitToastPortal />
        <RealtimeRoot>
          <UserShell />
        </RealtimeRoot>
      </AuthProvider>
    </QueryClientProvider>
  );
}
