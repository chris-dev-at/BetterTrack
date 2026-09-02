import { z } from 'zod';

import { healthCircuitStateSchema } from './admin';

/**
 * Operations-cockpit reads (#1406 W4).
 *
 * The W4 workspace merges Health / Monitoring / Problems / queues into one
 * operator surface. Everything here is a **projection of numbers the process
 * already counts** — BullMQ's own job counts and schedulers, the §9 dead-letter
 * list, the per-capability circuit breakers (§13.5 V5-P1c) and the Prometheus
 * market-cache counters. Nothing here writes, enqueues, retries or discards:
 * the #1406 DECISION kills generic queue retry/discard/mass-retry outright, so
 * this contract deliberately has no request shape at all.
 *
 * Two privacy rules are baked into the SHAPES rather than left to callers:
 *
 *  1. **A job payload never appears.** The dead-letter record carries `data`
 *     (the payload, for diagnosis) and this projection has no field for it —
 *     the same reason Bull Board redacts payloads. A future field cannot leak
 *     one by accident because `.strict()` rejects unknown keys on the way out.
 *  2. **Free text is bounded.** `failedReason` and `lastError` are the only
 *     strings that originate outside our own code, and both are capped, so a
 *     rogue upstream error that embeds a whole request body cannot turn an
 *     operator read into a data dump.
 */

/** Hard cap on any error string this surface republishes. */
export const ADMIN_OPS_ERROR_MAX_LENGTH = 300;

const boundedError = z.string().max(ADMIN_OPS_ERROR_MAX_LENGTH);

/** One BullMQ queue's live depth, including the states §9 cares about. */
export const adminOpsQueueSchema = z
  .object({
    name: z.string(),
    waiting: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    delayed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    paused: z.number().int().nonnegative(),
  })
  .strict();
export type AdminOpsQueue = z.infer<typeof adminOpsQueueSchema>;

/**
 * What a scheduled run reported when it finished.
 *
 * `counts` is the handler's own summary — the pruned-row counts of a retention
 * sweep, for example. It is `Record<string, number>` on purpose: a sweep reports
 * HOW MANY rows it touched, never WHICH, so no identifier can reach an admin
 * screen through a job's return value.
 */
export const adminOpsJobRunSchema = z
  .object({
    finishedAt: z.string(),
    durationMs: z.number().int().nonnegative(),
    counts: z.record(z.string(), z.number()).nullable(),
  })
  .strict();
export type AdminOpsJobRun = z.infer<typeof adminOpsJobRunSchema>;

/**
 * One repeatable schedule as BullMQ holds it (§9: "all schedules live in
 * code"), plus the outcome of its most recent completed run.
 *
 * `nextRunAt` comes from BullMQ's own scheduler record, so the cockpit's
 * "next / overdue" column is the scheduler's answer rather than a re-derivation
 * of the cron expression on the client.
 */
export const adminOpsScheduleSchema = z
  .object({
    id: z.string(),
    queue: z.string(),
    /** Cron pattern, when the schedule is cron-shaped. */
    pattern: z.string().nullable(),
    /** Fixed interval in ms, when the schedule is interval-shaped. */
    everyMs: z.number().int().positive().nullable(),
    tz: z.string().nullable(),
    nextRunAt: z.string().nullable(),
    lastRun: adminOpsJobRunSchema.nullable(),
  })
  .strict();
export type AdminOpsSchedule = z.infer<typeof adminOpsScheduleSchema>;

/**
 * One permanently-failed job from the §9 dead-letter list.
 *
 * Note what is NOT here: the job payload. `DeadLetterEntry.data` is retained
 * server-side for diagnosis and is deliberately not projected — an operator
 * needs to know that `notifications.dispatch` is failing and why, not who the
 * notification was for.
 */
export const adminOpsJobFailureSchema = z
  .object({
    queue: z.string(),
    jobId: z.string().nullable(),
    name: z.string(),
    failedReason: boundedError,
    attemptsMade: z.number().int().nonnegative(),
    at: z.string(),
  })
  .strict();
export type AdminOpsJobFailure = z.infer<typeof adminOpsJobFailureSchema>;

/**
 * Response body of `GET /api/v1/admin/ops/jobs`.
 *
 * `available: false` is the honest answer from a process that holds no queue
 * registry (the API under test, or a deploy without the worker's Redis-backed
 * queues) — the cockpit says so rather than drawing five zeroes, because "no
 * jobs waiting" and "I cannot see the jobs" are different operational facts.
 */
