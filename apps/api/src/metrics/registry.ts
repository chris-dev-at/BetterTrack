import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus metrics registry (PROJECTPLAN.md §13.5 V5-P2 arc (a)).
 *
 * A DEDICATED registry — never prom-client's global default — so importing this
 * module has no hidden global side effects and tests can render it in isolation.
 * The metric objects are module singletons: the natural instrumentation points
 * (HTTP middleware, circuit breaker, market cache, BullMQ workers, the realtime
 * gateway) `.inc()`/`.observe()` them directly, no DI threading required.
 *
 * Every series is prefixed `bettertrack_`. The endpoint that serves this
 * registry ({@link ../metrics/server}) is bound to localhost/LAN only — it is
 * NEVER mounted on the public `/api/v1` surface (the plan's "unreachable from
 * public origins" mandate, §16 2026-07-17).
 */
export const metricsRegistry = new Registry();

/** Total HTTP requests handled by the public API, by method/route/status. */
export const httpRequestsTotal = new Counter({
  name: 'bettertrack_http_requests_total',
  help: 'Total HTTP requests handled by the public API.',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [metricsRegistry],
});

/** HTTP request latency in seconds, by method/route/status. */
export const httpRequestDurationSeconds = new Histogram({
  name: 'bettertrack_http_request_duration_seconds',
  help: 'HTTP request latency in seconds.',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

/** One queue's job counts, as returned by the per-state sampler below. */
export interface QueueDepthSample {
  queue: string;
  state: string;
  value: number;
}

// Live samplers bound at boot (see the setters below), read on every scrape by
// each gauge's `collect` hook so the numbers are always current without a
// background timer. `null` until bound / after detach.
let queueDepthSampler: (() => Promise<QueueDepthSample[]>) | null = null;
let websocketSampler: (() => number) | null = null;

/** Jobs waiting/active/delayed/failed per BullMQ queue (sampled on scrape). */
export const queueDepth = new Gauge({
  name: 'bettertrack_queue_depth',
  help: 'Number of jobs per BullMQ queue and state.',
  labelNames: ['queue', 'state'] as const,
  registers: [metricsRegistry],
  async collect() {
    if (!queueDepthSampler) return;
    this.reset();
    for (const { queue, state, value } of await queueDepthSampler()) {
      this.set({ queue, state }, value);
    }
  },
});

/** BullMQ job outcomes per queue (`completed` / `failed`). */
export const jobOutcomesTotal = new Counter({
  name: 'bettertrack_job_outcomes_total',
  help: 'BullMQ job outcomes per queue.',
  labelNames: ['queue', 'outcome'] as const,
  registers: [metricsRegistry],
});

/** Market-data provider calls, by provider and outcome. */
export const providerCallsTotal = new Counter({
  name: 'bettertrack_provider_calls_total',
  help: 'Market-data provider calls by provider and outcome.',
  labelNames: ['provider', 'outcome'] as const,
  registers: [metricsRegistry],
});

/** Market-cache lookups, by result (`hit` / `miss` / `stale` / `negative`). */
export const cacheEventsTotal = new Counter({
  name: 'bettertrack_market_cache_events_total',
  help: 'Market cache lookups by result.',
  labelNames: ['result'] as const,
  registers: [metricsRegistry],
});

/** Currently connected realtime websockets (sampled on scrape). */
export const websocketConnections = new Gauge({
  name: 'bettertrack_websocket_connections',
  help: 'Currently connected realtime websockets.',
  registers: [metricsRegistry],
  collect() {
    if (websocketSampler) this.set(websocketSampler());
  },
});

let defaultsStarted = false;

/**
 * Register default process metrics (event-loop lag, heap, GC, …) on the
 * registry. Idempotent — prom-client throws on a duplicate registration, so the
 * guard makes a second call (e.g. a test importing this alongside boot) a no-op.
 */
export function startDefaultMetrics(): void {
  if (defaultsStarted) return;
  defaultsStarted = true;
  collectDefaultMetrics({ register: metricsRegistry });
}

/** Prometheus text exposition of the whole registry. */
export function renderMetrics(): Promise<string> {
  return metricsRegistry.metrics();
}

/** The `Content-Type` Prometheus expects for the exposition above. */
export const metricsContentType = metricsRegistry.contentType;

/**
 * Bind the queue-depth gauge to a live sampler (BullMQ `getJobCounts`), invoked
 * lazily on every scrape so the gauge always reflects the current backlog
 * without a background timer. Pass `null` to detach.
 */
export function setQueueDepthCollector(sample: (() => Promise<QueueDepthSample[]>) | null): void {
  queueDepthSampler = sample;
}

/**
 * Bind the websocket gauge to the gateway's live connection count, sampled on
 * every scrape. Pass `null` to detach.
 */
export function setWebsocketGauge(sample: (() => number) | null): void {
  websocketSampler = sample;
}
