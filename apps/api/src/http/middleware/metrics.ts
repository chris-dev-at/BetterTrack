import type { Request, RequestHandler } from 'express';

import { httpRequestDurationSeconds, httpRequestsTotal } from '../../metrics';
import { requestRouteTemplate } from '../errorHandler';

/**
 * Derive a LOW-cardinality route label. Express only populates `req.route` once
 * a handler matches, so this is read on `finish`.
 *
 * The prefix is NOT `req.baseUrl`: the router rewinds it on the `next(err)`
 * unwind — before the response, and therefore before `finish` — so composing
 * `baseUrl + route.path` labelled every error response with the bare matched
 * pattern (`/:id`) while its 200s carried the full template. Error-rate-by-route
 * was then uncomputable on exactly the panel that exists to answer "which
 * endpoint is 500-ing". {@link requestRouteTemplate} reconstructs the prefix
 * from `req.originalUrl` instead (id segments masked) and is correct on both
 * paths. Unmatched requests (404s) carry no route, so they still collapse to a
 * single `unmatched` series rather than opening the label set to raw URLs.
 */
function routeLabel(req: Request): string {
  if (typeof req.route?.path !== 'string') return req.baseUrl || 'unmatched';
  return requestRouteTemplate(req);
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
