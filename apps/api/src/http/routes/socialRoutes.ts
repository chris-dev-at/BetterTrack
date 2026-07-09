import { Router } from 'express';
import { z } from 'zod';

import {
  audienceParamSchema,
  conglomerateIdParamSchema,
  createFriendRequestRequestSchema,
  idParamSchema,
  portfolioIdParamSchema,
  profileItemParamSchema,
  profileUsernameParamSchema,
  setActivityAlertRequestSchema,
  setAudienceRequestSchema,
  tokenParamSchema,
  updateProfileSettingsRequestSchema,
  watchlistIdParamSchema,
  type AudienceParam,
  type CreateFriendRequestRequest,
  type ProfileItemParam,
  type ProfileUsernameParam,
  type SetActivityAlertRequest,
  type SetAudienceRequest,
  type UpdateProfileSettingsRequest,
} from '@bettertrack/contracts';

import type { RateLimiters } from '../middleware/rateLimit';
import { requireUser } from '../middleware/session';
import { validateBody, validateParams } from '../middleware/validate';
import type { AppContext } from '../context';

/**
 * Social endpoints (PROJECTPLAN.md §6.9, §13.3 V3-P5). Handlers stay thin
 * (parse → service → respond); the no-enumeration, 404-never-403, and audience
 * enforcement rules live in the services.
 */
const userIdParamSchema = z.object({ userId: z.string().uuid() }).strict();

