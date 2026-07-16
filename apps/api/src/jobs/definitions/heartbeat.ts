import { QUEUE_NAMES, type JobDefinition } from '../types';

/**
 * `system.heartbeat` — the end-to-end wiring smoke-test (issue scope, not a §9
 * product job). It proves the whole harness without any market-data dependency:
 * the scheduler enqueues it on an interval, a worker processes it, and the
 * handler publishes a typed domain event onto the bus.
 *
 * It publishes a `quote.updated` for the reserved sentinel asset id below. That
 * id matches no real asset, so the realtime gateway routes it to an empty
 * `asset:__heartbeat__` room with no effect — exactly what we want from a
 * liveness probe. Real `quote.updated` events come from the price jobs later.
 */

/** Stable scheduler id; idempotent across worker restarts. */
export const HEARTBEAT_SCHEDULER_ID = 'system.heartbeat';

/** How often the heartbeat fires. */
export const HEARTBEAT_INTERVAL_MS = 60_000;

/** Reserved, non-routable asset id carried by the heartbeat's proof event. */
export const HEARTBEAT_ASSET_ID = '__heartbeat__';

/**
 * Redis key holding the last heartbeat tick's ISO timestamp. Written by the
 * worker on every tick, read by the admin health check (§13.4 V4-P5a) — a
 * cross-process freshness marker for "is the job system alive?". Kept a small
 * multiple of the interval by re-writing each tick (no TTL: a stale value is
 * itself the signal the health check reports).
 */
export const HEARTBEAT_LAST_KEY = 'system:heartbeat:last';

export const heartbeatJob: JobDefinition<'system.heartbeat'> = {
  name: QUEUE_NAMES.systemHeartbeat,
  schedule: { id: HEARTBEAT_SCHEDULER_ID, every: HEARTBEAT_INTERVAL_MS },
  async handler(job, ctx) {
    const occurredAt = new Date(job.timestamp || Date.now()).toISOString();
    ctx.logger.debug({ jobId: job.id, occurredAt }, 'heartbeat: publishing proof event');
    // Freshness marker for the admin health page — read cross-process from Redis.
    await ctx.redis.set(HEARTBEAT_LAST_KEY, occurredAt);
    await ctx.events.publish({
      type: 'quote.updated',
      assetId: HEARTBEAT_ASSET_ID,
      occurredAt,
    });
  },
};
