import { and, eq, isNotNull, or, sql } from 'drizzle-orm';

import type { Database } from '../db';
import { assetIdentities, portfolios, portfolioVaultTransitionStates } from '../schema';

/** Content-free owner lookup survives E4's custom-asset content deletion. */
export async function portfolioVaultLiveRetirementOwner(
  db: Database,
  assetId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ ownerId: assetIdentities.ownerId })
    .from(assetIdentities)
    .where(eq(assetIdentities.id, assetId))
    .limit(1);
  return row?.ownerId ?? null;
}

/**
 * Resolve a crash-ambiguous Redis fence from durable Postgres state. The
 * caller holds the owner's account privacy lock, so an in-flight move-in must
 * commit or roll back before this answer can reopen the generation.
 */
export async function isPortfolioVaultLiveRetirementRequired(
  db: Database,
  userId: string,
  assetId: string,
): Promise<boolean> {
  const inMoveInSet = sql<boolean>`cast(${assetId} as uuid) = any(${portfolioVaultTransitionStates.moveInRetiredCustomAssetIds})`;
  const inPendingMoveOutSet = sql<boolean>`cast(${assetId} as uuid) = any(${portfolioVaultTransitionStates.moveOutPostCommitCustomAssetIds})`;
  const [row] = await db
    .select({ portfolioId: portfolioVaultTransitionStates.portfolioId })
    .from(portfolioVaultTransitionStates)
    .innerJoin(portfolios, eq(portfolios.id, portfolioVaultTransitionStates.portfolioId))
    .where(
      and(
        eq(portfolioVaultTransitionStates.userId, userId),
        or(
          and(isNotNull(portfolios.vaultId), inMoveInSet),
          and(
            eq(portfolioVaultTransitionStates.moveOutPostCommitPending, true),
            inPendingMoveOutSet,
          ),
        ),
      ),
    )
    .limit(1);
  return row !== undefined;
}
