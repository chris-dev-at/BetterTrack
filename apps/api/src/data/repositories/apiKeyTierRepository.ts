import { asc, eq, ne } from 'drizzle-orm';

import type { Database } from '../db';
import { apiKeyTiers, type ApiKeyTierRow } from '../schema';

/**
 * Admin-configurable API-key rate tiers (§13.5 V5-P10, issue 2/2). A tier is a
 * named (limit, window) pair the per-key limiter reads; a key references one via
 * `api_keys.tier_id` and unassigned keys fall back to the single `is_default`
 * tier. "Exactly one default" is enforced here (a transactional clear-then-set)
 * rather than by a DB constraint, so re-marking a default is one call.
 */
export interface CreateApiKeyTierInput {
  name: string;
  requestLimit: number;
  windowSec: number;
  isDefault?: boolean;
}

export interface UpdateApiKeyTierPatch {
  name?: string;
  requestLimit?: number;
  windowSec?: number;
  isDefault?: boolean;
}

export function createApiKeyTierRepository(db: Database) {
  return {
    /** All tiers, oldest first (a stable order for the admin editor). */
    async list(): Promise<ApiKeyTierRow[]> {
      return db.select().from(apiKeyTiers).orderBy(asc(apiKeyTiers.createdAt));
    },

    async getById(id: string): Promise<ApiKeyTierRow | undefined> {
      const [row] = await db.select().from(apiKeyTiers).where(eq(apiKeyTiers.id, id)).limit(1);
      return row;
    },

    /** The single `is_default` tier, or undefined when none is marked. */
    async getDefault(): Promise<ApiKeyTierRow | undefined> {
      const [row] = await db
        .select()
        .from(apiKeyTiers)
        .where(eq(apiKeyTiers.isDefault, true))
        .limit(1);
      return row;
    },

    async create(input: CreateApiKeyTierInput): Promise<ApiKeyTierRow> {
      return db.transaction(async (tx) => {
        if (input.isDefault) {
          await tx
            .update(apiKeyTiers)
            .set({ isDefault: false })
            .where(eq(apiKeyTiers.isDefault, true));
        }
        const [row] = await tx
          .insert(apiKeyTiers)
          .values({
            name: input.name,
            requestLimit: input.requestLimit,
            windowSec: input.windowSec,
            isDefault: input.isDefault ?? false,
          })
          .returning();
        if (!row) throw new Error('Failed to insert API-key tier');
        return row;
      });
    },

    async update(id: string, patch: UpdateApiKeyTierPatch): Promise<ApiKeyTierRow | undefined> {
      return db.transaction(async (tx) => {
        if (patch.isDefault === true) {
          // Clear any other default first so exactly one tier stays default.
          await tx.update(apiKeyTiers).set({ isDefault: false }).where(ne(apiKeyTiers.id, id));
        }
        const [row] = await tx
          .update(apiKeyTiers)
          .set({
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.requestLimit !== undefined ? { requestLimit: patch.requestLimit } : {}),
            ...(patch.windowSec !== undefined ? { windowSec: patch.windowSec } : {}),
            ...(patch.isDefault !== undefined ? { isDefault: patch.isDefault } : {}),
            updatedAt: new Date(),
          })
          .where(eq(apiKeyTiers.id, id))
          .returning();
        return row;
      });
    },

    /** Delete a tier; keys referencing it fall back to the default (FK set-null). */
    async delete(id: string): Promise<ApiKeyTierRow | undefined> {
      const [row] = await db.delete(apiKeyTiers).where(eq(apiKeyTiers.id, id)).returning();
      return row;
    },
  };
}

export type ApiKeyTierRepository = ReturnType<typeof createApiKeyTierRepository>;
