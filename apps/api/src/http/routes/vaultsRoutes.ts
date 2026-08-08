import express, { Router, type RequestHandler } from 'express';
import { z } from 'zod';

import {
  createVaultRequestSchema,
  parseVaultEtag,
  scopeSatisfies,
  updateVaultRequestSchema,
  VAULT2_ERROR_CODES,
  VAULT_CONTENT_TYPE,
  VAULT_COMMON_DOC_MAX_BYTES,
  VAULT_HEADER_MAX_BYTES,
  VAULT_PORTFOLIO_DOC_MAX_BYTES,
  vaultMigrationClaimRequestSchema,
  vaultMigrationFlipRequestSchema,
  vaultMigrationStateSchema,
  vaultCreateResponseSchema,
  vaultDocMetadataSchema,
  vaultEtag,
  vaultListResponseSchema,
  vaultSchema,
  vaultSyncListResponseSchema,
  type CreateVaultRequest,
  type UpdateVaultRequest,
  type VaultMigrationClaimRequest,
  type VaultMigrationFlipRequest,
} from '@bettertrack/contracts';

import { ApiError, EnvelopeApiError, forbidden } from '../../errors';
import { VAULT_SYNC_SCOPE, vaultsSyncRouteAcceptsBearer } from '../middleware/bearerAuth';
import { requireUser } from '../middleware/session';
import { validateBody, validateParams } from '../middleware/validate';

import type { VaultDocSelector } from '../../data/repositories/vaultRepository';
import type { AppContext } from '../context';
import type { RateLimiters } from '../middleware/rateLimit';

/**
 * Vaults v2 HTTP surface (`docs/VAULTS_V2_DESIGN.md` §3), mounted at
 * `/api/v1/vaults`. Deliberately a SEPARATE mount from the legacy
 * `/api/v1/vault` account-singleton routes, which keep serving unchanged for
 * the migration window.
 *
 * Bearer policy: a `vault:sync` token may LIST vaults and GET/PUT their opaque
 * documents. Every transition — create, rename/re-back, delete, join, leave —
 * stays owning-browser-session-only, the same principle the account-level vault
 * already enforces (#1043) and for the same reason: a transition is destructive
 * and a sync token exists only to move already-encrypted bytes.
 */

/**
 * Mount path of the create route, exported for `app.ts`'s body-parser deferral:
 * the client-built header rides inline as base64 and its 1 MiB cap inflates
 * past the 100 KiB global JSON bound.
 */
export const VAULTS_CREATE_HTTP_PATH = '/api/v1/vaults';

const vaultIdParamSchema = z.object({ vaultId: z.string().uuid() }).strict();
const vaultPortfolioParamSchema = z
  .object({ vaultId: z.string().uuid(), portfolioId: z.string().uuid() })
  .strict();

const preconditionRequired = (): ApiError =>
  new ApiError(
    428,
    VAULT2_ERROR_CODES.preconditionRequired,
    'A vault document write requires an If-Match (replace) or If-None-Match: * (create) precondition.',
  );

/**
 * A malformed `If-Match`. Design r2 §15 requires `currentVersion` on every CAS
 * 412; the header never named a real version here, so it is reported as `null`
 * rather than being omitted — the field's presence is the contract.
 */
const versionConflict = (): ApiError =>
  new EnvelopeApiError(
    412,
    VAULT2_ERROR_CODES.versionConflict,
    'The If-Match precondition is not a valid vault version.',
    { currentVersion: null },
  );

const docTooLarge = (): ApiError =>
  new ApiError(
    413,
    VAULT2_ERROR_CODES.docTooLarge,
    'The ciphertext exceeds the configured size cap for this document kind.',
  );

/**
 * Router-local defense in depth, the exact analogue of the account vault's
 * `requireCookieSessionOrVaultSync`. It is route-aware AND scope-aware, so
 * neither a remount nor a regression in the global policy table can hand a
 * transition to a bearer, and an unrelated scope can never reach the vault.
 */
