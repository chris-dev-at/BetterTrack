import express, { Router } from 'express';

import {
  deleteAccountRequestSchema,
  exportDownloadQuerySchema,
  exportRequestSchema,
  paranoidMediaStatusResponseSchema,
  patchParanoidMediaRequestSchema,
  patchParanoidMediaResponseSchema,
  prepareParanoidMediaVerificationRequestSchema,
  prepareParanoidMediaVerificationResponseSchema,
  VAULT_ERROR_CODES,
  type DeleteAccountRequest,
  type ExportDownloadQuery,
  type ExportRequest,
  type PatchParanoidMediaRequest,
  type PrepareParanoidMediaVerificationRequest,
} from '@bettertrack/contracts';

import { ApiError, forbidden, notFound } from '../../errors';

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

  router.get('/paranoid/media', requireUser, async (req, res) => {
    const state = await ctx.paranoidVault.getMediaState(req.authUser!.id);
    if (!state) throw notFound('Account not found.');
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(paranoidMediaStatusResponseSchema.parse(state));
  });

  router.post(
    '/paranoid/media/verification',
    requireUser,
    validateBody(prepareParanoidMediaVerificationRequestSchema),
    async (req, res) => {
      const result = await ctx.paranoidVault.prepareMediaVerification(
        req.authUser!.id,
        req.valid?.body as PrepareParanoidMediaVerificationRequest,
      );
      switch (result.status) {
        case 'ok':
          res.setHeader('Cache-Control', 'private, no-store');
          res.json(prepareParanoidMediaVerificationResponseSchema.parse(result.proof));
          return;
        case 'not_found':
          throw notFound('Account not found.');
        case 'mode_required':
          throw forbidden(
            'Vault media can be changed only while paranoid mode is active.',
            VAULT_ERROR_CODES.modeRequired,
          );
        case 'state_conflict':
          throw new ApiError(
            409,
            VAULT_ERROR_CODES.mediaStateConflict,
            'Vault media changed after the client last read it.',
          );
        case 'verification_failed':
          throw new ApiError(
            412,
            VAULT_ERROR_CODES.mediaVerificationFailed,
            'The verified copy is not fresh enough for this media change.',
          );
      }
    },
  );

  router.patch(
    '/paranoid/media',
    requireUser,
    validateBody(patchParanoidMediaRequestSchema),
    async (req, res) => {
      const result = await ctx.paranoidVault.patchMedia(
        req.authUser!.id,
        req.valid?.body as PatchParanoidMediaRequest,
      );
      switch (result.status) {
        case 'ok':
          res.setHeader('Cache-Control', 'private, no-store');
          res.json(patchParanoidMediaResponseSchema.parse(result.state));
          return;
        case 'not_found':
          throw notFound('Account not found.');
        case 'mode_required':
          throw forbidden(
            'Vault media can be changed only while paranoid mode is active.',
            VAULT_ERROR_CODES.modeRequired,
          );
        case 'state_conflict':
          throw new ApiError(
            409,
            VAULT_ERROR_CODES.mediaStateConflict,
            'Vault media changed after the client last read it.',
          );
        case 'verification_failed':
          throw new ApiError(
            412,
            VAULT_ERROR_CODES.mediaVerificationFailed,
            'The verified copy is not fresh enough for this media change.',
          );
      }
    },
  );

  // Drive-only → both is one raw-byte transaction: the opaque Drive source is
  // inserted as the server head and the account media set changes together.
  // A request interrupted before commit therefore leaves BOTH rows untouched,
  // preserving the Drive-only zero-server-bytes boundary.
  const rawVaultBody = express.raw({ type: () => true, limit: ctx.config.vault.maxBytes });
  router.put(
    '/paranoid/media/server',
    requireUser,
    limiters.vault,
    (req, res, next) => {
      rawVaultBody(req, res, (err?: unknown) => {
        if ((err as { type?: string } | undefined)?.type === 'entity.too.large') {
          next(
            new ApiError(
              413,
              VAULT_ERROR_CODES.tooLarge,
              'The vault ciphertext exceeds the configured size cap.',
            ),
          );
          return;
        }
        if (err) {
          next(err);
          return;
        }
        next();
      });
    },
    async (req, res) => {
      const blob = Buffer.isBuffer(req.body) ? req.body : null;
      if (!blob || blob.length === 0) {
        throw new ApiError(
          400,
          VAULT_ERROR_CODES.malformed,
          'The vault write body must be non-empty envelope bytes.',
        );
      }
      const result = await ctx.paranoidVault.addServerMedium(req.authUser!.id, blob);
      switch (result.status) {
        case 'ok':
          res.setHeader('Cache-Control', 'private, no-store');
          res.json(patchParanoidMediaResponseSchema.parse(result.state));
          return;
        case 'not_found':
          throw notFound('Account not found.');
        case 'mode_required':
          throw forbidden(
            'The server vault medium can be added only while paranoid mode is active.',
            VAULT_ERROR_CODES.modeRequired,
          );
        case 'state_conflict':
          throw new ApiError(
            409,
            VAULT_ERROR_CODES.mediaStateConflict,
            'Vault media changed before the server medium could be added.',
          );
        case 'verification_failed':
          throw new ApiError(
            412,
            VAULT_ERROR_CODES.mediaVerificationFailed,
            'The Drive source is older than the durable media state.',
          );
        case 'too_large':
          throw new ApiError(
            413,
            VAULT_ERROR_CODES.tooLarge,
            'The vault ciphertext exceeds the configured size cap.',
          );
        case 'malformed':
          throw new ApiError(400, VAULT_ERROR_CODES.malformed, result.reason);
      }
    },
  );

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