export const adminOpsJobsResponseSchema = z
  .object({
    available: z.boolean(),
    checkedAt: z.string(),
    /** Worker heartbeat age in seconds; null when the key was never written. */
    heartbeatAgeSeconds: z.number().int().nonnegative().nullable(),
    /** The interval the heartbeat is expected on, so the UI can judge staleness. */
    heartbeatIntervalSeconds: z.number().int().positive(),
    queues: z.array(adminOpsQueueSchema),
    schedules: z.array(adminOpsScheduleSchema),
    failures: z.array(adminOpsJobFailureSchema),
    /** Total retained dead-letter entries, of which `failures` is the newest page. */
    failureTotal: z.number().int().nonnegative(),
  })
  .strict();
export type AdminOpsJobsResponse = z.infer<typeof adminOpsJobsResponseSchema>;

/**
 * One provider capability's breaker (§13.5 V5-P1c / #1552).
 *
 * Breakers are scoped per provider AND capability precisely so a dead
 * `fundamentals` module cannot fail-fast `quote`. `GET /admin/health` reports
 * only the worst state per provider, which hides exactly the distinction the
 * isolation was built for — this is that missing dimension.
 */
export const adminOpsBreakerSchema = z
  .object({
    capability: z.string(),
    state: healthCircuitStateSchema,
    /** Consecutive failures since the last success, i.e. progress to tripping. */
    consecutiveFailures: z.number().int().nonnegative(),
    /** Threshold the failures above are counted against. */
    failureThreshold: z.number().int().positive(),
    /** When the breaker last tripped open; null if it never has. */
    openedAt: z.string().nullable(),
    /** When a half-open probe becomes admissible; null unless currently open. */
    retryAt: z.string().nullable(),
    /**
     * Error class (or message, when the class is anonymous) of the failure that
     * tripped the breaker — the same disclosure level `AdminHealthComponent.detail`
     * already carries, bounded so it can never grow into a payload dump.
     */
    lastError: boundedError.nullable(),
    lastErrorAt: z.string().nullable(),
  })
  .strict();
export type AdminOpsBreaker = z.infer<typeof adminOpsBreakerSchema>;

/** Provider call outcomes since this process booted. */
export const adminOpsProviderCallsSchema = z
  .object({
    success: z.number().int().nonnegative(),
    error: z.number().int().nonnegative(),
    /** Calls short-circuited by an open breaker — never attempted upstream. */
    circuitOpen: z.number().int().nonnegative(),
  })
  .strict();
export type AdminOpsProviderCalls = z.infer<typeof adminOpsProviderCallsSchema>;

/** One upstream provider: its worst breaker state, every capability, its calls. */
export const adminOpsProviderSchema = z
  .object({
    providerId: z.string(),
    /** Worst state across the provider's capability breakers (open ≻ half ≻ closed). */
    state: healthCircuitStateSchema,
    capabilities: z.array(adminOpsBreakerSchema),
    calls: adminOpsProviderCallsSchema,
  })
  .strict();
export type AdminOpsProvider = z.infer<typeof adminOpsProviderSchema>;

/**
 * Market-cache outcomes since this process booted (§5.3).
 *
 * Rates are `null` rather than `0` when nothing has been sampled yet: a cache
 * that has answered no lookups has no hit rate, and drawing "0 %" would read as
 * a catastrophe rather than as silence.
 */
export const adminOpsCacheStatsSchema = z
  .object({
    hit: z.number().nonnegative(),
    miss: z.number().nonnegative(),
    stale: z.number().nonnegative(),
    negative: z.number().nonnegative(),
    total: z.number().nonnegative(),
    /** Share of lookups served from the fresh copy, 0–1. Null when total is 0. */
    hitRate: z.number().min(0).max(1).nullable(),
    /** Share of lookups served stale-while-revalidate, 0–1. Null when total is 0. */
    staleRate: z.number().min(0).max(1).nullable(),
  })
  .strict();
export type AdminOpsCacheStats = z.infer<typeof adminOpsCacheStatsSchema>;

/**
 * Response body of `GET /api/v1/admin/ops/providers`.
 *
 * `sampledSince` exists because these counters are **process-local**: prom-client
 * counters live in the API process that answers the request and reset when it
 * restarts, and the worker's own provider calls are counted in the worker. The
 * field lets the UI say so instead of implying an all-time, whole-deployment
 * number. There is deliberately no upstream quota gauge — Yahoo is keyless, and
 * the #1406 DECISION rejected inventing one.
 */
export const adminOpsProvidersResponseSchema = z
  .object({
    checkedAt: z.string(),
    sampledSince: z.string(),
    providers: z.array(adminOpsProviderSchema),
    cache: adminOpsCacheStatsSchema,
  })
  .strict();
export type AdminOpsProvidersResponse = z.infer<typeof adminOpsProvidersResponseSchema>;
