import { Navigate, Outlet, useLocation } from 'react-router-dom';

import { useAuth } from '../AuthContext';
import { readFirstRun } from './firstRunStorage';

/**
 * Routes the gate must never hijack.
 *
 * - `/welcome` — the destination itself; redirecting to it from it is a loop.
 * - `/oauth/authorize` — an authorization-code flow has a third party waiting on
 *   the other end (§6.13). Bouncing a brand-new user into setup mid-flow would
 *   silently break the integration rather than merely delay it.
 *
 * Matched as path prefixes so nested/deep-linked forms are covered too.
 */
const EXEMPT_PREFIXES = ['/welcome', '/oauth/authorize'] as const;

function isExempt(pathname: string): boolean {
  return EXEMPT_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * Sends an account that has never been set up to `/welcome` — once, from
 * wherever it lands (§6.12).
 *
 * **Why a gate and not a redirect after signup.** The trigger used to be a
 * `navigate('/welcome')` on the register and invite screens, so it only ever
 * fired for the two flows that create an account *in the browser*. An
 * admin-created user and an approved applicant never touch either screen — they
 * receive a mail and sign in — so they never saw setup at all. This gate sits
 * inside the authenticated tree instead, so every mode reaches it.
 *
 * **The signal.** `me.firstRunCompletedAt === null` — an explicit server column
 * (migration 0074), because nothing already on `MeResponse` can carry it:
 * `lastLoginAt` is stamped before the login response body is built, so it is
 * already non-null the first time a user ever reads `/auth/me`. Being
 * server-side, it also survives a new device, which the local record cannot.
 *
 * `undefined` means "unknown" (a pre-0074 server, or a test fixture that omits
 * the field) and never redirects — guessing "not completed" there would march
 * every established user back through setup.
 *
 * **Both sources must agree the run is unfinished.** The local record is a
 * safety valve: if the completion call failed, the in-memory user was still
 * stamped optimistically, but a reload would read `null` from the server again
 * and bounce straight back. Honouring the local `done` flag means a network
 * failure can cost the user a re-run on another device — never a trap on this one.
 *
 * Placement matters: this is mounted below the `loading`,
 * `password-change-required` and `pin-required` states, which `UserShell`
 * resolves *above* routing. It therefore cannot fight the forced-password-change
 * trap or the PIN gate — neither ever reaches a router at all.
 */
export function FirstRunGate() {
  const { user } = useAuth();
  const { pathname } = useLocation();

  const pending = user?.firstRunCompletedAt === null;
  // Short-circuit order is deliberate: the storage read only happens for the
  // handful of sessions the server actually reports as un-set-up.
  if (pending && !isExempt(pathname) && !readFirstRun().done) {
    return <Navigate to="/welcome" replace />;
  }
  return <Outlet />;
}
