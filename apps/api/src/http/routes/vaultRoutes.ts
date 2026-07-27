import express, { Router, type RequestHandler } from 'express';

import {
  parseVaultEtag,
  VAULT_CONTENT_TYPE,
  VAULT_ERROR_CODES,
  VAULT_HISTORY_CREATED_AT_HEADER,
  VAULT_HISTORY_MEDIUM_HEADER,
  VAULT_HISTORY_SIZE_BYTES_HEADER,
  vaultEtag,
  vaultHistoryListResponseSchema,
  vaultHistoryListQuerySchema,
  vaultHistoryVersionParamSchema,
  vaultMediaPatchRequestSchema,
  vaultMediaStateResponseSchema,
  retiredServerVaultPurgeRequestSchema,
  retiredServerVaultPurgeResponseSchema,
  type RetiredServerVaultPurgeRequest,
  type VaultHistoryListQuery,
  type VaultHistoryVersionParam,
  type VaultMediaPatchRequest,
} from '@bettertrack/contracts';

import { ApiError, forbidden, notFound } from '../../errors';

import type { RateLimiters } from '../middleware/rateLimit';
import { requireUser } from '../middleware/session';
import { validateBody, validateParams, validateQuery } from '../middleware/validate';
import type { AppContext } from '../context';

/**
 * Paranoid vault — the `server` storage medium (§13.5 V5-P13 arc b,
 * `docs/paranoid-design.md` §4). A BLIND blob store with compare-and-swap:
 *
 *  - `GET /api/v1/vault` → `200` with the opaque `application/octet-stream`
 *    ciphertext + `ETag: "<vaultVersion>"`, `404` when no vault exists, `304`
 *    when the caller's `If-None-Match` already holds the current version.
 *  - `PUT /api/v1/vault` (raw bytes) → CAS write. `If-None-Match: *` creates the
 *    first blob; `If-Match: "<version>"` replaces the matching one; a
 *    stale/missing precondition returns `412`/`428` and NEVER overwrites newer
 *    ciphertext. Oversized payloads are refused (`413`) before persistence; a
 *    malformed envelope is `400`.
 *
 * The server reads only the safe envelope header (format + version) for CAS and
 * the byte size for the cap — it never decrypts, parses further, logs or indexes
 * the payload. Session-authenticated and strictly scoped to the caller's own
 * vault; the per-user vault write limiter fronts the `PUT`.
 *
 * PD2 scope: the blind store itself. Enabling/disabling paranoid mode and the §8
 * route-enforcement guard land in PD3 — here every authenticated owner may read
 * and write their own vault blob.
 */

const preconditionRequired = (): ApiError =>
  new ApiError(
    428,
    VAULT_ERROR_CODES.preconditionRequired,
    'A vault write requires an If-Match (replace) or If-None-Match: * (create) precondition.',
  );

const preconditionFailed = (): ApiError =>
  new ApiError(
    412,
    VAULT_ERROR_CODES.preconditionFailed,
    'The vault precondition did not match the current version.',
  );

const payloadTooLarge = (): ApiError =>
  new ApiError(
    413,
    VAULT_ERROR_CODES.tooLarge,
    'The vault ciphertext exceeds the configured size cap.',
  );

const malformed = (message: string): ApiError =>
  new ApiError(400, VAULT_ERROR_CODES.malformed, message);

const requireParanoidMode: RequestHandler = (req, _res, next) => {
  if (req.authUser?.privacyMode !== 'paranoid') {
    next(
      forbidden(
        'Vault history is available only while paranoid mode is active.',
        VAULT_ERROR_CODES.modeRequired,
      ),
    );
    return;
  }
  next();
};

