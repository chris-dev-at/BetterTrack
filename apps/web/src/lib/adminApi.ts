import {
  adminHealthResponseSchema,
  adminInviteListResponseSchema,
  adminStatsSchema,
  adminTwoFactorStatusResponseSchema,
  adminUserListResponseSchema,
  adminUserSchema,
  accountDefaultsResponseSchema,
  announcementListResponseSchema,
  announcementSchema,
  appSettingsResponseSchema,
  auditLogListResponseSchema,
  bulkUserActionResponseSchema,
  createInviteResponseSchema,
  createOAuthClientResponseSchema,
  createUserResponseSchema,
  emailLogListResponseSchema,
  emailStatusResponseSchema,
  loginResponseSchema,
  meResponseSchema,
  oauthClientListResponseSchema,
  oauthClientSummarySchema,
  okResponseSchema,
  problemSchema,
  problemListResponseSchema,
  createRegistrationTokenResponseSchema,
  registrationRequestListResponseSchema,
  registrationTokenListResponseSchema,
  resetPasswordResponseSchema,
  testEmailResponseSchema,
  twoFactorEnrollResponseSchema,
  twoFactorMethodEnabledResponseSchema,
  twoFactorRecoveryCodesResponseSchema,
  versionResponseSchema,
  type AdminHealthResponse,
  type AdminInviteListResponse,
  type AdminStats,
  type AdminTwoFactorEmailStartRequest,
  type AdminTwoFactorStatusResponse,
  type AdminUser,
  type AdminUserListResponse,
  type AccountDefaultsResponse,
  type Announcement,
  type AnnouncementListResponse,
  type AppSettingsResponse,
  type AuditLogListResponse,
  type BulkUserActionRequest,
  type BulkUserActionResponse,
  type ChangePasswordRequest,
  type CreateAnnouncementRequest,
  type CreateInviteRequest,
  type CreateInviteResponse,
  type CreateOAuthClientRequest,
  type CreateOAuthClientResponse,
  type CreateUserRequest,
  type CreateUserResponse,
  type EmailLogListResponse,
  type EmailStatusResponse,
  type Problem,
  type ProblemKind,
  type ProblemListResponse,
  type ProblemStatus,
  type LoginRequest,
  type LoginResponse,
  type MeResponse,
  type CreateRegistrationTokenRequest,
  type CreateRegistrationTokenResponse,
  type OAuthClientListResponse,
  type OAuthClientSummary,
  type RegistrationRequestListResponse,
  type RegistrationTokenListResponse,
  type ResetPasswordResponse,
  type TestEmailRequest,
  type TestEmailResponse,
  type TwoFactorConfirmRequest,
  type TwoFactorDisableRequest,
  type TwoFactorEmailCodeRequest,
  type TwoFactorEmailConfirmRequest,
  type TwoFactorEnrollResponse,
  type TwoFactorMethodEnabledResponse,
  type TwoFactorRecoveryCodesResponse,
  type TwoFactorVerifyRequest,
  type UpdateAccountDefaultsRequest,
  type UpdateAnnouncementRequest,
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

/**
 * Password login (§6.1). Resolves to either the signed-in admin (no 2FA — the
 * session cookie is set) or a login 2FA challenge (`twoFactorRequired`) that the
 * caller completes via {@link verifyTwoFactor}. Every admin is enrolled once the
 * mandatory-2FA bootstrap (#400) is satisfied, so an established admin gets the
 * challenge branch.
 */
export async function login(body: LoginRequest): Promise<LoginResponse> {
  const data = await apiRequest<unknown>('/auth/login', { method: 'POST', body });
  return loginResponseSchema.parse(data);
}

/**
 * Complete a login 2FA challenge (§6.1, #400) with a TOTP/email code or a recovery
 * code. On success the API sets the session cookie and returns the signed-in admin.
 */
export async function verifyTwoFactor(body: TwoFactorVerifyRequest): Promise<MeResponse> {
  const data = await apiRequest<unknown>('/auth/2fa/verify', { method: 'POST', body });
  return meResponseSchema.parse(data);
}

/** Request a one-time email login code for a pending 2FA challenge (§6.1). */
export async function requestTwoFactorEmailCode(body: TwoFactorEmailCodeRequest): Promise<void> {
  await apiRequest<unknown>('/auth/2fa/email-code', { method: 'POST', body });
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

// --- Admin: registration tokens + approval queue (§6.12, §13.4 V4-P4a) -----

export async function listRegistrationTokens(
  signal?: AbortSignal,
): Promise<RegistrationTokenListResponse> {
  const data = await apiRequest<unknown>('/admin/registration-tokens', { signal });
  return registrationTokenListResponseSchema.parse(data);
}

export async function createRegistrationToken(
  body: CreateRegistrationTokenRequest,
): Promise<CreateRegistrationTokenResponse> {
  const data = await apiRequest<unknown>('/admin/registration-tokens', { method: 'POST', body });
  return createRegistrationTokenResponseSchema.parse(data);
}

export async function revokeRegistrationToken(id: string): Promise<void> {
  const data = await apiRequest<unknown>(`/admin/registration-tokens/${id}/revoke`, {
    method: 'POST',
  });
  okResponseSchema.parse(data);
}

export async function listRegistrationRequests(
  signal?: AbortSignal,
): Promise<RegistrationRequestListResponse> {
  const data = await apiRequest<unknown>('/admin/registration-requests', { signal });
  return registrationRequestListResponseSchema.parse(data);
}

export async function approveRegistrationRequest(id: string): Promise<AdminUser> {
  const data = await apiRequest<unknown>(`/admin/registration-requests/${id}/approve`, {
    method: 'POST',
  });
  return adminUserSchema.parse(data);
}

export async function rejectRegistrationRequest(id: string): Promise<void> {
  const data = await apiRequest<unknown>(`/admin/registration-requests/${id}/reject`, {
    method: 'POST',
  });
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

// --- Admin: Problems (§13.5 V5-P2 arc (d), the Sentry replacement) ---------

export async function listProblems(
  params: { kind?: ProblemKind; status?: ProblemStatus; limit?: number } = {},
  signal?: AbortSignal,
): Promise<ProblemListResponse> {
  const data = await apiRequest<unknown>('/admin/problems', {
    query: { kind: params.kind, status: params.status, limit: params.limit },
    signal,
  });
  return problemListResponseSchema.parse(data);
}

export async function resolveProblem(id: string): Promise<Problem> {
  const data = await apiRequest<unknown>(`/admin/problems/${id}/resolve`, { method: 'POST' });
  return problemSchema.parse(data);
}

export async function reopenProblem(id: string): Promise<Problem> {
  const data = await apiRequest<unknown>(`/admin/problems/${id}/reopen`, { method: 'POST' });
  return problemSchema.parse(data);
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

// --- Admin: new-account defaults (§13.4 V4-P0d) ---------------------------

export async function getAccountDefaults(signal?: AbortSignal): Promise<AccountDefaultsResponse> {
  const data = await apiRequest<unknown>('/admin/account-defaults', { signal });
  return accountDefaultsResponseSchema.parse(data);
}

/**
 * Operator health snapshot (§13.4 V4-P5a): DB/Redis/provider/queue/gateway
 * status plus app version and uptime. Live-probed server-side on every call, so
 * a stopped dependency reflects on the next fetch.
 */
export async function getAdminHealth(signal?: AbortSignal): Promise<AdminHealthResponse> {
  const data = await apiRequest<unknown>('/admin/health', { signal });
  return adminHealthResponseSchema.parse(data);
}

export async function updateAccountDefaults(
  body: UpdateAccountDefaultsRequest,
): Promise<AccountDefaultsResponse> {
  const data = await apiRequest<unknown>('/admin/account-defaults', { method: 'PATCH', body });
  return accountDefaultsResponseSchema.parse(data);
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

// --- Admin: mandatory-login 2FA (§6.12, #400) -----------------------------

/**
 * The admin's own 2FA state + the mandatory-setup gate flag. EXEMPT from the gate,
 * so it always answers for a logged-in admin — the SPA reads `setupRequired` to
 * decide between the forced-enrollment wizard and the console.
 */
export async function getTwoFactorStatus(
  signal?: AbortSignal,
): Promise<AdminTwoFactorStatusResponse> {
  const data = await apiRequest<unknown>('/admin/security/2fa/status', { signal });
  return adminTwoFactorStatusResponseSchema.parse(data);
}

/** Begin authenticator enrollment — a provisional secret + `otpauth://` URI (not yet on). */
export async function enrollTotp(): Promise<TwoFactorEnrollResponse> {
  const data = await apiRequest<unknown>('/admin/security/2fa/totp/enroll', { method: 'POST' });
  return twoFactorEnrollResponseSchema.parse(data);
}

/**
 * Enable the authenticator method by proving a current code. `recoveryCodes` is the
 * fresh set when this is the first method enabled, else `null`.
 */
export async function confirmTotp(
  body: TwoFactorConfirmRequest,
): Promise<TwoFactorMethodEnabledResponse> {
  const data = await apiRequest<unknown>('/admin/security/2fa/totp/confirm', {
    method: 'POST',
    body,
  });
  return twoFactorMethodEnabledResponseSchema.parse(data);
}

/** Disable the authenticator method — a current TOTP code or recovery code authorizes it. */
export async function disableTotp(body: TwoFactorDisableRequest): Promise<void> {
  await apiRequest<unknown>('/admin/security/2fa/totp/disable', { method: 'POST', body });
}

/**
 * Set (first time) or change the 2FA email and mail a confirmation code to it.
 * `proof` (a current TOTP or recovery code) is required only when already enrolled.
 */
export async function startEmailTwoFactor(body: AdminTwoFactorEmailStartRequest): Promise<void> {
  await apiRequest<unknown>('/admin/security/2fa/email/start', { method: 'POST', body });
}

/** Enable the email method with the mailed code (first method → fresh recovery codes). */
export async function confirmEmailTwoFactor(
  body: TwoFactorEmailConfirmRequest,
): Promise<TwoFactorMethodEnabledResponse> {
  const data = await apiRequest<unknown>('/admin/security/2fa/email/confirm', {
    method: 'POST',
    body,
  });
  return twoFactorMethodEnabledResponseSchema.parse(data);
}

/** Turn the email method off (authenticated admin session). */
export async function disableEmailTwoFactor(): Promise<void> {
  await apiRequest<unknown>('/admin/security/2fa/email/disable', { method: 'POST' });
}

/** Regenerate recovery codes — invalidates any prior unused codes; shown once. */
export async function regenerateRecoveryCodes(): Promise<TwoFactorRecoveryCodesResponse> {
  const data = await apiRequest<unknown>('/admin/security/2fa/recovery-codes', { method: 'POST' });
  return twoFactorRecoveryCodesResponseSchema.parse(data);
}

// --- Admin: announcements (§13.4 V4-P5b) ----------------------------------

/** Every composed announcement, newest first — the admin composer's list. */
export async function listAnnouncements(signal?: AbortSignal): Promise<AnnouncementListResponse> {
  const data = await apiRequest<unknown>('/admin/announcements', { signal });
  return announcementListResponseSchema.parse(data);
}

/**
 * Create an announcement. EN + DE title/body are required (§13.4 binding).
 * Creating with `active: true` publishes immediately (fans one inbox row out
 * per user, idempotent per user via the shared eventKey).
 */
export async function createAnnouncement(body: CreateAnnouncementRequest): Promise<Announcement> {
  const data = await apiRequest<unknown>('/admin/announcements', { method: 'POST', body });
  return announcementSchema.parse(data);
}

/**
 * Update an announcement. Flipping `active` off → on publishes; a re-publish
 * (already-published row toggled off → on again) is a per-user no-op via the
 * shared eventKey.
 */
export async function updateAnnouncement(
  id: string,
  body: UpdateAnnouncementRequest,
): Promise<Announcement> {
  const data = await apiRequest<unknown>(`/admin/announcements/${id}`, { method: 'PATCH', body });
  return announcementSchema.parse(data);
}

/** Delete an announcement (cascades per-user dismissals away). */
export async function deleteAnnouncement(id: string): Promise<void> {
  await apiRequest<unknown>(`/admin/announcements/${id}`, { method: 'DELETE' });
}
