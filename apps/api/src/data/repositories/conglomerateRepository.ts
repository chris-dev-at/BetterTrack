import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import type { Database } from '../db';
import { assets, conglomeratePositions, conglomerates } from '../schema';
import type { AssetRow, ConglomerateRow } from '../schema';

/** `draft` | `active` — the persisted Conglomerate status (§6.5). */
type ConglomerateStatus = ConglomerateRow['status'];

/**
 * Conglomerate persistence (PROJECTPLAN.md §6.5, §8). Every method is
 * owner-scoped at the SQL layer (`WHERE owner_id = :ownerId`), so a
 * Conglomerate belonging to another user is simply not found — callers 404
 * without leaking existence, no IDOR by construction (§8). Names are unique per
 * owner, case-insensitively; a collision raises `ConglomerateNameConflictError`
 * which the service maps to a 409.
 */

/** Raised on a case-insensitive name collision within one owner; service → 409. */
export class ConglomerateNameConflictError extends Error {
  constructor() {
    super('A conglomerate with this name already exists.');
    this.name = 'ConglomerateNameConflictError';
  }
}

/** A summary row (list view) — the Conglomerate plus its position count. */
export interface ConglomerateSummaryRow {
  id: string;
  name: string;
  description: string | null;
  status: ConglomerateStatus;
  /** Friend-sharing visibility (§6.9, V2-P9): `private` (default) or `friends`. */
  visibility: 'private' | 'friends';
  positionCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/** One asset position with the identity of its asset embedded for display (§6.5). */
export interface ConglomeratePositionWithAssetRow {
  kind: 'asset';
  assetId: string;
  weightPct: number;
  sortOrder: number;
  asset: {
    symbol: string;
    name: string;
    currency: string;
    type: AssetRow['type'];
  };
}

/** One nested-conglomerate constituent with the child's identity embedded (V5-P6). */
export interface ConglomerateChildPositionRow {
  kind: 'conglomerate';
  childId: string;
  weightPct: number;
  sortOrder: number;
  child: {
    id: string;
    name: string;
    status: ConglomerateStatus;
    positionCount: number;
  };
}

/** One constituent row — an asset position or a nested conglomerate (V5-P6). */
export type ConglomerateConstituentRow =
  | ConglomeratePositionWithAssetRow
  | ConglomerateChildPositionRow;

/** A single Conglomerate with its ordered constituents. */
export interface ConglomerateDetailRow extends ConglomerateSummaryRow {
  positions: ConglomerateConstituentRow[];
}

/** A constituent to persist — `sortOrder` is derived from array index by the caller. */
export type PositionInput =
  | { kind: 'asset'; assetId: string; weightPct: number }
  | { kind: 'conglomerate'; childId: string; weightPct: number };

export function createConglomerateRepository(db: Database) {
  /**
   * True when the owner already has a *different* Conglomerate whose name
   * matches case-insensitively (§6.5). `excludeId` skips the row being updated.
   */
  async function nameTaken(ownerId: string, name: string, excludeId?: string): Promise<boolean> {
    const rows = await db
      .select({ id: conglomerates.id })
      .from(conglomerates)
      .where(
        and(
          eq(conglomerates.ownerId, ownerId),
          sql`lower(${conglomerates.name}) = ${name.trim().toLowerCase()}`,
        ),
      );
    return rows.some((r) => r.id !== excludeId);
  }

  return {
    /** Every Conglomerate the owner has, oldest first, each with a position count. */
    async listForOwner(ownerId: string): Promise<ConglomerateSummaryRow[]> {
      const rows = await db
        .select({
          id: conglomerates.id,
          name: conglomerates.name,
          description: conglomerates.description,
          status: conglomerates.status,
          visibility: conglomerates.visibility,
          createdAt: conglomerates.createdAt,
          updatedAt: conglomerates.updatedAt,
          positionCount: sql<number>`count(${conglomeratePositions.id})`.mapWith(Number),
        })
        .from(conglomerates)
        .leftJoin(conglomeratePositions, eq(conglomeratePositions.conglomerateId, conglomerates.id))
        .where(eq(conglomerates.ownerId, ownerId))
        .groupBy(conglomerates.id)
        .orderBy(asc(conglomerates.createdAt), asc(conglomerates.id));
      return rows;
    },

    /**
     * A single Conglomerate scoped to its owner (§8): returns null when the id
     * is unknown *or* belongs to another user. Positions are joined to their
     * asset identity and ordered by `sortOrder`.
     */
    async findByIdForOwner(ownerId: string, id: string): Promise<ConglomerateDetailRow | null> {
      const headRows = await db
        .select({
          id: conglomerates.id,
          name: conglomerates.name,
          description: conglomerates.description,
          status: conglomerates.status,
          visibility: conglomerates.visibility,
          createdAt: conglomerates.createdAt,
          updatedAt: conglomerates.updatedAt,
        })
        .from(conglomerates)
        .where(and(eq(conglomerates.id, id), eq(conglomerates.ownerId, ownerId)))
        .limit(1);
      const head = headRows[0];
      if (!head) return null;

      const posRows = await db
        .select({
          assetId: conglomeratePositions.assetId,
          childId: conglomeratePositions.childConglomerateId,
          weightPct: conglomeratePositions.weightPct,
          sortOrder: conglomeratePositions.sortOrder,
          symbol: assets.symbol,
          name: assets.name,
          currency: assets.currency,
          type: assets.type,
        })
        .from(conglomeratePositions)
        .leftJoin(assets, eq(conglomeratePositions.assetId, assets.id))
        .where(eq(conglomeratePositions.conglomerateId, id))
        .orderBy(asc(conglomeratePositions.sortOrder));

      // Child (nested-conglomerate) identity for the V5-P6 rows: name/status +
      // own position count, fetched in one grouped query. Children are always
      // the same owner's (write-time rule), so no extra owner filter is needed.
      const childIds = posRows.flatMap((r) => (r.childId !== null ? [r.childId] : []));
      const childById = new Map<
        string,
        { id: string; name: string; status: ConglomerateStatus; positionCount: number }
      >();
      if (childIds.length > 0) {
        const childRows = await db
          .select({
            id: conglomerates.id,
            name: conglomerates.name,
            status: conglomerates.status,
            positionCount: sql<number>`count(${conglomeratePositions.id})`.mapWith(Number),
          })
          .from(conglomerates)
          .leftJoin(
            conglomeratePositions,
            eq(conglomeratePositions.conglomerateId, conglomerates.id),
          )
          .where(inArray(conglomerates.id, childIds))
          .groupBy(conglomerates.id);
        for (const c of childRows) childById.set(c.id, c);
      }

      const positions: ConglomerateConstituentRow[] = [];
      for (const r of posRows) {
        if (r.childId !== null) {
          const child = childById.get(r.childId);
          if (!child) continue; // FK-guaranteed; defensive only.
          positions.push({
            kind: 'conglomerate',
            childId: r.childId,
            weightPct: Number(r.weightPct),
            sortOrder: r.sortOrder,
            child,
          });
        } else if (r.assetId !== null && r.symbol !== null) {
          positions.push({
            kind: 'asset',
            assetId: r.assetId,
            weightPct: Number(r.weightPct),
            sortOrder: r.sortOrder,
            asset: {
              symbol: r.symbol,
              name: r.name ?? r.symbol,
              currency: r.currency ?? 'EUR',
              type: r.type ?? 'stock',
            },
          });
        }
      }

      return { ...head, positionCount: positions.length, positions };
    },

    /** Create a new `draft` owned by the caller. Throws on a duplicate name. */
    async create(
      ownerId: string,
      input: { name: string; description?: string | null },
    ): Promise<string> {
      if (await nameTaken(ownerId, input.name)) throw new ConglomerateNameConflictError();
      const rows = await db
        .insert(conglomerates)
        .values({
          ownerId,
          name: input.name,
          description: input.description ?? null,
          status: 'draft',
        })
        .returning({ id: conglomerates.id });
      const id = rows[0]?.id;
      if (!id) throw new Error('Conglomerate vanished after insert');
      return id;
    },

    /**
     * Update mutable fields, scoped to the owner (§8). Returns false when the id
     * is not the caller's (→ 404). Throws on a case-insensitive name collision.
     */
    async update(
      ownerId: string,
      id: string,
      patch: { name?: string; description?: string | null; visibility?: 'private' | 'friends' },
    ): Promise<boolean> {
      const set: Partial<{
        name: string;
        description: string | null;
        visibility: 'private' | 'friends';
        updatedAt: Date;
      }> = {};
      if (patch.name !== undefined) {
        if (await nameTaken(ownerId, patch.name, id)) throw new ConglomerateNameConflictError();
        set.name = patch.name;
      }
      if (patch.description !== undefined) set.description = patch.description;
      if (patch.visibility !== undefined) set.visibility = patch.visibility;

      // A no-field PATCH shouldn't touch `updatedAt`; still confirm ownership so
      // an unknown/foreign id 404s rather than silently succeeding.
      if (Object.keys(set).length === 0) {
        const owned = await db
          .select({ id: conglomerates.id })
          .from(conglomerates)
          .where(and(eq(conglomerates.id, id), eq(conglomerates.ownerId, ownerId)))
          .limit(1);
        return owned.length > 0;
      }
      set.updatedAt = new Date();

      const rows = await db
        .update(conglomerates)
        .set(set)
        .where(and(eq(conglomerates.id, id), eq(conglomerates.ownerId, ownerId)))
        .returning({ id: conglomerates.id });
      return rows.length > 0;
    },

    /** Hard-delete (cascades positions). Returns false when the id is not owned. */
    async delete(ownerId: string, id: string): Promise<boolean> {
      const rows = await db
        .delete(conglomerates)
        .where(and(eq(conglomerates.id, id), eq(conglomerates.ownerId, ownerId)))
        .returning({ id: conglomerates.id });
      return rows.length > 0;
    },

    /**
     * The subset of the given asset ids that are *visible* to `ownerId`: a
     * global market asset (`owner_id IS NULL`) or the caller's own custom asset.
     * Another user's private custom asset (house, vehicle, unlisted stock) is
     * omitted, so it can never be embedded into a Conglomerate and leaked —
     * mirrors `portfolioService.loadVisibleAssets`, no IDOR (§8, §10).
     */
    async visibleAssetIds(ownerId: string, ids: readonly string[]): Promise<Set<string>> {
      if (ids.length === 0) return new Set();
      const rows = await db
        .select({ id: assets.id })
        .from(assets)
        .where(
          and(
            inArray(assets.id, [...ids]),
            sql`(${assets.ownerId} is null or ${assets.ownerId} = ${ownerId})`,
          ),
        );
      return new Set(rows.map((r) => r.id));
    },

    /**
     * The subset of the given conglomerate ids OWNED by `ownerId` — only own
     * conglomerates are nestable (V5-P6), so a foreign/unknown id is simply
     * absent from the result and the service 404s without leaking existence.
     */
    async ownedConglomerateIds(ownerId: string, ids: readonly string[]): Promise<Set<string>> {
      if (ids.length === 0) return new Set();
      const rows = await db
        .select({ id: conglomerates.id })
        .from(conglomerates)
        .where(and(inArray(conglomerates.id, [...ids]), eq(conglomerates.ownerId, ownerId)));
      return new Set(rows.map((r) => r.id));
    },

    /**
     * The owner's conglomerates that embed `id` as a nested constituent —
     * the delete-blocking lookup (V5-P6): a conglomerate in use as a
     * constituent may not be deleted, and the error names these parents.
     * Ordered by name for a stable message.
     */
    async parentsOf(ownerId: string, id: string): Promise<Array<{ id: string; name: string }>> {
      return db
        .select({ id: conglomerates.id, name: conglomerates.name })
        .from(conglomeratePositions)
        .innerJoin(conglomerates, eq(conglomeratePositions.conglomerateId, conglomerates.id))
        .where(
          and(
            eq(conglomeratePositions.childConglomerateId, id),
            eq(conglomerates.ownerId, ownerId),
          ),
        )
        .orderBy(asc(conglomerates.name), asc(conglomerates.id));
    },

    /**
     * Every nesting edge (parent → child) across the owner's conglomerates —
     * the write-time cycle/depth validation graph (V5-P6). Owner-local by
     * construction: only own conglomerates are nestable.
     */
    async nestingEdges(ownerId: string): Promise<Array<{ parentId: string; childId: string }>> {
      const rows = await db
        .select({
          parentId: conglomeratePositions.conglomerateId,
          childId: conglomeratePositions.childConglomerateId,
        })
        .from(conglomeratePositions)
        .innerJoin(conglomerates, eq(conglomeratePositions.conglomerateId, conglomerates.id))
        .where(
          and(
            eq(conglomerates.ownerId, ownerId),
            sql`${conglomeratePositions.childConglomerateId} is not null`,
          ),
        );
      return rows.flatMap((r) =>
        r.childId !== null ? [{ parentId: r.parentId, childId: r.childId }] : [],
      );
    },

    /**
     * Replace *all* of a Conglomerate's positions in one transaction (the
     * Builder autosave, §6.5): delete the old set, insert the new one with
     * `sortOrder` from array index. Ownership is verified inside the transaction,
     * so a not-owned id mutates nothing and returns false (→ 404). `updatedAt`
     * is bumped so the list reflects the edit.
     */
    async replacePositions(
      ownerId: string,
      id: string,
      positions: readonly PositionInput[],
    ): Promise<boolean> {
      return db.transaction(async (tx) => {
        const owned = await tx
          .select({ id: conglomerates.id })
          .from(conglomerates)
          .where(and(eq(conglomerates.id, id), eq(conglomerates.ownerId, ownerId)))
          .limit(1);
        if (owned.length === 0) return false;

        await tx.delete(conglomeratePositions).where(eq(conglomeratePositions.conglomerateId, id));
        if (positions.length > 0) {
          await tx.insert(conglomeratePositions).values(
            positions.map((p, index) => ({
              conglomerateId: id,
              assetId: p.kind === 'asset' ? p.assetId : null,
              childConglomerateId: p.kind === 'conglomerate' ? p.childId : null,
              weightPct: String(p.weightPct),
              sortOrder: index,
            })),
          );
        }
        await tx
          .update(conglomerates)
          .set({ updatedAt: new Date() })
          .where(eq(conglomerates.id, id));
        return true;
      });
    },

    /** Flip status, scoped to the owner. Returns false when the id is not owned. */
    async setStatus(ownerId: string, id: string, status: ConglomerateStatus): Promise<boolean> {
      const rows = await db
        .update(conglomerates)
        .set({ status, updatedAt: new Date() })
        .where(and(eq(conglomerates.id, id), eq(conglomerates.ownerId, ownerId)))
        .returning({ id: conglomerates.id });
      return rows.length > 0;
    },
  };
}

export type ConglomerateRepository = ReturnType<typeof createConglomerateRepository>;