export function createVaultRouter(ctx: AppContext, limiters: RateLimiters): Router {
  const router = Router();

  router.use(requireUser);

  // Blind retained-history surface. The account mode comes from the user row
  // freshly resolved for this request; no user id is accepted from the client.
  router.use('/history', requireParanoidMode);

  // GET /vault/history?cursor=&limit= — newest-first metadata only. The
  // repository clamps every page independently of the requested limit.
  router.get('/history', validateQuery(vaultHistoryListQuerySchema), async (req, res) => {
    const query = req.valid?.query as VaultHistoryListQuery;
    const page = await ctx.paranoidVault.listHistory(req.authUser!.id, query);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(vaultHistoryListResponseSchema.parse(page));
  });

  // GET /vault/history/:version — one byte-identical opaque historical
  // envelope. Safe metadata rides headers; the body is never parsed or logged.
  router.get(
    '/history/:version',
    validateParams(vaultHistoryVersionParamSchema),
    async (req, res) => {
      const { version } = req.valid?.params as VaultHistoryVersionParam;
      const row = await ctx.paranoidVault.getHistory(req.authUser!.id, version);
      if (!row) throw notFound('No retained vault version found.', VAULT_ERROR_CODES.notFound);

      res.setHeader('ETag', vaultEtag(row.version));
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Type', VAULT_CONTENT_TYPE);
      res.setHeader(VAULT_HISTORY_CREATED_AT_HEADER, row.createdAt.toISOString());
      res.setHeader(VAULT_HISTORY_SIZE_BYTES_HEADER, String(row.sizeBytes));
      res.setHeader(VAULT_HISTORY_MEDIUM_HEADER, 'server');
      res.status(200).send(row.blob);
    },
  );

  // GET /vault — the current opaque blob + version ETag (or 404 / 304).
  router.get('/', async (req, res) => {
    const row = await ctx.paranoidVault.get(req.authUser!.id);
    if (!row) throw notFound('No vault stored.', VAULT_ERROR_CODES.notFound);

    res.setHeader('ETag', vaultEtag(row.version));
    res.setHeader('Cache-Control', 'private, no-store');

    const ifNoneMatch = parseVaultEtag(req.headers['if-none-match'] as string | undefined);
    if (ifNoneMatch !== null && ifNoneMatch === row.version) {
      res.status(304).end();
      return;
    }

    res.setHeader('Content-Type', VAULT_CONTENT_TYPE);
    res.status(200).send(row.blob);
  });

  // Raw opaque body for the PUT, capped at the configured size (`§2`). The cap is
  // the transport guard; the service re-checks it authoritatively before any
  // persistence. `type: () => true` parses the octet-stream regardless of the
  // exact content type a client sends.
  const rawBody = express.raw({ type: () => true, limit: ctx.config.vault.maxBytes });

  router.put(
    '/',
    limiters.vault,
    (req, res, next) => {
      rawBody(req, res, (err?: unknown) => {
        if (err) {
          if ((err as { type?: string }).type === 'entity.too.large') {
            next(payloadTooLarge());
            return;
          }
          next(err);
          return;
        }
        next();
      });
    },
    async (req, res) => {
      const blob = Buffer.isBuffer(req.body) ? req.body : null;
      if (!blob || blob.length === 0) {
        throw malformed('The vault write body must be non-empty envelope bytes.');
      }

      // CAS precondition: `If-None-Match: *` creates; `If-Match: <version>`
      // replaces; neither is a hard error (CAS is mandatory).
      const ifNoneMatch = (req.headers['if-none-match'] as string | undefined)?.trim();
      const ifMatch = req.headers['if-match'] as string | undefined;
      let expectedVersion: number | null;
      if (ifNoneMatch === '*') {
        expectedVersion = null;
      } else if (ifMatch !== undefined) {
        const parsed = parseVaultEtag(ifMatch);
        // A non-integer / wildcard / list If-Match can never match a concrete
        // stored version → the CAS fails closed.
        if (parsed === null || parsed < 1) throw preconditionFailed();
        expectedVersion = parsed;
      } else {
        throw preconditionRequired();
      }

      const result = await ctx.paranoidVault.put({
        userId: req.authUser!.id,
        expectedVersion,
        blob,
      });

      switch (result.status) {
        case 'ok':
          res.setHeader('ETag', vaultEtag(result.version));
          res.status(204).end();
          return;
        case 'precondition_failed':
          // Surface the current version so the client can resync, then fail the
          // CAS — newer ciphertext is never overwritten.
          if (result.currentVersion !== null) {
            res.setHeader('ETag', vaultEtag(result.currentVersion));
          }
          throw preconditionFailed();
        case 'too_large':
          throw payloadTooLarge();
        case 'malformed':
          throw malformed(result.reason);
      }
    },
  );

  return router;
}

