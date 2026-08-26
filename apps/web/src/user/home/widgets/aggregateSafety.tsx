import type { PortfolioSummary } from '@bettertrack/contracts';

import { useT } from '../../../i18n';

interface AggregateQueryState {
  isError: boolean;
  isPending: boolean;
  isFetching: boolean;
}

/**
 * Fail closed until E10 can attach authenticated document-set provenance to a
 * vaulted result. A server/API result for a vaulted stub is never trusted, even
 * if stale cache data exists beside a settled query error.
 */
export function hasUnsafeAggregateMember(
  portfolios: readonly PortfolioSummary[],
  results: readonly AggregateQueryState[],
): boolean {
  return (
    hasUntrustedVaultMember(portfolios) ||
    results.length !== portfolios.length ||
    results.some((result) => result.isError || (result.isPending && !result.isFetching))
  );
}

/** Check a full scope even when an established widget reads only a capped subset. */
export function hasUntrustedVaultMember(portfolios: readonly PortfolioSummary[]): boolean {
  return portfolios.some((portfolio) => portfolio.vaultId != null);
}

/** Shared non-numeric outcome for aggregate widgets that cannot prove completeness. */
export function UnavailableHomeAggregate() {
  const t = useT();
  return <p className="bt-soft text-sm">{t('common.unavailable')}</p>;
}
