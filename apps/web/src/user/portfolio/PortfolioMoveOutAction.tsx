import { useState } from 'react';

import { useQuery } from '@tanstack/react-query';

import type { EndpointVaultState } from '../vault/keystore';
import type { PortfolioVaultStub } from './lockedPortfolio';

import { useT } from '../../i18n';
import { listVaults, VAULTS_QUERY_KEY } from '../../lib/vaultApi';
import { Button } from '../../ui/origin';
import {
  moveOutUnlocked,
  resolvePortfolioVaultMoveCapture,
  submitPortfolioMoveOut,
  type PortfolioVaultMoveCapture,
} from '../vault/portfolioVaultMove';
import { PortfolioVaultMoveWizard } from '../vault/ui/PortfolioVaultMoveWizard';
import { useVaultEndpointState } from '../vault/ui/useVaultEndpointState';

/**
 * "Leave the vault", wherever a vaulted portfolio is shown (§10).
 *
 * Extracted from `LockedPortfolioStub` when the unlocked in-place view shipped
 * (#1416): the locked stub and the unlocked overview both have to offer it, and
 * two copies of a destructive flow is exactly the kind of duplication where one
 * side silently loses a precondition. The wizard still states the price and
 * refuses without a step-up credential.
 */
export function PortfolioMoveOutAction({
  portfolio,
  state: suppliedState,
  displayName,
  capture = resolvePortfolioVaultMoveCapture(),
  onMoved,
}: {
  portfolio: PortfolioVaultStub;
  /** Endpoint custody state, when the caller already holds it. */
  state?: EndpointVaultState;
  /** The name to show in the wizard — the alias while locked, the real one once open. */
  displayName: string;
  capture?: PortfolioVaultMoveCapture | null;
  onMoved?: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  // Read it here when the caller has none. `moveOutUnlocked` treats a missing
  // state as LOCKED, so a caller that simply forgot would show the "unlock this
  // vault first" precondition on a vault that is demonstrably open — which is
  // exactly what happened to the unlocked in-place view before this fallback
  // existed. The query key is shared, so the stub's own read is not doubled.
  const stateQuery = useVaultEndpointState(suppliedState || !open ? null : portfolio.vaultId);
  const state = suppliedState ?? stateQuery.data;
  // An UNKNOWN custody state is not a locked one. `moveOutUnlocked` cannot tell
  // them apart — both are falsy — so the wizard would state "unlock this vault
  // on this device" about a vault whose state simply has not arrived yet. These
  // two flags keep the wizard behind the answer instead of guessing it.
  const stateLoading = suppliedState === undefined && stateQuery.isPending;
  const stateFailed = suppliedState === undefined && stateQuery.isError;
  // Cleartext vault config, shared with the shell's chip cache — the move-out
  // wizard names the vault the portfolio is leaving.
  const vaultsQuery = useQuery({
    queryKey: VAULTS_QUERY_KEY,
    queryFn: ({ signal }) => listVaults(signal),
    enabled: open,
    staleTime: 600_000,
  });
  const vault = (vaultsQuery.data ?? []).find((entry) => entry.id === portfolio.vaultId) ?? null;

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} size="sm" type="button" variant="quiet">
        {t('vault.portfolioMove.moveOut.action')}
      </Button>
    );
  }
  if (vaultsQuery.isPending || stateLoading) {
    return <p className="bt-meta">{t('common.loading')}</p>;
  }
  if (vaultsQuery.isError || stateFailed || vault === null) {
    return (
      <div className="bt-soft flex flex-wrap items-center justify-between gap-3" role="alert">
        <span>{t('vault.manager.loadError')}</span>
        <Button
          onClick={() => {
            void vaultsQuery.refetch();
            void stateQuery.refetch();
          }}
          size="sm"
          type="button"
        >
          {t('common.retry')}
        </Button>
      </div>
    );
  }
  return (
    <PortfolioVaultMoveWizard
      mode="out"
      onCancel={() => setOpen(false)}
      onSubmit={async ({ stepUp }) => {
        if (!capture) throw new Error('portfolio-vault-move-unavailable');
        await submitPortfolioMoveOut({ portfolio, vault, stepUp, capture });
        setOpen(false);
        onMoved?.();
      }}
      portfolioName={displayName}
      preconditions={
        capture === null
          ? [
              {
                id: 'capture-unavailable',
                messageKey: 'vault.portfolioMove.precondition.captureUnavailable',
              },
            ]
          : []
      }
      unlocked={moveOutUnlocked(state, capture)}
      vaultName={vault.name}
    />
  );
}
