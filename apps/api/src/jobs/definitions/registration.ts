import { QUEUE_JOB_OPTIONS } from '../options';
import { QUEUE_FEATURE_FLAGS, QUEUE_NAMES, type JobDefinition, type QueueName } from '../types';

const DECLARED_QUEUE_JOB_OPTIONS: Partial<Record<QueueName, object>> = QUEUE_JOB_OPTIONS;

export interface JobRegistrationSource {
  readonly file: string;
  readonly symbol: string;
}

/**
 * Side-effect-free identity for one definition installed by the production
 * worker. `key` makes registrations distinct even when they share a queue;
 * `source` keeps completeness diagnostics actionable.
 */
export interface JobRegistrationDescriptor<N extends QueueName = QueueName> {
  readonly key: string;
  readonly name: N;
  readonly source: JobRegistrationSource;
}

const descriptor = <K extends string, N extends QueueName>(
  key: K,
  name: N,
  file: string,
  symbol: string,
) => ({
  key,
  name,
  source: {
    file: `apps/api/src/jobs/definitions/${file}`,
    symbol,
  },
});

/**
 * The exact definition set installed by `scripts/worker.ts`.
 *
 * Keep composition here rather than inferring it from `QUEUE_NAMES`: the queue
 * catalog says which names are legal, while this registry says which concrete
 * factories and handlers production executes.
 */
export const JOB_REGISTRATION_DESCRIPTORS = [
  descriptor('heartbeatJob', QUEUE_NAMES.systemHeartbeat, 'heartbeat.ts', 'heartbeatJob'),
  descriptor(
    'createPricesRefreshDailyJob',
    QUEUE_NAMES.pricesRefreshDaily,
    'marketDataJobs.ts',
    'createPricesRefreshDailyJob',
  ),
  descriptor(
    'createPricesBackfillJob',
    QUEUE_NAMES.pricesBackfill,
    'marketDataJobs.ts',
    'createPricesBackfillJob',
  ),
  descriptor(
    'createFxRefreshSpotJob',
    QUEUE_NAMES.fxRefreshSpot,
    'marketDataJobs.ts',
    'createFxRefreshSpotJob',
  ),
  descriptor(
    'createAlertsEvaluateJob',
    QUEUE_NAMES.alertsEvaluate,
    'alertsJob.ts',
    'createAlertsEvaluateJob',
  ),
  descriptor(
    'createNotificationsDispatchJob',
    QUEUE_NAMES.notificationsDispatch,
    'notificationsJob.ts',
    'createNotificationsDispatchJob',
  ),
  descriptor(
    'createDigestDailyJob',
    QUEUE_NAMES.notificationsDigestDaily,
    'digestJobs.ts',
    'createDigestDailyJob',
  ),
  descriptor(
    'createDigestWeeklyJob',
    QUEUE_NAMES.notificationsDigestWeekly,
    'digestJobs.ts',
    'createDigestWeeklyJob',
  ),
  descriptor(
    'createDeferredDeliveryJob',
    QUEUE_NAMES.notificationsDeferredDelivery,
    'digestJobs.ts',
    'createDeferredDeliveryJob',
  ),
  descriptor(
    'createExportBuildJob',
    QUEUE_NAMES.dataExport,
    'exportJobs.ts',
    'createExportBuildJob',
  ),
  descriptor(
    'createExportCleanupJob',
    QUEUE_NAMES.dataExportCleanup,
    'exportJobs.ts',
    'createExportCleanupJob',
  ),
  descriptor(
    'createSnapshotsRecomputeJob',
    QUEUE_NAMES.snapshotsRecompute,
    'snapshotJobs.ts',
    'createSnapshotsRecomputeJob',
  ),
  descriptor(
    'createSnapshotsBackfillJob',
    QUEUE_NAMES.snapshotsBackfill,
    'snapshotJobs.ts',
    'createSnapshotsBackfillJob',
  ),
  descriptor(
    'createPortfolioVaultFinalizeJob',
    QUEUE_NAMES.portfolioVaultFinalize,
    'portfolioVaultJobs.ts',
    'createPortfolioVaultFinalizeJob',
  ),
  descriptor(
    'createUsageRollupJob',
    QUEUE_NAMES.usageRollup,
    'usageAnalyticsJobs.ts',
    'createUsageRollupJob',
  ),
  descriptor(
    'createEarningsReminderJob',
    QUEUE_NAMES.earningsRemind,
    'earningsReminderJob.ts',
    'createEarningsReminderJob',
  ),
  descriptor(
    'createDividendEventsScanJob',
    QUEUE_NAMES.marketIntelDividendScan,
    'dividendEventsJob.ts',
    'createDividendEventsScanJob',
  ),
  descriptor(
    'createStandingOrdersJob',
    QUEUE_NAMES.standingOrdersProcess,
    'standingOrdersJob.ts',
    'createStandingOrdersJob',
  ),
  descriptor(
    'createMirrorReplicateJob',
    QUEUE_NAMES.mirrorReplicate,
    'mirrorJobs.ts',
    'createMirrorReplicateJob',
  ),
  descriptor(
    'createMirrorInviteCleanupJob',
    QUEUE_NAMES.mirrorInviteCleanup,
    'mirrorJobs.ts',
    'createMirrorInviteCleanupJob',
  ),
  descriptor(
    'createMirrorConsistencySweepJob',
    QUEUE_NAMES.mirrorConsistencySweep,
    'mirrorJobs.ts',
    'createMirrorConsistencySweepJob',
  ),
  descriptor(
    'createWebhookDeliverJob',
    QUEUE_NAMES.webhooksDeliver,
    'webhookJobs.ts',
    'createWebhookDeliverJob',
  ),
  descriptor(
    'createWebhookDeliveryCleanupJob',
    QUEUE_NAMES.webhooksDeliveryCleanup,
    'webhookJobs.ts',
    'createWebhookDeliveryCleanupJob',
  ),
  descriptor(
    'createApiKeyRequestLogCleanupJob',
    QUEUE_NAMES.apiKeyRequestLogCleanup,
    'apiKeyJobs.ts',
    'createApiKeyRequestLogCleanupJob',
  ),
  descriptor(
    'createDataRetentionCleanupJob',
    QUEUE_NAMES.dataRetentionCleanup,
    'retentionJobs.ts',
    'createDataRetentionCleanupJob',
  ),
] as const;

