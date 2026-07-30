import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import type { ReadinessResponse } from '@bettertrack/contracts';

import type { Database } from '../../data/db';
import { withTimeout } from '../../providers/resilience';
import { API_SERVICE_NAME, API_VERSION } from '../../version';

/** Each dependency gets its own tight budget; the probes run concurrently. */
export const READINESS_TIMEOUT_MS = 1_500;

export interface ReadinessServiceDeps {
  db: Database;
  redis: Redis;
  timeoutMs?: number;
  /** Injectable wall clock for deterministic latency/timestamp tests. */
  now?: () => number;
}

export interface ReadinessService {
  check(): Promise<ReadinessResponse>;
}

type ReadinessCheck = ReadinessResponse['checks']['database'];

/**
 * Dependency readiness for the container gate. This stays separate from the
 * richer operator health service: provider, queue and realtime degradation must
 * remain visible to admins without taking the API container out of rotation.
 */
export function createReadinessService(deps: ReadinessServiceDeps): ReadinessService {
  const timeoutMs = deps.timeoutMs ?? READINESS_TIMEOUT_MS;
  const now = deps.now ?? Date.now;

  async function probe(run: () => Promise<unknown>): Promise<ReadinessCheck> {
    const startedAt = now();
    try {
      await withTimeout(run, timeoutMs);
      return { status: 'ok', latencyMs: Math.max(0, now() - startedAt) };
    } catch {
      return { status: 'down', latencyMs: Math.max(0, now() - startedAt) };
    }
  }

  return {
    async check(): Promise<ReadinessResponse> {
      const [database, redis] = await Promise.all([
        probe(() => deps.db.execute(sql`select 1`)),
        probe(async () => {
          if ((await deps.redis.ping()) !== 'PONG') {
            throw new Error('Unexpected Redis ping response');
          }
        }),
      ]);

      return {
        status: database.status === 'ok' && redis.status === 'ok' ? 'ready' : 'not_ready',
        service: API_SERVICE_NAME,
        version: API_VERSION,
        timestamp: new Date(now()).toISOString(),
        checks: { database, redis },
      };
    },
  };
}
