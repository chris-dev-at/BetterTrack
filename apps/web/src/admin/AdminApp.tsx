import { Navigate, Route, Routes } from 'react-router-dom';

import { AuthProvider } from './AuthContext';
import { AdminLayout } from './components/AdminLayout';
import { AuditPage } from './pages/AuditPage';
import { InvitesPage } from './pages/InvitesPage';
import { LoginPage } from './pages/LoginPage';
import { UsersPage } from './pages/UsersPage';

/**
 * The admin world (PROJECTPLAN.md §6.12): its own auth provider and router,
 * mounted at `/admin/*`, with a layout entirely separate from the normal app.
 * Routes here are relative to `/admin`.
 */
export function AdminApp() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="login" element={<LoginPage />} />
        <Route element={<AdminLayout />}>
          <Route index element={<Navigate to="users" replace />} />
          <Route path="users" element={<UsersPage />} />
          <Route path="invites" element={<InvitesPage />} />
          <Route path="audit" element={<AuditPage />} />
        </Route>
        {/* Unknown admin paths fall back to the users page (or login if anonymous). */}
        <Route path="*" element={<Navigate to="users" replace />} />
      </Routes>
    </AuthProvider>
  );
}
