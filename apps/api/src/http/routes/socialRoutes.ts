import { Router } from 'express';
import { z } from 'zod';

import {
  createFriendRequestRequestSchema,
  idParamSchema,
  type CreateFriendRequestRequest,
} from '@bettertrack/contracts';

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

export function createSocialRouter(ctx: AppContext): Router {
  const router = Router();

  router.use(requireUser);

  // POST /social/requests — request a friend by username or email (no-enumeration).
  router.post('/requests', validateBody(createFriendRequestRequestSchema), async (req, res) => {
    const { identifier } = req.valid?.body as CreateFriendRequestRequest;
    await ctx.social.sendRequest(req.authUser!.id, identifier);
    res.status(202).json({ ok: true });
  });

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

  return router;
}
