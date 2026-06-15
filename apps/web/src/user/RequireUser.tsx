import { Navigate, Outlet, useLocation } from 'react-router-dom';

import { useAuth } from './AuthContext';
import { Splash } from './components/ui';

/**
 * Route guard for the `user` routes (PROJECTPLAN.md §7.2). Anonymous visitors
 * are sent to `/login` with the intended path stashed in `state.from`, so the
 * login screen can return them there. The `loading` and
 * `password-change-required` states are handled above this guard (UserApp), so
 * here we only resolve authenticated vs. anonymous.
 */
export function RequireUser() {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <Splash label="Checking session…" />;
  if (status !== 'authenticated') {
    const from = `${location.pathname}${location.search}`;
    return <Navigate to="/login" replace state={{ from }} />;
  }
  return <Outlet />;
}
