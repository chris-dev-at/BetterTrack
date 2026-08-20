import { createPublicKey } from 'node:crypto';

import express, { Router, type RequestHandler } from 'express';

import {
  createVaultRequestSchema,
  createVaultResponseSchema,
  deleteVaultRequestSchema,
  deleteVaultResponseSchema,
  patchVaultRequestSchema,
  patchVaultResponseSchema,
  perVaultMediaStateResponseSchema,
  perVaultMediaTransitionRequestSchema,
  perVaultMediaTransitionResponseSchema,
  perVaultRetiredServerPurgeChallengeRequestSchema,
  perVaultRetiredServerPurgeChallengeResponseSchema,
  perVaultRetiredServerPurgeRequestSchema,
  perVaultRetiredServerPurgeResponseSchema,
  perVaultServerCandidateMetadataSchema,
  perVaultServerCandidateReadParamsSchema,
  perVaultServerCandidateStageParamsSchema,
  PER_VAULT_ERROR_CODES,
  paranoidMediaStateResponseSchema,
  paranoidMediaTransitionRequestSchema,
  paranoidMediaTransitionResponseSchema,
  paranoidServerCandidateMetadataSchema,
  paranoidServerCandidateParamSchema,
  parseVaultEtag,
  retiredServerPurgeChallengeRequestSchema,
  retiredServerPurgeChallengeResponseSchema,
  retiredServerPurgeRequestSchema,
  retiredServerPurgeResponseSchema,
  scopeSatisfies,
  VAULT_CONTENT_TYPE,
  VAULT_ERROR_CODES,
  VAULT_HISTORY_CREATED_AT_HEADER,
  VAULT_HISTORY_MEDIUM_HEADER,
  VAULT_HISTORY_SIZE_BYTES_HEADER,
  VAULT_RETIREMENT_PROOF_PUBLIC_KEY_HEADER,
  VAULT_SERVER_CANDIDATE_EXPIRES_AT_HEADER,
  VAULT_SERVER_CANDIDATE_ID_HEADER,
  VAULT_SERVER_CANDIDATE_READBACK_HEADER,
  vaultEtag,
  vaultDocHistoryVersionParamSchema,
  vaultDocParamsSchema,
  vaultIdParamSchema,
  vaultListResponseSchema,
  vaultHistoryListResponseSchema,
  vaultHistoryListQuerySchema,
  vaultHistoryVersionParamSchema,
  vaultRetirementProofPublicKeySchema,
  type ParanoidMediaTransitionRequest,
  type CreateVaultRequest,
  type DeleteVaultRequest,
  type PatchVaultRequest,
  type PerVaultMediaTransitionRequest,
  type PerVaultRetiredServerPurgeChallengeRequest,
  type PerVaultRetiredServerPurgeRequest,
  type PerVaultServerCandidateReadParams,
  type PerVaultServerCandidateStageParams,
  type ParanoidServerCandidateParam,
  type RetiredServerPurgeChallengeRequest,
  type RetiredServerPurgeRequest,
  type VaultHistoryListQuery,
  type VaultHistoryVersionParam,
  type VaultDocHistoryVersionParam,
  type VaultDocParams,
  type VaultIdParam,
} from '@bettertrack/contracts';

import { ApiError, EnvelopeApiError, forbidden, notFound } from '../../errors';
import {
  isParanoidKilledScope,
  PARANOID_MODE_ERROR_CODE,
} from '../../services/account/paranoidEnforcement';

import type { AppContext } from '../context';
import {
  ACCOUNT_SECURITY_SCOPE,
  VAULT_SYNC_SCOPE,
  recordBearerScopeDenied,
  vaultAccountSecurityRouteAcceptsBearer,
  vaultSyncRouteAcceptsBearer,
} from '../middleware/bearerAuth';
import type { RateLimiters } from '../middleware/rateLimit';
import { requireUser } from '../middleware/session';
import { validateBody, validateParams, validateQuery } from '../middleware/validate';

const preconditionRequired = (): ApiError =>
  new ApiError(
    428,
    VAULT_ERROR_CODES.preconditionRequired,
    'A vault write requires an If-Match (replace) or If-None-Match: * (create) precondition.',
  );

/**
 * The v1 CAS 412. It carries the server's current version as a TOP-LEVEL body
 * member, exactly like the v2 surface (design r2 §15 / r3): the ETag hint this
 * route once set was removed by #1161's no-validators-on-errors rule, which
 * left a v1 CAS loser paying a second `GET /vault` just to learn the winner.
 * The body member restores the hint without putting a cache validator back on
 * an error response. `null` means the precondition never named a real stored
 * version (malformed `If-Match`, or nothing stored at all).
 */
const preconditionFailed = (currentVersion: number | null = null): ApiError =>
  new EnvelopeApiError(
    412,
    VAULT_ERROR_CODES.preconditionFailed,
    'The vault precondition did not match the current version.',
    { currentVersion },
  );

const payloadTooLarge = (): ApiError =>
  new ApiError(
    413,
    VAULT_ERROR_CODES.tooLarge,
    'The vault ciphertext exceeds the configured size cap.',
  );

