/**
 * Declarative paranoid-mode enforcement inventory.
 *
 * This module deliberately has no Express, service, job, or repository imports:
 * it is a data-and-accessor foundation only. The enforcement composition belongs
 * to #884; keeping this inventory inert lets the completeness harness prove that
 * every account-facing surface has an explicit policy before any guard is wired.
 */

/** Stable capability names shared by the later #884 enforcement composition. */
export type ParanoidKilledCapability =
  | 'publicProfile'
  | 'sharing'
  | 'mirrorchain'
  | 'portfolioServer'
  | 'imports'
  | 'portfolioApiScope'
  | 'standingOrderExecution'
  | 'portfolioJobs'
  | 'portfolioWebhooks';

export interface ParanoidSurfaceSource {
  readonly file: string;
  readonly symbol: string;
}

export interface ParanoidRouteSurface {
  readonly kind: 'route';
  readonly source: ParanoidSurfaceSource;
  readonly method: string;
  /**
   * API-relative under `/api/v1` (for example `/portfolios/{portfolioId}`),
   * or root-relative for endpoints mounted outside that prefix.
   */
  readonly path: string;
}

/** Synthetic method identity for an explicit-path opaque `app.use` leaf mount. */
export const PARANOID_OPAQUE_MOUNT_METHOD = '<opaque-mount>';

/** Synthetic method identity for an `app.all`/`router.all` route. */
export const PARANOID_ALL_METHODS_ROUTE_METHOD = '<all-methods>';

export interface ParanoidServiceSurface {
  readonly kind: 'service';
  readonly source: ParanoidSurfaceSource;
  readonly service: string;
  readonly method: string;
}

/** Synthetic method identity used when an AppContext field is directly callable. */
export const PARANOID_DIRECT_SERVICE_CALL = '<call>';

export interface ParanoidJobSurface {
  readonly kind: 'job';
  readonly source: ParanoidSurfaceSource;
  readonly name: string;
}

/** A named internal account path that needs a tracked temporary exception. */
export interface ParanoidInternalSurface {
  readonly kind: 'internal';
  readonly source: ParanoidSurfaceSource;
}

export type ParanoidSurface =
  | ParanoidRouteSurface
  | ParanoidServiceSurface
  | ParanoidJobSurface
  | ParanoidInternalSurface;

export interface ParanoidGuardedClassification {
  readonly disposition: 'guarded';
  readonly capability: ParanoidKilledCapability;
}

export interface ParanoidExemptClassification {
  readonly disposition: 'exempt';
  /** Why keeping this surface available does not expose server-side portfolio data. */
  readonly reason: string;
  /** Temporary exceptions remain visible to the follow-up that closes them. */
  readonly knownGapIssue?: 884;
  readonly knownGapId?: string;
}

export type ParanoidSurfaceClassification =
  | ParanoidGuardedClassification
  | ParanoidExemptClassification;

export interface ParanoidRouteRule {
  readonly method?: string;
  readonly exact?: string;
  readonly prefix?: string;
  readonly pattern?: RegExp;
  /** Required for exemptions that apply only to one known opaque handler. */
  readonly source?: ParanoidSurfaceSource;
}

export interface ParanoidExemptRouteRule extends ParanoidRouteRule {
  readonly reason: string;
}

export type ParanoidServiceSubject =
  | 'userIdFirst'
  | 'userIdFirstAndDynamicPrincipals'
  | 'userIdField'
  | 'portfolioIdFirst'
  | 'portfolioIdFirstAllowMissing'
  | 'assetIdFirst'
  | 'paranoidWebhookSubjects'
  | 'dynamicPrincipals'
  | 'intrinsic';

export type ParanoidSemanticCoverage =
  | 'accountMode'
  | 'dynamicPrincipals'
  | 'ownedAssetProvenance'
  | 'queuedPrincipals';

/** A future #884 proxy binding. This issue only records it; it mounts nothing. */
export interface ParanoidServiceBinding {
  readonly capability: ParanoidKilledCapability;
  readonly service: string;
  /** Exact method names, `*`, or a prefix glob such as `submit*`. */
  readonly methods: readonly string[];
  readonly subject: ParanoidServiceSubject;
  readonly action?: 'throw' | 'skip';
  readonly coverage?: readonly ParanoidSemanticCoverage[];
}

/** Explicit non-killed policy for a context service method. */
export interface ParanoidServiceExemption {
  readonly service: string;
  readonly methods: readonly string[];
  readonly handling: 'kept' | 'internallyFiltered' | 'dynamicPrincipals';
  readonly reason: string;
  readonly coverage?: readonly ParanoidSemanticCoverage[];
}

export type ParanoidJobMode =
  | 'kept'
  | 'internallyFiltered'
  | 'portfolio'
  | 'perUser'
  | 'serviceFiltered'
  | 'event';

export type ParanoidJobPolicy =
  | {
      readonly capability: ParanoidKilledCapability;
      readonly mode: ParanoidJobMode;
    }
  | {
      readonly capability: null;
      readonly mode: ParanoidJobMode;
      readonly reason: string;
      readonly knownGapId?: string;
    };

export interface ParanoidJobPolicyEntry {
  readonly surface: ParanoidJobSurface;
  readonly policy: ParanoidJobPolicy;
}

export interface ParanoidKillRegistryEntry {
  readonly capability: ParanoidKilledCapability;
  readonly routes: readonly ParanoidRouteRule[];
  readonly services: readonly ParanoidServiceBinding[];
  readonly scopes: readonly string[];
  readonly jobs: readonly string[];
  readonly webhookEventTypes: readonly string[];
}

export const PARANOID_ROUTE_TABLE_SOURCE: ParanoidSurfaceSource = {
  file: 'apps/api/src/app.ts',
  symbol: 'createApp',
};

export const PARANOID_ACCOUNT_CONTEXT_SOURCE: ParanoidSurfaceSource = {
  file: 'apps/api/src/http/context.ts',
  symbol: 'AppContext',
};

const serviceBinding = (
  capability: ParanoidKilledCapability,
  service: string,
  subject: ParanoidServiceSubject,
  methods: readonly string[],
  action?: 'throw' | 'skip',
  coverage?: readonly ParanoidSemanticCoverage[],
): ParanoidServiceBinding => ({
  capability,
  service,
  subject,
  methods,
  ...(action ? { action } : {}),
  ...(coverage ? { coverage } : {}),
});

