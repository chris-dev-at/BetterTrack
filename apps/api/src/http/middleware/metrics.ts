import type { Request, RequestHandler } from 'express';

import { httpRequestDurationSeconds, httpRequestsTotal } from '../../metrics';

/**
 * Derive a LOW-cardinality route label. Express only populates `req.route` once
 * a handler matches, so this is read on `finish`; the mounted router prefix is
 * `req.baseUrl` and the matched pattern is `req.route.path` (parameterised, e.g.
 * `/:id`, never the concrete id). Unmatched requests (404s) carry no route, so
 * they collapse to a single `unmatched` series rather than leaking raw URLs.
 */
function routeLabel(req: Request): string {
  const routePath = req.route?.path;
  if (typeof routePath === 'string') {
    return `${req.baseUrl}${routePath}` || '/';
  }
  return req.baseUrl || 'unmatched';
}

/**
 * HTTP instrumentation (PROJECTPLAN.md §13.5 V5-P2 arc (a)): a request counter
 * and a latency histogram, labelled by method/route/status, feeding the metrics
 * registry. This is plain middleware — it adds NO route, so the public app
 * still exposes no `/metrics` path; the registry is scraped only through the
 * separate localhost/LAN listener.
 */
export function createMetricsMiddleware(): RequestHandler {
  return (req, res, next) => {
    const endTimer = httpRequestDurationSeconds.startTimer();
    res.on('finish', () => {
      const labels = {
        method: req.method,
        route: routeLabel(req),
        status: String(res.statusCode),
      };
      endTimer(labels);
      httpRequestsTotal.inc(labels);
    });
    next();
  };
}
