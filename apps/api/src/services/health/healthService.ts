import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import type {
  AdminHealthComponent,
  AdminHealthQueueDepth,
  AdminHealthResponse,
  HealthStatus,
} from '@bettertrack/contracts';

import type { AppConfig } from '../../config/env';
import type { Database } from '../../data/db';
import { ALL_QUEUE_NAMES, HEARTBEAT_INTERVAL_MS, HEARTBEAT_LAST_KEY } from '../../jobs';
import type { QueueRegistry } from '../../jobs';
import type { MarketDataService } from '../../providers';
import type { RealtimeGateway } from '../../realtime';
import { API_VERSION } from '../../version';

/**
 * Admin health service (PROJECTPLAN.md §13.4 V4-P5a).
 *
 * Assembles the operator diagnostics snapshot behind `GET /admin/health`: a live
 * probe of each dependency (DB / Redis pings, provider circuit breakers, queue
 * depths + heartbeat freshness, realtime gateway) plus app version and uptime.
 * Every check runs on demand — no caching — so a stopped Redis reflects on the
 * very next request (the "within 30 s" acceptance is trivially met by a fresh
 * probe). Probes fail soft: one component down never throws the whole response,
 * it just marks that component `down`/`degraded`.
 *
 * This is the RICHER, admin-only companion to the public `/health` liveness
 * probe (`http/healthRouter.ts`), which stays the unauthenticated deploy marker.
 */
export interface HealthServiceDeps {
  config: AppConfig;
  db: Database;
  redis: Redis;
  marketData: MarketDataService;
  /** Producer-side queue registry; null in processes that hold none (tests). */
  queues: QueueRegistry | null;
  gateway: RealtimeGateway;
  /** Injectable clock (heartbeat freshness tests). Defaults to `Date.now`. */
  now?: () => number;
}

export interface HealthService {
  check(): Promise<AdminHealthResponse>;
}

/** A heartbeat older than this is treated as stale (a soft, degraded signal). */
const HEARTBEAT_STALE_MS = HEARTBEAT_INTERVAL_MS * 3;

const errorDetail = (err: unknown): string =>
  err instanceof Error ? err.name || err.message : 'error';

