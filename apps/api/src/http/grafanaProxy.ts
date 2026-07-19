import type { RequestHandler } from 'express';

import type { AppContext } from './context';

/**
 * Admin-authenticated reverse proxy to Grafana (PROJECTPLAN.md §13.5 V5-P2 arc
 * (a), owner directive 2026-07-19) — the PRIMARY external-access path.
 *
 * Grafana stays bound to localhost/LAN on the server and is never routed through
 * the public web front proxy. This middleware is the ONLY public door to it: it
 * forwards requests server-side to the internal Grafana over the docker network,
 * behind the existing admin authentication. So the surface that reaches outside
 * the LAN is the already-public, already-auth-gated admin dashboard — matching
 * §13.5's "admin dashboard is the single public management surface" intent while
 * adding external reach. Prometheus is NEVER proxied (it has no auth of its own).
 *
 * Mounted at the app root (like the bull-board inspector) at
 * `/api/v1/admin/monitoring/grafana`, AFTER session load but BEFORE the CSRF
 * guard + general limiter: Grafana's own POSTs (`/api/ds/query`) carry no
 * `X-Requested-With`, and one embedded dashboard bursts dozens of requests, so
 * neither guard can sit in front. Admin auth + mandatory-2FA (applied at the
 * mount) are the boundary; the per-request exposure gate below is the switch.
 *
 * Exposure gate (all enforced by {@link MonitoringService.externalAccessEffective}):
 * the deploy opted in (`BT_OBS_EXTERNAL_ACCESS`), a usable Grafana admin password
 * is set, and the runtime kill-switch is on. Any one false ⇒ a clean 404, so an
 * un-opted-in deploy exposes nothing even to an authenticated admin.
 *
 * Grafana must be configured to serve under this sub-path and allow embedding
 * (`GF_SERVER_ROOT_URL=…/api/v1/admin/monitoring/grafana/`,
 * `GF_SERVER_SERVE_FROM_SUB_PATH=true`, `GF_SECURITY_ALLOW_EMBEDDING=true`); see
 * `docs/monitoring.md`. Because Grafana serves from the sub-path, the ORIGINAL
 * request path (prefix included) is forwarded verbatim.
 */

/** Full public base path this proxy is mounted at. */
export const GRAFANA_PROXY_BASE_PATH = '/api/v1/admin/monitoring/grafana';

/** Upstream timeout — long enough for a dashboard load, short enough to fail. */
const PROXY_TIMEOUT_MS = 15_000;

/**
 * Request headers we never forward: `host` (fetch sets it for the upstream) and
 * the hop-by-hop headers, plus the incoming length/encoding (the reconstructed
 * body sets its own).
 */
const STRIPPED_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
]);

/**
 * Response headers we never pass back: hop-by-hop, the framing blockers Grafana
 * or helmet may set (we replace them with a scoped `frame-ancestors`), and the
 * length/encoding (fetch already decoded the body, so the original encoding +
 * length no longer describe the bytes we send).
 */
const STRIPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'content-encoding',
  'x-frame-options',
  'content-security-policy',
]);

export function createGrafanaProxyMiddleware(
  ctx: AppContext,
  /** Injectable fetch (tests). Defaults to global `fetch`. */
  fetchImpl: typeof fetch = fetch,
): RequestHandler {
  const { config, monitoring, logger } = ctx;
  const upstreamBase = config.observability.grafanaInternalUrl;
  // Allow the admin (and web) SPA origins to frame the proxied Grafana document.
  // This replaces helmet's `frame-ancestors 'self'` / `X-Frame-Options` on the
  // proxied responses so the same-origin-to-the-iframe assets still load while
  // the cross-origin admin dashboard is permitted as the framing ancestor.
  const frameAncestors = ["'self'", ...config.corsOrigins].join(' ');

  return function grafanaProxy(req, res, next): void {
    void (async () => {
      // The exposure gate. Refuse with a clean 404 (no surface leak) unless the
      // deploy + password + runtime kill-switch all permit external reach.
      if (!(await monitoring.externalAccessEffective())) {
        res.status(404).json({
          error: {
            code: 'MONITORING_NOT_EXPOSED',
            message: 'Monitoring external access is not enabled.',
          },
        });
        return;
      }

      // Grafana serves from this exact sub-path, so forward the ORIGINAL path
      // (prefix + query) unchanged. `originalUrl` is untouched by the mount.
      const target = new URL(req.originalUrl, upstreamBase);

      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) continue;
        headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      // Preserve the real client identity for Grafana's logs.
      const forwardedFor = req.headers['x-forwarded-for'];
      headers.set(
        'x-forwarded-for',
        (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor) ?? req.ip ?? '',
      );

      // Body reconstruction: `express.json()` already ran on the app, so a JSON
      // body (Grafana's datasource queries) arrives parsed on `req.body`. Re-
      // serialize it; GET/HEAD and empty bodies forward none. Non-JSON upload
      // bodies are out of scope for the dashboard-view embed (see docs).
      let body: string | undefined;
      const method = req.method.toUpperCase();
      const hasBody = method !== 'GET' && method !== 'HEAD';
      if (hasBody && req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
        body = JSON.stringify(req.body);
        headers.set('content-type', 'application/json');
      }

      let upstream: Response;
      try {
        upstream = await fetchImpl(target, {
          method,
          headers,
          body,
          redirect: 'manual',
          signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
        });
      } catch (err) {
        // Grafana down/unreachable — 502 so the admin panel degrades gracefully
        // rather than the request hanging or 500-ing.
        logger.warn({ err }, 'grafana proxy upstream request failed');
        res.status(502).json({
          error: {
            code: 'MONITORING_UPSTREAM_UNAVAILABLE',
            message: 'Grafana is not reachable.',
          },
        });
        return;
      }

      res.status(upstream.status);
      upstream.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        if (STRIPPED_RESPONSE_HEADERS.has(lower)) return;
        // `Headers.forEach` comma-joins Set-Cookie, which corrupts multi-cookie
        // responses (Grafana can set several) — handle it separately below.
        if (lower === 'set-cookie') return;
        res.setHeader(key, value);
      });
      // Preserve each Set-Cookie as its own header line (undici exposes them via
      // getSetCookie()); the browser must send Grafana's cookies back verbatim.
      const setCookies = upstream.headers.getSetCookie();
      if (setCookies.length > 0) res.setHeader('Set-Cookie', setCookies);
      // Scope framing to our own SPA origins (replaces helmet's default), and be
      // explicit that the legacy header is gone.
      res.setHeader('Content-Security-Policy', `frame-ancestors ${frameAncestors}`);
      res.removeHeader('X-Frame-Options');

      const buffer = Buffer.from(await upstream.arrayBuffer());
      res.end(buffer);
    })().catch(next);
  };
}
