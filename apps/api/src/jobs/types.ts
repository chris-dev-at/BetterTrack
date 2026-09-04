import type { Job, JobsOptions, WorkerOptions } from 'bullmq';
import type { Redis } from 'ioredis';

import type { FeatureFlagKey } from '@bettertrack/contracts';

import type { DomainEvent, EventBus } from '../events';
import type { Logger } from '../logger';

import type { DeadLetter } from './deadLetter';

/**
 * The BullMQ queues that make up the job system (PROJECTPLAN.md §9). One queue
 * per logical job. `system.heartbeat` is the wiring smoke-test added by this
 * issue; the market-data/notification job bodies are dropped into the others by
 * later issues, so only their names and payload shapes are fixed here.
 */
export const QUEUE_NAMES = {
  alertsEvaluate: 'alerts.evaluate',
  pricesRefreshDaily: 'prices.refreshDaily',
  pricesBackfill: 'prices.backfill',
  fxRefreshSpot: 'fx.refreshSpot',
  notificationsDispatch: 'notifications.dispatch',
  // V5-P3 digest mode (#575): repeatable jobs that render one grouped summary
  // per user per period for the daily/weekly outbound cadences.
  notificationsDigestDaily: 'notifications.digestDaily',
  notificationsDigestWeekly: 'notifications.digestWeekly',
  // V5-P3 quiet hours (#579): a frequent, cheap, idempotent job that delivers
  // notifications deferred past a user's quiet-hours window, once due.
  notificationsDeferredDelivery: 'notifications.deferredDelivery',
  // Account data export (§13.4 V4-P6a, #494): the build job assembles one user's
  // zip on demand; the cleanup job prunes expired exports on a daily schedule.
  dataExport: 'data.export',
  dataExportCleanup: 'data.exportCleanup',
  // V5-P1 daily snapshots (#553): on-demand recompute of one invalidated
  // portfolio, and the nightly roll/backfill sweep over every portfolio.
  snapshotsRecompute: 'snapshots.recompute',
  snapshotsBackfill: 'snapshots.backfill',
  // E4: durable recovery for move-outs whose cleartext restore committed but
  // whose derived-state rebuild/final membership flip has not yet converged.
  portfolioVaultFinalize: 'portfolioVault.finalize',
  // V5-P2 usage analytics (#567): the nightly rollup that materializes the
  // per-day usage aggregates the admin usage-analytics page serves.
  usageRollup: 'usage.rollup',
  // V5-P5 market intelligence (#582): the daily scan that emits the opt-in
  // earnings reminder for held/watched assets with a report in the lead window.
  earningsRemind: 'notifications.earningsRemind',
  // V5-P5 market intelligence (#581): the daily scan that fires opt-in dividend
  // ex-date reminders for held assets (idempotent per user+asset+ex-date).
  marketIntelDividendScan: 'marketIntel.dividendScan',
  // V5-P6b standing orders (#593): the daily scan that books each active order's
  // newest due occurrence exactly once (idempotent per period).
  standingOrdersProcess: 'standingOrders.process',
  // V5-P7 MIRRORCHAIN (#644, design §2): bring every copy of one chain up to
  // `last_seq` — strictly ordered, idempotent per op, per-chain serialized via
  // job-id dedupe. Enqueued after every chain write and on join.
  mirrorReplicate: 'mirror.replicate',
  // V5-P7 MIRRORCHAIN (#680, design §4): daily sweep that retires pending
  // invites past the 30-day token-hygiene horizon (frees the pending-unique
  // slot; matches the accept-time expiry check).
  mirrorInviteCleanup: 'mirror.inviteCleanup',
  // V5-P7 MIRRORCHAIN (#684, design §2/§7): daily defense-in-depth repair sweep
  // that re-applies §7 succession to any ownerless active chain and surfaces the
  // two crash residuals onto the admin Problems page.
  mirrorConsistencySweep: 'mirror.consistencySweep',
  // V5-P10 outbound webhooks (#648): per-event HMAC-signed delivery with the
  // repo's retry/backoff, plus a daily retention sweep over the delivery log.
  webhooksDeliver: 'webhooks.deliver',
  webhooksDeliveryCleanup: 'webhooks.deliveryCleanup',
  // V5-P10 API-key governance (issue 2/2): daily retention sweep over the
  // bounded per-key request-log audit trail.
  apiKeyRequestLogCleanup: 'apiKeys.requestLogCleanup',
  // V5-P14 PL-01: bounded daily purge of identifying audit + email-log rows.
  dataRetentionCleanup: 'data.retentionCleanup',
  systemHeartbeat: 'system.heartbeat',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** Every queue name, for registry iteration. */
export const ALL_QUEUE_NAMES = Object.values(QUEUE_NAMES) as readonly QueueName[];

/**
 * Which runtime kill switch each queue belongs to (PROJECTPLAN.md §6.12: the
 * flags are "read per request"; §13.5 V5-P2 arc (c)).
 *
 * A kill switch exists to STOP something, so gating only the HTTP router was
 * half a switch: flipping `alerts` OFF hid the alerts surface — the user's way
 * to see, pause or delete an alert — while `alerts.evaluate` kept firing and
 * kept enqueuing `alert.triggered` onto the durable dispatch queue. A queue
 * named here is shed at the job boundary by {@link JobDefinition.featureFlag},
 * enforced centrally in `runJobDefinition`.
 *
 * The map is TOTAL over {@link QUEUE_NAMES} on purpose: a new queue does not
 * typecheck until its author has answered "which switch owns this?", and `null`
 * is the explicit answer "none". That is what stops the next flag-owning
 * producer from silently escaping the switch the way this one did.
 *
 * `notifications.dispatch` stays `null` deliberately: it is the shared delivery
 * lane for every event type, not the alerts producer, so gating it on `alerts`
 * would kill unrelated notifications. Shedding happens where the fire is
 * PRODUCED, so nothing reaches the durable queue in the first place.
 */
export const QUEUE_FEATURE_FLAGS: Readonly<Record<QueueName, FeatureFlagKey | null>> = {
  'alerts.evaluate': 'alerts',
  'prices.refreshDaily': null,
  'prices.backfill': null,
  'fx.refreshSpot': null,
  'notifications.dispatch': null,
  'notifications.digestDaily': null,
  'notifications.digestWeekly': null,
  'notifications.deferredDelivery': null,
  'data.export': null,
  'data.exportCleanup': null,
  'snapshots.recompute': null,
  'snapshots.backfill': null,
  'portfolioVault.finalize': null,
  'usage.rollup': null,
  'notifications.earningsRemind': null,
  'marketIntel.dividendScan': null,
  'standingOrders.process': null,
  'mirror.replicate': null,
  'mirror.inviteCleanup': null,
  'mirror.consistencySweep': null,
  'webhooks.deliver': null,
  'webhooks.deliveryCleanup': null,
  'apiKeys.requestLogCleanup': null,
  'data.retentionCleanup': null,
  'system.heartbeat': null,
};

/** The switch that owns `name`, or null when the queue is ungated. */
export function featureFlagForQueue(name: QueueName): FeatureFlagKey | null {
  return QUEUE_FEATURE_FLAGS[name];
}

/** Every producer queue a given kill switch owns, in catalog order. */
export function flagOwningQueues(flag: FeatureFlagKey): readonly QueueName[] {
  return ALL_QUEUE_NAMES.filter((name) => QUEUE_FEATURE_FLAGS[name] === flag);
}

/**
 * The typed payload each queue carries. Scheduled jobs that operate over "all
 * relevant assets" take no payload; on-demand and event-driven jobs carry the
 * minimum needed to do their work.
 */
export interface JobPayloads {
  'alerts.evaluate': Record<string, never>;
  'prices.refreshDaily': Record<string, never>;
  'prices.backfill': { assetId: string };
  'fx.refreshSpot': Record<string, never>;
  'notifications.dispatch': { event: DomainEvent };
  'notifications.digestDaily': Record<string, never>;
  'notifications.digestWeekly': Record<string, never>;
  'notifications.deferredDelivery': Record<string, never>;
  'data.export': { jobId: string };
  'data.exportCleanup': Record<string, never>;
  'snapshots.recompute': { portfolioId: string };
  'snapshots.backfill': Record<string, never>;
  'portfolioVault.finalize': Record<string, never>;
  'usage.rollup': Record<string, never>;
  'notifications.earningsRemind': Record<string, never>;
  'marketIntel.dividendScan': Record<string, never>;
  'standingOrders.process': Record<string, never>;
  'mirror.replicate': { chainId: string };
  'mirror.inviteCleanup': Record<string, never>;
  'mirror.consistencySweep': Record<string, never>;
  // One HMAC-signed POST of `event` to the subscription; `deliveryId` is stable
  // across retries (receiver dedupe key + delivery-log row id).
  'webhooks.deliver': { subscriptionId: string; deliveryId: string; event: DomainEvent };
  'webhooks.deliveryCleanup': Record<string, never>;
  'apiKeys.requestLogCleanup': Record<string, never>;
  'data.retentionCleanup': Record<string, never>;
  'system.heartbeat': Record<string, never>;
}

export type JobPayload<N extends QueueName> = JobPayloads[N];

/** What a job handler is handed at run time: the bus, dead-letter list, Redis, logger. */
export interface JobContext {
  events: EventBus;
  deadLetter: DeadLetter;
  redis: Redis;
  logger: Logger;
  /**
   * Runtime kill-switch read (§13.5 V5-P2 arc (c)) — the worker's equivalent of
   * the API's `requireFeature` guard. Required, not optional: a job context that
   * cannot resolve a flag is a context whose flag-owning producers would keep
   * running after the switch was flipped, so it must not be constructible.
   *
   * Resolved PER RUN, never captured at worker startup: the underlying service
   * reads the admin-flipped value through its shared Redis snapshot, so a flip
   * takes effect on the next scheduled run with no redeploy.
   */
  isFeatureEnabled(key: FeatureFlagKey): Promise<boolean>;
}

/**
 * How a repeatable job is scheduled from code (PROJECTPLAN.md §9: "All
 * schedules live in code (no external cron)"). Exactly one of `every` / `pattern`.
 */
export interface RepeatSpec {
  /** Stable scheduler id; re-registering with the same id is idempotent. */
  id: string;
  /** Fixed interval in milliseconds. */
  every?: number;
  /** Cron pattern (mutually exclusive with `every`). */
  pattern?: string;
  /** Timezone for a cron `pattern` (e.g. `Europe/Vienna`). */
  tz?: string;
}

/**
 * A self-contained job definition: the queue it runs on, its handler, optional
 * repeat schedule, and option overrides. The worker bootstrap turns a list of
 * these into BullMQ workers and registers their schedules.
 */
/**
 * What a handler may report about the run it just finished (#1406 W4).
 *
 * **Numbers only, by design.** BullMQ persists a handler's return value as the
 * job's `returnvalue`, and the admin operations cockpit reads it to answer
 * "what did last night's retention sweep actually delete?". Constraining the
 * type to counts is what makes that safe: a sweep reports HOW MANY rows it
 * touched, never WHICH, so no identifier can reach an operator screen through a
 * job's return value — the same reason Bull Board redacts `returnValue`
 * wholesale. The projection re-checks this at the boundary; the type is the
 * first of the two gates, not the only one.
 */
export type JobRunSummary = Readonly<Record<string, number>>;

export interface JobDefinition<N extends QueueName = QueueName> {
  name: N;
  // Method syntax (bivariant) so a concrete `JobDefinition<'system.heartbeat'>`
  // is assignable to `JobDefinition<QueueName>` in the definitions collection.
  // A handler may return a {@link JobRunSummary}; returning nothing stays valid
  // and is what almost every handler does.
  handler(job: Job<JobPayload<N>>, ctx: JobContext): Promise<void | JobRunSummary>;
  /** Present → the job is registered as a repeatable schedule. */
  schedule?: RepeatSpec;
  /**
   * The runtime kill switch this producer belongs to (§13.5 V5-P2 arc (c)).
   * Declarative on purpose: the handler stays unaware of flags, and the single
   * execution seam (`runJobDefinition`) sheds the whole run — no evaluation, no
   * side effect, no idempotency bucket consumed — while the switch is OFF.
   *
   * It must equal this queue's {@link QUEUE_FEATURE_FLAGS} entry;
   * `assembleRegisteredJobDefinitions` refuses a production definition that
   * omits its queue's flag or claims one the queue does not own.
   */
  featureFlag?: FeatureFlagKey;
  /**
   * The non-default options jobs on this queue carry, stated next to the
   * handler that relies on them. It must be the queue's entry from
   * `QUEUE_JOB_OPTIONS` — that map is what the queue registry seeds queues
   * with, and the worker refuses to assemble a definition that declares
   * anything else, so this field can never again describe options that no
   * enqueued job actually gets.
   */
  jobOptions?: JobsOptions;
  /** Per-worker overrides (e.g. `concurrency`). */
  workerOptions?: Partial<WorkerOptions>;
}
