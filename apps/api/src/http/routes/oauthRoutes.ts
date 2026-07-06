import { Router } from 'express';

import {
  oauthApproveRequestSchema,
  oauthAuthorizationDetailsQuerySchema,
  oauthTokenRequestSchema,
  type OAuthApproveRequest,
  type OAuthAuthorizationDetailsQuery,
  type OAuthTokenRequest,
} from '@bettertrack/contracts';

import { requireUser } from '../middleware/session';
import { validateBody, validateQuery } from '../middleware/validate';
import type { AppContext } from '../context';

/**
 * OAuth 2.0 authorize + token endpoints (PROJECTPLAN.md §6.13, V2-P12).
 *
 * The token endpoint is machine-to-machine (a partner's backend) and carries no
 * cookie — it is mounted BEFORE the session/CSRF chain in app.ts via
 * {@link createOAuthPublicRouter} so it stays fully public. The authorize/consent
 * endpoints are served on the user origin with the standard session (the PIN
 * gate applies to the consent UI like any page) via {@link createOAuthRouter}.
 */

/** Public token exchange — mounted pre-CSRF (no cookie, no session). */
export function createOAuthPublicRouter(ctx: AppContext): Router {
  const router = Router();

  // POST /oauth/token — authorization_code or refresh_token grant.
  router.post('/token', validateBody(oauthTokenRequestSchema), async (req, res) => {
    const body = req.valid?.body as OAuthTokenRequest;
    const tokens = await ctx.oauth.exchangeToken({ body, ip: req.ip ?? null });
    // No-store per RFC 6749 §5.1 — tokens must never be cached.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.json(tokens);
  });

  return router;
}

/** Session-authenticated consent endpoints (user origin). */
export function createOAuthRouter(ctx: AppContext): Router {
  const router = Router();

  router.use(requireUser);

  // GET /oauth/authorization-details — the consent screen reads the validated
  // authorize request (app name + plain-language scopes) to render itself.
  router.get(
    '/authorization-details',
    validateQuery(oauthAuthorizationDetailsQuerySchema),
    async (req, res) => {
      const query = req.valid?.query as OAuthAuthorizationDetailsQuery;
      const details = await ctx.oauth.getAuthorizationDetails(query);
      res.json(details);
    },
  );

  // POST /oauth/authorize — the user approved: mint a single-use code and return
  // where to send the browser (the registered redirect URI with ?code=&state=).
  router.post('/authorize', validateBody(oauthApproveRequestSchema), async (req, res) => {
    const body = req.valid?.body as OAuthApproveRequest;
    const result = await ctx.oauth.approve({ userId: req.authUser!.id, body, ip: req.ip ?? null });
    res.json(result);
  });

  return router;
}
