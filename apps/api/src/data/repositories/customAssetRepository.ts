import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

import type { Database } from '../db';
import { newId } from '../ids';
import { assets, priceHistory } from '../schema';
import type { AssetRow } from '../schema';

/**
 * Custom-investment persistence (PROJECTPLAN.md §6.9, §5.1).
 *
 * A custom asset is an ordinary `assets` row owned by its creator
 * (`owner_id = user`), wired to the **`manual`** provider. Its `provider_ref`
 * must be globally unique because the manual provider resolves an asset by ref
 * alone (it has no user context, §5.1) — so we set `provider_ref` to the row's
 * own id. Its value points live in `price_history` exactly like market closes,
 * so the rest of the system (charts, holdings, value series) treats a house and
 * a stock identically.
 *
 * Every read is owner-scoped: another user's custom asset is indistinguishable
 * from a missing one (§10).
 */

const MANUAL_PROVIDER_ID = 'manual';

export interface NewCustomAsset {
  ownerId: string;
  symbol: string;
  name: string;
  currency: string;
  /** Custom-investment category, stored under `assets.meta.category` (§6.9). */
  category: string;
  /** Value-smoothing toggle, stored under `assets.meta.smoothing` (V3-P2). */
  smoothing: boolean;
}

export interface ValuePointRecord {
  /** ISO `YYYY-MM-DD`. */
  date: string;
  value: number;
}

export function createCustomAssetRepository(db: Database) {
  return {
    /** Create a custom (`manual`) asset owned by the caller; ref = the new row id. */
    async create(input: NewCustomAsset): Promise<AssetRow> {
      const id = newId();
      const rows = await db
        .insert(assets)
        .values({
          id,
          providerId: MANUAL_PROVIDER_ID,
          providerRef: id,
          ownerId: input.ownerId,
          type: 'custom',
          symbol: input.symbol,
          name: input.name,
          exchange: null,
          currency: input.currency,
          meta: { category: input.category, smoothing: input.smoothing },
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('Custom asset insert returned no row');
      return row;
    },

    /**
     * Every custom (`manual`) asset the caller owns, name-ascending. Includes
     * assets with no holdings and no value points — the mobile list surface needs
     * all of them (owner-scoped, §10).
     */
    async listForUser(userId: string): Promise<AssetRow[]> {
      return db
        .select()
        .from(assets)
        .where(and(eq(assets.ownerId, userId), eq(assets.providerId, MANUAL_PROVIDER_ID)))
        .orderBy(asc(assets.name));
    },

    /**
     * The most recent value point for each of the given assets (by date), keyed
     * by asset id. Assets without any value points are simply absent from the map.
     */
    async latestValuePoints(assetIds: readonly string[]): Promise<Map<string, ValuePointRecord>> {
      const map = new Map<string, ValuePointRecord>();
      if (assetIds.length === 0) return map;
      const rows = await db
        .selectDistinctOn([priceHistory.assetId], {
          assetId: priceHistory.assetId,
          date: priceHistory.date,
          close: priceHistory.close,
        })
        .from(priceHistory)
        .where(inArray(priceHistory.assetId, [...assetIds]))
        .orderBy(priceHistory.assetId, desc(priceHistory.date));
      for (const r of rows) {
        const value = Number(r.close);
        if (Number.isFinite(value)) map.set(r.assetId, { date: r.date, value });
      }
      return map;
    },

    /** The caller's own custom asset for `id`, or null (owner-scoped, §10). */
    async findForUser(userId: string, id: string): Promise<AssetRow | null> {
      const rows = await db
        .select()
        .from(assets)
        .where(
          and(
            eq(assets.id, id),
            eq(assets.ownerId, userId),
            eq(assets.providerId, MANUAL_PROVIDER_ID),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    /**
     * Update mutable custom-asset fields, scoped to the owner at the DB layer
     * (defense-in-depth — the service authorises first, but the WHERE never lets
     * an update touch another user's row). Currency is intentionally immutable.
     */
    async update(
      userId: string,
      id: string,
      patch: { name?: string; meta?: unknown },
    ): Promise<AssetRow | null> {
      const owned = and(
        eq(assets.id, id),
        eq(assets.ownerId, userId),
        eq(assets.providerId, MANUAL_PROVIDER_ID),
      );
      const set: Record<string, unknown> = {};
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.meta !== undefined) set.meta = patch.meta;
      if (Object.keys(set).length === 0) {
        const rows = await db.select().from(assets).where(owned).limit(1);
        return rows[0] ?? null;
      }
      const rows = await db.update(assets).set(set).where(owned).returning();
      return rows[0] ?? null;
    },

    /** Delete a custom asset scoped to its owner. Cascades to value points + txns. */
    async deleteForUser(userId: string, id: string): Promise<boolean> {
      const rows = await db
        .delete(assets)
        .where(
          and(
            eq(assets.id, id),
            eq(assets.ownerId, userId),
            eq(assets.providerId, MANUAL_PROVIDER_ID),
          ),
        )
        .returning({ id: assets.id });
      return rows.length > 0;
    },

    /**
     * How many of a user's custom assets still carry the one-time re-categorize
     * flag (V3-P2) — the migration set `meta.recategorize = true` on every
     * pre-existing custom asset. Drives the re-categorize banner.
     */
    async countNeedingRecategorization(userId: string): Promise<number> {
      const rows = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(assets)
        .where(
          and(
            eq(assets.ownerId, userId),
            eq(assets.providerId, MANUAL_PROVIDER_ID),
            sql`(${assets.meta} ->> 'recategorize') = 'true'`,
          ),
        );
      return rows[0]?.n ?? 0;
    },

    /**
     * Drop the re-categorize flag from every custom asset the user owns (banner
     * dismissal, V3-P2). Re-categorizing a single asset clears its own flag in
     * the service update path.
     */
    async clearRecategorization(userId: string): Promise<void> {
      await db
        .update(assets)
        .set({ meta: sql`${assets.meta} - 'recategorize'` })
        .where(and(eq(assets.ownerId, userId), eq(assets.providerId, MANUAL_PROVIDER_ID)));
    },

    /** Value points for a custom asset, ascending by date. */
    async getValuePoints(assetId: string): Promise<ValuePointRecord[]> {
      const rows = await db
        .select({ date: priceHistory.date, close: priceHistory.close })
        .from(priceHistory)
        .where(eq(priceHistory.assetId, assetId))
        .orderBy(asc(priceHistory.date));
      return rows
        .map((r) => ({ date: r.date, value: Number(r.close) }))
        .filter((p) => Number.isFinite(p.value));
    },

    /**
     * Replace the entire value-point set for a custom asset (§6.9 add/edit/delete
     * expressed as one bulk PUT). Done in a transaction so the editor never
     * observes a half-applied set.
     */
    async replaceValuePoints(assetId: string, points: readonly ValuePointRecord[]): Promise<void> {
      await db.transaction(async (tx) => {
        await tx.delete(priceHistory).where(eq(priceHistory.assetId, assetId));
        if (points.length > 0) {
          await tx
            .insert(priceHistory)
            .values(points.map((p) => ({ assetId, date: p.date, close: String(p.value) })));
        }
      });
    },
  };
}

export type CustomAssetRepository = ReturnType<typeof createCustomAssetRepository>;
