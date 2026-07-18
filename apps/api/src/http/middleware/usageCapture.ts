import type { Request, RequestHandler } from 'express';

import type { UsageAnalyticsService } from '../../services/analytics/usageAnalyticsService';

/**
 * First-party usage capture (PROJECTPLAN.md §13.5 V5-P2 arc (b)). Plain
 * middleware — it adds NO route and sends nothing to any third party; it just
 * folds one in-memory signal per authenticated request into the usage buffer on
 * `finish`. By then the whole chain has run, so `req.authUser`, `req.baseUrl`,
 * `req.route` and `req.params` are all populated.
 *
 * Requests collapse onto a LOW-cardinality feature bucket derived from the
 * mounted router (`req.baseUrl`), so no raw path or id is ever counted as a
 * feature; unmapped surfaces (admin, auth, account, health, oauth…) are simply
 * not captured. The asset a request concerned is recorded only for asset-detail
 * reads, feeding the "top assets" panel.
 */

/** Router segment (`/api/v1/<segment>`) → the coarse feature bucket. */
const FEATURE_BY_SEGMENT: Record<string, string> = {
  portfolios: 'portfolio',
  workboard: 'workboard',
  conglomerates: 'workboard',
  backtest: 'workboard',
  ideas: 'workboard',
  assets: 'assets',
  search: 'assets',
  'custom-assets': 'assets',
  social: 'social',
  chat: 'social',
  notifications: 'social',
  alerts: 'alerts',
  analytics: 'analytics',
  imports: 'imports',
  settings: 'settings',
};

/** The `/api/v1/<segment>` router segment from the matched mount. */
function segmentOf(req: Request): string | null {
  // `req.baseUrl` is the mounted router prefix, e.g. `/api/v1/portfolios`.
  const parts = req.baseUrl.split('/').filter(Boolean);
  // ['api', 'v1', '<segment>', ...]
  if (parts[0] !== 'api' || parts[1] !== 'v1') return null;
  return parts[2] ?? null;
}

export function createUsageCaptureMiddleware(usage: UsageAnalyticsService): RequestHandler {
  return (req, res, next) => {
    res.on('finish', () => {
      // Only successful, authenticated first-party traffic counts as usage.
      if (!req.authUser || res.statusCode >= 400) return;
      const segment = segmentOf(req);
      if (!segment) return;
      const feature = FEATURE_BY_SEGMENT[segment];
      if (!feature) return;
      // Asset-detail reads carry the asset id; nothing else records an asset.
      const assetId =
        feature === 'assets' && typeof req.params?.id === 'string' ? req.params.id : null;
      usage.capture({ userId: req.authUser.id, feature, assetId });
    });
    next();
  };
}