const malformed = (message: string): ApiError =>
  new ApiError(400, VAULT_ERROR_CODES.malformed, message);

const serverMediumInactive = (message: string): ApiError =>
  new ApiError(409, VAULT_ERROR_CODES.serverMediumInactive, message);

/**
 * Local defense-in-depth for #1043's sync-only bearer exception. A bearer may
 * reach only the exact opaque sync reads/writes listed by the global policy;
 * every media/storage transition and every future route still requires the
 * owning cookie session. Direct-router use therefore cannot silently widen the
 * exception if the mount or global policy changes later.
 */
export const requireCookieSessionOrVaultSync: RequestHandler = (req, _res, next) => {
  const bearerSyncAllowed =
    req.apiKey !== undefined &&
    // Route-aware AND scope-aware: if the global policy table is what regresses,
    // a token holding some unrelated scope must still not reach the vault.
    scopeSatisfies(req.apiKey.scopes, VAULT_SYNC_SCOPE) &&
    vaultSyncRouteAcceptsBearer(
      req.method,
      `/vault${req.path === '/' || req.path === '' ? '' : req.path}`,
    );
  if ((!req.apiKey && req.sessionId) || bearerSyncAllowed) {
    next();
    return;
  }
  next(
    forbidden(
      'This vault endpoint is available only to the owning browser session.',
      'API_KEY_FORBIDDEN',
    ),
  );
};

/**
 * Vault write state machine: an owning cookie session may write while the
 * account is normal so the enable wizard can stage its encrypted server copy,
 * and may keep writing after the transition. A `vault:sync` bearer cannot own
 * that transition, so it may write only after privacyMode is paranoid. Once
 * paranoid, the repository additionally requires `server` to be an active
 * medium under the same account lock as the CAS.
 */
const requireBearerVaultWriteState: RequestHandler = (req, _res, next) => {
  if (req.apiKey && req.authUser?.privacyMode !== 'paranoid') {
    next(
      serverMediumInactive('Bearer vault writes are available only while paranoid mode is active.'),
    );
    return;
  }
  next();
};

const requireParanoidHistory: RequestHandler = (req, _res, next) => {
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

/**
 * The retirement proof verifier is a recovery-media authority, not part of the
 * sync protocol: it is immutable once stored (a later CAS write supplying a
 * different key is refused with `proof_key_conflict`), it is the only thing a
 * retired-server purge can ever verify against, and it is *generated* client
 * side rather than derived, so whoever writes it first pins a value nobody else
 * can reproduce. #1043 grants a bearer opaque byte sync, explicitly not that
 * authority, so this second cleartext header is not read at all on the bearer
 * path — it resolves to `null`, which is inert in both CAS branches: the create
 * branch stores no key and the update branch keeps whatever the row already has
 * (`current.retirementProofPublicKey ?? …`). The owning browser session
 * therefore remains the only enroller, on a vault a bearer created as well.
 */
function parseRetirementProofPublicKey(req: Parameters<RequestHandler>[0]): string | null {
  if (req.apiKey) return null;
  const raw = req.get(VAULT_RETIREMENT_PROOF_PUBLIC_KEY_HEADER);
  if (!raw) return null;
  const parsed = vaultRetirementProofPublicKeySchema.safeParse(raw);
  if (!parsed.success || !isEd25519SpkiPublicKey(parsed.data)) {
    throw malformed('The retirement proof public key header must be a base64url Ed25519 SPKI key.');
  }
  return parsed.data;
}

/**
 * The isomorphic contract checks canonical DER shape. Parse it in Node as
 * well so only a key OpenSSL recognizes as Ed25519 can be made immutable in
 * active or staged server media.
 */
function isEd25519SpkiPublicKey(value: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(value, 'base64url'),
      format: 'der',
      type: 'spki',
    });
    return key.asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}