const serviceExemption = (
  service: string,
  methods: readonly string[],
  handling: ParanoidServiceExemption['handling'],
  reason: string,
  coverage?: readonly ParanoidSemanticCoverage[],
): ParanoidServiceExemption => ({
  service,
  methods,
  handling,
  reason,
  ...(coverage ? { coverage } : {}),
});

/**
 * Future executable bindings for account-context services. They are inventory
 * only here: no route, service, or job imports this module until #884.
 */
export const PARANOID_SERVICE_BINDINGS: readonly ParanoidServiceBinding[] = [
  serviceBinding('publicProfile', 'social', 'intrinsic', [
    'getPublicProfile',
    'getPublicProfileItem',
  ]),
  serviceBinding('sharing', 'workboard', 'userIdFirst', ['getSharing', 'setSharing']),
  serviceBinding('sharing', 'ideas', 'userIdFirst', ['clone']),
  serviceBinding('sharing', 'backtest', 'userIdFirst', ['runSharedSandboxPreview']),
  serviceBinding('sharing', 'comments', 'userIdFirst', ['*']),
  serviceBinding('sharing', 'alerts', 'userIdFirst', ['getSharing', 'setSharing']),
  serviceBinding('sharing', 'social', 'userIdFirst', [
    'listGroups',
    'createGroup',
    'renameGroup',
    'deleteGroup',
    'addGroupMember',
    'removeGroupMember',
    'followUser',
    'unfollowUser',
    'updateFollow',
    'unfollowItem',
    'listItemFollows',
    'listMyShared',
    'getAudience',
    'setAudience',
    'applyAudienceVisibility',
  ]),
  serviceBinding('sharing', 'social', 'intrinsic', ['getByPublicLink']),
  serviceBinding('mirrorchain', 'mirror', 'userIdFirst', [
    'enrichPortfolioSummaries',
    'convertToChain',
    'createChain',
    'convertChain',
    'declineInvite',
    'revokeInvite',
  ]),
  serviceBinding(
    'mirrorchain',
    'mirror',
    'dynamicPrincipals',
    [
      'listChainsForUser',
      'getMemberList',
      'getActivity',
      'listInvites',
      'setMemberRole',
      'transferOwnership',
      'removeMember',
      'leaveChain',
      'renameChain',
      'dissolveChain',
    ],
    undefined,
    ['dynamicPrincipals'],
  ),
  serviceBinding(
    'mirrorchain',
    'mirror',
    'userIdFirstAndDynamicPrincipals',
    ['submit*'],
    undefined,
    ['dynamicPrincipals'],
  ),
  serviceBinding('mirrorchain', 'mirror', 'portfolioIdFirstAllowMissing', [
    'syncedMembership',
    'overlayForPortfolio',
  ]),
  serviceBinding('portfolioServer', 'portfolio', 'userIdFirst', ['*']),
  serviceBinding('portfolioServer', 'customAssets', 'userIdFirst', ['*']),
  serviceBinding('portfolioServer', 'analytics', 'userIdFirst', ['*']),
  serviceBinding('portfolioServer', 'portfolioMarketIntel', 'userIdFirst', ['*']),
  serviceBinding('portfolioServer', 'marketIntel', 'userIdFirst', ['newsDigest']),
  serviceBinding('portfolioServer', 'tax', 'userIdFirst', [
    'getSettings',
    'updateSettings',
    'getEffectiveSettings',
    'getPortfolioTaxSettings',
    'setPortfolioTaxOverride',
    'clearPortfolioTaxOverride',
    'planTransactionDeleteCorrections',
    'recordDividend',
    'listDividends',
    'deleteDividend',
    'getYearReports',
    'getYearReport',
  ]),
  serviceBinding('portfolioServer', 'tax', 'userIdField', ['planTransactionTaxes']),
  serviceBinding('portfolioServer', 'expenses', 'userIdFirst', ['*']),
  serviceBinding('portfolioServer', 'expenseBudgets', 'userIdFirst', ['*']),
  serviceBinding('portfolioServer', 'aiFeatures', 'userIdFirst', ['insights']),
  serviceBinding('portfolioServer', 'snapshots', 'portfolioIdFirst', [
    'getSeries',
    'getOverlays',
    'invalidate',
    'getStateUpdatedAt',
    'recompute',
  ]),
  serviceBinding('portfolioServer', 'snapshots', 'assetIdFirst', [
    'resolveAssetReferences',
    'invalidateForAsset',
  ]),
  serviceBinding('imports', 'imports', 'userIdFirst', [
    'createBatch',
    'getBatch',
    'applyBatch',
    'discardBatch',
  ]),
  serviceBinding('imports', 'expenseImports', 'userIdFirst', ['preview', 'apply']),
  serviceBinding('standingOrderExecution', 'standingOrders', 'userIdFirst', [
    'list',
    'get',
    'create',
    'update',
    'pause',
    'resume',
    'remove',
  ]),
  serviceBinding(
    'portfolioWebhooks',
    'webhookBridge',
    'paranoidWebhookSubjects',
    ['handleEvent'],
    'skip',
  ),
] as const;

/**
 * Explicit non-killed policy for every mixed service above. `reason` is
 * deliberately mandatory: "not guarded" is never an implicit default.
 */
