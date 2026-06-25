import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Navigate, Route, Routes } from 'react-router-dom';

import { AuthProvider, useAuth } from './AuthContext';
import { RequireUser } from './RequireUser';
import { AppLayout } from './components/AppLayout';
import { Splash, Toast } from './components/ui';
import { ForcedPasswordChangePage } from './pages/ForcedPasswordChangePage';
import { InvitePage } from './pages/InvitePage';
import { LoginPage } from './pages/LoginPage';
import {
  AssetDetailPage,
  ConglomeratesPage,
  DashboardPage,
  PortfolioPage,
  SettingsPage,
  WorkboardPage,
} from './pages/placeholders';
import { SearchPage } from './pages/SearchPage';

const queryClient = new QueryClient();

/**
 * The non-admin app (PROJECTPLAN.md §6.1, §7.1, §7.2). Two app-wide auth gates
 * sit above routing: the session bootstrap (`loading`) and the forced-password-
 * change trap — while either is in effect no `user`/public route is reachable,
 * which is exactly the §6.1 guarantee that a must-change user cannot navigate
 * anywhere else until the change succeeds (sign-out aside).
 */
function UserShell() {
  const { status } = useAuth();

  if (status === 'loading') return <Splash label="Loading…" />;
  if (status === 'password-change-required') return <ForcedPasswordChangePage />;

  return (
    <Routes>
      <Route path="login" element={<LoginPage />} />
      <Route path="invite/:token" element={<InvitePage />} />
      <Route element={<RequireUser />}>
        <Route element={<AppLayout />}>
          <Route index element={<DashboardPage />} />
          <Route path="search" element={<SearchPage />} />
          <Route path="assets/:id" element={<AssetDetailPage />} />
          <Route path="workboard" element={<WorkboardPage />} />
          <Route path="conglomerates/*" element={<ConglomeratesPage />} />
          <Route path="portfolio" element={<PortfolioPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
      </Route>
      {/* Unknown paths fall back home (which the guard sends to /login if anon). */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
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
        <UserShell />
      </AuthProvider>
    </QueryClientProvider>
  );
}
