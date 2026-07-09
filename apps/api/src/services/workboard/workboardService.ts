import type { WatchlistSharingResponse, WatchlistSummary } from '@bettertrack/contracts';

import type {
  WorkboardRepository,
  WorkboardItemWithAsset,
} from '../../data/repositories/workboardRepository';
import { badRequest, conflict, notFound } from '../../errors';
import type { ReferenceBackfill } from '../assets/referenceBackfill';
import type { AudienceService } from '../social/audienceService';

export interface WorkboardServiceDeps {
  repo: WorkboardRepository;
  referenceBackfill: ReferenceBackfill;
  /** The single sharing-enforcement layer — per-list audiences run through it (§13.3 V3-P5). */
  audience: AudienceService;
}

export interface WorkboardService {
  /** Every item across the caller's lists (owner view + membership set). */
  list(userId: string): Promise<WorkboardItemWithAsset[]>;
  /** Items in one of the caller's lists (404 when the list isn't theirs). */
  listInWatchlist(userId: string, watchlistId: string): Promise<WorkboardItemWithAsset[]>;
  /** Items in one list by id — for the authorized shared read (authorization is upstream). */
  itemsForSharedView(watchlistId: string): Promise<WorkboardItemWithAsset[]>;
  /** Add an asset to `watchlistId` (or the default General list when omitted). */
  addItem(userId: string, assetId: string, watchlistId?: string): Promise<WorkboardItemWithAsset>;
  removeItem(userId: string, itemId: string): Promise<void>;
  reorder(userId: string, itemIds: string[]): Promise<void>;
  /** The caller's named lists (General first) with per-list audience. */
  listWatchlists(userId: string): Promise<WatchlistSummary[]>;
  createWatchlist(userId: string, name: string): Promise<WatchlistSummary>;
  renameWatchlist(userId: string, watchlistId: string, name: string): Promise<WatchlistSummary>;
  deleteWatchlist(userId: string, watchlistId: string): Promise<void>;
  /** Legacy per-user watchlist sharing state (§6.9, V2-P9) — the General list's audience, coarsened. */
  getSharing(userId: string): Promise<WatchlistSharingResponse>;
  /** Legacy toggle — sets the General list's audience to all-friends / private. */
  setSharing(userId: string, visibility: 'private' | 'friends'): Promise<WatchlistSharingResponse>;
}

export function createWorkboardService(deps: WorkboardServiceDeps): WorkboardService {
  const { repo, referenceBackfill, audience } = deps;

  /** Resolve + assert ownership of the target list, defaulting to General. */
  async function resolveTargetList(userId: string, watchlistId?: string): Promise<string> {
    if (watchlistId === undefined) return repo.ensureDefaultWatchlist(userId);
    const found = await repo.findWatchlist(userId, watchlistId);
    if (!found) throw notFound('Watchlist not found.', 'WATCHLIST_NOT_FOUND');
    return found.id;
  }

  return {
    async list(userId) {
      await repo.ensureDefaultWatchlist(userId);
      return repo.list(userId);
    },

    async listInWatchlist(userId, watchlistId) {
      const found = await repo.findWatchlist(userId, watchlistId);
      if (!found) throw notFound('Watchlist not found.', 'WATCHLIST_NOT_FOUND');
      return repo.listByWatchlistForUser(userId, watchlistId);
    },

    itemsForSharedView(watchlistId) {
      return repo.listByWatchlist(watchlistId);
    },

    async addItem(userId, assetId, watchlistId) {
      const targetList = await resolveTargetList(userId, watchlistId);
      const exists = await repo.assetExists(assetId);
      if (!exists) throw notFound('Asset not found.', 'ASSET_NOT_FOUND');

      const row = await repo.add(userId, targetList, assetId);
      if (!row) throw conflict('Asset is already on this watchlist.', 'ALREADY_WATCHING');

      // First reference (§6.2/§9): warm the asset's daily history. Best-effort.
      await referenceBackfill.ensureHistory(assetId);

      const item = await repo.findOneWithAsset(userId, row.id);
      if (!item) throw new Error('Workboard item vanished after insert');
      return item;
    },

    async removeItem(userId, itemId) {
      const deleted = await repo.remove(userId, itemId);
      if (!deleted) throw notFound('Workboard item not found.', 'ITEM_NOT_FOUND');
    },

    async reorder(userId, itemIds) {
      await repo.reorder(userId, itemIds);
    },

    async listWatchlists(userId) {
      await repo.ensureDefaultWatchlist(userId);
      const lists = await repo.listWatchlists(userId);
      const audiences = await audience.audiencesForSubjects(
        'watchlist',
        lists.map((l) => l.id),
      );
      return lists.map((l) => ({
        id: l.id,
        name: l.name,
        isDefault: l.isDefault,
        itemCount: l.itemCount,
        audience: audiences.get(l.id) ?? 'private',
      }));
    },

    async createWatchlist(userId, name) {
      const trimmed = name.trim();
      if (await repo.watchlistNameTaken(userId, trimmed)) {
        throw conflict('A watchlist with this name already exists.', 'WATCHLIST_NAME_TAKEN');
      }
      const id = await repo.createWatchlist(userId, trimmed);
      return { id, name: trimmed, isDefault: false, itemCount: 0, audience: 'private' };
    },

    async renameWatchlist(userId, watchlistId, name) {
      const found = await repo.findWatchlist(userId, watchlistId);
      if (!found) throw notFound('Watchlist not found.', 'WATCHLIST_NOT_FOUND');
      if (found.isDefault) {
        throw badRequest('The default watchlist cannot be renamed.', 'WATCHLIST_DEFAULT_LOCKED');
      }
      const trimmed = name.trim();
      if (await repo.watchlistNameTaken(userId, trimmed, watchlistId)) {
        throw conflict('A watchlist with this name already exists.', 'WATCHLIST_NAME_TAKEN');
      }
      await repo.renameWatchlist(userId, watchlistId, trimmed);
      const audienceState = await audience.getAudience(userId, 'watchlist', watchlistId);
      const items = await repo.listByWatchlistForUser(userId, watchlistId);
      return {
        id: watchlistId,
        name: trimmed,
        isDefault: false,
        itemCount: items.length,
        audience: audienceState?.audience ?? 'private',
      };
    },

    async deleteWatchlist(userId, watchlistId) {
      const found = await repo.findWatchlist(userId, watchlistId);
      if (!found) throw notFound('Watchlist not found.', 'WATCHLIST_NOT_FOUND');
      if (found.isDefault) {
        throw badRequest('The default watchlist cannot be deleted.', 'WATCHLIST_DEFAULT_LOCKED');
      }
      // Drop the audience row first (polymorphic subject, no cascade), then the list.
      await audience.clearForSubject('watchlist', watchlistId);
      await repo.deleteWatchlist(userId, watchlistId);
    },

    async getSharing(userId) {
      const defaultId = await repo.ensureDefaultWatchlist(userId);
      const state = await audience.getAudience(userId, 'watchlist', defaultId);
      const visibility = state && state.audience !== 'private' ? 'friends' : 'private';
      return { visibility };
    },

    async setSharing(userId, visibility) {
      const defaultId = await repo.ensureDefaultWatchlist(userId);
      await audience.applyVisibility(userId, 'watchlist', defaultId, visibility);
      return { visibility };
    },
  };
}