export const PARANOID_SERVICE_EXEMPTIONS: readonly ParanoidServiceExemption[] = [
  serviceExemption(
    'conglomerate',
    ['*'],
    'kept',
    'Conglomerate definitions are account-local configuration; their sharing surfaces are classified separately.',
  ),
  serviceExemption(
    'workboard',
    ['removeItem', 'reorder', 'createWatchlist', 'deleteWatchlist'],
    'kept',
    'Local workboard organization remains available and does not expose server-side portfolio values.',
  ),
  serviceExemption(
    'workboard',
    ['list', 'listInWatchlist', 'listWatchlists', 'addItem', 'renameWatchlist'],
    'internallyFiltered',
    'The service filters account-owned asset provenance before returning or accepting workboard rows.',
    ['accountMode', 'ownedAssetProvenance'],
  ),
  serviceExemption(
    'workboard',
    ['itemsForSharedView'],
    'internallyFiltered',
    'Shared-view discovery resolves its audience principals before exposing any item.',
    ['dynamicPrincipals', 'ownedAssetProvenance'],
  ),
  serviceExemption(
    'ideas',
    ['list', 'get', 'create', 'update', 'remove'],
    'kept',
    'Ideas stay private local notes.',
  ),
  serviceExemption(
    'backtest',
    ['runPreview', 'runComparison'],
    'internallyFiltered',
    'Draft backtests resolve only allowed assets and never require a server portfolio read.',
    ['accountMode', 'ownedAssetProvenance'],
  ),
  serviceExemption(
    'social',
    [
      'sendRequest',
      'listRequests',
      'accept',
      'decline',
      'cancel',
      'listFriends',
      'removeFriend',
      'followItem',
      'listFollowing',
      'listFollowers',
      'setActivityAlert',
      'listSharedWithMe',
      'getSharedPortfolio',
      'getSharedConglomerate',
      'getSharedWatchlist',
      'getProfileSettings',
      'updateProfileSettings',
    ],
    'internallyFiltered',
    'Social reads resolve the affected principals and preserve no-leak behavior for unavailable content.',
    ['dynamicPrincipals'],
  ),
  serviceExemption(
    'mirror',
    [
      'attachMemberCopy',
      'inviteMember',
      'acceptInvite',
      'replicateChain',
      'notifyChainStalled',
      'handleAccountDeletion',
      'runConsistencySweep',
    ],
    'dynamicPrincipals',
    'Membership lifecycle work resolves every affected chain principal before applying its action.',
    ['dynamicPrincipals', 'queuedPrincipals'],
  ),
  serviceExemption(
    'assets',
    ['*'],
    'internallyFiltered',
    'Asset reads enforce global-or-owned asset provenance and hide foreign custom assets.',
    ['accountMode', 'ownedAssetProvenance'],
  ),
  serviceExemption(
    'search',
    ['search', 'catalogFreshness'],
    'internallyFiltered',
    'Search and freshness reads filter custom-asset provenance before returning a result.',
    ['accountMode', 'ownedAssetProvenance'],
  ),
  serviceExemption(
    'search',
    ['enrichmentSettled'],
    'kept',
    'The enrichment wait primitive carries no account or portfolio content.',
  ),
  serviceExemption(
    'marketIntel',
    ['capabilities', 'dividends', 'earnings', 'news', 'splits', 'earningsCalendar'],
    'internallyFiltered',
    'Market-intelligence reads scope each asset to global-or-owned provenance before querying providers.',
    ['accountMode', 'ownedAssetProvenance'],
  ),
  serviceExemption(
    'chat',
    ['openConversation', 'listConversations', 'markRead'],
    'kept',
    'Private chat metadata remains separate from portfolio data.',
  ),
  serviceExemption(
    'chat',
    ['getThread', 'sendMessage'],
    'internallyFiltered',
    'Thread access resolves both conversation principals before it reads or writes a message.',
    ['dynamicPrincipals', 'ownedAssetProvenance'],
  ),
  serviceExemption(
    'aiFeatures',
    ['conglomerateDraft'],
    'kept',
    'The NL builder produces a reviewed draft from catalog search rather than reading a server portfolio.',
  ),
  serviceExemption(
    'snapshots',
    ['recomputeAll'],
    'internallyFiltered',
    'The bulk snapshot repair skips paranoid accounts before it materializes a portfolio series.',
    ['accountMode'],
  ),
  serviceExemption(
    'imports',
    ['listBrokers'],
    'kept',
    'Available broker mapper metadata contains no user data.',
  ),
  serviceExemption(
    'expenseImports',
    ['listBanks'],
    'kept',
    'Available bank mapper metadata contains no user data.',
  ),
  serviceExemption(
    'alerts',
    ['remove'],
    'kept',
    'Deleting an existing alert does not read or create server-side portfolio content.',
  ),
  serviceExemption(
    'alerts',
    ['list', 'create', 'update', 'rearm'],
    'internallyFiltered',
    'Alert operations resolve asset provenance and affected followers before returning or mutating data.',
    ['accountMode', 'ownedAssetProvenance', 'dynamicPrincipals'],
  ),
  serviceExemption(
    'standingOrders',
    ['processDueOrders'],
    'internallyFiltered',
    'The scheduler skips accounts whose privacy mode forbids server-side portfolio execution.',
    ['accountMode'],
  ),
] as const;

/**
 * The remainder of the callable AppContext is deliberately enumerated too.
 * These are not §8 portfolio rails, but making every one explicit means a new
 * context service cannot silently bypass the completeness gate.
 */
