import { Navigate, Route, Routes } from 'react-router-dom';

import { AuthProvider, useAuth } from './AuthContext';
import { AdminLayout } from './components/AdminLayout';
import { AuditPage } from './pages/AuditPage';
import { EmailPage } from './pages/EmailPage';
import { ForcedPasswordChangePage } from './pages/ForcedPasswordChangePage';
import { InvitesPage } from './pages/InvitesPage';
import { LoginPage } from './pages/LoginPage';
import { SettingsPage } from './pages/SettingsPage';
import { UserDetailPage } from './pages/UserDetailPage';
import { UsersPage } from './pages/UsersPage';

/**
 * Route tree for the admin world. A reset admin is trapped into the forced-change
 * screen above routing until the flag clears (§6.1, #248 item 6) — mirroring the
 * user app's forced-change trap — so the account is recoverable here.
 */
function AdminShell() {
  const { status } = useAuth();

  if (status === 'password-change-required') return <ForcedPasswordChangePage />;

  return (
    <Routes>
      <Route path="login" element={<LoginPage />} />
      <Route element={<AdminLayout />}>
        <Route index element={<Navigate to="users" replace />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="users/:userId" element={<UserDetailPage />} />
        <Route path="invites" element={<InvitesPage />} />
        <Route path="email" element={<EmailPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
      {/* Unknown admin paths fall back to the users page (or login if anonymous). */}
      <Route path="*" element={<Navigate to="users" replace />} />
    </Routes>
  );
}

/**
 * The admin world (PROJECTPLAN.md §6.12): its own auth provider and router,
 * mounted at `/admin/*`, with a layout entirely separate from the normal app.
 * Routes here are relative to `/admin`.
 */
export function AdminApp() {
  return (
    <AuthProvider>
      <AdminShell />
    </AuthProvider>
  );
}
