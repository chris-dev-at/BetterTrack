import {
  customAssetCategorySchema,
  type CreateCustomAssetRequest,
  type CreateCustomAssetResponse,
  type CustomAsset,
  type CustomAssetCategory,
  type CustomAssetListItem,
  type UpdateCustomAssetRequest,
  type ValuePoint,
} from '@bettertrack/contracts';

import type { CustomAssetRepository } from '../../data/repositories/customAssetRepository';
import type { AssetRow } from '../../data/schema';
import { badRequest, notFound } from '../../errors';
import type { PortfolioService } from '../portfolio/portfolioService';
import type { PortfolioSnapshotService } from '../portfolio/portfolioSnapshots';

/**
 * Custom-investment service (PROJECTPLAN.md §6.9, §5.1).
 *
 * Creates and edits the user's own assets (a house, a vehicle, cash …) wired to
 * the `manual` provider, plus their value-points editor. Value points live in
 * `price_history`, so the manual provider's latest value point *is* the asset's
 * quote — the rest of the system values a custom asset exactly like a stock.
 *
 * The optional initial purchase is recorded as an ordinary BUY transaction
 * through the {@link PortfolioService}. Value-point / smoothing / deletion
 * changes here reshape the reconstructed series of EVERY portfolio holding the
 * asset, so they invalidate the V5-P1 daily snapshots asset-scoped (issue
 * #553, §16 2026-07-17 rule 7): each holding portfolio, from the earliest
 * changed day (floored at that portfolio's first transaction on the asset).
 */

export interface CustomAssetServiceDeps {
  repo: CustomAssetRepository;
  portfolio: PortfolioService;
  snapshots: PortfolioSnapshotService;
}

export interface CustomAssetService {
  /** Every custom asset the user owns, each with its latest value point (§6.9). */
  list(userId: string): Promise<CustomAssetListItem[]>;
  create(userId: string, input: CreateCustomAssetRequest): Promise<CreateCustomAssetResponse>;
  update(userId: string, id: string, patch: UpdateCustomAssetRequest): Promise<CustomAsset>;
  remove(userId: string, id: string): Promise<void>;
  getValuePoints(userId: string, id: string): Promise<ValuePoint[]>;
  putValuePoints(userId: string, id: string, points: ValuePoint[]): Promise<ValuePoint[]>;
  /** How many of the user's custom assets still need re-categorizing (V3-P2). */
  recategorizationStatus(userId: string): Promise<{ pending: number }>;
  /** Dismiss the re-categorize banner: clear every flag the user owns (V3-P2). */
  dismissRecategorization(userId: string): Promise<void>;
}

interface CustomAssetMeta {
  category?: string;
  smoothing?: boolean;
  recategorize?: boolean;
}

function metaOf(row: AssetRow): CustomAssetMeta {
  return (row.meta ?? {}) as CustomAssetMeta;
}

function categoryOf(row: AssetRow): CustomAssetCategory {
  const parsed = customAssetCategorySchema.safeParse(metaOf(row).category);
  return parsed.success ? parsed.data : 'other';
}

function toDto(row: AssetRow): CustomAsset {
  const meta = metaOf(row);
  return {
    id: row.id,
    symbol: row.symbol,
    name: row.name,
    category: categoryOf(row),
    currency: row.currency,
    type: row.type,
    smoothing: meta.smoothing === true,
    needsRecategorization: meta.recategorize === true,
  };
}

