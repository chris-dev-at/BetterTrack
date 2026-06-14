import {
  adminInviteListResponseSchema,
  adminStatsSchema,
  adminUserListResponseSchema,
  adminUserSchema,
  auditLogListResponseSchema,
  createInviteResponseSchema,
  createUserResponseSchema,
  meResponseSchema,
  okResponseSchema,
  resetPasswordResponseSchema,
  type AdminInviteListResponse,
  type AdminStats,
  type AdminUser,
  type AdminUserListResponse,
  type AuditLogListResponse,
  type CreateInviteRequest,
  type CreateInviteResponse,
  type CreateUserRequest,
  type CreateUserResponse,
  type LoginRequest,
  type MeResponse,
  type ResetPasswordResponse,
  type UpdateUserRequest,
} from '@bettertrack/contracts';

import { apiRequest } from './apiClient';

/**
 * Thin, typed wrappers over the auth + admin endpoints (PROJECTPLAN.md §6.1,
 * §6.12, §8). Every response is validated against the shared contract schema so
 * the UI works against a single source of truth — no ad-hoc shapes.
 */

// --- Auth -----------------------------------------------------------------

export async function login(body: LoginRequest): Promise<MeResponse> {
  const data = await apiRequest<unknown>('/auth/login', { method: 'POST', body });
  return meResponseSchema.parse(data);
}

export async function logout(): Promise<void> {
  await apiRequest<unknown>('/auth/logout', { method: 'POST' });
}

export async function getMe(signal?: AbortSignal): Promise<MeResponse> {
  const data = await apiRequest<unknown>('/auth/me', { signal });
  return meResponseSchema.parse(data);
}

// --- Admin: users ---------------------------------------------------------

export async function listUsers(
  search?: string,
  signal?: AbortSignal,
): Promise<AdminUserListResponse> {
  const data = await apiRequest<unknown>('/admin/users', { query: { search }, signal });
  return adminUserListResponseSchema.parse(data);
}

export async function createUser(body: CreateUserRequest): Promise<CreateUserResponse> {
  const data = await apiRequest<unknown>('/admin/users', { method: 'POST', body });
  return createUserResponseSchema.parse(data);
}

export async function updateUser(id: string, body: UpdateUserRequest): Promise<AdminUser> {
  const data = await apiRequest<unknown>(`/admin/users/${id}`, { method: 'PATCH', body });
  return adminUserSchema.parse(data);
}

export async function resetPassword(id: string): Promise<ResetPasswordResponse> {
  const data = await apiRequest<unknown>(`/admin/users/${id}/reset-password`, { method: 'POST' });
  return resetPasswordResponseSchema.parse(data);
}

export async function deleteUser(id: string, confirmUsername: string): Promise<void> {
  const data = await apiRequest<unknown>(`/admin/users/${id}`, {
    method: 'DELETE',
    body: { confirmUsername },
  });
  okResponseSchema.parse(data);
}

// --- Admin: invites -------------------------------------------------------

export async function listInvites(signal?: AbortSignal): Promise<AdminInviteListResponse> {
  const data = await apiRequest<unknown>('/admin/invites', { signal });
  return adminInviteListResponseSchema.parse(data);
}

export async function createInvite(body: CreateInviteRequest): Promise<CreateInviteResponse> {
  const data = await apiRequest<unknown>('/admin/invites', { method: 'POST', body });
  return createInviteResponseSchema.parse(data);
}

export async function revokeInvite(id: string): Promise<void> {
  const data = await apiRequest<unknown>(`/admin/invites/${id}/revoke`, { method: 'POST' });
  okResponseSchema.parse(data);
}

// --- Admin: stats + audit -------------------------------------------------

export async function getStats(signal?: AbortSignal): Promise<AdminStats> {
  const data = await apiRequest<unknown>('/admin/stats', { signal });
  return adminStatsSchema.parse(data);
}

export async function listAudit(
  params: { cursor?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<AuditLogListResponse> {
  const data = await apiRequest<unknown>('/admin/audit', {
    query: { cursor: params.cursor, limit: params.limit },
    signal,
  });
  return auditLogListResponseSchema.parse(data);
}
