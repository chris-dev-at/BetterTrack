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
  PinVerifyRequest: contracts.pinVerifyRequestSchema,
  SetPinRequest: contracts.setPinRequestSchema,
  SetPinLockRequest: contracts.setPinLockRequestSchema,
  MeResponse: contracts.meResponseSchema,
  SessionInfoResponse: contracts.sessionInfoResponseSchema,
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

  // Workboard (§6.4)
  AddToWorkboardRequest: contracts.addToWorkboardRequestSchema,
  ReorderWorkboardRequest: contracts.reorderWorkboardRequestSchema,
  WorkboardItem: contracts.workboardItemSchema,
  WorkboardListResponse: contracts.workboardListResponseSchema,

  // Search (§6.2)
  SearchResponse: contracts.searchResponseSchema,

  // Assets (§6.3)
  AssetDetailResponse: contracts.assetDetailResponseSchema,
  QuoteResponse: contracts.quoteResponseSchema,
  HistoryResponse: contracts.historyResponseSchema,
  DailyClosesResponse: contracts.dailyClosesResponseSchema,

  // Portfolios (§6.8)
  UpdatePortfolioRequest: contracts.updatePortfolioRequestSchema,
  CreateTransactionsRequest: contracts.createTransactionsRequestSchema,
  UpdateTransactionRequest: contracts.updateTransactionRequestSchema,
  PortfolioListResponse: contracts.portfolioListResponseSchema,
  PortfolioResponse: contracts.portfolioResponseSchema,
  UpdatePortfolioResponse: contracts.updatePortfolioResponseSchema,
  PortfolioHistoryResponse: contracts.portfolioHistoryResponseSchema,
  TransactionListResponse: contracts.transactionListResponseSchema,
  CreateTransactionsResponse: z
    .object({ transactions: z.array(contracts.transactionSchema) })
    .strict(),
  UpdateTransactionResponse: z.object({ transaction: contracts.transactionSchema }).strict(),

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

  // Social (§6.9)
  CreateFriendRequestRequest: contracts.createFriendRequestRequestSchema,
  FriendRequestListResponse: contracts.friendRequestListResponseSchema,
  FriendsListResponse: contracts.friendsListResponseSchema,
  SharedPortfolioListResponse: contracts.sharedPortfolioListResponseSchema,
  SharedPortfolioDetailResponse: contracts.sharedPortfolioDetailResponseSchema,
  MySharedListResponse: contracts.mySharedListResponseSchema,

  // Notifications & settings (§6.10, §6.11)
  MarkReadRequest: contracts.markReadRequestSchema,
  NotificationListResponse: contracts.notificationListResponseSchema,
  UpdateNotificationSettingsRequest: contracts.updateNotificationSettingsRequestSchema,
  NotificationSettingsResponse: contracts.notificationSettingsResponseSchema,
};

/** Registered component refs, keyed by component name (literal keys preserved). */
const R = {} as { [K in keyof typeof componentSchemas]: z.ZodTypeAny };
for (const name of Object.keys(componentSchemas) as (keyof typeof componentSchemas)[]) {
  R[name] = registry.register(name, componentSchemas[name]);
}

// The session cookie is the only auth scheme (httpOnly, opaque Redis session id).
const SESSION_SECURITY = 'sessionCookie';
registry.registerComponent('securitySchemes', SESSION_SECURITY, {
  type: 'apiKey',
  in: 'cookie',
  name: 'bt_sid',
  description:
    'httpOnly session cookie set on login (§6.1). Opaque Redis session id; not readable by JS.',
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
    summary: 'Log in with an identifier + password; sets the session cookie.',
    public: true,
    body: R.LoginRequest,
    status: 200,
    response: R.MeResponse,
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
    summary: 'The caller’s portfolios.',
    status: 200,
    response: R.PortfolioListResponse,
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
    summary: 'Friends’ portfolios shared with me.',
    status: 200,
    response: R.SharedPortfolioListResponse,
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
    summary: 'My own portfolios currently shared with friends.',
    status: 200,
    response: R.MySharedListResponse,
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
        'envelope `{ error: { code, message, details? } }`. All routes require a ' +
        'session cookie unless marked public.',
    },
    servers: [{ url: '/api/v1', description: 'BetterTrack API v1 (relative to the API origin).' }],
    security: [{ [SESSION_SECURITY]: [] }],
  });
}

let cached: ReturnType<typeof buildOpenApiDocument> | null = null;

/** The generated document, built once and reused. */
export function getOpenApiDocument() {
  cached ??= buildOpenApiDocument();
  return cached;
}
