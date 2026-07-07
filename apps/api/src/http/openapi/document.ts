import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
  extendZodWithOpenApi,
  type ResponseConfig,
} from '@asteasolutions/zod-to-openapi';
import * as contracts from '@bettertrack/contracts';
import { z } from 'zod';

import { API_VERSION } from '../../version';

// zod-to-openapi augments the shared zod prototype with `.openapi()`, which the
// registry uses to attach `$ref` ids. There is a single zod instance in the
// workspace, so this also covers the contract schemas we register below.
extendZodWithOpenApi(z);

/**
 * OpenAPI 3 document generated from the `@bettertrack/contracts` zod schemas
 * (PROJECTPLAN.md §5, §6.13). Every `/api/v1` endpoint is registered here with
 * its method, path, request (body/query/params) and response schemas, the
 * shared error envelope, and whether it requires a session or is public (`P`).
 *
 * Request/response bodies are NOT hand-typed: they reference the same zod
 * schemas the routers validate against, so the spec cannot drift from the API.
 * The CI coverage gate that fails on an undocumented route is a separate P9
 * follow-up (out of scope here).
 */

// ── Component schemas ───────────────────────────────────────────────────────
// Registered under components.schemas and referenced by `$ref` from the paths.
// A few response wrappers have no dedicated contract schema (the handler returns
// `{ transaction }` / `{ asset }` etc.); those are assembled here from the
// contract *leaf* schemas so they still derive from the contracts package.
const registry = new OpenAPIRegistry();

const componentSchemas = {
  // Shared
  ApiError: contracts.apiErrorSchema,
  OkResponse: contracts.okResponseSchema,
  HealthResponse: contracts.healthResponseSchema,

  // Auth (§6.1)
  LoginRequest: contracts.loginRequestSchema,
  RegisterRequest: contracts.registerRequestSchema,
  AcceptInviteRequest: contracts.acceptInviteRequestSchema,
  ChangePasswordRequest: contracts.changePasswordRequestSchema,
  PasswordResetRequest: contracts.passwordResetRequestSchema,
  PasswordResetComplete: contracts.passwordResetCompleteSchema,
  PinVerifyRequest: contracts.pinVerifyRequestSchema,
  SetPinRequest: contracts.setPinRequestSchema,
  SetPinLockRequest: contracts.setPinLockRequestSchema,
  TwoFactorEnrollResponse: contracts.twoFactorEnrollResponseSchema,
  TwoFactorConfirmRequest: contracts.twoFactorConfirmRequestSchema,
  TwoFactorEmailConfirmRequest: contracts.twoFactorEmailConfirmRequestSchema,
  TwoFactorDisableRequest: contracts.twoFactorDisableRequestSchema,
  TwoFactorStatusResponse: contracts.twoFactorStatusResponseSchema,
  TwoFactorRecoveryCodesResponse: contracts.twoFactorRecoveryCodesResponseSchema,
  TwoFactorMethodEnabledResponse: contracts.twoFactorMethodEnabledResponseSchema,
  TwoFactorVerifyRequest: contracts.twoFactorVerifyRequestSchema,
  TwoFactorEmailCodeRequest: contracts.twoFactorEmailCodeRequestSchema,
  LoginResponse: contracts.loginResponseSchema,
  MeResponse: contracts.meResponseSchema,
  SessionInfoResponse: contracts.sessionInfoResponseSchema,
  SessionSummary: contracts.sessionSummarySchema,
  SessionListResponse: contracts.sessionListResponseSchema,
  RevokeSessionsResponse: contracts.revokeSessionsResponseSchema,
  InviteValidationResponse: contracts.inviteValidationResponseSchema,

  // Admin (§6.12)
  CreateUserRequest: contracts.createUserRequestSchema,
  UpdateUserRequest: contracts.updateUserRequestSchema,
  BulkUserActionRequest: contracts.bulkUserActionRequestSchema,
  BulkUserActionResponse: contracts.bulkUserActionResponseSchema,
  DeleteUserRequest: contracts.deleteUserRequestSchema,
  CreateInviteRequest: contracts.createInviteRequestSchema,
  TestEmailRequest: contracts.testEmailRequestSchema,
  UpdateAppSettingsRequest: contracts.updateAppSettingsRequestSchema,
  AdminUser: contracts.adminUserSchema,
  AdminUserListResponse: contracts.adminUserListResponseSchema,
  CreateUserResponse: contracts.createUserResponseSchema,
  ResetPasswordResponse: contracts.resetPasswordResponseSchema,
  AdminInviteListResponse: contracts.adminInviteListResponseSchema,
  CreateInviteResponse: contracts.createInviteResponseSchema,
  AdminStats: contracts.adminStatsSchema,
  AppSettingsResponse: contracts.appSettingsResponseSchema,
  EmailStatusResponse: contracts.emailStatusResponseSchema,
  TestEmailResponse: contracts.testEmailResponseSchema,
  AuditLogListResponse: contracts.auditLogListResponseSchema,
  EmailLogListResponse: contracts.emailLogListResponseSchema,

  // Workboard (§6.4, §13.2 V2-P9)
  AddToWorkboardRequest: contracts.addToWorkboardRequestSchema,
  ReorderWorkboardRequest: contracts.reorderWorkboardRequestSchema,
  WorkboardItem: contracts.workboardItemSchema,
  WorkboardListResponse: contracts.workboardListResponseSchema,
  WatchlistSharingResponse: contracts.watchlistSharingResponseSchema,
  UpdateWatchlistSharingRequest: contracts.updateWatchlistSharingRequestSchema,

  // Search (§6.2)
  SearchResponse: contracts.searchResponseSchema,

  // Assets (§6.3)
  AssetDetailResponse: contracts.assetDetailResponseSchema,
  QuoteResponse: contracts.quoteResponseSchema,
  HistoryResponse: contracts.historyResponseSchema,
  DailyClosesResponse: contracts.dailyClosesResponseSchema,

  // Portfolios (§6.8, §13.2 V2-P8)
  CreatePortfolioRequest: contracts.createPortfolioRequestSchema,
  UpdatePortfolioRequest: contracts.updatePortfolioRequestSchema,
  CreateTransactionsRequest: contracts.createTransactionsRequestSchema,
  UpdateTransactionRequest: contracts.updateTransactionRequestSchema,
  PortfolioListResponse: contracts.portfolioListResponseSchema,
  PortfolioMutationResponse: contracts.portfolioMutationResponseSchema,
  PortfolioResponse: contracts.portfolioResponseSchema,
  UpdatePortfolioResponse: contracts.updatePortfolioResponseSchema,
  PortfolioHistoryResponse: contracts.portfolioHistoryResponseSchema,
  TransactionListResponse: contracts.transactionListResponseSchema,
  CreateTransactionsResponse: z
    .object({ transactions: z.array(contracts.transactionSchema) })
    .strict(),
  UpdateTransactionResponse: z.object({ transaction: contracts.transactionSchema }).strict(),

  // Cash ledger (§14, #220)
  CashEntryRequest: contracts.cashEntryRequestSchema,
  CashPreviewRequest: contracts.cashPreviewRequestSchema,
  CashMovementsResponse: contracts.cashMovementsResponseSchema,
  CashMovementResponse: contracts.cashMovementResponseSchema,
  CashPreviewResponse: contracts.cashPreviewResponseSchema,

  // Custom assets (§6.9)
  CreateCustomAssetRequest: contracts.createCustomAssetRequestSchema,
  UpdateCustomAssetRequest: contracts.updateCustomAssetRequestSchema,
  PutValuePointsRequest: contracts.putValuePointsRequestSchema,
  CreateCustomAssetResponse: contracts.createCustomAssetResponseSchema,
  UpdateCustomAssetResponse: z.object({ asset: contracts.customAssetSchema }).strict(),
  ValuePointsResponse: contracts.valuePointsResponseSchema,

  // Conglomerates (§6.5, §6.7)
  CreateConglomerateRequest: contracts.createConglomerateRequestSchema,
  UpdateConglomerateRequest: contracts.updateConglomerateRequestSchema,
  ReplacePositionsRequest: contracts.replacePositionsRequestSchema,
  AllocateRequest: contracts.allocateRequestSchema,
  ConglomerateListResponse: contracts.conglomerateListResponseSchema,
  ConglomerateDetail: contracts.conglomerateDetailSchema,
  AllocateResponse: contracts.allocateResponseSchema,

  // Backtest (§6.6)
  BacktestPreviewRequest: contracts.backtestPreviewRequestSchema,
  BacktestResponse: contracts.backtestResponseSchema,

  // Social (§6.9, §13.2 V2-P9)
  CreateFriendRequestRequest: contracts.createFriendRequestRequestSchema,
  FriendRequestListResponse: contracts.friendRequestListResponseSchema,
  FriendsListResponse: contracts.friendsListResponseSchema,
  SharedWithMeResponse: contracts.sharedWithMeResponseSchema,
  SharedPortfolioDetailResponse: contracts.sharedPortfolioDetailResponseSchema,
  SharedConglomerateDetailResponse: contracts.sharedConglomerateDetailResponseSchema,
  SharedWatchlistDetailResponse: contracts.sharedWatchlistDetailResponseSchema,
  MySharedResponse: contracts.mySharedResponseSchema,

  // Notifications & settings (§6.10, §6.11, §13.2 V2-P9)
  MarkReadRequest: contracts.markReadRequestSchema,
  NotificationListResponse: contracts.notificationListResponseSchema,
  UpdateNotificationSettingsRequest: contracts.updateNotificationSettingsRequestSchema,
  NotificationSettingsResponse: contracts.notificationSettingsResponseSchema,
  AccountSettingsResponse: contracts.accountSettingsResponseSchema,
  UpdateAccountSettingsRequest: contracts.updateAccountSettingsRequestSchema,

  // Personal API keys (§6.13, V2-P12)
  CreateApiKeyRequest: contracts.createApiKeyRequestSchema,
  ApiKeyListResponse: contracts.apiKeyListResponseSchema,
  CreateApiKeyResponse: contracts.createApiKeyResponseSchema,

  // OAuth apps (§6.13, V2-P12)
  CreateOAuthClientRequest: contracts.createOAuthClientRequestSchema,
  OAuthClientListResponse: contracts.oauthClientListResponseSchema,
  CreateOAuthClientResponse: contracts.createOAuthClientResponseSchema,
  OAuthGrantListResponse: contracts.oauthGrantListResponseSchema,
  OAuthAuthorizationDetailsResponse: contracts.oauthAuthorizationDetailsResponseSchema,
  OAuthApproveRequest: contracts.oauthApproveRequestSchema,
  OAuthApproveResponse: contracts.oauthApproveResponseSchema,
  OAuthTokenRequest: contracts.oauthTokenRequestSchema,
  OAuthTokenResponse: contracts.oauthTokenResponseSchema,
};

