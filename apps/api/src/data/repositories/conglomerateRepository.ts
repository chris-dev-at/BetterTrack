import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import type { Database } from '../db';
import { assets, conglomeratePositions, conglomerates, priceHistory } from '../schema';
import type { AssetRow, ConglomeratePositionRow, ConglomerateRow } from '../schema';

export interface ConglomeratePositionWithAsset extends ConglomeratePositionRow {
  asset: AssetRow;
}

export interface ConglomerateDetailRow extends ConglomerateRow {
  positions: ConglomeratePositionWithAsset[];
}

export interface BacktestAssetHistoryRow {
  assetId: string;
  symbol: string;
  currency: string;
  prices: Array<{ date: string; close: number }>;
}

function isPgDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

export function createConglomerateRepository(db: Database) {
  async function loadDetail(ownerId: string, id: string): Promise<ConglomerateDetailRow | null> {
    const rows = await db
      .select()
      .from(conglomerates)
      .where(and(eq(conglomerates.id, id), eq(conglomerates.ownerId, ownerId)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;

    const positions = await db
      .select({
        id: conglomeratePositions.id,
        conglomerateId: conglomeratePositions.conglomerateId,
        assetId: conglomeratePositions.assetId,
        weightPct: conglomeratePositions.weightPct,
        sortOrder: conglomeratePositions.sortOrder,
        asset: assets,
      })
      .from(conglomeratePositions)
      .innerJoin(assets, eq(conglomeratePositions.assetId, assets.id))
      .where(eq(conglomeratePositions.conglomerateId, id))
      .orderBy(conglomeratePositions.sortOrder);

    return { ...row, positions };
  }

  return {
    async create(ownerId: string, name: string, description: string | null) {
      const rows = await db
        .insert(conglomerates)
        .values({ ownerId, name, description, status: 'draft' })
        .returning();
      return rows[0]!;
    },

    async load(ownerId: string, id: string) {
      return loadDetail(ownerId, id);
    },

    async nameExists(ownerId: string, name: string, exceptId?: string): Promise<boolean> {
      const normalized = name.trim().toLowerCase();
      const rows = await db
        .select({ id: conglomerates.id })
        .from(conglomerates)
        .where(
          and(
            eq(conglomerates.ownerId, ownerId),
            sql`lower(${conglomerates.name}) = ${normalized}`,
          ),
        );
      return rows.some((row) => row.id !== exceptId);
    },

    async updateMeta(
      ownerId: string,
      id: string,
      input: { name?: string; description?: string | null },
    ): Promise<ConglomerateDetailRow | null> {
      const rows = await db
        .update(conglomerates)
        .set({ ...input, updatedAt: new Date() })
        .where(and(eq(conglomerates.id, id), eq(conglomerates.ownerId, ownerId)))
        .returning({ id: conglomerates.id });
      if (rows.length === 0) return null;
      return loadDetail(ownerId, id);
    },

    async replacePositions(
      ownerId: string,
      id: string,
      positions: Array<{ assetId: string; weightPct: number }>,
    ): Promise<ConglomerateDetailRow | null> {
      const existing = await loadDetail(ownerId, id);
      if (!existing) return null;

      await db.delete(conglomeratePositions).where(eq(conglomeratePositions.conglomerateId, id));
      if (positions.length > 0) {
        await db.insert(conglomeratePositions).values(
          positions.map((position, sortOrder) => ({
            conglomerateId: id,
            assetId: position.assetId,
            weightPct: position.weightPct.toFixed(3),
            sortOrder,
          })),
        );
      }
      await db.update(conglomerates).set({ updatedAt: new Date() }).where(eq(conglomerates.id, id));

      return loadDetail(ownerId, id);
    },

    async activate(ownerId: string, id: string): Promise<ConglomerateDetailRow | null> {
      const rows = await db
        .update(conglomerates)
        .set({ status: 'active', updatedAt: new Date() })
        .where(and(eq(conglomerates.id, id), eq(conglomerates.ownerId, ownerId)))
        .returning({ id: conglomerates.id });
      if (rows.length === 0) return null;
      return loadDetail(ownerId, id);
    },

    async visibleAssetsExist(ownerId: string, assetIds: string[]): Promise<Set<string>> {
      if (assetIds.length === 0) return new Set();
      const rows = await db
        .select({ id: assets.id })
        .from(assets)
        .where(
          and(inArray(assets.id, assetIds), or(isNull(assets.ownerId), eq(assets.ownerId, ownerId))),
        );
      return new Set(rows.map((row) => row.id));
    },

    async historyForAssets(ownerId: string, assetIds: string[]): Promise<BacktestAssetHistoryRow[]> {
      if (assetIds.length === 0) return [];
      const rows = await db
        .select({
          assetId: assets.id,
          symbol: assets.symbol,
          currency: assets.currency,
          date: priceHistory.date,
          close: priceHistory.close,
        })
        .from(assets)
        .leftJoin(priceHistory, eq(priceHistory.assetId, assets.id))
        .where(
          and(inArray(assets.id, assetIds), or(isNull(assets.ownerId), eq(assets.ownerId, ownerId))),
        )
        .orderBy(assets.id, priceHistory.date);

      const grouped = new Map<string, BacktestAssetHistoryRow>();
      for (const row of rows) {
        let entry = grouped.get(row.assetId);
        if (!entry) {
          entry = { assetId: row.assetId, symbol: row.symbol, currency: row.currency, prices: [] };
          grouped.set(row.assetId, entry);
        }
        if (row.date !== null && row.close !== null) {
          entry.prices.push({ date: isPgDate(row.date), close: Number(row.close) });
        }
      }
      return [...grouped.values()];
    },
  };
}

export type ConglomerateRepository = ReturnType<typeof createConglomerateRepository>;
