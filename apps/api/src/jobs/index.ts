/**
 * Public surface of the BullMQ job system (PROJECTPLAN.md §9). Callers — the
 * worker bootstrap, services that enqueue jobs, admin stats — import from here.
 */
export {
  QUEUE_NAMES,
  ALL_QUEUE_NAMES,
  type QueueName,
  type JobPayloads,
  type JobPayload,
  type JobContext,
  type JobDefinition,
  type RepeatSpec,
} from './types';
export { DEFAULT_JOB_OPTIONS, BACKOFF_BASE_MS } from './options';
export { createJobConnection, jobConnectionFactory, type JobConnectionFactory } from './connection';
export { createQueueRegistry, type QueueRegistry } from './queues';
export {
  createBackfillScheduler,
  noopBackfillScheduler,
  type BackfillScheduler,
} from './backfillScheduler';
export {
  createDeadLetter,
  isPermanentFailure,
  DEAD_LETTER_KEY,
  DEAD_LETTER_MAX,
  type DeadLetter,
  type DeadLetterEntry,
} from './deadLetter';
export {
  registerSchedule,
  registerSchedules,
  toRepeatOptions,
  type SchedulableQueue,
} from './scheduler';
export { createJobWorkers, type RunningWorkers, type CreateJobWorkersDeps } from './worker';
export {
  createJobDefinitions,
  heartbeatJob,
  HEARTBEAT_SCHEDULER_ID,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_ASSET_ID,
  createAlertsEvaluateJob,
  ALERTS_EVALUATE_SCHEDULER_ID,
  ALERTS_EVALUATE_INTERVAL_MS,
  createPricesRefreshDailyJob,
  createPricesBackfillJob,
  createFxRefreshSpotJob,
  PRICES_REFRESH_DAILY_SCHEDULER_ID,
  PRICES_REFRESH_DAILY_CRON,
  PRICES_REFRESH_DAILY_TZ,
  FX_REFRESH_SPOT_SCHEDULER_ID,
  FX_REFRESH_SPOT_CRON,
  REFRESH_DAILY_RANGE,
  BACKFILL_RANGE,
  DAILY_INTERVAL,
  BACKFILL_LIMITER,
  type MarketDataJobDeps,
} from './definitions';
