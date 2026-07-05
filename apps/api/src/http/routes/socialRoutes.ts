import { Router } from 'express';
import { z } from 'zod';

import {
  conglomerateIdParamSchema,
  createFriendRequestRequestSchema,
  idParamSchema,
  portfolioIdParamSchema,
  type CreateFriendRequestRequest,
} from '@bettertrack/contracts';

import type { RateLimiters } from '../middleware/rateLimit';
import { requireUser } from '../middleware/session';
import { validateBody, validateParams } from '../middleware/validate';
import type { AppContext } from '../context';

/**
 * Social endpoints (PROJECTPLAN.md §6.9): friend requests + friendships.
 * Handlers stay thin (parse → service → respond); the no-enumeration and
 * 404-never-403 rules live in the service. Bell notifications are P6.
 *
 * `POST /requests` always answers with the same `{ ok: true }` — whether the
 * target exists, doesn't, or is yourself — so the endpoint reveals nothing
 * about who has an account.
 */
const userIdParamSchema = z.object({ userId: z.string().uuid() }).strict();

export function createSocialRouter(ctx: AppContext, limiters: RateLimiters): Router {
  const router = Router();

  router.use(requireUser);

  // POST /social/requests — request a friend by username or email (no-enumeration).
  // Rate-limited per user (§6.9, §10): sending a request creates an outbox row that
  // reveals the target's username, so bulk email→username probing must be costly.
  router.post(
    '/requests',
    limiters.social,
    validateBody(createFriendRequestRequestSchema),
    async (req, res) => {
      const { identifier } = req.valid?.body as CreateFriendRequestRequest;
      await ctx.social.sendRequest(req.authUser!.id, identifier);
      res.status(202).json({ ok: true });
    },
  );

  // GET /social/requests — the caller's pending incoming + outgoing requests.
  router.get('/requests', async (req, res) => {
    const result = await ctx.social.listRequests(req.authUser!.id);
    res.json(result);
  });

  // POST /social/requests/:id/accept — recipient accepts → forms a friendship.
  router.post('/requests/:id/accept', validateParams(idParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    await ctx.social.accept(req.authUser!.id, id);
    res.json({ ok: true });
  });

  // POST /social/requests/:id/decline — recipient declines (terminal).
  router.post('/requests/:id/decline', validateParams(idParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    await ctx.social.decline(req.authUser!.id, id);
    res.json({ ok: true });
  });

  // POST /social/requests/:id/cancel — sender withdraws their pending request.
  router.post('/requests/:id/cancel', validateParams(idParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    await ctx.social.cancel(req.authUser!.id, id);
    res.json({ ok: true });
  });

  // GET /social/friends — the caller's friends.
  router.get('/friends', async (req, res) => {
    const result = await ctx.social.listFriends(req.authUser!.id);
    res.json(result);
  });

  // DELETE /social/friends/:userId — remove a friendship (either side may).
  router.delete('/friends/:userId', validateParams(userIdParamSchema), async (req, res) => {
    const { userId } = req.valid?.params as { userId: string };
    await ctx.social.removeFriend(req.authUser!.id, userId);
    res.status(204).send();
  });

  // GET /social/shared — friends' portfolios shared with me (visibility=friends).
  router.get('/shared', async (req, res) => {
    const result = await ctx.social.listSharedWithMe(req.authUser!.id);
    res.json(result);
  });

  // GET /social/shared/conglomerates/:conglomerateId — read-only view of a
  // friend-shared conglomerate. Registered before /shared/:portfolioId so its
  // two-segment path is never mistaken for a portfolio id. 404 (never 403) for a
  // non-friend / private / unknown basket, recomputed per request (§6.9, V2-P9).
  router.get(
    '/shared/conglomerates/:conglomerateId',
    validateParams(conglomerateIdParamSchema),
    async (req, res) => {
      const { conglomerateId } = req.valid?.params as { conglomerateId: string };
      const result = await ctx.social.getSharedConglomerate(req.authUser!.id, conglomerateId);
      res.json(result);
    },
  );

  // GET /social/shared/watchlists/:userId — read-only view of a friend's shared
  // watchlist. 404 (never 403) for a non-friend / not-sharing / unknown owner,
  // recomputed per request (§6.9, V2-P9).
  router.get('/shared/watchlists/:userId', validateParams(userIdParamSchema), async (req, res) => {
    const { userId } = req.valid?.params as { userId: string };
    const result = await ctx.social.getSharedWatchlist(req.authUser!.id, userId);
    res.json(result);
  });

  // GET /social/shared/:portfolioId — read-only overview of a friend-shared portfolio.
  // A non-friend / private / unknown portfolio 404s (never 403), recomputed per request.
  router.get('/shared/:portfolioId', validateParams(portfolioIdParamSchema), async (req, res) => {
    const { portfolioId } = req.valid?.params as { portfolioId: string };
    const result = await ctx.social.getSharedPortfolio(req.authUser!.id, portfolioId);
    res.json(result);
  });

  // GET /social/my-shared — my own portfolios currently at visibility=friends (toggle-off list).
  router.get('/my-shared', async (req, res) => {
    const result = await ctx.social.listMyShared(req.authUser!.id);
    res.json(result);
  });

  return router;
}
