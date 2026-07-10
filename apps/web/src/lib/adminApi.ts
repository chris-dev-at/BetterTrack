import {
  adminInviteListResponseSchema,
  adminStatsSchema,
  adminUserListResponseSchema,
  adminUserSchema,
  appSettingsResponseSchema,
  auditLogListResponseSchema,
  bulkUserActionResponseSchema,
  createInviteResponseSchema,
  createOAuthClientResponseSchema,
  createUserResponseSchema,
  emailLogListResponseSchema,
  emailStatusResponseSchema,
  meResponseSchema,
  oauthClientListResponseSchema,
  oauthClientSummarySchema,
  okResponseSchema,
  resetPasswordResponseSchema,
  testEmailResponseSchema,
  versionResponseSchema,
  type AdminInviteListResponse,
  type AdminStats,
  type AdminUser,
  type AdminUserListResponse,
  type AppSettingsResponse,
  type AuditLogListResponse,
  type BulkUserActionRequest,
  type BulkUserActionResponse,
  type ChangePasswordRequest,
  type CreateInviteRequest,
  type CreateInviteResponse,
  type CreateOAuthClientRequest,
  type CreateOAuthClientResponse,
  type CreateUserRequest,
  type CreateUserResponse,
  type EmailLogListResponse,
  type EmailStatusResponse,
  type LoginRequest,
  type MeResponse,
  type OAuthClientListResponse,
  type OAuthClientSummary,
  type ResetPasswordResponse,
  type TestEmailRequest,
  type TestEmailResponse,
  type UpdateAppSettingsRequest,
  type UpdateOAuthClientRequest,
  type UpdateUserRequest,
  type VersionResponse,
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

/**
 * Complete a forced password change for the current session (§6.1). Used to let
 * an admin whose password was reset recover the account from the admin area
 * itself — the session established by the temp-password login is the proof, so
 * no current password is sent (#248 items 6/7).
 */
export async function changePassword(body: ChangePasswordRequest): Promise<MeResponse> {
  const data = await apiRequest<unknown>('/auth/change-password', { method: 'POST', body });
  return meResponseSchema.parse(data);
}

export async function getMe(signal?: AbortSignal): Promise<MeResponse> {
  const data = await apiRequest<unknown>('/auth/me', { signal });
  return meResponseSchema.parse(data);
}

// --- Meta ------------------------------------------------------------------

/**
 * Public deploy marker (`GET /api/v1/version`) — no auth. The admin login footer
 * uses it to show which API commit is live; callers treat any failure as "marker
 * unavailable" and fail silent.
 */
export async function getVersion(signal?: AbortSignal): Promise<VersionResponse> {
  const data = await apiRequest<unknown>('/version', { signal });
  return versionResponseSchema.parse(data);
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

export async function bulkUserAction(body: BulkUserActionRequest): Promise<BulkUserActionResponse> {
  const data = await apiRequest<unknown>('/admin/users/bulk', { method: 'POST', body });
  return bulkUserActionResponseSchema.parse(data);
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

// --- Admin: first-party OAuth apps ----------------------------------------

export async function listFirstPartyApps(signal?: AbortSignal): Promise<OAuthClientListResponse> {
  const data = await apiRequest<unknown>('/admin/oauth-clients', { signal });
  return oauthClientListResponseSchema.parse(data);
}

export async function createFirstPartyApp(
  body: CreateOAuthClientRequest,
): Promise<CreateOAuthClientResponse> {
  const data = await apiRequest<unknown>('/admin/oauth-clients', { method: 'POST', body });
  return createOAuthClientResponseSchema.parse(data);
}

export async function updateFirstPartyApp(
  id: string,
  body: UpdateOAuthClientRequest,
): Promise<OAuthClientSummary> {
  const data = await apiRequest<unknown>(`/admin/oauth-clients/${id}`, { method: 'PATCH', body });
  return oauthClientSummarySchema.parse(data);
}

export async function deleteFirstPartyApp(id: string): Promise<void> {
  const data = await apiRequest<unknown>(`/admin/oauth-clients/${id}`, { method: 'DELETE' });
  okResponseSchema.parse(data);
}

// --- Admin: stats + audit -------------------------------------------------

export async function getStats(signal?: AbortSignal): Promise<AdminStats> {
  const data = await apiRequest<unknown>('/admin/stats', { signal });
  return adminStatsSchema.parse(data);
}

// --- Admin: email channel -------------------------------------------------

export async function getEmailStatus(signal?: AbortSignal): Promise<EmailStatusResponse> {
  const data = await apiRequest<unknown>('/admin/email/status', { signal });
  return emailStatusResponseSchema.parse(data);
}

export async function sendTestEmail(body: TestEmailRequest): Promise<TestEmailResponse> {
  const data = await apiRequest<unknown>('/admin/test-email', { method: 'POST', body });
  return testEmailResponseSchema.parse(data);
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

// --- Admin: global settings -----------------------------------------------

export async function getSettings(signal?: AbortSignal): Promise<AppSettingsResponse> {
  const data = await apiRequest<unknown>('/admin/settings', { signal });
  return appSettingsResponseSchema.parse(data);
}

export async function updateSettings(body: UpdateAppSettingsRequest): Promise<AppSettingsResponse> {
  const data = await apiRequest<unknown>('/admin/settings', { method: 'PATCH', body });
  return appSettingsResponseSchema.parse(data);
}

// --- Admin: email log -----------------------------------------------------

export async function listEmails(
  params: { cursor?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<EmailLogListResponse> {
  const data = await apiRequest<unknown>('/admin/emails', {
    query: { cursor: params.cursor, limit: params.limit },
    signal,
  });
  return emailLogListResponseSchema.parse(data);
}

export async function listUserEmails(
  userId: string,
  params: { cursor?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<EmailLogListResponse> {
  const data = await apiRequest<unknown>(`/admin/users/${userId}/emails`, {
    query: { cursor: params.cursor, limit: params.limit },
    signal,
  });
  return emailLogListResponseSchema.parse(data);
}

export async function listUserAudit(
  userId: string,
  params: { cursor?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<AuditLogListResponse> {
  const data = await apiRequest<unknown>(`/admin/users/${userId}/audit`, {
    query: { cursor: params.cursor, limit: params.limit },
    signal,
  });
  return auditLogListResponseSchema.parse(data);
}
