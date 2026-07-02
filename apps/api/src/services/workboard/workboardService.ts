import type {
  WorkboardRepository,
  WorkboardItemWithAsset,
} from '../../data/repositories/workboardRepository';
import { conflict, notFound } from '../../errors';
import type { ReferenceBackfill } from '../assets/referenceBackfill';

export interface WorkboardServiceDeps {
  repo: WorkboardRepository;
  referenceBackfill: ReferenceBackfill;
}

export interface WorkboardService {
  list(userId: string): Promise<WorkboardItemWithAsset[]>;
  addItem(userId: string, assetId: string): Promise<WorkboardItemWithAsset>;
  removeItem(userId: string, itemId: string): Promise<void>;
  reorder(userId: string, itemIds: string[]): Promise<void>;
}

export function createWorkboardService(deps: WorkboardServiceDeps): WorkboardService {
  const { repo, referenceBackfill } = deps;

  return {
    async list(userId) {
      return repo.list(userId);
    },

    async addItem(userId, assetId) {
      const exists = await repo.assetExists(assetId);
      if (!exists) {
        throw notFound('Asset not found.', 'ASSET_NOT_FOUND');
      }

      const row = await repo.add(userId, assetId);
      if (!row) {
        throw conflict('Asset is already on your workboard.', 'ALREADY_WATCHING');
      }

      // First reference (§6.2/§9): watching an asset warms its daily history so
      // sparklines and later series have data. Best-effort — never fails the add.
      await referenceBackfill.ensureHistory(assetId);

      const item = await repo.findOneWithAsset(userId, row.id);
      if (!item) throw new Error('Workboard item vanished after insert');
      return item;
    },

    async removeItem(userId, itemId) {
      const deleted = await repo.remove(userId, itemId);
      if (!deleted) {
        throw notFound('Workboard item not found.', 'ITEM_NOT_FOUND');
      }
    },

    async reorder(userId, itemIds) {
      await repo.reorder(userId, itemIds);
    },
  };
}
