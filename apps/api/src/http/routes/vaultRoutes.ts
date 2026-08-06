import { createPublicKey } from 'node:crypto';

import express, { Router, type RequestHandler } from 'express';

import {
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
  vaultHistoryListResponseSchema,
  vaultHistoryListQuerySchema,
  vaultHistoryVersionParamSchema,
  vaultRetirementProofPublicKeySchema,
  type ParanoidMediaTransitionRequest,
  type ParanoidServerCandidateParam,
  type RetiredServerPurgeChallengeRequest,
  type RetiredServerPurgeRequest,
  type VaultHistoryListQuery,
  type VaultHistoryVersionParam,
} from '@bettertrack/contracts';

import { ApiError, forbidden, notFound } from '../../errors';

import type { AppContext } from '../context';
import { VAULT_SYNC_SCOPE, vaultSyncRouteAcceptsBearer } from '../middleware/bearerAuth';
import type { RateLimiters } from '../middleware/rateLimit';
import { requireUser } from '../middleware/session';
import { validateBody, validateParams, validateQuery } from '../middleware/validate';

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
          if (result.currentVersion !== null)
            res.setHeader('ETag', vaultEtag(result.currentVersion));
          throw preconditionFailed();
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
