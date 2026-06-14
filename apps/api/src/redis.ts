import { Redis } from 'ioredis';

/**
 * Shared Redis connection (sessions, rate limits; BullMQ/pub-sub later).
 * `maxRetriesPerRequest: null` is required for BullMQ compatibility down the line.
 */
export function createRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}
