import { eq } from 'drizzle-orm';

import type { Database } from '../db';
import { assets, portfolios } from '../schema';

export interface ParanoidOwnedSubject {
  /** False means the id no longer resolves; privacy guards treat that fail-closed. */
  exists: boolean;
  /** Null is valid only for a global market asset. */
  userId: string | null;
}

/**
 * Ownership lookups shared by the API context and worker privacy bindings.
 * Keeping them here avoids duplicating SQL in those two composition roots.
 */
export function createParanoidEnforcementRepository(db: Database) {
  return {
    async portfolioOwner(portfolioId: string): Promise<ParanoidOwnedSubject> {
      const [row] = await db
        .select({ userId: portfolios.userId })
        .from(portfolios)
        .where(eq(portfolios.id, portfolioId))
        .limit(1);
      return row ? { exists: true, userId: row.userId } : { exists: false, userId: null };
    },

    async assetOwner(assetId: string): Promise<ParanoidOwnedSubject> {
      const [row] = await db
        .select({ userId: assets.ownerId })
        .from(assets)
        .where(eq(assets.id, assetId))
        .limit(1);
      return row ? { exists: true, userId: row.userId } : { exists: false, userId: null };
    },
  };
}

export type ParanoidEnforcementRepository = ReturnType<typeof createParanoidEnforcementRepository>;
