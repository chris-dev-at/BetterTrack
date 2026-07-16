import { Router } from 'express';

import {
  deleteAccountRequestSchema,
  exportDownloadQuerySchema,
  exportRequestSchema,
  type DeleteAccountRequest,
  type ExportDownloadQuery,
  type ExportRequest,
} from '@bettertrack/contracts';

import { clearSessionCookie } from '../cookies';
import { requireUser } from '../middleware/session';
import { validateBody, validateQuery } from '../middleware/validate';
import type { RateLimiters } from '../middleware/rateLimit';
import type { AppContext } from '../context';

/**
 * Account-lifecycle endpoints (PROJECTPLAN.md §13.4). Two families:
 *
 * - **Self-service account deletion** (V4-P2c, #362): the shared capability
 *   behind the web deletion page and the mobile in-app flow.
 * - **Account data export** (V4-P6a, #494): re-auth-gated `POST /export`
 *   (1/day) creates an async zip job and returns the raw download token once;
 *   `GET /export` polls status; `GET /export/download?token=` streams the
 *   assembled zip while the token matches and the job is ready and unexpired.
 *
 * User-kind only. The mutating routes ride the login rate schedule (per-IP)
 * because they re-verify a credential; each service adds its own per-account
 * throttle.
 */
export function createAccountRouter(ctx: AppContext, limiters: RateLimiters): Router {
  const router = Router();

  router.delete(
    '/',
    requireUser,
    limiters.login,
    validateBody(deleteAccountRequestSchema),
    async (req, res) => {
      const body = req.valid?.body as DeleteAccountRequest;
      await ctx.accountDeletion.deleteAccount({ userId: req.authUser!.id, body, ip: req.ip });
      // The session store is already empty; clear the cookie for the web caller
      // (a bearer caller's credential rows died with the user).
      clearSessionCookie(res, ctx.config);
      res.json({ ok: true });
    },
  );

  // Request an export: re-auth (password / 2FA) + 1/day gate → async build. The
  // raw download token is returned ONCE (only its hash is persisted).
  router.post(
    '/export',
    requireUser,
    limiters.login,
    validateBody(exportRequestSchema),
    async (req, res) => {
      const body = req.valid?.body as ExportRequest;
      const result = await ctx.dataExport.requestExport({
        userId: req.authUser!.id,
        body,
        ip: req.ip,
      });
      res.json(result);
    },
  );

  // Poll the caller's latest export job (no secret in the response).
  router.get('/export', requireUser, async (req, res) => {
    res.json(await ctx.dataExport.getStatus(req.authUser!.id));
  });

  // Stream the ready zip. Session-authenticated AND token-gated: the token was
  // minted behind the request-time re-auth and is short-lived, so it is the
  // download's fresh-re-auth proof; a foreign/expired token 404s (fails closed).
  router.get(
    '/export/download',
    requireUser,
    validateQuery(exportDownloadQuerySchema),
    async (req, res) => {
      const { token } = req.valid?.query as ExportDownloadQuery;
      const file = await ctx.dataExport.resolveDownload({ userId: req.authUser!.id, token });
      res.download(file.filePath, file.fileName);
    },
  );

  return router;
}
