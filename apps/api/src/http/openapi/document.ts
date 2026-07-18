import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
  extendZodWithOpenApi,
  type ResponseConfig,
} from '@asteasolutions/zod-to-openapi';
import * as contracts from '@bettertrack/contracts';
import { z } from 'zod';

import { API_VERSION } from '../../version';
import { pathAcceptsBearer } from '../middleware/bearerAuth';

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
  VersionResponse: contracts.versionResponseSchema,

  // Auth (§6.1)
  LoginRequest: contracts.loginRequestSchema,
  RegisterRequest: contracts.registerRequestSchema,
  AcceptInviteRequest: contracts.acceptInviteRequestSchema,
  GoogleLinkStatusResponse: contracts.googleLinkStatusResponseSchema,
  GoogleUnlinkRequest: contracts.googleUnlinkRequestSchema,
  GoogleRegisterTicketResponse: contracts.googleRegisterTicketResponseSchema,
  GoogleRegisterRequest: contracts.googleRegisterRequestSchema,
  ChangePasswordRequest: contracts.changePasswordRequestSchema,
  DeleteAccountRequest: contracts.deleteAccountRequestSchema,
  PasswordResetRequest: contracts.passwordResetRequestSchema,
  PasswordResetComplete: contracts.passwordResetCompleteSchema,
  PinVerifyRequest: contracts.pinVerifyRequestSchema,
  PinStatusResponse: contracts.pinStatusResponseSchema,
  PinQuickAuthRequest: contracts.pinQuickAuthRequestSchema,
  PinQuickAuthResponse: contracts.pinQuickAuthResponseSchema,
  RememberedDeviceResponse: contracts.rememberedDeviceResponseSchema,
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
  AdminTwoFactorStatusResponse: contracts.adminTwoFactorStatusResponseSchema,
  AdminTwoFactorEmailStartRequest: contracts.adminTwoFactorEmailStartRequestSchema,
  CreateUserRequest: contracts.createUserRequestSchema,
  UpdateUserRequest: contracts.updateUserRequestSchema,
  BulkUserActionRequest: contracts.bulkUserActionRequestSchema,
  BulkUserActionResponse: contracts.bulkUserActionResponseSchema,
  DeleteUserRequest: contracts.deleteUserRequestSchema,
  CreateInviteRequest: contracts.createInviteRequestSchema,
  TestEmailRequest: contracts.testEmailRequestSchema,
  UpdateAppSettingsRequest: contracts.updateAppSettingsRequestSchema,
  AccountDefaultsResponse: contracts.accountDefaultsResponseSchema,
  UpdateAccountDefaultsRequest: contracts.updateAccountDefaultsRequestSchema,
  AdminUser: contracts.adminUserSchema,
  AdminUserListResponse: contracts.adminUserListResponseSchema,
  CreateUserResponse: contracts.createUserResponseSchema,
  ResetPasswordResponse: contracts.resetPasswordResponseSchema,
  AdminInviteListResponse: contracts.adminInviteListResponseSchema,
  CreateInviteResponse: contracts.createInviteResponseSchema,
  AdminStats: contracts.adminStatsSchema,
  AdminHealthResponse: contracts.adminHealthResponseSchema,
  AppSettingsResponse: contracts.appSettingsResponseSchema,
  // Registration modes (§6.12, §13.4 V4-P4a)
  PublicRegistrationInfoResponse: contracts.publicRegistrationInfoResponseSchema,
  CreateRegistrationTokenRequest: contracts.createRegistrationTokenRequestSchema,
  CreateRegistrationTokenResponse: contracts.createRegistrationTokenResponseSchema,
  RegistrationTokenListResponse: contracts.registrationTokenListResponseSchema,
  RegistrationRequestListResponse: contracts.registrationRequestListResponseSchema,
  EmailStatusResponse: contracts.emailStatusResponseSchema,
  TestEmailResponse: contracts.testEmailResponseSchema,
  AuditLogListResponse: contracts.auditLogListResponseSchema,
  EmailLogListResponse: contracts.emailLogListResponseSchema,
  // Admin Problems page (§13.5 V5-P2 arc (d), the Sentry replacement)
  Problem: contracts.problemSchema,
  ProblemListResponse: contracts.problemListResponseSchema,
  // Admin usage analytics (§13.5 V5-P2 arc (b), first-party only)
  UsageAnalyticsResponse: contracts.usageAnalyticsResponseSchema,

  // Workboard (§6.4, §13.2 V2-P9)
  AddToWorkboardRequest: contracts.addToWorkboardRequestSchema,
  ReorderWorkboardRequest: contracts.reorderWorkboardRequestSchema,
  WorkboardItem: contracts.workboardItemSchema,
  WorkboardListResponse: contracts.workboardListResponseSchema,
  WatchlistSharingResponse: contracts.watchlistSharingResponseSchema,
  UpdateWatchlistSharingRequest: contracts.updateWatchlistSharingRequestSchema,
  WatchlistSummary: contracts.watchlistSummarySchema,
  WatchlistListResponse: contracts.watchlistListResponseSchema,
  CreateWatchlistRequest: contracts.createWatchlistRequestSchema,
  UpdateWatchlistRequest: contracts.updateWatchlistRequestSchema,

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

  // Cash ledger (§14, #220; cash sources V3-P3)
  CashEntryRequest: contracts.cashEntryRequestSchema,
  CashPreviewRequest: contracts.cashPreviewRequestSchema,
  CashMovementsResponse: contracts.cashMovementsResponseSchema,
  CashMovementResponse: contracts.cashMovementResponseSchema,
  CashPreviewResponse: contracts.cashPreviewResponseSchema,
  CreateCashSourceRequest: contracts.createCashSourceRequestSchema,
  UpdateCashSourceRequest: contracts.updateCashSourceRequestSchema,
  CashSourceListResponse: contracts.cashSourceListResponseSchema,
  CashSourceResponse: contracts.cashSourceResponseSchema,
  CashTransferRequest: contracts.cashTransferRequestSchema,
  CashTransferResponse: contracts.cashTransferResponseSchema,
  SetCashBalanceRequest: contracts.setCashBalanceRequestSchema,
  SetCashBalanceResponse: contracts.setCashBalanceResponseSchema,

  // Taxes & dividends (V3-P4, §13.3)
  TaxSettingsResponse: contracts.taxSettingsResponseSchema,
  UpdateTaxSettingsRequest: contracts.updateTaxSettingsRequestSchema,
  CreateDividendRequest: contracts.createDividendRequestSchema,
  CreateDividendResponse: contracts.createDividendResponseSchema,
  DividendListResponse: contracts.dividendListResponseSchema,
  TaxYearListResponse: contracts.taxYearListResponseSchema,
  TaxYearReportResponse: contracts.taxYearReportResponseSchema,

  // Custom assets (§6.9)
  CreateCustomAssetRequest: contracts.createCustomAssetRequestSchema,
  UpdateCustomAssetRequest: contracts.updateCustomAssetRequestSchema,
  PutValuePointsRequest: contracts.putValuePointsRequestSchema,
  CreateCustomAssetResponse: contracts.createCustomAssetResponseSchema,
  CustomAssetListResponse: contracts.customAssetListResponseSchema,
  UpdateCustomAssetResponse: z.object({ asset: contracts.customAssetSchema }).strict(),
  ValuePointsResponse: contracts.valuePointsResponseSchema,
  RecategorizationStatusResponse: contracts.recategorizationStatusResponseSchema,

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

  // Ideas (§13.4 V4-P9)
  IdeaListResponse: contracts.ideaListResponseSchema,
  IdeaResponse: contracts.ideaResponseSchema,

  // Broker CSV imports (§13.4 V4-P8)
  ImportBrokerListResponse: contracts.importBrokerListResponseSchema,
  ImportPreviewResponse: contracts.importPreviewResponseSchema,
  ApplyImportRequest: contracts.applyImportRequestSchema,
  ApplyImportResponse: contracts.applyImportResponseSchema,
  CreateIdeaRequest: contracts.createIdeaRequestSchema,
  UpdateIdeaRequest: contracts.updateIdeaRequestSchema,

  // Announcements (§13.4 V4-P5b)
  Announcement: contracts.announcementSchema,
  AnnouncementListResponse: contracts.announcementListResponseSchema,
  CreateAnnouncementRequest: contracts.createAnnouncementRequestSchema,
  UpdateAnnouncementRequest: contracts.updateAnnouncementRequestSchema,
  ActiveAnnouncement: contracts.activeAnnouncementSchema,
  ActiveAnnouncementListResponse: contracts.activeAnnouncementListResponseSchema,

  // Analytics (§13.3 V3-P9)
  AnalyticsSeriesResponse: contracts.analyticsSeriesResponseSchema,

  // Social (§6.9, §13.2 V2-P9)
  CreateFriendRequestRequest: contracts.createFriendRequestRequestSchema,
  FriendRequestListResponse: contracts.friendRequestListResponseSchema,
  FriendsListResponse: contracts.friendsListResponseSchema,
  FollowUserRequest: contracts.followUserRequestSchema,
  FollowingListResponse: contracts.followingListResponseSchema,
  FollowersListResponse: contracts.followersListResponseSchema,
  UpdateFollowRequest: contracts.updateFollowRequestSchema,
  FollowingEntry: contracts.followingEntrySchema,
  ItemFollowRequest: contracts.itemFollowRequestSchema,
  ItemFollowsListResponse: contracts.itemFollowsListResponseSchema,
  SharedWithMeResponse: contracts.sharedWithMeResponseSchema,
  SharedPortfolioDetailResponse: contracts.sharedPortfolioDetailResponseSchema,
  SharedConglomerateDetailResponse: contracts.sharedConglomerateDetailResponseSchema,
  SharedWatchlistDetailResponse: contracts.sharedWatchlistDetailResponseSchema,
  MySharedResponse: contracts.mySharedResponseSchema,
  AudienceState: contracts.audienceStateSchema,
  SetAudienceRequest: contracts.setAudienceRequestSchema,
  AudienceMutationResponse: contracts.audienceMutationResponseSchema,
  SharedLinkResponse: contracts.sharedLinkResponseSchema,
  SetActivityAlertRequest: contracts.setActivityAlertRequestSchema,
  ActivityAlertState: contracts.activityAlertStateSchema,
  ProfileSettingsResponse: contracts.profileSettingsResponseSchema,
  UpdateProfileSettingsRequest: contracts.updateProfileSettingsRequestSchema,
  PublicProfileResponse: contracts.publicProfileResponseSchema,

  // Friend chat (§13.3 V3-P8)
  ChatConversationListResponse: contracts.chatConversationListResponseSchema,
  OpenConversationRequest: contracts.openConversationRequestSchema,
  ConversationResponse: contracts.conversationResponseSchema,
  ChatThreadResponse: contracts.chatThreadResponseSchema,
  SendChatMessageRequest: contracts.sendChatMessageRequestSchema,
  SendChatMessageResponse: contracts.sendChatMessageResponseSchema,

  // Notifications & settings (§6.10, §6.11, §13.2 V2-P9, #368)
  MarkReadRequest: contracts.markReadRequestSchema,
  NotificationListResponse: contracts.notificationListResponseSchema,
  RegisterDeviceRequest: contracts.registerDeviceRequestSchema,
  DeleteDeviceRequest: contracts.deleteDeviceRequestSchema,
  WebPushSubscribeRequest: contracts.webPushSubscribeRequestSchema,
  WebPushUnsubscribeRequest: contracts.webPushUnsubscribeRequestSchema,
  UpdateNotificationSettingsRequest: contracts.updateNotificationSettingsRequestSchema,
  NotificationSettingsResponse: contracts.notificationSettingsResponseSchema,
  AccountSettingsResponse: contracts.accountSettingsResponseSchema,
  UpdateAccountSettingsRequest: contracts.updateAccountSettingsRequestSchema,

  // Telegram + Discord channels (§13.4 V4-P10)
  TelegramSettingsResponse: contracts.telegramSettingsResponseSchema,
  TelegramConfirmResponse: contracts.telegramConfirmResponseSchema,
  DiscordSettingsResponse: contracts.discordSettingsResponseSchema,
  DiscordWebhookRequest: contracts.discordWebhookRequestSchema,
  DiscordTestResponse: contracts.discordTestResponseSchema,

  // Account data export (§13.4 V4-P6a, #494)
  ExportRequest: contracts.exportRequestSchema,
  ExportRequestResponse: contracts.exportRequestResponseSchema,
  ExportStatusResponse: contracts.exportStatusResponseSchema,

  // Price alerts (§14, V3-P10)
  Alert: contracts.alertSchema,
  AlertListResponse: contracts.alertListResponseSchema,
  CreateAlertRequest: contracts.createAlertRequestSchema,
  UpdateAlertRequest: contracts.updateAlertRequestSchema,
  AlertSharingResponse: contracts.alertSharingResponseSchema,
  UpdateAlertSharingRequest: contracts.updateAlertSharingRequestSchema,

  // Personal API keys (§6.13, V2-P12)
  CreateApiKeyRequest: contracts.createApiKeyRequestSchema,
  ApiKeyListResponse: contracts.apiKeyListResponseSchema,
  CreateApiKeyResponse: contracts.createApiKeyResponseSchema,

  // OAuth apps (§6.13, V2-P12)
  CreateOAuthClientRequest: contracts.createOAuthClientRequestSchema,
  UpdateOAuthClientRequest: contracts.updateOAuthClientRequestSchema,
  OAuthClientSummary: contracts.oauthClientSummarySchema,
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

