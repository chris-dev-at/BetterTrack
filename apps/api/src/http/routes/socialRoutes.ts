import { Router } from 'express';
import { z } from 'zod';

import {
  audienceParamSchema,
  commentIdParamSchema,
  conglomerateIdParamSchema,
  createCommentRequestSchema,
  createFriendRequestRequestSchema,
  followUserRequestSchema,
  idParamSchema,
  itemFollowRequestSchema,
  portfolioIdParamSchema,
  profileItemParamSchema,
  profileUsernameParamSchema,
  setActivityAlertRequestSchema,
  setAudienceRequestSchema,
  toggleReactionRequestSchema,
  tokenParamSchema,
  updateFollowRequestSchema,
  updateProfileSettingsRequestSchema,
  watchlistIdParamSchema,
  type AudienceParam,
  type CommentIdParam,
  type CreateCommentRequest,
  type CreateFriendRequestRequest,
  type FollowUserRequest,
  type ItemFollowRequest,
  type ProfileItemParam,
  type ProfileUsernameParam,
  type SetActivityAlertRequest,
  type SetAudienceRequest,
  type ToggleReactionRequest,
  type UpdateFollowRequest,
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

  // POST /social/follows — follow a PERSON (#438). Idempotent; grants no access,
  // notifies nobody. Bearer `social:write` (the `/social` prefix maps the scope).
  router.post(
    '/follows',
    limiters.social,
    validateBody(followUserRequestSchema),
    async (req, res) => {
      const { userId, autoFollowItems, notifyOnAlertCreate, notifyOnAlertFire } = req.valid
        ?.body as FollowUserRequest;
      await ctx.social.followUser(req.authUser!.id, userId, {
        autoFollowItems,
        notifyOnAlertCreate,
        notifyOnAlertFire,
      });
      res.status(202).json({ ok: true });
    },
  );

  // GET /social/follows — the users the caller follows, with counts (#438).
  router.get('/follows', async (req, res) => {
    const result = await ctx.social.listFollowing(req.authUser!.id);
    res.json(result);
  });

  // GET /social/followers — the users who follow the caller (#438).
  router.get('/followers', async (req, res) => {
    const result = await ctx.social.listFollowers(req.authUser!.id);
    res.json(result);
  });

  // DELETE /social/follows/:userId — unfollow; stops their news immediately (#438).
  router.delete('/follows/:userId', validateParams(userIdParamSchema), async (req, res) => {
    const { userId } = req.valid?.params as { userId: string };
    await ctx.social.unfollowUser(req.authUser!.id, userId);
    res.status(204).send();
  });

  // PATCH /social/follows/:userId — the caller's per-follow prefs: the
  // auto-follow-items toggle (#439) and the two independent alert-follow
  // triggers (#455). 404 when not following.
  router.patch(
    '/follows/:userId',
    validateParams(userIdParamSchema),
    validateBody(updateFollowRequestSchema),
    async (req, res) => {
      const { userId } = req.valid?.params as { userId: string };
      const patch = req.valid?.body as UpdateFollowRequest;
      const result = await ctx.social.updateFollow(req.authUser!.id, userId, patch);
      res.json(result);
    },
  );

  // POST /social/item-follows — bookmark another user's item (#439). Idempotent;
  // only a CURRENTLY visible item is followable (friend-shared or public with a
  // live profile) — anything else 404s, so this can't probe private items.
  router.post(
    '/item-follows',
    limiters.social,
    validateBody(itemFollowRequestSchema),
    async (req, res) => {
      const { kind, subjectId } = req.valid?.body as ItemFollowRequest;
      await ctx.social.followItem(req.authUser!.id, kind, subjectId);
      res.status(202).json({ ok: true });
    },
  );

  // GET /social/item-follows — the caller's Following collection (#439), each
  // row's visibility re-derived through the enforcement layer at read time.
  router.get('/item-follows', async (req, res) => {
    const result = await ctx.social.listItemFollows(req.authUser!.id);
    res.json(result);
  });

  // DELETE /social/item-follows/:kind/:subjectId — remove a bookmark (#439).
  // Works regardless of current visibility (that's how a "gone" row is removed).
  router.delete(
    '/item-follows/:kind/:subjectId',
    validateParams(audienceParamSchema),
    async (req, res) => {
      const { kind, subjectId } = req.valid?.params as AudienceParam;
      await ctx.social.unfollowItem(req.authUser!.id, kind, subjectId);
      res.status(204).send();
    },
  );

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

  // GET /social/my-shared — every shareable item I own (portfolios, conglomerates
  // and watchlists), shared or not, each with its current audience (#384).
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

  // --- Comments + reactions on shared items (§13.5 V5-P8) --------------------
  // Every endpoint authorizes read AND write through the SAME audience layer
  // every social read uses (fail-closed): the thread of an item you can't see
  // 404s exactly like a non-existent one (no enumeration). All sit behind
  // `requireUser`, and the non-owner path needs a friendship, so a public-link
  // (logged-out) visitor never reaches them — public links stay read-only (§16).

  // GET /social/items/:kind/:subjectId/thread — the item's comment thread +
  // item-level reactions. 404 when the caller can't currently read the item.
  router.get(
    '/items/:kind/:subjectId/thread',
    validateParams(audienceParamSchema),
    async (req, res) => {
      const { kind, subjectId } = req.valid?.params as AudienceParam;
      const result = await ctx.comments.getThread(req.authUser!.id, kind, subjectId);
      res.json(result);
    },
  );

  // POST /social/items/:kind/:subjectId/comments — post one comment (audience-scoped).
  router.post(
    '/items/:kind/:subjectId/comments',
    limiters.social,
    validateParams(audienceParamSchema),
    validateBody(createCommentRequestSchema),
    async (req, res) => {
      const { kind, subjectId } = req.valid?.params as AudienceParam;
      const { body } = req.valid?.body as CreateCommentRequest;
      const result = await ctx.comments.addComment(req.authUser!.id, kind, subjectId, body);
      res.status(201).json(result);
    },
  );

  // POST /social/items/:kind/:subjectId/reactions — toggle a curated emoji on the item.
  router.post(
    '/items/:kind/:subjectId/reactions',
    limiters.social,
    validateParams(audienceParamSchema),
    validateBody(toggleReactionRequestSchema),
    async (req, res) => {
      const { kind, subjectId } = req.valid?.params as AudienceParam;
      const { emoji } = req.valid?.body as ToggleReactionRequest;
      const result = await ctx.comments.toggleItemReaction(
        req.authUser!.id,
        kind,
        subjectId,
        emoji,
      );
      res.json(result);
    },
  );

  // DELETE /social/comments/:commentId — soft-delete a comment. The author, or
  // the item owner moderating any comment; nobody else (404, never 403).
  router.delete('/comments/:commentId', validateParams(commentIdParamSchema), async (req, res) => {
    const { commentId } = req.valid?.params as CommentIdParam;
    await ctx.comments.deleteComment(req.authUser!.id, commentId);
    res.status(204).send();
  });

  // POST /social/comments/:commentId/reactions — toggle a curated emoji on a comment.
  router.post(
    '/comments/:commentId/reactions',
    limiters.social,
    validateParams(commentIdParamSchema),
    validateBody(toggleReactionRequestSchema),
    async (req, res) => {
      const { commentId } = req.valid?.params as CommentIdParam;
      const { emoji } = req.valid?.body as ToggleReactionRequest;
      const result = await ctx.comments.toggleCommentReaction(req.authUser!.id, commentId, emoji);
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
