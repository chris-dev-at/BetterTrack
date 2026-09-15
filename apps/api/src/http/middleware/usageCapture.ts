import type { Request, RequestHandler } from 'express';

import type { UsageAnalyticsService } from '../../services/analytics/usageAnalyticsService';
import {
  isVaultSensitiveUnattributedAssetRequest,
  vaultedPortfolioTargetForRequest,
  type VaultedPortfolioGuard,
} from '../../services/account/vaultedPortfolioEnforcement';

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
 * not captured. The asset a request concerned is recorded only where the
 * router's `:id` really is an asset id, feeding the "top assets" panel.
 *
 * FIRST-PARTY means a human on our own client: a request carrying `req.apiKey`
 * — a personal API key or a third-party OAuth grant (§6.13) — is a program, and
 * it is never captured (#1847). A bot polling `GET /portfolios` every minute
 * otherwise pinned its owner into DAU/WAU/MAU forever, drove the feature
 * counters at its own poll rate, and wrote the LIFETIME `usage_activations`
 * marker for an account no human had ever used.
 */

/** What one router segment (`/api/v1/<segment>`) contributes to the telemetry. */
export interface UsageSegmentClassification {
  /** The coarse feature bucket the segment's traffic collapses onto. */
  readonly feature: string;
  /**
   * Whether a matched `:id` on this router is recorded as the request's ASSET
   * id. True only where that param really is an asset — the feature bucket is
   * not the test: `search` shares the `assets` bucket and records nothing.
   *
   * Every id-recording segment must also be vault-sensitive per
   * {@link isVaultSensitiveUnattributedAssetRequest}, since a recorded id with
   * no portfolio attribution is exactly what reconstructs a holdings roster.
   * `usageAnalytics.test.ts` enumerates this table and pins that.
   */
  readonly recordsAssetId?: true;
}

/** Router segment (`/api/v1/<segment>`) → what its traffic records. */
export const FEATURE_BY_SEGMENT: Record<string, UsageSegmentClassification> = {
  portfolios: { feature: 'portfolio' },
  workboard: { feature: 'workboard' },
  conglomerates: { feature: 'workboard' },
  backtest: { feature: 'workboard' },
  ideas: { feature: 'workboard' },
  assets: { feature: 'assets', recordsAssetId: true },
  search: { feature: 'assets' },
  'custom-assets': { feature: 'assets', recordsAssetId: true },
  social: { feature: 'social' },
  chat: { feature: 'social' },
  notifications: { feature: 'social' },
  alerts: { feature: 'alerts' },
  analytics: { feature: 'analytics' },
  imports: { feature: 'imports' },
  settings: { feature: 'settings' },
};

/** The `/api/v1/<segment>` router segment from the matched mount. */
function segmentOf(req: Request): string | null {
  // `req.baseUrl` is the mounted router prefix, e.g. `/api/v1/portfolios`.
  const parts = req.baseUrl.split('/').filter(Boolean);
  // ['api', 'v1', '<segment>', ...]
  if (parts[0] !== 'api' || parts[1] !== 'v1') return null;
  return parts[2] ?? null;
}

export function createUsageCaptureMiddleware(
  usage: UsageAnalyticsService,
  vaulted: Pick<VaultedPortfolioGuard, 'isOwnedPortfolioVaulted' | 'userOwnsVaultedPortfolio'>,
): RequestHandler {
  return (req, res, next) => {
    const user = req.authUser;
    const target = vaultedPortfolioTargetForRequest({
      method: req.method,
      path: req.originalUrl,
      params: req.params,
      query: req.query,
      body: req.body,
      valid: req.valid,
    });
    const unattributedAssetRequest = isVaultSensitiveUnattributedAssetRequest(req.originalUrl);
    const suppression = (async (): Promise<boolean> => {
      // The legacy v1 rail remains blanket-suppressed until E9 removes the
      // account column. A normal user that owns a v2 vault is decided below per
      // target; vault presence alone is not an account kill.
      if (!user || user.privacyMode === 'paranoid') return true;
      // A bearer principal is dropped on `finish` regardless, so do not spend a
      // vault lookup deciding how to record traffic that is never recorded.
      if (req.apiKey) return true;
      if (target) return vaulted.isOwnedPortfolioVaulted(user.id, target.portfolioId);
      // Per-asset routes contain no portfolio attribution. When the account
      // owns any vault, recording the requested ids can reconstruct its local
      // holdings roster; fail closed for this telemetry branch.
      if (unattributedAssetRequest) return vaulted.userOwnsVaultedPortfolio(user.id);
      return false;
    })().catch(() => true);

    res.on('finish', () => {
      void suppression.then((suppressed) => {
        // Only successful, authenticated first-party traffic counts as usage.
        // `req.apiKey` is the discriminator every other bearer-aware surface
        // uses (rate limiting, the settings routes); its presence means the
        // caller is a token, not a person.
        if (!req.authUser || req.apiKey || res.statusCode >= 400 || suppressed) return;
        // A legacy paranoid account is NEVER captured (§13.5 V5-P13 arc b). Its client
        // values the portfolio locally, which means one `GET /assets/:id/quote`
        // per holding per day — capturing those wrote the account's complete
        // holdings ROSTER into `usage_events`, keyed to its user id, every day.
        // The whole signal is dropped rather than just the asset id: a bare
        // `feature='assets'` row still folds a `hits` counter that tracks how many
        // holdings were priced, and `usage_events` feeds analytics only (DAU/WAU/
        // MAU, feature counters, top assets) — no rate limit or quota reads it, so
        // there is no accounting left to preserve. `privacyMode` is refreshed from
        // the user row on every authenticated request by `toAuthUser`, and all
        // three principals (cookie session, personal API key, OAuth grant) build
        // `authUser` through it, so the bearer paths are covered here too.
        const segment = segmentOf(req);
        if (!segment) return;
        const classification = FEATURE_BY_SEGMENT[segment];
        if (!classification) return;
        // Whether an id is recorded is the SEGMENT's property, not the feature
        // bucket's: `custom-assets` shares the `assets` bucket but its ids are
        // the user's own private objects, and folding on the bucket recorded
        // them for a vaulted account too (#1896).
        const assetId =
          classification.recordsAssetId && typeof req.params?.id === 'string'
            ? req.params.id
            : null;
        usage.capture({
          userId: req.authUser.id,
          feature: classification.feature,
          assetId,
          targetPortfolioId: target?.portfolioId,
          suppressIfAnyVault: unattributedAssetRequest,
        });
      });
    });
    next();
  };
}
