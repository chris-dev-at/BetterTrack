import type { Redis } from 'ioredis';
import { z } from 'zod';

import type {
  AdminOpsJobFailure,
  AdminOpsJobsResponse,
  AdminOpsQueue,
  AdminOpsSchedule,
} from '@bettertrack/contracts';

import {
  ALL_QUEUE_NAMES,
  DEAD_LETTER_KEY,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_LAST_KEY,
  type QueueName,
  type QueueRegistry,
} from '../../jobs';

import { scrubOpsError } from './opsText';

/**
 * The job half of the admin operations cockpit (#1406 W4).
 *
 * PROJECTPLAN.md §9 promised a "dead-letter list visible in admin stats" and
 * nothing ever rendered it: the list is written by the worker into Redis and,
 * until now, read by nobody. This is that read, joined to BullMQ's own job
 * counts and scheduler records so one request answers the three questions an
 * operator actually has — is work piling up, did the scheduled work run, and
 * what broke.
 *
 * **Strictly read-only.** The #1406 DECISION killed generic queue
 * retry/discard/mass-retry ("per-job idempotency and privacy differ too much to
 * expose one button"), and Bull Board is already pinned to `readOnlyMode` with
 * `allowRetries: false`. There is deliberately no write path here — not a
 * disabled one, not a guarded one, none.
 *
 * Two things are deliberately dropped on the way out:
 *
 *  - **The job payload.** `DeadLetterEntry.data` exists for diagnosis and is
 *    never projected. An operator needs "notifications.dispatch is failing with
 *    ECONNREFUSED", not who the notification was for.
 *  - **Any non-numeric `returnvalue`.** BullMQ stores whatever a handler
 *    returns; {@link summaryOf} keeps only finite numbers, so a handler that
 *    someday returns a row it fetched cannot leak it through this surface.
 */

/** How many dead-letter entries the cockpit shows by default. */
export const JOB_FAILURE_PAGE_SIZE = 25;

/**
 * Queues whose most recent completed run is worth reading in full.
 *
 * Reading the newest completed job costs one Redis round-trip per queue, so
 * this is bounded to the SCHEDULED queues (the ones with a repeat spec) rather
 * than fanned out over all 26. On-demand queues have no "last scheduled run" to
 * report — their story is the depth table above.
 */
export interface JobOpsDeps {
  /** Producer-side registry; null in a process that holds none (tests, API-only). */
  queues: QueueRegistry | null;
  /** Redis for the §9 dead-letter list and the worker heartbeat key. */
  redis: Redis;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** How many dead-letter entries to project. Defaults to {@link JOB_FAILURE_PAGE_SIZE}. */
  failureLimit?: number;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * A completed job's `returnvalue`, reduced to the counts contract.
 *
 * This is the second of the two gates named on {@link JobRunSummary}: the type
 * constrains what handlers may return, and this constrains what leaves the
 * process. A value that is not a flat object of finite numbers becomes `null` —
 * showing nothing is always safe, showing an unknown shape is not.
 */
export function summaryOf(value: unknown): Record<string, number> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) return null;
    out[key] = entry;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Heartbeat age in seconds, or null when the key was never written / is unreadable. */
async function heartbeatAgeSeconds(redis: Redis, now: number): Promise<number | null> {
  try {
    const last = await redis.get(HEARTBEAT_LAST_KEY);
    if (!last) return null;
    const parsed = Date.parse(last);
    if (!Number.isFinite(parsed)) return null;
    return Math.round(Math.max(0, now - parsed) / 1000);
  } catch {
    // The Redis component of `/admin/health` already reports an outage; this
    // surface degrades to "unknown" rather than failing the whole cockpit read.
    return null;
  }
}

/**
 * The shape a dead-letter row must have to be projectable.
 *
 * `deadLetter.record()` writes exactly this today, but the list is a Redis
 * value written by a SEPARATE process across deploys: an older format, a
 * half-written row, or a future field change all reach this reader, and none of
 * them is a reason to blank the panel. Unknown keys are stripped rather than
 * passed through — which is also a third gate on the payload, since `data`
 * cannot survive a parse that does not declare it.
 */
const deadLetterRowSchema = z.object({
  queue: z.string(),
  jobId: z.string().optional(),
  name: z.string(),
  failedReason: z.string(),
  attemptsMade: z.number().int().nonnegative(),
  timestamp: z.number().int().nonnegative(),
});

/**
 * Newest-first dead-letter entries, payload stripped and every row validated.
 *
 * Reads the raw list rather than going through `deadLetter.list()`, because that
 * helper swallows a corrupt row silently — which is the right call for its other
 * callers and the wrong one here: an operator looking at a failure panel needs
 * to know the panel is incomplete. `total` comes from `LLEN` and is settled
 * independently of the projection, so a page that cannot be read still reports
 * how many rows are retained.
 */
