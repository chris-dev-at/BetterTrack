import { createContext, useContext, type ReactNode } from 'react';

import { apiPortfolioStore, type PortfolioStore } from '../../lib/portfolioStore';

/**
 * One application-level selection point for portfolio reads and mutations.
 * Normal sessions use the API implementation; the paranoid bootstrap supplies
 * its authenticated vault-backed store here before rendering portfolio surfaces.
 */
const PortfolioStoreContext = createContext<PortfolioStore>(apiPortfolioStore);

export function PortfolioStoreProvider({
  children,
  store = apiPortfolioStore,
}: {
  children: ReactNode;
  store?: PortfolioStore;
}) {
  return <PortfolioStoreContext.Provider value={store}>{children}</PortfolioStoreContext.Provider>;
}

export function usePortfolioStore(): PortfolioStore {
  return useContext(PortfolioStoreContext);
}