export const PARANOID_CONTEXT_SERVICE_EXEMPTIONS: readonly ParanoidServiceExemption[] = [
  serviceExemption(
    'redis',
    ['*'],
    'kept',
    'Infrastructure Redis client; it has no account-facing policy of its own.',
  ),
  serviceExemption(
    'logger',
    ['*'],
    'kept',
    'Process logging infrastructure; it does not expose account content.',
  ),
  serviceExemption(
    'auth',
    ['*'],
    'kept',
    'Authentication, sessions, and recovery remain available to a paranoid account.',
  ),
  serviceExemption(
    'google',
    ['*'],
    'kept',
    'Identity-provider linking is account security metadata, not portfolio data.',
  ),
  serviceExemption(
    'twoFactor',
    ['*'],
    'kept',
    'Two-factor enrollment and verification remain available for account security.',
  ),
  serviceExemption(
    'passkeys',
    ['*'],
    'kept',
    'Passkey management is authentication material, not portfolio content.',
  ),
  serviceExemption(
    'adminTwoFactor',
    ['*'],
    'kept',
    'Administrator assurance is an admin-security rail, not a user portfolio rail.',
  ),
  serviceExemption(
    'admin',
    ['*'],
    'kept',
    'Administrator operations are independently authorized and do not run as a user portfolio surface.',
  ),
  serviceExemption(
    'apiKeys',
    ['*'],
    'kept',
    'API-key governance is credential management; portfolio scopes are classified separately.',
  ),
  serviceExemption(
    'oauth',
    ['*'],
    'kept',
    'OAuth client and grant lifecycle is credential management; portfolio scopes are classified separately.',
  ),
  serviceExemption(
    'marketData',
    ['*'],
    'kept',
    'Provider/cache primitives operate on public market references, not account portfolio rows.',
  ),
  serviceExemption(
    'paranoidVault',
    ['*'],
    'kept',
    'The opaque ciphertext vault is the deliberate paranoid-mode data home.',
  ),
  serviceExemption(
    'webhooks',
    ['*'],
    'kept',
    'Webhook subscription metadata is separate from the event bridge that suppresses portfolio events.',
  ),
  serviceExemption(
    'notifications',
    ['*'],
    'kept',
    'Notification inbox and device settings remain available while server alerts continue to operate.',
  ),
  serviceExemption(
    'notificationSettings',
    ['*'],
    'kept',
    'Notification preferences are account metadata, not portfolio content.',
  ),
  serviceExemption(
    'telegramSetup',
    ['*'],
    'kept',
    'Telegram channel setup is account notification configuration.',
  ),
  serviceExemption(
    'discordSetup',
    ['*'],
    'kept',
    'Discord channel setup is account notification configuration.',
  ),
  serviceExemption(
    'accountSettings',
    ['*'],
    'kept',
    'Account defaults are profile metadata rather than portfolio content.',
  ),
  serviceExemption(
    'accountDeletion',
    ['*'],
    'kept',
    'A user must always be able to delete their account.',
  ),
  serviceExemption(
    'dataExport',
    ['*'],
    'kept',
    'Export lifecycle metadata stays available; payload policy is handled by the paranoid vault/export flow.',
  ),
  serviceExemption(
    'announcements',
    ['*'],
    'kept',
    'Announcement delivery is global product communication, not portfolio data.',
  ),
  serviceExemption(
    'notificationDispatcher',
    ['*'],
    'kept',
    'Notification delivery infrastructure is independent of the portfolio rails it receives.',
  ),
  serviceExemption(
    'digestService',
    ['*'],
    'kept',
    'Digest scheduling is delivery infrastructure; portfolio-producing jobs are classified separately.',
  ),
  serviceExemption(
    'notify',
    ['*'],
    'kept',
    'The notification entry point is transport infrastructure, not a portfolio read surface.',
  ),
  serviceExemption(
    'presence',
    ['*'],
    'kept',
    'Presence is transient UI metadata and contains no portfolio data.',
  ),
  serviceExemption(
    'realtime',
    ['*'],
    'kept',
    'Gateway lifecycle methods are transport infrastructure; room authorization has its own tracked gap below.',
  ),
  serviceExemption(
    'liveMode',
    ['*'],
    'kept',
    'Live quote polling is market-data transport over allowed assets, not a portfolio read surface.',
  ),
  serviceExemption(
    'events',
    ['*'],
    'kept',
    'The typed event bus is process infrastructure; event payload policies are classified separately.',
  ),
  serviceExemption(
    'idempotency',
    ['*'],
    'kept',
    'Idempotency bookkeeping is transient request infrastructure.',
  ),
  serviceExemption(
    'queues',
    ['*'],
    'kept',
    'The BullMQ queue registry is producer infrastructure; each queued portfolio operation has its own policy.',
  ),
  serviceExemption(
    'observability',
    ['*'],
    'kept',
    'Observability is operator infrastructure and does not expose user portfolio content.',
  ),
  serviceExemption(
    'health',
    ['*'],
    'kept',
    'Health checks are operational diagnostics, not portfolio data.',
  ),
  serviceExemption(
    'readiness',
    ['*'],
    'kept',
    'Readiness checks are dependency diagnostics, not portfolio data.',
  ),
  serviceExemption(
    'problems',
    ['*'],
    'kept',
    'Problems-page capture is operational diagnostics, not a user portfolio rail.',
  ),
  serviceExemption('monitoring', ['*'], 'kept', 'Monitoring controls are operator infrastructure.'),
  serviceExemption(
    'usageAnalytics',
    ['*'],
    'kept',
    'Usage analytics is first-party aggregate telemetry, not portfolio content.',
  ),
  serviceExemption(
    'featureFlags',
    ['*'],
    'kept',
    'Feature-flag evaluation is runtime configuration infrastructure.',
  ),
  serviceExemption(
    'ai',
    ['*'],
    'kept',
    'AI provider controls are capability/configuration plumbing; user portfolio insight calls are classified on aiFeatures.',
  ),
] as const;

const ALERTS_CUSTOM_ASSET_GAP_ID = 'alerts-evaluate-custom-asset-enumeration';

const jobPolicy = (
  file: string,
  symbol: string,
  name: string,
  policy: ParanoidJobPolicy,
): ParanoidJobPolicyEntry => ({
  surface: {
    kind: 'job',
    source: {
      file: `apps/api/src/jobs/definitions/${file}`,
      symbol,
    },
    name,
  },
  policy,
});

/**
 * Every production registration must declare its paranoid-mode handling by
 * concrete definition source as well as queue name. A replacement handler on
 * an existing queue is therefore a new, unclassified candidate.
 */
