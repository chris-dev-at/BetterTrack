import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';

import { createBullBoardRouter } from './http/bullBoard';
import { createErrorHandler } from './http/errorHandler';
import { healthRouter } from './http/healthRouter';
import { versionRouter } from './http/versionRouter';
import { loadBearerAuth, enforceApiKeyScope } from './http/middleware/bearerAuth';
import { createCorsMiddleware } from './http/middleware/cors';
import { createCsrfGuard } from './http/middleware/csrf';
import { createMetricsMiddleware } from './http/middleware/metrics';
import { createUsageCaptureMiddleware } from './http/middleware/usageCapture';
import { createRateLimiters } from './http/middleware/rateLimit';
import { enforcePasswordChange, loadSession, requireAdmin } from './http/middleware/session';
import { createOpenApiRouter } from './http/openapi';
import { createAccountRouter } from './http/routes/accountRoutes';
import { createAdminRouter } from './http/routes/adminRoutes';
import { createAlertsRouter } from './http/routes/alertsRoutes';
import { createAnalyticsRouter } from './http/routes/analyticsRoutes';
import { createAssetsRouter } from './http/routes/assetsRoutes';
import { createAuthRouter } from './http/routes/authRoutes';
import { createBacktestRouter } from './http/routes/backtestRoutes';
import { createChatRouter } from './http/routes/chatRoutes';
import { createConglomerateRouter } from './http/routes/conglomerateRoutes';
import { createIdeasRouter } from './http/routes/ideasRoutes';
import { createImportsRouter } from './http/routes/importsRoutes';
import { createCustomAssetsRouter } from './http/routes/customAssetsRoutes';
import { createNotificationsRouter } from './http/routes/notificationsRoutes';
import { createOAuthPublicRouter, createOAuthRouter } from './http/routes/oauthRoutes';
import { createPortfolioRouter } from './http/routes/portfolioRoutes';
import { createSearchRouter } from './http/routes/searchRoutes';
import { createSettingsRouter } from './http/routes/settingsRoutes';
import { createSocialRouter } from './http/routes/socialRoutes';
import { createWorkboardRouter } from './http/routes/workboardRoutes';
import type { AppContext } from './http/context';

// Side-effect import: augments Express's Request type (req.authUser, etc.).
import './http/types';

/**
 * Builds the Express application from a wired context. Kept separate from
 * `server.ts` (and the test harness) so the app can be mounted without binding
 * a port or real infrastructure.
 */
