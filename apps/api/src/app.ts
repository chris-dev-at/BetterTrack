import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';

import { createErrorHandler } from './http/errorHandler';
import { healthRouter } from './http/healthRouter';
import { createCorsMiddleware } from './http/middleware/cors';
import { createCsrfGuard } from './http/middleware/csrf';
import { createRateLimiters } from './http/middleware/rateLimit';
import { enforcePasswordChange, loadSession } from './http/middleware/session';
import { createOpenApiRouter } from './http/openapi';
import { createAdminRouter } from './http/routes/adminRoutes';
import { createAssetsRouter } from './http/routes/assetsRoutes';
import { createAuthRouter } from './http/routes/authRoutes';
import { createBacktestRouter } from './http/routes/backtestRoutes';
import { createConglomerateRouter } from './http/routes/conglomerateRoutes';
import { createCustomAssetsRouter } from './http/routes/customAssetsRoutes';
import { createNotificationsRouter } from './http/routes/notificationsRoutes';
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

  const limiters = createRateLimiters(ctx);

  // Order: resolve session → general rate limit (keyed by user) → CSRF guard →
  // forced-password-change guard. The last is global with an explicit
  // allowlist, so any future /api/v1 router is covered without opting in.
  app.use('/api/v1', loadSession(ctx));
  app.use('/api/v1', limiters.general);
  app.use('/api/v1', createCsrfGuard(ctx.config.corsOrigins));
  app.use('/api/v1', enforcePasswordChange);

  app.use('/api/v1', healthRouter);
  app.use('/api/v1/auth', createAuthRouter(ctx, limiters));
  app.use('/api/v1/admin', createAdminRouter(ctx, limiters));
  app.use('/api/v1/workboard', createWorkboardRouter(ctx));
  app.use('/api/v1/search', createSearchRouter(ctx, limiters));
  app.use('/api/v1/assets', createAssetsRouter(ctx));
  app.use('/api/v1/portfolios', createPortfolioRouter(ctx));
  app.use('/api/v1/custom-assets', createCustomAssetsRouter(ctx));
  app.use('/api/v1/conglomerates', createConglomerateRouter(ctx));
  app.use('/api/v1/backtest', createBacktestRouter(ctx));
  app.use('/api/v1/social', createSocialRouter(ctx, limiters));
  app.use('/api/v1/notifications', createNotificationsRouter(ctx));
  app.use('/api/v1/settings', createSettingsRouter(ctx));

  app.use(createErrorHandler(ctx.logger));
  return app;
}