function rawVaultBody(ctx: AppContext): RequestHandler {
  const parser = express.raw({ type: () => true, limit: ctx.config.vault.maxBytes });
  return (req, res, next) => {
    parser(req, res, (err?: unknown) => {
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
  };
}

function requireRawEnvelope(req: Parameters<RequestHandler>[0]): Buffer {
  const blob = Buffer.isBuffer(req.body) ? req.body : null;
  if (!blob || blob.length === 0) {
    throw malformed('The vault write body must be non-empty envelope bytes.');
  }
  return blob;
}

export function createVaultRouter(ctx: AppContext, limiters: RateLimiters): Router {
  const router = Router();
  const parseRawEnvelope = rawVaultBody(ctx);

  router.use(requireUser, requireCookieSessionOrVaultSync);
  router.use('/history', requireParanoidHistory);

  router.get('/history', validateQuery(vaultHistoryListQuerySchema), async (req, res) => {
    const query = req.valid?.query as VaultHistoryListQuery;
    const page = await ctx.paranoidVault.listHistory(req.authUser!.id, query);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(vaultHistoryListResponseSchema.parse(page));
  });

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

  // Durable selection plus active/candidate/retired server disposition. There
  // is intentionally no blob in this JSON response.
  router.get('/media', async (req, res) => {
    const state = await ctx.paranoidVault.getMediaState(req.authUser!.id);
    if (!state) throw notFound('Account not found.');
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(paranoidMediaStateResponseSchema.parse(state));
  });

  router.patch('/media', validateBody(paranoidMediaTransitionRequestSchema), async (req, res) => {
    const result = await ctx.paranoidVault.transitionMedia(
      req.authUser!.id,
      req.valid?.body as ParanoidMediaTransitionRequest,
    );
    switch (result.status) {
      case 'ok':
        res.setHeader('Cache-Control', 'private, no-store');
        res.json(paranoidMediaTransitionResponseSchema.parse(result.state));
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
          'The required vault read-back is absent, stale, or invalid.',
        );
      case 'proof_required':
        throw new ApiError(
          409,
          VAULT_ERROR_CODES.retirementProofRequired,
          'An immutable retirement proof verifier is required before server media can be activated or retired.',
        );
      case 'proof_key_conflict':
        throw new ApiError(
          409,
          VAULT_ERROR_CODES.retirementConflict,
          'The server retirement proof key conflicts with retained recovery data.',
        );
      case 'retirement_conflict':
        throw new ApiError(
          409,
          VAULT_ERROR_CODES.retirementConflict,
          'Retained server bytes conflict with this media transition.',
        );
    }
  });

  // Drive-only -> both first stages a blind candidate outside the active vault.
  router.put('/media/server-candidate', limiters.vault, parseRawEnvelope, async (req, res) => {
    const result = await ctx.paranoidVault.stageServerCandidate(
      req.authUser!.id,
      requireRawEnvelope(req),
      parseRetirementProofPublicKey(req),
    );
    switch (result.status) {
      case 'ok':
        res.setHeader('Cache-Control', 'private, no-store');
        res.json(paranoidServerCandidateMetadataSchema.parse(result.candidate));
        return;
      case 'not_found':
        throw notFound('Account not found.');
      case 'mode_required':
        throw forbidden(
          'A server candidate can be staged only while paranoid mode is active.',
          VAULT_ERROR_CODES.modeRequired,
        );
      case 'state_conflict':
        throw new ApiError(
          409,
          VAULT_ERROR_CODES.mediaStateConflict,
          'The server candidate no longer matches the durable media state.',
        );
      case 'verification_failed':
        throw new ApiError(
          412,
          VAULT_ERROR_CODES.mediaVerificationFailed,
          'The candidate version is stale for the durable Drive state.',
        );
      case 'proof_key_conflict':
        throw new ApiError(
          409,
          VAULT_ERROR_CODES.retirementConflict,
          'The candidate uses a different retirement proof key than retained data.',
        );
      case 'too_large':
        throw payloadTooLarge();
      case 'malformed':
        throw malformed(result.reason);
    }
  });

  // Raw candidate read-back. The opaque receipt is HMAC-bound to this browser
  // session, candidate id/version and expiry; PATCH cannot promote without it.
  router.get(
    '/media/server-candidate/:candidateId',
    validateParams(paranoidServerCandidateParamSchema),
    async (req, res) => {
      const { candidateId } = req.valid?.params as ParanoidServerCandidateParam;
      const candidate = await ctx.paranoidVault.getServerCandidate(req.authUser!.id, candidateId);
      if (!candidate) {
        throw notFound('No active server vault candidate found.', VAULT_ERROR_CODES.notFound);
      }
      const readback = ctx.paranoidVault.issueCandidateReadback(req.authUser!.id, candidate);
      if (!readback) {
        throw new ApiError(
          503,
          VAULT_ERROR_CODES.retirementProofRequired,
          'Vault proof issuance is unavailable.',
        );
      }
      res.setHeader('ETag', vaultEtag(candidate.version));
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Type', VAULT_CONTENT_TYPE);
      res.setHeader(VAULT_SERVER_CANDIDATE_ID_HEADER, candidate.id);
      res.setHeader(VAULT_SERVER_CANDIDATE_EXPIRES_AT_HEADER, candidate.expiresAt.toISOString());
      res.setHeader(VAULT_SERVER_CANDIDATE_READBACK_HEADER, readback);
      res.status(200).send(candidate.blob);
    },
  );

  router.post(
    '/media/retired/purge/challenge',
    validateBody(retiredServerPurgeChallengeRequestSchema),
    async (req, res) => {
      const result = await ctx.paranoidVault.prepareRetiredPurge(
        req.authUser!.id,
        req.valid?.body as RetiredServerPurgeChallengeRequest,
      );
      switch (result.status) {
        case 'ok':
          res.setHeader('Cache-Control', 'private, no-store');
          res.json(retiredServerPurgeChallengeResponseSchema.parse(result.challenge));
          return;
        case 'not_found':
          throw notFound('No retired server vault data found.', VAULT_ERROR_CODES.notFound);
        case 'state_conflict':
          throw new ApiError(
            409,
            VAULT_ERROR_CODES.mediaStateConflict,
            'The requested retirement set is no longer current.',
          );
        case 'proof_required':
          throw new ApiError(
            409,
            VAULT_ERROR_CODES.retirementProofRequired,
            'No immutable retirement proof verifier is available.',
          );
      }
    },
  );

  router.post(
    '/media/retired/purge',
    validateBody(retiredServerPurgeRequestSchema),
    async (req, res) => {
      const result = await ctx.paranoidVault.purgeRetired(
        req.authUser!.id,
        req.valid?.body as RetiredServerPurgeRequest,
      );
      switch (result.status) {
        case 'ok':
          res.setHeader('Cache-Control', 'private, no-store');
          res.json(retiredServerPurgeResponseSchema.parse({ purged: true }));
          return;
        case 'not_found':
          throw notFound('No retired server vault data found.', VAULT_ERROR_CODES.notFound);
        case 'mode_required':
          throw forbidden(
            'Retired vault data exists only while paranoid mode is active.',
            VAULT_ERROR_CODES.modeRequired,
          );
        case 'state_conflict':
          throw new ApiError(
            409,
            VAULT_ERROR_CODES.mediaStateConflict,
            'The server medium must be empty and the retirement version current to purge.',
          );
        case 'retention_pending':
          throw new ApiError(
            409,
            VAULT_ERROR_CODES.retirementRetention,
            'The retired server recovery window has not elapsed.',
          );
        case 'proof_required':
          throw new ApiError(
            409,
            VAULT_ERROR_CODES.retirementProofRequired,
            'No immutable retirement proof verifier is available.',
          );
        case 'proof_invalid':
          throw new ApiError(
            412,
            VAULT_ERROR_CODES.retirementProofInvalid,
            'The retired-server purge proof is malformed, stale, or does not verify.',
          );
      }
    },
  );

  /*
   * A safe method that can change state, so worth stating: for a NORMAL-mode
   * account whose enable window has already expired, the repository read is
   * also the sweep that physically deletes the abandoned ciphertext before
   * answering `medium_inactive`. It only ever destroys bytes that were already
   * unreachable, only for the authenticated caller's own account, and the same
   * disposal runs from the retention job — so being CSRF-exempt (`csrf.ts`
   * exempts safe methods) costs nothing: a forged cross-site GET can reach no
   * state a plain expiry would not have reached anyway, and cannot read the
   * opaque response.
   */
  router.get('/', async (req, res) => {
    const result = await ctx.paranoidVault.get(
      req.authUser!.id,
      req.apiKey ? 'sync-bearer' : 'owner-session',
    );
    if (result.status === 'medium_inactive') {
      throw serverMediumInactive(
        'The server vault is available only while paranoid mode or its owner enable window is active.',
      );
    }
    if (result.status === 'not_found') {
      throw notFound('No vault stored.', VAULT_ERROR_CODES.notFound);
    }
    const { row } = result;
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

  router.put(
    '/',
    limiters.vault,
    requireBearerVaultWriteState,
    parseRawEnvelope,
    async (req, res) => {
      const blob = requireRawEnvelope(req);
      const ifNoneMatch = (req.headers['if-none-match'] as string | undefined)?.trim();
      const ifMatch = req.headers['if-match'] as string | undefined;
      let expectedVersion: number | null;
      if (ifNoneMatch === '*') {
        expectedVersion = null;
      } else if (ifMatch !== undefined) {
        const parsed = parseVaultEtag(ifMatch);
        if (parsed === null || parsed < 1) throw preconditionFailed();
        expectedVersion = parsed;
      } else {
        throw preconditionRequired();
      }
      const result = await ctx.paranoidVault.put({
        userId: req.authUser!.id,
        access: req.apiKey ? 'sync-bearer' : 'owner-session',
        expectedVersion,
        blob,
        retirementProofPublicKey: parseRetirementProofPublicKey(req),
      });
      switch (result.status) {
        case 'ok':
          res.setHeader('ETag', vaultEtag(result.version));
          res.status(204).end();
          return;
        case 'precondition_failed':
          throw preconditionFailed(result.currentVersion);
        case 'too_large':
          throw payloadTooLarge();
        case 'malformed':
          throw malformed(result.reason);
        case 'medium_inactive':
          throw serverMediumInactive(
            'The server vault medium is inactive; stage and promote a candidate instead.',
          );
        case 'proof_key_conflict':
          throw new ApiError(
            409,
            VAULT_ERROR_CODES.retirementConflict,
            'The retirement proof key is immutable once server bytes are active.',
          );
      }
    },
  );

  return router;
}

const perVaultPreconditionRequired = (): ApiError =>
  new ApiError(
    428,
    PER_VAULT_ERROR_CODES.preconditionRequired,
    'A document write requires If-Match or If-None-Match: *.',
  );

const perVaultPreconditionFailed = (currentVersion: number | null): ApiError =>
  new EnvelopeApiError(
    412,
    PER_VAULT_ERROR_CODES.preconditionFailed,
    'The document precondition did not match its current version.',
    { currentVersion },
  );

const perVaultNotFound = (): ApiError =>
  notFound('Vault or vault document not found.', PER_VAULT_ERROR_CODES.notFound);

const perVaultRawBody = (ctx: AppContext): RequestHandler => {
  const limit = Math.max(...Object.values(ctx.config.vault.docMaxBytes));
  const parser = express.raw({ type: () => true, limit });
  return (req, res, next) => {
    parser(req, res, (error?: unknown) => {
      if ((error as { type?: unknown } | undefined)?.type === 'entity.too.large') {
        next(
          new ApiError(
            413,
            PER_VAULT_ERROR_CODES.tooLarge,
            'The vault document exceeds the configured size cap.',
          ),
        );
        return;
      }
      next(error);
    });
  };
};

/** Defense-in-depth mirror of the exact global `/vaults` bearer policy. */
function buildCookieSessionOrPerVaultAccess(ctx: AppContext): RequestHandler {
  // Named independently of the factory: the production-route census pins the
  // opaque mount by handler name as well as by its `/vaults` mount point.
  return function requireCookieSessionOrPerVaultAccess(req, _res, next) {
    if (!req.apiKey && req.sessionId) {
      next();
      return;
    }
    if (!req.apiKey) {
      next(
        forbidden(
          'This vault endpoint is available only to the owning browser session.',
          'API_KEY_FORBIDDEN',
        ),
      );
      return;
    }
    // Match the global bearer guard's user/admin boundary even if this router
    // is remounted without that guard: a bearer-backed admin principal learns
    // nothing about the user vault surface.
    if (req.authUser?.role === 'admin') {
      next(notFound());
      return;
    }

    const path = `/vaults${req.path === '/' || req.path === '' ? '' : req.path}`;
    const requiredScope = vaultSyncRouteAcceptsBearer(req.method, path)
      ? VAULT_SYNC_SCOPE
      : vaultAccountSecurityRouteAcceptsBearer(req.method, path)
        ? ACCOUNT_SECURITY_SCOPE
        : null;
    if (requiredScope === null) {
      next(
        forbidden(
          'This vault endpoint is available only to the owning browser session.',
          'API_KEY_FORBIDDEN',
        ),
      );
      return;
    }
    if (req.authUser?.privacyMode === 'paranoid' && isParanoidKilledScope(requiredScope)) {
      next(
        forbidden(
          'This API scope is unavailable while paranoid mode is active.',
          PARANOID_MODE_ERROR_CODE,
        ),
      );
      return;
    }
    if (!scopeSatisfies(req.apiKey.scopes, requiredScope)) {
      recordBearerScopeDenied(ctx, req, requiredScope, path).then(
        () =>
          next(
            forbidden(
              `API key is missing the required scope "${requiredScope}".`,
              'INSUFFICIENT_SCOPE',
            ),
          ),
        next,
      );
      return;
    }
    next();
  };
}

export { buildCookieSessionOrPerVaultAccess as requireCookieSessionOrPerVaultAccess };

/** Parallel per-vault E1 surface. The legacy `/vault` router above is unchanged. */
export function createVaultsRouter(ctx: AppContext, limiters: RateLimiters): Router {
  const router = Router();
  const parseRawDocument = perVaultRawBody(ctx);

  router.use(requireUser, buildCookieSessionOrPerVaultAccess(ctx));
  router.use((req, res, next) => {
    const limiter =
      req.method === 'GET' || req.method === 'HEAD' ? limiters.vaultRead : limiters.vault;
    limiter(req, res, next);
  });

  router.get('/', async (req, res) => {
    const vaults = await ctx.vaults.list(req.authUser!.id);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(vaultListResponseSchema.parse({ vaults }));
  });

  router.post('/', validateBody(createVaultRequestSchema), async (req, res) => {
    const result = await ctx.vaults.create(
      req.authUser!.id,
      req.valid?.body as CreateVaultRequest,
      req.ip,
    );
    switch (result.status) {
      case 'ok':
        res.setHeader('Cache-Control', 'private, no-store');
        res.status(201).json(createVaultResponseSchema.parse({ vault: result.vault }));
        return;
      case 'name_taken':
        throw new ApiError(
          409,
          PER_VAULT_ERROR_CODES.nameConflict,
          'A vault with that name exists.',
        );
      case 'drive_not_found':
        throw new ApiError(
          409,
          PER_VAULT_ERROR_CODES.driveBindingInvalid,
          'The selected Drive connection is not available to this account.',
        );
      case 'reserved_medium':
        throw new ApiError(
          400,
          PER_VAULT_ERROR_CODES.reservedMedium,
          'The local vault medium is reserved and is not supported by this server.',
        );
      case 'portfolio_binding_mismatch':
        throw new ApiError(
          409,
          PER_VAULT_ERROR_CODES.portfolioBindingMismatch,
          'Vault singleton document ids cannot collide with an owned portfolio id.',
        );
    }
  });

  router.get('/:vaultId', validateParams(vaultIdParamSchema), async (req, res) => {
    const { vaultId } = req.valid?.params as VaultIdParam;
    const vault = await ctx.vaults.get(req.authUser!.id, vaultId);
    if (!vault) throw perVaultNotFound();
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(createVaultResponseSchema.parse({ vault }));
  });

  router.patch(
    '/:vaultId',
    validateParams(vaultIdParamSchema),
    validateBody(patchVaultRequestSchema),
    async (req, res) => {
      const { vaultId } = req.valid?.params as VaultIdParam;
      const result = await ctx.vaults.patch(
        req.authUser!.id,
        vaultId,
        req.valid?.body as PatchVaultRequest,
        req.ip,
      );
      if (result.status === 'not_found') throw perVaultNotFound();
      if (result.status === 'name_taken') {
        throw new ApiError(
          409,
          PER_VAULT_ERROR_CODES.nameConflict,
          'A vault with that name exists.',
        );
      }
      res.setHeader('Cache-Control', 'private, no-store');
      res.json(patchVaultResponseSchema.parse({ vault: result.vault }));
    },
  );

  router.delete(
    '/:vaultId',
    validateParams(vaultIdParamSchema),
    validateBody(deleteVaultRequestSchema),
    async (req, res) => {
      const { vaultId } = req.valid?.params as VaultIdParam;
      const result = await ctx.vaults.delete({
        userId: req.authUser!.id,
        vaultId,
        body: req.valid?.body as DeleteVaultRequest,
        ip: req.ip,
      });
      switch (result.status) {
        case 'ok':
          res.json(deleteVaultResponseSchema.parse({ ok: true }));
          return;
        case 'not_found':
          throw perVaultNotFound();
        case 'referenced':
          throw new ApiError(
            409,
            PER_VAULT_ERROR_CODES.deleteReferenced,
            'Move every portfolio out of this vault before deleting it.',
          );
        case 'retirement_pending':
          throw new ApiError(
            409,
            PER_VAULT_ERROR_CODES.deleteRetirementPending,
            'The retired server set must pass the signed purge gate before deletion.',
          );
      }
    },
  );

  router.get('/:vaultId/docs/:docId', validateParams(vaultDocParamsSchema), async (req, res) => {
    const { vaultId, docId } = req.valid?.params as VaultDocParams;
    const result = await ctx.vaults.readDoc(req.authUser!.id, vaultId, docId);
    if (result.status === 'not_found') throw perVaultNotFound();
    if (result.status === 'medium_inactive') {
      throw new ApiError(
        409,
        PER_VAULT_ERROR_CODES.mediaStateConflict,
        'The server medium is not active for this vault.',
      );
    }
    res.setHeader('ETag', vaultEtag(result.row.version));
    res.setHeader('Cache-Control', 'private, no-store');
    const validator = parseVaultEtag(req.headers['if-none-match'] as string | undefined);
    if (validator === result.row.version) {
      res.status(304).end();
      return;
    }
    res.setHeader('Content-Type', VAULT_CONTENT_TYPE);
    res.status(200).send(result.row.blob);
  });

  router.put(
    '/:vaultId/docs/:docId',
    validateParams(vaultDocParamsSchema),
    parseRawDocument,
    async (req, res) => {
      const { vaultId, docId } = req.valid?.params as VaultDocParams;
      const blob = requireRawEnvelope(req);
      const ifNoneMatch = (req.headers['if-none-match'] as string | undefined)?.trim();
      const ifMatch = req.headers['if-match'] as string | undefined;
      let expectedVersion: number | null;
      if (ifNoneMatch === '*') expectedVersion = null;
      else if (ifMatch !== undefined) {
        const parsed = parseVaultEtag(ifMatch);
        if (parsed === null || parsed < 1) throw perVaultPreconditionFailed(null);
        expectedVersion = parsed;
      } else throw perVaultPreconditionRequired();

      const result = await ctx.vaults.putDoc({
        userId: req.authUser!.id,
        vaultId,
        docId,
        expectedVersion,
        blob,
      });
      switch (result.status) {
        case 'ok':
          res.setHeader('ETag', vaultEtag(result.row.version));
          res.status(204).end();
          return;
        case 'not_found':
          throw perVaultNotFound();
        case 'portfolio_binding_mismatch':
          throw new ApiError(
            409,
            PER_VAULT_ERROR_CODES.portfolioBindingMismatch,
            'A portfolio document id must equal an owned locked stub in this vault.',
          );
        case 'doc_kind_mismatch':
          throw new ApiError(
            400,
            PER_VAULT_ERROR_CODES.docKindMismatch,
            'The envelope document kind does not match its registered address.',
          );
        case 'precondition_failed':
          throw perVaultPreconditionFailed(result.currentVersion);
        case 'medium_inactive':
          throw new ApiError(
            409,
            PER_VAULT_ERROR_CODES.mediaStateConflict,
            'The server medium is not active for this vault.',
          );
        case 'too_large':
          throw new ApiError(
            413,
            PER_VAULT_ERROR_CODES.tooLarge,
            'The vault document exceeds its configured kind cap.',
          );
        case 'malformed':
          throw new ApiError(400, PER_VAULT_ERROR_CODES.malformed, result.reason);
        case 'address_mismatch':
          throw new ApiError(
            400,
            PER_VAULT_ERROR_CODES.docAddressMismatch,
            'The envelope vaultId/docId does not match the request path.',
          );
      }
    },
  );

  router.get(
    '/:vaultId/docs/:docId/history',
    validateParams(vaultDocParamsSchema),
    validateQuery(vaultHistoryListQuerySchema),
    async (req, res) => {
      const { vaultId, docId } = req.valid?.params as VaultDocParams;
      const result = await ctx.vaults.listHistory(
        req.authUser!.id,
        vaultId,
        docId,
        req.valid?.query as VaultHistoryListQuery,
      );
      if (result.status === 'not_found') throw perVaultNotFound();
      res.setHeader('Cache-Control', 'private, no-store');
      res.json(vaultHistoryListResponseSchema.parse(result.page));
    },
  );

  router.get(
    '/:vaultId/docs/:docId/history/:version',
    validateParams(vaultDocHistoryVersionParamSchema),
    async (req, res) => {
      const { vaultId, docId, version } = req.valid?.params as VaultDocHistoryVersionParam;
      const result = await ctx.vaults.getHistory(req.authUser!.id, vaultId, docId, version);
      if (result.status === 'not_found') throw perVaultNotFound();
      res.setHeader('ETag', vaultEtag(result.value.version));
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Type', VAULT_CONTENT_TYPE);
      res.setHeader(VAULT_HISTORY_CREATED_AT_HEADER, result.value.createdAt.toISOString());
      res.setHeader(VAULT_HISTORY_SIZE_BYTES_HEADER, String(result.value.sizeBytes));
      res.setHeader(VAULT_HISTORY_MEDIUM_HEADER, 'server');
      res.status(200).send(result.value.blob);
    },
  );

  router.get('/:vaultId/media', validateParams(vaultIdParamSchema), async (req, res) => {
    const { vaultId } = req.valid?.params as VaultIdParam;
    const state = await ctx.vaults.getMediaState(req.authUser!.id, vaultId);
    if (!state) throw perVaultNotFound();
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(perVaultMediaStateResponseSchema.parse(state));
  });

  router.patch(
    '/:vaultId/media',
    validateParams(vaultIdParamSchema),
    validateBody(perVaultMediaTransitionRequestSchema),
    async (req, res) => {
      const { vaultId } = req.valid?.params as VaultIdParam;
      const result = await ctx.vaults.transitionMedia(
        req.authUser!.id,
        vaultId,
        req.valid?.body as PerVaultMediaTransitionRequest,
        req.ip,
      );
      switch (result.status) {
        case 'ok':
          res.setHeader('Cache-Control', 'private, no-store');
          res.json(perVaultMediaTransitionResponseSchema.parse(result.state));
          return;
        case 'not_found':
          throw perVaultNotFound();
        case 'reserved_medium':
          throw new ApiError(400, PER_VAULT_ERROR_CODES.reservedMedium, 'Local media is reserved.');
        case 'state_conflict':
        case 'drive_not_found':
          throw new ApiError(
            409,
            result.status === 'drive_not_found'
              ? PER_VAULT_ERROR_CODES.driveBindingInvalid
              : PER_VAULT_ERROR_CODES.mediaStateConflict,
            'The media state or Drive binding changed before this transition committed.',
          );
        case 'partial_set':
          throw new ApiError(
            412,
            PER_VAULT_ERROR_CODES.mediaPartialSet,
            'Every live vault document must be verified in one transition batch.',
          );
        case 'verification_failed':
          throw new ApiError(
            412,
            PER_VAULT_ERROR_CODES.mediaVerificationFailed,
            'The full-document-set readback is absent, stale, or invalid.',
          );
        case 'retirement_conflict':
          throw new ApiError(
            409,
            PER_VAULT_ERROR_CODES.retirementConflict,
            'Retained server bytes conflict with this media transition.',
          );
        case 'retirement_pending':
          throw new ApiError(
            409,
            PER_VAULT_ERROR_CODES.deleteRetirementPending,
            'The retired server set must pass the signed purge gate before server is re-added.',
          );
      }
    },
  );

  router.put(
    '/:vaultId/media/server-candidate/:transitionId/docs/:docId',
    validateParams(perVaultServerCandidateStageParamsSchema),
    parseRawDocument,
    async (req, res) => {
      const { vaultId, transitionId, docId } = req.valid
        ?.params as PerVaultServerCandidateStageParams;
      const result = await ctx.vaults.stageServerCandidate({
        userId: req.authUser!.id,
        vaultId,
        transitionId,
        docId,
        blob: requireRawEnvelope(req),
      });
      switch (result.status) {
        case 'ok':
          res.setHeader('Cache-Control', 'private, no-store');
          res.json(perVaultServerCandidateMetadataSchema.parse(result.candidate));
          return;
        case 'not_found':
          throw perVaultNotFound();
        case 'portfolio_binding_mismatch':
          throw new ApiError(
            409,
            PER_VAULT_ERROR_CODES.portfolioBindingMismatch,
            'A portfolio document id must equal an owned locked stub in this vault.',
          );
        case 'doc_kind_mismatch':
          throw new ApiError(400, PER_VAULT_ERROR_CODES.docKindMismatch, 'Document kind mismatch.');
        case 'state_conflict':
          throw new ApiError(
            409,
            PER_VAULT_ERROR_CODES.mediaStateConflict,
            'Candidates can be staged only for a Drive-only vault.',
          );
        case 'too_large':
          throw new ApiError(
            413,
            PER_VAULT_ERROR_CODES.tooLarge,
            'Candidate exceeds its kind cap.',
          );
        case 'malformed':
          throw new ApiError(400, PER_VAULT_ERROR_CODES.malformed, result.reason);
        case 'address_mismatch':
          throw new ApiError(
            400,
            PER_VAULT_ERROR_CODES.docAddressMismatch,
            'The envelope vaultId/docId does not match the request path.',
          );
      }
    },
  );

  router.get(
    '/:vaultId/media/server-candidate/:candidateId',
    validateParams(perVaultServerCandidateReadParamsSchema),
    async (req, res) => {
      const { vaultId, candidateId } = req.valid?.params as PerVaultServerCandidateReadParams;
      const candidate = await ctx.vaults.getServerCandidate(req.authUser!.id, vaultId, candidateId);
      if (!candidate) {
        throw notFound(
          'No active server candidate found.',
          PER_VAULT_ERROR_CODES.serverCandidateNotFound,
        );
      }
      const readback = ctx.vaults.issueCandidateReadback(req.authUser!.id, vaultId, candidate);
      if (!readback) {
        throw new ApiError(
          409,
          PER_VAULT_ERROR_CODES.retirementProofInvalid,
          'Candidate proof issuance is unavailable.',
        );
      }
      res.setHeader('ETag', vaultEtag(candidate.version));
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Type', VAULT_CONTENT_TYPE);
      res.setHeader(VAULT_SERVER_CANDIDATE_ID_HEADER, candidate.id);
      res.setHeader(VAULT_SERVER_CANDIDATE_EXPIRES_AT_HEADER, candidate.expiresAt.toISOString());
      res.setHeader(VAULT_SERVER_CANDIDATE_READBACK_HEADER, readback);
      res.status(200).send(candidate.blob);
    },
  );

  router.post(
    '/:vaultId/media/retired/purge/challenge',
    validateParams(vaultIdParamSchema),
    validateBody(perVaultRetiredServerPurgeChallengeRequestSchema),
    async (req, res) => {
      const { vaultId } = req.valid?.params as VaultIdParam;
      const result = await ctx.vaults.prepareRetiredPurge(
        req.authUser!.id,
        vaultId,
        req.valid?.body as PerVaultRetiredServerPurgeChallengeRequest,
      );
      switch (result.status) {
        case 'ok':
          res.setHeader('Cache-Control', 'private, no-store');
          res.json(perVaultRetiredServerPurgeChallengeResponseSchema.parse(result.challenge));
          return;
        case 'not_found':
          throw perVaultNotFound();
        case 'state_conflict':
          throw new ApiError(
            409,
            PER_VAULT_ERROR_CODES.mediaStateConflict,
            'The retirement generation or version-set hash is stale.',
          );
        case 'proof_unavailable':
          throw new ApiError(
            409,
            PER_VAULT_ERROR_CODES.retirementProofInvalid,
            'Retirement proof issuance is unavailable.',
          );
      }
    },
  );

  router.post(
    '/:vaultId/media/retired/purge',
    validateParams(vaultIdParamSchema),
    validateBody(perVaultRetiredServerPurgeRequestSchema),
    async (req, res) => {
      const { vaultId } = req.valid?.params as VaultIdParam;
      const result = await ctx.vaults.purgeRetired(
        req.authUser!.id,
        vaultId,
        req.valid?.body as PerVaultRetiredServerPurgeRequest,
        req.ip,
      );
      switch (result.status) {
        case 'ok':
          res.setHeader('Cache-Control', 'private, no-store');
          res.json(
            perVaultRetiredServerPurgeResponseSchema.parse({
              purged: true,
              vaultId,
              generation: (req.valid?.body as PerVaultRetiredServerPurgeRequest).generation,
              versionSetHash: (req.valid?.body as PerVaultRetiredServerPurgeRequest).versionSetHash,
            }),
          );
          return;
        case 'not_found':
          throw perVaultNotFound();
        case 'state_conflict':
          throw new ApiError(
            409,
            PER_VAULT_ERROR_CODES.mediaStateConflict,
            'The retirement set or server-medium state is no longer current.',
          );
        case 'partial_set':
          throw new ApiError(
            412,
            PER_VAULT_ERROR_CODES.mediaPartialSet,
            'Fresh other-medium readback must cover the complete current doc roster.',
          );
        case 'retention_pending':
          throw new ApiError(
            409,
            PER_VAULT_ERROR_CODES.retirementRetention,
            'The retired server recovery window has not elapsed.',
            { purgeAfter: result.purgeAfter.toISOString() },
          );
        case 'proof_invalid':
          throw new ApiError(
            412,
            PER_VAULT_ERROR_CODES.retirementProofInvalid,
            'The purge proof is malformed, forged, expired, or stale.',
          );
      }
    },
  );

  return router;
}
