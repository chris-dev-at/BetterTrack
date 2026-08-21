import type { PortfolioSummary } from '@bettertrack/contracts';

export type PortfolioVaultStub = PortfolioSummary & { vaultId: string };

export function isVaultedPortfolio(
  portfolio: PortfolioSummary | null | undefined,
): portfolio is PortfolioVaultStub {
  return typeof portfolio?.vaultId === 'string' && portfolio.vaultId.length > 0;
}

/** The real portfolio name is never a fallback for a locked stub. */
export function portfolioDisplayName(portfolio: PortfolioSummary, lockedFallback: string): string {
  if (!isVaultedPortfolio(portfolio)) return portfolio.name;
  const alias = portfolio.vaultAlias?.trim();
  return alias && alias.length > 0 ? alias : lockedFallback;
}

export function lockedPortfolioCount(portfolios: readonly PortfolioSummary[]): number {
  return portfolios.filter(isVaultedPortfolio).length;
}