/** Registered component refs, keyed by component name (literal keys preserved). */
const R = {} as { [K in keyof typeof componentSchemas]: z.ZodTypeAny };
for (const name of Object.keys(componentSchemas) as (keyof typeof componentSchemas)[]) {
  R[name] = registry.register(name, componentSchemas[name]);
}

// Two auth schemes reach `/api/v1`: the web/admin SPA uses the httpOnly session
// cookie; scripts/integrations use a personal API key as a bearer token.
const SESSION_SECURITY = 'sessionCookie';
registry.registerComponent('securitySchemes', SESSION_SECURITY, {
  type: 'apiKey',
  in: 'cookie',
  name: 'bt_sid',
  description:
    'httpOnly session cookie set on login (§6.1). Opaque Redis session id; not readable by JS.',
});

// Personal API key bearer auth (§6.13, V2-P12). Mint a key in Settings → API
// Access; send it as `Authorization: Bearer btk_…`. Access is gated by the
// key's coarse scopes; admin endpoints are never reachable with an API key.
const BEARER_SECURITY = 'apiKeyBearer';
registry.registerComponent('securitySchemes', BEARER_SECURITY, {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'btk_<random>',
  description:
    'Personal API key as a bearer token (§6.13). Scopes: ' +
    `${contracts.API_KEY_SCOPES.join(', ')}. Safe methods need the module's :read scope, ` +
    'mutations its :write scope. Missing scope → 403 INSUFFICIENT_SCOPE. Bearer requests ' +
    'skip CSRF (no cookies) and can never reach admin endpoints.',
});

// `userId` param is defined inline in socialRoutes (not exported from contracts).
const userIdParamSchema = z.object({ userId: z.string().uuid() }).strict();

// ── Endpoint table ──────────────────────────────────────────────────────────
type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

interface EndpointDef {
  method: Method;
  path: string;
  tag: string;
  summary: string;
  /** Public (`P`) routes need no session; everything else is session-guarded. */
  public?: boolean;
  params?: z.AnyZodObject;
  query?: z.AnyZodObject;
  body?: z.ZodTypeAny;
  status: number;
  /** Success response schema; omit for empty (204) responses. */
  response?: z.ZodTypeAny;
}

