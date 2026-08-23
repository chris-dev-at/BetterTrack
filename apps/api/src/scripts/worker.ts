/**
 * BullMQ worker process (PROJECTPLAN.md §9).
 *
 * A separate process from the API, sharing its env/Redis config. Run it with:
 *   - dev:  `pnpm --filter @bettertrack/api worker`
 *   - prod: `pnpm --filter @bettertrack/api start:worker` (after `pnpm build`)
 *
 * It boots the typed event bus, the dead-letter list and the queue registry,
 * starts a worker per job definition, registers the repeatable schedules from
 * code, and shuts everything down cleanly on SIGINT/SIGTERM.
 */
import { loadConfig } from '../config/env';
import { createDatabase } from '../data/db';
import { createAlertRepository } from '../data/repositories/alertRepository';
import { createAuditRepository } from '../data/repositories/auditRepository';
import { createDeviceTokenRepository } from '../data/repositories/deviceTokenRepository';
import { createEmailLogRepository } from '../data/repositories/emailLogRepository';
import { createMarketIntelRepository } from '../data/repositories/marketIntelRepository';
import { createNotificationRepository } from '../data/repositories/notificationRepository';
import { createNotificationDigestRepository } from '../data/repositories/notificationDigestRepository';
import { createPushSubscriptionRepository } from '../data/repositories/pushSubscriptionRepository';
import { createParanoidVaultRepository } from '../data/repositories/paranoidVaultRepository';
import {
  createParanoidEnforcementRepository,
  withExclusiveLockedPrivacyMode,
  withFreshLockedPrivacyModes,
  withLockedPrivacyModes,
} from '../data/repositories/paranoidEnforcementRepository';
import { createUserRepository } from '../data/repositories/userRepository';
import { createEventBus } from '../events';
import {
  ALL_QUEUE_NAMES,
  assembleRegisteredJobDefinitions,
  assertParanoidJobBindings,
  bindParanoidJob,
  createBackfillScheduler,
  createDeadLetter,
  createExportBuildJob,
  createExportCleanupJob,
  createJobWorkers,
  createAlertsEvaluateJob,
  createFxRefreshSpotJob,
  createParanoidUserJobFilter,
  createMirrorReplicateJob,
  createMirrorInviteCleanupJob,
  createMirrorConsistencySweepJob,
  createPricesBackfillJob,
  createPricesRefreshDailyJob,
  createWebhookDeliverJob,
  createWebhookDeliveryCleanupJob,
  createApiKeyRequestLogCleanupJob,
  createDataRetentionCleanupJob,
  createNotificationsDispatchJob,
  createPortfolioVaultFinalizeJob,
  createDigestDailyJob,
  createDigestWeeklyJob,
  createDeferredDeliveryJob,
  createQueueRegistry,
  createSnapshotsBackfillJob,
  createSnapshotsRecomputeJob,
  createUsageRollupJob,
  createEarningsReminderJob,
  createDividendEventsScanJob,
  createStandingOrdersJob,
  dividendNotifyGate,
  heartbeatJob,
  jobConnectionFactory,
  registerSchedules,
  type JobContext,
} from '../jobs';
import { createCashMovementRepository } from '../data/repositories/cashMovementRepository';
import { createCashSourceRepository } from '../data/repositories/cashSourceRepository';
import { createAssetRepository } from '../data/repositories/assetRepository';
import { createFriendGroupRepository } from '../data/repositories/friendGroupRepository';
import { createFriendshipRepository } from '../data/repositories/friendshipRepository';
import { createItemFollowsRepository } from '../data/repositories/itemFollowsRepository';
import { createMirrorchainRepository } from '../data/repositories/mirrorchainRepository';
import { createPortfolioRepository } from '../data/repositories/portfolioRepository';
import { createPortfolioSettingsRepository } from '../data/repositories/portfolioSettingsRepository';
import { createPortfolioSnapshotRepository } from '../data/repositories/portfolioSnapshotRepository';
import { createProfileRepository } from '../data/repositories/profileRepository';
import { createShareAudienceRepository } from '../data/repositories/shareAudienceRepository';
import { createStandingOrderRepository } from '../data/repositories/standingOrderRepository';
import { createStandingOrderService } from '../services/standingOrders/standingOrderService';
import { createApiKeyRequestLogRepository } from '../data/repositories/apiKeyRequestLogRepository';
import { createTaxRepository } from '../data/repositories/taxRepository';
import { createTransactionRepository } from '../data/repositories/transactionRepository';
import { createUserFollowsRepository } from '../data/repositories/userFollowsRepository';
import {
  createWebhookSubscriptionRepository,
  createWebhookDeliveryRepository,
} from '../data/repositories/webhookRepository';
import {
  createWebhookBridge,
  createWebhookDispatcher,
  createFetchWebhookTransport,
} from '../services/webhooks';
import { createCurrencyService } from '../services/currency/currencyService';
import { createMarketDataFxSource } from '../services/currency/marketDataFxSource';
import { createReferenceBackfill } from '../services/assets/referenceBackfill';
import { createAudienceService } from '../services/social/audienceService';
import { createMirrorService } from '../services/mirror';
import { createPortfolioService } from '../services/portfolio/portfolioService';
import { createPortfolioSnapshotService } from '../services/portfolio/portfolioSnapshots';
import { createTaxService } from '../services/tax/taxService';
import { createUsageAnalyticsRepository } from '../data/repositories/usageAnalyticsRepository';
import { createUsageAnalyticsService } from '../services/analytics/usageAnalyticsService';
import { createLogger } from '../logger';
import { createMetricsServer } from '../metrics';
import { createMarketData, purgeManualAssetCaches } from '../providers';
import { initObservability } from '../services/observability/sentry';
import { createProblemService } from '../services/observability/problemService';
import { createProblemRepository } from '../data/repositories/problemRepository';
import { createAuditService } from '../services/audit/auditService';
import { createEmailService } from '../services/email/emailService';
import { createSmtpTransport } from '../services/email/transport';
import { createExportRepository } from '../data/repositories/exportRepository';
import { createTwoFactorRepository } from '../data/repositories/twoFactorRepository';
import { createExportService } from '../services/export';
import { createPasswordHasher } from '../services/password/passwordHasher';
import { createTwoFactorService } from '../services/auth/twoFactorService';
import { createFcmChannel } from '../services/notifications/fcm';
import { createNotificationCenter } from '../services/notifications/notificationCenter';
import { createNotificationDispatcher } from '../services/notifications/notificationDispatcher';
import { createDigestService } from '../services/notifications/digestService';
import { createPresenceStore } from '../services/notifications/presence';
import { createWebPushChannel } from '../services/notifications/webPush';
import { createCashTagRepository } from '../data/repositories/cashTagRepository';
import { createCashBudgetRepository } from '../data/repositories/cashBudgetRepository';
import { createCashSummaryRepository } from '../data/repositories/cashSummaryRepository';
import {
  createParanoidModeGuard,
  isParanoidOwnedSubjectBlocked,
  ParanoidModeError,
  runIfParanoidOwnedSubjectAllowed,
} from '../services/account/paranoidEnforcement';
import { isVaultedPortfolioContentEventAllowed } from '../services/account/vaultedPortfolioEnforcement';
import { createPortfolioVaultMoveOutFinalizer } from '../services/account/portfolioVaultTransitionService';
import { createCashBudgetService } from '../services/cash/cashBudgetService';
import { purgeBacktestCaches } from '../services/backtest/backtestService';
import { releaseRetiredLiveAssets } from '../services/liveMode';

