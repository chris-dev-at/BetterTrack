import type { Job, JobsOptions, WorkerOptions } from 'bullmq';
import type { Redis } from 'ioredis';

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
  // V5-P10 outbound webhooks (#648): per-event HMAC-signed delivery with the
  // repo's retry/backoff, plus a daily retention sweep over the delivery log.
  webhooksDeliver: 'webhooks.deliver',
  webhooksDeliveryCleanup: 'webhooks.deliveryCleanup',
  // V5-P10 API-key governance (issue 2/2): daily retention sweep over the
  // bounded per-key request-log audit trail.
  apiKeyRequestLogCleanup: 'apiKeys.requestLogCleanup',
  systemHeartbeat: 'system.heartbeat',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** Every queue name, for registry iteration. */
export const ALL_QUEUE_NAMES = Object.values(QUEUE_NAMES) as readonly QueueName[];

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
  'usage.rollup': Record<string, never>;
  'notifications.earningsRemind': Record<string, never>;
  'marketIntel.dividendScan': Record<string, never>;
  'standingOrders.process': Record<string, never>;
  'mirror.replicate': { chainId: string };
  'mirror.inviteCleanup': Record<string, never>;
  // One HMAC-signed POST of `event` to the subscription; `deliveryId` is stable
  // across retries (receiver dedupe key + delivery-log row id).
  'webhooks.deliver': { subscriptionId: string; deliveryId: string; event: DomainEvent };
  'webhooks.deliveryCleanup': Record<string, never>;
  'apiKeys.requestLogCleanup': Record<string, never>;
  'system.heartbeat': Record<string, never>;
}

export type JobPayload<N extends QueueName> = JobPayloads[N];

/** What a job handler is handed at run time: the bus, dead-letter list, Redis, logger. */
export interface JobContext {
  events: EventBus;
  deadLetter: DeadLetter;
  redis: Redis;
  logger: Logger;
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
export interface JobDefinition<N extends QueueName = QueueName> {
  name: N;
  // Method syntax (bivariant) so a concrete `JobDefinition<'system.heartbeat'>`
  // is assignable to `JobDefinition<QueueName>` in the definitions collection.
  handler(job: Job<JobPayload<N>>, ctx: JobContext): Promise<void>;
  /** Present → the job is registered as a repeatable schedule. */
  schedule?: RepeatSpec;
  /** Per-job option overrides merged onto {@link DEFAULT_JOB_OPTIONS}. */
  jobOptions?: JobsOptions;
  /** Per-worker overrides (e.g. `concurrency`). */
  workerOptions?: Partial<WorkerOptions>;
}