export function createHealthService(deps: HealthServiceDeps): HealthService {
  const { config, db, redis, marketData, queues, gateway } = deps;
  const now = deps.now ?? Date.now;

  async function checkDatabase(): Promise<AdminHealthComponent> {
    const started = now();
    try {
      await db.execute(sql`select 1`);
      return { status: 'ok', latencyMs: now() - started };
    } catch (err) {
      return { status: 'down', detail: errorDetail(err) };
    }
  }

  async function checkRedis(): Promise<AdminHealthComponent> {
    const started = now();
    try {
      const pong = await redis.ping();
      if (pong !== 'PONG') return { status: 'degraded', detail: 'unexpected ping reply' };
      return { status: 'ok', latencyMs: now() - started };
    } catch (err) {
      return { status: 'down', detail: errorDetail(err) };
    }
  }

  function checkProviders(): AdminHealthResponse['components']['providers'] {
    const breakers = marketData.breakerStates();
    // An open (or half-open) breaker is a soft fault: the market-data layer
    // serves stale, so the surface still works but upstream is impaired (§5.3).
    const status: HealthStatus = breakers.some((b) => b.state !== 'closed') ? 'degraded' : 'ok';
    // Failover attribution (§13.5 V5-P1c): who is serving each chain, the recent
    // switches, and per-provider serve counts. Epoch-ms → ISO at this boundary.
    const failover = marketData.failoverStatus();
    const iso = (ms: number | null): string | null =>
      ms === null ? null : new Date(ms).toISOString();
    return {
      status,
      breakers,
      chains: failover.chains.map((c) => ({
        primaryId: c.primaryId,
        serving: c.serving,
        since: iso(c.since),
        providerIds: c.providerIds,
      })),
      switches: failover.switches.map((s) => ({
        primaryId: s.primaryId,
        from: s.from,
        to: s.to,
        at: new Date(s.at).toISOString(),
      })),
      attribution: failover.attribution.map((a) => ({
        providerId: a.providerId,
        serves: a.serves,
        lastServedAt: iso(a.lastServedAt),
      })),
    };
  }

  async function checkHeartbeat(
    redisReachable: boolean,
  ): Promise<AdminHealthResponse['components']['queues']['heartbeat']> {
    // Redis outage is already reported by the Redis component; don't double-fault.
    if (!redisReachable) return { status: 'ok', ageSeconds: null };
    try {
      const last = await redis.get(HEARTBEAT_LAST_KEY);
      // No key yet: a fresh deploy where the worker hasn't ticked — not a fault
      // in itself (age unknown), so it stays `ok` rather than perpetually
      // degrading the page before the first heartbeat lands.
      if (!last) return { status: 'ok', ageSeconds: null };
      const ageMs = Math.max(0, now() - Date.parse(last));
      const ageSeconds = Math.round(ageMs / 1000);
      // A heartbeat that WAS seen but has gone stale means the worker stalled —
      // a soft, degraded signal.
      return { status: ageMs > HEARTBEAT_STALE_MS ? 'degraded' : 'ok', ageSeconds };
    } catch {
      return { status: 'ok', ageSeconds: null };
    }
  }

  async function checkQueues(
    redisReachable: boolean,
  ): Promise<AdminHealthResponse['components']['queues']> {
    const heartbeat = await checkHeartbeat(redisReachable);
    if (!queues) {
      // This process holds no queue registry (e.g. tests, or an API without the
      // worker's Redis-backed queues): not a fault, just nothing to report.
      return { status: heartbeat.status, available: false, depths: [], heartbeat };
    }
    try {
      const depths: AdminHealthQueueDepth[] = await Promise.all(
        ALL_QUEUE_NAMES.map(async (name) => {
          const counts = await queues
            .get(name)
            .getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
          return {
            name,
            waiting: counts.waiting ?? 0,
            active: counts.active ?? 0,
            delayed: counts.delayed ?? 0,
            failed: counts.failed ?? 0,
            completed: counts.completed ?? 0,
          };
        }),
      );
      return { status: heartbeat.status, available: true, depths, heartbeat };
    } catch {
      // Reachable registry but the count read failed (usually a Redis blip that
      // checkRedis already surfaced): report the job system as degraded.
      return { status: 'degraded', available: true, depths: [], heartbeat };
    }
  }

  function checkGateway(): AdminHealthResponse['components']['gateway'] {
    return {
      status: 'ok',
      enabled: config.realtime.enabled,
      attached: gateway.isAttached(),
      connections: gateway.connectionCount(),
    };
  }

  return {
    async check(): Promise<AdminHealthResponse> {
      const [database, redisComponent] = await Promise.all([checkDatabase(), checkRedis()]);
      const providers = checkProviders();
      const queuesComponent = await checkQueues(redisComponent.status !== 'down');
      const gatewayComponent = checkGateway();

      // Overall verdict: the database is the system of record, so a down DB is a
      // hard `down`. Every other fault — a stopped Redis, an open breaker, a
      // stale heartbeat — still serves the surface, so it reads `degraded`, not
      // `down` (the "stopped Redis reflects as degraded" acceptance, §13.4 P5a).
      const componentStatuses: HealthStatus[] = [
        redisComponent.status,
        providers.status,
        queuesComponent.status,
        gatewayComponent.status,
      ];
      const overall: HealthStatus =
        database.status === 'down'
          ? 'down'
          : componentStatuses.some((s) => s !== 'ok')
            ? 'degraded'
            : 'ok';

      return {
        status: overall,
        version: API_VERSION,
        uptimeSeconds: process.uptime(),
        checkedAt: new Date().toISOString(),
        components: {
          database,
          redis: redisComponent,
          providers,
          queues: queuesComponent,
          gateway: gatewayComponent,
        },
      };
    },
  };
}
