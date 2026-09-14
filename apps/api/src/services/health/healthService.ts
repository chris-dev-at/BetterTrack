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
import { withTimeout } from '../../providers/resilience';
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
 * probe).
 *
 * Probes fail soft AND fail fast: every I/O probe runs under
 * {@link HEALTH_PROBE_TIMEOUT_MS} (the same treatment `readinessService` gives
 * the container gate), so a dependency that never answers — a stopped Redis
 * whose command sits in the offline queue forever, a wedged connection pool —
 * marks its own component `down`/`degraded` instead of hanging the response.
 * The probes run in two concurrent waves (DB + Redis, then heartbeat + queue
 * depths, which need the Redis verdict to avoid double-faulting), so the whole
 * response is bounded by two probe budgets even when every dependency hangs.
 * One faulted component never throws the whole response.
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
  /** Per-probe timeout budget; defaults to {@link HEALTH_PROBE_TIMEOUT_MS}. */
  probeTimeoutMs?: number;
  /** Injectable clock (heartbeat freshness tests). Defaults to `Date.now`. */
  now?: () => number;
}

export interface HealthService {
  check(): Promise<AdminHealthResponse>;
}

/**
 * Budget for a single dependency probe. Matched to `READINESS_TIMEOUT_MS`: an
 * operator page must answer while the dependency it is reporting on is wedged,
 * and a dependency that cannot answer a `select 1` / `PING` inside 1.5 s is a
 * fault worth reporting either way. Bounding lives here rather than in the
 * shared Redis client (`redis.ts`) so application traffic keeps its full
 * BullMQ-compatible retry/reconnect semantics.
 */
export const HEALTH_PROBE_TIMEOUT_MS = 1_500;

/** A heartbeat older than this is treated as stale (a soft, degraded signal). */
const HEARTBEAT_STALE_MS = HEARTBEAT_INTERVAL_MS * 3;
/** A new API process tolerates one stale window for the worker's first proof. */
export const WORKER_HEARTBEAT_STARTUP_GRACE_MS = HEARTBEAT_STALE_MS;

const errorDetail = (err: unknown): string =>
  err instanceof Error ? err.name || err.message : 'error';

export function createHealthService(deps: HealthServiceDeps): HealthService {
  const { config, db, redis, marketData, queues, gateway } = deps;
  const now = deps.now ?? Date.now;
  const probeTimeoutMs = deps.probeTimeoutMs ?? HEALTH_PROBE_TIMEOUT_MS;
  const startedAtMs = now();

  /** Run one dependency read under the probe budget; a hang rejects, never waits. */
  const probe = <T>(run: () => Promise<T>): Promise<T> => withTimeout(run, probeTimeoutMs);

  async function checkDatabase(): Promise<AdminHealthComponent> {
    const started = now();
    try {
      await probe(async () => {
        await db.execute(sql`select 1`);
      });
      return { status: 'ok', latencyMs: now() - started };
    } catch (err) {
      return { status: 'down', detail: errorDetail(err) };
    }
  }

  async function checkRedis(): Promise<AdminHealthComponent> {
    const started = now();
    try {
      const pong = await probe(() => redis.ping());
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
      const last = await probe(() => redis.get(HEARTBEAT_LAST_KEY));
      // A fresh deploy gets one bounded grace window for its first scheduled
      // proof. Once that expires, a worker which never created the key must be
      // visible instead of remaining permanently healthy.
      if (!last) {
        const startupAgeMs = Math.max(0, now() - startedAtMs);
        return {
          status: startupAgeMs > WORKER_HEARTBEAT_STARTUP_GRACE_MS ? 'degraded' : 'ok',
          ageSeconds: null,
        };
      }
      const parsed = Date.parse(last);
      if (!Number.isFinite(parsed)) return { status: 'degraded', ageSeconds: null };
      const ageMs = Math.max(0, now() - parsed);
      const ageSeconds = Math.round(ageMs / 1000);
      // A heartbeat that WAS seen but has gone stale means the worker stalled —
      // a soft, degraded signal.
      return { status: ageMs > HEARTBEAT_STALE_MS ? 'degraded' : 'ok', ageSeconds };
    } catch {
      // Redis answered `PING` but refused (or never answered) this read — e.g. a
      // restart still `-LOADING` its dataset. Nothing is proving the worker
      // alive, so this is a soft fault, exactly like an unparseable value above;
      // reporting `ok` here would paint the job system green while no job runs.
      return { status: 'degraded', ageSeconds: null };
    }
  }

  async function readQueueDepths(registry: QueueRegistry): Promise<AdminHealthQueueDepth[]> {
    return await Promise.all(
      ALL_QUEUE_NAMES.map(async (name) => {
        const counts = await probe(() =>
          registry.get(name).getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed'),
        );
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
  }

  async function checkQueues(
    redisReachable: boolean,
  ): Promise<AdminHealthResponse['components']['queues']> {
    // Both reads are Redis-backed and independent: run them as one wave so the
    // component costs one probe budget, not two.
    const [heartbeat, depths] = await Promise.all([
      checkHeartbeat(redisReachable),
      // This process may hold no queue registry (e.g. tests, or an API without
      // the worker's Redis-backed queues): not a fault, just nothing to report.
      queues ? readQueueDepths(queues).catch(() => null) : Promise.resolve(null),
    ]);
    if (!queues) {
      return { status: heartbeat.status, available: false, depths: [], heartbeat };
    }
    if (!depths) {
      // Reachable registry but the count read failed or hung (usually a Redis
      // blip that checkRedis already surfaced): report the job system degraded.
      return { status: 'degraded', available: true, depths: [], heartbeat };
    }
    return { status: heartbeat.status, available: true, depths, heartbeat };
  }

  function checkGateway(): AdminHealthResponse['components']['gateway'] {
    const enabled = config.realtime.enabled;
    const attached = gateway.isAttached();
    // Realtime is an enhancement layer (§4.5): with the flag OFF an unattached
    // gateway is the expected state, not a fault. With the flag ON, a gateway
    // that never attached — `attach()` bailed early or was never reached —
    // serves no socket at all, and that is the one fault this signal exists to
    // report (§6.12). Reporting it `ok` made the component a constant.
    return {
      status: enabled && !attached ? 'down' : 'ok',
      enabled,
      attached,
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
      // stale heartbeat, a detached gateway — still serves the surface (realtime
      // degrades to the polling fallback), so it reads `degraded`, not `down`
      // (the "stopped Redis reflects as degraded" acceptance, §13.4 P5a).
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
