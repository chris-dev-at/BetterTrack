import {
  inviteValidationResponseSchema,
  meResponseSchema,
  sessionInfoResponseSchema,
  type AcceptInviteRequest,
  type ChangePasswordRequest,
  type InviteValidationResponse,
  type LoginRequest,
  type MeResponse,
  type PinVerifyRequest,
  type SessionInfoResponse,
  type SetPinLockRequest,
  type SetPinRequest,
} from '@bettertrack/contracts';

import { apiRequest } from './apiClient';

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

export async function login(body: LoginRequest): Promise<MeResponse> {
  const data = await apiRequest<unknown>('/auth/login', {
    method: 'POST',
    body,
    suppressAuthRedirect: true,
  });
  return meResponseSchema.parse(data);
}

export async function logout(): Promise<void> {
  await apiRequest<unknown>('/auth/logout', { method: 'POST', suppressAuthRedirect: true });
}

export async function getMe(signal?: AbortSignal): Promise<MeResponse> {
  const data = await apiRequest<unknown>('/auth/me', { signal, suppressAuthRedirect: true });
  return meResponseSchema.parse(data);
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

export async function acceptInvite(body: AcceptInviteRequest): Promise<MeResponse> {
  const data = await apiRequest<unknown>('/auth/accept-invite', {
    method: 'POST',
    body,
    suppressAuthRedirect: true,
  });
  return meResponseSchema.parse(data);
}
