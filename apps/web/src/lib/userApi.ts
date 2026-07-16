import {
  googleLinkStatusResponseSchema,
  inviteValidationResponseSchema,
  loginResponseSchema,
  meResponseSchema,
  pinQuickAuthResponseSchema,
  publicRegistrationInfoResponseSchema,
  registerResponseSchema,
  rememberedDeviceResponseSchema,
  revokeSessionsResponseSchema,
  sessionInfoResponseSchema,
  sessionListResponseSchema,
  type AcceptInviteRequest,
  type ChangePasswordRequest,
  type DeleteAccountRequest,
  type GoogleLinkStatusResponse,
  type InviteValidationResponse,
  type LoginRequest,
  type LoginResponse,
  type MeResponse,
  type PasswordResetComplete,
  type PasswordResetRequest,
  type PublicRegistrationInfoResponse,
  type RegisterRequest,
  type RegisterResponse,
  type PinQuickAuthRequest,
  type PinQuickAuthResponse,
  type PinVerifyRequest,
  type RememberedDeviceResponse,
  type RevokeSessionsResponse,
  type SessionInfoResponse,
  type SessionSummary,
  type SetPinLockRequest,
  type SetPinRequest,
  type TwoFactorEmailCodeRequest,
  type TwoFactorVerifyRequest,
} from '@bettertrack/contracts';

import { apiRequest } from './apiClient';
import { apiBaseUrl } from './runtimeConfig';

/**
 * Typed wrappers over the public/user auth endpoints (PROJECTPLAN.md §6.1, §8).
 * Mirrors `adminApi.ts`: every response is validated against the shared contract
 * schema so the SPA works against a single source of truth.
 *
 * All of these `suppressAuthRedirect`: they are the auth surface itself, so the
 * AuthContext owns their state transitions. A `401` here (bad credentials, wrong
 * current password) is an in-form error — it must not fire the global redirect
 * policy and eject the user from the login or forced-change screen.
 */

/**
 * Password login (§6.1). Resolves to either the signed-in user (no 2FA, session
 * set) or a 2FA challenge (`twoFactorRequired`), which the caller completes via
 * {@link verifyTwoFactor}. `suppressAuthRedirect`: this is the auth surface.
 */
export async function login(body: LoginRequest): Promise<LoginResponse> {
  const data = await apiRequest<unknown>('/auth/login', {
    method: 'POST',
    body,
    suppressAuthRedirect: true,
  });
  return loginResponseSchema.parse(data);
}

/**
 * Complete a login 2FA challenge (§6.1, §13.2 V2-P5) with a TOTP/email code or a
 * recovery code. On success the API sets the session cookie and returns the
 * signed-in user. `suppressAuthRedirect`: a 401 here is an in-form error.
 */
export async function verifyTwoFactor(body: TwoFactorVerifyRequest): Promise<MeResponse> {
  const data = await apiRequest<unknown>('/auth/2fa/verify', {
    method: 'POST',
    body,
    suppressAuthRedirect: true,
  });
  return meResponseSchema.parse(data);
}

/** Request a one-time email login code for a pending 2FA challenge (§6.1). */
export async function requestTwoFactorEmailCode(body: TwoFactorEmailCodeRequest): Promise<void> {
  await apiRequest<unknown>('/auth/2fa/email-code', {
    method: 'POST',
    body,
    suppressAuthRedirect: true,
  });
}

export async function logout(): Promise<void> {
  await apiRequest<unknown>('/auth/logout', { method: 'POST', suppressAuthRedirect: true });
}

export async function getMe(signal?: AbortSignal): Promise<MeResponse> {
  const data = await apiRequest<unknown>('/auth/me', { signal, suppressAuthRedirect: true });
  return meResponseSchema.parse(data);
}

/**
 * Promote the current session to persistent — the OAuth-login "stay signed in —
 * your PIN protects this" choice (V4-P2b, §399 §A). The server PIN-gates it and
 * re-issues the session cookie with a Max-Age. `suppressAuthRedirect`: this is
 * part of the login surface.
 */
export async function persistSession(): Promise<void> {
  await apiRequest<unknown>('/auth/session/persist', {
    method: 'POST',
    suppressAuthRedirect: true,
  });
}

/**
 * `GET /auth/session` — the caller's own session timestamps (§6.11 Security):
 * when it was created, last renewed, and when the 30-day window lapses. Consumed
 * by Settings → Security.
 */
export async function getSession(signal?: AbortSignal): Promise<SessionInfoResponse> {
  const data = await apiRequest<unknown>('/auth/session', { signal, suppressAuthRedirect: true });
  return sessionInfoResponseSchema.parse(data);
}

