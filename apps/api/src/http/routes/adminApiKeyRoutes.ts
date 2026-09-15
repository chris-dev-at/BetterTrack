import { type Request, type Router } from 'express';

import {
  adminApiKeyListQuerySchema,
  adminApiKeyListResponseSchema,
  adminApiKeySchema,
  apiKeyAuditResponseSchema,
  apiKeyTierListResponseSchema,
  apiKeyTierSchema,
  assignApiKeyTierRequestSchema,
  createApiKeyTierRequestSchema,
  idParamSchema,
  updateApiKeyTierRequestSchema,
  type AdminApiKeyListQuery,
  type AssignApiKeyTierRequest,
  type CreateApiKeyTierRequest,
  type UpdateApiKeyTierRequest,
} from '@bettertrack/contracts';

import type { ApiKeyAdminActor } from '../../services/apiKeys/apiKeyService';
import type { AppContext } from '../context';
import { validateBody, validateParams, validateQuery } from '../middleware/validate';

const actorOf = (req: Request): ApiKeyAdminActor => ({ id: req.authUser!.id, ip: req.ip });

/**
 * Admin API-key governance endpoints (§13.5 V5-P10, issue 2/2). Registered FLAT
 * onto the admin router (not a nested sub-router — the OpenAPI coverage checker
 * only reconstructs top-level mounts), AFTER the {@link requireAdminTwoFactor}
 * gate. `requireAdmin` on the parent router fences these to admins (404 to
 * everyone else). Two surfaces:
 *
 * - `/admin/api-key-tiers` — CRUD over the admin-configurable rate tiers
 *   (name/limit/window; exactly one default).
 * - `/admin/api-keys` — list every user's keys, (re)assign a key's tier, and
 *   read a key's bounded, PII-scrubbed request-log audit trail.
 */
export function registerAdminApiKeyRoutes(router: Router, ctx: AppContext): void {
  router.get('/api-key-tiers', async (_req, res) => {
    res.json(apiKeyTierListResponseSchema.parse({ tiers: await ctx.apiKeys.listTiers() }));
  });

  router.post('/api-key-tiers', validateBody(createApiKeyTierRequestSchema), async (req, res) => {
    const body = req.valid?.body as CreateApiKeyTierRequest;
    const tier = await ctx.apiKeys.createTier(body, actorOf(req));
    res.status(201).json(apiKeyTierSchema.parse(tier));
  });

  router.patch(
    '/api-key-tiers/:id',
    validateParams(idParamSchema),
    validateBody(updateApiKeyTierRequestSchema),
    async (req, res) => {
      const { id } = req.valid?.params as { id: string };
      const body = req.valid?.body as UpdateApiKeyTierRequest;
      const tier = await ctx.apiKeys.updateTier(id, body, actorOf(req));
      res.json(apiKeyTierSchema.parse(tier));
    },
  );

  router.delete('/api-key-tiers/:id', validateParams(idParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    await ctx.apiKeys.deleteTier(id, actorOf(req));
    res.status(204).end();
  });

  // Bounded since V5-P2 (#1814): an over-large `limit`/`offset` is refused by
  // the contract exactly as the users list refuses one, and revoked keys stay
  // out of the window unless `includeRevoked=true` asks for them.
  router.get('/api-keys', validateQuery(adminApiKeyListQuerySchema), async (req, res) => {
    const query = req.valid?.query as AdminApiKeyListQuery;
    const { keys, total } = await ctx.apiKeys.listKeysPage(query);
    res.json(
      adminApiKeyListResponseSchema.parse({
        keys,
        page: { total, limit: query.limit, offset: query.offset },
      }),
    );
  });

  router.patch(
    '/api-keys/:id/tier',
    validateParams(idParamSchema),
    validateBody(assignApiKeyTierRequestSchema),
    async (req, res) => {
      const { id } = req.valid?.params as { id: string };
      const { tierId } = req.valid?.body as AssignApiKeyTierRequest;
      const key = await ctx.apiKeys.assignTier(id, tierId, actorOf(req));
      res.json(adminApiKeySchema.parse(key));
    },
  );

  router.get('/api-keys/:id/audit', validateParams(idParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    res.json(apiKeyAuditResponseSchema.parse(await ctx.apiKeys.keyAudit(id)));
  });
}
