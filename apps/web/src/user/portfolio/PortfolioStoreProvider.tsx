import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { apiPortfolioStore, type PortfolioStore } from '../../lib/portfolioStore';

/**
 * What the store under this subtree can actually do, stated up front instead of
 * discovered by calling it and catching the refusal (#1416; paranoid-UX failure
 * map #7).
 *
 * The resolver-backed vault store refuses every row operation by CONSTRUCTION —
 * it carries a derivation engine and an authenticated snapshot, not a mutation
 * store — so a surface that offers "+ Transaction" over it is offering a button
 * whose only possible outcome is an error. A refusal-by-design is also not an
 * outage: presenting it through the ordinary error path put a permanent "This
 * information isn't available." above the net-worth headline of a portfolio
 * that was rendering perfectly.
 */
export interface PortfolioStoreCapabilities {
  /** Row writes (record a trade, deposit, custom investment) reach a store. */
  readonly writes: boolean;
  /** Row reads (transactions, cash sources, movements) answer rather than refuse. */
  readonly rowReads: boolean;
  /**
   * A server endpoint under this subtree may be given THIS portfolio's id.
   *
   * False inside an unlocked vault portfolio, where it is not a preference but
   * an arithmetic fact: `createVaultedPortfolioRouteGuard` reads a portfolio id
   * off the path, the query or the body and answers 403 VAULTED_PORTFOLIO
   * (§6.16 kills server-computed reads for a vaulted portfolio), so such a
   * request is doomed before it is written — doubled by `apiRetryPolicy` and
   * swallowed by whatever asked. Surfaces state it up front instead of calling
   * and catching the refusal (#1416, paranoid-UX failure map #7).
   *
   * SEPARATE FROM `rowReads` ON PURPOSE (#1981). The two answer different
   * questions — "does the store answer row projections?" versus "may an
   * endpoint be handed this id?" — and they are already diverging: since #1532
   * the resolver-backed vault store serves the full row projection set out of
   * its authenticated document. A surface that reads `rowReads` to decide
   * whether to call the SERVER therefore sits on a flag that is expected to
   * flip for an unrelated reason, and the flip would silently restore the 403
   * storm this flag exists to prevent.
   *
   * It is a statement about the per-portfolio vault boundary only; a paranoid
   * ACCOUNT is fenced separately (`ParanoidSurfaceGate`, and the server's own
   * `createParanoidRouteGuard`).
   */
  readonly serverPortfolioReads: boolean;
}

export const FULL_PORTFOLIO_STORE_CAPABILITIES: PortfolioStoreCapabilities = {
  writes: true,
  rowReads: true,
  serverPortfolioReads: true,
};

interface PortfolioStoreBinding {
  store: PortfolioStore;
  /**
   * Extra query-key segments that scope this store's cache to THIS store.
   *
   * Empty for the account-level API store, which owns the default keyspace —
   * so every surface keyed `['portfolio', id, …]` today keeps sharing exactly
   * the cache entries it shares today. A per-portfolio vault access appends its
   * own identity instead, because a cache entry is only ever a valid answer for
   * the store that produced it: unlocking disposes the in-flight resolution,
   * its `getPortfolio` then rejects, and under a shared key that rejection is
   * what the freshly resolved, perfectly healthy store renders — the "Could not
   * load your portfolio. Please refresh the page." on an unlocked vault
   * (paranoid-UX failure map #1).
   */
  scope: readonly unknown[];
  capabilities: PortfolioStoreCapabilities;
}

const NO_SCOPE: readonly unknown[] = Object.freeze([]);

const PortfolioStoreContext = createContext<PortfolioStoreBinding>({
  store: apiPortfolioStore,
  scope: NO_SCOPE,
  capabilities: FULL_PORTFOLIO_STORE_CAPABILITIES,
});

export function PortfolioStoreProvider({
  children,
  store = apiPortfolioStore,
  scope = NO_SCOPE,
  capabilities = FULL_PORTFOLIO_STORE_CAPABILITIES,
}: {
  children: ReactNode;
  store?: PortfolioStore;
  scope?: readonly unknown[];
  capabilities?: PortfolioStoreCapabilities;
}) {
  const value = useMemo(() => ({ store, scope, capabilities }), [capabilities, scope, store]);
  return <PortfolioStoreContext.Provider value={value}>{children}</PortfolioStoreContext.Provider>;
}

export function usePortfolioStore(): PortfolioStore {
  return useContext(PortfolioStoreContext).store;
}

/** Append to a `['portfolio', id, …]` key so a dead store's answer cannot be read as this one's. */
export function usePortfolioStoreScope(): readonly unknown[] {
  return useContext(PortfolioStoreContext).scope;
}

export function usePortfolioStoreCapabilities(): PortfolioStoreCapabilities {
  return useContext(PortfolioStoreContext).capabilities;
}
