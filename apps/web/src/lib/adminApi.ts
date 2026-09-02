import {
  adminApiKeyListResponseSchema,
  adminFeedbackListResponseSchema,
  adminFeedbackSubmissionSchema,
  apiKeyAuditResponseSchema,
  apiKeyTierListResponseSchema,
  apiKeyTierSchema,
  adminBackupStatusResponseSchema,
  adminHealthResponseSchema,
  adminInviteListResponseSchema,
  adminStatsSchema,
  adminTwoFactorStatusResponseSchema,
  adminUserListResponseSchema,
  adminUserSchema,
  adminUserAccessResponseSchema,
  adminUserSharingResponseSchema,
  adminUserSupportResponseSchema,
  adminUserNoteSchema,
  adminUserNoteListResponseSchema,
  accountDefaultsResponseSchema,
  adminFeatureFlagsResponseSchema,
  adminSessionPolicyResponseSchema,
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
  updateFeedbackStatusResponseSchema,
  updateFeedbackArchiveResponseSchema,
  feedbackThreadResponseSchema,
  sendFeedbackMessageResponseSchema,
  monitoringStatusResponseSchema,
  aiSettingsResponseSchema,
  aiTestConnectionResponseSchema,
  aiTestRequestResponseSchema,
  usageAnalyticsResponseSchema,
  createRegistrationTokenResponseSchema,
  registrationRequestListResponseSchema,
  registrationTokenListResponseSchema,
  resetPasswordResponseSchema,
  testEmailResponseSchema,
  twoFactorEnrollResponseSchema,
  twoFactorMethodEnabledResponseSchema,
  twoFactorRecoveryCodesResponseSchema,
  versionResponseSchema,
  type AdminBackupStatusResponse,
  type AdminHealthResponse,
  type AdminFeedbackListResponse,
  type AdminFeedbackSubmission,
  type AdminFeedbackListQuery,
  type AdminInviteListResponse,
  type AdminStats,
  type AdminTwoFactorEmailStartRequest,
  type AdminTwoFactorStatusResponse,
  type AdminSessionPolicyResponse,
  type AdminUser,
  type AdminUserListResponse,
  type AccountDefaultsResponse,
  type AdminFeatureFlagsResponse,
  type FeatureFlagKey,
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
  type UpdateFeedbackStatusRequest,
  type UpdateFeedbackArchiveRequest,
  type UpdateFeedbackArchiveResponse,
  type FeedbackThreadQuery,
  type FeedbackThreadResponse,
  type SendFeedbackMessageRequest,
  type SendFeedbackMessageResponse,
  type UpdateFeedbackStatusResponse,
  type MonitoringStatusResponse,
  type AiSettingsResponse,
  type AiTestConnectionRequest,
  type AiTestConnectionResponse,
  type AiTestRequest,
  type AiTestRequestResponse,
  type UpdateAiSettingsRequest,
  type UsageAnalyticsResponse,
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
  type AdminUserListQuery,
  type AdminUserAccessResponse,
  type AdminUserSharingResponse,
  type AdminUserSupportResponse,
  type AdminUserNote,
  type AdminUserNoteListResponse,
  type CreateAdminUserNoteRequest,
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
  type UpdateAdminSessionPolicyRequest,
  type UpdateAnnouncementRequest,
  type UpdateAppSettingsRequest,
  type UpdateOAuthClientRequest,
  type UpdateUserRequest,
  type VersionResponse,
  type AdminApiKey,
  type AdminApiKeyListResponse,
  type ApiKeyAuditResponse,
  type ApiKeyTier,
  type ApiKeyTierListResponse,
  type CreateApiKeyTierRequest,
  type UpdateApiKeyTierRequest,
} from '@bettertrack/contracts';

import { ApiError, apiRequest } from './apiClient';

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

/**
 * The People list (#1406 W2). Every filter is optional; omitted keys are simply
 * not sent, so the server's own defaults (newest first, 25 rows) apply and the
 * ⌘K palette can keep calling this with nothing but a search term.
 */
export async function listUsers(
  params: Partial<AdminUserListQuery> = {},
  signal?: AbortSignal,
): Promise<AdminUserListResponse> {
  const data = await apiRequest<unknown>('/admin/users', {
    query: {
      search: params.search,
      role: params.role,
      status: params.status,
      privacyMode: params.privacyMode,
      sort: params.sort,
      direction: params.direction,
      limit: params.limit,
      offset: params.offset,
    },
    signal,
  });
  return adminUserListResponseSchema.parse(data);
}