const config = loadConfig();
const logger = createLogger(config);
// Error tracking (§13.4 V4-P5a): init in the worker too, so BullMQ job failures
// AND any uncaught worker error are captured. A no-op when BT_SENTRY_DSN is unset.
const observability = initObservability(config, logger, { serverName: 'worker' });
const createConnection = jobConnectionFactory(config.redisUrl);

// Dedicated connections per role: pub/sub subscriber must be its own; the
// dead-letter list, queue registry and market-data cache get ordinary
// (non-blocking) connections.
const events = createEventBus({
  publisher: createConnection(),
  subscriber: createConnection(),
  logger,
});
const deadLetterConnection = createConnection();
const deadLetter = createDeadLetter(deadLetterConnection);
const registry = createQueueRegistry(createConnection());

// The market-data jobs read/write Postgres and reach providers through the same
// caching/resilience service the API uses.
const { db, client } = createDatabase(config.databaseUrl);
// Dedicated privacy-lock pool, same rule as in `server.ts`: every privacy-mode
// lock reserves a connection here rather than on the job pool above, so a lock
// held across a read never waits on a connection its own callback needs. Its size
// (`createDatabase`, `max: 10`) is the concurrency budget for privacy-guarded
// work; on this side the holders are the export build and the expiry sweep, both
// bounded per job rather than by a client socket.
const { db: lockDb, client: lockClient } = createDatabase(config.databaseUrl);
const workerUserRepo = createUserRepository(db);
const paranoidSubjects = createParanoidEnforcementRepository(db);
const paranoidGuard = createParanoidModeGuard({
  privacyModeFor: async (userId) => (await workerUserRepo.findById(userId))?.privacyMode ?? null,
  withLockedPrivacyModes: (userIds, run) => withLockedPrivacyModes(lockDb, userIds, run),
});
const isBlockedPortfolio = async (portfolioId: string) =>
  isParanoidOwnedSubjectBlocked(await paranoidSubjects.portfolioOwner(portfolioId), paranoidGuard);
