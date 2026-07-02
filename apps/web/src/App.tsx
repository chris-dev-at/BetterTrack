import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { AdminApp } from './admin/AdminApp';
import { getRuntimeConfig } from './lib/runtimeConfig';
import { UserApp } from './user/UserApp';

/**
 * Top-level routing: the separate admin world under `/admin/*` (its own auth +
 * layout, §6.12) and the normal app everywhere else (§7.2). Each subtree mounts
 * its own AuthProvider, so only one auth-response policy is ever active.
 *
 * When served from the admin origin (runtime config `app: "admin"`, §7.1), the
 * root path redirects into `/admin` so that origin lands on the admin world;
 * every other origin defaults to the user app.
 */
export default function App() {
  const isAdminOrigin = getRuntimeConfig().app === 'admin';
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/admin/*" element={<AdminApp />} />
        <Route path="/*" element={isAdminOrigin ? <Navigate to="/admin" replace /> : <UserApp />} />
      </Routes>
    </BrowserRouter>
  );
}
