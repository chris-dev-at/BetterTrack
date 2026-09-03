import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
  extendZodWithOpenApi,
  type ResponseConfig,
} from '@asteasolutions/zod-to-openapi';
import * as contracts from '@bettertrack/contracts';
import { z } from 'zod';

import { API_VERSION } from '../../version';
import { openApiPathTemplateAcceptsBearer } from '../middleware/bearerAuth';
import { pathRequiresAdminTwoFactorSetup, pathRequiresPasswordChange } from '../middleware/session';

// zod-to-openapi augments the shared zod prototype with `.openapi()`, which the
// registry uses to attach `$ref` ids. There is a single zod instance in the
// workspace, so this also covers the contract schemas we register below.
extendZodWithOpenApi(z);

// zod-to-openapi (7.3.x) has no ZodLazy transformer at all: reaching the strict
// restore contract's recursive JSON-value schema throws unless the instance the
// generator lands on already carries a `type` hint, which short-circuits the
// traversal. The hint therefore cannot live on a separate documentation schema
// registered in `componentSchemas` — `.openapi()` CLONES, while the contract
// parents captured the original instance, so a clone is never what the generator
// walks into. What it can do is stop being permanent: install the hint only for
// the duration of one `generateDocument()` call and put the previous value back,
// so `@bettertrack/contracts` is observably unmodified before and after (nothing
// else runs inside that synchronous call). Runtime request validation always uses
// the untouched recursive schema.
const VAULT_JSON_DOCUMENTATION = {
  type: 'object' as const,
  additionalProperties: true,
  description:
    'A persisted JSON column, passed through verbatim. Documented as an object because ' +
    'OpenAPI 3.0 cannot express a recursive any-JSON union; the endpoint actually accepts ' +
    'any JSON value there (object, array, string, number, boolean or null) and validates it ' +
    'against the recursive contract schema.',
};

// Same generator gap, second instance: 7.3.x has no `ZodCatch` transformer
// either, and the vault import-row `candidates` field is a `.catch(null)` so a
// malformed display-only suggestion list can never make a portfolio
// unrestorable. It is reachable from `PortfolioVaultMoveOutRequest`, so without
// a hint `/openapi.json` and `/docs` 500 for the whole API.
const VAULT_IMPORT_ROW_CANDIDATES_DOCUMENTATION = {
  type: 'array' as const,
  nullable: true,
  items: { type: 'object' as const, additionalProperties: true },
  description:
    'Display-only "did you mean" suggestions for an unresolved import row. Tolerant by ' +
    'design: a value that does not match the strict candidate list is accepted and read ' +
    'back as null rather than rejecting the row, because a suggestion list must never be ' +
    'the reason a portfolio cannot be restored.',
};

// Same generator gap, third instance: the vault import-row `ruleTagIds` field
// is a `.catch(null)` too, so a malformed staging-time tag suggestion can never
// make a portfolio unrestorable. Reachable from `PortfolioVaultMoveOutRequest`,
// so without a hint `/openapi.json` and `/docs` 500 for the whole API.
const VAULT_IMPORT_ROW_RULE_TAG_IDS_DOCUMENTATION = {
  type: 'array' as const,
  nullable: true,
  items: { type: 'string' as const },
  description:
    'Cash-rule tag ids a staged import row was pre-tagged with (#964). Tolerant by design: a ' +
    'value that does not match the strict uuid list is accepted and read back as null rather ' +
    'than rejecting the row, because a staging-time suggestion must never be the reason a ' +
    'portfolio cannot be restored.',
};

// Same generator gap, fourth instance: the vault import-BATCH `understanding`
// field is a `.catch(null)`, so a malformed description of a staging preview can
// never make a portfolio unrestorable. Reachable from
// `PortfolioVaultMoveOutRequest`, so without a hint `/openapi.json` and `/docs`
// 500 for the whole API.
const VAULT_IMPORT_BATCH_UNDERSTANDING_DOCUMENTATION = {
  type: 'object' as const,
  nullable: true,
  description:
    'What the generic import pipeline understood about an uploaded file (#964): the per-column ' +
    'labels with their evidence, the headers it could not name, and the sniffed delimiter, ' +
    'encoding and locales. Tolerant by design: a value that does not match the strict shape is ' +
    'accepted and read back as null rather than rejecting the batch, because a description of a ' +
    'short-lived staging preview must never be the reason a portfolio cannot be restored.',
};

// Same generator gap, fifth instance: the vault import-row `resolvedBy` field is
// a `.catch(null)` for the same reason as its siblings.
const VAULT_IMPORT_ROW_RESOLVED_BY_DOCUMENTATION = {
  type: 'string' as const,
  nullable: true,
  description:
    "Provenance for a staged import row's resolved asset (#964): absent when the pipeline " +
    'matched the instrument exactly, "user" when a person pinned it in the wizard. Tolerant by ' +
    'design: an unrecognized value is read back as null rather than rejecting the row.',
};

// Same generator gap, sixth instance: the vault import-row `kind_undecided`
// field is a `.catch(false)` for the same reason as its siblings — a malformed
// value must not be why a portfolio cannot be restored. Reachable from
// `PortfolioVaultMoveOutRequest`, so without a hint `/openapi.json` and `/docs`
// 500 for the whole API (which is exactly how this one was caught).
const VAULT_IMPORT_ROW_KIND_UNDECIDED_DOCUMENTATION = {
  type: 'boolean' as const,
  description:
    "Whether a staged import row's KIND is still an open question (§16 2026-08-29): the row " +
    'parsed cleanly but nobody has said what it is, so a person may still confirm one. ' +
    'Tolerant by design: an unrecognized value is read back as false — the row then reads as ' +
    'a plain reported line, which is what it was before the affordance existed.',
};

/**
 * Install `type` hints on the contract schemas zod-to-openapi 7.3.x cannot walk
 * (`ZodLazy`, `ZodCatch`) for the duration of ONE `generateDocument()` call,
 * then put the previous values back — so `@bettertrack/contracts` is observably
 * unmodified before and after, and a second build is still correct rather than
 * a one-shot. Runtime request validation always uses the untouched schemas.
 */
type HintableSchema = { _def: { openapi?: unknown }; openapi: (h: unknown) => HintableSchema };

const GENERATOR_GAP_HINTS: ReadonlyArray<readonly [HintableSchema, unknown]> = [
  [contracts.vaultJsonSchema as unknown as HintableSchema, VAULT_JSON_DOCUMENTATION],
  [
    contracts.vaultImportRowCandidatesSchema as unknown as HintableSchema,
    VAULT_IMPORT_ROW_CANDIDATES_DOCUMENTATION,
  ],
  [
    contracts.vaultImportRowRuleTagIdsSchema as unknown as HintableSchema,
    VAULT_IMPORT_ROW_RULE_TAG_IDS_DOCUMENTATION,
  ],
  [
    contracts.vaultImportBatchUnderstandingSchema as unknown as HintableSchema,
    VAULT_IMPORT_BATCH_UNDERSTANDING_DOCUMENTATION,
  ],
  [
    contracts.vaultImportRowResolvedBySchema as unknown as HintableSchema,
    VAULT_IMPORT_ROW_RESOLVED_BY_DOCUMENTATION,
  ],
  [
    contracts.vaultImportRowKindUndecidedSchema as unknown as HintableSchema,
    VAULT_IMPORT_ROW_KIND_UNDECIDED_DOCUMENTATION,
  ],
];

