import { createContext, useContext, type ReactNode } from 'react';

import { apiPortfolioStore, type PortfolioStore } from '../../lib/portfolioStore';

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