/**
 * Account-scoped media controls live at `/api/v1/account/paranoid/media`.
 * Drive credentials never cross this router: only the non-sensitive media set
 * and a short-lived opaque-envelope read-back attestation are accepted.
 */
export function createParanoidMediaRouter(ctx: AppContext): Router {
  const router = Router();

  router.use(requireUser, requireParanoidMode);

  router.get('/media', async (req, res) => {
    const state = await ctx.paranoidVault.getMediaState(req.authUser!.id);
    if (!state) {
      throw notFound('No paranoid media state found.', VAULT_ERROR_CODES.notFound);
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(vaultMediaStateResponseSchema.parse(state));
  });

  router.patch('/media', validateBody(vaultMediaPatchRequestSchema), async (req, res) => {
    const body = req.valid?.body as VaultMediaPatchRequest;
    const result = await ctx.paranoidVault.patchMedia(req.authUser!.id, body);
    switch (result.status) {
      case 'ok':
        res.setHeader('Cache-Control', 'private, no-store');
        res.json(vaultMediaStateResponseSchema.parse(result.media));
        return;
      case 'not_found':
        throw notFound('No account found.', VAULT_ERROR_CODES.notFound);
      case 'mode_required':
        throw forbidden(
          'Media switching is available only in paranoid mode.',
          VAULT_ERROR_CODES.modeRequired,
        );
      case 'precondition_failed':
        throw new ApiError(
          412,
          VAULT_ERROR_CODES.mediaPreconditionFailed,
          'The durable vault media set changed before this transition.',
          { mediaSet: result.mediaSet },
        );
      case 'invalid_transition':
        throw new ApiError(
          409,
          VAULT_ERROR_CODES.mediaTransitionInvalid,
          'Vault media must be added or removed one medium at a time.',
        );
      case 'verification_required':
        throw new ApiError(
          422,
          VAULT_ERROR_CODES.mediaVerificationRequired,
          'A fresh verified round trip is required before changing vault media.',
        );
      case 'verification_invalid':
        throw new ApiError(
          422,
          VAULT_ERROR_CODES.mediaVerificationInvalid,
          'The vault media verification is stale or does not match the server copy.',
        );
    }
  });

  router.post(
    '/media/server/purge',
    validateBody(retiredServerVaultPurgeRequestSchema),
    async (req, res) => {
      const { proof } = req.valid?.body as RetiredServerVaultPurgeRequest;
      const result = await ctx.paranoidVault.purgeRetiredServer(req.authUser!.id, proof);
      switch (result.status) {
        case 'ok':
          res.setHeader('Cache-Control', 'private, no-store');
          res.json(
            retiredServerVaultPurgeResponseSchema.parse({
              media: result.media,
              purgedVersions: result.purgedVersions,
              purgedBytes: result.purgedBytes,
            }),
          );
          return;
        case 'not_found':
          throw notFound('No account found.', VAULT_ERROR_CODES.notFound);
        case 'mode_required':
          throw forbidden(
            'Retired vault purge is available only in paranoid mode.',
            VAULT_ERROR_CODES.modeRequired,
          );
        case 'media_invalid':
          throw new ApiError(
            409,
            VAULT_ERROR_CODES.mediaTransitionInvalid,
            'Retired server ciphertext can be purged only while Drive is the sole medium.',
          );
        case 'proof_invalid':
          throw new ApiError(
            422,
            VAULT_ERROR_CODES.retiredPurgeProofInvalid,
            'The fresh Drive read-back proof does not cover the retired server vault.',
          );
        case 'retention_not_met':
          throw new ApiError(
            409,
            VAULT_ERROR_CODES.retiredRetentionRequired,
            'The retired server vault is still inside its minimum recovery window.',
            { eligibleAt: result.eligibleAt.toISOString() },
          );
      }
    },
  );

  return router;
}
