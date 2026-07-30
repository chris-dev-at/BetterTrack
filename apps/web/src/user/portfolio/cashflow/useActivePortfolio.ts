import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import { listPortfolios } from '../../../lib/portfolioApi';
import { ACTIVE_PORTFOLIO_PARAM, resolveActivePortfolio } from '../PortfolioSwitcher';

/**
 * Resolve the active portfolio exactly the way every portfolio-scoped page
 * does (`?portfolio=<id>` → `resolveActivePortfolio`; `CashSourcesPage.tsx` is
 * the style reference) — shared by the cash-flow sub-tabs so each of them
 * doesn't repeat the same lookup.
 */
export function useActivePortfolio() {
  const [searchParams] = useSearchParams();
  const portfoliosQuery = useQuery({
    queryKey: ['portfolios'],
    queryFn: ({ signal }) => listPortfolios(signal),
    staleTime: 60_000,
  });
  const activeParam = searchParams.get(ACTIVE_PORTFOLIO_PARAM);
  const portfolio = useMemo(
    () => resolveActivePortfolio(portfoliosQuery.data?.portfolios ?? [], activeParam),
    [portfoliosQuery.data, activeParam],
  );
  return { portfoliosQuery, portfolio, portfolioId: portfolio?.id ?? null };
}
