import { get as httpGet, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../config/env';
import { createLogger } from '../logger';
import {
  cacheEventsTotal,
  createMetricsServer,
  httpRequestsTotal,
  jobOutcomesTotal,
  providerCallsTotal,
  renderMetrics,
} from '../metrics';
import { createStubMarketData } from '../testing/marketDataStubs';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * V5-P2 arc (a), API side (issue #564): the Prometheus registry exposes default
 * process metrics + the custom app metrics; the public `/api/v1` surface carries
 * NO metrics route; an instrumented request bumps the HTTP counter; and the
 * dedicated localhost-bound listener serves `/metrics` only, gated by the env
 * flag (disabled ⇒ binds no port).
 */

const BASE_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://test',
  REDIS_URL: 'redis://test',
  SESSION_SECRET: 'test-session-secret-please-change-0123456789',
};

/** GET a URL and resolve with status + body text. */
function fetchText(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    httpGet(url, (res: IncomingMessage) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    }).on('error', reject);
  });
}

/**
 * Sum of every exposition sample whose line starts with `metric` and contains
 * all `labels` substrings — order-independent (prom-client's label ordering is
 * not part of its contract).
 */
function metricValue(text: string, metric: string, labels: string[]): number {
  return text
    .split('\n')
    .filter((l) => l.startsWith(metric) && labels.every((label) => l.includes(label)))
    .reduce((sum, l) => {
      const value = Number(l.slice(l.lastIndexOf(' ') + 1));
      return Number.isFinite(value) ? sum + value : sum;
    }, 0);
}

describe('metrics registry', () => {
  it('renders default process metrics + the custom app metrics', async () => {
    // Touch every custom metric so its series is materialised in the exposition.
    httpRequestsTotal.inc({ method: 'GET', route: '/probe', status: '200' });
    jobOutcomesTotal.inc({ queue: 'q', outcome: 'completed' });
    providerCallsTotal.inc({ provider: 'yahoo', outcome: 'success' });
    cacheEventsTotal.inc({ result: 'hit' });

    const text = await renderMetrics();

    expect(text).toContain('bettertrack_http_requests_total');
    expect(text).toContain('bettertrack_http_request_duration_seconds');
    expect(text).toContain('bettertrack_queue_depth');
    expect(text).toContain('bettertrack_job_outcomes_total');
    expect(text).toContain('bettertrack_provider_calls_total');
    expect(text).toContain('bettertrack_market_cache_events_total');
    expect(text).toContain('bettertrack_websocket_connections');
  });
});

describe('metrics on the public app', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestApp({ marketData: createStubMarketData() });
  });

  it('exposes no metrics route on the public API', async () => {
    const a = await request(harness.app).get('/metrics');
    const b = await request(harness.app).get('/api/v1/metrics');
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
  });

  it('increments the HTTP request counter when an endpoint is hit', async () => {
    const labels = ['method="GET"', 'route="/api/v1/version"', 'status="200"'];
    const before = metricValue(await renderMetrics(), 'bettertrack_http_requests_total', labels);

    const res = await request(harness.app).get('/api/v1/version');
    expect(res.status).toBe(200);

    // The counter is bumped from the response `finish` event; yield one macrotask
    // so that listener has certainly run before we scrape.
    await new Promise((resolve) => setImmediate(resolve));
    const after = metricValue(await renderMetrics(), 'bettertrack_http_requests_total', labels);
    expect(after).toBeGreaterThan(before);
  });
});

describe('metrics listener', () => {
  const logger = createLogger(loadConfig(BASE_ENV));
  let servers: Array<ReturnType<typeof createMetricsServer>> = [];

  afterEach(async () => {
    await Promise.all(
      servers.filter(Boolean).map((s) => new Promise<void>((resolve) => s!.close(() => resolve()))),
    );
    servers = [];
  });

  it('binds no port and returns null when disabled', () => {
    const config = loadConfig({ ...BASE_ENV, BT_METRICS_ENABLED: 'false' });
    expect(config.metrics.enabled).toBe(false);
    const server = createMetricsServer(config, logger);
    expect(server).toBeNull();
  });

  it('serves /metrics from a dedicated listener and 404s everything else', async () => {
    // Port 0 → the OS assigns a free ephemeral port (no collision with peers).
    const base = loadConfig(BASE_ENV);
    const config = { ...base, metrics: { ...base.metrics, port: 0 } };
    expect(config.metrics.enabled).toBe(true);
    expect(config.metrics.host).toBe('127.0.0.1');

    const server = createMetricsServer(config, logger);
    servers.push(server);
    expect(server).not.toBeNull();
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const { port } = server!.address() as AddressInfo;

    const metrics = await fetchText(`http://127.0.0.1:${port}/metrics`);
    expect(metrics.status).toBe(200);
    expect(metrics.body).toContain('bettertrack_http_requests_total');
    // Default process metrics are live only once the endpoint is enabled.
    expect(metrics.body).toContain('process_cpu_user_seconds_total');

    const other = await fetchText(`http://127.0.0.1:${port}/`);
    expect(other.status).toBe(404);
  });
});
