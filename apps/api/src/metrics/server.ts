import { createServer, type Server } from 'node:http';

import type { AppConfig } from '../config/env';
import type { Logger } from '../logger';

import { metricsContentType, renderMetrics, startDefaultMetrics } from './registry';

/**
 * The dedicated Prometheus scrape listener (PROJECTPLAN.md §13.5 V5-P2, §16
 * 2026-07-17). Serves `GET /metrics` in text exposition format on its OWN
 * HTTP server bound to `config.metrics.host` (default `127.0.0.1`, configurable
 * to a LAN interface) — deliberately NOT mounted on the public `/api/v1`
 * surface, so the endpoint is unreachable from public origins.
 *
 * Returns `null` when metrics are disabled: the process then boots identically
 * and binds no metrics port at all.
 */
export function createMetricsServer(config: AppConfig, logger: Logger): Server | null {
  if (!config.metrics.enabled) {
    logger.info('metrics endpoint disabled (BT_METRICS_ENABLED=false)');
    return null;
  }

  // Default process metrics only start once the endpoint is actually enabled.
  startDefaultMetrics();

  const server = createServer((req, res) => {
    // Only GET /metrics is served; everything else 404s. Strip any query string.
    const path = (req.url ?? '').split('?')[0];
    if (req.method !== 'GET' || path !== '/metrics') {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Not found');
      return;
    }
    renderMetrics()
      .then((body) => {
        res.statusCode = 200;
        res.setHeader('Content-Type', metricsContentType);
        res.end(body);
      })
      .catch((err: unknown) => {
        logger.error({ err }, 'failed to render metrics');
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('metrics collection failed');
      });
  });

  server.listen(config.metrics.port, config.metrics.host, () => {
    logger.info(
      { host: config.metrics.host, port: config.metrics.port },
      'metrics endpoint listening (localhost/LAN only)',
    );
  });

  return server;
}