export function createSocialRouter(ctx: AppContext, limiters: RateLimiters): Router {
  const router = Router();

  // GET /social/links/:token — UNAUTHENTICATED public-link read (§14). Mounted
  // BEFORE `requireUser`, so a logged-out visitor can open a live read-only view.
  // A revoked/unknown token, or one whose owner narrowed the audience away from
  // `public_link`, is a plain 404 (no existence leak). It is a safe GET, so the
  // CSRF guard passes; the global rate limiter still applies.
  router.get('/links/:token', validateParams(tokenParamSchema), async (req, res) => {
    const { token } = req.valid?.params as { token: string };
    const result = await ctx.social.getByPublicLink(token);
    res.json(result);
  });

  // GET /social/profiles/:username — UNAUTHENTICATED public-profile read (§14,
  // V3-P6). Composes ONLY the user's `public_link` items + bio. An opted-out /
  // unknown / inactive user is a plain 404 (no leak); disabling the profile 404s
  // the slug instantly. Mounted BEFORE `requireUser`; a safe GET.
  router.get(
    '/profiles/:username',
    validateParams(profileUsernameParamSchema),
    async (req, res) => {
      const { username } = req.valid?.params as ProfileUsernameParam;
      const result = await ctx.social.getPublicProfile(username);
      res.json(result);
    },
  );

  // GET /social/profiles/:username/:kind/:subjectId — UNAUTHENTICATED drill-in to
  // one public item on a profile. Resolved through the SAME `public_link` audience
  // gate as the listing, so a non-public / non-owned / dead item 404s.
  router.get(
    '/profiles/:username/:kind/:subjectId',
    validateParams(profileItemParamSchema),
    async (req, res) => {
      const { username, kind, subjectId } = req.valid?.params as ProfileItemParam;
      const result = await ctx.social.getPublicProfileItem(username, kind, subjectId);
      res.json(result);
    },
  );

  // Everything below requires a (non-admin) session.
  router.use(requireUser);

  // POST /social/requests — request a friend by username or email (no-enumeration).
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

  // DELETE /social/friends/:userId — remove a friendship (either side may). This
  // instantly closes every specific- and all-friends share between the pair, since
  // the enforcement join no longer matches (§6.9).
  router.delete('/friends/:userId', validateParams(userIdParamSchema), async (req, res) => {
    const { userId } = req.valid?.params as { userId: string };
    await ctx.social.removeFriend(req.authUser!.id, userId);
    res.status(204).send();
  });

  // GET /social/shared — everything my friends share with me (audience-derived).
  router.get('/shared', async (req, res) => {
    const result = await ctx.social.listSharedWithMe(req.authUser!.id, {
      baseCurrency: req.authUser!.baseCurrency,
    });
    res.json(result);
  });

  // GET /social/shared/conglomerates/:conglomerateId — read-only friend-shared basket.
  router.get(
    '/shared/conglomerates/:conglomerateId',
    validateParams(conglomerateIdParamSchema),
    async (req, res) => {
      const { conglomerateId } = req.valid?.params as { conglomerateId: string };
      const result = await ctx.social.getSharedConglomerate(req.authUser!.id, conglomerateId);
      res.json(result);
    },
  );

  // GET /social/shared/watchlists/:watchlistId — read-only friend-shared named list.
  router.get(
    '/shared/watchlists/:watchlistId',
    validateParams(watchlistIdParamSchema),
    async (req, res) => {
      const { watchlistId } = req.valid?.params as { watchlistId: string };
      const result = await ctx.social.getSharedWatchlist(req.authUser!.id, watchlistId);
      res.json(result);
    },
  );

  // GET /social/shared/:portfolioId — read-only overview of a friend-shared portfolio.
  router.get('/shared/:portfolioId', validateParams(portfolioIdParamSchema), async (req, res) => {
    const { portfolioId } = req.valid?.params as { portfolioId: string };
    const result = await ctx.social.getSharedPortfolio(req.authUser!.id, portfolioId, {
      baseCurrency: req.authUser!.baseCurrency,
    });
    res.json(result);
  });

  // GET /social/my-shared — everything I currently share (audience != private).
  router.get('/my-shared', async (req, res) => {
    const result = await ctx.social.listMyShared(req.authUser!.id);
    res.json(result);
  });

  // GET /social/audience/:kind/:subjectId — the owner's audience for one subject
  // (feeds the AudiencePicker). 404 (never 403) when not owned — no leak.
  router.get(
    '/audience/:kind/:subjectId',
    validateParams(audienceParamSchema),
    async (req, res) => {
      const { kind, subjectId } = req.valid?.params as AudienceParam;
      const result = await ctx.social.getAudience(req.authUser!.id, kind, subjectId);
      res.json(result);
    },
  );

  // PUT /social/audience/:kind/:subjectId — set a subject's audience. `public_link`
  // is rejected without an explicit acknowledgment (§16); minting one returns the
  // raw token EXACTLY ONCE (hash-only storage, §14).
  router.put(
    '/audience/:kind/:subjectId',
    validateParams(audienceParamSchema),
    validateBody(setAudienceRequestSchema),
    async (req, res) => {
      const { kind, subjectId } = req.valid?.params as AudienceParam;
      const body = req.valid?.body as SetAudienceRequest;
      const result = await ctx.social.setAudience(req.authUser!.id, kind, subjectId, body);
      res.json(result);
    },
  );

  // PUT /social/shared/activity/:kind/:subjectId — the viewer's activity-alert
  // opt-in for one shared item (V3-P6). Only the preference is stored; delivery is
  // #368. 404 (never 403) when the viewer can't currently read the item.
  router.put(
    '/shared/activity/:kind/:subjectId',
    validateParams(audienceParamSchema),
    validateBody(setActivityAlertRequestSchema),
    async (req, res) => {
      const { kind, subjectId } = req.valid?.params as AudienceParam;
      const { enabled } = req.valid?.body as SetActivityAlertRequest;
      const result = await ctx.social.setActivityAlert(req.authUser!.id, kind, subjectId, enabled);
      res.json(result);
    },
  );

  // GET /social/profile — the caller's own public-profile settings (V3-P6).
  router.get('/profile', async (req, res) => {
    const result = await ctx.social.getProfileSettings(req.authUser!.id);
    res.json(result);
  });

  // PUT /social/profile — update the caller's public-profile opt-in + bio.
  // Enabling requires an explicit acknowledgment (§16); disabling unpublishes the
  // slug instantly.
  router.put('/profile', validateBody(updateProfileSettingsRequestSchema), async (req, res) => {
    const body = req.valid?.body as UpdateProfileSettingsRequest;
    const result = await ctx.social.updateProfileSettings(req.authUser!.id, body);
    res.json(result);
  });

  return router;
}