export function createCustomAssetService(deps: CustomAssetServiceDeps): CustomAssetService {
  const { repo, portfolio, snapshots } = deps;

  async function requireOwned(userId: string, id: string): Promise<AssetRow> {
    const row = await repo.findForUser(userId, id);
    if (!row) throw notFound('Custom asset not found.', 'CUSTOM_ASSET_NOT_FOUND');
    return row;
  }

  return {
    async list(userId) {
      const rows = await repo.listForUser(userId);
      const latest = await repo.latestValuePoints(rows.map((r) => r.id));
      return rows.map((row) => {
        const point = latest.get(row.id);
        return {
          ...toDto(row),
          latestValue: point ? { date: point.date, value: point.value } : null,
        };
      });
    },

    async create(userId, input) {
      const row = await repo.create({
        ownerId: userId,
        // Custom investments have no ticker; the name doubles as the symbol so
        // search/holdings/workboard render something meaningful.
        symbol: input.name,
        name: input.name,
        currency: input.currency,
        category: input.category,
        smoothing: input.smoothing,
      });

      let transactionId: string | null = null;
      if (input.initialPurchase) {
        const p = input.initialPurchase;
        // Recorded as a BUY through the portfolio service: it validates, inserts
        // and invalidates the value-series cache in one place (§6.9). Custom
        // investments live in the user's default portfolio.
        const portfolioId = await portfolio.getDefaultPortfolioId(userId);
        const [txn] = await portfolio.createTransactions(userId, portfolioId, [
          {
            assetId: row.id,
            side: 'buy',
            quantity: p.quantity,
            price: p.price,
            fee: p.fee,
            executedAt: p.executedAt,
            note: p.note ?? null,
          },
        ]);
        transactionId = txn?.id ?? null;
      }

      return { asset: toDto(row), transactionId };
    },

    async update(userId, id, patch) {
      const existing = await requireOwned(userId, id);

      // Merge category / smoothing into the stored meta only when the patch
      // touches them (name-only edits leave meta untouched). Re-categorizing an
      // asset clears its one-time migration flag so the banner fades (V3-P2).
      let meta: CustomAssetMeta | undefined;
      if (patch.category !== undefined || patch.smoothing !== undefined) {
        meta = { ...metaOf(existing) };
        if (patch.category !== undefined) {
          meta.category = patch.category;
          delete meta.recategorize;
        }
        if (patch.smoothing !== undefined) meta.smoothing = patch.smoothing;
      }

      const updated = await repo.update(userId, id, { name: patch.name, meta });
      if (!updated) throw notFound('Custom asset not found.', 'CUSTOM_ASSET_NOT_FOUND');

      // Smoothing reshapes the asset's whole reconstructed value series (§6.9),
      // so a toggle invalidates every holding portfolio's snapshots from its
      // first transaction on the asset (§16 rule 7) — same as a value-point edit.
      if (
        patch.smoothing !== undefined &&
        patch.smoothing !== (metaOf(existing).smoothing === true)
      ) {
        await snapshots.invalidateForAsset(id);
      }

      return toDto(updated);
    },

    async recategorizationStatus(userId) {
      return { pending: await repo.countNeedingRecategorization(userId) };
    },

    async dismissRecategorization(userId) {
      await repo.clearRecategorization(userId);
    },

    async remove(userId, id) {
      // Resolve the holding portfolios BEFORE the delete — the transactions the
      // fan-out reads cascade away with the asset — but invalidate only AFTER
      // it commits, so a fast recompute can never persist pre-delete data and
      // then be trusted (§16 rule 7).
      const refs = await snapshots.resolveAssetReferences(id);
      const deleted = await repo.deleteForUser(userId, id);
      if (!deleted) throw notFound('Custom asset not found.', 'CUSTOM_ASSET_NOT_FOUND');
      for (const ref of refs) {
        await snapshots.invalidate(ref.portfolioId, ref.fromDay);
      }
    },

    async getValuePoints(userId, id) {
      await requireOwned(userId, id);
      const points = await repo.getValuePoints(id);
      return points.map((p) => ({ date: p.date, value: p.value }));
    },

    async putValuePoints(userId, id, points) {
      await requireOwned(userId, id);

      // One value point per day (§6.9). Reject duplicate dates loudly rather
      // than silently collapsing them.
      const seen = new Set<string>();
      for (const p of points) {
        if (seen.has(p.date)) {
          throw badRequest(`Duplicate value point for ${p.date}.`, 'DUPLICATE_VALUE_POINT', {
            date: p.date,
          });
        }
        seen.add(p.date);
      }

      // Diff against the stored points to find the earliest day the replace
      // actually changes — carry-forward means the series reshapes from there
      // on (§16 rule 7). An identical re-save invalidates nothing.
      const before = await repo.getValuePoints(id);
      const beforeByDate = new Map(before.map((p) => [p.date, p.value]));
      const afterByDate = new Map(points.map((p) => [p.date, p.value]));
      let changedFrom: string | undefined;
      for (const date of new Set([...beforeByDate.keys(), ...afterByDate.keys()])) {
        if (beforeByDate.get(date) === afterByDate.get(date)) continue;
        if (changedFrom === undefined || date < changedFrom) changedFrom = date;
      }

      await repo.replaceValuePoints(
        id,
        points.map((p) => ({ date: p.date, value: p.value })),
      );
      if (changedFrom !== undefined) {
        await snapshots.invalidateForAsset(id, changedFrom);
      }

      const stored = await repo.getValuePoints(id);
      return stored.map((p) => ({ date: p.date, value: p.value }));
    },
  };
}
