import { Navigate, Route, Routes } from 'react-router-dom';

import { I18nProvider, useT } from '../i18n';
import { NotFoundState } from '../ui';

import { AuthProvider, useAuth } from './AuthContext';
import { AdminLayout } from './components/AdminLayout';
import { Button } from './components/ui';
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
  const t = useT();
  const { status, retrySession } = useAuth();

  if (status === 'session-unavailable') {
    return (
      <main className="grid min-h-screen place-items-center bg-neutral-950 px-4">
        <div
          role="alert"
          className="flex w-full max-w-md flex-col gap-4 rounded-lg border border-neutral-800 bg-neutral-900 p-6 text-neutral-100"
        >
          <h1 className="text-xl font-semibold">{t('auth.common.sessionUnavailableTitle')}</h1>
          <p className="text-sm text-neutral-400">{t('auth.common.sessionUnavailableBody')}</p>
          <Button onClick={retrySession}>{t('common.retry')}</Button>
        </div>
      </main>
    );
  }
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
        <Route path="*" element={<NotFoundState homeTo="/admin/users" />} />
      </Route>
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
      </AuthProvider>
    </I18nProvider>
  );
}
