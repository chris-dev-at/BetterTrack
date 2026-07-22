import { Router } from 'express';

import {
  convertMirrorChainRequestSchema,
  createMirrorChainRequestSchema,
  inviteMirrorMemberRequestSchema,
  mirrorActivityQuerySchema,
  mirrorChainIdParamSchema,
  mirrorInviteIdParamSchema,
  mirrorMemberParamSchema,
  renameMirrorChainRequestSchema,
  setMirrorMemberRoleRequestSchema,
  transferMirrorOwnershipRequestSchema,
  type ConvertMirrorChainRequest,
  type CreateMirrorChainRequest,
  type InviteMirrorMemberRequest,
  type MirrorActivityQuery,
  type MirrorChainIdParam,
  type MirrorInviteIdParam,
  type MirrorMemberParam,
  type RenameMirrorChainRequest,
  type SetMirrorMemberRoleRequest,
  type TransferMirrorOwnershipRequest,
} from '@bettertrack/contracts';

import type { RateLimiters } from '../middleware/rateLimit';
import { requireUser } from '../middleware/session';
import { validateBody, validateParams, validateQuery } from '../middleware/validate';
import type { AppContext } from '../context';

/**
 * MIRRORCHAIN group-portfolio membership API (§13.5 V5-P7 M3;
 * `docs/mirrorchain-design.md` §§4–7, §11). Thin handlers — every rule (the §5
 * authority matrix, friends-only invites, the member cap, kick/leave → fork, the
 * §7 owner-refusal stopgap) lives in `mirrorService`. Session-only (cookie auth
 * via `requireUser`); no bearer scope. The eight `mirror.*` notifications and the
 * per-copy content writes are wired elsewhere (the dispatcher + the §1 seam);
 * this router is the chain-lifecycle surface only.
 */
const DEFAULT_ACTIVITY_LIMIT = 30;