// Idempotency-Key request header (§13.4 V4-P2a, #417), documented on the covered
// portfolio mutation endpoints. Optional (opt-in) — a request without it behaves
// exactly as before. Header name + semantics come from `@bettertrack/contracts`.
const idempotencyKeyHeaders = z.object({
  [contracts.IDEMPOTENCY_KEY_HEADER]: contracts.idempotencyKeySchema.optional().openapi({
    description:
      'Optional idempotency key (a UUID). The first request under this key runs the mutation and its response is stored per user for ≥ 48 h; a duplicate replays that exact response instead of repeating the side effect. Reusing the key with a different request body is rejected (409 IDEMPOTENCY_KEY_MISMATCH); a non-UUID value is 400 IDEMPOTENCY_KEY_INVALID.',
    example: '018f9a1e-7c3d-7b2a-9e10-2b6f4c1d8a55',
  }),
});

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
  /**
   * Request body media type; defaults to JSON. The CSV upload (§13.4 V4-P8) is
   * the one `multipart/form-data` endpoint — its file part is described in its
   * body schema via `.openapi({ format: 'binary' })`.
   */
  bodyContentType?: string;
  status: number;
  /** Success response schema; omit for empty (204) responses. */
  response?: z.ZodTypeAny;
  /**
   * Accepts the opt-in `Idempotency-Key` header (§13.4 V4-P2a, #417) — documents
   * the header + its 409 conflict semantics. Kept in lockstep with the routes the
   * idempotency middleware is actually mounted on.
   */
  idempotent?: boolean;
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
  {
    method: 'get',
    path: '/version',
    tag: 'Meta',
    summary: 'Deployed build marker (commit + build time) for deploy verification.',
    public: true,
    status: 200,
    response: R.VersionResponse,
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
    method: 'post',
    path: '/auth/session/persist',
    tag: 'Auth',
    summary: 'Promote the current session to persistent (OAuth “stay signed in”, PIN-gated).',
    status: 200,
    response: R.OkResponse,
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
    method: 'delete',
    path: '/account',
    tag: 'Auth',
    summary:
      'Delete the account irreversibly (typed username confirmation + password or fresh 2FA). Revokes every session and credential; chat messages anonymize for the partner.',
    body: R.DeleteAccountRequest,
    status: 200,
    response: R.OkResponse,
  },
  {
    method: 'post',
    path: '/account/export',
    tag: 'Account',
    summary:
      'Request a data export (re-auth + 1/day). Returns the job id and the raw download token once; only its hash is stored.',
    body: R.ExportRequest,
    status: 200,
    response: R.ExportRequestResponse,
  },
  {
    method: 'get',
    path: '/account/export',
    tag: 'Account',
    summary: 'The caller’s latest export job status (no secret).',
    status: 200,
    response: R.ExportStatusResponse,
  },
  {
    method: 'get',
    path: '/account/export/download',
    tag: 'Account',
    summary:
      'Download the ready export zip; session-authenticated and token-gated (foreign/expired tokens 404).',
    query: contracts.exportDownloadQuerySchema,
    status: 200,
  },
  {
    method: 'get',
    path: '/auth/pin/status',
    tag: 'Auth',
    summary: 'Whether a login PIN is set (for the app-lock option).',
    status: 200,
    response: R.PinStatusResponse,
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
    path: '/auth/pin/quick-auth',
    tag: 'Auth',
    summary:
      'OAuth PIN quick re-auth for a remembered device: PIN-only sign-in (or an auto-pass probe returning { pinRequired } when the window is closed).',
    body: R.PinQuickAuthRequest,
    status: 200,
    response: R.PinQuickAuthResponse,
  },
  {
    method: 'post',
    path: '/auth/remembered-device',
    tag: 'Auth',
    summary: 'Remember this device for OAuth PIN quick re-auth (PIN users only).',
    status: 200,
    response: R.RememberedDeviceResponse,
  },
  {
    method: 'delete',
    path: '/auth/remembered-device',
    tag: 'Auth',
    summary: 'Forget the remembered device (“Another account” / explicit forget).',
    status: 200,
    response: R.OkResponse,
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
    method: 'delete',
    path: '/auth/2fa/enroll',
    tag: 'Auth',
    summary:
      'Cancel a pending (unconfirmed) TOTP enrollment. 409 when TOTP is already enabled, 404 when nothing is pending.',
    status: 200,
    response: R.OkResponse,
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
    method: 'get',
    path: '/auth/registration-info',
    tag: 'Auth',
    summary: 'Public: the active registration mode (leaks nothing else).',
    public: true,
    status: 200,
    response: R.PublicRegistrationInfoResponse,
  },
  {
    method: 'post',
    path: '/auth/register',
    tag: 'Auth',
    summary:
      'Public self-serve registration; gated by the active mode (closed → 403, invite-token/open → account, approval → 202 pending).',
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
  // Google sign-in (§13.4 V4-P4b). Env-gated: all four 404 when no Google client
  // is configured. `start`/`callback` are browser redirects (no JSON body).
  {
    method: 'get',
    path: '/auth/google/start',
    tag: 'Auth',
    summary:
      'Begin the Google OAuth flow: bind a single-use state and redirect to Google. A live session makes it a link flow; anonymous is a sign-in/registration. 404 when Google is not configured.',
    public: true,
    status: 302,
  },
  {
    method: 'get',
    path: '/auth/google/callback',
    tag: 'Auth',
    summary:
      'Google’s redirect back: validate state, verify the ID token, then sign in / link, or land a brand-new identity on the connected register form via a one-time ticket. Sets the session cookie on a sign-in and always redirects to the SPA. 404 when Google is not configured.',
    public: true,
    query: z.object({
      state: z.string().optional(),
      code: z.string().optional(),
      error: z.string().optional(),
    }),
    status: 302,
  },
  {
    method: 'get',
    path: '/auth/google/register-ticket',
    tag: 'Auth',
    summary:
      'Display values (email to lock, name to seed the username) for a pending Google sign-up, referenced by the signed httpOnly ticket cookie. 404 when Google is not configured or no ticket is pending.',
    public: true,
    status: 200,
    response: R.GoogleRegisterTicketResponse,
  },
  {
    method: 'post',
    path: '/auth/google/register',
    tag: 'Auth',
    summary:
      'Create the account from a pending Google ticket (email + linked subject taken from the ticket, never the body) per the active mode: open/invite-token → account 201, approval → 202 pending. 404 when Google is not configured.',
    public: true,
    body: R.GoogleRegisterRequest,
    status: 201,
    response: R.MeResponse,
  },
  {
    method: 'get',
    path: '/auth/google/link-status',
    tag: 'Auth',
    summary:
      'The caller’s Google link state for Settings → Security (enabled / linked / canUnlink).',
    status: 200,
    response: R.GoogleLinkStatusResponse,
  },
  {
    method: 'post',
    path: '/auth/google/unlink',
    tag: 'Auth',
    summary:
      'Unlink Google after a password re-auth. Refused (409 GOOGLE_ONLY_SIGN_IN) while Google is the account’s only usable sign-in method.',
    body: R.GoogleUnlinkRequest,
    status: 200,
    response: R.OkResponse,
  },

  // Admin (§6.12)
  // Mandatory admin-login 2FA management (#400). Reachable even in the
  // setup-required bootstrap state — every OTHER admin endpoint 403s with
  // ADMIN_2FA_SETUP_REQUIRED until a method is confirmed. The login challenge
  // itself reuses the shared /auth/login → /auth/2fa/verify flow.
  {
    method: 'get',
    path: '/admin/security/2fa/status',
    tag: 'Admin',
    summary: 'The admin’s own 2FA methods + the mandatory-setup gate state.',
    status: 200,
    response: R.AdminTwoFactorStatusResponse,
  },
  {
    method: 'post',
    path: '/admin/security/2fa/totp/enroll',
    tag: 'Admin',
    summary: 'Begin admin TOTP enrollment; returns a provisional secret + otpauth URI.',
    status: 200,
    response: R.TwoFactorEnrollResponse,
  },
  {
    method: 'post',
    path: '/admin/security/2fa/totp/confirm',
    tag: 'Admin',
    summary:
      'Confirm admin TOTP with a code. Returns recovery codes if it is the first method enabled, else null.',
    body: R.TwoFactorConfirmRequest,
    status: 200,
    response: R.TwoFactorMethodEnabledResponse,
  },
  {
    method: 'post',
    path: '/admin/security/2fa/totp/disable',
    tag: 'Admin',
    summary: 'Disable the admin authenticator (TOTP) method with a valid TOTP or recovery code.',
    body: R.TwoFactorDisableRequest,
    status: 204,
  },
  {
    method: 'post',
    path: '/admin/security/2fa/email/start',
    tag: 'Admin',
    summary:
      'Set or change the separate 2FA email and send a confirmation code to it. Requires a fresh 2FA proof once enrolled.',
    body: R.AdminTwoFactorEmailStartRequest,
    status: 204,
  },
  {
    method: 'post',
    path: '/admin/security/2fa/email/confirm',
    tag: 'Admin',
    summary:
      'Confirm the emailed code; enables the admin email method on the new 2FA email. Returns recovery codes if first method, else null.',
    body: R.TwoFactorEmailConfirmRequest,
    status: 200,
    response: R.TwoFactorMethodEnabledResponse,
  },
  {
    method: 'post',
    path: '/admin/security/2fa/email/disable',
    tag: 'Admin',
    summary: 'Disable the admin email 2FA method and clear the 2FA email.',
    status: 204,
  },
  {
    method: 'post',
    path: '/admin/security/2fa/recovery-codes',
    tag: 'Admin',
    summary: 'Regenerate the admin recovery codes (voids the old set).',
    status: 200,
    response: R.TwoFactorRecoveryCodesResponse,
  },
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
    path: '/admin/registration-tokens',
    tag: 'Admin',
    summary: 'List registration access tokens (invite-token mode).',
    status: 200,
    response: R.RegistrationTokenListResponse,
  },
  {
    method: 'post',
    path: '/admin/registration-tokens',
    tag: 'Admin',
    summary: 'Create a registration access token; returns its register URL once.',
    body: R.CreateRegistrationTokenRequest,
    status: 201,
    response: R.CreateRegistrationTokenResponse,
  },
  {
    method: 'post',
    path: '/admin/registration-tokens/{id}/revoke',
    tag: 'Admin',
    summary: 'Revoke a registration access token.',
    params: contracts.idParamSchema,
    status: 200,
    response: R.OkResponse,
  },
  {
    method: 'get',
    path: '/admin/registration-requests',
    tag: 'Admin',
    summary: 'List pending approval-queue registration applications.',
    status: 200,
    response: R.RegistrationRequestListResponse,
  },
  {
    method: 'post',
    path: '/admin/registration-requests/{id}/approve',
    tag: 'Admin',
    summary: 'Approve a pending registration; creates the account + emails the applicant.',
    params: contracts.idParamSchema,
    status: 200,
    response: R.AdminUser,
  },
  {
    method: 'post',
    path: '/admin/registration-requests/{id}/reject',
    tag: 'Admin',
    summary: 'Reject a pending registration; drops it + emails the applicant.',
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
    method: 'patch',
    path: '/admin/oauth-clients/{id}',
    tag: 'Admin',
    summary:
      'Edit a first-party OAuth app (name, redirect URIs, scopes). Consent-safe: widening scopes never widens live grants; narrowing applies immediately.',
    params: contracts.idParamSchema,
    body: R.UpdateOAuthClientRequest,
    status: 200,
    response: R.OAuthClientSummary,
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
  // Announcements (§13.4 V4-P5b) — admin CRUD; publish fan-out runs in the
  // service on `active` flip on. Delivery is banner + inbox only.
  {
    method: 'get',
    path: '/admin/announcements',
    tag: 'Admin',
    summary: 'List every composed announcement (newest first).',
    status: 200,
    response: R.AnnouncementListResponse,
  },
  {
    method: 'post',
    path: '/admin/announcements',
    tag: 'Admin',
    summary:
      'Create an announcement. Requires EN + DE title/body; creating with active=true publishes immediately (fans one inbox row out per user).',
    body: R.CreateAnnouncementRequest,
    status: 201,
    response: R.Announcement,
  },
  {
    method: 'patch',
    path: '/admin/announcements/{id}',
    tag: 'Admin',
    summary:
      'Update an announcement. Flipping active off→on publishes (fan-out is idempotent per user via the shared eventKey).',
    params: contracts.idParamSchema,
    body: R.UpdateAnnouncementRequest,
    status: 200,
    response: R.Announcement,
  },
  {
    method: 'delete',
    path: '/admin/announcements/{id}',
    tag: 'Admin',
    summary: 'Delete an announcement (cascades its per-user dismissals away).',
    params: contracts.idParamSchema,
    status: 204,
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
    path: '/admin/health',
    tag: 'Admin',
    summary: 'Operator health snapshot: DB/Redis/provider/queue/gateway, version, uptime.',
    status: 200,
    response: R.AdminHealthResponse,
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
    path: '/admin/account-defaults',
    tag: 'Admin',
    summary: 'New-account defaults (chat, portfolio visibility, dev status, notifications).',
    status: 200,
    response: R.AccountDefaultsResponse,
  },
  {
    method: 'patch',
    path: '/admin/account-defaults',
    tag: 'Admin',
    summary: 'Update new-account defaults (audit-logged; applies to next registration only).',
    body: R.UpdateAccountDefaultsRequest,
    status: 200,
    response: R.AccountDefaultsResponse,
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
  {
    method: 'get',
    path: '/admin/usage-analytics',
    tag: 'Admin',
    summary: 'First-party usage analytics: DAU/WAU/MAU, feature counters, top assets, funnel.',
    status: 200,
    response: R.UsageAnalyticsResponse,
  },
  {
    method: 'get',
    path: '/admin/problems',
    tag: 'Admin',
    summary: 'Captured problems (errors/failed jobs/provider failures), filter by kind/status.',
    query: contracts.problemListQuerySchema,
    status: 200,
    response: R.ProblemListResponse,
  },
  {
    method: 'get',
    path: '/admin/problems/{id}',
    tag: 'Admin',
    summary: 'One captured problem.',
    params: contracts.idParamSchema,
    status: 200,
    response: R.Problem,
  },
  {
    method: 'post',
    path: '/admin/problems/{id}/resolve',
    tag: 'Admin',
    summary: 'Mark a problem resolved (audit-logged).',
    params: contracts.idParamSchema,
    status: 200,
    response: R.Problem,
  },
  {
    method: 'post',
    path: '/admin/problems/{id}/reopen',
    tag: 'Admin',
    summary: 'Reopen a resolved problem (audit-logged).',
    params: contracts.idParamSchema,
    status: 200,
    response: R.Problem,
  },

  // Workboard (§6.4, §13.3 V3-P5)
  {
    method: 'get',
    path: '/workboard',
    tag: 'Workboard',
    summary: 'The caller’s watchlist items (optionally scoped to one named list).',
    query: contracts.workboardListQuerySchema,
    status: 200,
    response: R.WorkboardListResponse,
  },
  {
    method: 'post',
    path: '/workboard',
    tag: 'Workboard',
    summary: 'Add an asset to a watchlist (default General list when omitted).',
    body: R.AddToWorkboardRequest,
    status: 201,
    response: R.WorkboardItem,
  },
  {
    method: 'get',
    path: '/workboard/watchlists',
    tag: 'Workboard',
    summary: 'The caller’s named watchlists (General first) with per-list audience.',
    status: 200,
    response: R.WatchlistListResponse,
  },
  {
    method: 'post',
    path: '/workboard/watchlists',
    tag: 'Workboard',
    summary: 'Create a named watchlist.',
    body: R.CreateWatchlistRequest,
    status: 201,
    response: R.WatchlistSummary,
  },
  {
    method: 'patch',
    path: '/workboard/watchlists/{watchlistId}',
    tag: 'Workboard',
    summary: 'Rename a watchlist (never the default General list).',
    params: contracts.watchlistIdParamSchema,
    body: R.UpdateWatchlistRequest,
    status: 200,
    response: R.WatchlistSummary,
  },
  {
    method: 'delete',
    path: '/workboard/watchlists/{watchlistId}',
    tag: 'Workboard',
    summary: 'Delete a watchlist (never the default General list).',
    params: contracts.watchlistIdParamSchema,
    status: 204,
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
    method: 'delete',
    path: '/portfolios/{portfolioId}',
    tag: 'Portfolios',
    summary: 'Permanently delete a portfolio and all its data (rejects the only active one).',
    params: contracts.portfolioIdParamSchema,
    status: 204,
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
    idempotent: true,
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
    idempotent: true,
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
    path: '/portfolios/{portfolioId}/cash/sources',
    tag: 'Portfolios',
    summary: 'Cash sources with per-source balances (Main first).',
    params: contracts.portfolioIdParamSchema,
    query: contracts.cashSourceListQuerySchema,
    status: 200,
    response: R.CashSourceListResponse,
  },
  {
    method: 'post',
    path: '/portfolios/{portfolioId}/cash/sources',
    tag: 'Portfolios',
    summary: 'Create a named cash source.',
    params: contracts.portfolioIdParamSchema,
    body: R.CreateCashSourceRequest,
    status: 201,
    response: R.CashSourceResponse,
  },
  {
    method: 'patch',
    path: '/portfolios/{portfolioId}/cash/sources/{sourceId}',
    tag: 'Portfolios',
    summary: 'Rename or relabel a cash source.',
    params: contracts.cashSourceParamsSchema,
    body: R.UpdateCashSourceRequest,
    status: 200,
    response: R.CashSourceResponse,
  },
  {
    method: 'post',
    path: '/portfolios/{portfolioId}/cash/sources/{sourceId}/archive',
    tag: 'Portfolios',
    summary: 'Archive a cash source (rejects Main and non-zero balances).',
    params: contracts.cashSourceParamsSchema,
    status: 200,
    response: R.CashSourceResponse,
  },
  {
    method: 'post',
    path: '/portfolios/{portfolioId}/cash/sources/{sourceId}/restore',
    tag: 'Portfolios',
    summary: 'Restore an archived cash source.',
    params: contracts.cashSourceParamsSchema,
    status: 200,
    response: R.CashSourceResponse,
  },
  {
    method: 'post',
    path: '/portfolios/{portfolioId}/cash/transfer',
    tag: 'Portfolios',
    summary: 'Transfer between two cash sources (atomic paired movements).',
    params: contracts.portfolioIdParamSchema,
    body: R.CashTransferRequest,
    status: 201,
    response: R.CashTransferResponse,
    idempotent: true,
  },
  {
    method: 'post',
    path: '/portfolios/{portfolioId}/cash/sources/{sourceId}/set-balance',
    tag: 'Portfolios',
    summary: 'Set a source balance to X (records the signed delta as a movement).',
    params: contracts.cashSourceParamsSchema,
    body: R.SetCashBalanceRequest,
    status: 200,
    response: R.SetCashBalanceResponse,
    idempotent: true,
  },
  {
    method: 'post',
    path: '/portfolios/{portfolioId}/dividends',
    tag: 'Portfolios',
    summary: 'Record a dividend into a cash source (tax-mode aware).',
    params: contracts.portfolioIdParamSchema,
    body: R.CreateDividendRequest,
    status: 201,
    response: R.CreateDividendResponse,
  },
  {
    method: 'get',
    path: '/portfolios/{portfolioId}/dividends',
    tag: 'Portfolios',
    summary: 'The portfolio’s recorded dividends.',
    params: contracts.portfolioIdParamSchema,
    status: 200,
    response: R.DividendListResponse,
  },
  {
    method: 'delete',
    path: '/portfolios/{portfolioId}/dividends/{dividendId}',
    tag: 'Portfolios',
    summary: 'Delete a dividend (its movements cascade; AT years re-settle).',
    params: contracts.dividendParamsSchema,
    status: 204,
  },
  {
    method: 'get',
    path: '/portfolios/{portfolioId}/reports/tax-years',
    tag: 'Portfolios',
    summary: 'Per-year realized P/L + dividends + taxes summaries.',
    params: contracts.portfolioIdParamSchema,
    status: 200,
    response: R.TaxYearListResponse,
  },
  {
    method: 'get',
    path: '/portfolios/{portfolioId}/reports/tax-years/{year}',
    tag: 'Portfolios',
    summary: 'One tax year with per-position drill-down.',
    params: contracts.taxYearParamsSchema,
    status: 200,
    response: R.TaxYearReportResponse,
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
    idempotent: true,
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
    idempotent: true,
  },
  {
    method: 'delete',
    path: '/portfolios/{portfolioId}/transactions/{txId}',
    tag: 'Portfolios',
    summary: 'Delete a transaction (re-validates oversell).',
    params: contracts.portfolioTransactionParamsSchema,
    status: 204,
    idempotent: true,
  },

  // Custom assets (§6.9)
  {
    method: 'get',
    path: '/custom-assets/recategorization',
    tag: 'Custom Assets',
    summary: 'How many custom assets still need re-categorizing (V3-P2 banner).',
    status: 200,
    response: R.RecategorizationStatusResponse,
  },
  {
    method: 'post',
    path: '/custom-assets/recategorization/dismiss',
    tag: 'Custom Assets',
    summary: 'Dismiss the re-categorize banner (clear every flag).',
    status: 204,
  },
  {
    method: 'get',
    path: '/custom-assets',
    tag: 'Custom Assets',
    summary: 'List all custom assets the caller owns (with latest value point).',
    status: 200,
    response: R.CustomAssetListResponse,
  },
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
    idempotent: true,
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

  // Ideas (§13.4 V4-P9) — saved & shareable Workboard analyses
  {
    method: 'get',
    path: '/ideas',
    tag: 'Ideas',
    summary: 'The caller’s saved ideas, newest first.',
    status: 200,
    response: R.IdeaListResponse,
  },
  {
    method: 'post',
    path: '/ideas',
    tag: 'Ideas',
    summary: 'Save a named Workboard state (conglomerate ref or ad-hoc set) + thesis.',
    body: R.CreateIdeaRequest,
    status: 201,
    response: R.IdeaResponse,
  },
  {
    method: 'get',
    path: '/ideas/{ideaId}',
    tag: 'Ideas',
    summary: 'One of the caller’s own ideas — the exact saved state.',
    params: contracts.ideaIdParamSchema,
    status: 200,
    response: R.IdeaResponse,
  },
  {
    method: 'patch',
    path: '/ideas/{ideaId}',
    tag: 'Ideas',
    summary: 'Rename, re-note, or re-save the Workboard state.',
    params: contracts.ideaIdParamSchema,
    body: R.UpdateIdeaRequest,
    status: 200,
    response: R.IdeaResponse,
  },
  {
    method: 'delete',
    path: '/ideas/{ideaId}',
    tag: 'Ideas',
    summary: 'Delete an own idea (and its audience row).',
    params: contracts.ideaIdParamSchema,
    status: 204,
  },
  {
    method: 'post',
    path: '/ideas/{ideaId}/clone',
    tag: 'Ideas',
    summary: 'Clone an audience-admitted idea into an own private copy.',
    params: contracts.ideaIdParamSchema,
    status: 201,
    response: R.IdeaResponse,
  },

  // Broker CSV imports (§13.4 V4-P8)
  {
    method: 'get',
    path: '/imports/brokers',
    tag: 'Imports',
    summary: 'The supported broker CSV mappers, for the manual picker.',
    status: 200,
    response: R.ImportBrokerListResponse,
  },
  {
    method: 'post',
    path: '/imports',
    tag: 'Imports',
    summary:
      'Upload a broker CSV: autodetect (or pick) the broker, parse + normalize into a staged batch, and return the preview with per-row mapped/unmapped/duplicate/error flags. Nothing is applied yet.',
    body: contracts.createImportBatchFieldsSchema.extend({
      file: z.string().openapi({
        type: 'string',
        format: 'binary',
        description: 'The broker CSV export (UTF-8, ≤ 5 MB).',
      }),
    }),
    bodyContentType: 'multipart/form-data',
    status: 201,
    response: R.ImportPreviewResponse,
  },
  {
    method: 'get',
    path: '/imports/{batchId}',
    tag: 'Imports',
    summary: "Re-read a staged import batch's preview (owner-scoped).",
    params: contracts.importBatchIdParamSchema,
    status: 200,
    response: R.ImportPreviewResponse,
  },
  {
    method: 'post',
    path: '/imports/{batchId}/apply',
    tag: 'Imports',
    summary:
      'Confirm a staged batch: apply its valid rows into the portfolio (+ chosen cash source) through the portfolio/tax services, with per-row outcomes — never all-or-nothing.',
    params: contracts.importBatchIdParamSchema,
    body: R.ApplyImportRequest,
    status: 200,
    response: R.ApplyImportResponse,
    idempotent: true,
  },
  {
    method: 'delete',
    path: '/imports/{batchId}',
    tag: 'Imports',
    summary: 'Discard a staged import batch (staging data only).',
    params: contracts.importBatchIdParamSchema,
    status: 204,
  },

  // Analytics (§13.3 V3-P9)
  {
    method: 'get',
    path: '/analytics/portfolios/{portfolioId}/series',
    tag: 'Analytics',
    summary:
      'Configurable analytics series + per-series stats, contributions, compare & inflation.',
    params: contracts.portfolioIdParamSchema,
    query: contracts.analyticsSeriesQuerySchema,
    status: 200,
    response: R.AnalyticsSeriesResponse,
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
    method: 'post',
    path: '/social/follows',
    tag: 'Social',
    summary: 'Follow a person (idempotent) — opt into their published-item news.',
    body: R.FollowUserRequest,
    status: 202,
    response: R.OkResponse,
  },
  {
    method: 'get',
    path: '/social/follows',
    tag: 'Social',
    summary: 'The users the caller follows, with follower/following counts.',
    status: 200,
    response: R.FollowingListResponse,
  },
  {
    method: 'get',
    path: '/social/followers',
    tag: 'Social',
    summary: 'The users who follow the caller.',
    status: 200,
    response: R.FollowersListResponse,
  },
  {
    method: 'delete',
    path: '/social/follows/{userId}',
    tag: 'Social',
    summary: 'Unfollow a person — stops their news immediately.',
    params: userIdParamSchema,
    status: 204,
  },
  {
    method: 'patch',
    path: '/social/follows/{userId}',
    tag: 'Social',
    summary: 'Update per-follow preferences (auto-follow their new items, alert-follow triggers).',
    params: userIdParamSchema,
    body: R.UpdateFollowRequest,
    status: 200,
    response: R.FollowingEntry,
  },
  {
    method: 'post',
    path: '/social/item-follows',
    tag: 'Social',
    summary: 'Follow (bookmark) another user’s visible item (idempotent).',
    body: R.ItemFollowRequest,
    status: 202,
    response: R.OkResponse,
  },
  {
    method: 'get',
    path: '/social/item-follows',
    tag: 'Social',
    summary: 'The caller’s followed items, visibility re-derived per row.',
    status: 200,
    response: R.ItemFollowsListResponse,
  },
  {
    method: 'delete',
    path: '/social/item-follows/{kind}/{subjectId}',
    tag: 'Social',
    summary: 'Unfollow an item — works even after it became invisible.',
    params: contracts.audienceParamSchema,
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
    path: '/social/shared/watchlists/{watchlistId}',
    tag: 'Social',
    summary: 'Read-only view of a friend’s shared named watchlist.',
    params: contracts.watchlistIdParamSchema,
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
    summary:
      'My items — every shareable item I own (all portfolios, conglomerates and watchlists), shared or not, each with its current audience.',
    status: 200,
    response: R.MySharedResponse,
  },
  {
    method: 'get',
    path: '/social/links/{token}',
    tag: 'Social',
    summary: 'Resolve a public share link to its live read-only view (unauthenticated).',
    public: true,
    params: contracts.tokenParamSchema,
    status: 200,
    response: R.SharedLinkResponse,
  },
  {
    method: 'get',
    path: '/social/audience/{kind}/{subjectId}',
    tag: 'Social',
    summary: 'The owner’s audience for one shareable subject (feeds the AudiencePicker).',
    params: contracts.audienceParamSchema,
    status: 200,
    response: R.AudienceState,
  },
  {
    method: 'put',
    path: '/social/audience/{kind}/{subjectId}',
    tag: 'Social',
    summary:
      'Set a subject’s audience; minting a public link returns the raw token once (hash-only storage).',
    params: contracts.audienceParamSchema,
    body: R.SetAudienceRequest,
    status: 200,
    response: R.AudienceMutationResponse,
  },
  {
    method: 'put',
    path: '/social/shared/activity/{kind}/{subjectId}',
    tag: 'Social',
    summary:
      'Set my activity-alert preference for one shared item (preference only; delivery is #368).',
    params: contracts.audienceParamSchema,
    body: R.SetActivityAlertRequest,
    status: 200,
    response: R.ActivityAlertState,
  },
  {
    method: 'get',
    path: '/social/profile',
    tag: 'Social',
    summary: 'My public-profile settings — opt-in flag, bio, and how many items are public.',
    status: 200,
    response: R.ProfileSettingsResponse,
  },
  {
    method: 'put',
    path: '/social/profile',
    tag: 'Social',
    summary:
      'Update my public-profile opt-in + bio; enabling requires an acknowledgment, disabling unpublishes instantly.',
    body: R.UpdateProfileSettingsRequest,
    status: 200,
    response: R.ProfileSettingsResponse,
  },
  {
    method: 'get',
    path: '/social/profiles/{username}',
    tag: 'Social',
    summary:
      'A user’s public profile — bio + their public_link items (unauthenticated; 404 when not opted-in).',
    public: true,
    params: contracts.profileUsernameParamSchema,
    status: 200,
    response: R.PublicProfileResponse,
  },
  {
    method: 'get',
    path: '/social/profiles/{username}/{kind}/{subjectId}',
    tag: 'Social',
    summary:
      'Read-only detail of one public item on a profile (unauthenticated; non-public item 404s).',
    public: true,
    params: contracts.profileItemParamSchema,
    status: 200,
    response: R.SharedLinkResponse,
  },

  // Friend chat (§13.3 V3-P8)
  {
    method: 'get',
    path: '/chat/conversations',
    tag: 'Chat',
    summary: 'The caller’s 1:1 conversations with unread counts, newest-active first.',
    status: 200,
    response: R.ChatConversationListResponse,
  },
  {
    method: 'post',
    path: '/chat/conversations',
    tag: 'Chat',
    summary: 'Open (or resolve) the conversation with a friend; a non-friend 404s (never data).',
    body: R.OpenConversationRequest,
    status: 201,
    response: R.ConversationResponse,
  },
  {
    method: 'get',
    path: '/chat/conversations/{conversationId}/messages',
    tag: 'Chat',
    summary: 'A page of a thread (newest-first) + its summary. Non-participant 404s.',
    params: contracts.conversationIdParamSchema,
    query: contracts.chatThreadQuerySchema,
    status: 200,
    response: R.ChatThreadResponse,
  },
  {
    method: 'post',
    path: '/chat/conversations/{conversationId}/messages',
    tag: 'Chat',
    summary:
      'Send text and/or a share chip. Non-participant 404s; a former friend 403s (thread closed).',
    params: contracts.conversationIdParamSchema,
    body: R.SendChatMessageRequest,
    status: 201,
    response: R.SendChatMessageResponse,
  },
  {
    method: 'post',
    path: '/chat/conversations/{conversationId}/read',
    tag: 'Chat',
    summary: 'Clear the caller’s unread badge for a thread (idempotent).',
    params: contracts.conversationIdParamSchema,
    status: 200,
    response: R.OkResponse,
  },

  // Notifications (§6.10, #437)
  {
    method: 'get',
    path: '/notifications',
    tag: 'Notifications',
    summary:
      'Newest-first notifications with unread count. `view` filters on archive state (#437): active (default — unarchived), archived, or all; unreadCount always counts unread ACTIVE rows.',
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
  {
    method: 'post',
    path: '/notifications/{id}/archive',
    tag: 'Notifications',
    summary:
      'Archive one notification (also marks it read); it leaves the default/active view. Foreign or unknown id → 404 (#437).',
    params: contracts.notificationIdParamSchema,
    status: 200,
    response: R.OkResponse,
  },
  {
    method: 'post',
    path: '/notifications/{id}/unarchive',
    tag: 'Notifications',
    summary: 'Un-archive one notification (back to active; stays read). Unknown id → 404 (#437).',
    params: contracts.notificationIdParamSchema,
    status: 200,
    response: R.OkResponse,
  },
  {
    method: 'post',
    path: '/notifications/archive-all-read',
    tag: 'Notifications',
    summary: 'Archive every read, still-active notification of the caller (idempotent, #437).',
    status: 200,
    response: R.OkResponse,
  },
  {
    method: 'delete',
    path: '/notifications/{id}',
    tag: 'Notifications',
    summary: 'Hard-delete one notification; a repeated or foreign id → 404 (#437).',
    params: contracts.notificationIdParamSchema,
    status: 204,
  },
  {
    method: 'delete',
    path: '/notifications',
    tag: 'Notifications',
    summary:
      "Bulk hard delete (#437): scope=archived removes exactly the caller's archived rows, scope=all empties the caller's notifications. scope is required.",
    query: contracts.notificationBulkDeleteQuerySchema,
    status: 204,
  },
  {
    method: 'post',
    path: '/notifications/devices',
    tag: 'Notifications',
    summary:
      'Register (or refresh) an FCM device token for phone push — idempotent upsert, re-bound to the caller (#368).',
    body: R.RegisterDeviceRequest,
    status: 200,
    response: R.OkResponse,
  },
  {
    method: 'delete',
    path: '/notifications/devices',
    tag: 'Notifications',
    summary: 'Remove one of the caller’s FCM device tokens (idempotent).',
    body: R.DeleteDeviceRequest,
    status: 200,
    response: R.OkResponse,
  },
  {
    method: 'post',
    path: '/notifications/web-push',
    tag: 'Notifications',
    summary: 'Store (or refresh) a web-push subscription for browser push (#368).',
    body: R.WebPushSubscribeRequest,
    status: 200,
    response: R.OkResponse,
  },
  {
    method: 'delete',
    path: '/notifications/web-push',
    tag: 'Notifications',
    summary: 'Remove one of the caller’s web-push subscriptions (idempotent).',
    body: R.WebPushUnsubscribeRequest,
    status: 200,
    response: R.OkResponse,
  },
  // Announcements banner (§13.4 V4-P5b)
  {
    method: 'get',
    path: '/notifications/announcements',
    tag: 'Notifications',
    summary:
      'Currently active announcements the caller has not dismissed, rendered in their locale (banner list).',
    status: 200,
    response: R.ActiveAnnouncementListResponse,
  },
  {
    method: 'post',
    path: '/notifications/announcements/{id}/dismiss',
    tag: 'Notifications',
    summary: 'Dismiss one announcement for the caller (idempotent; per user AND per announcement).',
    params: contracts.announcementIdParamSchema,
    status: 200,
    response: R.OkResponse,
  },

  // Price alerts (§14, V3-P10)
  {
    method: 'get',
    path: '/alerts',
    tag: 'Alerts',
    summary: 'The caller’s price alerts.',
    status: 200,
    response: R.AlertListResponse,
  },
  {
    method: 'post',
    path: '/alerts',
    tag: 'Alerts',
    summary: 'Create a price alert (captures a reference price for the from-ref kinds).',
    body: R.CreateAlertRequest,
    status: 201,
    response: R.Alert,
  },
  {
    method: 'patch',
    path: '/alerts/{id}',
    tag: 'Alerts',
    summary: 'Update an alert’s threshold and/or repeat behaviour.',
    params: contracts.alertIdParamSchema,
    body: R.UpdateAlertRequest,
    status: 200,
    response: R.Alert,
  },
  {
    method: 'post',
    path: '/alerts/{id}/rearm',
    tag: 'Alerts',
    summary: 'Re-arm a fired one-shot alert back to active.',
    params: contracts.alertIdParamSchema,
    status: 200,
    response: R.Alert,
  },
  {
    method: 'delete',
    path: '/alerts/{id}',
    tag: 'Alerts',
    summary: 'Delete a price alert.',
    params: contracts.alertIdParamSchema,
    status: 204,
  },
  {
    method: 'get',
    path: '/alerts/sharing',
    tag: 'Alerts',
    summary: 'Whether the caller’s alerts are visible to their followers.',
    status: 200,
    response: R.AlertSharingResponse,
  },
  {
    method: 'put',
    path: '/alerts/sharing',
    tag: 'Alerts',
    summary:
      'Expose or hide the caller’s alerts to followers (enabling requires the acknowledgment).',
    body: R.UpdateAlertSharingRequest,
    status: 200,
    response: R.AlertSharingResponse,
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

  // Telegram + Discord channels (§13.4 V4-P10)
  {
    method: 'get',
    path: '/settings/telegram',
    tag: 'Settings',
    summary:
      'The caller’s Telegram link state (available / linked / pending). Bot token is env-gated.',
    status: 200,
    response: R.TelegramSettingsResponse,
  },
  {
    method: 'post',
    path: '/settings/telegram/link',
    tag: 'Settings',
    summary:
      'Issue a fresh single-use Telegram link code — the SPA uses it in the `https://t.me/<bot>?start=<code>` deep link.',
    status: 200,
    response: R.TelegramSettingsResponse,
  },
  {
    method: 'post',
    path: '/settings/telegram/confirm',
    tag: 'Settings',
    summary:
      'Poll for the bot’s `/start <code>` update and attach the chat id when it arrives; idempotent.',
    status: 200,
    response: R.TelegramConfirmResponse,
  },
  {
    method: 'delete',
    path: '/settings/telegram',
    tag: 'Settings',
    summary: 'Unlink the caller’s Telegram chat (idempotent).',
    status: 200,
    response: R.TelegramSettingsResponse,
  },
  {
    method: 'get',
    path: '/settings/discord',
    tag: 'Settings',
    summary: 'The caller’s Discord webhook state (never returns the raw URL).',
    status: 200,
    response: R.DiscordSettingsResponse,
  },
  {
    method: 'post',
    path: '/settings/discord/webhook',
    tag: 'Settings',
    summary:
      'Save (or replace) the caller’s Discord webhook — shape-validated and live-tested before persisting; URL encrypted at rest.',
    body: R.DiscordWebhookRequest,
    status: 200,
    response: R.DiscordSettingsResponse,
  },
  {
    method: 'post',
    path: '/settings/discord/test',
    tag: 'Settings',
    summary: 'Send a diagnostic message to the caller’s saved Discord webhook.',
    status: 200,
    response: R.DiscordTestResponse,
  },
  {
    method: 'delete',
    path: '/settings/discord',
    tag: 'Settings',
    summary: 'Remove the caller’s Discord webhook (idempotent).',
    status: 200,
    response: R.DiscordSettingsResponse,
  },
  {
    method: 'get',
    path: '/settings/taxes',
    tag: 'Settings',
    summary: 'The caller’s tax mode (+ country), V3-P4.',
    status: 200,
    response: R.TaxSettingsResponse,
  },
  {
    method: 'patch',
    path: '/settings/taxes',
    tag: 'Settings',
    summary: 'Switch the tax mode; applies forward only (§16).',
    body: R.UpdateTaxSettingsRequest,
    status: 200,
    response: R.TaxSettingsResponse,
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
  // Idempotency conflict semantics (§13.4 V4-P2a, #417): reusing a key for a
  // different request, or racing an in-flight one, is a typed 409.
  if (ep.idempotent) {
    responses['409'] = errorResponse(
      'Idempotency-Key conflict (IDEMPOTENCY_KEY_MISMATCH / IDEMPOTENCY_IN_PROGRESS).',
    );
  }
  // Shared error envelope `{ error: { code, message, details? } }` (§8).
  responses['default'] = errorResponse('Error envelope.');

  // Auth requirement per route (#361): public routes need none; every guarded
  // route accepts the session cookie, and those the bearer middleware admits
  // (identity, logout, scope-gated modules + the account-security surface) ALSO
  // accept `Authorization: Bearer …`. Derived from the real middleware policy
  // (`pathAcceptsBearer`) so the spec cannot drift from what the API enforces —
  // fixing the prior blanket "sessionCookie only" claim on every route.
  const security: Record<string, string[]>[] = ep.public
    ? []
    : pathAcceptsBearer(ep.path)
      ? [{ [SESSION_SECURITY]: [] }, { [BEARER_SECURITY]: [] }]
      : [{ [SESSION_SECURITY]: [] }];

  registry.registerPath({
    method: ep.method,
    path: ep.path,
    tags: [ep.tag],
    summary: ep.summary,
    security,
    request: {
      ...(ep.params ? { params: ep.params } : {}),
      ...(ep.query ? { query: ep.query } : {}),
      ...(ep.idempotent ? { headers: idempotencyKeyHeaders } : {}),
      ...(ep.body
        ? {
            body: {
              required: true,
              content: { [ep.bodyContentType ?? 'application/json']: { schema: ep.body } },
            },
          }
        : {}),
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
