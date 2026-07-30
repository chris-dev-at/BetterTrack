import { json, Router } from 'express';

import {
  deleteAccountRequestSchema,
  exportDownloadRequestSchema,
  exportRequestSchema,
  paranoidDisableRequestSchema,
  paranoidEnableRequestSchema,
  type DeleteAccountRequest,
  type ExportDownloadRequest,
  type ExportRequest,
  type ParanoidDisableRequest,
  type ParanoidEnableRequest,
} from '@bettertrack/contracts';

import { ApiError } from '../../errors';
import {
  PARANOID_TRANSITION_HTTP_ERRORS,
  ParanoidTransitionError,
} from '../../services/account/paranoidTransitionService';
import { clearSessionCookie } from '../cookies';
import { requireUser } from '../middleware/session';
import { validateBody } from '../middleware/validate';
import type { RateLimiters } from '../middleware/rateLimit';
import type { AppContext } from '../context';

export const PARANOID_DISABLE_HTTP_PATH = '/api/v1/account/paranoid/disable';

/**
 * Plaintext allowance over the stored ciphertext bound for the one route that
 * carries a decrypted vault. The client deflates the envelope BEFORE encrypting
 * it, so the restore JSON is never smaller than the blob and is typically
 * several-fold larger. Deriving the body limit from `BT_VAULT_MAX_BYTES` alone
 * would accept a document for storage that can never be handed back — and
 * disable is the only way out of paranoid mode, so a 413 there is a trap with no
 * second exit. The factor covers the ratio deflate reaches on this JSON
 * (repeated keys, ISO dates, decimal strings) with margin; see
 * docs/paranoid-design.md §7 for the resulting practical ceiling.
 *
 * The buffered-body cost that buys is accepted: the route is session-gated and
 * rides the per-account vault rate schedule, and rehydrating a document of that
 * size already costs strictly more memory than holding its bytes.
 */
export const PARANOID_RESTORE_PLAINTEXT_FACTOR = 8;
export const paranoidDisableJsonLimitBytes = (vaultMaxBytes: number): number =>
  vaultMaxBytes * PARANOID_RESTORE_PLAINTEXT_FACTOR + 64 * 1024;

/**
 * Bound how long one download may hold the account transition lock. The transfer
 * streams inside that lock (a paranoid enable must not retire the archive
 * mid-transfer), so an abandoned client would otherwise park a lock-pool
 * connection idle-in-transaction — and block that account's enable — for as long
 * as its socket stays open. This is an IDLE bound: a slow but progressing
 * transfer keeps resetting it, only a stalled one is cut.
 */
export const EXPORT_DOWNLOAD_STALL_TIMEOUT_MS = 60_000;

/**
 * Account-lifecycle endpoints (PROJECTPLAN.md §13.4). Two families:
 *
 * - **Self-service account deletion** (V4-P2c, #362): the shared capability
 *   behind the web deletion page and the mobile in-app flow.
 * - **Account data export** (V4-P6a, #494): re-auth-gated `POST /export`
 *   (1/day) creates an async zip job and returns the raw download token once;
 *   `GET /export` polls status; `POST /export/download` consumes the token from
 *   its body and streams the assembled zip when the job is ready and unexpired.
 *
 * User-kind only. The mutating routes ride the login rate schedule (per-IP)
 * because they re-verify a credential; each service adds its own per-account
 * throttle.
 */
export function createAccountRouter(ctx: AppContext, limiters: RateLimiters): Router {
  const router = Router();

  const runTransition = async <T>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      if (!(error instanceof ParanoidTransitionError)) throw error;
      const mapped = PARANOID_TRANSITION_HTTP_ERRORS[error.code];
      throw new ApiError(mapped.status, mapped.code, error.message);
    }
  };

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

  // Both public transition directions ship as one surface. The service holds
  // the account row lock through each atomic purge/rehydration transaction.
  router.post(
    '/paranoid/enable',
    requireUser,
    limiters.vault,
    validateBody(paranoidEnableRequestSchema),
    async (req, res) => {
      const body = req.valid?.body as ParanoidEnableRequest;
      res.json(await runTransition(() => ctx.paranoidTransitions.enable(req.authUser!.id, body)));
    },
  );

  router.post(
    '/paranoid/disable',
    requireUser,
    limiters.vault,
    json({ limit: paranoidDisableJsonLimitBytes(ctx.config.vault.maxBytes) }),
    validateBody(paranoidDisableRequestSchema),
    async (req, res) => {
      const body = req.valid?.body as ParanoidDisableRequest;
      res.json(await runTransition(() => ctx.paranoidTransitions.disable(req.authUser!.id, body)));
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
  router.post(
    '/export/download',
    requireUser,
    validateBody(exportDownloadRequestSchema),
    async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      const { token } = req.valid?.body as ExportDownloadRequest;
      try {
        await ctx.dataExport.withDownload(
          { userId: req.authUser!.id, token },
          (file) =>
            new Promise<void>((resolve, reject) => {
              let settled = false;
              const finish = (error?: Error): void => {
                if (settled) return;
                settled = true;
                res.setTimeout(0);
                if (error) reject(error);
                else resolve();
              };
              // The watchdog settles the promise itself rather than relying on
              // the stream to call back after the socket dies: holding the
              // account lock forever would be far worse than a spurious error.
              res.setTimeout(EXPORT_DOWNLOAD_STALL_TIMEOUT_MS, () => {
                const stalled = new Error('The export download stalled.');
                res.destroy(stalled);
                finish(stalled);
              });
              res.download(file.filePath, file.fileName, finish);
            }),
        );
      } catch (error) {
        // Token resolution fails before anything is written, so it still becomes
        // the usual 404. Once the archive is on the wire the response is
        // committed: an abort or a cut stall can only be logged.
        if (!res.headersSent) throw error;
        ctx.logger.warn(
          { err: error instanceof Error ? error.message : 'unknown' },
          'export download did not complete',
        );
      }
    },
  );

  return router;
}
