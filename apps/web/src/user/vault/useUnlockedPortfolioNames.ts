import { useRef } from 'react';

import type { PortfolioSummary } from '@bettertrack/contracts';

import { useVaultedPortfolioStores } from './useVaultedPortfolioStores';

/**
 * The decrypted names of the vaulted portfolios this device is holding open,
 * by portfolio id — the identity half of the unlocked experience (#1416
 * residual; paranoid-UX failure map #6).
 *
 * WHY A SEPARATE HOOK. `useVaultedPortfolioStores` hands back whole access
 * objects: a client store, a derivation engine, decrypted documents. A
 * switcher row or a membership chip needs exactly one string from that, and
 * giving those surfaces the access object so they can reach `.portfolio.name`
 * themselves invites them to reach for the store as well. This narrows the
 * seam to the one field they may render.
 *
 * FAIL CLOSED, EVERY RENDER. Liveness is re-asked synchronously on each render
 * rather than cached with the snapshot, exactly as the workspace's render fork
 * does: the instant an access stops being current its name leaves the map, and
 * a currency check that THROWS counts as not current. What is left is the vault
 * alias — never the true name, and never the server's `name` sentinel.
 */
export function useUnlockedPortfolioNames(
  portfolios: readonly PortfolioSummary[],
): ReadonlyMap<string, string> {
  const { unlocked } = useVaultedPortfolioStores(portfolios);

  const live: [string, string][] = [];
  for (const [portfolioId, access] of unlocked) {
    let current = false;
    try {
      current = access.isCurrent();
    } catch {
      current = false;
    }
    if (!current) continue;
    const name = access.portfolio.name.trim();
    if (name.length > 0) live.push([portfolioId, name]);
  }
  live.sort(([left], [right]) => left.localeCompare(right));
  // Escapes, never the raw bytes: a literal NUL in a source file makes git
  // classify it as binary, and the whole file then reviews as "Bin 0 -> N bytes"
  // with no diff at all. Identical at runtime.
  const signature = live.map(([id, name]) => `${id}\u0000${name}`).join('\u0001');

  // Identity held stable across renders that changed nothing. The liveness loop
  // above has to run every render, so the Map it builds is new every render —
  // and this hook sits in the switcher, which is mounted on every portfolio
  // surface. Handing a fresh Map down would invalidate every consumer's memo on
  // each keystroke elsewhere in the tree, for a value that did not move.
  const cache = useRef<{ signature: string; names: ReadonlyMap<string, string> }>({
    signature: '',
    names: EMPTY_NAMES,
  });
  if (cache.current.signature !== signature) {
    cache.current = { signature, names: live.length === 0 ? EMPTY_NAMES : new Map(live) };
  }
  return cache.current.names;
}

const EMPTY_NAMES: ReadonlyMap<string, string> = new Map();
