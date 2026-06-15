import type { Redis } from 'ioredis';

import { createRedis } from '../redis';

/**
 * ioredis connection factory for the BullMQ job system (PROJECTPLAN.md §9).
 *
 * Reuses the shared {@link createRedis} factory (driven by `config/env.ts`
 * `REDIS_URL`) so workers, queues and the event bus all speak to the same Redis
 * as the API. `createRedis` already sets `maxRetriesPerRequest: null`, which
 * BullMQ requires.
 *
 * BullMQ needs distinct connections for distinct roles: every `Worker` holds a
 * blocking connection that cannot be shared, and pub/sub subscribers must be
 * dedicated. Queues may share one. Callers therefore take this **factory** and
 * mint connections per role rather than passing one connection around.
 */
export function createJobConnection(url: string): Redis {
  return createRedis(url);
}

/** A zero-arg factory bound to one `REDIS_URL`, handy for per-role minting. */
export type JobConnectionFactory = () => Redis;

/** Bind {@link createJobConnection} to a URL. */
export function jobConnectionFactory(url: string): JobConnectionFactory {
  return () => createJobConnection(url);
}
