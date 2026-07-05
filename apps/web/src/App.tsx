import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { AdminApp } from './admin/AdminApp';
import { getRuntimeConfig } from './lib/runtimeConfig';
import { UserApp } from './user/UserApp';

/**
 * Top-level routing: admin and user are two fully separate systems (§3, §4.6),
 * and which one mounts is decided **only** by the per-origin runtime config
 * (`app: "admin"` is injected by the admin origin's nginx block, §7.1) — never
 * by URL. Each app mounts its own AuthProvider, so only one auth-response policy
 * is ever active.
 *
 * On the admin origin the admin world is served under `/admin/*` and the root
 * redirects into it; the user app is never referenced, so it cannot be reached.
 * On every other (user) origin the admin app is not part of the route tree at
 * all — `/admin/*` resolves through the user app's own not-found handling, so
 * navigating to `/admin` can never mount the admin world by URL alone (#248).
 * The API's kind-disjoint session guards back this at the endpoint layer.
 */
export default function App() {
  if (getRuntimeConfig().app === 'admin') {
    return (
      <BrowserRouter>
        <Routes>
          <Route path="/admin/*" element={<AdminApp />} />
          <Route path="/*" element={<Navigate to="/admin" replace />} />
        </Routes>
      </BrowserRouter>
    );
  }
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/*" element={<UserApp />} />
      </Routes>
    </BrowserRouter>
  );
}
