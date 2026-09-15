import { useCallback } from 'react';

import { ApiError } from '../lib/apiClient';
import {
  adminSignOutReason,
  isAdminTwoFactorSetupRequired,
  isAdminWindowClosed,
  useAuth,
} from './AuthContext';

/**
 * The two pure readings of an admin failure — "the window closed" and "what the
 * login screen may claim" — are defined in `AuthContext`, because the deadline
 * machinery there reads them too, and re-exported here where their consumers
 * already look for them (see the doc comments at the definitions).
 */
export { adminSignOutReason, isAdminWindowClosed };

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

/**
 * What a 404 means for one bespoke call. The same distinction
 * `AdminMutationNotFoundPolicy` draws on the shared write seam, restated here
 * because these call sites cannot use that seam.
 */
export type AdminCallNotFoundPolicy = 'surface' | 'session';

/**
 * The structural half of an admin failure, for a `catch` that keeps its own
 * error mapping (#1814).
 *
 * A handful of admin reads and writes hand-roll their `catch` because they need
 * the call's RESULT (a fresh status object, a one-time secret) rather than just
 * a success flag. Before this hook every one of them stopped at "set a banner":
 * a closed V5-P13c session window surfaced as a red "could not save" on a
 * console whose every next request would also fail, and three of them printed
 * the server's English envelope into an otherwise German console.
 *
 * Returns `true` when it HANDLED the failure — signed the console out, or
 * trapped into forced 2FA enrollment — so the caller leaves its banner alone.
 * Returns `false` when the caller should show its own **catalog** copy; server
 * envelopes are authored in English and are not locale-aware, which is why no
 * displayable message ever comes out of one (`useResource`, `useAdminMutation`).
 *
 * `notFound` defaults to `session`, matching the read path: a 404 on the admin
 * origin normally means `requireAdmin` no longer recognises the caller. Pass
 * `surface` for a call addressed by a row id another actor can remove.
 */
export function useAdminCallFailure(): (
  err: unknown,
  notFound?: AdminCallNotFoundPolicy,
) => boolean {
  const { clearSession, requireTwoFactorSetup } = useAuth();
  return useCallback(
    (err: unknown, notFound: AdminCallNotFoundPolicy = 'session') => {
      const status = err instanceof ApiError ? err.status : null;
      if (status === 401 || (status === 404 && notFound === 'session')) {
        clearSession(adminSignOutReason(err));
        return true;
      }
      // Checked AFTER auth loss and unreachable from it: the mandatory-2FA gate
      // answers 403, so an unenrolled admin lands in the enrollment wizard
      // rather than being read as an expired session.
      if (isAdminTwoFactorSetupRequired(err)) {
        requireTwoFactorSetup();
        return true;
      }
      return false;
    },
    [clearSession, requireTwoFactorSetup],
  );
}