const endpoints: EndpointDef[] = [
  // Meta (§5)
  {
    method: 'get',
    path: '/health',
    tag: 'Meta',
    summary: 'Liveness probe.',
    public: true,
    status: 200,
    response: R.HealthResponse,
  },

  // Auth (§6.1)
  {
    method: 'post',
    path: '/auth/login',
    tag: 'Auth',
    summary:
      'Log in with an identifier + password; sets the session cookie, or returns a 2FA challenge when 2FA is enabled.',
    public: true,
    body: R.LoginRequest,
    status: 200,
    response: R.LoginResponse,
  },
  {
    method: 'post',
    path: '/auth/2fa/verify',
    tag: 'Auth',
    summary: 'Complete a login 2FA challenge with a TOTP/email/recovery code; sets the session.',
    public: true,
    body: R.TwoFactorVerifyRequest,
    status: 200,
    response: R.MeResponse,
  },
  {
    method: 'post',
    path: '/auth/2fa/email-code',
    tag: 'Auth',
    summary: 'Send a one-time email login code for a pending 2FA challenge.',
    public: true,
    body: R.TwoFactorEmailCodeRequest,
    status: 200,
    response: R.OkResponse,
  },
  {
    method: 'post',
    path: '/auth/logout',
    tag: 'Auth',
    summary: 'Clear the current session.',
    public: true,
    status: 200,
    response: R.OkResponse,
  },
  {
    method: 'get',
    path: '/auth/me',
    tag: 'Auth',
    summary: 'The signed-in user.',
    status: 200,
    response: R.MeResponse,
  },
  {
    method: 'get',
    path: '/auth/session',
    tag: 'Auth',
    summary: 'Read-only info about the caller’s current session.',
    status: 200,
    response: R.SessionInfoResponse,
  },
  {
    method: 'get',
    path: '/auth/sessions',
    tag: 'Auth',
    summary: 'List the caller’s active sessions (device, created, last-seen, current marker).',
    status: 200,
    response: R.SessionListResponse,
  },
  {
    method: 'delete',
    path: '/auth/sessions/{id}',
    tag: 'Auth',
    summary: 'Revoke one session by its opaque handle (“log out that device”).',
    params: contracts.sessionHandleParamSchema,
    status: 200,
    response: R.OkResponse,
  },
  {
    method: 'post',
    path: '/auth/sessions/revoke-others',
    tag: 'Auth',
    summary: 'Revoke every other session, keeping the caller signed in.',
    status: 200,
    response: R.RevokeSessionsResponse,
  },
  {
    method: 'post',
    path: '/auth/change-password',
    tag: 'Auth',
    summary: 'Change the password; rotates the session.',
    body: R.ChangePasswordRequest,
    status: 200,
    response: R.MeResponse,
  },
  {
    method: 'post',
    path: '/auth/pin/verify',
    tag: 'Auth',
    summary: 'Verify the PIN and renew the session window.',
    body: R.PinVerifyRequest,
    status: 200,
    response: R.MeResponse,
  },
  {
    method: 'put',
    path: '/auth/pin',
    tag: 'Auth',
    summary: 'Enable or change the PIN.',
    body: R.SetPinRequest,
    status: 200,
    response: R.MeResponse,
  },
  {
    method: 'delete',
    path: '/auth/pin',
    tag: 'Auth',
    summary: 'Disable the PIN.',
    status: 200,
    response: R.MeResponse,
  },
  {
    method: 'put',
    path: '/auth/pin/idle-timeout',
    tag: 'Auth',
    summary: 'Set (or clear) the AFK auto-lock idle timeout.',
    body: R.SetPinLockRequest,
    status: 200,
    response: R.MeResponse,
  },
  {
    method: 'post',
    path: '/auth/2fa/enroll',
    tag: 'Auth',
    summary: 'Begin TOTP enrollment; returns a provisional secret + otpauth URI.',
    status: 200,
    response: R.TwoFactorEnrollResponse,
  },
  {
    method: 'post',
    path: '/auth/2fa/confirm',
    tag: 'Auth',
    summary:
      'Confirm TOTP with a code; enables the authenticator method. Returns recovery codes if it is the first method enabled, else null.',
    body: R.TwoFactorConfirmRequest,
    status: 200,
    response: R.TwoFactorMethodEnabledResponse,
  },
  {
    method: 'post',
    path: '/auth/2fa/disable',
    tag: 'Auth',
    summary: 'Disable the authenticator (TOTP) method with a valid TOTP or recovery code.',
    body: R.TwoFactorDisableRequest,
    status: 200,
    response: R.OkResponse,
  },
  {
    method: 'post',
    path: '/auth/2fa/email/enroll',
    tag: 'Auth',
    summary:
      'Begin email-code 2FA enrollment; sends a mailbox-proof code. Rejected when SMTP is unconfigured.',
    status: 200,
    response: R.OkResponse,
  },
  {
    method: 'post',
    path: '/auth/2fa/email/confirm',
    tag: 'Auth',
    summary:
      'Confirm email-code 2FA with the emailed code; enables the method. Returns recovery codes if it is the first method enabled, else null.',
    body: R.TwoFactorEmailConfirmRequest,
    status: 200,
    response: R.TwoFactorMethodEnabledResponse,
  },
  {
    method: 'post',
    path: '/auth/2fa/email/disable',
    tag: 'Auth',
    summary: 'Disable the email-code 2FA method from the authenticated session.',
    status: 200,
    response: R.OkResponse,
  },
  {
    method: 'get',
    path: '/auth/2fa/status',
    tag: 'Auth',
    summary: 'The caller’s current 2FA state.',
    status: 200,
    response: R.TwoFactorStatusResponse,
  },
  {
    method: 'post',
    path: '/auth/2fa/recovery-codes',
    tag: 'Auth',
    summary: 'Regenerate the recovery codes (voids the old set).',
    status: 200,
    response: R.TwoFactorRecoveryCodesResponse,
  },
  {
    method: 'get',
    path: '/auth/invite/{token}',
    tag: 'Auth',
    summary: 'Validate an invite token.',
    public: true,
    params: contracts.tokenParamSchema,
    status: 200,
    response: R.InviteValidationResponse,
  },
  {
    method: 'post',
    path: '/auth/register',
    tag: 'Auth',
    summary: 'Public self-serve registration (rejected in closed mode).',
    public: true,
    body: R.RegisterRequest,
    status: 201,
    response: R.MeResponse,
  },
  {
    method: 'post',
    path: '/auth/password-reset/request',
    tag: 'Auth',
    summary: 'Request a self-service password-reset email (generic response).',
    public: true,
    body: R.PasswordResetRequest,
    status: 200,
    response: R.OkResponse,
  },
  {
    method: 'post',
    path: '/auth/password-reset/complete',
    tag: 'Auth',
    summary:
      'Complete a password reset with the emailed token; signs the user in, or returns a 2FA challenge when 2FA is enabled.',
    public: true,
    body: R.PasswordResetComplete,
    status: 200,
    response: R.LoginResponse,
  },
  {
    method: 'post',
    path: '/auth/accept-invite',
    tag: 'Auth',
    summary: 'Accept an invite and create the account.',
    public: true,
    body: R.AcceptInviteRequest,
    status: 201,
    response: R.MeResponse,
  },

  // Admin (§6.12)
  {
    method: 'get',
    path: '/admin/users',
    tag: 'Admin',
    summary: 'List users (optional search).',
    query: contracts.adminUserListQuerySchema,
    status: 200,
    response: R.AdminUserListResponse,
  },
  {
    method: 'post',
    path: '/admin/users',
    tag: 'Admin',
    summary: 'Create a user; returns a temp password.',
    body: R.CreateUserRequest,
    status: 201,
    response: R.CreateUserResponse,
  },
  {
    method: 'post',
    path: '/admin/users/bulk',
    tag: 'Admin',
    summary: 'Bulk user action (V1: disable) over a set of ids.',
    body: R.BulkUserActionRequest,
    status: 200,
    response: R.BulkUserActionResponse,
  },
  {
    method: 'patch',
    path: '/admin/users/{id}',
    tag: 'Admin',
    summary: 'Update a user.',
    params: contracts.idParamSchema,
    body: R.UpdateUserRequest,
    status: 200,
    response: R.AdminUser,
  },
  {
    method: 'post',
    path: '/admin/users/{id}/reset-password',
    tag: 'Admin',
    summary: 'Reset a user’s password to a temp password.',
    params: contracts.idParamSchema,
    status: 200,
    response: R.ResetPasswordResponse,
  },
  {
    method: 'delete',
    path: '/admin/users/{id}',
    tag: 'Admin',
    summary: 'Delete a user (confirm by username).',
    params: contracts.idParamSchema,
    body: R.DeleteUserRequest,
    status: 200,
    response: R.OkResponse,
  },
  {
    method: 'get',
    path: '/admin/invites',
    tag: 'Admin',
    summary: 'List invites.',
    status: 200,
    response: R.AdminInviteListResponse,
  },
  {
    method: 'post',
    path: '/admin/invites',
    tag: 'Admin',
    summary: 'Create an invite; returns its URL.',
    body: R.CreateInviteRequest,
    status: 201,
    response: R.CreateInviteResponse,
  },
  {
    method: 'post',
    path: '/admin/invites/{id}/revoke',
    tag: 'Admin',
    summary: 'Revoke an invite.',
    params: contracts.idParamSchema,
    status: 200,
    response: R.OkResponse,
  },
  {
    method: 'get',
    path: '/admin/oauth-clients',
    tag: 'Admin',
    summary: 'List first-party (official) OAuth apps.',
    status: 200,
    response: R.OAuthClientListResponse,
  },
  {
    method: 'post',
    path: '/admin/oauth-clients',
    tag: 'Admin',
    summary: 'Register a first-party OAuth app; returns the client id (and secret once).',
    body: R.CreateOAuthClientRequest,
    status: 201,
    response: R.CreateOAuthClientResponse,
  },
  {
    method: 'delete',
    path: '/admin/oauth-clients/{id}',
    tag: 'Admin',
    summary: 'Delete a first-party OAuth app.',
    params: contracts.idParamSchema,
    status: 200,
    response: R.OkResponse,
  },
  {
    method: 'get',
    path: '/admin/stats',
    tag: 'Admin',
    summary: 'Overview counters.',
    status: 200,
    response: R.AdminStats,
  },
  {
    method: 'get',
    path: '/admin/settings',
    tag: 'Admin',
    summary: 'Global app settings (registration mode + beta toggle).',
    status: 200,
    response: R.AppSettingsResponse,
  },
  {
    method: 'patch',
    path: '/admin/settings',
    tag: 'Admin',
    summary: 'Update global app settings (audit-logged).',
    body: R.UpdateAppSettingsRequest,
    status: 200,
    response: R.AppSettingsResponse,
  },
  {
    method: 'get',
    path: '/admin/email/status',
    tag: 'Admin',
    summary: 'SMTP transport status.',
    status: 200,
    response: R.EmailStatusResponse,
  },
  {
    method: 'post',
    path: '/admin/test-email',
    tag: 'Admin',
    summary: 'Send a test email.',
    body: R.TestEmailRequest,
    status: 200,
    response: R.TestEmailResponse,
  },
  {
    method: 'get',
    path: '/admin/audit',
    tag: 'Admin',
    summary: 'Cursor-paged audit log.',
    query: contracts.auditQuerySchema,
    status: 200,
    response: R.AuditLogListResponse,
  },
  {
    method: 'get',
    path: '/admin/emails',
    tag: 'Admin',
    summary: 'Cursor-paged global email send log.',
    query: contracts.emailLogQuerySchema,
    status: 200,
    response: R.EmailLogListResponse,
  },
  {
    method: 'get',
    path: '/admin/users/{id}/emails',
    tag: 'Admin',
    summary: 'Cursor-paged email send log for one user.',
    params: contracts.idParamSchema,
    query: contracts.emailLogQuerySchema,
    status: 200,
    response: R.EmailLogListResponse,
  },
  {
    method: 'get',
    path: '/admin/users/{id}/audit',
    tag: 'Admin',
    summary: 'Cursor-paged audit history for one user.',
    params: contracts.idParamSchema,
    query: contracts.auditQuerySchema,
    status: 200,
    response: R.AuditLogListResponse,
  },

  // Workboard (§6.4)
  {
    method: 'get',
    path: '/workboard',
    tag: 'Workboard',
    summary: 'The caller’s watchlist.',
    status: 200,
    response: R.WorkboardListResponse,
  },
  {
    method: 'post',
    path: '/workboard',
    tag: 'Workboard',
    summary: 'Add an asset to the watchlist.',
    body: R.AddToWorkboardRequest,
    status: 201,
    response: R.WorkboardItem,
  },
  {
    method: 'delete',
    path: '/workboard/{itemId}',
    tag: 'Workboard',
    summary: 'Remove a watchlist item.',
    params: contracts.itemIdParamSchema,
    status: 204,
  },
  {
    method: 'patch',
    path: '/workboard/reorder',
    tag: 'Workboard',
    summary: 'Reorder the watchlist.',
    body: R.ReorderWorkboardRequest,
    status: 200,
    response: R.OkResponse,
  },
  {
    method: 'get',
    path: '/workboard/sharing',
    tag: 'Workboard',
    summary: 'The caller’s watchlist friend-sharing state.',
    status: 200,
    response: R.WatchlistSharingResponse,
  },
  {
    method: 'patch',
    path: '/workboard/sharing',
    tag: 'Workboard',
    summary: 'Turn watchlist friend-sharing on/off.',
    body: R.UpdateWatchlistSharingRequest,
    status: 200,
    response: R.WatchlistSharingResponse,
  },

  // Search (§6.2)
  {
    method: 'get',
    path: '/search',
    tag: 'Search',
    summary: 'Local-first asset search merged with the caller’s custom assets.',
    query: contracts.searchQuerySchema,
    status: 200,
    response: R.SearchResponse,
  },

  // Assets (§6.3)
  {
    method: 'get',
    path: '/assets/{id}',
    tag: 'Assets',
    summary: 'Asset meta + latest quote.',
    params: contracts.assetIdParamSchema,
    status: 200,
    response: R.AssetDetailResponse,
  },
  {
    method: 'get',
    path: '/assets/{id}/quote',
    tag: 'Assets',
    summary: 'Latest quote with stale/asOf markers.',
    params: contracts.assetIdParamSchema,
    status: 200,
    response: R.QuoteResponse,
  },
  {
    method: 'get',
    path: '/assets/{id}/history',
    tag: 'Assets',
    summary: 'Price series for a range.',
    params: contracts.assetIdParamSchema,
    query: contracts.historyQuerySchema,
    status: 200,
    response: R.HistoryResponse,
  },
  {
    method: 'get',
    path: '/assets/{id}/daily-closes',
    tag: 'Assets',
    summary: 'Full daily close series for the linked transaction date ↔ price fields.',
    params: contracts.assetIdParamSchema,
    status: 200,
    response: R.DailyClosesResponse,
  },

  // Portfolios (§6.8)
  {
    method: 'get',
    path: '/portfolios',
    tag: 'Portfolios',
    summary: 'The caller’s portfolios (archived included only when asked).',
    query: contracts.portfolioListQuerySchema,
    status: 200,
    response: R.PortfolioListResponse,
  },
  {
    method: 'post',
    path: '/portfolios',
    tag: 'Portfolios',
    summary: 'Create a named portfolio.',
    body: R.CreatePortfolioRequest,
    status: 201,
    response: R.PortfolioMutationResponse,
  },
  {
    method: 'post',
    path: '/portfolios/{portfolioId}/archive',
    tag: 'Portfolios',
    summary: 'Soft-archive a portfolio (rejects the last active one).',
    params: contracts.portfolioIdParamSchema,
    status: 200,
    response: R.PortfolioMutationResponse,
  },
  {
    method: 'post',
    path: '/portfolios/{portfolioId}/restore',
    tag: 'Portfolios',
    summary: 'Restore an archived portfolio.',
    params: contracts.portfolioIdParamSchema,
    status: 200,
    response: R.PortfolioMutationResponse,
  },
  {
    method: 'get',
    path: '/portfolios/{portfolioId}',
    tag: 'Portfolios',
    summary: 'Holdings + totals for a portfolio.',
    params: contracts.portfolioIdParamSchema,
    status: 200,
    response: R.PortfolioResponse,
  },
  {
    method: 'patch',
    path: '/portfolios/{portfolioId}',
    tag: 'Portfolios',
    summary: 'Rename and/or change visibility.',
    params: contracts.portfolioIdParamSchema,
    body: R.UpdatePortfolioRequest,
    status: 200,
    response: R.UpdatePortfolioResponse,
  },
  {
    method: 'get',
    path: '/portfolios/{portfolioId}/history',
    tag: 'Portfolios',
    summary: 'Value-over-time series (optional per-asset overlay).',
    params: contracts.portfolioIdParamSchema,
    query: contracts.portfolioHistoryQuerySchema,
    status: 200,
    response: R.PortfolioHistoryResponse,
  },
  {
    method: 'get',
    path: '/portfolios/{portfolioId}/cash',
    tag: 'Portfolios',
    summary: 'Cash movements + current balance.',
    params: contracts.portfolioIdParamSchema,
    status: 200,
    response: R.CashMovementsResponse,
  },
  {
    method: 'post',
    path: '/portfolios/{portfolioId}/cash/deposit',
    tag: 'Portfolios',
    summary: 'Record an external cash deposit.',
    params: contracts.portfolioIdParamSchema,
    body: R.CashEntryRequest,
    status: 201,
    response: R.CashMovementResponse,
  },
  {
    method: 'post',
    path: '/portfolios/{portfolioId}/cash/withdraw',
    tag: 'Portfolios',
    summary: 'Record a cash withdrawal (rejects an overdraw).',
    params: contracts.portfolioIdParamSchema,
    body: R.CashEntryRequest,
    status: 201,
    response: R.CashMovementResponse,
  },
  {
    method: 'post',
    path: '/portfolios/{portfolioId}/cash/preview',
    tag: 'Portfolios',
    summary: 'Preview the balance after a proposed cash movement.',
    params: contracts.portfolioIdParamSchema,
    body: R.CashPreviewRequest,
    status: 200,
    response: R.CashPreviewResponse,
  },
  {
    method: 'get',
    path: '/portfolios/{portfolioId}/transactions',
    tag: 'Portfolios',
    summary: 'Cursor-paged transaction ledger.',
    params: contracts.portfolioIdParamSchema,
    query: contracts.transactionListQuerySchema,
    status: 200,
    response: R.TransactionListResponse,
  },
  {
    method: 'post',
    path: '/portfolios/{portfolioId}/transactions',
    tag: 'Portfolios',
    summary: 'Record one or many transactions.',
    params: contracts.portfolioIdParamSchema,
    body: R.CreateTransactionsRequest,
    status: 201,
    response: R.CreateTransactionsResponse,
  },
  {
    method: 'patch',
    path: '/portfolios/{portfolioId}/transactions/{txId}',
    tag: 'Portfolios',
    summary: 'Edit a transaction (re-validates oversell).',
    params: contracts.portfolioTransactionParamsSchema,
    body: R.UpdateTransactionRequest,
    status: 200,
    response: R.UpdateTransactionResponse,
  },
  {
    method: 'delete',
    path: '/portfolios/{portfolioId}/transactions/{txId}',
    tag: 'Portfolios',
    summary: 'Delete a transaction (re-validates oversell).',
    params: contracts.portfolioTransactionParamsSchema,
    status: 204,
  },

  // Custom assets (§6.9)
  {
    method: 'post',
    path: '/custom-assets',
    tag: 'Custom Assets',
    summary: 'Create a custom asset (optional initial buy).',
    body: R.CreateCustomAssetRequest,
    status: 201,
    response: R.CreateCustomAssetResponse,
  },
  {
    method: 'patch',
    path: '/custom-assets/{id}',
    tag: 'Custom Assets',
    summary: 'Edit name/category (currency is immutable).',
    params: contracts.customAssetIdParamSchema,
    body: R.UpdateCustomAssetRequest,
    status: 200,
    response: R.UpdateCustomAssetResponse,
  },
  {
    method: 'delete',
    path: '/custom-assets/{id}',
    tag: 'Custom Assets',
    summary: 'Delete a custom asset (cascades).',
    params: contracts.customAssetIdParamSchema,
    status: 204,
  },
  {
    method: 'get',
    path: '/custom-assets/{id}/value-points',
    tag: 'Custom Assets',
    summary: 'List value points (ascending by date).',
    params: contracts.customAssetIdParamSchema,
    status: 200,
    response: R.ValuePointsResponse,
  },
  {
    method: 'put',
    path: '/custom-assets/{id}/value-points',
    tag: 'Custom Assets',
    summary: 'Full-replace value points.',
    params: contracts.customAssetIdParamSchema,
    body: R.PutValuePointsRequest,
    status: 200,
    response: R.ValuePointsResponse,
  },

  // Conglomerates (§6.5, §6.7)
  {
    method: 'get',
    path: '/conglomerates',
    tag: 'Conglomerates',
    summary: 'The caller’s Conglomerates.',
    status: 200,
    response: R.ConglomerateListResponse,
  },
  {
    method: 'post',
    path: '/conglomerates',
    tag: 'Conglomerates',
    summary: 'Create a new draft basket.',
    body: R.CreateConglomerateRequest,
    status: 201,
    response: R.ConglomerateDetail,
  },
  {
    method: 'get',
    path: '/conglomerates/{conglomerateId}',
    tag: 'Conglomerates',
    summary: 'Detail with positions + embedded asset identity.',
    params: contracts.conglomerateIdParamSchema,
    status: 200,
    response: R.ConglomerateDetail,
  },
  {
    method: 'patch',
    path: '/conglomerates/{conglomerateId}',
    tag: 'Conglomerates',
    summary: 'Rename / edit description.',
    params: contracts.conglomerateIdParamSchema,
    body: R.UpdateConglomerateRequest,
    status: 200,
    response: R.ConglomerateDetail,
  },
  {
    method: 'delete',
    path: '/conglomerates/{conglomerateId}',
    tag: 'Conglomerates',
    summary: 'Delete a Conglomerate (cascades positions).',
    params: contracts.conglomerateIdParamSchema,
    status: 204,
  },
  {
    method: 'put',
    path: '/conglomerates/{conglomerateId}/positions',
    tag: 'Conglomerates',
    summary: 'Bulk-replace positions (Builder autosave).',
    params: contracts.conglomerateIdParamSchema,
    body: R.ReplacePositionsRequest,
    status: 200,
    response: R.ConglomerateDetail,
  },
  {
    method: 'post',
    path: '/conglomerates/{conglomerateId}/activate',
    tag: 'Conglomerates',
    summary: 'Activate a draft when weights sum to 100.',
    params: contracts.conglomerateIdParamSchema,
    status: 200,
    response: R.ConglomerateDetail,
  },
  {
    method: 'post',
    path: '/conglomerates/{conglomerateId}/allocate',
    tag: 'Conglomerates',
    summary: 'Invest Calculator: budget → never-overshoot buy list.',
    params: contracts.conglomerateIdParamSchema,
    body: R.AllocateRequest,
    status: 200,
    response: R.AllocateResponse,
  },

  // Backtest (§6.6)
  {
    method: 'post',
    path: '/backtest/preview',
    tag: 'Backtest',
    summary: 'Backtest an unsaved draft basket over inline positions.',
    body: R.BacktestPreviewRequest,
    status: 200,
    response: R.BacktestResponse,
  },

  // Social (§6.9)
  {
    method: 'post',
    path: '/social/requests',
    tag: 'Social',
    summary: 'Request a friend by username or email (no enumeration).',
    body: R.CreateFriendRequestRequest,
    status: 202,
    response: R.OkResponse,
  },
  {
    method: 'get',
    path: '/social/requests',
    tag: 'Social',
    summary: 'Pending incoming + outgoing friend requests.',
    status: 200,
    response: R.FriendRequestListResponse,
  },
  {
    method: 'post',
    path: '/social/requests/{id}/accept',
    tag: 'Social',
    summary: 'Accept a friend request.',
    params: contracts.idParamSchema,
    status: 200,
    response: R.OkResponse,
  },
  {
    method: 'post',
    path: '/social/requests/{id}/decline',
    tag: 'Social',
    summary: 'Decline a friend request.',
    params: contracts.idParamSchema,
    status: 200,
    response: R.OkResponse,
  },
  {
    method: 'post',
    path: '/social/requests/{id}/cancel',
    tag: 'Social',
    summary: 'Cancel an outgoing friend request.',
    params: contracts.idParamSchema,
    status: 200,
    response: R.OkResponse,
  },
  {
    method: 'get',
    path: '/social/friends',
    tag: 'Social',
    summary: 'The caller’s friends.',
    status: 200,
    response: R.FriendsListResponse,
  },
  {
    method: 'delete',
    path: '/social/friends/{userId}',
    tag: 'Social',
    summary: 'Remove a friendship.',
    params: userIdParamSchema,
    status: 204,
  },
  {
    method: 'get',
    path: '/social/shared',
    tag: 'Social',
    summary: 'Everything my friends share with me — portfolios, conglomerates, watchlists.',
    status: 200,
    response: R.SharedWithMeResponse,
  },
  {
    method: 'get',
    path: '/social/shared/conglomerates/{conglomerateId}',
    tag: 'Social',
    summary: 'Read-only view of a friend-shared conglomerate.',
    params: contracts.conglomerateIdParamSchema,
    status: 200,
    response: R.SharedConglomerateDetailResponse,
  },
  {
    method: 'get',
    path: '/social/shared/watchlists/{userId}',
    tag: 'Social',
    summary: 'Read-only view of a friend’s shared watchlist.',
    params: userIdParamSchema,
    status: 200,
    response: R.SharedWatchlistDetailResponse,
  },
  {
    method: 'get',
    path: '/social/shared/{portfolioId}',
    tag: 'Social',
    summary: 'Read-only overview of a friend-shared portfolio.',
    params: contracts.portfolioIdParamSchema,
    status: 200,
    response: R.SharedPortfolioDetailResponse,
  },
  {
    method: 'get',
    path: '/social/my-shared',
    tag: 'Social',
    summary: 'Everything I currently share with friends — portfolios, conglomerates, watchlist.',
    status: 200,
    response: R.MySharedResponse,
  },

  // Notifications (§6.10)
  {
    method: 'get',
    path: '/notifications',
    tag: 'Notifications',
    summary: 'Newest-first notifications with unread count.',
    query: contracts.notificationListQuerySchema,
    status: 200,
    response: R.NotificationListResponse,
  },
  {
    method: 'post',
    path: '/notifications/mark-read',
    tag: 'Notifications',
    summary: 'Mark notifications read (by id or all).',
    body: R.MarkReadRequest,
    status: 200,
    response: R.OkResponse,
  },

  // Settings (§6.10, §6.11)
  {
    method: 'get',
    path: '/settings/notifications',
    tag: 'Settings',
    summary: 'The caller’s per-channel notification settings.',
    status: 200,
    response: R.NotificationSettingsResponse,
  },
  {
    method: 'patch',
    path: '/settings/notifications',
    tag: 'Settings',
    summary: 'Update notification channel toggles.',
    body: R.UpdateNotificationSettingsRequest,
    status: 200,
    response: R.NotificationSettingsResponse,
  },
  {
    method: 'get',
    path: '/settings/account',
    tag: 'Settings',
    summary: 'The caller’s account defaults (default portfolio visibility).',
    status: 200,
    response: R.AccountSettingsResponse,
  },
  {
    method: 'patch',
    path: '/settings/account',
    tag: 'Settings',
    summary: 'Update the default portfolio visibility.',
    body: R.UpdateAccountSettingsRequest,
    status: 200,
    response: R.AccountSettingsResponse,
  },

  // Personal API keys (§6.13, V2-P12) — session-only (never reachable by a key).
  {
    method: 'get',
    path: '/settings/api-keys',
    tag: 'Settings',
    summary: 'List the caller’s active personal API keys.',
    status: 200,
    response: R.ApiKeyListResponse,
  },
  {
    method: 'post',
    path: '/settings/api-keys',
    tag: 'Settings',
    summary: 'Mint a personal API key; the plaintext token is returned exactly once.',
    body: R.CreateApiKeyRequest,
    status: 201,
    response: R.CreateApiKeyResponse,
  },
  {
    method: 'delete',
    path: '/settings/api-keys/{id}',
    tag: 'Settings',
    summary: 'Revoke a personal API key the caller owns.',
    params: contracts.idParamSchema,
    status: 204,
  },

  // OAuth apps + grants (§6.13, V2-P12) — session-only management surface.
  {
    method: 'get',
    path: '/settings/oauth-clients',
    tag: 'Settings',
    summary: 'List the caller’s registered OAuth apps.',
    status: 200,
    response: R.OAuthClientListResponse,
  },
  {
    method: 'post',
    path: '/settings/oauth-clients',
    tag: 'Settings',
    summary:
      'Register an OAuth app; the client_secret is returned exactly once (null for public clients).',
    body: R.CreateOAuthClientRequest,
    status: 201,
    response: R.CreateOAuthClientResponse,
  },
  {
    method: 'delete',
    path: '/settings/oauth-clients/{id}',
    tag: 'Settings',
    summary: 'Delete an OAuth app (cascades its grants and tokens).',
    params: contracts.idParamSchema,
    status: 204,
  },
  {
    method: 'get',
    path: '/settings/oauth-grants',
    tag: 'Settings',
    summary: 'List the apps the caller has authorized (active grants).',
    status: 200,
    response: R.OAuthGrantListResponse,
  },
  {
    method: 'delete',
    path: '/settings/oauth-grants/{id}',
    tag: 'Settings',
    summary: 'Revoke an authorized app; kills its access + refresh tokens instantly.',
    params: contracts.idParamSchema,
    status: 204,
  },

  // OAuth 2.0 flow (§6.13, V2-P12).
  {
    method: 'get',
    path: '/oauth/authorization-details',
    tag: 'OAuth',
    summary: 'Consent-screen data for an authorize request (app + plain-language scopes).',
    query: contracts.oauthAuthorizationDetailsQuerySchema,
    status: 200,
    response: R.OAuthAuthorizationDetailsResponse,
  },
  {
    method: 'post',
    path: '/oauth/authorize',
    tag: 'OAuth',
    summary:
      'Approve consent: mint a single-use authorization code and return the redirect target.',
    body: R.OAuthApproveRequest,
    status: 200,
    response: R.OAuthApproveResponse,
  },
  {
    method: 'post',
    path: '/oauth/token',
    tag: 'OAuth',
    summary:
      'Public token endpoint: exchange an authorization code (+ PKCE / client secret) or rotate a refresh token.',
    public: true,
    body: R.OAuthTokenRequest,
    status: 200,
    response: R.OAuthTokenResponse,
  },
];

