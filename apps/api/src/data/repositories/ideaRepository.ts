import { and, desc, eq } from 'drizzle-orm';

import type { IdeaWorkboardState } from '@bettertrack/contracts';

import type { Database } from '../db';
import { ideas } from '../schema';

/**
 * Idea persistence (PROJECTPLAN.md §13.4 V4-P9, §8). A saved Workboard analysis:
 * a name, an optional thesis note, and the exact `state` (jsonb). Every mutation
 * is owner-scoped at the SQL layer (`WHERE owner_id = :ownerId`), so an idea
 * belonging to another user is simply not found — callers 404 without leaking
 * existence, no IDOR by construction (§8).
 *
 * Sharing/authorization is NOT here — ideas are the fourth `share_kind` and route
 * through the ONE audience-enforcement layer ({@link ShareAudienceRepository}).
 * The one cross-owner read exposed here, {@link findById}, is only ever called
 * AFTER an audience authorization has passed (the clone path), so it discloses
 * nothing on its own.
 */

/** A saved idea as stored — `state` narrowed back to its contract shape. */
export interface IdeaRecord {
  id: string;
  ownerId: string;
  name: string;
  thesis: string | null;
  state: IdeaWorkboardState;
  createdAt: Date;
  updatedAt: Date;
}

/** Fields a create/clone persists. */
export interface CreateIdeaInput {
  name: string;
  thesis: string | null;
  state: IdeaWorkboardState;
}

/** Fields an update may touch (all optional; a no-op patch still bumps nothing). */
export interface UpdateIdeaPatch {
  name?: string;
  thesis?: string | null;
  state?: IdeaWorkboardState;
}

function toRecord(row: typeof ideas.$inferSelect): IdeaRecord {
  return {
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    thesis: row.thesis,
    state: row.state as IdeaWorkboardState,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createIdeaRepository(db: Database) {
  return {
    /** Every idea the owner has, newest first. */
    async listForOwner(ownerId: string): Promise<IdeaRecord[]> {
      const rows = await db
        .select()
        .from(ideas)
        .where(eq(ideas.ownerId, ownerId))
        .orderBy(desc(ideas.createdAt), desc(ideas.id));
      return rows.map(toRecord);
    },

    /** A single idea scoped to its owner (§8): null when unknown or foreign. */
    async findByIdForOwner(ownerId: string, id: string): Promise<IdeaRecord | null> {
      const [row] = await db
        .select()
        .from(ideas)
        .where(and(eq(ideas.id, id), eq(ideas.ownerId, ownerId)))
        .limit(1);
      return row ? toRecord(row) : null;
    },

    /**
     * A single idea by id, NOT owner-scoped. Only called after the audience layer
     * has already authorized the caller to read it (the clone path) — never a
     * substitute for that check. Returns null when the idea has vanished.
     */
    async findById(id: string): Promise<IdeaRecord | null> {
      const [row] = await db.select().from(ideas).where(eq(ideas.id, id)).limit(1);
      return row ? toRecord(row) : null;
    },

    /** Persist a new idea owned by the caller; returns the stored record. */
    async create(ownerId: string, input: CreateIdeaInput): Promise<IdeaRecord> {
      const [row] = await db
        .insert(ideas)
        .values({
          ownerId,
          name: input.name,
          thesis: input.thesis,
          state: input.state,
        })
        .returning();
      if (!row) throw new Error('Idea vanished after insert');
      return toRecord(row);
    },

    /**
     * Update mutable fields, scoped to the owner (§8). Returns the updated record,
     * or null when the id is not the caller's (→ 404). A no-field patch still
     * confirms ownership and returns the current record unchanged.
     */
    async update(ownerId: string, id: string, patch: UpdateIdeaPatch): Promise<IdeaRecord | null> {
      const set: Partial<{
        name: string;
        thesis: string | null;
        state: IdeaWorkboardState;
        updatedAt: Date;
      }> = {};
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.thesis !== undefined) set.thesis = patch.thesis;
      if (patch.state !== undefined) set.state = patch.state;

      if (Object.keys(set).length === 0) {
        return this.findByIdForOwner(ownerId, id);
      }
      set.updatedAt = new Date();
      const [row] = await db
        .update(ideas)
        .set(set)
        .where(and(eq(ideas.id, id), eq(ideas.ownerId, ownerId)))
        .returning();
      return row ? toRecord(row) : null;
    },

    /** Hard-delete, scoped to the owner. Returns false when the id is not owned. */
    async delete(ownerId: string, id: string): Promise<boolean> {
      const rows = await db
        .delete(ideas)
        .where(and(eq(ideas.id, id), eq(ideas.ownerId, ownerId)))
        .returning({ id: ideas.id });
      return rows.length > 0;
    },

    /** Whether `ownerId` owns idea `id` — used to gate audience mutations (§8). */
    async ownsIdea(ownerId: string, id: string): Promise<boolean> {
      const [row] = await db
        .select({ id: ideas.id })
        .from(ideas)
        .where(and(eq(ideas.id, id), eq(ideas.ownerId, ownerId)))
        .limit(1);
      return row !== undefined;
    },
  };
}

export type IdeaRepository = ReturnType<typeof createIdeaRepository>;
