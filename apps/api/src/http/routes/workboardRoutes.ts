import { Router } from 'express';

import {
  addToWorkboardRequestSchema,
  createWatchlistRequestSchema,
  itemIdParamSchema,
  reorderWorkboardRequestSchema,
  updateWatchlistRequestSchema,
  updateWatchlistSharingRequestSchema,
  watchlistIdParamSchema,
  workboardListQuerySchema,
  type AddToWorkboardRequest,
  type CreateWatchlistRequest,
  type ReorderWorkboardRequest,
  type UpdateWatchlistRequest,
  type UpdateWatchlistSharingRequest,
  type WorkboardListQuery,
} from '@bettertrack/contracts';

import { requireUser } from '../middleware/session';
import { validateBody, validateParams, validateQuery } from '../middleware/validate';
import type { AppContext } from '../context';
import { toWorkboardItem } from '../serializers';

/** Workboard + named-watchlist endpoints (PROJECTPLAN.md §6.4, §13.3 V3-P5). */
export function createWorkboardRouter(ctx: AppContext): Router {
  const router = Router();

  router.use(requireUser);

  // GET /workboard/watchlists — the caller's named lists (General first) + audience.
  router.get('/watchlists', async (req, res) => {
    const watchlists = await ctx.workboard.listWatchlists(req.authUser!.id);
    res.json({ watchlists });
  });

  // POST /workboard/watchlists — create a named list (409 on name clash).
  router.post('/watchlists', validateBody(createWatchlistRequestSchema), async (req, res) => {
    const { name } = req.valid?.body as CreateWatchlistRequest;
    const watchlist = await ctx.workboard.createWatchlist(req.authUser!.id, name);
    res.status(201).json(watchlist);
  });

  // PATCH /workboard/watchlists/:watchlistId — rename (never the default General).
  router.patch(
    '/watchlists/:watchlistId',
    validateParams(watchlistIdParamSchema),
    validateBody(updateWatchlistRequestSchema),
    async (req, res) => {
      const { watchlistId } = req.valid?.params as { watchlistId: string };
      const { name } = req.valid?.body as UpdateWatchlistRequest;
      const watchlist = await ctx.workboard.renameWatchlist(req.authUser!.id, watchlistId, name);
      res.json(watchlist);
    },
  );

  // DELETE /workboard/watchlists/:watchlistId — delete a list (never General).
  router.delete(
    '/watchlists/:watchlistId',
    validateParams(watchlistIdParamSchema),
    async (req, res) => {
      const { watchlistId } = req.valid?.params as { watchlistId: string };
      await ctx.workboard.deleteWatchlist(req.authUser!.id, watchlistId);
      res.status(204).send();
    },
  );

  // GET /workboard/sharing — legacy per-user watchlist sharing (the General list).
  router.get('/sharing', async (req, res) => {
    const result = await ctx.workboard.getSharing(req.authUser!.id);
    res.json(result);
  });

  // PATCH /workboard/sharing — legacy toggle on the General list.
  router.patch('/sharing', validateBody(updateWatchlistSharingRequestSchema), async (req, res) => {
    const { visibility } = req.valid?.body as UpdateWatchlistSharingRequest;
    const result = await ctx.workboard.setSharing(req.authUser!.id, visibility);
    res.json(result);
  });

  // GET /workboard[?watchlistId=] — all the caller's items, or one list's items.
  router.get('/', validateQuery(workboardListQuerySchema), async (req, res) => {
    const { watchlistId } = req.valid?.query as WorkboardListQuery;
    const items = watchlistId
      ? await ctx.workboard.listInWatchlist(req.authUser!.id, watchlistId)
      : await ctx.workboard.list(req.authUser!.id);
    res.json({ items: items.map(toWorkboardItem) });
  });

  // POST /workboard — add an asset to a list (default General when omitted).
  router.post('/', validateBody(addToWorkboardRequestSchema), async (req, res) => {
    const { assetId, watchlistId } = req.valid?.body as AddToWorkboardRequest;
    const item = await ctx.workboard.addItem(req.authUser!.id, assetId, watchlistId);
    res.status(201).json(toWorkboardItem(item));
  });

  // DELETE /workboard/:itemId — remove a watchlist item.
  router.delete('/:itemId', validateParams(itemIdParamSchema), async (req, res) => {
    const { itemId } = req.valid?.params as { itemId: string };
    await ctx.workboard.removeItem(req.authUser!.id, itemId);
    res.status(204).send();
  });

  // PATCH /workboard/reorder — persist a new sort order.
  router.patch('/reorder', validateBody(reorderWorkboardRequestSchema), async (req, res) => {
    const { itemIds } = req.valid?.body as ReorderWorkboardRequest;
    await ctx.workboard.reorder(req.authUser!.id, itemIds);
    res.json({ ok: true });
  });

  return router;
}