const runPortfolioJobIfAllowed = async (portfolioId: string, action: () => Promise<void>) =>
  runIfParanoidOwnedSubjectAllowed(
    () => paranoidSubjects.portfolioOwner(portfolioId),
    paranoidGuard,
    'portfolioJobs',
    action,
  );
const earningsParanoidFilter = createParanoidUserJobFilter(
  'notifications.earningsRemind',
  paranoidGuard,
);
const dividendParanoidFilter = createParanoidUserJobFilter(
  'marketIntel.dividendScan',
  paranoidGuard,
);
const standingOrderParanoidFilter = createParanoidUserJobFilter(
  'standingOrders.process',
  paranoidGuard,
);
// DB-backed problem capture (§13.5 V5-P2 arc (d), the Sentry replacement): the
// worker captures its own permanently-failed jobs and provider failures into
// the shared `problems` table. No audit sink here — resolve/reopen is admin-only.
const problems = createProblemService({ repo: createProblemRepository(db), logger });
const marketDataConnection = createConnection();
const { registry: providerRegistry, service: marketData } = createMarketData({
  db,
  redis: marketDataConnection,
  failover: { enabled: config.providers.failover.enabled },
  queueOptions: {
    concurrency: config.providers.maxConcurrency,
    minSpacingMs: config.providers.minSpacingMs,
  },
  options: {
    // Failed background revalidations never surface to callers (§5.3 — they
    // already got the stale copy), so the log line is their only trace.
    onBackgroundError: (key, err) =>
      logger.warn({ key, err }, 'market-data background refresh failed'),
    // A tripped breaker is a definitive provider failure → admin Problems page.
    breaker: {
      onOpen: (err, meta) => problems.captureProviderFailure(err, meta),
    },
  },
});
// The notification delivery core (#368): the worker is the ONE owner of
// notification fan-out. Every source (API or worker) enqueues onto the durable
// `notifications.dispatch` queue; the job below hands each event to this
// dispatcher — matrix resolve → inbox row / email / FCM push / web-push, with
// the (user, eventKey) marker keeping BullMQ's at-least-once retries idempotent.
const audit = createAuditService(createAuditRepository(db));
const email = createEmailService({
  config,
  logger,
  audit,
  emailLog: createEmailLogRepository(db),
  transport: config.email.enabled ? createSmtpTransport(config.email) : null,
});
const notificationRepo = createNotificationRepository(db);
const notificationDigestRepo = createNotificationDigestRepository(db);
const alertRepo = createAlertRepository(db);
const fcmChannel = createFcmChannel({
  serviceAccountFile: config.push.fcmServiceAccountFile,
  devices: createDeviceTokenRepository(db),
  logger,
});
const webPushChannel = createWebPushChannel({
  vapid: config.webPush,
  subscriptions: createPushSubscriptionRepository(db),
  logger,
});
const dispatcher = createNotificationDispatcher({
  bus: events,
  repo: notificationRepo,
  users: createUserRepository(db),
  email,
  resolveAlert: (alertId) => alertRepo.findNotificationContext(alertId),
  // Push channels are env-gated (#421): unset/missing config ⇒ null + one warn
  // log here at boot; the worker runs on either way.
  fcm: fcmChannel,
  webPush: webPushChannel,
  presence: createPresenceStore({ redis: deadLetterConnection }),
  // Digest cadence + queue (V5-P3): a daily/weekly type's outbound channels are
  // deferred into the digest queue; the digest jobs below deliver them.
  digest: {
    cadenceFor: (userId, type) => notificationDigestRepo.cadenceFor(userId, type),
    enqueue: (item) => notificationDigestRepo.enqueue(item),
  },
  // Quiet hours (V5-P3): an instant outbound notification fired inside the
  // recipient's quiet window is deferred here; the deferred-delivery job below
  // sends it at window end.
  quietHours: {
    enqueueDeferred: (item) => notificationDigestRepo.enqueueDeferred(item),
  },
  logger,
});

