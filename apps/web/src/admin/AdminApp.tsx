import { Navigate, Route, Routes } from 'react-router-dom';

import { I18nProvider } from '../i18n';
import { IosInstallHint } from '../ui';

import { AuthProvider, useAuth } from './AuthContext';
import { AdminLayout } from './components/AdminLayout';
import { AccountDefaultsPage } from './pages/AccountDefaultsPage';
import { AiSettingsPage } from './pages/AiSettingsPage';
import { AnnouncementsPage } from './pages/AnnouncementsPage';
import { AuditPage } from './pages/AuditPage';
import { EmailPage } from './pages/EmailPage';
import { FeatureFlagsPage } from './pages/FeatureFlagsPage';
import { ForcedPasswordChangePage } from './pages/ForcedPasswordChangePage';
import { HealthPage } from './pages/HealthPage';
import { InvitesPage } from './pages/InvitesPage';
import { LoginPage } from './pages/LoginPage';
import { MonitoringPage } from './pages/MonitoringPage';
import { ApiKeysPage } from './pages/ApiKeysPage';
import { OAuthAppsPage } from './pages/OAuthAppsPage';
import { ProblemsPage } from './pages/ProblemsPage';
import { UsageAnalyticsPage } from './pages/UsageAnalyticsPage';
import { SecuritySettingsPage } from './pages/SecuritySettingsPage';
import { SettingsPage } from './pages/SettingsPage';
import { TwoFactorChallengePage } from './pages/TwoFactorChallengePage';
import { TwoFactorSetupPage } from './pages/TwoFactorSetupPage';
import { UserDetailPage } from './pages/UserDetailPage';
import { UsersPage } from './pages/UsersPage';

/**
 * Route tree for the admin world. Several states trap above routing until they
 * clear, mirroring the user app: a reset admin into the forced-change screen (§6.1,
 * #248 item 6); an enrolled admin mid-login into the 2FA challenge; and an admin
 * with no confirmed 2FA method into the mandatory-enrollment wizard (§6.12, #400).
 */
function AdminShell() {
  const { status } = useAuth();

  if (status === 'password-change-required') return <ForcedPasswordChangePage />;
  if (status === 'two-factor-required') return <TwoFactorChallengePage />;
  if (status === 'two-factor-setup-required') return <TwoFactorSetupPage />;

  return (
    <Routes>
      <Route path="login" element={<LoginPage />} />
      <Route element={<AdminLayout />}>
        <Route index element={<Navigate to="users" replace />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="users/:userId" element={<UserDetailPage />} />
        <Route path="invites" element={<InvitesPage />} />
        <Route path="oauth-apps" element={<OAuthAppsPage />} />
        <Route path="api-keys" element={<ApiKeysPage />} />
        <Route path="email" element={<EmailPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="health" element={<HealthPage />} />
        <Route path="problems" element={<ProblemsPage />} />
        <Route path="monitoring" element={<MonitoringPage />} />
        <Route path="usage-analytics" element={<UsageAnalyticsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="ai" element={<AiSettingsPage />} />
        <Route path="feature-flags" element={<FeatureFlagsPage />} />
        <Route path="account-defaults" element={<AccountDefaultsPage />} />
        <Route path="announcements" element={<AnnouncementsPage />} />
        <Route path="security" element={<SecuritySettingsPage />} />
      </Route>
      {/* Unknown admin paths fall back to the users page (or login if anonymous).
          The target MUST be absolute (`/admin/users`): a relative `to="users"`
          resolves against the splat's full matched pathname, so from an unmatched
          `/admin/blabla` it appends (`/admin/blabla/users`) — which only re-matches
          this same `*` route and appends again, looping forever. An absolute path
          lands on the home route in exactly one hop. */}
      <Route path="*" element={<Navigate to="/admin/users" replace />} />
    </Routes>
  );
}

/**
 * The admin world (PROJECTPLAN.md §6.12): its own auth provider and router,
 * mounted at `/admin/*`, with a layout entirely separate from the normal app.
 * Routes here are relative to `/admin`. Wrapped in {@link I18nProvider} so the
 * admin surfaces (§13.3 V3-P1) render the chosen language — the graceful EN
 * fallback keeps `useT()` working in unit tests even without a provider.
 */
export function AdminApp() {
  return (
    <I18nProvider>
      <AuthProvider>
        <AdminShell />
        {/* iOS Safari "Add to Home Screen" nudge (§13.5 V5-P13b) — same self-
            gating as the user app; a no-op on desktop admin sessions. */}
        <IosInstallHint />
      </AuthProvider>
    </I18nProvider>
  );
}
