import type { Holding } from '@bettertrack/contracts';

/**
 * Merge the same asset held in several portfolios into one combined position,
 * for the widgets whose scope spans more than one portfolio (allocation,
 * top movers).
 *
 * The three money quantities are additive, so the merge is exact rather than an
 * approximation, and the two percentages are re-derived from the combined
 * quantities using the same denominators the server uses per portfolio:
 *
 *   day %   = Σ dayChange / (Σ marketValue − Σ dayChange)   ← previous value
 *   total % = Σ unrealisedPnl / Σ costBasis                 ← total return on cost
 *
 * A null input contributes nothing; a position whose denominator is zero or
 * unknown yields a null percentage rather than a fabricated one.
 */
export function mergeHoldings(groups: ReadonlyArray<readonly Holding[]>): Holding[] {
  if (groups.length === 1) return [...(groups[0] ?? [])];

  const merged = new Map<string, Holding>();
  for (const group of groups) {
    for (const holding of group) {
      const existing = merged.get(holding.asset.id);
      if (!existing) {
        merged.set(holding.asset.id, { ...holding });
        continue;
      }
      merged.set(holding.asset.id, {
        ...existing,
        quantity: existing.quantity + holding.quantity,
        realizedPnl: existing.realizedPnl + holding.realizedPnl,
        marketValueEur: addNullable(existing.marketValueEur, holding.marketValueEur),
        costBasisEur: addNullable(existing.costBasisEur, holding.costBasisEur),
        unrealizedPnlEur: addNullable(existing.unrealizedPnlEur, holding.unrealizedPnlEur),
        dayChangeEur: addNullable(existing.dayChangeEur, holding.dayChangeEur),
        // Re-derived below once every contribution is in; a blended average
        // cost/price across portfolios is not meaningful, so those stay as the
        // first portfolio's and are never rendered by the merging widgets.
        unrealizedPnlPct: null,
        dayChangePct: null,
      });
    }
  }

  return [...merged.values()].map((holding) => {
    const previous =
      holding.marketValueEur != null && holding.dayChangeEur != null
        ? holding.marketValueEur - holding.dayChangeEur
        : null;
    return {
      ...holding,
      dayChangePct:
        holding.dayChangeEur != null && previous != null && previous > 0
          ? (holding.dayChangeEur / previous) * 100
          : null,
      unrealizedPnlPct:
        holding.unrealizedPnlEur != null && holding.costBasisEur != null && holding.costBasisEur > 0
          ? (holding.unrealizedPnlEur / holding.costBasisEur) * 100
          : null,
    };
  });
}

function addNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a + b;
}