// The V5-P3 digest delivery core: the repeatable digest jobs drive it to render
// one grouped summary per (user, period) for the daily/weekly cadences.
const digestService = createDigestService({
  repo: notificationDigestRepo,
  users: createUserRepository(db),
  email,
  fcm: fcmChannel,
  webPush: webPushChannel,
  // Quiet hours (V5-P3): a digest whose delivery moment lands inside the user's
  // window is deferred to window end via the deferral store.
  quietHours: notificationDigestRepo,
  logger,
});

// Worker-side sources (the alert evaluator) emit through the same durable
// center as the API — one pipeline, no source ever talks to a channel (#368).
const notify = createNotificationCenter({
  enqueue: async (event) => {
    await registry.enqueue('notifications.dispatch', { event });
  },
  logger,
});

// Account data export (§13.4 V4-P6a, #494): the build + daily cleanup jobs close
// over the export service. Only buildExport/cleanupExpired run here (the re-auth
// deps below back the HTTP request path and are inert on the worker); enqueue is
// wired to the durable queue for completeness though the worker never requests.
const exportUserRepo = createUserRepository(db);
const dataExportService = createExportService({
  config,
  db,
  redis: deadLetterConnection,
  exportRepo: createExportRepository(db),
  userRepo: exportUserRepo,
  passwordHasher: createPasswordHasher(),
  twoFactor: createTwoFactorService({
    config,
    userRepo: exportUserRepo,
    twoFactorRepo: createTwoFactorRepository(db),
    audit,
    redis: deadLetterConnection,
    email,
  }),
  audit,
  notify,
  enqueueBuild: async (jobId) => {
    await registry.enqueue('data.export', { jobId });
  },
  withAccountTransitionLock: (userId, run) =>
    withFreshLockedPrivacyModes(lockDb, [userId], () => run()),
  logger,
});

// V5-P1 daily snapshots (#553): the worker runs the SAME snapshot engine the
// API serves reads from — one math, two uses. The nightly `snapshots.backfill`
// sweep (03:30 Vienna, after prices.refreshDaily) doubles as the first-run
// backfill of all existing portfolios; `snapshots.recompute` refills a single
// portfolio a write invalidated. No `requestRecompute` here — the jobs ARE the
// recompute, nothing to re-enqueue.
const snapshots = createPortfolioSnapshotService({
  snapshotRepo: createPortfolioSnapshotRepository(db),
  portfolioRepo: createPortfolioRepository(db),
  transactionRepo: createTransactionRepository(db),
  cashMovementRepo: createCashMovementRepository(db),
  marketData,
  currencyService: createCurrencyService({ source: createMarketDataFxSource(marketData) }),
  isParanoidPortfolio: isBlockedPortfolio,
  runIfAllowedPortfolio: runPortfolioJobIfAllowed,
  logger,
});

