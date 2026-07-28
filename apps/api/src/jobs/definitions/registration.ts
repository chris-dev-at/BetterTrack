import { QUEUE_NAMES, type JobDefinition, type QueueName } from '../types';

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
 * a queue other than the one attached to its production source identity.
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
    return definition;
  });
}
