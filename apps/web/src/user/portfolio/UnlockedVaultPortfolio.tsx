import { useMemo, type ReactNode } from 'react';

import { useT } from '../../i18n';
import { Badge } from '../../ui/origin';
import type { UnlockedVaultPortfolioAccess } from '../vault/resolvedPortfolioStore';
import type { PortfolioVaultStub } from './lockedPortfolio';
import { PortfolioMoveOutAction } from './PortfolioMoveOutAction';
import { PortfolioStoreProvider, type PortfolioStoreCapabilities } from './PortfolioStoreProvider';

/**
 * What a resolver-backed access can serve, as the surfaces below are told
 * BEFORE they offer anything (#1416, `resolvedPortfolioStore.refusingRowStore`):
 * the overview's derivations, and nothing else. Row reads refuse because this
 * resolution carries a derivation engine rather than the account-level mutation
 * store those projections are written against; writes refuse because a
 * resolution is a READ of an authenticated snapshot and owns no CAS write path.
 */
const RESOLVED_VAULT_STORE_CAPABILITIES: PortfolioStoreCapabilities = {
  writes: false,
  rowReads: false,
};

/**
 * The unlocked in-place view of a vaulted portfolio (PARANOID-E6 residual,
 * #1416) — the surface whose absence the E10 A10 arc used to record.
 *
 * Everything below the strip reads through the resolver-backed client store,
 * scoped to this subtree only: the shell above keeps the API store, so the
 * switcher and every account-level surface stay on the server stub roster.
 *
 * The strip is not decoration. A user looking at real balances has to be able
 * to tell that they are looking INTO a vault this device happens to have open —
 * otherwise "unlocked" and "never sealed" render identically — and §10 requires
 * that leaving the vault stay reachable from wherever the portfolio is shown,
 * exactly as it is from the locked stub.
 */
export function UnlockedVaultPortfolio({
  access,
  portfolio,
  children,
  onMoved,
}: {
  access: UnlockedVaultPortfolioAccess;
  /** The server stub, which is what the move-out request is addressed to. */
  portfolio: PortfolioVaultStub;
  children: ReactNode;
  onMoved?: () => void;
}) {
  const t = useT();
  // The cache scope is the ACCESS's, so the answers a disposed resolution left
  // behind can never be read as this one's (failure map #1).
  const scope = useMemo(() => [{ vaultAccess: access.accessId }], [access.accessId]);

  return (
    <section className="flex flex-col gap-4" data-testid="unlocked-vault-portfolio">
      <div className="bt-panel flex flex-wrap items-center gap-3 p-4">
        <Badge tone="gold">{t('vault.unlockedPortfolio.badge')}</Badge>
        <p className="bt-soft m-0 flex-1 text-sm">{t('vault.unlockedPortfolio.body')}</p>
        <PortfolioMoveOutAction
          displayName={access.portfolio.name}
          onMoved={onMoved}
          portfolio={portfolio}
        />
      </div>
      <PortfolioStoreProvider
        capabilities={RESOLVED_VAULT_STORE_CAPABILITIES}
        scope={scope}
        store={access.store}
      >
        {children}
      </PortfolioStoreProvider>
    </section>
  );
}