async function readFailures(
  redis: Redis,
  limit: number,
): Promise<{ failures: AdminOpsJobFailure[]; total: number; malformed: number }> {
  const [rawResult, totalResult] = await Promise.allSettled([
    redis.lrange(DEAD_LETTER_KEY, 0, limit > 0 ? limit - 1 : -1),
    redis.llen(DEAD_LETTER_KEY),
  ]);

  const total = totalResult.status === 'fulfilled' ? totalResult.value : 0;
  if (rawResult.status !== 'fulfilled') return { failures: [], total, malformed: 0 };

  const failures: AdminOpsJobFailure[] = [];
  let malformed = 0;

  for (const raw of rawResult.value) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      malformed += 1;
      continue;
    }
    const parsed = deadLetterRowSchema.safeParse(decoded);
    if (!parsed.success) {
      malformed += 1;
      continue;
    }
    const entry = parsed.data;
    failures.push({
      queue: entry.queue,
      jobId: entry.jobId ?? null,
      name: entry.name,
      // An error message, not a payload — the same class of text the Problems
      // page already shows an admin, and scrubbed the same way before it is
      // bounded (see `scrubOpsError`).
      failedReason: scrubOpsError(entry.failedReason),
      attemptsMade: entry.attemptsMade,
      at: iso(entry.timestamp),
    });
  }

  return { failures, total, malformed };
}

/** Depths for every declared queue, including `paused` (which health omits). */
async function readQueues(queues: QueueRegistry): Promise<AdminOpsQueue[]> {
  return Promise.all(
    ALL_QUEUE_NAMES.map(async (name) => {
      const counts = await queues
        .get(name)
        .getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed', 'paused');
      return {
        name,
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        failed: counts.failed ?? 0,
        completed: counts.completed ?? 0,
        paused: counts.paused ?? 0,
      };
    }),
  );
}

/**
 * Every repeatable schedule BullMQ holds, plus its newest completed run.
 *
 * `next` comes from BullMQ's own scheduler record rather than from re-parsing
 * the cron pattern in the browser: the scheduler is the thing that will
 * actually fire, so it is the only honest source for "next run" and for the
 * overdue judgement the cockpit draws from it.
 *
 * COST, stated because this is an operator surface that may poll: BullMQ's
 * `Queue` API has no batched form, so this is one round-trip per queue for the
 * scheduler records, plus one more for each queue that actually HAS a schedule.
 * The last-run read is deliberately sequenced AFTER the scheduler read rather
 * than issued alongside it — most of the ~26 queues are on-demand and have no
 * schedule at all, and fetching their newest completed job only to discard it
 * doubled the round-trips for nothing. Pipelining the rest would mean reaching
 * past the `Queue` API into its key layout, which is not worth owning here;
 * the honest fix if this ever bites is a cached snapshot, not a private
 * reimplementation of BullMQ's reads.
 */
async function readSchedules(queues: QueueRegistry): Promise<AdminOpsSchedule[]> {
  const perQueue = await Promise.all(
    ALL_QUEUE_NAMES.map(async (name: QueueName) => {
      const queue = queues.get(name);
      const schedulers = await queue.getJobSchedulers();
      if (schedulers.length === 0) return [];

      // Newest completed job on this queue. `removeOnComplete: { count: 1000 }`
      // means one is retained for every queue that has ever run.
      const completed = await queue.getJobs(['completed'], 0, 0, false);
      const newest = completed[0];
      const finishedOn = newest?.finishedOn ?? null;
      const processedOn = newest?.processedOn ?? null;
      const lastRun =
        finishedOn === null
          ? null
          : {
              finishedAt: iso(finishedOn),
              durationMs: processedOn === null ? 0 : Math.max(0, finishedOn - processedOn),
              counts: summaryOf(newest?.returnvalue),
            };

      return schedulers.map((scheduler) => ({
        id: scheduler.id ?? scheduler.key,
        queue: name,
        pattern: scheduler.pattern ?? null,
        everyMs: typeof scheduler.every === 'number' ? scheduler.every : null,
        tz: scheduler.tz ?? null,
        nextRunAt: typeof scheduler.next === 'number' ? iso(scheduler.next) : null,
        lastRun,
      }));
    }),
  );
  return perQueue.flat();
}

/**
 * One read of everything the cockpit's "Health & queues" tab needs.
 *
 * Fails soft as a whole: a process with no registry answers `available: false`
 * with empty arrays, because "nothing is queued" and "I cannot see the queue"
 * must not render identically. A registry that is present but unreadable (a
 * Redis blip) does the same — the Redis component of `/admin/health` is where
 * that fault is named.
 */
export async function readJobOps(deps: JobOpsDeps): Promise<AdminOpsJobsResponse> {
  const now = deps.now ?? Date.now;
  const at = now();
  const [heartbeat, failurePage] = await Promise.all([
    heartbeatAgeSeconds(deps.redis, at),
    readFailures(deps.redis, deps.failureLimit ?? JOB_FAILURE_PAGE_SIZE),
  ]);

  const base = {
    checkedAt: iso(at),
    heartbeatAgeSeconds: heartbeat,
    heartbeatIntervalSeconds: Math.round(HEARTBEAT_INTERVAL_MS / 1000),
    failures: failurePage.failures,
    failureTotal: failurePage.total,
    malformed: failurePage.malformed,
  };

  if (!deps.queues) {
    return { ...base, available: false, queues: [], schedules: [] };
  }

  try {
    const [queues, schedules] = await Promise.all([
      readQueues(deps.queues),
      readSchedules(deps.queues),
    ]);
    return { ...base, available: true, queues, schedules };
  } catch {
    return { ...base, available: false, queues: [], schedules: [] };
  }
}
