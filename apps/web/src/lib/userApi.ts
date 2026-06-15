import {
  inviteValidationResponseSchema,
  meResponseSchema,
  type AcceptInviteRequest,
  type ChangePasswordRequest,
  type InviteValidationResponse,
  type LoginRequest,
  type MeResponse,
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

export async function changePassword(body: ChangePasswordRequest): Promise<MeResponse> {
  const data = await apiRequest<unknown>('/auth/change-password', {
    method: 'POST',
    body,
    suppressAuthRedirect: true,
  });
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