export function createMirrorchainRouter(ctx: AppContext, limiters: RateLimiters): Router {
  const router = Router();
  router.use(requireUser);

  // GET /mirrorchain/chains — the caller's active group-portfolio summaries
  // (the portfolio switcher's group rows, with per-copy sync state).
  router.get('/chains', async (req, res) => {
    const chains = await ctx.mirror.listChainsForUser(req.authUser!.id);
    res.json({ chains });
  });

  // POST /mirrorchain/chains — "new group portfolio": a fresh empty copy (§11).
  router.post('/chains', validateBody(createMirrorChainRequestSchema), async (req, res) => {
    const { name } = req.valid?.body as CreateMirrorChainRequest;
    const summary = await ctx.mirror.createChain(req.authUser!.id, name);
    res.status(201).json(summary);
  });

  // POST /mirrorchain/chains/convert — "make this a group portfolio" (§2 genesis).
  router.post(
    '/chains/convert',
    validateBody(convertMirrorChainRequestSchema),
    async (req, res) => {
      const { portfolioId, name } = req.valid?.body as ConvertMirrorChainRequest;
      const summary = await ctx.mirror.convertChain(req.authUser!.id, portfolioId, { name });
      res.status(201).json(summary);
    },
  );

  // GET /mirrorchain/invites — the caller's pending invites in + out (§4).
  router.get('/invites', async (req, res) => {
    const result = await ctx.mirror.listInvites(req.authUser!.id);
    res.json(result);
  });

  // POST /mirrorchain/invites/:inviteId/accept — the §4 one-screen acceptance:
  // the copy is materialized immediately and replay is enqueued.
  router.post(
    '/invites/:inviteId/accept',
    validateParams(mirrorInviteIdParamSchema),
    async (req, res) => {
      const { inviteId } = req.valid?.params as MirrorInviteIdParam;
      const result = await ctx.mirror.acceptInvite(req.authUser!.id, inviteId);
      res.json(result);
    },
  );

  // POST /mirrorchain/invites/:inviteId/decline — decline (a re-invite is allowed).
  router.post(
    '/invites/:inviteId/decline',
    validateParams(mirrorInviteIdParamSchema),
    async (req, res) => {
      const { inviteId } = req.valid?.params as MirrorInviteIdParam;
      await ctx.mirror.declineInvite(req.authUser!.id, inviteId);
      res.json({ ok: true });
    },
  );

  // POST /mirrorchain/invites/:inviteId/revoke — owner + managers revoke (§4).
  router.post(
    '/invites/:inviteId/revoke',
    validateParams(mirrorInviteIdParamSchema),
    async (req, res) => {
      const { inviteId } = req.valid?.params as MirrorInviteIdParam;
      await ctx.mirror.revokeInvite(req.authUser!.id, inviteId);
      res.json({ ok: true });
    },
  );

  // GET /mirrorchain/chains/:chainId/members — the member sheet (§11). A severed
  // (non-active) member 404s.
  router.get(
    '/chains/:chainId/members',
    validateParams(mirrorChainIdParamSchema),
    async (req, res) => {
      const { chainId } = req.valid?.params as MirrorChainIdParam;
      const result = await ctx.mirror.getMemberList(req.authUser!.id, chainId);
      res.json(result);
    },
  );

  // GET /mirrorchain/chains/:chainId/activity — the activity feed, newest-first,
  // paginated by `before` seq (§6/§11).
  router.get(
    '/chains/:chainId/activity',
    validateParams(mirrorChainIdParamSchema),
    validateQuery(mirrorActivityQuerySchema),
    async (req, res) => {
      const { chainId } = req.valid?.params as MirrorChainIdParam;
      const { before, limit } = req.valid?.query as MirrorActivityQuery;
      const result = await ctx.mirror.getActivity(req.authUser!.id, chainId, {
        before,
        limit: limit ?? DEFAULT_ACTIVITY_LIMIT,
      });
      res.json(result);
    },
  );

  // POST /mirrorchain/chains/:chainId/invites — invite a friend (owner + managers,
  // §5). Rate-limited like friend requests (the §4 spam guard).
  router.post(
    '/chains/:chainId/invites',
    limiters.social,
    validateParams(mirrorChainIdParamSchema),
    validateBody(inviteMirrorMemberRequestSchema),
    async (req, res) => {
      const { chainId } = req.valid?.params as MirrorChainIdParam;
      const { userId } = req.valid?.body as InviteMirrorMemberRequest;
      await ctx.mirror.inviteMember(req.authUser!.id, chainId, userId);
      res.status(202).json({ ok: true });
    },
  );

  // PATCH /mirrorchain/chains/:chainId — rename the chain (owner + managers, §5).
  router.patch(
    '/chains/:chainId',
    validateParams(mirrorChainIdParamSchema),
    validateBody(renameMirrorChainRequestSchema),
    async (req, res) => {
      const { chainId } = req.valid?.params as MirrorChainIdParam;
      const { name } = req.valid?.body as RenameMirrorChainRequest;
      const summary = await ctx.mirror.renameChain(req.authUser!.id, chainId, name);
      res.json(summary);
    },
  );

  // POST /mirrorchain/chains/:chainId/transfer — transfer ownership (owner-only,
  // §5): the old owner becomes a plain member.
  router.post(
    '/chains/:chainId/transfer',
    validateParams(mirrorChainIdParamSchema),
    validateBody(transferMirrorOwnershipRequestSchema),
    async (req, res) => {
      const { chainId } = req.valid?.params as MirrorChainIdParam;
      const { toUserId } = req.valid?.body as TransferMirrorOwnershipRequest;
      await ctx.mirror.transferOwnership(req.authUser!.id, chainId, toUserId);
      res.json({ ok: true });
    },
  );

  // POST /mirrorchain/chains/:chainId/leave — leave → keep an un-synced fork (§6).
  // The owner is refused with the §7 stopgap 409 until M4 ships succession.
  router.post(
    '/chains/:chainId/leave',
    validateParams(mirrorChainIdParamSchema),
    async (req, res) => {
      const { chainId } = req.valid?.params as MirrorChainIdParam;
      await ctx.mirror.leaveChain(req.authUser!.id, chainId);
      res.json({ ok: true });
    },
  );

  // DELETE /mirrorchain/chains/:chainId — dissolve (owner-only, §6): every copy
  // becomes a fork.
  router.delete('/chains/:chainId', validateParams(mirrorChainIdParamSchema), async (req, res) => {
    const { chainId } = req.valid?.params as MirrorChainIdParam;
    await ctx.mirror.dissolveChain(req.authUser!.id, chainId);
    res.status(204).send();
  });

  // PATCH /mirrorchain/chains/:chainId/members/:userId/role — grant (`manager`) /
  // revoke (`member`) manage rights (owner-only, §5).
  router.patch(
    '/chains/:chainId/members/:userId/role',
    validateParams(mirrorMemberParamSchema),
    validateBody(setMirrorMemberRoleRequestSchema),
    async (req, res) => {
      const { chainId, userId } = req.valid?.params as MirrorMemberParam;
      const { role } = req.valid?.body as SetMirrorMemberRoleRequest;
      await ctx.mirror.setMemberRole(req.authUser!.id, chainId, userId, role);
      res.json({ ok: true });
    },
  );

  // DELETE /mirrorchain/chains/:chainId/members/:userId — kick → fork (§6). The
  // removed member keeps their copy, un-synced.
  router.delete(
    '/chains/:chainId/members/:userId',
    validateParams(mirrorMemberParamSchema),
    async (req, res) => {
      const { chainId, userId } = req.valid?.params as MirrorMemberParam;
      await ctx.mirror.removeMember(req.authUser!.id, chainId, userId);
      res.status(204).send();
    },
  );

  return router;
}
