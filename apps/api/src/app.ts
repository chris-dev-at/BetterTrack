import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';

import { createErrorHandler } from './http/errorHandler';
import { healthRouter } from './http/healthRouter';
import { requireCsrfHeader } from './http/middleware/csrf';
import { createRateLimiters } from './http/middleware/rateLimit';
import { enforcePasswordChange, loadSession } from './http/middleware/session';
import { createAdminRouter } from './http/routes/adminRoutes';
import { createAuthRouter } from './http/routes/authRoutes';
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
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser(ctx.config.sessionSecrets));

  const limiters = createRateLimiters(ctx);

  // Order: resolve session → general rate limit (keyed by user) → CSRF guard →
  // forced-password-change guard. The last is global with an explicit
  // allowlist, so any future /api/v1 router is covered without opting in.
  app.use('/api/v1', loadSession(ctx));
  app.use('/api/v1', limiters.general);
  app.use('/api/v1', requireCsrfHeader);
  app.use('/api/v1', enforcePasswordChange);

  app.use('/api/v1', healthRouter);
  app.use('/api/v1/auth', createAuthRouter(ctx, limiters));
  app.use('/api/v1/admin', createAdminRouter(ctx, limiters));
  app.use('/api/v1/workboard', createWorkboardRouter(ctx));

  app.use(createErrorHandler(ctx.logger));
  return app;
}
