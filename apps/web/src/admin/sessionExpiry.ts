import { useCallback } from 'react';

import { ApiError } from '../lib/apiClient';
import { useAuth, type AdminSignOutReason } from './AuthContext';

/**
 * Reading an admin-API failure as "this console's session window closed"
 * (§13.5 V5-P13c, #1779).
 *
 * §6.12 makes every `/admin/*` route answer **404** to anyone who is not an
 * admin, and `requireAdmin` raises that 404 with the generic `NOT_FOUND` code.
 * So a bare 404 on the admin origin means the caller lost admin authority — on a
 * live console, that the session expired.
 *
 * A 404 that names a DOMAIN outcome is a different animal: `GET /admin/users/:id`
 * answers `USER_NOT_FOUND` for an account a colleague just deleted. That row is
 * gone; the session is not. Both still end the surface (the caller decides how),
 * but only the first may claim "your admin session expired".
 */
const DOMAINLESS_NOT_FOUND_CODES = new Set(['', 'NOT_FOUND']);

/**
 * The §6.12 "you are not an admin here any more" answer — a 404 that names no
 * domain outcome. Deliberately does NOT include 401: on routes that verify a
 * factor (`POST /admin/security/2fa/totp/disable`), a 401 is the *code* being
 * wrong, not the session being gone.
 */
export function isAdminWindowClosed(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404 && DOMAINLESS_NOT_FOUND_CODES.has(err.code);
}

/**
 * Why a 401/404 read failure should sign the console out. `'expired'` when the
 * failure really is the window closing, `undefined` when the route answered a
 * domain 404 — the session ends either way (the read path has always treated
 * `isNotAuthorized` structurally), but the login screen only claims an expiry
 * when that is what happened.
 */
export function adminSignOutReason(err: unknown): AdminSignOutReason | undefined {
  if (err instanceof ApiError && err.status === 401) return 'expired';
  return isAdminWindowClosed(err) ? 'expired' : undefined;
}

/**
 * Sign the console out when a bespoke `catch` sees the window close, and report
 * whether it did — so the caller can skip its own error mapping.
 *
 * Most admin writes belong on `useAdminMutation`, which handles this internally.
 * This is for the controls that legitimately keep their own error mapping —
 * every factor-verifying write under `/admin/security/2fa/*` (the TOTP-disable
 * code field, and the TOTP/email enroll + confirm steps), whose **401 is a
 * rejected code rather than auth loss**, so the seam's "401 ⇒ signed out" would
 * log a working admin out over a typo. They would otherwise render the raw
 * English `Not found` envelope on a console that can no longer do anything.
 */
export function useAdminWindowClosedSignOut(): (err: unknown) => boolean {
  const { clearSession } = useAuth();
  return useCallback(
    (err: unknown) => {
      if (!isAdminWindowClosed(err)) return false;
      clearSession('expired');
      return true;
    },
    [clearSession],
  );
}