// V5-P7 MIRRORCHAIN (#644, design §2): the worker runs the `mirror.replicate`
// job, which applies each chain's pending ops to every member's copy THROUGH
// that member's own portfolio/tax services (force mode) — so it needs the same
// service stack the API composes, built here on the worker's connections.
const portfolioRepo = createPortfolioRepository(db);
const transactionRepo = createTransactionRepository(db);
const cashMovementRepo = createCashMovementRepository(db);
const cashSourceRepo = createCashSourceRepository(db);
const taxRepo = createTaxRepository(db);
const assetRepo = createAssetRepository(db);
const friendshipRepo = createFriendshipRepository(db);
const profileRepo = createProfileRepository(db);
const currencyService = createCurrencyService({ source: createMarketDataFxSource(marketData) });
// E4 recovery uses an explicitly transition-authorized snapshot engine. This
// private instance runs only for the durable transition retry plan under the
// owner's exclusive privacy lock.
const portfolioVaultFinalizationSnapshots = createPortfolioSnapshotService({
  snapshotRepo: createPortfolioSnapshotRepository(db),
  portfolioRepo,
  transactionRepo,
  cashMovementRepo,
  marketData,
  currencyService,
  logger,
});
const portfolioVaultFinalizationCashBudgets = createCashBudgetService({
  budgets: createCashBudgetRepository(db),
  summaries: createCashSummaryRepository(db),
  tags: createCashTagRepository(db),
  portfolios: portfolioRepo,
  notify,
  logger,
});
const portfolioVaultFinalizer = createPortfolioVaultMoveOutFinalizer({
  db,
  withFinalizationLock: (userId, run) => withExclusiveLockedPrivacyMode(lockDb, userId, run),
  runPostCommit: async (userId, portfolioId, plan) => {
    await marketData.settled();
    await Promise.all([
      purgeManualAssetCaches(deadLetterConnection, plan.customAssetIds),
      purgeBacktestCaches(deadLetterConnection, userId),
    ]);
    const affectedPortfolios = new Set([portfolioId]);
    for (const assetId of plan.customAssetIds) {
      const references = await portfolioVaultFinalizationSnapshots.resolveAssetReferences(assetId);
      await portfolioVaultFinalizationSnapshots.invalidateForAsset(assetId);
      for (const reference of references) affectedPortfolios.add(reference.portfolioId);
    }
    for (const affectedPortfolioId of [...affectedPortfolios].sort()) {
      await portfolioVaultFinalizationSnapshots.recompute(affectedPortfolioId);
    }
  },
  runAfterMoveOutUnlock: async (userId, portfolioId, plan) => {
    await portfolioVaultFinalizationCashBudgets.evaluateRequired(userId, portfolioId);
    await events.publish({
      type: 'portfolio.changed',
      userId,
      portfolioId,
      occurredAt: plan.completedAt,
    });
    await releaseRetiredLiveAssets(deadLetterConnection, plan.customAssetIds);
  },
});
const audience = createAudienceService({
  repo: createShareAudienceRepository(db),
  friendship: friendshipRepo,
  groups: createFriendGroupRepository(db),
  follows: createUserFollowsRepository(db),
  itemFollows: createItemFollowsRepository(db),
  profile: profileRepo,
  notify,
  logger,
  paranoid: paranoidGuard,
});
const taxService = createTaxService({
  taxRepo,
  portfolioSettingsRepo: createPortfolioSettingsRepository(db),
  transactionRepo,
  cashMovementRepo,
  cashSourceRepo,
  portfolioRepo,
  currencyService,
  snapshots,
  logger,
  paranoid: paranoidGuard,
});
// V5-P6b standing orders (#593): the worker owns the engine that the daily
// `standingOrders.process` job drives. Build it before the portfolio service so
// archive restores can durably close elapsed periods before the scan sees the
// portfolio as active again.
const standingOrders = createStandingOrderService({
  repo: createStandingOrderRepository(db),
  portfolioRepo,
  assetRepo,
  transactionRepo,
  cashMovementRepo,
  cashSourceRepo,
  marketData,
  snapshots,
  notify,
  paranoid: paranoidGuard,
  isParanoidForProcessing: standingOrderParanoidFilter,
  runIfAllowedForProcessing: standingOrderParanoidFilter.runAllowed,
  logger,
});
const portfolioService = createPortfolioService({
  portfolioRepo,
  transactionRepo,
  cashMovementRepo,
  cashSourceRepo,
  // Read-only: lets the cash ledger DTO carry each movement's tags (V5 cash fusion).
  cashTagRepo: createCashTagRepository(db),
  marketData,
  currencyService,
  referenceBackfill: createReferenceBackfill({
    assetRepo,
    backfill: createBackfillScheduler(registry),
    logger,
  }),
  snapshots,
  taxService,
  standingOrders,
  friendshipRepo,
  audience,
  profile: profileRepo,
  notify,
  logger,
});
// Plain enqueue, no job id: a retained completed/failed job under a fixed id
// silently swallows every later add (see mirrorJobs.ts); `replicateChain`'s
// per-chain lock serializes appliers instead.
const enqueueMirrorReplicate = async (chainId: string) => {
  await registry.enqueue('mirror.replicate', { chainId });
};
const mirrorchainRepo = createMirrorchainRepository(db);
const mirror = createMirrorService({
  repo: mirrorchainRepo,
  portfolio: portfolioService,
  tax: taxService,
  portfolioRepo,
  transactionRepo,
  cashMovementRepo,
  cashSourceRepo,
  taxRepo,
  users: createUserRepository(db),
  friendship: friendshipRepo,
  notify,
  maxMembers: config.mirror.maxMembers,
  audit,
  events,
  redis: deadLetterConnection,
  enqueueReplicate: enqueueMirrorReplicate,
  logger,
  paranoid: paranoidGuard,
});

