import { isVaultedPortfolioStubName, type PortfolioSummary } from '@bettertrack/contracts';

export type PortfolioVaultStub = PortfolioSummary & { vaultId: string };

export function isVaultedPortfolio(
  portfolio: PortfolioSummary | null | undefined,
): portfolio is PortfolioVaultStub {
  return typeof portfolio?.vaultId === 'string' && portfolio.vaultId.length > 0;
}

/**
 * The name to render for one portfolio row.
 *
 * THREE INPUTS, in falling order of truth:
 *
 *  1. `unlockedName` — the DECRYPTED name, and only ever passed when this
 *     device is holding a live resolution for that portfolio right now
 *     (`useUnlockedPortfolioNames`). A vault that is open on this device has
 *     already put the real name on screen inside the workspace; showing the
 *     vault's alias for the same portfolio in the switcher beside it is not
 *     privacy, it is two names for one thing — and with two portfolios in one
 *     vault it made them indistinguishable (paranoid-UX failure map #6).
 *  2. `vaultAlias` — the cleartext locked-stub label the server can route by.
 *  3. `lockedFallback` — a vault with no alias at all.
 *
 * The real portfolio name is never a fallback for a LOCKED stub: `portfolio.name`
 * is only ever read for a row that is not in a vault, and even then only after
 * the server sentinel check below.
 */
export function portfolioDisplayName(
  portfolio: PortfolioSummary,
  lockedFallback: string,
  unlockedName?: string | null,
): string {
  if (!isVaultedPortfolio(portfolio)) {
    // BELT AND BRACES. A vaulted row's `name` column carries E4's content-free
    // sentinel (`__vaulted_portfolio__:<uuid>`), which is not a name and must
    // never reach a screen. `vaultId` is what classifies the row and it has
    // always been set alongside the sentinel — but one caller reading `.name`
    // directly is all it took to print the raw sentinel as a dialog subtitle
    // (failure map #6), so the sentinel is refused here too, at the one seam
    // every surface is supposed to go through.
    return isVaultedPortfolioStubName(portfolio.name) ? lockedFallback : portfolio.name;
  }
  const decrypted = unlockedName?.trim();
  if (decrypted !== undefined && decrypted.length > 0) return decrypted;
  const alias = portfolio.vaultAlias?.trim();
  return alias !== undefined && alias.length > 0 ? alias : lockedFallback;
}

export function lockedPortfolioCount(portfolios: readonly PortfolioSummary[]): number {
  return portfolios.filter(isVaultedPortfolio).length;
}