export const PARANOID_JOB_POLICIES: readonly ParanoidJobPolicyEntry[] = [
  jobPolicy('heartbeat.ts', 'heartbeatJob', 'system.heartbeat', {
    capability: null,
    mode: 'kept',
    reason: 'The heartbeat is deployment-health infrastructure.',
  }),
  jobPolicy('marketDataJobs.ts', 'createPricesRefreshDailyJob', 'prices.refreshDaily', {
    capability: null,
    mode: 'kept',
    reason: 'Global market-price refresh has no account-owned input.',
  }),
  jobPolicy('marketDataJobs.ts', 'createPricesBackfillJob', 'prices.backfill', {
    capability: null,
    mode: 'kept',
    reason: 'Global market-history backfill has no account-owned input.',
  }),
  jobPolicy('marketDataJobs.ts', 'createFxRefreshSpotJob', 'fx.refreshSpot', {
    capability: null,
    mode: 'kept',
    reason: 'Global FX refresh has no account-owned input.',
  }),
  // Known gap #884: custom-asset alerts are still enumerated by the evaluator.
  // Keep this explicit temporary exemption visible until #884 adds the guard.
  jobPolicy('alertsJob.ts', 'createAlertsEvaluateJob', 'alerts.evaluate', {
    capability: null,
    mode: 'internallyFiltered',
    reason:
      'Known gap #884: alerts.evaluate must exclude custom-asset alerts owned by paranoid accounts.',
    knownGapId: ALERTS_CUSTOM_ASSET_GAP_ID,
  }),
  jobPolicy('notificationsJob.ts', 'createNotificationsDispatchJob', 'notifications.dispatch', {
    capability: null,
    mode: 'kept',
    reason:
      'Notification delivery is transport infrastructure; event ownership is handled at its producer.',
  }),
  jobPolicy('digestJobs.ts', 'createDigestDailyJob', 'notifications.digestDaily', {
    capability: null,
    mode: 'kept',
    reason:
      'Digest delivery is notification transport; portfolio-producing jobs are classified separately.',
  }),
  jobPolicy('digestJobs.ts', 'createDigestWeeklyJob', 'notifications.digestWeekly', {
    capability: null,
    mode: 'kept',
    reason:
      'Digest delivery is notification transport; portfolio-producing jobs are classified separately.',
  }),
  jobPolicy('digestJobs.ts', 'createDeferredDeliveryJob', 'notifications.deferredDelivery', {
    capability: null,
    mode: 'kept',
    reason: 'Deferred delivery only releases already-classified notifications.',
  }),
  jobPolicy('exportJobs.ts', 'createExportBuildJob', 'data.export', {
    capability: null,
    mode: 'kept',
    reason: 'Export job metadata is handled by the vault/export protocol.',
  }),
  jobPolicy('exportJobs.ts', 'createExportCleanupJob', 'data.exportCleanup', {
    capability: null,
    mode: 'kept',
    reason: 'Expired export cleanup is retention infrastructure.',
  }),
  jobPolicy('snapshotJobs.ts', 'createSnapshotsRecomputeJob', 'snapshots.recompute', {
    capability: 'portfolioJobs',
    mode: 'portfolio',
  }),
  jobPolicy('snapshotJobs.ts', 'createSnapshotsBackfillJob', 'snapshots.backfill', {
    capability: 'portfolioJobs',
    mode: 'serviceFiltered',
  }),
  jobPolicy('usageAnalyticsJobs.ts', 'createUsageRollupJob', 'usage.rollup', {
    capability: null,
    mode: 'kept',
    reason: 'Usage rollups are aggregate telemetry, not portfolio content.',
  }),
  jobPolicy('earningsReminderJob.ts', 'createEarningsReminderJob', 'notifications.earningsRemind', {
    capability: 'portfolioJobs',
    mode: 'perUser',
  }),
  jobPolicy('dividendEventsJob.ts', 'createDividendEventsScanJob', 'marketIntel.dividendScan', {
    capability: 'portfolioJobs',
    mode: 'perUser',
  }),
  jobPolicy('standingOrdersJob.ts', 'createStandingOrdersJob', 'standingOrders.process', {
    capability: 'standingOrderExecution',
    mode: 'perUser',
  }),
  jobPolicy('mirrorJobs.ts', 'createMirrorReplicateJob', 'mirror.replicate', {
    capability: 'mirrorchain',
    mode: 'serviceFiltered',
  }),
  jobPolicy('mirrorJobs.ts', 'createMirrorInviteCleanupJob', 'mirror.inviteCleanup', {
    capability: null,
    mode: 'kept',
    reason: 'Expired invite cleanup only removes stale security tokens.',
  }),
  jobPolicy('mirrorJobs.ts', 'createMirrorConsistencySweepJob', 'mirror.consistencySweep', {
    capability: 'mirrorchain',
    mode: 'serviceFiltered',
  }),
  jobPolicy('webhookJobs.ts', 'createWebhookDeliverJob', 'webhooks.deliver', {
    capability: 'portfolioWebhooks',
    mode: 'event',
  }),
  jobPolicy('webhookJobs.ts', 'createWebhookDeliveryCleanupJob', 'webhooks.deliveryCleanup', {
    capability: null,
    mode: 'kept',
    reason: 'Webhook delivery-log cleanup is retention infrastructure.',
  }),
  jobPolicy('apiKeyJobs.ts', 'createApiKeyRequestLogCleanupJob', 'apiKeys.requestLogCleanup', {
    capability: null,
    mode: 'kept',
    reason: 'API-key audit-log cleanup is retention infrastructure.',
  }),
] as const;

const servicesFor = (capability: ParanoidKilledCapability): readonly ParanoidServiceBinding[] =>
  PARANOID_SERVICE_BINDINGS.filter((binding) => binding.capability === capability);

const jobsFor = (capability: ParanoidKilledCapability): readonly string[] =>
  PARANOID_JOB_POLICIES.filter((entry) => entry.policy.capability === capability).map(
    (entry) => entry.surface.name,
  );

/**
 * The typed §8 kill registry. It is intentionally declarative in this issue;
 * #884 will consume it to mount the actual route/service/job enforcement.
 */
