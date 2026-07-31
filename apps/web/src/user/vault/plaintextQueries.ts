import type { QueryClient } from '@tanstack/react-query';

/**
 * The TanStack query roots that cache SERVER-DERIVED money data — the entries a
 * paranoid session must never be served, because in paranoid mode the server
 * holds no portfolio bytes and every figure is computed client-side after local
 * decryption (`docs/paranoid-design.md` §8).
 *
 * One home, two callers, because the account can cross this boundary in either
 * direction and both crossings must evict the same set:
 *
 * - normal → paranoid, at enable (`usePrivacyMode.acceptEnabled`);
 * - paranoid → locked/normal, at lock or disable (`AccountModeRoot`).
 *
 * A second copy of this list would drift the moment a feature adds a query root,
 * and the failure is silent in both directions: stale plaintext served into a
 * paranoid session, or a live query evicted from a normal one.
 */
export const PLAINTEXT_QUERY_ROOTS = new Set([
  'analytics',
  'cash',
  'custom-asset',
  'custom-assets',
  'expenses',
  'forecast',
  'portfolio',
  'portfolios',
  'standingOrders',
  'tax',
  'transactions',
]);

/** Drop every cached server-derived money read. */
export function removePlaintextQueries(cache: QueryClient): void {
  cache.removeQueries({
    predicate: (query) => {
      const root = query.queryKey[0];
      return (
        (typeof root === 'string' && PLAINTEXT_QUERY_ROOTS.has(root)) ||
        (root === 'settings' && query.queryKey[1] === 'taxes')
      );
    },
  });
}
