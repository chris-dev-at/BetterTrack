import type { VaultKnowledge } from './sectionState';

/**
 * Aggregate coverage with vaults (`docs/VAULTS_V2_DESIGN.md` r2 §12).
 *
 * r2 adds a fourth coverage state, `lockedExcluded`, and makes the qualifier
 * **mandatory**: while any vault is locked, no cross-portfolio total may render
 * as a bare number. A dashboard that quietly shows €40k when €25k is sitting in
 * a locked vault is worse than useless — it is wrong, and the user has no way
 * to tell. The arithmetic here is identical on web and mobile by contract.
 */

/** The existing three states plus r2's fourth. */
export type VaultCoverageState = 'complete' | 'partial' | 'unavailable' | 'lockedExcluded';

export interface LockedAggregate {
  /** The sum over portfolios this client can actually read. */
  visibleTotal: number;
  /** How many portfolios were excluded because their vault is locked. */
  lockedCount: number;
  /** How many were excluded because their blob could not be read (r2 §8). */
  unavailableCount: number;
  coverage: VaultCoverageState;
  /** True when a bare total must NOT be rendered. */
  requiresQualifier: boolean;
  /** The vaults contributing exclusions, for the per-vault lock chips. */
  lockedVaults: { vaultId: string; name: string; portfolioCount: number }[];
}

export interface AggregateInput {
  /** Portfolio ids the caller summed, with their values. */
  visible: { portfolioId: string; value: number }[];
  vaults: VaultKnowledge[];
  /** Portfolio ids whose blob is named by a header index but unreadable. */
  unavailablePortfolioIds?: readonly string[];
  /** Coverage the caller already computed from price data alone. */
  priceCoverage?: 'complete' | 'partial';
}

/**
 * Fold vault lock state into an aggregate.
 *
 * `lockedExcluded` wins over `partial`: a missing price is a quality caveat,
 * while a locked vault is a whole portfolio absent from the number, and the
 * user must be told about the larger omission first.
 */
export function foldVaultCoverage(input: AggregateInput): LockedAggregate {
  const unavailable = new Set(input.unavailablePortfolioIds ?? []);
  const visibleIds = new Set(input.visible.map((entry) => entry.portfolioId));

  const lockedVaults: LockedAggregate['lockedVaults'] = [];
  let lockedCount = 0;

  for (const vault of input.vaults) {
    if (vault.unlocked) continue;
    const members = new Set<string>([
      ...(vault.header?.portfolios.map((entry) => entry.portfolioId) ?? []),
      ...vault.summary.portfolioIds,
    ]);
    const excluded = [...members].filter((id) => !visibleIds.has(id) && !unavailable.has(id));
    if (excluded.length === 0) continue;
    lockedCount += excluded.length;
    lockedVaults.push({
      vaultId: vault.summary.id,
      name: vault.summary.name,
      portfolioCount: excluded.length,
    });
  }

  const unavailableCount = unavailable.size;
  const visibleTotal = input.visible.reduce((sum, entry) => sum + entry.value, 0);

  const coverage: VaultCoverageState =
    unavailableCount > 0
      ? 'unavailable'
      : lockedCount > 0
        ? 'lockedExcluded'
        : (input.priceCoverage ?? 'complete');

  return {
    visibleTotal,
    lockedCount,
    unavailableCount,
    coverage,
    requiresQualifier: lockedCount > 0 || unavailableCount > 0,
    lockedVaults,
  };
}

/**
 * The i18n key + variables for the mandatory qualifier. Returning a descriptor
 * rather than a string keeps the arithmetic here and the wording in the
 * catalog, and lets tests assert the qualifier exists without matching prose.
 */
export function qualifierFor(
  aggregate: LockedAggregate,
): { key: string; vars: Record<string, number> } | null {
  if (!aggregate.requiresQualifier) return null;
  if (aggregate.unavailableCount > 0 && aggregate.lockedCount > 0) {
    return {
      key: 'vault.v2.aggregate.lockedAndUnavailable',
      vars: { locked: aggregate.lockedCount, unavailable: aggregate.unavailableCount },
    };
  }
  if (aggregate.unavailableCount > 0) {
    return {
      key: 'vault.v2.aggregate.unavailable',
      vars: { count: aggregate.unavailableCount },
    };
  }
  return { key: 'vault.v2.aggregate.locked', vars: { count: aggregate.lockedCount } };
}