export const PARANOID_KILL_REGISTRY: readonly ParanoidKillRegistryEntry[] = [
  {
    capability: 'publicProfile',
    routes: [{ prefix: '/social/profiles/' }],
    services: servicesFor('publicProfile'),
    scopes: [],
    jobs: jobsFor('publicProfile'),
    webhookEventTypes: [],
  },
  {
    capability: 'sharing',
    routes: [
      { prefix: '/social/links/' },
      { exact: '/social/groups' },
      { prefix: '/social/groups/' },
      { exact: '/social/follows' },
      { prefix: '/social/follows/' },
      { exact: '/social/followers' },
      { exact: '/social/item-follows' },
      { prefix: '/social/item-follows/' },
      { exact: '/social/shared' },
      { prefix: '/social/shared/' },
      { exact: '/social/my-shared' },
      { prefix: '/social/audience/' },
      { prefix: '/social/items/' },
      { prefix: '/social/comments/' },
      { exact: '/alerts/sharing' },
      { exact: '/workboard/sharing' },
      { pattern: /^\/ideas\/[^/]+\/clone$/ },
      { prefix: '/backtest/shared/' },
    ],
    services: servicesFor('sharing'),
    scopes: [],
    jobs: jobsFor('sharing'),
    webhookEventTypes: [],
  },
  {
    capability: 'mirrorchain',
    routes: [{ prefix: '/mirrorchain/' }],
    services: servicesFor('mirrorchain'),
    scopes: [],
    jobs: jobsFor('mirrorchain'),
    webhookEventTypes: [],
  },
  {
    capability: 'portfolioServer',
    routes: [
      { exact: '/portfolios' },
      { prefix: '/portfolios/' },
      { exact: '/custom-assets' },
      { prefix: '/custom-assets/' },
      { prefix: '/analytics/' },
      { prefix: '/expenses/categories' },
      { prefix: '/expenses/transactions' },
      { prefix: '/expenses/rules' },
      { prefix: '/expenses/summary' },
      { prefix: '/expenses/trends' },
      { prefix: '/expenses/budgets' },
      { exact: '/assets/portfolio/dividend-calendar' },
      { exact: '/assets/portfolio/dividend-projection' },
      { exact: '/assets/portfolio/news-digest' },
      { method: 'POST', exact: '/ai/insights' },
      { exact: '/settings/taxes' },
    ],
    services: servicesFor('portfolioServer'),
    scopes: [],
    jobs: jobsFor('portfolioServer'),
    webhookEventTypes: [],
  },
  {
    capability: 'imports',
    routes: [{ exact: '/imports' }, { prefix: '/imports/' }, { prefix: '/expenses/import/' }],
    services: servicesFor('imports'),
    scopes: [],
    jobs: jobsFor('imports'),
    webhookEventTypes: [],
  },
  {
    capability: 'portfolioApiScope',
    routes: [],
    services: servicesFor('portfolioApiScope'),
    scopes: [
      'portfolio:read',
      'portfolio:write',
      'tax:read',
      'tax:write',
      'import:read',
      'import:write',
    ],
    jobs: jobsFor('portfolioApiScope'),
    webhookEventTypes: [],
  },
  {
    capability: 'standingOrderExecution',
    routes: [{ exact: '/standing-orders' }, { prefix: '/standing-orders/' }],
    services: servicesFor('standingOrderExecution'),
    scopes: [],
    jobs: jobsFor('standingOrderExecution'),
    webhookEventTypes: [],
  },
  {
    capability: 'portfolioJobs',
    routes: [],
    services: servicesFor('portfolioJobs'),
    scopes: [],
    jobs: jobsFor('portfolioJobs'),
    webhookEventTypes: [],
  },
  {
    capability: 'portfolioWebhooks',
    routes: [],
    services: servicesFor('portfolioWebhooks'),
    scopes: [],
    jobs: jobsFor('portfolioWebhooks'),
    webhookEventTypes: [
      'portfolio.changed',
      'portfolio.shared',
      'watchlist.shared',
      'conglomerate.shared',
      'friend.activity',
      'follow.published',
      'follow.alert.created',
      'follow.alert.fired',
      'dividend.event',
      'budget.exceeded',
      'mirror.invite',
      'mirror.member_joined',
      'mirror.member_left',
      'mirror.member_removed',
      'mirror.removed',
      'mirror.ownership_transferred',
      'mirror.chain_dissolved',
      'mirror.sync_stalled',
    ],
  },
] as const;

const keptRoutes = (
  reason: string,
  rules: readonly ParanoidRouteRule[],
): readonly ParanoidExemptRouteRule[] => rules.map((rule) => ({ ...rule, reason }));

const productionOpaqueRoute = ({
  mountedPath,
  normalizedPath,
  handler,
  occurrence = 1,
}: {
  readonly mountedPath: string;
  readonly normalizedPath: string;
  readonly handler: string;
  readonly occurrence?: number;
}): ParanoidRouteRule => ({
  method: PARANOID_OPAQUE_MOUNT_METHOD,
  exact: normalizedPath,
  source: {
    ...PARANOID_ROUTE_TABLE_SOURCE,
    symbol: `${PARANOID_ROUTE_TABLE_SOURCE.symbol}.${handler}[${occurrence}]@${mountedPath}`,
  },
});

/**
 * Explicit kept route classification. Mixed routers enumerate their allowed
 * families so a newly mounted endpoint cannot fall through to an implicit allow.
 */