// V5-P2 usage analytics (#567): the worker owns a rollup-only instance (no
// capture happens here — the API captures) that materializes the daily
// aggregates the admin page serves. Timer off; the cron drives it.
const usageAnalytics = createUsageAnalyticsService({
  repo: createUsageAnalyticsRepository(db, lockDb),
  logger,
  startTimer: false,
});

// V5-P10 outbound webhooks (#648): the worker owns the authoritative delivery
// core (signs + POSTs + records the log + auto-disable streak) and the bridge
// that fans a user-scoped event out to that user's subscriptions. The bridge
// runs from the `notifications.dispatch` job — the ONE place every such event
// converges — enqueuing a durable `webhooks.deliver` per matching subscription.
const webhookSubscriptionRepo = createWebhookSubscriptionRepository(db);
const webhookDeliveryRepo = createWebhookDeliveryRepository(db);
const webhookDispatcher = createWebhookDispatcher({
  subscriptions: webhookSubscriptionRepo,
  deliveries: webhookDeliveryRepo,
  transport: createFetchWebhookTransport(),
  encryptionKey: config.twoFactor.encryptionKey,
  audit,
  logger,
});
const webhookBridge = createWebhookBridge({
  subscriptions: webhookSubscriptionRepo,
  enqueue: async (job) => {
    await registry.enqueue('webhooks.deliver', job);
  },
  logger,
  paranoid: paranoidGuard,
  vaultedPortfolio: {
    portfolioSubject: (portfolioId) => paranoidSubjects.portfolioOwner(portfolioId),
    standingOrderPortfolio: (userId, standingOrderId) =>
      paranoidSubjects.standingOrderPortfolio(userId, standingOrderId),
    cashBudgetPortfolio: (userId, budgetId) =>
      paranoidSubjects.cashBudgetPortfolio(userId, budgetId),
    legacyExpenseBudgetExists: (userId, budgetId) =>
      paranoidSubjects.legacyExpenseBudgetExists(userId, budgetId),
    userHasPlainHolding: (userId, assetId) => paranoidSubjects.userHasPlainHolding(userId, assetId),
    mirrorMemberPortfolios: (chainId, principalUserIds) =>
      paranoidSubjects.mirrorMemberPortfolios(chainId, principalUserIds),
  },
});

const coreJobDeps = {
  db,
  marketData,
  notify,
  paranoid: paranoidGuard,
  // Custom assets (the `manual` provider) are durable in our own DB; the price
  // jobs must not fetch them (see MarketDataJobDeps.isLocalProvider).
  isLocalProvider: (providerId: string) =>
    providerRegistry.has(providerId) && providerRegistry.get(providerId).local === true,
};