function withVaultJsonDocumentation<T>(generate: () => T): T {
  const restore = GENERATOR_GAP_HINTS.map(([schema, hint]) => {
    const original = schema._def.openapi;
    schema._def.openapi = schema.openapi(hint)._def.openapi;
    return () => {
      schema._def.openapi = original;
    };
  });
  try {
    return generate();
  } finally {
    for (const undo of restore) undo();
  }
}

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
  ReadinessResponse: contracts.readinessResponseSchema,
  VersionResponse: contracts.versionResponseSchema,
  VaultHistoryListResponse: contracts.vaultHistoryListResponseSchema,
  /** Generic session step-up (`POST /auth/reauth`). */
  ReauthRequest: contracts.reauthRequestSchema,
  ParanoidMediaStateResponse: contracts.paranoidMediaStateResponseSchema,
  ParanoidMediaTransitionRequest: contracts.paranoidMediaTransitionRequestSchema,
  ParanoidMediaTransitionResponse: contracts.paranoidMediaTransitionResponseSchema,
  ParanoidServerCandidateMetadata: contracts.paranoidServerCandidateMetadataSchema,
  ParanoidEnableRequest: contracts.paranoidEnableRequestSchema,
  ParanoidEnableResponse: contracts.paranoidEnableResponseSchema,
  ParanoidDisableRequest: contracts.paranoidDisableRequestSchema,
  ParanoidForkProvenanceResponse: contracts.paranoidForkProvenanceResponseSchema,
  ParanoidNormalRevisionResponse: contracts.paranoidNormalRevisionResponseSchema,
  ParanoidDisableResponse: contracts.paranoidDisableResponseSchema,
  RetiredServerPurgeChallengeRequest: contracts.retiredServerPurgeChallengeRequestSchema,
  RetiredServerPurgeChallengeResponse: contracts.retiredServerPurgeChallengeResponseSchema,
  RetiredServerPurgeRequest: contracts.retiredServerPurgeRequestSchema,
  RetiredServerPurgeResponse: contracts.retiredServerPurgeResponseSchema,

  // Per-vault blind blob store (paranoid E1 #1411)
  VaultConfig: contracts.vaultConfigSchema,
  VaultListResponse: contracts.vaultListResponseSchema,
  CreateVaultRequest: contracts.createVaultRequestSchema,
  CreateVaultResponse: contracts.createVaultResponseSchema,
  PatchVaultRequest: contracts.patchVaultRequestSchema,
  PatchVaultResponse: contracts.patchVaultResponseSchema,
  DeleteVaultRequest: contracts.deleteVaultRequestSchema,
  DeleteVaultResponse: contracts.deleteVaultResponseSchema,
  PerVaultMediaStateResponse: contracts.perVaultMediaStateResponseSchema,
  PerVaultMediaTransitionRequest: contracts.perVaultMediaTransitionRequestSchema,
  PerVaultMediaTransitionResponse: contracts.perVaultMediaTransitionResponseSchema,
  PerVaultServerCandidateMetadata: contracts.perVaultServerCandidateMetadataSchema,
  PerVaultRetiredServerPurgeChallengeRequest:
    contracts.perVaultRetiredServerPurgeChallengeRequestSchema,
  PerVaultRetiredServerPurgeChallengeResponse:
    contracts.perVaultRetiredServerPurgeChallengeResponseSchema,
  PerVaultRetiredServerPurgeRequest: contracts.perVaultRetiredServerPurgeRequestSchema,
  PerVaultRetiredServerPurgeResponse: contracts.perVaultRetiredServerPurgeResponseSchema,
  DriveConnection: contracts.driveConnectionSchema,
  DriveConnectionListResponse: contracts.driveConnectionListResponseSchema,
  CreateDriveConnectionRequest: contracts.createDriveConnectionRequestSchema,
  CreateDriveConnectionResponse: contracts.createDriveConnectionResponseSchema,

  // Per-portfolio move pipeline (paranoid E4 #1414, E6 residual #1525)
  PortfolioVaultRevisionResponse: contracts.portfolioVaultRevisionResponseSchema,
  PortfolioVaultLifecycleResponse: contracts.portfolioVaultLifecycleResponseSchema,
  // Lossless capture reads (#1529)
  PortfolioVaultImportCaptureResponse: contracts.portfolioVaultImportCaptureResponseSchema,
  CustomAssetVaultSnapshotsResponse: contracts.customAssetVaultSnapshotsResponseSchema,
  PortfolioVaultMoveInRequest: contracts.portfolioVaultMoveInRequestSchema,
  PortfolioVaultMoveInResponse: contracts.portfolioVaultMoveInResponseSchema,
  PortfolioVaultMoveOutChallengeRequest: contracts.portfolioVaultMoveOutChallengeRequestSchema,
  PortfolioVaultMoveOutChallengeResponse: contracts.portfolioVaultMoveOutChallengeResponseSchema,
  PortfolioVaultMoveOutRequest: contracts.portfolioVaultMoveOutRequestSchema,
  PortfolioVaultMoveOutResponse: contracts.portfolioVaultMoveOutResponseSchema,

  // Auth (§6.1)
  LoginRequest: contracts.loginRequestSchema,
  RegisterRequest: contracts.registerRequestSchema,
  AcceptInviteRequest: contracts.acceptInviteRequestSchema,
  GoogleLinkStatusResponse: contracts.googleLinkStatusResponseSchema,
  GoogleMobileLinkStartResponse: contracts.googleMobileLinkStartResponseSchema,
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
  RememberedDeviceSummary: contracts.rememberedDeviceSummarySchema,
  RememberedDeviceListResponse: contracts.rememberedDeviceListResponseSchema,
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
  // Passkeys / WebAuthn (§13.4 V4-P4)
  Passkey: contracts.passkeySchema,
  PasskeyListResponse: contracts.passkeyListResponseSchema,
  PasskeyRegisterOptionsResponse: contracts.passkeyRegisterOptionsResponseSchema,
  PasskeyRegisterVerifyRequest: contracts.passkeyRegisterVerifyRequestSchema,
  PasskeyRenameRequest: contracts.passkeyRenameRequestSchema,
  PasskeyDeleteRequest: contracts.passkeyDeleteRequestSchema,
  PasskeyLoginOptionsResponse: contracts.passkeyLoginOptionsResponseSchema,
  PasskeyLoginVerifyRequest: contracts.passkeyLoginVerifyRequestSchema,
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
  AdminSessionPolicyResponse: contracts.adminSessionPolicyResponseSchema,
  UpdateAdminSessionPolicyRequest: contracts.updateAdminSessionPolicyRequestSchema,
  AccountDefaultsResponse: contracts.accountDefaultsResponseSchema,
  UpdateAccountDefaultsRequest: contracts.updateAccountDefaultsRequestSchema,
  AdminUser: contracts.adminUserSchema,
  AdminUserListResponse: contracts.adminUserListResponseSchema,
  // People 360 (#1406 W2) — read-only projections + operator notes.
  AdminUserAccessResponse: contracts.adminUserAccessResponseSchema,
  AdminUserSharingResponse: contracts.adminUserSharingResponseSchema,
  AdminUserSupportResponse: contracts.adminUserSupportResponseSchema,
  AdminUserNote: contracts.adminUserNoteSchema,
  AdminUserNoteListResponse: contracts.adminUserNoteListResponseSchema,
  CreateAdminUserNoteRequest: contracts.createAdminUserNoteRequestSchema,
  CreateUserResponse: contracts.createUserResponseSchema,
  ResetPasswordResponse: contracts.resetPasswordResponseSchema,
  AdminInviteListResponse: contracts.adminInviteListResponseSchema,
  CreateInviteResponse: contracts.createInviteResponseSchema,
  AdminStats: contracts.adminStatsSchema,
  AdminHealthResponse: contracts.adminHealthResponseSchema,
  AdminBackupStatusResponse: contracts.adminBackupStatusResponseSchema,
  // Operations cockpit (#1406 W4) — read-only projections of counters the
  // process already keeps. Neither has a request body: there is no write here.
  AdminOpsJobsResponse: contracts.adminOpsJobsResponseSchema,
  AdminOpsProvidersResponse: contracts.adminOpsProvidersResponseSchema,
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
  // Admin monitoring / Diagnostics (§13.5 V5-P2 arc (a), owner 2026-07-19)
  MonitoringStatusResponse: contracts.monitoringStatusResponseSchema,
  UpdateMonitoringExternalAccessRequest: contracts.updateMonitoringExternalAccessRequestSchema,
  // Local-AI provider layer (§13.5 V5-P12, §16 2026-07-22 — LOCAL OLLAMA ONLY)
  AiSettingsResponse: contracts.aiSettingsResponseSchema,
  UpdateAiSettingsRequest: contracts.updateAiSettingsRequestSchema,
  AiTestConnectionRequest: contracts.aiTestConnectionRequestSchema,
  AiTestConnectionResponse: contracts.aiTestConnectionResponseSchema,
  AiTestRequest: contracts.aiTestRequestSchema,
  AiTestRequestResponse: contracts.aiTestRequestResponseSchema,
  AiCapabilityResponse: contracts.aiCapabilityResponseSchema,
  // User-facing AI features (§13.5 V5-P12 2/2 — insights + NL conglomerate builder)
  AiInsightsRequest: contracts.aiInsightsRequestSchema,
  AiInsightsResponse: contracts.aiInsightsResponseSchema,
  AiConglomerateDraftRequest: contracts.aiConglomerateDraftRequestSchema,
  AiConglomerateDraftResponse: contracts.aiConglomerateDraftResponseSchema,
  // Admin API-key governance (§13.5 V5-P10, issue 2/2)
  ApiKeyTier: contracts.apiKeyTierSchema,
  ApiKeyTierListResponse: contracts.apiKeyTierListResponseSchema,
  CreateApiKeyTierRequest: contracts.createApiKeyTierRequestSchema,
  UpdateApiKeyTierRequest: contracts.updateApiKeyTierRequestSchema,
  AssignApiKeyTierRequest: contracts.assignApiKeyTierRequestSchema,
  AdminApiKey: contracts.adminApiKeySchema,
  AdminApiKeyListResponse: contracts.adminApiKeyListResponseSchema,
  ApiKeyAuditResponse: contracts.apiKeyAuditResponseSchema,

  // Runtime feature kill-switches (§13.5 V5-P2 arc (c))
  FeatureFlagsResponse: contracts.featureFlagsResponseSchema,
  AdminFeatureFlagsResponse: contracts.adminFeatureFlagsResponseSchema,
  UpdateFeatureFlagRequest: contracts.updateFeatureFlagRequestSchema,

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
  AssetQuotesResponse: contracts.assetQuotesResponseSchema,
  AssetSparklinesResponse: contracts.assetSparklinesResponseSchema,
  HistoryResponse: contracts.historyResponseSchema,
  DailyClosesResponse: contracts.dailyClosesResponseSchema,

  // Market intelligence (§13.5 V5-P5)
  MarketIntelStatusResponse: contracts.marketIntelStatusResponseSchema,
  DividendsResponse: contracts.dividendsResponseSchema,
  EarningsResponse: contracts.earningsResponseSchema,
  EarningsCalendarResponse: contracts.earningsCalendarResponseSchema,
  NewsResponse: contracts.newsResponseSchema,
  NewsDigestResponse: contracts.newsDigestResponseSchema,
  SplitsResponse: contracts.splitsResponseSchema,
  FundamentalsResponse: contracts.fundamentalsResponseSchema,
  DividendCalendarResponse: contracts.dividendCalendarResponseSchema,
  ProjectedDividendIncomeResponse: contracts.projectedDividendIncomeResponseSchema,

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
  UpdateCashMovementRequest: contracts.updateCashMovementRequestSchema,
  CashDeletionResponse: contracts.cashDeletionResponseSchema,
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
  PortfolioTaxSettingsResponse: contracts.portfolioTaxSettingsResponseSchema,
  TaxYearChangesResponse: contracts.taxYearChangesResponseSchema,
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
  ConglomerateResolvedResponse: contracts.conglomerateResolvedResponseSchema,
  AllocateResponse: contracts.allocateResponseSchema,

  // Backtest (§6.6, §13.5 V5-P6)
  BacktestPreviewRequest: contracts.backtestPreviewRequestSchema,
  BacktestResponse: contracts.backtestResponseSchema,
  BacktestComparisonRequest: contracts.backtestComparisonRequestSchema,
  BacktestComparisonResponse: contracts.backtestComparisonResponseSchema,
  SharedSandboxPreviewRequest: contracts.sharedSandboxPreviewRequestSchema,
  SharedSandboxPreviewResponse: contracts.sharedSandboxPreviewResponseSchema,

  // Ideas (§13.4 V4-P9)
  IdeaListResponse: contracts.ideaListResponseSchema,
  IdeaResponse: contracts.ideaResponseSchema,

  // Authenticated in-app feedback (#1315)
  CreateFeedbackRequest: contracts.createFeedbackRequestSchema,
  CreateFeedbackResponse: contracts.createFeedbackResponseSchema,
  MyFeedbackResponse: contracts.myFeedbackResponseSchema,
  FeedbackThreadResponse: contracts.feedbackThreadResponseSchema,
  SendFeedbackMessageRequest: contracts.sendFeedbackMessageRequestSchema,
  SendFeedbackMessageResponse: contracts.sendFeedbackMessageResponseSchema,
  AdminFeedbackListResponse: contracts.adminFeedbackListResponseSchema,
  AdminFeedbackSubmission: contracts.adminFeedbackSubmissionSchema,
  UpdateFeedbackStatusRequest: contracts.updateFeedbackStatusRequestSchema,
  UpdateFeedbackStatusResponse: contracts.updateFeedbackStatusResponseSchema,
  UpdateFeedbackArchiveRequest: contracts.updateFeedbackArchiveRequestSchema,
  UpdateFeedbackArchiveResponse: contracts.updateFeedbackArchiveResponseSchema,
  UpdateFeedbackRequest: contracts.updateFeedbackRequestSchema,
  UpdateFeedbackResponse: contracts.updateFeedbackResponseSchema,

  // Broker CSV imports (§13.4 V4-P8)
  ImportBrokerListResponse: contracts.importBrokerListResponseSchema,
  ImportPreviewResponse: contracts.importPreviewResponseSchema,
  ApplyImportRequest: contracts.applyImportRequestSchema,
  ResolveImportRowRequest: contracts.resolveImportRowRequestSchema,
  ApplyImportResponse: contracts.applyImportResponseSchema,
  CreateIdeaRequest: contracts.createIdeaRequestSchema,
  UpdateIdeaRequest: contracts.updateIdeaRequestSchema,

  // Standing orders (§13.5 V5-P6b)
  StandingOrder: contracts.standingOrderSchema,
  StandingOrderListResponse: contracts.standingOrderListResponseSchema,
  StandingOrderRunListResponse: contracts.standingOrderRunListResponseSchema,
  CreateStandingOrderRequest: contracts.createStandingOrderRequestSchema,
  UpdateStandingOrderRequest: contracts.updateStandingOrderRequestSchema,

  // Cash flow — classification on the portfolio cash ledger (V5 cash fusion)
  CashTagListResponse: contracts.cashTagListResponseSchema,
  CashTagResponse: contracts.cashTagResponseSchema,
  CreateCashTagRequest: contracts.createCashTagRequestSchema,
  UpdateCashTagRequest: contracts.updateCashTagRequestSchema,
  SetCashMovementTagsRequest: contracts.setCashMovementTagsRequestSchema,
  CashMovementTagsResponse: contracts.cashMovementTagsResponseSchema,
  CashBudgetListResponse: contracts.cashBudgetListResponseSchema,
  CashBudgetRawListResponse: contracts.cashBudgetRawListResponseSchema,
  CashBudgetResponse: contracts.cashBudgetResponseSchema,
  CreateCashBudgetRequest: contracts.createCashBudgetRequestSchema,
  UpdateCashBudgetRequest: contracts.updateCashBudgetRequestSchema,
  CashRuleListResponse: contracts.cashRuleListResponseSchema,
  CashRuleResponse: contracts.cashRuleResponseSchema,
  CashRuleApplyResponse: contracts.cashRuleApplyResponseSchema,
  CashRulePreviewRequest: contracts.cashRulePreviewRequestSchema,
  CashRulePreviewResponse: contracts.cashRulePreviewResponseSchema,
  CreateCashRuleRequest: contracts.createCashRuleRequestSchema,
  UpdateCashRuleRequest: contracts.updateCashRuleRequestSchema,
  CashMonthlySummaryResponse: contracts.cashMonthlySummaryResponseSchema,
  CashTrendResponse: contracts.cashTrendResponseSchema,

  // Expense tracking (§13.5 V5-P9)
  ExpenseCategoryListResponse: contracts.expenseCategoryListResponseSchema,
  ExpenseCategoryResponse: contracts.expenseCategoryResponseSchema,
  CreateExpenseCategoryRequest: contracts.createExpenseCategoryRequestSchema,
  UpdateExpenseCategoryRequest: contracts.updateExpenseCategoryRequestSchema,
  ExpenseTransactionListResponse: contracts.expenseTransactionListResponseSchema,
  ExpenseTransactionResponse: contracts.expenseTransactionResponseSchema,
  CreateExpenseTransactionRequest: contracts.createExpenseTransactionRequestSchema,
  UpdateExpenseTransactionRequest: contracts.updateExpenseTransactionRequestSchema,
  RecategorizeExpenseTransactionRequest: contracts.recategorizeExpenseTransactionRequestSchema,
  ExpenseRuleListResponse: contracts.expenseRuleListResponseSchema,
  ExpenseRuleResponse: contracts.expenseRuleResponseSchema,
  CreateExpenseRuleRequest: contracts.createExpenseRuleRequestSchema,
  UpdateExpenseRuleRequest: contracts.updateExpenseRuleRequestSchema,
  ExpenseBankListResponse: contracts.expenseBankListResponseSchema,
  ExpenseImportPreviewResponse: contracts.expenseImportPreviewResponseSchema,
  ExpenseImportApplyResponse: contracts.expenseImportApplyResponseSchema,
  ExpenseMonthlySummaryResponse: contracts.expenseMonthlySummaryResponseSchema,
  ExpenseTrendResponse: contracts.expenseTrendResponseSchema,
  ExpenseBudgetListResponse: contracts.expenseBudgetListResponseSchema,
  ExpenseBudgetResponse: contracts.expenseBudgetResponseSchema,
  CreateExpenseBudgetRequest: contracts.createExpenseBudgetRequestSchema,
  UpdateExpenseBudgetRequest: contracts.updateExpenseBudgetRequestSchema,

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
  // Friend groups (§13.5 V5-P8)
  FriendGroup: contracts.friendGroupSchema,
  FriendGroupListResponse: contracts.friendGroupListResponseSchema,
  CreateFriendGroupRequest: contracts.createFriendGroupRequestSchema,
  RenameFriendGroupRequest: contracts.renameFriendGroupRequestSchema,
  AddGroupMemberRequest: contracts.addGroupMemberRequestSchema,
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

  // Comments + reactions on shared items (§13.5 V5-P8)
  CommentThreadResponse: contracts.commentThreadResponseSchema,
  CreateCommentRequest: contracts.createCommentRequestSchema,
  CreateCommentResponse: contracts.createCommentResponseSchema,
  ToggleReactionRequest: contracts.toggleReactionRequestSchema,
  ReactionListResponse: contracts.reactionListResponseSchema,

  // MIRRORCHAIN group portfolios (§13.5 V5-P7 M3)
  CreateMirrorChainRequest: contracts.createMirrorChainRequestSchema,
  ConvertMirrorChainRequest: contracts.convertMirrorChainRequestSchema,
  InviteMirrorMemberRequest: contracts.inviteMirrorMemberRequestSchema,
  SetMirrorMemberRoleRequest: contracts.setMirrorMemberRoleRequestSchema,
  TransferMirrorOwnershipRequest: contracts.transferMirrorOwnershipRequestSchema,
  RenameMirrorChainRequest: contracts.renameMirrorChainRequestSchema,
  MirrorChainSummary: contracts.mirrorChainSummarySchema,
  MirrorChainListResponse: contracts.mirrorChainListResponseSchema,
  MirrorMemberListResponse: contracts.mirrorMemberListResponseSchema,
  MirrorInviteListResponse: contracts.mirrorInviteListResponseSchema,
  MirrorAcceptInviteResponse: contracts.mirrorAcceptInviteResponseSchema,
  MirrorActivityResponse: contracts.mirrorActivityResponseSchema,

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
  HomeLayoutResponse: contracts.homeLayoutResponseSchema,
  UpdateHomeLayoutRequest: contracts.updateHomeLayoutRequestSchema,
  WidgetLayoutResponse: contracts.widgetLayoutResponseSchema,
  UpdateWidgetLayoutRequest: contracts.updateWidgetLayoutRequestSchema,

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
  ExportDownloadRequest: contracts.exportDownloadRequestSchema,

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

  // Outbound webhooks (§13.5 V5-P10)
  CreateWebhookSubscriptionRequest: contracts.createWebhookSubscriptionRequestSchema,
  UpdateWebhookSubscriptionRequest: contracts.updateWebhookSubscriptionRequestSchema,
  WebhookSubscriptionListResponse: contracts.webhookSubscriptionListResponseSchema,
  WebhookSubscriptionResponse: contracts.webhookSubscriptionResponseSchema,
  CreateWebhookSubscriptionResponse: contracts.createWebhookSubscriptionResponseSchema,
  WebhookDeliveryListResponse: contracts.webhookDeliveryListResponseSchema,

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
  OAuthDenyRequest: contracts.oauthDenyRequestSchema,
  OAuthDenyResponse: contracts.oauthDenyResponseSchema,
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

// Per-doc CAS/readback headers (E1 #1411). These are machine-readable rather
// than prose-only so generated clients can actually perform the blind-store
// protocol without guessing header names or response metadata.
const perVaultConditionalReadHeaders = z.object({
  'If-None-Match': z.string().optional().openapi({
    description:
      'Optional strong document ETag such as `"7"`; a match returns 304 without ciphertext.',
    example: '"7"',
  }),
});
const perVaultCasWriteHeaders = z.object({
  'If-Match': z.string().optional().openapi({
    description:
      'Strong ETag of the current document version for replacement, for example `"7"`. Send exactly one CAS precondition.',
    example: '"7"',
  }),
  'If-None-Match': z.literal('*').optional().openapi({
    description: 'Send `*` only for first creation. Send exactly one of If-None-Match or If-Match.',
  }),
});
const perVaultEtagResponseHeaders = z.object({
  ETag: z.string().openapi({
    description: 'Strong ETag carrying this document’s integer CAS version.',
    example: '"7"',
  }),
});
const perVaultHistoryResponseHeaders = perVaultEtagResponseHeaders.extend({
  [contracts.VAULT_HISTORY_CREATED_AT_HEADER]: z.string().datetime().openapi({
    description: 'When this ciphertext version entered bounded server history.',
  }),
  [contracts.VAULT_HISTORY_SIZE_BYTES_HEADER]: z.string().openapi({
    description: 'Opaque envelope byte length as a base-10 integer.',
    example: '4096',
  }),
  [contracts.VAULT_HISTORY_MEDIUM_HEADER]: z.literal('server').openapi({
    description: 'Storage medium holding this retained ciphertext.',
  }),
});
const perVaultCandidateReadbackResponseHeaders = perVaultEtagResponseHeaders.extend({
  [contracts.VAULT_SERVER_CANDIDATE_ID_HEADER]: z.string().uuid().openapi({
    description: 'Identity of the inactive candidate that was read back.',
  }),
  [contracts.VAULT_SERVER_CANDIDATE_EXPIRES_AT_HEADER]: z.string().datetime().openapi({
    description: 'Expiry of this inactive candidate and its readback receipt.',
  }),
  [contracts.VAULT_SERVER_CANDIDATE_READBACK_HEADER]: z.string().openapi({
    description:
      'Opaque short-lived receipt supplied in the matching full-set media-transition attestation.',
  }),
});
const noStoreResponseHeaders = z.object({
  'Cache-Control': z.literal('no-store').openapi({
    description:
      'Sensitive transition/capture responses are never stored by browsers or intermediary caches.',
  }),
});