const jsonContent = (schema: z.ZodTypeAny) => ({ 'application/json': { schema } });
const errorResponse = (description: string) => ({
  description,
  content: jsonContent(R.ApiError),
});

for (const ep of endpoints) {
  const responses: Record<string, ResponseConfig> = {};
  responses[ep.status] = ep.response
    ? { description: 'Success.', content: jsonContent(ep.response) }
    : { description: 'No content.' };
  if (ep.body || ep.query || ep.params) {
    responses['400'] = errorResponse('Invalid request (VALIDATION_ERROR).');
  }
  if (!ep.public) {
    responses['401'] = errorResponse('Authentication required.');
  }
  // Shared error envelope `{ error: { code, message, details? } }` (§8).
  responses['default'] = errorResponse('Error envelope.');

  registry.registerPath({
    method: ep.method,
    path: ep.path,
    tags: [ep.tag],
    summary: ep.summary,
    security: ep.public ? [] : [{ [SESSION_SECURITY]: [] }],
    request: {
      ...(ep.params ? { params: ep.params } : {}),
      ...(ep.query ? { query: ep.query } : {}),
      ...(ep.body ? { body: { required: true, content: jsonContent(ep.body) } } : {}),
    },
    responses,
  });
}

/** The number of `/api/v1` operations documented — handy for coverage checks. */
export const OPENAPI_ENDPOINT_COUNT = endpoints.length;

