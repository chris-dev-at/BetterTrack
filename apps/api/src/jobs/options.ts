import type { DefaultJobOptions } from 'bullmq';

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