/** One account — the read that retired downloading the whole table (#1406 W2). */
export async function getUser(id: string, signal?: AbortSignal): Promise<AdminUser> {
  const data = await apiRequest<unknown>(`/admin/users/${id}`, { signal });
  return adminUserSchema.parse(data);
}

/** Sessions, API keys, OAuth grants and linked identities — all read-only. */
export async function getUserAccess(
  id: string,
  signal?: AbortSignal,
): Promise<AdminUserAccessResponse> {
  const data = await apiRequest<unknown>(`/admin/users/${id}/access`, { signal });
  return adminUserAccessResponseSchema.parse(data);
}

/** How exposed the account is, as counts. Never an inventory (§3, §6.12). */
export async function getUserSharing(
  id: string,
  signal?: AbortSignal,
): Promise<AdminUserSharingResponse> {
  const data = await apiRequest<unknown>(`/admin/users/${id}/sharing`, { signal });
  return adminUserSharingResponseSchema.parse(data);
}

/** This account's support submissions, summarized — no message bodies. */
export async function getUserSupport(
  id: string,
  signal?: AbortSignal,
): Promise<AdminUserSupportResponse> {
  const data = await apiRequest<unknown>(`/admin/users/${id}/support`, { signal });
  return adminUserSupportResponseSchema.parse(data);
}

export async function listUserNotes(
  id: string,
  signal?: AbortSignal,
): Promise<AdminUserNoteListResponse> {
  const data = await apiRequest<unknown>(`/admin/users/${id}/notes`, { signal });
  return adminUserNoteListResponseSchema.parse(data);
}

export async function createUserNote(
  id: string,
  body: CreateAdminUserNoteRequest,
): Promise<AdminUserNote> {
  const data = await apiRequest<unknown>(`/admin/users/${id}/notes`, { method: 'POST', body });
  return adminUserNoteSchema.parse(data);
}