/**
 * "Integrate with BetterTrack" — the human-readable OAuth quickstart carried on
 * `/docs` alongside the endpoint reference (§6.13, V2-P12, owner requirement).
 * Rendered as markdown by Scalar from the OpenAPI `info.description`, so an
 * external developer can wire up delegated access from the docs alone. Walks the
 * five steps (register → authorize → exchange → call → refresh/revoke) with a
 * copy-pasteable example at each, then the simpler personal-token alternative.
 */
export const INTEGRATION_GUIDE = [
  '## Integrate with BetterTrack',
  '',
  'Third-party apps get delegated, scoped, **revocable** access to a user’s',
  'BetterTrack workspace via OAuth 2.0 (authorization code + PKCE) — the user',
  'never hands your app their password or a personal key. Access tokens are',
  'bearer tokens gated by coarse scopes: `' + contracts.API_KEY_SCOPES.join('`, `') + '`.',
  '',
  '### 1. Register your app',
  '',
  'In BetterTrack, open **Settings → API Access → OAuth apps** and register your',
  'app with its name, one or more exact **redirect URIs** (https, http-loopback,',
  'or a custom-scheme deep link like `myapp://callback` for mobile), and the',
  'scopes it needs. You receive a `client_id` (`btc_…`) and, for confidential',
  '(server-side) apps, a `client_secret` (`bts_…`) **shown once**. Native/mobile',
  'and SPA apps register as **public** clients — no secret, PKCE required.',
  '',
  '### 2. Send the user to the authorize URL',
  '',
  'Generate a PKCE `code_verifier` (43–128 chars) and its',
  '`code_challenge = base64url(sha256(verifier))`, a random `state`, then open',
  'the consent screen on the BetterTrack **web origin**:',
  '',
  '```',
  'https://app.bettertrack.example/oauth/authorize' +
    '?response_type=code&client_id=btc_XXXX' +
    '&redirect_uri=myapp%3A%2F%2Fcallback&scope=portfolio%3Aread%20workboard%3Aread' +
    '&state=RANDOM&code_challenge=CHALLENGE&code_challenge_method=S256',
  '```',
  '',
  'An unauthenticated user is taken through the normal BetterTrack sign-in first,',
  'then lands directly on the consent screen with your request intact. On approve',
  'the browser is redirected to your `redirect_uri` with `?code=…&state=…`.',
  '(Always check the returned `state` matches the one you sent.)',
  '',
  '### 3. Exchange the code for tokens',
  '',
  'From your backend (or app), POST the code to the token endpoint. Confidential',
  'clients send `client_secret`; public clients send the PKCE `code_verifier`:',
  '',
  '```bash',
  'curl -X POST https://api.bettertrack.example/api/v1/oauth/token \\',
  '  -H "Content-Type: application/json" \\',
  '  -d \'{"grant_type":"authorization_code","code":"bta_…",' +
    '"redirect_uri":"myapp://callback","client_id":"btc_XXXX",' +
    '"code_verifier":"THE_VERIFIER"}\'',
  '```',
  '',
  'Response (`Cache-Control: no-store`):',
  '',
  '```json',
  '{"access_token":"bto_…","token_type":"Bearer","expires_in":3600,' +
    '"refresh_token":"btr_…","scope":"portfolio:read workboard:read"}',
  '```',
  '',
  'The authorization code is **single-use** and expires in ~60s.',
  '',
  '### 4. Call the API with the bearer token',
  '',
  '```bash',
  'curl https://api.bettertrack.example/api/v1/portfolios \\',
  '  -H "Authorization: Bearer bto_…"',
  '```',
  '',
  'A call outside the granted scopes returns `403 INSUFFICIENT_SCOPE`. OAuth',
  'tokens can never reach admin endpoints.',
  '',
  '### 5. Refresh and revoke',
  '',
  'Access tokens are short-lived. Rotate them with the refresh token — each',
  'refresh returns a **new** refresh token and invalidates the old one:',
  '',
  '```bash',
  'curl -X POST https://api.bettertrack.example/api/v1/oauth/token \\',
  '  -H "Content-Type: application/json" \\',
  '  -d \'{"grant_type":"refresh_token","refresh_token":"btr_…",' + '"client_id":"btc_XXXX"}\'',
  '```',
  '',
  'The user can revoke your app at any time under **Settings → API Access →',
  'Authorized apps**; that **immediately** invalidates its access and refresh',
  'tokens (the next call gets `401`).',
  '',
  '### Just scripting something? Use a personal token',
  '',
  'If you only need to automate **your own** account, skip OAuth entirely: mint a',
  'scoped **personal API key** under **Settings → API Access** and send it as',
  '`Authorization: Bearer btk_…`. Same scopes, same endpoints — no authorize flow.',
].join('\n');

/**
 * Builds the OpenAPI 3.0 document from the registered contract schemas + paths.
 * Cached at module scope by {@link getOpenApiDocument}.
 */
export function buildOpenApiDocument() {
  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: '3.0.3',
    info: {
      title: 'BetterTrack API',
      version: API_VERSION,
      description:
        'BetterTrack HTTP API. Base path `/api/v1`, JSON, camelCase. Errors use the ' +
        'envelope `{ error: { code, message, details? } }`. Routes require either a ' +
        'session cookie or a bearer token — a personal API key or a delegated OAuth ' +
        'access token (§6.13) — unless marked public.\n\n' +
        INTEGRATION_GUIDE,
    },
    servers: [{ url: '/api/v1', description: 'BetterTrack API v1 (relative to the API origin).' }],
    // Either scheme authenticates a request; API-key scopes further gate access.
    security: [{ [SESSION_SECURITY]: [] }, { [BEARER_SECURITY]: [] }],
  });
}

let cached: ReturnType<typeof buildOpenApiDocument> | null = null;

/** The generated document, built once and reused. */
export function getOpenApiDocument() {
  cached ??= buildOpenApiDocument();
  return cached;
}