/**
 * `GET /auth/sessions` — the caller's active sessions for Settings → Security
 * (§6.11, V3-P11a): device label, created/last-seen, and the current-session
 * marker. Only ever the caller's own sessions.
 */
export async function listSessions(signal?: AbortSignal): Promise<SessionSummary[]> {
  const data = await apiRequest<unknown>('/auth/sessions', { signal });
  return sessionListResponseSchema.parse(data).sessions;
}

/** Revoke one session by its opaque handle — "log out that device" (V3-P11a). */
export async function revokeSession(id: string): Promise<void> {
  await apiRequest<unknown>(`/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Revoke every other session, keeping this one signed in (V3-P11a). */
export async function revokeOtherSessions(): Promise<RevokeSessionsResponse> {
  const data = await apiRequest<unknown>('/auth/sessions/revoke-others', { method: 'POST' });
  return revokeSessionsResponseSchema.parse(data);
}

export async function changePassword(body: ChangePasswordRequest): Promise<MeResponse> {
  const data = await apiRequest<unknown>('/auth/change-password', {
    method: 'POST',
    body,
    suppressAuthRedirect: true,
  });
  return meResponseSchema.parse(data);
}

/**
 * Verify the PIN to resume a session (§6.1). `suppressAuthRedirect`: a wrong
 * PIN (401) or the too-many-attempts fallback is handled by the PIN gate, not
 * the global redirect policy.
 */
export async function verifyPin(body: PinVerifyRequest): Promise<MeResponse> {
  const data = await apiRequest<unknown>('/auth/pin/verify', {
    method: 'POST',
    body,
    suppressAuthRedirect: true,
  });
  return meResponseSchema.parse(data);
}

/**
 * OAuth PIN quick re-auth for a remembered device (§16, owner spec #399 §B,
 * V4-P2b). PIN-only sign-in bound to the signed `bt_rdid` device cookie — the
 * server never takes the identity from here. Omit `pin` to probe: the server
 * auto-passes (returns the signed-in user) when the ~15-min PIN window from a
 * recent entry is still open, else answers `{ pinRequired: true }` so the chooser
 * shows the PIN input. `suppressAuthRedirect`: a 401 (unknown device / wrong PIN)
 * is an in-flow chooser error, not a global redirect.
 */
export async function quickAuthPin(body: PinQuickAuthRequest): Promise<PinQuickAuthResponse> {
  const data = await apiRequest<unknown>('/auth/pin/quick-auth', {
    method: 'POST',
    body,
    suppressAuthRedirect: true,
  });
  return pinQuickAuthResponseSchema.parse(data);
}

/**
 * Remember this device for OAuth PIN quick re-auth (§399 §B). Sets the signed,
 * httpOnly `bt_rdid` cookie server-side and returns the identity the client
 * stores in its remember-me record — username + avatar + user id, never a token
 * or scope. PIN users only; the server 400s a PIN-less account.
 */
export async function rememberDevice(): Promise<RememberedDeviceResponse> {
  const data = await apiRequest<unknown>('/auth/remembered-device', {
    method: 'POST',
    suppressAuthRedirect: true,
  });
  return rememberedDeviceResponseSchema.parse(data);
}

/**
 * Forget the remembered device — "Another account" / explicit forget (§399 §B).
 * Clears the `bt_rdid` cookie + its server binding so the next OAuth open knows
 * nobody (blank login). Public: it only ever affects the calling device.
 */
export async function forgetRememberedDevice(): Promise<void> {
  await apiRequest<unknown>('/auth/remembered-device', {
    method: 'DELETE',
    suppressAuthRedirect: true,
  });
}

/** Enable or change the PIN (§6.1). */
export async function setPin(body: SetPinRequest): Promise<MeResponse> {
  const data = await apiRequest<unknown>('/auth/pin', { method: 'PUT', body });
  return meResponseSchema.parse(data);
}

/** Disable the PIN (§6.1). */
export async function disablePin(): Promise<MeResponse> {
  const data = await apiRequest<unknown>('/auth/pin', { method: 'DELETE' });
  return meResponseSchema.parse(data);
}

/**
 * Set (or clear with `null`) the AFK auto-lock idle timeout in minutes (§6.1,
 * §13.2 V2-P2). A UI-lock preference layered on the PIN — never touches the
 * session lifetime.
 */
export async function setPinLockIdleMinutes(body: SetPinLockRequest): Promise<MeResponse> {
  const data = await apiRequest<unknown>('/auth/pin/idle-timeout', { method: 'PUT', body });
  return meResponseSchema.parse(data);
}

export async function validateInvite(
  token: string,
  signal?: AbortSignal,
): Promise<InviteValidationResponse> {
  const data = await apiRequest<unknown>(`/auth/invite/${encodeURIComponent(token)}`, {
    signal,
    suppressAuthRedirect: true,
  });
  return inviteValidationResponseSchema.parse(data);
}

/**
 * Request a self-service password-reset email (§6.1, §14). Always resolves with
 * a generic ack — the response never reveals whether the email has an account.
 * `suppressAuthRedirect`: a public, unauthenticated call.
 */
export async function requestPasswordReset(body: PasswordResetRequest): Promise<void> {
  await apiRequest<unknown>('/auth/password-reset/request', {
    method: 'POST',
    body,
    suppressAuthRedirect: true,
  });
}

/**
 * Complete a password reset with the emailed token (§6.1, §14). Resolves to
 * either the signed-in user — the API set a fresh session cookie, so the reset
 * lands them logged-in with no redundant prompt (#268) — or a 2FA challenge
 * (`twoFactorRequired`) when the account has a second factor on, which the caller
 * completes via {@link verifyTwoFactor} before a session exists. A mailbox alone
 * must not defeat the second factor (§6.1).
 */
export async function completePasswordReset(body: PasswordResetComplete): Promise<LoginResponse> {
  const data = await apiRequest<unknown>('/auth/password-reset/complete', {
    method: 'POST',
    body,
    suppressAuthRedirect: true,
  });
  return loginResponseSchema.parse(data);
}

export async function acceptInvite(body: AcceptInviteRequest): Promise<MeResponse> {
  const data = await apiRequest<unknown>('/auth/accept-invite', {
    method: 'POST',
    body,
    suppressAuthRedirect: true,
  });
  return meResponseSchema.parse(data);
}

/**
 * Public registration-mode discovery (§13.4 V4-P4a). Lets the login / register
 * surfaces reflect the active mode. `suppressAuthRedirect`: unauthenticated.
 */
export async function getRegistrationInfo(
  signal?: AbortSignal,
): Promise<PublicRegistrationInfoResponse> {
  const data = await apiRequest<unknown>('/auth/registration-info', {
    signal,
    suppressAuthRedirect: true,
  });
  return publicRegistrationInfoResponseSchema.parse(data);
}

/**
 * Google sign-in (§13.4 V4-P4b). The OAuth flow is TWO browser redirects, so the
 * SPA never fetches these — it navigates the whole window to `/auth/google/start`
 * (a live session turns it into a "link" flow; an invite token rides along for
 * invite-token registration). Returns the absolute URL to assign to
 * `window.location`, so cookies + the top-level redirect back from Google behave.
 */
export function googleStartUrl(opts: { inviteToken?: string } = {}): string {
  const base = `${apiBaseUrl()}/auth/google/start`;
  return opts.inviteToken ? `${base}?inviteToken=${encodeURIComponent(opts.inviteToken)}` : base;
}

/** The caller's Google link state for Settings → Security (§13.4 V4-P4b). */
export async function getGoogleLinkStatus(signal?: AbortSignal): Promise<GoogleLinkStatusResponse> {
  const data = await apiRequest<unknown>('/auth/google/link-status', { signal });
  return googleLinkStatusResponseSchema.parse(data);
}

/**
 * Unlink the Google account after a password re-auth (§13.4 V4-P4b). Refused
 * (409 GOOGLE_ONLY_SIGN_IN) while Google is the only usable sign-in method;
 * `suppressAuthRedirect` so a wrong-password 401 stays an in-form error.
 */
export async function unlinkGoogle(password: string): Promise<void> {
  await apiRequest<unknown>('/auth/google/unlink', {
    method: 'POST',
    body: { password },
    suppressAuthRedirect: true,
  });
}

/**
 * Public self-serve registration (§13.4 V4-P4a). Resolves to either the signed-in
 * user (open / invite-token modes set a session cookie) or the approval-pending
 * answer (`{ pending: true }`, no session). Closed mode / a bad token / a taken
 * email throw an {@link ApiError}. `suppressAuthRedirect`: a public call.
 */
export async function register(body: RegisterRequest): Promise<RegisterResponse> {
  const data = await apiRequest<unknown>('/auth/register', {
    method: 'POST',
    body,
    suppressAuthRedirect: true,
  });
  return registerResponseSchema.parse(data);
}

/**
 * Self-service account deletion (§13.4 V4-P2c, #362): typed username
 * confirmation + re-auth (password or fresh 2FA). Irreversible — on success the
 * server has already revoked every session, so the caller resets local auth
 * state. `suppressAuthRedirect`: a 401 (wrong credential) is an in-form error.
 */
export async function deleteAccount(body: DeleteAccountRequest): Promise<void> {
  await apiRequest<unknown>('/account', {
    method: 'DELETE',
    body,
    suppressAuthRedirect: true,
  });
}
