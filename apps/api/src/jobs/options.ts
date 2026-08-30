import type { DefaultJobOptions, JobsOptions } from 'bullmq';

import { QUEUE_NAMES, type QueueName } from './types';

/**
 * Default options applied to every enqueued job (PROJECTPLAN.md §9):
 * "Retries: 3 attempts, exponential backoff."
 *
 * - `attempts: 3` — the job runs at most three times before it is permanently
 *   failed and dead-lettered.
 * - exponential backoff with a 1s base — retries are delayed ~1s, ~2s, ~4s …,
 *   so a flapping upstream is not hammered.
 * - completed jobs are trimmed to a bounded window (memory hygiene); failed
 *   jobs are retained longer for inspection, with the authoritative permanent
 *   failures also copied to the dead-letter list (see `deadLetter.ts`).
 */
export const BACKOFF_BASE_MS = 1000;

export const DEFAULT_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: BACKOFF_BASE_MS },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
};

/**
 * Per-queue deviations from the §9 defaults, merged onto
 * {@link DEFAULT_JOB_OPTIONS} when the queue is created.
 *
 * This map — not the handler-side `JobDefinition.jobOptions` field — is
 * what the queue registry reads, because the API process enqueues jobs from a
 * registry it builds without ever constructing a job definition (the
 * definitions need worker-only dependencies). A definition that wants
 * non-default options declares the entry from here, so the options the handler
 * documents and the options BullMQ stamps cannot drift apart.
 *
 * Keep this list short: a queue with no entry keeps the §9 defaults.
 */
export const QUEUE_JOB_OPTIONS = {
  // §13.5 V5-P10: an outbound delivery is retried five times before the
  // dispatcher calls it terminal and advances the auto-disable streak, so a
  // receiver blip of a few seconds does not spend a subscription's failure
  // budget. The 3-attempt default would make that budget ~3s wide.
  [QUEUE_NAMES.webhooksDeliver]: {
    attempts: 5,
    backoff: { type: 'exponential', delay: BACKOFF_BASE_MS },
  },
} as const satisfies Partial<Record<QueueName, JobsOptions>>;

/** Widened view for lookups by an arbitrary queue name. */
const QUEUE_JOB_OPTION_OVERRIDES: Partial<Record<QueueName, JobsOptions>> = QUEUE_JOB_OPTIONS;

/**
 * The options a job enqueued on `name` carries when the caller passes none.
 * BullMQ merges an explicit per-call `opts` over these, so a call site can
 * still override any single key.
 */
export function jobOptionsForQueue(name: QueueName): JobsOptions {
  const override = QUEUE_JOB_OPTION_OVERRIDES[name];
  return override ? { ...DEFAULT_JOB_OPTIONS, ...override } : DEFAULT_JOB_OPTIONS;
}
