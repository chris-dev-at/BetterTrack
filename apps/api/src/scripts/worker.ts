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
import { createNotificationRepository } from '../data/repositories/notificationRepository';
import { createNotificationDigestRepository } from '../data/repositories/notificationDigestRepository';
import { createPushSubscriptionRepository } from '../data/repositories/pushSubscriptionRepository';
import { createUserRepository } from '../data/repositories/userRepository';
import { createEventBus } from '../events';
import {
  createDeadLetter,
  createExportBuildJob,
  createExportCleanupJob,
  createJobDefinitions,
  createJobWorkers,
  createNotificationsDispatchJob,
  createDigestDailyJob,
  createDigestWeeklyJob,
  createDeferredDeliveryJob,
  createQueueRegistry,
  createSnapshotsBackfillJob,
  createSnapshotsRecomputeJob,
  jobConnectionFactory,
  registerSchedules,
  type JobContext,
} from '../jobs';
import { createCashMovementRepository } from '../data/repositories/cashMovementRepository';
import { createPortfolioRepository } from '../data/repositories/portfolioRepository';
import { createPortfolioSnapshotRepository } from '../data/repositories/portfolioSnapshotRepository';
import { createTransactionRepository } from '../data/repositories/transactionRepository';
import { createCurrencyService } from '../services/currency/currencyService';
import { createMarketDataFxSource } from '../services/currency/marketDataFxSource';
import { createPortfolioSnapshotService } from '../services/portfolio/portfolioSnapshots';
import { createLogger } from '../logger';
import { createMarketData } from '../providers';
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
  logger,
});

const definitions = [
  ...createJobDefinitions({
    db,
    marketData,
    notify,
    // Custom assets (the `manual` provider) are durable in our own DB; the price
    // jobs must not fetch them (see MarketDataJobDeps.isLocalProvider).
    isLocalProvider: (providerId) =>
      providerRegistry.has(providerId) && providerRegistry.get(providerId).local === true,
  }),
  createNotificationsDispatchJob({ dispatcher }),
  createDigestDailyJob({ digest: digestService }),
  createDigestWeeklyJob({ digest: digestService }),
  createDeferredDeliveryJob({ digest: digestService }),
  createExportBuildJob({ exportService: dataExportService }),
  createExportCleanupJob({ exportService: dataExportService }),
  createSnapshotsRecomputeJob({ snapshots }),
  createSnapshotsBackfillJob({ snapshots }),
];

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

const scheduled = await registerSchedules(registry, definitions);
logger.info({ queues: definitions.map((d) => d.name), scheduled }, 'BetterTrack worker started');

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'worker shutting down');
  try {
    await running.close();
    // Persist any in-flight problem captures before the DB connection closes.
    await problems.flush();
    // Let in-flight background cache revalidations write their results before
    // their Redis connection goes away.
    await marketData.settled();
    await registry.close();
    await events.close();
    await deadLetterConnection.quit();
    await marketDataConnection.quit();
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