export const PARANOID_KEPT_ROUTE_RULES: readonly ParanoidExemptRouteRule[] = [
  ...keptRoutes(
    'These origin-root opaque mounts are the known instrumentation, browser-security, parsing, and terminal error middleware; concrete operations are classified separately.',
    [
      productionOpaqueRoute({
        mountedPath: '/',
        normalizedPath: '/',
        handler: '<anonymous>',
      }),
      productionOpaqueRoute({
        mountedPath: '/',
        normalizedPath: '/',
        handler: 'helmetMiddleware',
      }),
      productionOpaqueRoute({
        mountedPath: '/',
        normalizedPath: '/',
        handler: '<anonymous>',
        occurrence: 2,
      }),
      productionOpaqueRoute({
        mountedPath: '/',
        normalizedPath: '/',
        handler: 'jsonParser',
      }),
      productionOpaqueRoute({
        mountedPath: '/',
        normalizedPath: '/',
        handler: 'cookieParser',
      }),
      productionOpaqueRoute({
        mountedPath: '/',
        normalizedPath: '/',
        handler: '<anonymous>',
        occurrence: 3,
      }),
    ],
  ),
  ...keptRoutes(
    'These API-root opaque mounts are the known authentication, audit, rate-limit, and request-policy middleware; concrete operations are classified separately.',
    [
      ...Array.from({ length: 8 }, (_, index) =>
        productionOpaqueRoute({
          mountedPath: '/api/v1',
          normalizedPath: '/',
          handler: '<anonymous>',
          occurrence: index + 1,
        }),
      ),
      productionOpaqueRoute({
        mountedPath: '/api/v1',
        normalizedPath: '/',
        handler: 'enforcePasswordChange',
      }),
    ],
  ),
  ...keptRoutes(
    'These exact opaque mounts are the production session-admission middleware; concrete operations are classified separately.',
    [
      productionOpaqueRoute({
        mountedPath: '/api/v1/assets',
        normalizedPath: '/assets',
        handler: 'requireUser',
      }),
      productionOpaqueRoute({
        mountedPath: '/api/v1/assets',
        normalizedPath: '/assets',
        handler: 'requireUser',
        occurrence: 2,
      }),
      ...[
        '/backtest',
        '/expenses',
        '/analytics',
        '/social',
        '/mirrorchain',
        '/chat',
        '/ai',
        '/settings',
        '/oauth',
      ].map((normalizedPath) =>
        productionOpaqueRoute({
          mountedPath: `/api/v1${normalizedPath}`,
          normalizedPath,
          handler: 'requireUser',
        }),
      ),
    ],
  ),
  ...keptRoutes(
    'This exact opaque mount is the production chat feature gate; concrete chat operations are classified separately.',
    [
      productionOpaqueRoute({
        mountedPath: '/api/v1/chat',
        normalizedPath: '/chat',
        handler: '<anonymous>',
      }),
    ],
  ),
  ...keptRoutes('Public self-documenting API documentation contains no account data.', [
    { method: 'GET', exact: '/docs' },
    { method: 'GET', exact: '/openapi.json' },
  ]),
  ...keptRoutes('Public deployment metadata contains no account data.', [
    { exact: '/version' },
    { exact: '/health' },
    { exact: '/health/ready' },
    { exact: '/feature-flags' },
  ]),
  ...keptRoutes('Catalog search is provenance-filtered and has no server portfolio read.', [
    { exact: '/search' },
  ]),
  ...keptRoutes('Authentication and recovery remain available to a paranoid account.', [
    { prefix: '/auth/' },
  ]),
  ...keptRoutes('Account lifecycle and export metadata remain available.', [
    { exact: '/account' },
    { prefix: '/account/' },
  ]),
  ...keptRoutes('Administrator routes are independently authorized operational surfaces.', [
    { exact: '/admin' },
    { prefix: '/admin/' },
  ]),
  ...keptRoutes('OAuth credential lifecycle is separate from portfolio scopes.', [
    { prefix: '/oauth/' },
  ]),
  ...keptRoutes(
    'Conglomerate definitions are local configuration; sharing is classified separately.',
    [{ exact: '/conglomerates' }, { prefix: '/conglomerates/' }],
  ),
  ...keptRoutes('Private chat remains separate from server-side portfolio content.', [
    { exact: '/chat/conversations' },
    { prefix: '/chat/conversations/' },
  ]),
  ...keptRoutes('Notification inbox and device preferences remain available.', [
    { exact: '/notifications' },
    { prefix: '/notifications/' },
  ]),
  ...keptRoutes('Alert CRUD is provenance-filtered; sharing settings are classified separately.', [
    { exact: '/alerts' },
    { pattern: /^\/alerts\/(?!sharing$)[^/]+(?:\/rearm)?$/ },
  ]),
  ...keptRoutes('The opaque ciphertext vault is the paranoid-mode data home.', [
    { exact: '/vault' },
    { prefix: '/vault/' },
  ]),
  ...keptRoutes(
    'Local workboard organization remains available; sharing settings are classified separately.',
    [
      { exact: '/workboard' },
      { prefix: '/workboard/watchlists/' },
      { pattern: /^\/workboard\/(?!sharing$)[^/]+$/ },
    ],
  ),
  ...keptRoutes('Per-asset market reads enforce global-or-owned asset provenance.', [
    {
      pattern:
        /^\/assets\/[^/]+(?:\/(?:quote|history|daily-closes|intel(?:\/(?:dividends|earnings|news|splits))?))?$/,
    },
    { exact: '/assets/intel/earnings-calendar' },
  ]),
  ...keptRoutes(
    'Local draft backtests do not read a server portfolio; shared previews are classified separately.',
    [{ exact: '/backtest/preview' }, { exact: '/backtest/compare' }],
  ),
  ...keptRoutes(
    'Ideas remain private local notes; cloning a shared idea is classified separately.',
    [{ exact: '/ideas' }, { pattern: /^\/ideas\/[^/]+$/ }],
  ),
  ...keptRoutes(
    'Friendship and profile-settings operations preserve their no-leak authorization semantics.',
    [
      { exact: '/social/requests' },
      { prefix: '/social/requests/' },
      { exact: '/social/friends' },
      { prefix: '/social/friends/' },
      { exact: '/social/profile' },
    ],
  ),
  ...keptRoutes('AI capability and reviewed draft endpoints do not read a server portfolio.', [
    { exact: '/ai/capability' },
    { method: 'POST', exact: '/ai/conglomerate-draft' },
  ]),
  ...keptRoutes(
    'Notification, account, API-key, OAuth, and webhook settings are account configuration.',
    [
      { exact: '/settings/webhooks' },
      { prefix: '/settings/webhooks/' },
      { exact: '/settings/notifications' },
      { exact: '/settings/telegram' },
      { prefix: '/settings/telegram/' },
      { exact: '/settings/discord' },
      { prefix: '/settings/discord/' },
      { exact: '/settings/account' },
      { exact: '/settings/api-keys' },
      { prefix: '/settings/api-keys/' },
      { exact: '/settings/oauth-clients' },
      { prefix: '/settings/oauth-clients/' },
      { exact: '/settings/oauth-grants' },
      { prefix: '/settings/oauth-grants/' },
    ],
  ),
];

const knownGap = (
  id: string,
  label: string,
  surface: ParanoidSurface,
  reason: string,
): ParanoidKnownGap => ({
  id,
  issue: 884,
  label,
  surface,
  classification: { disposition: 'exempt', reason, knownGapIssue: 884, knownGapId: id },
});

export interface ParanoidKnownGap {
  readonly id: string;
  readonly issue: 884;
  readonly label: string;
  readonly surface: ParanoidSurface;
  readonly classification: ParanoidExemptClassification;
}

/**
 * Explicit review findings that #884 must close. They remain classified so the
 * inventory is complete, but cannot be mistaken for intentional permanent
 * exemptions: each one names #884 and carries an individual reason.
 */