// ── Endpoint table ──────────────────────────────────────────────────────────
type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

interface EndpointDef {
  method: Method;
  path: string;
  tag: string;
  summary: string;
  /** Additional wire semantics that are too important to hide in schema fields. */
  description?: string;
  /** Public (`P`) routes need no session; everything else is session-guarded. */
  public?: boolean;
  params?: z.AnyZodObject;
  query?: z.AnyZodObject;
  body?: z.ZodTypeAny;
  /** Additional request headers derived into OpenAPI parameters. */
  requestHeaders?: z.AnyZodObject;
  /**
   * Request body media type; defaults to JSON. The CSV upload (§13.4 V4-P8) is
   * the one `multipart/form-data` endpoint — its file part is described in its
   * body schema via `.openapi({ format: 'binary' })`.
   */
  bodyContentType?: string;
  status: number;
  /** Success response schema; omit for empty (204) responses. */
  response?: z.ZodTypeAny;
  /** Headers present on the success response, including empty 204 responses. */
  responseHeaders?: z.AnyZodObject;
  /** Apply Cache-Control: no-store to every documented response for this operation. */
  noStore?: boolean;
  /** Stable non-validation error statuses emitted by this operation. */
  errorResponses?: Readonly<Record<number, string>>;
  /**
   * Documents the bodyless `304 Not Modified` a conditional read answers with
   * (#1498). Kept apart from `errorResponses` because a 304 carries no error
   * envelope — no body at all — only the success response's validators.
   */
  notModified?: string;
  /** Contract body returned with HTTP 503 by readiness-style public probes. */
  unavailableResponse?: z.ZodTypeAny;
  /**
   * Stable `ApiError.error.code` values emitted by this operation beyond the
   * shared authentication-state and admin-step-up guards.
   */
  errorCodes?: readonly string[];
  /**
   * Success response media type; defaults to JSON. Paranoid-vault ciphertext
   * reads use `application/octet-stream` and describe their opaque bodies with a
   * binary schema.
   */
  responseContentType?: string;
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
    path: '/health/ready',
    tag: 'Meta',
    summary: 'Postgres and Redis readiness probe.',
    public: true,
    status: 200,
    response: R.ReadinessResponse,
    unavailableResponse: R.ReadinessResponse,
  },
  {
    method: 'get',
    path: '/feature-flags',
    tag: 'Meta',
    summary:
      'Effective runtime feature flags advertised to the SPA (killed features hide client-side).',
    status: 200,
    response: R.FeatureFlagsResponse,
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
    method: 'post',
    path: '/account/paranoid/enable',
    tag: 'Account',
    summary:
      'Atomically verify encrypted media, purge cleartext portfolio data, revoke sharing, and enable paranoid mode.',
    body: R.ParanoidEnableRequest,
    status: 200,
    response: R.ParanoidEnableResponse,
  },
  {
    method: 'post',
    path: '/account/paranoid/disable',
    tag: 'Account',
    summary:
      'Atomically rehydrate a complete unlocked vault and return the account to normal mode.',
    body: R.ParanoidDisableRequest,
    status: 200,
    response: R.ParanoidDisableResponse,
  },
  {
    method: 'get',
    path: '/account/paranoid/fork-provenance',
    tag: 'Account',
    summary:
      'The caller’s own severed-MIRRORCHAIN-fork identity map, captured into the encrypted vault before enable purges it. No active membership, co-member identity, or chain metadata.',
    status: 200,
    response: R.ParanoidForkProvenanceResponse,
  },
  {
    method: 'get',
    path: '/account/paranoid/normal-revision',
    tag: 'Account',
    summary:
      'The capture↔commit CAS token: an opaque digest of the caller’s purgeable rows, read before the enable capture and re-derived under the account lock at commit. No portfolio content.',
    status: 200,
    response: R.ParanoidNormalRevisionResponse,
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
    method: 'post',
    path: '/account/export/download',
    tag: 'Account',
    summary:
      'Consume a one-time token from the request body and download the ready export zip; foreign, expired, or replayed tokens 404.',
    body: R.ExportDownloadRequest,
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
    method: 'post',
    path: '/auth/first-run/complete',
    tag: 'Auth',
    summary: 'Mark first-run setup as finished or dismissed (idempotent, set-once).',
    status: 200,
    response: R.MeResponse,
  },
  {
    method: 'post',
    path: '/auth/fresh-start-notice/acknowledge',
    tag: 'Auth',
    summary: 'Acknowledge the one-time paranoid fresh-start notice (§17, idempotent, set-once).',
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
    method: 'get',
    path: '/auth/remembered-devices',
    tag: 'Auth',
    summary: 'List the caller’s live remembered-device bindings by safe management handle.',
    status: 200,
    response: R.RememberedDeviceListResponse,
  },
  {
    method: 'delete',
    path: '/auth/remembered-devices/{handle}',
    tag: 'Auth',
    summary: 'Idempotently revoke one remembered-device binding by its safe handle.',
    params: contracts.rememberedDeviceHandleParamSchema,
    status: 200,
    response: R.OkResponse,
  },
  {
    method: 'delete',
    path: '/auth/remembered-devices',
    tag: 'Auth',
    summary: 'Forget every remembered-device binding owned by the caller.',
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
  // Passkeys / WebAuthn (§13.4 V4-P4)
  {
    method: 'get',
    path: '/auth/passkeys',
    tag: 'Auth',
    summary: 'List the caller’s registered passkeys (newest first).',
    status: 200,
    response: R.PasskeyListResponse,
  },
  {
    method: 'post',
    path: '/auth/passkeys/register/options',
    tag: 'Auth',
    summary: 'Begin registering a passkey — WebAuthn creation options + a single-use challenge.',
    status: 200,
    response: R.PasskeyRegisterOptionsResponse,
  },
  {
    method: 'post',
    path: '/auth/passkeys/register/verify',
    tag: 'Auth',
    summary: 'Finish registering a passkey (re-auth-gated); persists the credential.',
    body: R.PasskeyRegisterVerifyRequest,
    status: 201,
    response: R.Passkey,
  },
  {
    method: 'patch',
    path: '/auth/passkeys/{id}',
    tag: 'Auth',
    summary: 'Rename one of the caller’s passkeys.',
    body: R.PasskeyRenameRequest,
    status: 200,
    response: R.Passkey,
  },
  {
    method: 'delete',
    path: '/auth/passkeys/{id}',
    tag: 'Auth',
    summary: 'Delete one of the caller’s passkeys (re-auth-gated); the last one may be removed.',
    body: R.PasskeyDeleteRequest,
    status: 200,
    response: R.OkResponse,
  },
  {
    method: 'post',
    path: '/auth/passkeys/login/options',
    tag: 'Auth',
    summary:
      'Begin a passkey sign-in — usernameless WebAuthn request options + a challenge handle.',
    public: true,
    status: 200,
    response: R.PasskeyLoginOptionsResponse,
  },
  {
    method: 'post',
    path: '/auth/passkeys/login/verify',
    tag: 'Auth',
    summary: 'Complete a passkey sign-in; sets the session cookie (no follow-up 2FA challenge).',
    public: true,
    body: R.PasskeyLoginVerifyRequest,
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
    method: 'post',
    path: '/auth/google/link/start',
    tag: 'Auth',
    summary:
      'Mint a short-lived, hashed, one-time Google LINK ticket bound to the authenticated account and return its authorization URL. Bearers require account:security; no redirect target is accepted. 404 when Google is not configured.',
    status: 200,
    response: R.GoogleMobileLinkStartResponse,
  },
  {
    method: 'get',
    path: '/auth/google/link/callback',
    tag: 'Auth',
    summary:
      'Public Google return leg for a native LINK ticket. Atomically consumes state, links only the server-bound account, never mints a session, and redirects only to BetterTrackMobile’s registered deep link with stable success/error parameters. 404 when Google is not configured.',
    public: true,
    query: contracts.googleMobileLinkCallbackQuerySchema,
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
  // Admin session policy (§13.5 V5-P13c): the early-expiring admin session
  // lifetime (6–24 h). No step-up 2FA re-challenge — the guarantee is the short
  // session, not a re-prompt (#430 rejected).
  {
    method: 'get',
    path: '/admin/security/session-policy',
    tag: 'Admin',
    summary: 'The admin session absolute lifetime (hours) + the allowed window.',
    status: 200,
    response: R.AdminSessionPolicyResponse,
  },
  {
    method: 'patch',
    path: '/admin/security/session-policy',
    tag: 'Admin',
    summary: 'Set the admin session lifetime (6–24 h, audit-logged; live on next request).',
    body: R.UpdateAdminSessionPolicyRequest,
    status: 200,
    response: R.AdminSessionPolicyResponse,
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
    path: '/admin/ops/backup-status',
    tag: 'Admin',
    summary:
      'Backup and restore-drill readiness, projected read-only from the scheduler status file.',
    status: 200,
    response: R.AdminBackupStatusResponse,
  },
  {
    method: 'get',
    path: '/admin/ops/jobs',
    tag: 'Admin',
    summary: 'Queue depths, repeatable schedules with next/last run, and the dead-letter list.',
    description:
      'Read-only operations cockpit projection (#1406 W4). Job payloads are never included; ' +
      'a scheduled run reports its own counts only as numbers. `available: false` means this ' +
      'process holds no queue registry — not that the queues are empty.',
    status: 200,
    response: R.AdminOpsJobsResponse,
  },
  {
    method: 'get',
    path: '/admin/ops/providers',
    tag: 'Admin',
    summary: 'Per-capability circuit-breaker state, provider call outcomes and market-cache rates.',
    description:
      'Read-only (#1406 W4). Counters are process-local and reset on restart — `sampledSince` ' +
      'is their epoch. There is no upstream quota gauge: the provider is keyless and no ' +
      'authoritative quota exists to report.',
    status: 200,
    response: R.AdminOpsProvidersResponse,
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
    path: '/admin/feature-flags',
    tag: 'Admin',
    summary:
      'Runtime feature kill-switches (realtime/live/chat/alerts/imports/AI) with change metadata.',
    status: 200,
    response: R.AdminFeatureFlagsResponse,
  },
  // Local-AI provider settings (§13.5 V5-P12 — LOCAL OLLAMA ONLY; no secrets).
  {
    method: 'get',
    path: '/admin/ai/settings',
    tag: 'Admin',
    summary: 'Local-AI provider settings (Ollama endpoint + model + per-user daily cap).',
    status: 200,
    response: R.AiSettingsResponse,
  },
  {
    method: 'patch',
    path: '/admin/ai/settings',
    tag: 'Admin',
    summary: 'Update the local-AI endpoint / model / daily cap (audit-logged; live next request).',
    body: R.UpdateAiSettingsRequest,
    status: 200,
    response: R.AiSettingsResponse,
  },
  {
    method: 'post',
    path: '/admin/ai/test-connection',
    tag: 'Admin',
    summary: 'Probe an Ollama endpoint and list the models it serves (feeds the model picker).',
    body: R.AiTestConnectionRequest,
    status: 200,
    response: R.AiTestConnectionResponse,
  },
  {
    method: 'post',
    path: '/admin/ai/test-request',
    tag: 'Admin',
    summary:
      'Send a real prompt to an Ollama endpoint/model and return the reply + round-trip latency (diagnostic; no daily cap spend).',
    body: R.AiTestRequest,
    status: 200,
    response: R.AiTestRequestResponse,
  },
  // User-facing AI capability (§13.5 V5-P12): availability + remaining daily cap.
  {
    method: 'get',
    path: '/ai/capability',
    tag: 'AI',
    summary: 'Whether AI is available for the caller and how much of their daily cap remains.',
    status: 200,
    response: R.AiCapabilityResponse,
  },
  // User-facing AI features (§13.5 V5-P12 2/2) — gated on `requireFeature('ai')`.
  {
    method: 'post',
    path: '/ai/insights',
    tag: 'AI',
    summary:
      'Portfolio insights: service-computed observations phrased by the local model (informational only).',
    body: R.AiInsightsRequest,
    status: 200,
    response: R.AiInsightsResponse,
  },
  {
    method: 'post',
    path: '/ai/conglomerate-draft',
    tag: 'AI',
    summary:
      'Turn a natural-language basket description into a reviewed builder draft (assets resolved via the local catalog).',
    body: R.AiConglomerateDraftRequest,
    status: 200,
    response: R.AiConglomerateDraftResponse,
  },
  {
    method: 'patch',
    path: '/admin/feature-flags/{key}',
    tag: 'Admin',
    summary: 'Flip one feature kill-switch (audit-logged; effective on the next request).',
    params: contracts.featureFlagKeyParamSchema,
    body: R.UpdateFeatureFlagRequest,
    status: 200,
    response: R.AdminFeatureFlagsResponse,
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
    path: '/admin/users/{id}',
    tag: 'Admin',
    summary: 'One account (#1406 W2 — retires the download-the-whole-list detail read).',
    params: contracts.idParamSchema,
    status: 200,
    response: R.AdminUser,
  },
  {
    method: 'get',
    path: '/admin/users/{id}/access',
    tag: 'Admin',
    summary: "One account's live sessions, API keys, OAuth grants and linked identities.",
    description:
      'Read-only. Session ids are public revocation handles, never session tokens; ' +
      'linked identities carry no provider subject and no provider email.',
    params: contracts.idParamSchema,
    status: 200,
    response: R.AdminUserAccessResponse,
  },
  {
    method: 'get',
    path: '/admin/users/{id}/sharing',
    tag: 'Admin',
    summary: 'How exposed one account is, as counts only.',
    description:
      'Counts, never an inventory: PROJECTPLAN §3 forbids admin browsing of user ' +
      'portfolios, and #1406 defers the sharing inventory. No names, no tokens.',
    params: contracts.idParamSchema,
    status: 200,
    response: R.AdminUserSharingResponse,
  },
  {
    method: 'get',
    path: '/admin/users/{id}/support',
    tag: 'Admin',
    summary: "One account's support submissions, summarized (no message bodies).",
    params: contracts.idParamSchema,
    query: contracts.adminUserSupportQuerySchema,
    status: 200,
    response: R.AdminUserSupportResponse,
  },
  {
    method: 'get',
    path: '/admin/users/{id}/notes',
    tag: 'Admin',
    summary: 'Admin-private operator notes on one account, newest first.',
    params: contracts.idParamSchema,
    status: 200,
    response: R.AdminUserNoteListResponse,
  },
  {
    method: 'post',
    path: '/admin/users/{id}/notes',
    tag: 'Admin',
    summary: 'Add an admin-private operator note. Audited; never shown to the user.',
    params: contracts.idParamSchema,
    body: contracts.createAdminUserNoteRequestSchema,
    status: 201,
    response: R.AdminUserNote,
  },
  {
    method: 'delete',
    path: '/admin/users/{id}/notes/{noteId}',
    tag: 'Admin',
    summary: 'Remove an operator note. Audited; 404 when the note is not on this account.',
    params: contracts.adminUserNoteParamSchema,
    status: 200,
    response: R.OkResponse,
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
  {
    method: 'get',
    path: '/admin/feedback',
    tag: 'Admin',
    summary: 'Category-priority inbox for authenticated web and native feedback.',
    query: contracts.adminFeedbackListQuerySchema,
    status: 200,
    response: R.AdminFeedbackListResponse,
  },
  {
    method: 'get',
    path: '/admin/feedback/{id}',
    tag: 'Admin',
    summary: 'Read one feedback submission for the helpdesk split pane.',
    params: contracts.idParamSchema,
    status: 200,
    response: R.AdminFeedbackSubmission,
  },
  {
    method: 'patch',
    path: '/admin/feedback/{id}',
    tag: 'Admin',
    summary: 'Update one feedback submission lifecycle status or workspace archive state.',
    errorCodes: contracts.FEEDBACK_STATUS_ERROR_CODES,
    params: contracts.idParamSchema,
    body: R.UpdateFeedbackRequest,
    status: 200,
    response: R.UpdateFeedbackResponse,
  },
  {
    method: 'get',
    path: '/admin/feedback/{id}/messages',
    tag: 'Admin',
    summary: 'Read one submission’s admin ↔ submitter support thread.',
    params: contracts.idParamSchema,
    query: contracts.feedbackThreadQuerySchema,
    status: 200,
    response: R.FeedbackThreadResponse,
  },
  {
    method: 'post',
    path: '/admin/feedback/{id}/messages',
    tag: 'Admin',
    summary: 'Reply to a feedback submission as the authenticated admin.',
    params: contracts.idParamSchema,
    body: R.SendFeedbackMessageRequest,
    status: 201,
    response: R.SendFeedbackMessageResponse,
  },
  {
    method: 'post',
    path: '/admin/feedback/{id}/read',
    tag: 'Admin',
    summary: 'Mark one feedback support thread read for the admin side.',
    params: contracts.idParamSchema,
    status: 200,
    response: R.OkResponse,
  },
  {
    method: 'get',
    path: '/admin/monitoring/status',
    tag: 'Admin',
    summary: 'Grafana/Prometheus reachability + the external-access posture (Diagnostics panel).',
    status: 200,
    response: R.MonitoringStatusResponse,
  },
  {
    method: 'patch',
    path: '/admin/monitoring/external-access',
    tag: 'Admin',
    summary: 'Flip the runtime kill-switch for admin-proxied external Grafana access.',
    body: R.UpdateMonitoringExternalAccessRequest,
    status: 200,
    response: R.MonitoringStatusResponse,
  },

  // API-key governance (§13.5 V5-P10, issue 2/2)
  {
    method: 'get',
    path: '/admin/api-key-tiers',
    tag: 'Admin',
    summary: 'List the admin-configurable API-key rate tiers (name/limit/window).',
    status: 200,
    response: R.ApiKeyTierListResponse,
  },
  {
    method: 'post',
    path: '/admin/api-key-tiers',
    tag: 'Admin',
    summary: 'Define a new API-key rate tier.',
    body: R.CreateApiKeyTierRequest,
    status: 201,
    response: R.ApiKeyTier,
  },
  {
    method: 'patch',
    path: '/admin/api-key-tiers/{id}',
    tag: 'Admin',
    summary: 'Edit an API-key rate tier (name/limit/window/default).',
    params: contracts.idParamSchema,
    body: R.UpdateApiKeyTierRequest,
    status: 200,
    response: R.ApiKeyTier,
  },
  {
    method: 'delete',
    path: '/admin/api-key-tiers/{id}',
    tag: 'Admin',
    summary: 'Delete a non-default API-key rate tier (its keys fall back to the default).',
    params: contracts.idParamSchema,
    status: 204,
  },
  {
    method: 'get',
    path: '/admin/api-keys',
    tag: 'Admin',
    summary: 'List every user’s API keys with their assigned tier (governance surface).',
    status: 200,
    response: R.AdminApiKeyListResponse,
  },
  {
    method: 'patch',
    path: '/admin/api-keys/{id}/tier',
    tag: 'Admin',
    summary: 'Assign an API key to a tier (null ⇒ the default tier).',
    params: contracts.idParamSchema,
    body: R.AssignApiKeyTierRequest,
    status: 200,
    response: R.AdminApiKey,
  },
  {
    method: 'get',
    path: '/admin/api-keys/{id}/audit',
    tag: 'Admin',
    summary: 'The bounded, PII-scrubbed per-key request-log audit trail.',
    params: contracts.idParamSchema,
    status: 200,
    response: R.ApiKeyAuditResponse,
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
    path: '/assets/quotes',
    tag: 'Assets',
    summary:
      'Latest quotes for an aggregate asset id set; ids the caller cannot see are omitted, ids the provider could not price are listed in `failed`.',
    query: contracts.assetBatchQuerySchema,
    status: 200,
    response: R.AssetQuotesResponse,
  },
  {
    method: 'get',
    path: '/assets/sparklines',
    tag: 'Assets',
    summary:
      'Compact one-month daily sparklines for an aggregate asset id set; invisible ids are omitted, ids whose series could not be read are listed in `failed`.',
    query: contracts.assetBatchQuerySchema,
    status: 200,
    response: R.AssetSparklinesResponse,
  },
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

  // Market intelligence (§13.5 V5-P5)
  {
    method: 'get',
    path: '/assets/{id}/intel',
    tag: 'Assets',
    summary: 'Market-intelligence capability descriptor (gate + per-capability availability).',
    params: contracts.assetIdParamSchema,
    status: 200,
    response: R.MarketIntelStatusResponse,
  },
  {
    method: 'get',
    path: '/assets/{id}/intel/dividends',
    tag: 'Assets',
    summary: 'Dividend history, upcoming ex/pay dates and forward yield.',
    params: contracts.assetIdParamSchema,
    status: 200,
    response: R.DividendsResponse,
  },
  {
    method: 'get',
    path: '/assets/{id}/intel/earnings',
    tag: 'Assets',
    summary: 'Next and recent past earnings reports.',
    params: contracts.assetIdParamSchema,
    status: 200,
    response: R.EarningsResponse,
  },
  {
    method: 'get',
    path: '/assets/intel/earnings-calendar',
    tag: 'Assets',
    summary: 'Upcoming earnings across the caller’s held + watched assets (Workboard panel).',
    status: 200,
    response: R.EarningsCalendarResponse,
  },
  {
    method: 'get',
    path: '/assets/{id}/intel/news',
    tag: 'Assets',
    summary: 'Recent news headlines for the asset.',
    params: contracts.assetIdParamSchema,
    status: 200,
    response: R.NewsResponse,
  },
  {
    method: 'get',
    path: '/assets/{id}/intel/splits',
    tag: 'Assets',
    summary: 'Past and announced stock splits.',
    params: contracts.assetIdParamSchema,
    status: 200,
    response: R.SplitsResponse,
  },
  {
    method: 'get',
    path: '/assets/{id}/intel/fundamentals',
    tag: 'Assets',
    summary:
      'Revenue, statement line items and snapshot ratios (period=annual|quarterly, limit clamped to 1..12).',
    params: contracts.assetIdParamSchema,
    query: contracts.fundamentalsQuerySchema,
    status: 200,
    response: R.FundamentalsResponse,
  },
  {
    method: 'get',
    path: '/assets/portfolio/dividend-calendar',
    tag: 'Assets',
    summary: 'Upcoming dividend ex/pay dates across the caller’s held + watchlist assets.',
    status: 200,
    response: R.DividendCalendarResponse,
  },
  {
    method: 'get',
    path: '/assets/portfolio/dividend-projection',
    tag: 'Assets',
    summary: 'Projected dividend income for the whole portfolio (monthly + yearly, EUR).',
    status: 200,
    response: R.ProjectedDividendIncomeResponse,
  },
  {
    method: 'get',
    path: '/assets/portfolio/news-digest',
    tag: 'Assets',
    summary: 'Recent news across the caller’s held + watchlist assets, grouped per asset.',
    status: 200,
    response: R.NewsDigestResponse,
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
    summary: 'Paged cash movements + current balance.',
    description:
      `Returns cash movements newest first (executedAt descending, then id ascending). ` +
      `Requests without limit return at most ${contracts.CASH_MOVEMENTS_DEFAULT_LIMIT} rows; ` +
      'follow nextCursor to retrieve older rows.',
    params: contracts.portfolioIdParamSchema,
    query: contracts.cashMovementsQuerySchema,
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
    path: '/portfolios/{portfolioId}/cash/fee',
    tag: 'Portfolios',
    summary: 'Record a standing custody/account fee (rejects an overdraw).',
    params: contracts.portfolioIdParamSchema,
    body: R.CashEntryRequest,
    status: 201,
    response: R.CashMovementResponse,
    idempotent: true,
  },
  {
    method: 'patch',
    path: '/portfolios/{portfolioId}/cash/movements/{movementId}',
    tag: 'Portfolios',
    summary: 'Correct a hand-entered cash movement (deposit / withdrawal / fee).',
    params: contracts.portfolioCashMovementParamsSchema,
    body: R.UpdateCashMovementRequest,
    status: 200,
    response: R.CashMovementResponse,
    idempotent: true,
  },
  {
    method: 'delete',
    path: '/portfolios/{portfolioId}/cash/movements/{movementId}',
    tag: 'Portfolios',
    summary: 'Delete a hand-entered cash movement.',
    params: contracts.portfolioCashMovementParamsSchema,
    status: 200,
    response: R.CashDeletionResponse,
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
    path: '/portfolios/{portfolioId}/settings/tax',
    tag: 'Portfolios',
    summary: 'The portfolio’s resolved tax treatment (override ?? default ?? none), #636.',
    params: contracts.portfolioIdParamSchema,
    status: 200,
    response: R.PortfolioTaxSettingsResponse,
  },
  {
    method: 'put',
    path: '/portfolios/{portfolioId}/settings/tax',
    tag: 'Portfolios',
    summary: 'Override this portfolio’s tax treatment (per-portfolio scoping), #636.',
    params: contracts.portfolioIdParamSchema,
    body: R.UpdateTaxSettingsRequest,
    status: 200,
    response: R.PortfolioTaxSettingsResponse,
  },
  {
    method: 'delete',
    path: '/portfolios/{portfolioId}/settings/tax',
    tag: 'Portfolios',
    summary: 'Reset this portfolio’s tax treatment to the user default (#636).',
    params: contracts.portfolioIdParamSchema,
    status: 200,
    response: R.PortfolioTaxSettingsResponse,
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
    path: '/portfolios/{portfolioId}/reports/tax-years/{year}/export.csv',
    tag: 'Portfolios',
    summary:
      'Download one tax year as CSV (text/csv attachment); the same report numbers, ?locale= picks header language.',
    params: contracts.taxYearParamsSchema,
    query: contracts.taxYearExportQuerySchema,
    status: 200,
  },
  {
    method: 'get',
    path: '/portfolios/{portfolioId}/transactions',
    tag: 'Portfolios',
    summary: 'Cursor-paged transaction ledger.',
    params: contracts.portfolioIdParamSchema,
    // OpenAPI registers the query's object shape; the route still uses the
    // outer refinement that rejects a cursor from the other ordering mode.
    query: contracts.transactionListQuerySchema.innerType(),
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
    path: '/custom-assets/vault-snapshots',
    tag: 'Custom Assets',
    summary: 'Read the exact current state of the caller’s own manual assets (vault-entity rows).',
    description:
      'The lossless seam the per-portfolio vault move needs on both paths (#1529): each present asset in vault-entity row shape (decimal strings, verbatim meta) with every current value point; ids that are not the caller’s manual assets — unknown, catalog, another account’s — are simply absent (no oracle). `ids` is one comma-separated list of 1..200 UUIDs. Responses are no-store.',
    query: contracts.customAssetVaultSnapshotsQuerySchema,
    status: 200,
    response: R.CustomAssetVaultSnapshotsResponse,
    noStore: true,
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
    method: 'get',
    path: '/conglomerates/{conglomerateId}/resolved',
    tag: 'Conglomerates',
    summary: 'Flattened effective asset weights of a (nested) Conglomerate (V5-P6).',
    params: contracts.conglomerateIdParamSchema,
    status: 200,
    response: R.ConglomerateResolvedResponse,
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
  {
    method: 'post',
    path: '/backtest/compare',
    tag: 'Backtest',
    summary: 'Compare 2–6 of the caller’s conglomerates on one shared window (§13.5 V5-P6).',
    body: R.BacktestComparisonRequest,
    status: 200,
    response: R.BacktestComparisonResponse,
  },
  {
    method: 'post',
    path: '/backtest/shared/{conglomerateId}/preview',
    tag: 'Backtest',
    summary:
      'What-if sandbox: backtest a friend-shared basket with local weight tweaks (§13.5 V5-P6).',
    params: contracts.conglomerateIdParamSchema,
    body: R.SharedSandboxPreviewRequest,
    status: 200,
    response: R.SharedSandboxPreviewResponse,
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

  // Feedback (#1315/#1338) — capture plus caller-owned lifecycle read-back
  {
    method: 'get',
    path: '/feedback/mine',
    tag: 'Feedback',
    summary: 'List the caller’s own feedback submissions and their lifecycle status.',
    status: 200,
    response: R.MyFeedbackResponse,
  },
  {
    method: 'delete',
    path: '/feedback/{id}',
    tag: 'Feedback',
    summary: 'Hide one caller-owned submission while retaining an admin-visible tombstone.',
    params: contracts.idParamSchema,
    status: 204,
  },
  {
    method: 'post',
    path: '/feedback',
    tag: 'Feedback',
    summary: 'Submit a feature request, bug report, or other feedback.',
    errorCodes: contracts.FEEDBACK_SUBMISSION_ERROR_CODES,
    body: R.CreateFeedbackRequest,
    status: 201,
    response: R.CreateFeedbackResponse,
  },
  {
    method: 'get',
    path: '/feedback/{id}/messages',
    tag: 'Feedback',
    summary: 'Read a newest-first page of the caller-owned submission thread.',
    params: contracts.idParamSchema,
    query: contracts.feedbackThreadQuerySchema,
    status: 200,
    response: R.FeedbackThreadResponse,
  },
  {
    method: 'post',
    path: '/feedback/{id}/messages',
    tag: 'Feedback',
    summary: 'Post a text reply to the caller-owned submission thread.',
    params: contracts.idParamSchema,
    body: R.SendFeedbackMessageRequest,
    status: 201,
    response: R.SendFeedbackMessageResponse,
  },
  {
    method: 'post',
    path: '/feedback/{id}/read',
    tag: 'Feedback',
    summary: 'Mark the caller-owned support thread read for the submitter side.',
    params: contracts.idParamSchema,
    status: 200,
    response: R.OkResponse,
  },

  // Standing orders (§13.5 V5-P6b)
  {
    method: 'get',
    path: '/standing-orders',
    tag: 'Standing orders',
    summary: 'The caller’s standing orders (optionally one portfolio), each with its next-run day.',
    query: contracts.standingOrderListQuerySchema,
    status: 200,
    response: R.StandingOrderListResponse,
  },
  {
    method: 'get',
    path: '/standing-orders/runs',
    tag: 'Standing orders',
    summary:
      'The caller’s raw exactly-once run ledger, including periods claimed but never booked (which no order watermark can express).',
    status: 200,
    response: R.StandingOrderRunListResponse,
  },
  {
    method: 'post',
    path: '/standing-orders',
    tag: 'Standing orders',
    summary: 'Create a recurring buy / cash-add / cash-deduct that auto-records on its schedule.',
    body: R.CreateStandingOrderRequest,
    status: 201,
    response: R.StandingOrder,
  },
  {
    method: 'get',
    path: '/standing-orders/{id}',
    tag: 'Standing orders',
    summary: 'One of the caller’s own standing orders.',
    params: contracts.standingOrderIdParamSchema,
    status: 200,
    response: R.StandingOrder,
  },
  {
    method: 'patch',
    path: '/standing-orders/{id}',
    tag: 'Standing orders',
    summary: 'Edit a standing order’s amount, label, or end date.',
    params: contracts.standingOrderIdParamSchema,
    body: R.UpdateStandingOrderRequest,
    status: 200,
    response: R.StandingOrder,
  },
  {
    method: 'post',
    path: '/standing-orders/{id}/pause',
    tag: 'Standing orders',
    summary: 'Pause a standing order (stops firing; resuming never back-fills the paused periods).',
    params: contracts.standingOrderIdParamSchema,
    status: 200,
    response: R.StandingOrder,
  },
  {
    method: 'post',
    path: '/standing-orders/{id}/resume',
    tag: 'Standing orders',
    summary: 'Resume a paused standing order (fires from the current period onward).',
    params: contracts.standingOrderIdParamSchema,
    status: 200,
    response: R.StandingOrder,
  },
  {
    method: 'delete',
    path: '/standing-orders/{id}',
    tag: 'Standing orders',
    summary: 'Delete a standing order (its run history cascades).',
    params: contracts.standingOrderIdParamSchema,
    status: 204,
  },

  // Cash flow (V5 cash fusion) — tags, movement tagging, budgets and auto-tagging
  // rules ON the portfolio cash ledger. Supersedes the Expenses area below.
  {
    method: 'get',
    path: '/cash/tags',
    tag: 'Cash flow',
    summary: 'The caller’s cash-flow tags, app-owned ones included.',
    status: 200,
    response: R.CashTagListResponse,
  },
  {
    method: 'post',
    path: '/cash/tags',
    tag: 'Cash flow',
    summary: 'Create a tag (409 when the name is taken, case-insensitively).',
    body: R.CreateCashTagRequest,
    status: 201,
    response: R.CashTagResponse,
  },
  {
    method: 'patch',
    path: '/cash/tags/{tagId}',
    tag: 'Cash flow',
    summary: 'Rename or re-tint a tag. App-owned tags may be renamed, never deleted.',
    params: contracts.cashTagIdParamSchema,
    body: R.UpdateCashTagRequest,
    status: 200,
    response: R.CashTagResponse,
  },
  {
    method: 'delete',
    path: '/cash/tags/{tagId}',
    tag: 'Cash flow',
    summary: 'Delete a user tag (its budgets and rule links cascade); 409 for an app-owned tag.',
    params: contracts.cashTagIdParamSchema,
    status: 204,
  },
  {
    method: 'put',
    path: '/cash/movements/{movementId}/tags',
    tag: 'Cash flow',
    summary: 'Replace a movement’s whole tag set; an empty array clears it.',
    params: contracts.cashMovementIdParamSchema,
    body: R.SetCashMovementTagsRequest,
    status: 200,
    response: R.CashMovementTagsResponse,
  },
  {
    method: 'get',
    path: '/cash/budgets/all',
    tag: 'Cash flow',
    summary:
      'Every raw budget row (all portfolios, all periods, no month evaluation) — the faithful read the paranoid capture needs.',
    status: 200,
    response: R.CashBudgetRawListResponse,
  },
  {
    method: 'get',
    path: '/cash/budgets',
    tag: 'Cash flow',
    summary: 'One portfolio’s budgets with this month’s progress.',
    query: contracts.cashBudgetListQuerySchema,
    status: 200,
    response: R.CashBudgetListResponse,
  },
  {
    method: 'post',
    path: '/cash/budgets',
    tag: 'Cash flow',
    summary: 'Create a budget for one portfolio + tag + period (null period = recurring).',
    body: R.CreateCashBudgetRequest,
    status: 201,
    response: R.CashBudgetResponse,
  },
  {
    method: 'patch',
    path: '/cash/budgets/{budgetId}',
    tag: 'Cash flow',
    summary: 'Retarget a budget’s amount. Portfolio, tag and period are fixed at creation.',
    params: contracts.cashBudgetIdParamSchema,
    body: R.UpdateCashBudgetRequest,
    status: 200,
    response: R.CashBudgetResponse,
  },
  {
    method: 'delete',
    path: '/cash/budgets/{budgetId}',
    tag: 'Cash flow',
    summary: 'Delete a budget (its fired markers cascade).',
    params: contracts.cashBudgetIdParamSchema,
    status: 204,
  },
  {
    method: 'get',
    path: '/cash/rules',
    tag: 'Cash flow',
    summary: 'Auto-tagging rules in evaluation order (ascending priority, then age).',
    status: 200,
    response: R.CashRuleListResponse,
  },
  {
    method: 'post',
    path: '/cash/rules',
    tag: 'Cash flow',
    summary: 'Create a rule; a match applies its whole tag set and evaluation stops.',
    body: R.CreateCashRuleRequest,
    status: 201,
    response: R.CashRuleResponse,
  },
  {
    method: 'patch',
    path: '/cash/rules/{ruleId}',
    tag: 'Cash flow',
    summary: 'Patch a rule; `tagIds` replaces its whole tag set.',
    params: contracts.cashRuleIdParamSchema,
    body: R.UpdateCashRuleRequest,
    status: 200,
    response: R.CashRuleResponse,
  },
  {
    method: 'delete',
    path: '/cash/rules/{ruleId}',
    tag: 'Cash flow',
    summary: 'Delete an auto-tagging rule.',
    params: contracts.cashRuleIdParamSchema,
    status: 204,
  },
  {
    method: 'post',
    path: '/cash/rules/apply',
    tag: 'Cash flow',
    summary:
      'Run the rules over movements that already exist, in every portfolio you own — a rule is usually written after the movements it describes. Additive and idempotent, so a second call reports 0.',
    status: 200,
    response: R.CashRuleApplyResponse,
  },
  {
    method: 'post',
    path: '/cash/rules/preview',
    tag: 'Cash flow',
    summary:
      'What your rules would tag this note as. Read-only — the entry form asks while you type, so the label appears before you commit.',
    body: R.CashRulePreviewRequest,
    status: 200,
    response: R.CashRulePreviewResponse,
  },
  {
    method: 'get',
    path: '/cash/summary',
    tag: 'Cash flow',
    summary:
      'One portfolio-month’s totals and per-tag split. Tag rows may over-count — a movement with two tags counts in both — so only the totals reconcile to the ledger.',
    query: contracts.cashSummaryQuerySchema,
    status: 200,
    response: R.CashMonthlySummaryResponse,
  },
  {
    method: 'get',
    path: '/cash/trends',
    tag: 'Cash flow',
    summary: 'Inflow/outflow per month for one portfolio, oldest first; gaps are zeros.',
    query: contracts.cashTrendQuerySchema,
    status: 200,
    response: R.CashTrendResponse,
  },

  // Expense tracking (§13.5 V5-P9) — RETIRED for writes by the cash fusion; the
  // read paths stay for one release as the rollback and diagnosis path.
  {
    method: 'get',
    path: '/expenses/categories',
    tag: 'Expenses',
    summary: 'The caller’s spending/income categories (a pure read; never seeds).',
    status: 200,
    response: R.ExpenseCategoryListResponse,
  },
  {
    method: 'post',
    path: '/expenses/categories',
    tag: 'Expenses',
    summary: 'Create a category.',
    body: R.CreateExpenseCategoryRequest,
    status: 201,
    response: R.ExpenseCategoryResponse,
  },
  {
    method: 'patch',
    path: '/expenses/categories/{categoryId}',
    tag: 'Expenses',
    summary: 'Rename, re-tint, or flip the direction of a category.',
    params: contracts.expenseCategoryIdParamSchema,
    body: R.UpdateExpenseCategoryRequest,
    status: 200,
    response: R.ExpenseCategoryResponse,
  },
  {
    method: 'delete',
    path: '/expenses/categories/{categoryId}',
    tag: 'Expenses',
    summary: 'Delete a category (its transactions become uncategorized).',
    params: contracts.expenseCategoryIdParamSchema,
    status: 204,
  },
  {
    method: 'get',
    path: '/expenses/transactions',
    tag: 'Expenses',
    summary: 'The caller’s transactions, newest first (optional category/direction/date filters).',
    query: contracts.expenseTransactionListQuerySchema,
    status: 200,
    response: R.ExpenseTransactionListResponse,
  },
  {
    method: 'post',
    path: '/expenses/transactions',
    tag: 'Expenses',
    summary: 'Record a spend / income transaction.',
    body: R.CreateExpenseTransactionRequest,
    status: 201,
    response: R.ExpenseTransactionResponse,
  },
  {
    method: 'get',
    path: '/expenses/transactions/{transactionId}',
    tag: 'Expenses',
    summary: 'One of the caller’s own transactions.',
    params: contracts.expenseTransactionIdParamSchema,
    status: 200,
    response: R.ExpenseTransactionResponse,
  },
  {
    method: 'patch',
    path: '/expenses/transactions/{transactionId}',
    tag: 'Expenses',
    summary: 'Edit a transaction’s amount, date, description, category or direction.',
    params: contracts.expenseTransactionIdParamSchema,
    body: R.UpdateExpenseTransactionRequest,
    status: 200,
    response: R.ExpenseTransactionResponse,
  },
  {
    method: 'put',
    path: '/expenses/transactions/{transactionId}/category',
    tag: 'Expenses',
    summary: 'Recategorize a single transaction (null clears the category).',
    params: contracts.expenseTransactionIdParamSchema,
    body: R.RecategorizeExpenseTransactionRequest,
    status: 200,
    response: R.ExpenseTransactionResponse,
  },
  {
    method: 'delete',
    path: '/expenses/transactions/{transactionId}',
    tag: 'Expenses',
    summary: 'Delete a transaction.',
    params: contracts.expenseTransactionIdParamSchema,
    status: 204,
  },
  {
    method: 'get',
    path: '/expenses/rules',
    tag: 'Expenses',
    summary: 'The caller’s auto-categorization rules, in evaluation order.',
    status: 200,
    response: R.ExpenseRuleListResponse,
  },
  {
    method: 'post',
    path: '/expenses/rules',
    tag: 'Expenses',
    summary: 'Create an auto-categorization rule (shapes only; evaluation is a later phase).',
    body: R.CreateExpenseRuleRequest,
    status: 201,
    response: R.ExpenseRuleResponse,
  },
  {
    method: 'patch',
    path: '/expenses/rules/{ruleId}',
    tag: 'Expenses',
    summary: 'Edit an auto-categorization rule.',
    params: contracts.expenseRuleIdParamSchema,
    body: R.UpdateExpenseRuleRequest,
    status: 200,
    response: R.ExpenseRuleResponse,
  },
  {
    method: 'delete',
    path: '/expenses/rules/{ruleId}',
    tag: 'Expenses',
    summary: 'Delete an auto-categorization rule.',
    params: contracts.expenseRuleIdParamSchema,
    status: 204,
  },
  {
    method: 'get',
    path: '/expenses/import/banks',
    tag: 'Expenses',
    summary: 'The supported bank-statement CSV mappers (Erste/George, ELBA, N26, Revolut).',
    status: 200,
    response: R.ExpenseBankListResponse,
  },
  {
    method: 'post',
    path: '/expenses/import/preview',
    tag: 'Expenses',
    summary:
      'Upload a bank CSV: autodetect (or pick) the bank, normalize + auto-categorize its rows, flag duplicates, and return the staged preview. Nothing is persisted.',
    body: contracts.expenseImportPreviewFieldsSchema.extend({
      file: z.string().openapi({
        type: 'string',
        format: 'binary',
        description: 'The bank statement CSV export (UTF-8, ≤ 5 MB).',
      }),
    }),
    bodyContentType: 'multipart/form-data',
    status: 200,
    response: R.ExpenseImportPreviewResponse,
  },
  {
    method: 'post',
    path: '/expenses/import/apply',
    tag: 'Expenses',
    summary:
      'Confirm an import: re-upload the same CSV (+ optional per-row category overrides) and book the non-duplicate rows as expense transactions, tagged import:<bank>. Idempotent via content hashing.',
    body: contracts.expenseImportApplyFieldsSchema.extend({
      file: z.string().openapi({
        type: 'string',
        format: 'binary',
        description: 'The same bank statement CSV re-uploaded (UTF-8, ≤ 5 MB).',
      }),
    }),
    bodyContentType: 'multipart/form-data',
    status: 200,
    response: R.ExpenseImportApplyResponse,
  },
  {
    method: 'get',
    path: '/expenses/summary',
    tag: 'Expenses',
    summary:
      'Spend by category and income-vs-spend for a month (defaults to the current month); totals reconcile to the recorded transaction sum.',
    query: contracts.expenseSummaryQuerySchema,
    status: 200,
    response: R.ExpenseMonthlySummaryResponse,
  },
  {
    method: 'get',
    path: '/expenses/trends',
    tag: 'Expenses',
    summary: 'Income-vs-spend totals over the trailing months (default 6, max 24).',
    query: contracts.expenseTrendQuerySchema,
    status: 200,
    response: R.ExpenseTrendResponse,
  },
  {
    method: 'get',
    path: '/expenses/budgets',
    tag: 'Expenses',
    summary: 'The caller’s per-category monthly budgets with this period’s spend progress.',
    query: contracts.expenseBudgetListQuerySchema,
    status: 200,
    response: R.ExpenseBudgetListResponse,
  },
  {
    method: 'post',
    path: '/expenses/budgets',
    tag: 'Expenses',
    summary: 'Set a per-category monthly budget (one per category) with a matrix-routed alert.',
    body: R.CreateExpenseBudgetRequest,
    status: 201,
    response: R.ExpenseBudgetResponse,
  },
  {
    method: 'patch',
    path: '/expenses/budgets/{budgetId}',
    tag: 'Expenses',
    summary: 'Retarget a budget’s amount / currency.',
    params: contracts.expenseBudgetIdParamSchema,
    body: R.UpdateExpenseBudgetRequest,
    status: 200,
    response: R.ExpenseBudgetResponse,
  },
  {
    method: 'delete',
    path: '/expenses/budgets/{budgetId}',
    tag: 'Expenses',
    summary: 'Remove a budget.',
    params: contracts.expenseBudgetIdParamSchema,
    status: 204,
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
    method: 'patch',
    path: '/imports/{batchId}/rows/{rowId}',
    tag: 'Imports',
    summary:
      "Finish one staged row a person had to decide about — exactly one of assetId or kind per request; the refreshed preview is returned either way, and the row is stamped resolvedBy=user. assetId (#964) pins an unresolved row to an asset the USER picked: the row flips to mapped (or duplicate, if the pin collides with data already recorded). The row's candidates are UI suggestions, not the validation boundary — the asset id is checked with the same visibility rule as the manual transaction path, so a custom asset the caller just created is accepted. kind (§16 2026-08-29) confirms what an UNDECIDED row is — one member of that row's confirmableKinds, and nothing else: no amount, date or id is accepted from the client, because the server re-derives every value it books from the fields staging already parsed. A kind the row's own contents (or the direction its file states) will not support is refused with the reason; confirmation is one-shot, and both paths require the batch to still be pending.",
    params: contracts.importRowIdParamSchema,
    body: R.ResolveImportRowRequest,
    status: 200,
    response: R.ImportPreviewResponse,
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
    method: 'get',
    path: '/social/groups',
    tag: 'Social',
    summary: 'The caller’s friend groups, each with its live roster.',
    status: 200,
    response: R.FriendGroupListResponse,
  },
  {
    method: 'post',
    path: '/social/groups',
    tag: 'Social',
    summary: 'Create an empty named friend group.',
    body: R.CreateFriendGroupRequest,
    status: 201,
    response: R.FriendGroup,
  },
  {
    method: 'patch',
    path: '/social/groups/{groupId}',
    tag: 'Social',
    summary: 'Rename a friend group.',
    params: contracts.groupIdParamSchema,
    body: R.RenameFriendGroupRequest,
    status: 200,
    response: R.FriendGroup,
  },
  {
    method: 'delete',
    path: '/social/groups/{groupId}',
    tag: 'Social',
    summary: 'Delete a friend group — shares referencing it then resolve to nobody.',
    params: contracts.groupIdParamSchema,
    status: 204,
  },
  {
    method: 'post',
    path: '/social/groups/{groupId}/members',
    tag: 'Social',
    summary: 'Add an accepted friend to a group (idempotent).',
    params: contracts.groupIdParamSchema,
    body: R.AddGroupMemberRequest,
    status: 200,
    response: R.FriendGroup,
  },
  {
    method: 'delete',
    path: '/social/groups/{groupId}/members/{userId}',
    tag: 'Social',
    summary: 'Remove a member from a group.',
    params: contracts.groupMemberParamSchema,
    status: 200,
    response: R.FriendGroup,
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

  // Comments + reactions on shared items (§13.5 V5-P8)
  {
    method: 'get',
    path: '/social/items/{kind}/{subjectId}/thread',
    tag: 'Social',
    summary:
      'A shared item’s comment thread + item-level reactions (audience-scoped; 404 when unauthorized).',
    params: contracts.audienceParamSchema,
    status: 200,
    response: R.CommentThreadResponse,
  },
  {
    method: 'post',
    path: '/social/items/{kind}/{subjectId}/comments',
    tag: 'Social',
    summary: 'Post one comment on a shared item (visible to exactly the item’s audience).',
    params: contracts.audienceParamSchema,
    body: R.CreateCommentRequest,
    status: 201,
    response: R.CreateCommentResponse,
  },
  {
    method: 'post',
    path: '/social/items/{kind}/{subjectId}/reactions',
    tag: 'Social',
    summary: 'Toggle one curated emoji reaction on a shared item; returns the fresh aggregate.',
    params: contracts.audienceParamSchema,
    body: R.ToggleReactionRequest,
    status: 200,
    response: R.ReactionListResponse,
  },
  {
    method: 'delete',
    path: '/social/comments/{commentId}',
    tag: 'Social',
    summary: 'Soft-delete a comment — its author, or the item owner moderating any comment.',
    params: contracts.commentIdParamSchema,
    status: 204,
  },
  {
    method: 'post',
    path: '/social/comments/{commentId}/reactions',
    tag: 'Social',
    summary: 'Toggle one curated emoji reaction on a comment; returns the fresh aggregate.',
    params: contracts.commentIdParamSchema,
    body: R.ToggleReactionRequest,
    status: 200,
    response: R.ReactionListResponse,
  },

  // MIRRORCHAIN group portfolios (§13.5 V5-P7 M3)
  {
    method: 'get',
    path: '/mirrorchain/chains',
    tag: 'Mirrorchain',
    summary: 'The caller’s active group-portfolio summaries (switcher rows + sync state).',
    status: 200,
    response: R.MirrorChainListResponse,
  },
  {
    method: 'post',
    path: '/mirrorchain/chains',
    tag: 'Mirrorchain',
    summary: 'Create a new (empty) group portfolio.',
    body: R.CreateMirrorChainRequest,
    status: 201,
    response: R.MirrorChainSummary,
  },
  {
    method: 'post',
    path: '/mirrorchain/chains/convert',
    tag: 'Mirrorchain',
    summary: 'Make an existing portfolio a group portfolio (genesis).',
    body: R.ConvertMirrorChainRequest,
    status: 201,
    response: R.MirrorChainSummary,
  },
  {
    method: 'get',
    path: '/mirrorchain/invites',
    tag: 'Mirrorchain',
    summary: 'The caller’s pending group-portfolio invites, incoming + outgoing.',
    status: 200,
    response: R.MirrorInviteListResponse,
  },
  {
    method: 'post',
    path: '/mirrorchain/invites/{inviteId}/accept',
    tag: 'Mirrorchain',
    summary: 'Accept an invite — the copy is materialized and replay is enqueued.',
    params: contracts.mirrorInviteIdParamSchema,
    status: 200,
    response: R.MirrorAcceptInviteResponse,
  },
  {
    method: 'post',
    path: '/mirrorchain/invites/{inviteId}/decline',
    tag: 'Mirrorchain',
    summary: 'Decline an invite (a later re-invite is allowed).',
    params: contracts.mirrorInviteIdParamSchema,
    status: 200,
    response: R.OkResponse,
  },
  {
    method: 'post',
    path: '/mirrorchain/invites/{inviteId}/revoke',
    tag: 'Mirrorchain',
    summary: 'Revoke a pending invite (owner + managers).',
    params: contracts.mirrorInviteIdParamSchema,
    status: 200,
    response: R.OkResponse,
  },
  {
    method: 'get',
    path: '/mirrorchain/chains/{chainId}/members',
    tag: 'Mirrorchain',
    summary: 'The member sheet: roster + roles + per-copy sync state.',
    params: contracts.mirrorChainIdParamSchema,
    status: 200,
    response: R.MirrorMemberListResponse,
  },
  {
    method: 'get',
    path: '/mirrorchain/chains/{chainId}/activity',
    tag: 'Mirrorchain',
    summary: 'The chain activity feed (oplog), newest-first, paginated by seq.',
    params: contracts.mirrorChainIdParamSchema,
    query: contracts.mirrorActivityQuerySchema,
    status: 200,
    response: R.MirrorActivityResponse,
  },
  {
    method: 'post',
    path: '/mirrorchain/chains/{chainId}/invites',
    tag: 'Mirrorchain',
    summary: 'Invite a friend to the chain (owner + managers; friends-only).',
    params: contracts.mirrorChainIdParamSchema,
    body: R.InviteMirrorMemberRequest,
    status: 202,
    response: R.OkResponse,
  },
  {
    method: 'patch',
    path: '/mirrorchain/chains/{chainId}',
    tag: 'Mirrorchain',
    summary: 'Rename the chain (owner + managers).',
    params: contracts.mirrorChainIdParamSchema,
    body: R.RenameMirrorChainRequest,
    status: 200,
    response: R.MirrorChainSummary,
  },
  {
    method: 'post',
    path: '/mirrorchain/chains/{chainId}/transfer',
    tag: 'Mirrorchain',
    summary: 'Transfer ownership to an active member (owner-only).',
    params: contracts.mirrorChainIdParamSchema,
    body: R.TransferMirrorOwnershipRequest,
    status: 200,
    response: R.OkResponse,
  },
  {
    method: 'post',
    path: '/mirrorchain/chains/{chainId}/leave',
    tag: 'Mirrorchain',
    summary: 'Leave the chain, keeping an un-synced fork (owner refused until M4).',
    params: contracts.mirrorChainIdParamSchema,
    status: 200,
    response: R.OkResponse,
  },
  {
    method: 'delete',
    path: '/mirrorchain/chains/{chainId}',
    tag: 'Mirrorchain',
    summary: 'Dissolve the chain — every copy becomes a fork (owner-only).',
    params: contracts.mirrorChainIdParamSchema,
    status: 204,
  },
  {
    method: 'patch',
    path: '/mirrorchain/chains/{chainId}/members/{userId}/role',
    tag: 'Mirrorchain',
    summary: 'Grant / revoke manage rights (owner-only).',
    params: contracts.mirrorMemberParamSchema,
    body: R.SetMirrorMemberRoleRequest,
    status: 200,
    response: R.OkResponse,
  },
  {
    method: 'delete',
    path: '/mirrorchain/chains/{chainId}/members/{userId}',
    tag: 'Mirrorchain',
    summary: 'Kick a member — they keep an un-synced fork (owner + managers).',
    params: contracts.mirrorMemberParamSchema,
    status: 204,
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
  {
    method: 'get',
    path: '/settings/home',
    tag: 'Settings',
    summary: 'The caller’s Home widget board; both fields null when none was ever saved.',
    status: 200,
    response: R.HomeLayoutResponse,
  },
  {
    method: 'put',
    path: '/settings/home',
    tag: 'Settings',
    summary:
      'Replace the caller’s Home widget board (`layout: null` clears it). Stored verbatim — only shape and size are validated.',
    body: R.UpdateHomeLayoutRequest,
    status: 200,
    response: R.HomeLayoutResponse,
  },

  // Per-account widget compositions, one per client namespace (board #68)
  {
    method: 'get',
    path: '/settings/widget-layout/{namespace}',
    tag: 'Settings',
    summary: 'The caller’s saved widget composition for one client namespace.',
    description:
      '`mobile` and `web` are two independent compositions. Answers `404 WIDGET_LAYOUT_NOT_FOUND` when this account never saved this namespace; any namespace outside the enum is a `400`.',
    params: contracts.widgetLayoutNamespaceParamSchema,
    status: 200,
    response: R.WidgetLayoutResponse,
  },
  {
    method: 'put',
    path: '/settings/widget-layout/{namespace}',
    tag: 'Settings',
    summary: 'Replace the caller’s widget composition for one client namespace.',
    description:
      'Upsert, last write wins. The document is opaque — stored and returned verbatim, validated only as a JSON object serialising to at most 32 KB (`413 WIDGET_LAYOUT_TOO_LARGE` past the cap).',
    params: contracts.widgetLayoutNamespaceParamSchema,
    body: R.UpdateWidgetLayoutRequest,
    status: 200,
    response: R.WidgetLayoutResponse,
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
    summary: 'Switch the tax mode for the living tax documentation (§16).',
    body: R.UpdateTaxSettingsRequest,
    status: 200,
    response: R.TaxSettingsResponse,
  },

  // Living tax-year documentation (§16 2026-08-19).
  {
    method: 'get',
    path: '/settings/taxes/years',
    tag: 'Settings',
    summary: 'The caller’s account-wide tax-year last-change markers.',
    status: 200,
    response: R.TaxYearChangesResponse,
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
    description:
      'Cookie sessions are supported. Bearer access requires an official first-party OAuth client holding account:security; third-party OAuth tokens and personal API keys are refused.',
    status: 200,
    response: R.OAuthGrantListResponse,
  },
  {
    method: 'delete',
    path: '/settings/oauth-grants/{id}',
    tag: 'Settings',
    summary: 'Revoke an authorized app; kills its access + refresh tokens instantly.',
    description:
      'Cookie sessions are supported. Bearer access requires an official first-party OAuth client holding account:security; third-party OAuth tokens and personal API keys are refused.',
    params: contracts.idParamSchema,
    status: 204,
  },

  // Outbound webhooks (§13.5 V5-P10) — session-only (never reachable by a key).
  {
    method: 'get',
    path: '/settings/webhooks',
    tag: 'Settings',
    summary: 'List the caller’s webhook subscriptions (never returns the signing secret).',
    status: 200,
    response: R.WebhookSubscriptionListResponse,
  },
  {
    method: 'post',
    path: '/settings/webhooks',
    tag: 'Settings',
    summary:
      'Create a webhook subscription; the signing secret is returned exactly once and only its encrypted form is stored.',
    body: R.CreateWebhookSubscriptionRequest,
    status: 201,
    response: R.CreateWebhookSubscriptionResponse,
  },
  {
    method: 'patch',
    path: '/settings/webhooks/{id}',
    tag: 'Settings',
    summary:
      'Edit a subscription; flipping enabled true re-enables (resets failures), false pauses.',
    params: contracts.idParamSchema,
    body: R.UpdateWebhookSubscriptionRequest,
    status: 200,
    response: R.WebhookSubscriptionResponse,
  },
  {
    method: 'delete',
    path: '/settings/webhooks/{id}',
    tag: 'Settings',
    summary: 'Delete a subscription (cascades its delivery log).',
    params: contracts.idParamSchema,
    status: 204,
  },
  {
    method: 'get',
    path: '/settings/webhooks/{id}/deliveries',
    tag: 'Settings',
    summary: 'The subscription’s bounded delivery log, newest first.',
    params: contracts.idParamSchema,
    status: 200,
    response: R.WebhookDeliveryListResponse,
  },

  // OAuth 2.0 flow (§6.13, V2-P12).
  {
    method: 'get',
    path: '/oauth/client-logos/{clientId}',
    tag: 'OAuth',
    summary:
      'Serve immutable, save-time-cached OAuth client logo bytes from BetterTrack (never the registered remote URL).',
    public: true,
    params: contracts.oauthClientLogoParamsSchema,
    status: 200,
    response: z.string().openapi({
      type: 'string',
      format: 'binary',
      description: 'Validated PNG, JPEG, GIF or WebP logo bytes.',
    }),
    responseContentType: 'image/*',
  },
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
    path: '/oauth/deny',
    tag: 'OAuth',
    summary:
      'Deny consent: validate the authorize request and return an access_denied redirect target.',
    body: R.OAuthDenyRequest,
    status: 200,
    response: R.OAuthDenyResponse,
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

  // Separately-authenticated browser-only Google Drive identities (E5 #1415).
  {
    method: 'get',
    path: '/drive-connections',
    tag: 'Vault',
    summary: 'List the caller’s separately authenticated Google Drive identities.',
    description:
      'Identity/config only: the response and backing table contain no Google access token, refresh token, or Drive file id.',
    status: 200,
    response: R.DriveConnectionListResponse,
  },
  {
    method: 'post',
    path: '/drive-connections',
    tag: 'Vault',
    summary: 'Register the Drive identity captured client-side after fresh Google consent.',
    description:
      'The strict body accepts only googleSub, email, and displayName. Google tokens stay in browser memory and never cross this endpoint. Create-or-refresh: re-consenting an already registered account upserts onto the same connection id and also answers 201; the audit trail distinguishes drive_connection.created from drive_connection.refreshed.',
    body: R.CreateDriveConnectionRequest,
    status: 201,
    response: R.CreateDriveConnectionResponse,
  },
  {
    method: 'patch',
    path: '/drive-connections/{connectionId}/verified',
    tag: 'Vault',
    summary: 'Touch lastVerifiedAt after a browser directly verifies Drive access.',
    description:
      'Takes no request body; a non-empty body is refused, so no method of this module can carry a Google token.',
    params: contracts.driveConnectionIdParamSchema,
    status: 200,
    response: R.CreateDriveConnectionResponse,
  },
  {
    method: 'delete',
    path: '/drive-connections/{connectionId}',
    tag: 'Vault',
    summary: 'Disconnect one caller-owned Drive identity without deleting the user’s Drive files.',
    description:
      'Refuses while a vault is bound unless acknowledgeBound=true. Explicit acknowledgement may detach only vaults that hold a VERIFIED server copy: media must contain server AND mediaAttestedAt must be set, because a selected-but-never-attested server medium is a declaration, not a copy. Anything else — a Drive-only vault, or a server+drive vault whose full doc set has never attested — is refused as the last medium (PROJECTPLAN §16, 2026-08-21 and 2026-08-22). Takes no request body; a non-empty body is refused.',
    params: contracts.driveConnectionIdParamSchema,
    query: contracts.driveConnectionDisconnectQuerySchema,
    status: 204,
  },

  // Per-vault paranoid storage (E1 #1411) — config plus the BLIND per-doc store.
  {
    method: 'get',
    path: '/vaults',
    tag: 'Vault',
    summary: 'List the caller’s cleartext vault storage configurations.',
    status: 200,
    response: R.VaultListResponse,
  },
  {
    method: 'post',
    path: '/vaults',
    tag: 'Vault',
    summary:
      'Create a vault configuration with client-minted singleton doc ids and an immutable retirement verifier.',
    body: R.CreateVaultRequest,
    status: 201,
    response: R.CreateVaultResponse,
  },
  {
    method: 'get',
    path: '/vaults/{vaultId}',
    tag: 'Vault',
    summary: 'Read one caller-owned vault configuration; another owner’s id is not found.',
    params: contracts.vaultIdParamSchema,
    status: 200,
    response: R.CreateVaultResponse,
  },
  {
    method: 'patch',
    path: '/vaults/{vaultId}',
    tag: 'Vault',
    summary: 'Rename one caller-owned vault without changing its media transition state.',
    params: contracts.vaultIdParamSchema,
    body: R.PatchVaultRequest,
    status: 200,
    response: R.PatchVaultResponse,
  },
  {
    method: 'delete',
    path: '/vaults/{vaultId}',
    tag: 'Vault',
    summary:
      'Delete an unreferenced vault only after in-request password, TOTP, or recovery-code step-up.',
    description:
      'Available to an owning session or a bearer holding account:security. The same in-body step-up applies to both. Deletion refuses while a portfolio references the vault or while its signed-purge retirement gate remains live.',
    params: contracts.vaultIdParamSchema,
    body: R.DeleteVaultRequest,
    status: 200,
    response: R.DeleteVaultResponse,
  },
  {
    method: 'get',
    path: '/vaults/{vaultId}/docs/{docId}',
    tag: 'Vault',
    summary:
      'Read one caller-owned opaque vault document byte-for-byte with its per-document ETag.',
    description:
      'The server reads only the six cleartext addressing/idempotency header fields and never parses the encrypted payload.',
    params: contracts.vaultDocParamsSchema,
    requestHeaders: perVaultConditionalReadHeaders,
    status: 200,
    response: z.string().openapi({
      type: 'string',
      format: 'binary',
      description: 'Opaque envelope-v2 document bytes (never interpreted server-side).',
    }),
    responseContentType: 'application/octet-stream',
    responseHeaders: perVaultEtagResponseHeaders,
    notModified: 'If-None-Match already holds the current document version; no ciphertext follows.',
    errorResponses: {
      404: 'No such caller-owned vault document (VAULT_NOT_FOUND).',
      409: 'The server medium is not active for this vault (VAULT_MEDIA_STATE_CONFLICT).',
    },
    errorCodes: contracts.PER_VAULT_DOC_READ_ERROR_CODES,
  },
  {
    method: 'put',
    path: '/vaults/{vaultId}/docs/{docId}',
    tag: 'Vault',
    summary:
      'Compare-and-swap one opaque vault document using If-None-Match: * or If-Match: "<version>".',
    description:
      'A stale or missing precondition returns 412 or 428 without mutation. Per-kind byte caps return 413. Replaying the same (vaultId, docId, writeId) at the current docVersion is a no-op. The two 412 meanings carry DIFFERENT codes: VAULT_PRECONDITION_FAILED is retryable after a re-read/re-merge, while VAULT_WRITE_ID_REPLAYED is terminal for that writeId — the same request can never be accepted and the client must mint a new writeId.',
    params: contracts.vaultDocParamsSchema,
    requestHeaders: perVaultCasWriteHeaders,
    body: z.string().openapi({
      type: 'string',
      format: 'binary',
      description: 'Opaque envelope-v2 document bytes (never interpreted server-side).',
    }),
    bodyContentType: 'application/octet-stream',
    status: 204,
    responseHeaders: perVaultEtagResponseHeaders,
    errorResponses: {
      404: 'No such caller-owned vault document (VAULT_NOT_FOUND).',
      409: 'The server medium is not active for this vault (VAULT_MEDIA_STATE_CONFLICT).',
      412: 'Retryable stale precondition (VAULT_PRECONDITION_FAILED) or the terminal writeId replay with different bytes (VAULT_WRITE_ID_REPLAYED). Both carry the top-level currentVersion.',
      413: 'The document exceeds its configured per-kind byte cap (VAULT_TOO_LARGE).',
      428: 'Neither If-Match nor If-None-Match: * was supplied (VAULT_PRECONDITION_REQUIRED).',
    },
    errorCodes: contracts.PER_VAULT_DOC_WRITE_ERROR_CODES,
  },
  {
    method: 'get',
    path: '/vaults/{vaultId}/docs/{docId}/history',
    tag: 'Vault',
    summary: 'List retained ciphertext-history metadata for one caller-owned vault document.',
    params: contracts.vaultDocParamsSchema,
    query: contracts.vaultHistoryListQuerySchema,
    status: 200,
    response: R.VaultHistoryListResponse,
  },
  {
    method: 'get',
    path: '/vaults/{vaultId}/docs/{docId}/history/{version}',
    tag: 'Vault',
    summary: 'Read one retained historical vault document as byte-identical opaque ciphertext.',
    params: contracts.vaultDocHistoryVersionParamSchema,
    status: 200,
    response: z.string().openapi({
      type: 'string',
      format: 'binary',
      description: 'Opaque historical envelope-v2 document bytes.',
    }),
    responseContentType: 'application/octet-stream',
    responseHeaders: perVaultHistoryResponseHeaders,
  },
  {
    method: 'get',
    path: '/vaults/{vaultId}/media',
    tag: 'Vault',
    summary:
      'Read one vault’s durable media selection, attestation, candidate and retirement metadata.',
    params: contracts.vaultIdParamSchema,
    status: 200,
    response: R.PerVaultMediaStateResponse,
  },
  {
    method: 'patch',
    path: '/vaults/{vaultId}/media',
    tag: 'Vault',
    summary:
      'Commit one verified full-document-set media transition; removing server retires bytes instead of purging them.',
    description:
      'The two 412 meanings carry DIFFERENT codes: VAULT_MEDIA_VERIFICATION_FAILED is worth retrying with a fresh readback, while VAULT_MEDIA_CAPTURE_IN_FLIGHT is terminal for this caller — the readback is exact except for documents an interrupted portfolio move-in staged in the vault, whose ids are listed in error.details.portfolioIds. That move must be finished or cancelled first.',
    params: contracts.vaultIdParamSchema,
    body: R.PerVaultMediaTransitionRequest,
    status: 200,
    response: R.PerVaultMediaTransitionResponse,
    errorResponses: {
      400: 'The requested selection names the reserved local medium (VAULT_MEDIA_RESERVED).',
      404: 'No such caller-owned vault (VAULT_NOT_FOUND).',
      409: 'The durable media state, Drive binding, or a pending retirement refuses this transition (VAULT_MEDIA_STATE_CONFLICT / VAULT_DRIVE_BINDING_INVALID / VAULT_RETIRED_SERVER_CONFLICT / VAULT_RETIREMENT_PENDING).',
      412: 'The submitted full-document-set readback does not cover or does not match what the server holds (VAULT_MEDIA_PARTIAL_SET / VAULT_MEDIA_VERIFICATION_FAILED / VAULT_MEDIA_CAPTURE_IN_FLIGHT).',
    },
    errorCodes: contracts.PER_VAULT_MEDIA_TRANSITION_ERROR_CODES,
  },
  {
    method: 'put',
    path: '/vaults/{vaultId}/media/server-candidate/{transitionId}/docs/{docId}',
    tag: 'Vault',
    summary:
      'Stage one opaque server candidate inside a client-chosen full-document-set transition.',
    params: contracts.perVaultServerCandidateStageParamsSchema,
    body: z.string().openapi({
      type: 'string',
      format: 'binary',
      description: 'Opaque inactive envelope-v2 candidate bytes.',
    }),
    bodyContentType: 'application/octet-stream',
    status: 200,
    response: R.PerVaultServerCandidateMetadata,
    errorResponses: {
      413: 'The candidate exceeds its configured per-kind byte cap (VAULT_TOO_LARGE).',
    },
  },
  {
    method: 'get',
    path: '/vaults/{vaultId}/media/server-candidate/{candidateId}',
    tag: 'Vault',
    summary:
      'Read back one caller-owned inactive server candidate and receive its verification receipt.',
    params: contracts.perVaultServerCandidateReadParamsSchema,
    status: 200,
    response: z.string().openapi({
      type: 'string',
      format: 'binary',
      description: 'Opaque inactive envelope-v2 candidate bytes.',
    }),
    responseContentType: 'application/octet-stream',
    responseHeaders: perVaultCandidateReadbackResponseHeaders,
  },
  {
    method: 'post',
    path: '/vaults/{vaultId}/media/retired/purge/challenge',
    tag: 'Vault',
    summary:
      'Issue a short-lived challenge bound to one retirement generation and version-set hash.',
    params: contracts.vaultIdParamSchema,
    body: R.PerVaultRetiredServerPurgeChallengeRequest,
    status: 200,
    response: R.PerVaultRetiredServerPurgeChallengeResponse,
  },
  {
    method: 'post',
    path: '/vaults/{vaultId}/media/retired/purge',
    tag: 'Vault',
    summary:
      'Purge a retained server set only after the retention floor and a valid Ed25519 transcript proof.',
    params: contracts.vaultIdParamSchema,
    body: R.PerVaultRetiredServerPurgeRequest,
    status: 200,
    response: R.PerVaultRetiredServerPurgeResponse,
  },

  // Per-portfolio capture + destructive move pipeline (E4 #1414).
  {
    method: 'get',
    path: '/portfolios/{portfolioId}/vault/revision',
    tag: 'Vault',
    summary: 'Read the opaque portfolio capture-to-commit CAS revision.',
    description:
      'Available to an owning session or a bearer holding account:security. Read this no-store token before and after capture; the client accepts the capture only when both values match. The digest covers the target portfolio’s restorable cleartext rows and contains no portfolio content.',
    params: contracts.portfolioIdParamSchema,
    status: 200,
    response: R.PortfolioVaultRevisionResponse,
    noStore: true,
    errorResponses: {
      404: 'The portfolio is absent or not owned (PORTFOLIO_VAULT_NOT_FOUND).',
      409: 'The portfolio is already vaulted or cannot currently be captured.',
      429: 'The dedicated vault-transition rate limit was exceeded.',
    },
  },
  {
    method: 'get',
    path: '/portfolios/{portfolioId}/vault/lifecycle',
    tag: 'Vault',
    summary: 'Read a vaulted portfolio’s current membership lifecycle generation.',
    description:
      'Available to an owning session or a bearer holding account:security. §10 allows move-out from any unlocked device holding the phrase, but the server-minted lifecycle generation the move-out proof binds to was only ever returned by the original move-in commit — this no-store read recovers that non-sensitive transition metadata (E6 residual, #1525). It carries no portfolio content.',
    params: contracts.portfolioIdParamSchema,
    status: 200,
    response: R.PortfolioVaultLifecycleResponse,
    noStore: true,
    errorResponses: {
      404: 'The portfolio is absent or not owned (PORTFOLIO_VAULT_NOT_FOUND).',
      409: 'The portfolio is not stored in a vault, or its transition state is inconsistent.',
      429: 'The dedicated vault-transition rate limit was exceeded.',
    },
  },
  {
    method: 'get',
    path: '/portfolios/{portfolioId}/vault/import-batches',
    tag: 'Vault',
    summary: 'Read a plain portfolio’s historical import batches and staging rows losslessly.',
    description:
      'The lossless capture read that lets the §9 move-in carry historical import batches into the encrypted portfolio document instead of refusing (#1529, lifting the #1528 fail-closed ruling). Owner-scoped; every batch keyed to the portfolio rides on every page, staging rows page by an opaque cursor, and every column is served exactly as stored (decimals as strings). Session-only by the vault-namespace fence (bearer admission deferred: raw staging rows and memos must not reach third-party keys) — NOT a transition carve-out: a vaulted portfolio is refused at the enforcement boundary. Responses are no-store.',
    params: contracts.portfolioIdParamSchema,
    query: contracts.portfolioVaultImportCaptureQuerySchema,
    status: 200,
    response: R.PortfolioVaultImportCaptureResponse,
    noStore: true,
    errorResponses: {
      404: 'The portfolio is absent or not owned (PORTFOLIO_VAULT_NOT_FOUND).',
      409: 'The portfolio is already stored in a vault, the cursor does not belong to this read, or a stored staging row cannot be served losslessly (PORTFOLIO_VAULT_CAPTURE_UNSERVABLE).',
    },
  },
  {
    method: 'post',
    path: '/portfolios/{portfolioId}/vault/move-in',
    tag: 'Vault',
    summary: 'Commit a verified encrypted capture and hard-delete its server cleartext.',
    description:
      'DESTRUCTIVE: available to an owning session or a bearer holding account:security, with the same password/TOTP/recovery-code step-up in the request body. The in-body credential replaces CSRF + same-origin on the bearer path. The commit rechecks media, document-set and portfolio-revision CAS facts before one atomic purge; every refusal leaves cleartext untouched. Responses are no-store.',
    params: contracts.portfolioIdParamSchema,
    body: R.PortfolioVaultMoveInRequest,
    status: 200,
    response: R.PortfolioVaultMoveInResponse,
    noStore: true,
    errorResponses: {
      404: 'The portfolio or target vault is absent or not owned.',
      409: 'The portfolio is already vaulted, a transition/precondition conflicts, media are not verified, or the encrypted document set is stale.',
      412: 'The capture revision or encrypted portfolio document version is stale; nothing was purged.',
      429: 'Step-up verification or the dedicated move-in transition throttle was exceeded.',
    },
  },
  {
    method: 'post',
    path: '/portfolios/{portfolioId}/vault/move-out/challenge',
    tag: 'Vault',
    summary: 'Issue a graph-bound challenge for the unlocked-client move-out proof.',
    description:
      'Available to an owning session or a bearer holding account:security. The unlocked client hashes its canonical strict restore graph and exact opened document-version set. The server CAS-checks that set against the locked current ciphertext roster before returning a challenge; the client signs the transcript with the Ed25519 private key carried only inside the encrypted common document. Responses are no-store.',
    params: contracts.portfolioIdParamSchema,
    body: R.PortfolioVaultMoveOutChallengeRequest,
    status: 200,
    response: R.PortfolioVaultMoveOutChallengeResponse,
    noStore: true,
    errorResponses: {
      404: 'The vaulted portfolio or vault is absent or not owned.',
      409: 'The portfolio is not in the requested vault lifecycle.',
      412: 'The encrypted document set changed after the client opened it.',
      429: 'The dedicated vault-transition rate limit was exceeded.',
    },
  },
  {
    method: 'post',
    path: '/portfolios/{portfolioId}/vault/move-out',
    tag: 'Vault',
    summary: 'Restore one unlocked vault portfolio under the same UUID.',
    description:
      'WARNING: the portfolio becomes server-readable again. This operation is available only from an unlocked phrase-holding client, which supplies the strict restore document and a signed current encrypted-document-set CAS, and to an owning session or bearer holding account:security with the same in-body password/TOTP/recovery-code step-up. The in-body credential replaces CSRF + same-origin on the bearer path. Validation, fork-provenance proof and option-B solvency run before any restore write; responses are no-store.',
    params: contracts.portfolioIdParamSchema,
    body: R.PortfolioVaultMoveOutRequest,
    status: 200,
    response: R.PortfolioVaultMoveOutResponse,
    noStore: true,
    errorResponses: {
      400: 'The request or strict restore graph is invalid, insolvent, or fails retained fork-provenance validation.',
      404: 'The vaulted portfolio or vault is absent or not owned.',
      409: 'The portfolio is not vaulted, media are not verified, or another transition/history write conflicts.',
      412: 'The encrypted document set changed or the graph-bound phrase-possession proof is invalid.',
      413: 'The decrypted restore document exceeds the bounded portfolio restore payload ceiling.',
      429: 'Step-up verification or the dedicated move-out transition throttle was exceeded.',
    },
  },

  // Legacy account-singleton paranoid vault — kept unchanged through E9.
  {
    method: 'get',
    path: '/vault/history',
    tag: 'Vault',
    summary:
      'List one bounded, newest-first page of retained server ciphertext metadata. The hard page cap is enforced server-side; no cleartext-derived fields are returned.',
    query: contracts.vaultHistoryListQuerySchema,
    status: 200,
    response: R.VaultHistoryListResponse,
  },
  {
    method: 'get',
    path: '/vault/history/{version}',
    tag: 'Vault',
    summary:
      'Read one owner-scoped retained vault version as byte-identical opaque ciphertext. Version, archive time, byte size and server medium are the only vault metadata exposed.',
    params: contracts.vaultHistoryVersionParamSchema,
    status: 200,
    response: z.string().openapi({
      type: 'string',
      format: 'binary',
      description: 'Opaque historical vault envelope bytes (never interpreted server-side).',
    }),
    responseContentType: 'application/octet-stream',
  },
  {
    method: 'get',
    path: '/vault',
    tag: 'Vault',
    summary:
      'Read the account’s opaque encrypted vault blob (application/octet-stream) with an ETag of its version. 404 when no vault exists; 304 when If-None-Match already holds the current version; 409 VAULT_SERVER_MEDIUM_INACTIVE for a normal-mode account outside a live owner enable window, and for any bearer while the account is not paranoid. The server never decrypts or parses the ciphertext.',
    status: 200,
    response: z.string().openapi({
      type: 'string',
      format: 'binary',
      description: 'Opaque AES-256-GCM vault envelope bytes (never interpreted server-side).',
    }),
    responseContentType: 'application/octet-stream',
    notModified: 'If-None-Match already holds the current vault version; no ciphertext follows.',
    errorResponses: {
      404: 'No vault blob is stored for this account (VAULT_NOT_FOUND).',
      409: 'The server vault medium is inactive (VAULT_SERVER_MEDIUM_INACTIVE).',
    },
    errorCodes: [
      contracts.VAULT_ERROR_CODES.notFound,
      contracts.VAULT_ERROR_CODES.serverMediumInactive,
    ],
  },
  {
    method: 'get',
    path: '/vault/media',
    tag: 'Vault',
    summary:
      'Read the owner’s durable paranoid media selection and active/inactive-candidate/retired server disposition. The JSON contains no ciphertext.',
    status: 200,
    response: R.ParanoidMediaStateResponse,
  },
  {
    method: 'patch',
    path: '/vault/media',
    tag: 'Vault',
    summary:
      'Move exactly one paranoid storage medium. Removing server retires opaque bytes; it never purges them.',
    body: R.ParanoidMediaTransitionRequest,
    status: 200,
    response: R.ParanoidMediaTransitionResponse,
  },
  {
    method: 'put',
    path: '/vault/media/server-candidate',
    tag: 'Vault',
    summary:
      'Stage a Drive-source opaque envelope outside the active server vault. The browser must read it back and authenticate it before promotion.',
    body: z.string().openapi({
      type: 'string',
      format: 'binary',
      description: 'Opaque candidate vault envelope bytes.',
    }),
    bodyContentType: 'application/octet-stream',
    status: 200,
    response: R.ParanoidServerCandidateMetadata,
  },
  {
    method: 'get',
    path: '/vault/media/server-candidate/{candidateId}',
    tag: 'Vault',
    summary:
      'Read one owner-scoped inactive candidate as opaque bytes and receive the short-lived read-back receipt needed for promotion.',
    params: contracts.paranoidServerCandidateParamSchema,
    status: 200,
    response: z.string().openapi({
      type: 'string',
      format: 'binary',
      description: 'Opaque inactive candidate vault envelope bytes.',
    }),
    responseContentType: 'application/octet-stream',
  },
  {
    method: 'post',
    path: '/vault/media/retired/purge/challenge',
    tag: 'Vault',
    summary:
      'Issue a short-lived browser-session challenge for an explicit retired server set. It does not purge anything.',
    body: R.RetiredServerPurgeChallengeRequest,
    status: 200,
    response: R.RetiredServerPurgeChallengeResponse,
  },
  {
    method: 'post',
    path: '/vault/media/retired/purge',
    tag: 'Vault',
    summary:
      'After the minimum recovery retention, purge retired server bytes only with a fresh signature from the client-decrypted vault key.',
    body: R.RetiredServerPurgeRequest,
    status: 200,
    response: R.RetiredServerPurgeResponse,
  },
  {
    method: 'put',
    path: '/vault',
    tag: 'Vault',
    summary:
      'Compare-and-swap write of the opaque vault blob. If-None-Match: * creates the first blob; If-Match: "<version>" replaces the matching one. A stale/missing precondition returns 412/428 and never overwrites newer ciphertext; an oversized payload is 413.',
    body: z.string().openapi({
      type: 'string',
      format: 'binary',
      description: 'Opaque AES-256-GCM vault envelope bytes (never interpreted server-side).',
    }),
    bodyContentType: 'application/octet-stream',
    status: 204,
    errorResponses: {
      409: 'The server vault medium is inactive, or the retirement proof key is immutable (VAULT_SERVER_MEDIUM_INACTIVE / VAULT_RETIRED_SERVER_CONFLICT).',
      412: 'The precondition lost the CAS race; the top-level currentVersion names the winner (VAULT_PRECONDITION_FAILED).',
      413: 'The ciphertext exceeds the configured size cap (VAULT_TOO_LARGE).',
      428: 'Neither If-Match nor If-None-Match: * was supplied (VAULT_PRECONDITION_REQUIRED).',
    },
    errorCodes: [
      contracts.VAULT_ERROR_CODES.preconditionRequired,
      contracts.VAULT_ERROR_CODES.preconditionFailed,
      contracts.VAULT_ERROR_CODES.tooLarge,
      contracts.VAULT_ERROR_CODES.malformed,
      contracts.VAULT_ERROR_CODES.serverMediumInactive,
      contracts.VAULT_ERROR_CODES.retirementConflict,
    ],
  },

  {
    method: 'post',
    path: '/auth/reauth',
    tag: 'Auth',
    summary:
      'Generic session step-up: re-verify the CURRENT session user’s password. 204 on success, 401 on mismatch, 429 under the dedicated per-account throttle. Mints nothing — the caller gates its own surface on the response, so there is no artifact to store or replay. `purpose` is audit provenance only and never affects what is verified. Cookie-session only.',
    body: contracts.reauthRequestSchema,
    status: 204,
  },
];

const jsonContent = (schema: z.ZodTypeAny) => ({ 'application/json': { schema } });
const errorResponse = (description: string, headers?: z.AnyZodObject) => ({
  description,
  ...(headers ? { headers } : {}),
  content: jsonContent(R.ApiError),
});

function errorCodesForEndpoint(endpoint: EndpointDef): string[] {
  return [
    ...(endpoint.public ? [] : [contracts.AUTH_ERROR_CODES.unauthenticated]),
    ...(!endpoint.public && pathRequiresPasswordChange(endpoint.path)
      ? [contracts.AUTH_ERROR_CODES.passwordChangeRequired]
      : []),
    ...(pathRequiresAdminTwoFactorSetup(endpoint.path, endpoint.method)
      ? [contracts.ADMIN_2FA_SETUP_REQUIRED]
      : []),
    ...(endpoint.errorCodes ?? []),
  ].filter((code, index, all) => all.indexOf(code) === index);
}

/**
 * zod-to-openapi v7 preserves operation metadata but drops specification
 * extensions from response configs. Apply the operation-level extension to its
 * generated output instead, leaving the wire `ApiError` schema unchanged.
 */
function addErrorCodeExtensions<T extends { paths: Record<string, unknown> }>(document: T): T {
  for (const endpoint of endpoints) {
    const errorCodes = errorCodesForEndpoint(endpoint);
    if (errorCodes.length === 0) continue;

    const pathItem = document.paths[endpoint.path] as Record<string, unknown> | undefined;
    const operation = pathItem?.[endpoint.method] as Record<string, unknown> | undefined;
    if (!operation) {
      // The same endpoint table registers the operation above. A mismatch would
      // make this published vocabulary incomplete, so fail fast during document
      // generation instead of serving misleading API metadata.
      throw new Error(
        `OpenAPI operation missing while adding error-code metadata: ${endpoint.method.toUpperCase()} ${endpoint.path}`,
      );
    }
    operation['x-error-codes'] = errorCodes;
  }
  return document;
}

for (const ep of endpoints) {
  const responses: Record<string, ResponseConfig> = {};
  const responseHeaders = ep.noStore
    ? ep.responseHeaders
      ? noStoreResponseHeaders.merge(ep.responseHeaders)
      : noStoreResponseHeaders
    : ep.responseHeaders;
  const successHeaders = responseHeaders ? { headers: responseHeaders } : {};
  const errorHeaders = ep.noStore ? noStoreResponseHeaders : undefined;
  responses[ep.status] = ep.response
    ? {
        description: 'Success.',
        ...successHeaders,
        content: ep.responseContentType
          ? { [ep.responseContentType]: { schema: ep.response } }
          : jsonContent(ep.response),
      }
    : { description: 'No content.', ...successHeaders };
  if (ep.body || ep.query || ep.params) {
    responses['400'] = errorResponse('Invalid request (VALIDATION_ERROR).', errorHeaders);
  }
  if (!ep.public) {
    responses['401'] = errorResponse('Authentication required.', errorHeaders);
  }
  if (ep.unavailableResponse) {
    responses['503'] = {
      description: 'Required dependency unavailable.',
      content: jsonContent(ep.unavailableResponse),
    };
  }
  // Idempotency conflict semantics (§13.4 V4-P2a, #417): reusing a key for a
  // different request, or racing an in-flight one, is a typed 409.
  if (ep.idempotent) {
    responses['409'] = errorResponse(
      'Idempotency-Key conflict (IDEMPOTENCY_KEY_MISMATCH / IDEMPOTENCY_IN_PROGRESS).',
      errorHeaders,
    );
  }
  if (ep.notModified) {
    // No content member: RFC 9110 §15.4.5 forbids a 304 body, so the response
    // carries only the same validators the 200 would have sent.
    responses['304'] = { description: ep.notModified, ...successHeaders };
  }
  for (const [status, description] of Object.entries(ep.errorResponses ?? {})) {
    responses[status] = errorResponse(description, errorHeaders);
  }
  // Shared error envelope `{ error: { code, message, details? } }` (§8).
  responses['default'] = errorResponse('Error envelope.', errorHeaders);

  // Auth requirement per route (#361): public routes need none; every guarded
  // route accepts the session cookie, and those the bearer middleware admits
  // (identity, logout, scope-gated modules + the account-security surface) ALSO
  // accept `Authorization: Bearer …`. Derived from the real middleware policy
  // (`openApiPathTemplateAcceptsBearer`) so the spec cannot drift from what the
  // API enforces —
  // fixing the prior blanket "sessionCookie only" claim on every route.
  const security: Record<string, string[]>[] = ep.public
    ? []
    : openApiPathTemplateAcceptsBearer(ep.path, ep.method)
      ? [{ [SESSION_SECURITY]: [] }, { [BEARER_SECURITY]: [] }]
      : [{ [SESSION_SECURITY]: [] }];
  const requestHeaders =
    ep.idempotent && ep.requestHeaders
      ? idempotencyKeyHeaders.merge(ep.requestHeaders)
      : (ep.requestHeaders ?? (ep.idempotent ? idempotencyKeyHeaders : undefined));

  registry.registerPath({
    method: ep.method,
    path: ep.path,
    tags: [ep.tag],
    summary: ep.summary,
    ...(ep.description ? { description: ep.description } : {}),
    security,
    request: {
      ...(ep.params ? { params: ep.params } : {}),
      ...(ep.query ? { query: ep.query } : {}),
      ...(requestHeaders ? { headers: requestHeaders } : {}),
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
  '`x-error-codes` is an additive list of stable, module-owned `ApiError.error.code` values, not an exhaustive refusal vocabulary.',
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
  return withVaultJsonDocumentation(() => generateOpenApiDocument());
}

function generateOpenApiDocument() {
  const generator = new OpenApiGeneratorV3(registry.definitions);
  return addErrorCodeExtensions(
    generator.generateDocument({
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
      servers: [
        { url: '/api/v1', description: 'BetterTrack API v1 (relative to the API origin).' },
      ],
      // Either scheme authenticates a request; API-key scopes further gate access.
      security: [{ [SESSION_SECURITY]: [] }, { [BEARER_SECURITY]: [] }],
    }),
  );
}

let cached: ReturnType<typeof buildOpenApiDocument> | null = null;

/** The generated document, built once and reused. */
export function getOpenApiDocument() {
  cached ??= buildOpenApiDocument();
  return cached;
}