export function createApp(ctx: AppContext) {
  const app = express();
  app.set('trust proxy', ctx.config.isProduction ? 1 : false);
  app.disable('x-powered-by');

  // HTTP instrumentation (§13.5 V5-P2): first in the chain so every request —
  // including CORS preflight and 404s — is counted and timed. It adds no route;
  // the metrics registry is scraped only through the separate localhost/LAN
  // listener started in server.ts, never from this public app.
  app.use(createMetricsMiddleware());

  app.use(helmet());
  // Credentialed CORS first, so preflight (OPTIONS) short-circuits before any
  // session/rate-limit work and cross-origin web/admin callers get their headers
  // (§4.6, §10). The allowlist is the derived web+admin origins.
  app.use(createCorsMiddleware(ctx.config.corsOrigins));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser(ctx.config.sessionSecrets));

  // Public API docs (§5 Meta, §6.13): mounted at the origin root, BEFORE the
  // /api/v1 session/CSRF/password-change chain, so `GET /openapi.json` and
  // `GET /docs` are reachable with no session. The API itself stays guarded.
  app.use(createOpenApiRouter());

  // Public deploy-verification marker (§5 Meta): which commit is live. Mounted
  // in the public-meta zone alongside the docs, BEFORE the /api/v1 bearer/
  // session/rate-limit/CSRF chain below, so anyone (human or script, no auth)
  // can read GET /api/v1/version without a session, without a CSRF header, and
  // without spending the API rate limit. Only `/version` matches; every other
  // /api/v1 path falls through to the guarded chain.
  app.use('/api/v1', versionRouter);

  const limiters = createRateLimiters(ctx);

  // Order: bearer (API-key) auth → cookie session → general rate limit (per
  // user) → per-key rate limit (bearer only) → CSRF guard (skipped for bearer)
  // → forced-password-change guard → API-key scope enforcement. Bearer runs
  // first so a `Authorization: Bearer btk_…` request resolves its principal and
  // the cookie path stands down; the scope guard runs last so it sees the
  // resolved principal and covers every /api/v1 router by default (§6.13).
  app.use('/api/v1', loadBearerAuth(ctx));
  app.use('/api/v1', loadSession(ctx));
  app.use('/api/v1', limiters.general);
  app.use('/api/v1', limiters.apiKey);
  // The OAuth token endpoint is machine-to-machine (a partner backend, no cookie
  // and no bearer): mount it BEFORE the CSRF guard so it stays public, but AFTER
  // the general limiter so it is still rate-limited (by IP for anonymous callers).
  // Non-`/token` paths fall through to the session chain + the consent router.
  app.use('/api/v1/oauth', createOAuthPublicRouter(ctx));
  app.use('/api/v1', createCsrfGuard(ctx.config.corsOrigins));
  app.use('/api/v1', enforcePasswordChange);
  app.use('/api/v1', enforceApiKeyScope(ctx));

  // First-party usage capture (§13.5 V5-P2 arc (b)): folds one in-memory signal
  // per authenticated request on `finish` (no route, no third-party tracker).
  // Mounted after the auth chain so `req.authUser` is resolved for the capture.
  app.use('/api/v1', createUsageCaptureMiddleware(ctx.usageAnalytics));

  app.use('/api/v1', healthRouter);
  app.use('/api/v1/auth', createAuthRouter(ctx, limiters));
  app.use('/api/v1/account', createAccountRouter(ctx, limiters));
  // bull-board queue inspector (§13.4 V4-P5a), mounted admin-only and BEFORE the
  // admin router so `/api/v1/admin/queues` resolves here (a non-admin/anonymous
  // request 404s at requireAdmin — §6.12 no-leak). Mounted at the app root rather
  // than inside the admin router because it is itself a sub-router; the OpenAPI
  // coverage gate's route walker only recurses one level of app-level mounts.
  app.use('/api/v1/admin/queues', requireAdmin, createBullBoardRouter(ctx.queues));
  app.use('/api/v1/admin', createAdminRouter(ctx, limiters));
  app.use('/api/v1/workboard', createWorkboardRouter(ctx));
  app.use('/api/v1/search', createSearchRouter(ctx, limiters));
  app.use('/api/v1/assets', createAssetsRouter(ctx));
  app.use('/api/v1/portfolios', createPortfolioRouter(ctx));
  app.use('/api/v1/custom-assets', createCustomAssetsRouter(ctx));
  app.use('/api/v1/conglomerates', createConglomerateRouter(ctx));
  app.use('/api/v1/backtest', createBacktestRouter(ctx));
  app.use('/api/v1/ideas', createIdeasRouter(ctx));
  app.use('/api/v1/imports', createImportsRouter(ctx));
  app.use('/api/v1/analytics', createAnalyticsRouter(ctx));
  app.use('/api/v1/social', createSocialRouter(ctx, limiters));
  app.use('/api/v1/chat', createChatRouter(ctx));
  app.use('/api/v1/notifications', createNotificationsRouter(ctx));
  app.use('/api/v1/alerts', createAlertsRouter(ctx));
  app.use('/api/v1/settings', createSettingsRouter(ctx));
  // Session-authenticated OAuth consent endpoints (authorize + authorization-
  // details). The public /oauth/token router above already handled its path.
  app.use('/api/v1/oauth', createOAuthRouter(ctx));

  // Unexpected 500s are reported to error tracking (§13.4 V4-P5a) AND captured
  // onto the admin Problems page (§13.5 V5-P2 arc (d), the Sentry replacement):
  // the Sentry hook is a no-op when disabled, the DB capture always runs with
  // zero configuration. Expected ApiError/ZodError outcomes are never reported.
  app.use(
    createErrorHandler(ctx.logger, (err) => {
      ctx.observability.captureException(err);
      ctx.problems.captureError(err);
    }),
  );
  return app;
}