export async function deleteUserNote(id: string, noteId: string): Promise<void> {
  await apiRequest<unknown>(`/admin/users/${id}/notes/${noteId}`, { method: 'DELETE' });
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

// --- Admin: Problems (§13.5 V5-P2 arc (d)) ---------------------------------

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

// --- Admin: feedback inbox -------------------------------------------------

export async function listAdminFeedback(
  params: Partial<AdminFeedbackListQuery> = {},
  signal?: AbortSignal,
): Promise<AdminFeedbackListResponse> {
  const data = await apiRequest<unknown>('/admin/feedback', {
    query: {
      category: params.category,
      status: params.status,
      version: params.version,
      q: params.q,
      // `archived` and `unread` are booleans on the wire's TEXT side: the query
      // builder drops `undefined`, so an omitted `unread` stays "don't filter",
      // while an explicit `false` must still be sent as the string "false".
      archived: params.archived === undefined ? undefined : String(params.archived),
      unread: params.unread === undefined ? undefined : String(params.unread),
      sort: params.sort,
      page: params.page,
      limit: params.limit,
    },
    signal,
  });
  return adminFeedbackListResponseSchema.parse(data);
}

/**
 * "Gone" is an answer, not a session problem.
 *
 * The admin area answers non-admins with 404 rather than 403 (§6.12), so the
 * shared `useResource` treats any 404 as "this session is no longer an admin"
 * and signs the operator out. That is right for a whole page and wrong for one
 * addressed row: a helpdesk link to a submission that was since deleted would
 * log the operator out instead of saying the thread is gone. Mapping 404 to
 * `null` here keeps the dead end local. It cannot mask a genuinely expired
 * session, because the inbox list read on the same screen is not wrapped and
 * still trips the sign-out.
 */
async function nullOnMissing<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/**
 * One submission by id (#1406 W3). The split pane opens whatever `?thread=`
 * names even when the current filters exclude it, so the thread pane reads this
 * rather than hunting the row inside the paged list.
 */
export async function getAdminFeedback(
  id: string,
  signal?: AbortSignal,
): Promise<AdminFeedbackSubmission | null> {
  return nullOnMissing(async () => {
    const data = await apiRequest<unknown>(`/admin/feedback/${id}`, { signal });
    return adminFeedbackSubmissionSchema.parse(data);
  });
}

export async function getAdminFeedbackThread(
  id: string,
  params: FeedbackThreadQuery = {},
  signal?: AbortSignal,
): Promise<FeedbackThreadResponse | null> {
  return nullOnMissing(async () => {
    const data = await apiRequest<unknown>(`/admin/feedback/${id}/messages`, {
      query: { cursor: params.cursor, limit: params.limit },
      signal,
    });
    return feedbackThreadResponseSchema.parse(data);
  });
}

export async function sendAdminFeedbackReply(
  id: string,
  body: SendFeedbackMessageRequest,
): Promise<SendFeedbackMessageResponse> {
  const data = await apiRequest<unknown>(`/admin/feedback/${id}/messages`, {
    method: 'POST',
    body,
  });
  return sendFeedbackMessageResponseSchema.parse(data);
}

/** Idempotent: the route advances the shared admin marker on every open. */
export async function markAdminFeedbackRead(id: string): Promise<void> {
  const data = await apiRequest<unknown>(`/admin/feedback/${id}/read`, { method: 'POST' });
  okResponseSchema.parse(data);
}

export async function updateFeedbackStatus(
  id: string,
  body: UpdateFeedbackStatusRequest,
): Promise<UpdateFeedbackStatusResponse> {
  const data = await apiRequest<unknown>(`/admin/feedback/${id}`, {
    method: 'PATCH',
    body,
  });
  return updateFeedbackStatusResponseSchema.parse(data);
}

/** Workspace hygiene, not a lifecycle transition — and never a delete. */
export async function setAdminFeedbackArchived(
  id: string,
  archived: boolean,
): Promise<UpdateFeedbackArchiveResponse> {
  const data = await apiRequest<unknown>(`/admin/feedback/${id}`, {
    method: 'PATCH',
    body: { archived } satisfies UpdateFeedbackArchiveRequest,
  });
  return updateFeedbackArchiveResponseSchema.parse(data);
}

// --- Admin: Usage analytics (§13.5 V5-P2 arc (b), first-party only) --------

export async function getUsageAnalytics(signal?: AbortSignal): Promise<UsageAnalyticsResponse> {
  const data = await apiRequest<unknown>('/admin/usage-analytics', { signal });
  return usageAnalyticsResponseSchema.parse(data);
}

// --- Admin: Monitoring / Diagnostics (§13.5 V5-P2 arc (a), owner 2026-07-19) --

/**
 * Grafana/Prometheus reachability + the external-access posture that backs the
 * Diagnostics panel. The probe fails soft server-side, so this always resolves
 * even when the stack is down — the panel degrades to "not reachable".
 */
export async function getMonitoringStatus(signal?: AbortSignal): Promise<MonitoringStatusResponse> {
  const data = await apiRequest<unknown>('/admin/monitoring/status', { signal });
  return monitoringStatusResponseSchema.parse(data);
}

/**
 * Flip the runtime kill-switch for the admin-proxied external reach. Off takes
 * effect on the next proxy request; it can never widen exposure past the deploy
 * + password gates. Returns the refreshed status.
 */
export async function setMonitoringExternalAccess(
  enabled: boolean,
): Promise<MonitoringStatusResponse> {
  const data = await apiRequest<unknown>('/admin/monitoring/external-access', {
    method: 'PATCH',
    body: { enabled },
  });
  return monitoringStatusResponseSchema.parse(data);
}

// --- Admin: local-AI provider settings (§13.5 V5-P12, LOCAL OLLAMA ONLY) ---

/** The effective Ollama endpoint + model + per-user daily cap (no secrets). */
export async function getAiSettings(signal?: AbortSignal): Promise<AiSettingsResponse> {
  const data = await apiRequest<unknown>('/admin/ai/settings', { signal });
  return aiSettingsResponseSchema.parse(data);
}

/** Set the endpoint / model / daily cap (audit-logged; live on the next request). */
export async function updateAiSettings(body: UpdateAiSettingsRequest): Promise<AiSettingsResponse> {
  const data = await apiRequest<unknown>('/admin/ai/settings', { method: 'PATCH', body });
  return aiSettingsResponseSchema.parse(data);
}

/** Probe an endpoint (candidate or stored) and list the models it serves. */
export async function testAiConnection(
  body: AiTestConnectionRequest,
): Promise<AiTestConnectionResponse> {
  const data = await apiRequest<unknown>('/admin/ai/test-connection', { method: 'POST', body });
  return aiTestConnectionResponseSchema.parse(data);
}

/** Generate against a candidate endpoint/model and return the reply + latency. */
export async function sendAiTestRequest(body: AiTestRequest): Promise<AiTestRequestResponse> {
  const data = await apiRequest<unknown>('/admin/ai/test-request', { method: 'POST', body });
  return aiTestRequestResponseSchema.parse(data);
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

// --- Admin: session policy (§13.5 V5-P13c) --------------------------------

/** The early-expiring admin session lifetime (hours) + the allowed 6–24 h window. */
export async function getSessionPolicy(signal?: AbortSignal): Promise<AdminSessionPolicyResponse> {
  const data = await apiRequest<unknown>('/admin/security/session-policy', { signal });
  return adminSessionPolicyResponseSchema.parse(data);
}

/** Set the admin session lifetime (audit-logged; live on the next request). */
export async function updateSessionPolicy(
  body: UpdateAdminSessionPolicyRequest,
): Promise<AdminSessionPolicyResponse> {
  const data = await apiRequest<unknown>('/admin/security/session-policy', {
    method: 'PATCH',
    body,
  });
  return adminSessionPolicyResponseSchema.parse(data);
}

// --- Admin: runtime feature kill-switches (§13.5 V5-P2 arc (c)) ------------

export async function getFeatureFlags(signal?: AbortSignal): Promise<AdminFeatureFlagsResponse> {
  const data = await apiRequest<unknown>('/admin/feature-flags', { signal });
  return adminFeatureFlagsResponseSchema.parse(data);
}

export async function setFeatureFlag(
  key: FeatureFlagKey,
  enabled: boolean,
): Promise<AdminFeatureFlagsResponse> {
  const data = await apiRequest<unknown>(`/admin/feature-flags/${key}`, {
    method: 'PATCH',
    body: { enabled },
  });
  return adminFeatureFlagsResponseSchema.parse(data);
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

/**
 * Backup / restore-drill readiness (#1406 W1). Read-only, and deliberately
 * forgiving: a deployment without the backup sidecar answers `configured: false`
 * rather than failing, so the Overview tile reads "not configured" locally.
 */
export async function getBackupStatus(signal?: AbortSignal): Promise<AdminBackupStatusResponse> {
  const data = await apiRequest<unknown>('/admin/ops/backup-status', { signal });
  return adminBackupStatusResponseSchema.parse(data);
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

// --- Admin: API-key governance (§13.5 V5-P10, issue 2/2) -------------------

export async function listApiKeyTiers(signal?: AbortSignal): Promise<ApiKeyTierListResponse> {
  const data = await apiRequest<unknown>('/admin/api-key-tiers', { signal });
  return apiKeyTierListResponseSchema.parse(data);
}

export async function createApiKeyTier(body: CreateApiKeyTierRequest): Promise<ApiKeyTier> {
  const data = await apiRequest<unknown>('/admin/api-key-tiers', { method: 'POST', body });
  return apiKeyTierSchema.parse(data);
}

export async function updateApiKeyTier(
  id: string,
  body: UpdateApiKeyTierRequest,
): Promise<ApiKeyTier> {
  const data = await apiRequest<unknown>(`/admin/api-key-tiers/${id}`, { method: 'PATCH', body });
  return apiKeyTierSchema.parse(data);
}

export async function deleteApiKeyTier(id: string): Promise<void> {
  await apiRequest<unknown>(`/admin/api-key-tiers/${id}`, { method: 'DELETE' });
}

export async function listAdminApiKeys(signal?: AbortSignal): Promise<AdminApiKeyListResponse> {
  const data = await apiRequest<unknown>('/admin/api-keys', { signal });
  return adminApiKeyListResponseSchema.parse(data);
}

export async function assignApiKeyTier(id: string, tierId: string | null): Promise<AdminApiKey> {
  const data = await apiRequest<unknown>(`/admin/api-keys/${id}/tier`, {
    method: 'PATCH',
    body: { tierId },
  });
  return data as AdminApiKey;
}

export async function getApiKeyAudit(
  id: string,
  signal?: AbortSignal,
): Promise<ApiKeyAuditResponse> {
  const data = await apiRequest<unknown>(`/admin/api-keys/${id}/audit`, { signal });
  return apiKeyAuditResponseSchema.parse(data);
}