const definitions = assembleRegisteredJobDefinitions({
  heartbeatJob,
  createPricesRefreshDailyJob: createPricesRefreshDailyJob(coreJobDeps),
  createPricesBackfillJob: createPricesBackfillJob(coreJobDeps),
  createFxRefreshSpotJob: createFxRefreshSpotJob(coreJobDeps),
  // `alerts.evaluate` survives paranoid mode but splits itself into an
  // unguarded global rail and an owner-locked custom-asset rail; the factory
  // returns the definition already carrying that `internallyFiltered` binding.
  createAlertsEvaluateJob: createAlertsEvaluateJob(coreJobDeps),
  createNotificationsDispatchJob: createNotificationsDispatchJob({
    dispatcher,
    webhooks: webhookBridge,
  }),
  createDigestDailyJob: createDigestDailyJob({ digest: digestService }),
  createDigestWeeklyJob: createDigestWeeklyJob({ digest: digestService }),
  createDeferredDeliveryJob: createDeferredDeliveryJob({ digest: digestService }),
  createExportBuildJob: createExportBuildJob({ exportService: dataExportService }),
  createExportCleanupJob: createExportCleanupJob({ exportService: dataExportService }),
  createPortfolioVaultFinalizeJob: createPortfolioVaultFinalizeJob(portfolioVaultFinalizer),
  createSnapshotsRecomputeJob: bindParanoidJob(createSnapshotsRecomputeJob({ snapshots }), {
    mode: 'portfolio',
    runIfAllowed: runPortfolioJobIfAllowed,
  }),
  createSnapshotsBackfillJob: bindParanoidJob(createSnapshotsBackfillJob({ snapshots }), {
    mode: 'serviceFiltered',
  }),
  createUsageRollupJob: createUsageRollupJob({ usageAnalytics }),
  // V5-P5 market intelligence (#582): the daily opt-in earnings-reminder scan
  // over every user's held + watched assets. Gated by MARKET_INTEL_ENABLED — a
  // no-op scan when the arc is unconfigured. Idempotency store = ctx.redis.
  createEarningsReminderJob: bindParanoidJob(
    createEarningsReminderJob({
      intelRepo: createMarketIntelRepository(db),
      marketData,
      notify,
      enabled: config.marketIntel.enabled,
      runIfAllowed: earningsParanoidFilter.runAllowed,
    }),
    { mode: 'perUser', filter: earningsParanoidFilter },
  ),
  // V5-P5 dividend-event scan (#581): fires opt-in ex-date reminders for held
  // assets. Gated by MARKET_INTEL_ENABLED; per-user opt-in read from the matrix.
  createDividendEventsScanJob: bindParanoidJob(
    createDividendEventsScanJob({
      repo: createMarketIntelRepository(db),
      marketData,
      notify,
      isEnabled: dividendNotifyGate(notificationRepo),
      enabled: config.marketIntel.enabled,
      runIfAllowed: dividendParanoidFilter.runAllowed,
    }),
    { mode: 'perUser', filter: dividendParanoidFilter },
  ),
  // V5-P6b standing orders (#593): the daily scan that books each active order's
  // newest due occurrence exactly once.
  createStandingOrdersJob: bindParanoidJob(createStandingOrdersJob({ standingOrders }), {
    mode: 'perUser',
    filter: standingOrderParanoidFilter,
  }),
  // V5-P7 MIRRORCHAIN (#644): per-chain replication — strictly ordered,
  // idempotent, watermark-resumed; permanent failure dead-letters → Problems.
  createMirrorReplicateJob: bindParanoidJob(
    createMirrorReplicateJob({ mirror, enqueue: enqueueMirrorReplicate }),
    { mode: 'serviceFiltered' },
  ),
  // V5-P7 MIRRORCHAIN (#680): the daily sweep that retires pending invites past
  // the 30-day token-hygiene horizon (frees the pending-unique slot).
  createMirrorInviteCleanupJob: createMirrorInviteCleanupJob({ repo: mirrorchainRepo }),
  // V5-P7 MIRRORCHAIN (#684): the daily defense-in-depth repair sweep — re-applies
  // §7 succession to any ownerless chain and surfaces the two crash residuals
  // (design §2 (a)/(b)) onto the admin Problems page.
  createMirrorConsistencySweepJob: bindParanoidJob(
    createMirrorConsistencySweepJob({ mirror, problems }),
    { mode: 'serviceFiltered' },
  ),
  // V5-P10 outbound webhooks (#648): the signed delivery job (retry/backoff via
  // job options + auto-disable) and the daily delivery-log retention sweep.
  createWebhookDeliverJob: bindParanoidJob(
    createWebhookDeliverJob({ dispatcher: webhookDispatcher }),
    {
      mode: 'event',
      isEventAllowed: (event) =>
        isVaultedPortfolioContentEventAllowed(event, {
          portfolioSubject: (portfolioId) => paranoidSubjects.portfolioOwner(portfolioId),
          standingOrderPortfolio: (userId, standingOrderId) =>
            paranoidSubjects.standingOrderPortfolio(userId, standingOrderId),
          cashBudgetPortfolio: (userId, budgetId) =>
            paranoidSubjects.cashBudgetPortfolio(userId, budgetId),
          legacyExpenseBudgetExists: (userId, budgetId) =>
            paranoidSubjects.legacyExpenseBudgetExists(userId, budgetId),
          userHasPlainHolding: (userId, assetId) =>
            paranoidSubjects.userHasPlainHolding(userId, assetId),
          mirrorMemberPortfolios: (chainId, principalUserIds) =>
            paranoidSubjects.mirrorMemberPortfolios(chainId, principalUserIds),
        }),
      runIfAllowed: async (userIds, action) => {
        try {
          await paranoidGuard.runAllowedMany(userIds, 'portfolioWebhooks', action);
          return true;
        } catch (error) {
          if (error instanceof ParanoidModeError) return false;
          throw error;
        }
      },
    },
  ),
  createWebhookDeliveryCleanupJob: createWebhookDeliveryCleanupJob({
    deliveries: webhookDeliveryRepo,
  }),
  // V5-P10 API-key governance (issue 2/2): the daily retention sweep over the
  // bounded per-key request-log audit trail.
  createApiKeyRequestLogCleanupJob: createApiKeyRequestLogCleanupJob({
    requestLog: createApiKeyRequestLogRepository(db, lockDb),
  }),
  // V5-P14 PL-01: bounded daily retention sweep over identifying operational
  // trails. A zero-day config keeps that table forever and skips its branch;
  // the remembered-device sweep runs regardless, since those bindings carry a
  // fixed lifetime rather than an owner-configured window.
  createDataRetentionCleanupJob: createDataRetentionCleanupJob({
    audit: createAuditRepository(db),
    emailLog: createEmailLogRepository(db),
    vaultStaging: createParanoidVaultRepository(db),
    users: workerUserRepo,
    auditRetentionDays: config.retention.auditDays,
    emailLogRetentionDays: config.retention.emailLogDays,
  }),
});