export const requireCookieSessionOrVaultsSync: RequestHandler = (req, _res, next) => {
  const bearerSyncAllowed =
    req.apiKey !== undefined &&
    scopeSatisfies(req.apiKey.scopes, VAULT_SYNC_SCOPE) &&
    vaultsSyncRouteAcceptsBearer(
      req.method,
      `/vaults${req.path === '/' || req.path === '' ? '' : req.path}`,
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

/** Session-only guard for the transition half of this router. */
const requireOwnerSession: RequestHandler = (req, _res, next) => {
  if (req.apiKey) {
    next(forbidden('This endpoint is not accessible with an API key.', 'API_KEY_FORBIDDEN'));
    return;
  }
  next();
};

/** Read the CAS precondition off a document write, or refuse the write. */
function expectedVersionOf(req: Parameters<RequestHandler>[0]): number | null {
  const ifNoneMatch = (req.headers['if-none-match'] as string | undefined)?.trim();
  if (ifNoneMatch === '*') return null;
  const ifMatch = req.headers['if-match'] as string | undefined;
  if (ifMatch === undefined) throw preconditionRequired();
  const parsed = parseVaultEtag(ifMatch);
  if (parsed === null || parsed < 1) throw versionConflict();
  return parsed;
}

function requireRawCiphertext(req: Parameters<RequestHandler>[0]): Buffer {
  const bytes = Buffer.isBuffer(req.body) ? req.body : null;
  if (!bytes || bytes.length === 0) {
    throw new ApiError(
      400,
      VAULT2_ERROR_CODES.restoreInvalid,
      'The vault document write body must be non-empty ciphertext.',
    );
  }
  return bytes;
}

/**
 * Raw ciphertext body parser. Its own limit is the LARGER of the two document
 * caps — the exact per-kind cap is applied by the service, and a third time by
 * the `vault_docs_size_cap` CHECK constraint, so an oversized header still 413s
 * with the right number rather than being silently accepted at 8 MiB.
 */
function rawCiphertextBody(): RequestHandler {
  const parser = express.raw({
    type: () => true,
    limit: Math.max(
      VAULT_HEADER_MAX_BYTES,
      VAULT_COMMON_DOC_MAX_BYTES,
      VAULT_PORTFOLIO_DOC_MAX_BYTES,
    ),
  });
  return (req, res, next) => {
    parser(req, res, (err?: unknown) => {
      if (err) {
        next((err as { type?: string }).type === 'entity.too.large' ? docTooLarge() : err);
        return;
      }
      next();
    });
  };
}

export function createVaultsRouter(ctx: AppContext, limiters: RateLimiters): Router {
  const router = Router();
  const rawCiphertext = rawCiphertextBody();

  router.use(requireUser, requireCookieSessionOrVaultsSync);

  // ── List (session + `vault:sync` bearer) ──────────────────────────────────
  router.get('/', async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.apiKey) {
      // The narrow sync projection: ids + names + backends only (§3).
      res.json(
        vaultSyncListResponseSchema.parse({
          vaults: await ctx.vaults.listForSync(req.authUser!.id),
        }),
      );
      return;
    }
    res.json(vaultListResponseSchema.parse({ vaults: await ctx.vaults.list(req.authUser!.id) }));
  });

  // ── v1 → v2 migration protocol (r2 §11, owning browser session only) ──────
  // Mounted BEFORE the `/:vaultId` routes so the literal `migration` segment can
  // never be read as a vault id. Every step is session-only for the same reason
  // the account-level transitions are: the flip is a one-way commit that makes
  // the legacy vault a read-only tombstone.
  router.get('/migration', requireOwnerSession, async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(vaultMigrationStateSchema.parse(await ctx.vaults.migrationState(req.authUser!.id)));
  });

  router.post(
    '/migration/claim',
    requireOwnerSession,
    limiters.vault,
    validateBody(vaultMigrationClaimRequestSchema),
    async (req, res) => {
      const { clientNonce } = req.valid?.body as VaultMigrationClaimRequest;
      const state = await ctx.vaults.claimMigration(req.authUser!.id, clientNonce);
      res.setHeader('Cache-Control', 'private, no-store');
      res.json(vaultMigrationStateSchema.parse(state));
    },
  );

  router.post(
    '/migration/renew',
    requireOwnerSession,
    limiters.vault,
    validateBody(vaultMigrationClaimRequestSchema),
    async (req, res) => {
      const { clientNonce } = req.valid?.body as VaultMigrationClaimRequest;
      const state = await ctx.vaults.renewMigration(req.authUser!.id, clientNonce);
      res.setHeader('Cache-Control', 'private, no-store');
      res.json(vaultMigrationStateSchema.parse(state));
    },
  );

  router.post(
    '/migration/flip',
    requireOwnerSession,
    limiters.vault,
    validateBody(vaultMigrationFlipRequestSchema),
    async (req, res) => {
      const body = req.valid?.body as VaultMigrationFlipRequest;
      const state = await ctx.vaults.flipMigration(
        req.authUser!.id,
        body.clientNonce,
        body.vaultId,
        req.ip ?? null,
      );
      res.setHeader('Cache-Control', 'private, no-store');
      res.json(vaultMigrationStateSchema.parse(state));
    },
  );

  // ── Transitions (owning browser session only) ─────────────────────────────
  // The deferred JSON parser for create. Bound = the header cap expanded for
  // base64 (4/3) plus room for the small metadata fields, so the 413 a client
  // sees is the CONTRACT's cap rather than an accident of transport encoding.
  const createJson = express.json({
    limit: Math.ceil((VAULT_HEADER_MAX_BYTES * 4) / 3) + 8 * 1024,
  });

  router.post(
    '/',
    requireOwnerSession,
    limiters.vault,
    createJson,
    validateBody(createVaultRequestSchema),
    async (req, res) => {
      const result = await ctx.vaults.create(
        req.authUser!.id,
        req.valid?.body as CreateVaultRequest,
        req.ip ?? null,
      );
      res.status(201).json(vaultCreateResponseSchema.parse(result));
    },
  );

  router.patch(
    '/:vaultId',
    requireOwnerSession,
    validateParams(vaultIdParamSchema),
    validateBody(updateVaultRequestSchema),
    async (req, res) => {
      const { vaultId } = req.valid?.params as { vaultId: string };
      const vault = await ctx.vaults.update(
        req.authUser!.id,
        vaultId,
        req.valid?.body as UpdateVaultRequest,
        req.ip ?? null,
      );
      res.json(vaultSchema.parse(vault));
    },
  );

  router.delete(
    '/:vaultId',
    requireOwnerSession,
    validateParams(vaultIdParamSchema),
    async (req, res) => {
      const { vaultId } = req.valid?.params as { vaultId: string };
      await ctx.vaults.remove(req.authUser!.id, vaultId, req.ip ?? null);
      res.status(204).send();
    },
  );

  // ── Opaque documents (session + `vault:sync` bearer, If-Match CAS) ─────────
  const readDoc =
    (selectorOf: (params: Record<string, string>) => VaultDocSelector): RequestHandler =>
    async (req, res) => {
      const params = req.valid?.params as Record<string, string>;
      const result = await ctx.vaults.readDoc(
        req.authUser!.id,
        params.vaultId!,
        selectorOf(params),
      );
      res.setHeader('ETag', vaultEtag(result.version));
      res.setHeader('Cache-Control', 'private, no-store');
      const ifNoneMatch = parseVaultEtag(req.headers['if-none-match'] as string | undefined);
      if (ifNoneMatch !== null && ifNoneMatch === result.version) {
        res.status(304).end();
        return;
      }
      res.setHeader('Content-Type', VAULT_CONTENT_TYPE);
      res.status(200).send(result.ciphertext);
    };

  const writeDoc =
    (selectorOf: (params: Record<string, string>) => VaultDocSelector): RequestHandler =>
    async (req, res) => {
      const params = req.valid?.params as Record<string, string>;
      const ciphertext = requireRawCiphertext(req);
      const doc = await ctx.vaults.writeDoc({
        userId: req.authUser!.id,
        vaultId: params.vaultId!,
        selector: selectorOf(params),
        expectedVersion: expectedVersionOf(req),
        ciphertext,
      });
      res.setHeader('ETag', vaultEtag(doc.version));
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json(vaultDocMetadataSchema.parse(doc));
    };

  router.get(
    '/:vaultId/header',
    validateParams(vaultIdParamSchema),
    readDoc(() => ({ kind: 'header' })),
  );

  router.put(
    '/:vaultId/header',
    limiters.vault,
    validateParams(vaultIdParamSchema),
    rawCiphertext,
    writeDoc(() => ({ kind: 'header' })),
  );

  router.get(
    '/:vaultId/common',
    validateParams(vaultIdParamSchema),
    readDoc(() => ({ kind: 'common' })),
  );

  router.put(
    '/:vaultId/common',
    limiters.vault,
    validateParams(vaultIdParamSchema),
    rawCiphertext,
    writeDoc(() => ({ kind: 'common' })),
  );

  router.get(
    '/:vaultId/portfolios/:portfolioId',
    validateParams(vaultPortfolioParamSchema),
    readDoc((params) => ({ kind: 'portfolio', portfolioId: params.portfolioId! })),
  );

  router.put(
    '/:vaultId/portfolios/:portfolioId',
    limiters.vault,
    validateParams(vaultPortfolioParamSchema),
    rawCiphertext,
    writeDoc((params) => ({ kind: 'portfolio', portfolioId: params.portfolioId! })),
  );

  return router;
}
