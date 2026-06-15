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

export const heartbeatJob: JobDefinition<'system.heartbeat'> = {
  name: QUEUE_NAMES.systemHeartbeat,
  schedule: { id: HEARTBEAT_SCHEDULER_ID, every: HEARTBEAT_INTERVAL_MS },
  async handler(job, ctx) {
    const occurredAt = new Date(job.timestamp || Date.now()).toISOString();
    ctx.logger.debug({ jobId: job.id, occurredAt }, 'heartbeat: publishing proof event');
    await ctx.events.publish({
      type: 'quote.updated',
      assetId: HEARTBEAT_ASSET_ID,
      occurredAt,
    });
  },
};