type ProductionJobRegistration = (typeof JOB_REGISTRATION_DESCRIPTORS)[number];
type ProductionJobRegistrationKey = ProductionJobRegistration['key'];

type DescriptorFor<K extends ProductionJobRegistrationKey> = Extract<
  ProductionJobRegistration,
  { readonly key: K }
>;

/**
 * Exhaustive, source-keyed input consumed by the worker. An object literal that
 * omits a descriptor or installs an extra definition fails type checking.
 */
export type RegisteredJobDefinitions = {
  readonly [K in ProductionJobRegistrationKey]: JobDefinition<DescriptorFor<K>['name']>;
};

/**
 * Assemble definitions in registry order and fail closed if a factory returns
 * a queue other than the one attached to its production source identity, or
 * declares job options the queue registry would not apply.
 *
 * The options check is by identity on purpose: the registry seeds queues from
 * {@link QUEUE_JOB_OPTIONS}, so a definition may only restate its queue's entry
 * from that map. An inline object here would look authoritative next to the
 * handler while every enqueued job carried the plain defaults — which is
 * exactly how `webhooks.deliver` came to retry 3 times against a documented 5.
 *
 * The kill-switch check is the same shape and exists for the same reason: the
 * queue catalog says which switch owns a queue ({@link QUEUE_FEATURE_FLAGS}),
 * and a production definition on an owned queue may not boot without declaring
 * it — otherwise the switch would keep gating only the HTTP router while the
 * producer behind it kept firing.
 */
export function assembleRegisteredJobDefinitions(
  definitions: RegisteredJobDefinitions,
): readonly JobDefinition[] {
  return JOB_REGISTRATION_DESCRIPTORS.map((registration) => {
    const definition = definitions[registration.key] as JobDefinition;
    if (definition.name !== registration.name) {
      throw new Error(
        `${registration.source.file}#${registration.source.symbol} returned ${definition.name}; expected ${registration.name}`,
      );
    }
    if (
      definition.jobOptions &&
      definition.jobOptions !== DECLARED_QUEUE_JOB_OPTIONS[definition.name]
    ) {
      throw new Error(
        `${registration.source.file}#${registration.source.symbol} declares jobOptions that are not the QUEUE_JOB_OPTIONS entry for ${definition.name}; enqueued jobs would not carry them`,
      );
    }
    const owningFlag = QUEUE_FEATURE_FLAGS[definition.name];
    if ((definition.featureFlag ?? null) !== owningFlag) {
      throw new Error(
        owningFlag
          ? `${registration.source.file}#${registration.source.symbol} does not declare featureFlag '${owningFlag}'; the '${owningFlag}' kill switch would not stop ${definition.name}`
          : `${registration.source.file}#${registration.source.symbol} declares featureFlag '${definition.featureFlag}', which does not own ${definition.name} in QUEUE_FEATURE_FLAGS`,
      );
    }
    return definition;
  });
}
