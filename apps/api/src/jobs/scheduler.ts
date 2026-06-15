import type { RepeatOptions } from 'bullmq';

import type { QueueRegistry } from './queues';
import type { JobDefinition, RepeatSpec } from './types';

/**
 * Repeatable-job registration (PROJECTPLAN.md §9: "All schedules live in code
 * (no external cron)").
 *
 * Uses BullMQ's `upsertJobScheduler`, which is idempotent on the scheduler id:
 * re-running the worker re-asserts the schedule rather than stacking duplicate
 * timers, and changing the interval/pattern updates the existing one in place.
 */

/** The slice of `Queue` the scheduler needs — keeps the helper trivially testable. */
export interface SchedulableQueue {
  upsertJobScheduler(
    jobSchedulerId: string,
    repeatOpts: Omit<RepeatOptions, 'key'>,
    jobTemplate?: { name?: string; data?: unknown },
  ): Promise<unknown>;
}

/** Translate our {@link RepeatSpec} into BullMQ repeat options. */
export function toRepeatOptions(spec: RepeatSpec): Omit<RepeatOptions, 'key'> {
  if (spec.pattern !== undefined) {
    return spec.tz !== undefined
      ? { pattern: spec.pattern, tz: spec.tz }
      : { pattern: spec.pattern };
  }
  if (spec.every !== undefined) {
    return { every: spec.every };
  }
  throw new Error(`Repeat spec "${spec.id}" must set either "every" or "pattern"`);
}

/** Register one repeatable schedule on a queue. */
export async function registerSchedule(
  queue: SchedulableQueue,
  spec: RepeatSpec,
  data: unknown = {},
): Promise<void> {
  await queue.upsertJobScheduler(spec.id, toRepeatOptions(spec), { name: spec.id, data });
}

/**
 * Register every scheduled job in `definitions` against the registry. Jobs
 * without a `schedule` are skipped (they run on demand / on event). Returns the
 * scheduler ids that were registered.
 */
export async function registerSchedules(
  registry: QueueRegistry,
  definitions: readonly JobDefinition[],
): Promise<string[]> {
  const registered: string[] = [];
  for (const def of definitions) {
    if (!def.schedule) continue;
    await registerSchedule(registry.get(def.name), def.schedule);
    registered.push(def.schedule.id);
  }
  return registered;
}