export const PARANOID_KNOWN_GAPS: readonly ParanoidKnownGap[] = [
  // Known gap #884: the held-or-watched aggregation currently reaches watch-only
  // assets without the paranoid account filter required by the enforcement plan.
  knownGap(
    'market-intel-watch-only-queries',
    'marketIntelRepository watch-only queries',
    {
      kind: 'internal',
      source: {
        file: 'apps/api/src/data/repositories/marketIntelRepository.ts',
        symbol: 'MarketIntelRepository.listUserWatchAndHoldAssets',
      },
    },
    'Known gap #884: watch-only market-intelligence queries need paranoid-account filtering.',
  ),
  // Known gap #884: the registered evaluator still enumerates custom-asset alerts.
  knownGap(
    ALERTS_CUSTOM_ASSET_GAP_ID,
    'alerts.evaluate custom-asset enumeration',
    {
      kind: 'job',
      source: {
        file: 'apps/api/src/jobs/definitions/alertsJob.ts',
        symbol: 'createAlertsEvaluateJob',
      },
      name: 'alerts.evaluate',
    },
    'Known gap #884: alerts.evaluate must exclude custom-asset alerts owned by paranoid accounts.',
  ),
  // Known gap #884: member-copy attachment derives Main from a former owner
  // without holding the owner-mode decision through the complete operation.
  knownGap(
    'mirror-member-copy-owner-anchor',
    'attachMemberCopyUnderLock owner anchor',
    {
      kind: 'internal',
      source: {
        file: 'apps/api/src/services/mirror/mirrorService.ts',
        symbol: 'attachMemberCopyUnderLock',
      },
    },
    'Known gap #884: attachMemberCopyUnderLock must hold the former-owner paranoid decision through its Main anchor.',
  ),
  // Known gap #884: portfolio-room authorization currently releases its owner
  // guard before `socket.join`, leaving a transition window in the gateway.
  knownGap(
    'portfolio-room-authorization-window',
    'portfolio-room authorization window',
    {
      kind: 'internal',
      source: {
        file: 'apps/api/src/realtime/gateway.ts',
        symbol: 'handleRoomJoin',
      },
    },
    'Known gap #884: portfolio-room authorization must keep its owner guard through socket.join.',
  ),
] as const;

/** True only when a mounted route surface meets one complete declarative rule. */
export function routeMatches(rule: ParanoidRouteRule, surface: ParanoidRouteSurface): boolean {
  if (rule.method && rule.method !== surface.method) return false;
  if (rule.exact !== undefined && rule.exact !== surface.path) return false;
  if (rule.prefix !== undefined && !surface.path.startsWith(rule.prefix)) return false;
  if (rule.pattern !== undefined && !rule.pattern.test(surface.path)) return false;
  if (
    rule.source &&
    (rule.source.file !== surface.source.file || rule.source.symbol !== surface.source.symbol)
  ) {
    return false;
  }
  return (
    rule.exact !== undefined ||
    rule.prefix !== undefined ||
    rule.pattern !== undefined ||
    rule.source !== undefined
  );
}

/** Match an exact method, all methods, or a suffix `*` method family. */
export function serviceMethodMatches(pattern: string, method: string): boolean {
  return (
    pattern === '*' ||
    (pattern.endsWith('*') && method.startsWith(pattern.slice(0, -1))) ||
    pattern === method
  );
}

function guarded(capability: ParanoidKilledCapability): ParanoidGuardedClassification {
  return { disposition: 'guarded', capability };
}

function exempt(
  reason: string,
  knownGapIssue?: 884,
  knownGapId?: string,
): ParanoidExemptClassification {
  return {
    disposition: 'exempt',
    reason,
    ...(knownGapIssue ? { knownGapIssue } : {}),
    ...(knownGapId ? { knownGapId } : {}),
  };
}

/** All route classifications so the harness can detect missing or overlapping rules. */
export function paranoidRouteClassifications(
  surface: ParanoidRouteSurface,
): readonly ParanoidSurfaceClassification[] {
  const classifications: ParanoidSurfaceClassification[] = [];
  for (const entry of PARANOID_KILL_REGISTRY) {
    if (entry.routes.some((rule) => routeMatches(rule, surface))) {
      classifications.push(guarded(entry.capability));
    }
  }
  for (const rule of PARANOID_KEPT_ROUTE_RULES) {
    if (routeMatches(rule, surface)) classifications.push(exempt(rule.reason));
  }
  return classifications;
}

/** All service classifications so the harness can detect missing or overlapping methods. */
export function paranoidServiceClassifications(
  service: string,
  method: string,
): readonly ParanoidSurfaceClassification[] {
  const classifications: ParanoidSurfaceClassification[] = [];
  for (const binding of PARANOID_SERVICE_BINDINGS) {
    if (
      binding.service === service &&
      binding.methods.some((pattern) => serviceMethodMatches(pattern, method))
    ) {
      classifications.push(guarded(binding.capability));
    }
  }
  for (const exemptionRule of [
    ...PARANOID_SERVICE_EXEMPTIONS,
    ...PARANOID_CONTEXT_SERVICE_EXEMPTIONS,
  ]) {
    if (
      exemptionRule.service === service &&
      exemptionRule.methods.some((pattern) => serviceMethodMatches(pattern, method))
    ) {
      classifications.push(exempt(exemptionRule.reason));
    }
  }
  return classifications;
}

/** All job classifications, matched by queue and concrete production source. */
export function paranoidJobClassifications(
  surface: ParanoidJobSurface,
): readonly ParanoidSurfaceClassification[] {
  return PARANOID_JOB_POLICIES.filter(
    (entry) =>
      entry.surface.name === surface.name &&
      entry.surface.source.file === surface.source.file &&
      entry.surface.source.symbol === surface.source.symbol,
  ).map(({ policy }) => {
    if (policy.capability) return guarded(policy.capability);
    const knownGap = PARANOID_KNOWN_GAPS.find((gap) => gap.id === policy.knownGapId);
    return exempt(policy.reason, knownGap?.issue, policy.knownGapId);
  });
}

/**
 * Typed completeness accessor. It never applies a guard: callers can ask the
 * registry whether a discovered route, context method, job, or named internal
 * review finding has exactly one policy without recreating the kill set.
 */
export function paranoidSurfaceClassifications(
  surface: ParanoidSurface,
): readonly ParanoidSurfaceClassification[] {
  if (surface.kind === 'route') return paranoidRouteClassifications(surface);
  if (surface.kind === 'service') {
    return paranoidServiceClassifications(surface.service, surface.method);
  }
  if (surface.kind === 'job') return paranoidJobClassifications(surface);
  return PARANOID_KNOWN_GAPS.filter(
    (gap) =>
      gap.surface.kind === 'internal' &&
      gap.surface.source.file === surface.source.file &&
      gap.surface.source.symbol === surface.source.symbol,
  ).map((gap) => gap.classification);
}

/** Returns the one policy, or `undefined` when a surface is missing or overlaps. */
export function paranoidSurfaceClassification(
  surface: ParanoidSurface,
): ParanoidSurfaceClassification | undefined {
  const classifications = paranoidSurfaceClassifications(surface);
  return classifications.length === 1 ? classifications[0] : undefined;
}

/** Convenience predicate for future composition and the completeness harness. */
export function isParanoidSurfaceClassified(surface: ParanoidSurface): boolean {
  return paranoidSurfaceClassification(surface) !== undefined;
}