assertParanoidJobBindings(definitions, ALL_QUEUE_NAMES);

const ctx: JobContext = { events, deadLetter, redis: deadLetterConnection, logger };

const running = createJobWorkers({
  createConnection,
  definitions,
  ctx,
  logger,
  // Permanently-failed (dead-lettered) jobs are reported to error tracking AND
  // captured onto the admin Problems page (§13.5 V5-P2 arc (d)).
  onPermanentFailure: (err, meta) => {
    observability.captureException(err, meta);
    problems.captureJobFailure(err, meta);
  },
});

// Prometheus scrape listener for the worker (#632): the `bettertrack_job_outcomes_total`
// counter is only ever incremented in THIS process, so without a metrics endpoint
// here Prometheus can never scrape it and the dashboard's "Job outcomes" panel
// stays empty. Bound localhost/LAN-only exactly like the API's, on the same
// BT_METRICS_PORT (a separate container, so no port clash); Prometheus adds a
// `worker:9464` scrape target alongside `api:9464`.
const metricsServer = createMetricsServer(config, logger);

const scheduled = await registerSchedules(registry, definitions);
// Enqueue one immediate proof on every successful bootstrap. The healthcheck
// only turns green after a BullMQ worker consumes it and writes the canonical
// Redis marker; the repeatable schedule keeps that proof fresh thereafter.
await registry.enqueue(heartbeatJob.name, {});
logger.info({ queues: definitions.map((d) => d.name), scheduled }, 'BetterTrack worker started');

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'worker shutting down');
  try {
    await running.close();
    // Close the metrics scrape listener alongside the workers.
    if (metricsServer) {
      metricsServer.closeIdleConnections();
      await new Promise<void>((resolve) => metricsServer.close(() => resolve()));
    }
    // Persist any in-flight problem captures before the DB connection closes.
    await problems.flush();
    // Let in-flight background cache revalidations write their results before
    // their Redis connection goes away.
    await marketData.settled();
    await registry.close();
    await events.close();
    await deadLetterConnection.quit();
    await marketDataConnection.quit();
    await lockClient.end();
    await client.end();
    // Flush any buffered Sentry events before the process exits.
    await observability.close();
  } catch (err) {
    logger.error({ err }, 'error during worker shutdown');
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
