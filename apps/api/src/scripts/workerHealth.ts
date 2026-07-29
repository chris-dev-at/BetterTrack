import { pathToFileURL } from 'node:url';

import type { Redis } from 'ioredis';

import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_LAST_KEY } from '../jobs';
import { createRedis } from '../redis';
import { withTimeout } from '../providers/resilience';

/** Match the admin health service's three-missed-heartbeat freshness window. */
export const WORKER_HEARTBEAT_MAX_AGE_MS = HEARTBEAT_INTERVAL_MS * 3;
/** Keep the probe below Compose's five-second healthcheck timeout. */
export const WORKER_HEALTH_REDIS_TIMEOUT_MS = 2_000;

export function isWorkerHeartbeatFresh(value: string | null, now = Date.now()): boolean {
  if (!value) return false;
  const occurredAt = Date.parse(value);
  if (!Number.isFinite(occurredAt)) return false;
  const ageMs = now - occurredAt;
  return ageMs >= 0 && ageMs <= WORKER_HEARTBEAT_MAX_AGE_MS;
}

export async function checkWorkerHeartbeat(
  redis: Pick<Redis, 'get'>,
  options: { now?: number; timeoutMs?: number } = {},
): Promise<boolean> {
  try {
    const value = await withTimeout(
      () => redis.get(HEARTBEAT_LAST_KEY),
      options.timeoutMs ?? WORKER_HEALTH_REDIS_TIMEOUT_MS,
    );
    return isWorkerHeartbeatFresh(value, options.now);
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!redisUrl) {
    console.error('Worker healthcheck failed: REDIS_URL is not configured.');
    process.exitCode = 1;
    return;
  }

  const redis = createRedis(redisUrl);
  try {
    if (!(await checkWorkerHeartbeat(redis))) {
      console.error(
        'Worker healthcheck failed: heartbeat is absent, invalid, stale, or Redis is unavailable.',
      );
      process.exitCode = 1;
    }
  } finally {
    redis.disconnect();
  }
}

// Importing this module in tests must not connect to Redis.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
