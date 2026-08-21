import { useState } from 'react';

import { useQuery } from '@tanstack/react-query';

import type { EndpointVaultState } from '../vault/keystore';
import type { PortfolioVaultStub } from './lockedPortfolio';

import { useT } from '../../i18n';
import { listVaults, VAULTS_QUERY_KEY } from '../../lib/vaultApi';
import { Badge, Button, PageHead } from '../../ui/origin';
import {
  moveOutUnlocked,
  resolvePortfolioVaultMoveCapture,
  submitPortfolioMoveOut,
  type PortfolioVaultMoveCapture,
} from '../vault/portfolioVaultMove';
import { PortfolioVaultMoveWizard } from '../vault/ui/PortfolioVaultMoveWizard';
import { VaultStateAction } from '../vault/ui/VaultStateAction';
import { useVaultEndpointState } from '../vault/ui/useVaultEndpointState';
import { portfolioDisplayName } from './lockedPortfolio';

export function LockedPortfolioStub({
  portfolio,
  state: suppliedState,
  capture = resolvePortfolioVaultMoveCapture(),
  onMoved,
}: {
  portfolio: PortfolioVaultStub;
  state?: EndpointVaultState;
  capture?: PortfolioVaultMoveCapture | null;
  onMoved?: () => void;
}) {
  const t = useT();
  const [moveOutOpen, setMoveOutOpen] = useState(false);
  const stateQuery = useVaultEndpointState(suppliedState ? null : portfolio.vaultId);
  const state = suppliedState ?? stateQuery.data;
  const alias = portfolioDisplayName(portfolio, t('vault.lockedStub.fallbackAlias'));
  // Cleartext vault config, shared with the shell's chip cache — the move-out
  // wizard names the vault the portfolio is leaving.
  const vaultsQuery = useQuery({
    queryKey: VAULTS_QUERY_KEY,
    queryFn: ({ signal }) => listVaults(signal),
    enabled: moveOutOpen,
    staleTime: 600_000,
  });
  const vault = (vaultsQuery.data ?? []).find((entry) => entry.id === portfolio.vaultId) ?? null;

  return (
    <section className="bt-money-surface flex flex-col gap-4" data-testid="locked-portfolio-stub">
      <PageHead sub={t('vault.lockedStub.subtitle')} title={alias} />
      <div className="bt-panel flex flex-col items-start gap-3 p-4">
        <Badge tone="gold">{t('vault.lockedStub.badge')}</Badge>
        <p className="bt-soft text-sm">{t('vault.lockedStub.body')}</p>
        {state ? (
          <VaultStateAction state={state} vaultId={portfolio.vaultId} />
        ) : (
          <Button
            disabled={stateQuery.isPending}
            onClick={() => void stateQuery.refetch()}
            size="sm"
            type="button"
            variant="quiet"
          >
            {stateQuery.isError ? t('common.retry') : t('common.loading')}
          </Button>
        )}
        {/* §10: leaving the vault is always offered from the stub itself — the
            wizard states the price and refuses without a step-up credential. */}
        {moveOutOpen ? null : (
          <Button onClick={() => setMoveOutOpen(true)} size="sm" type="button" variant="quiet">
            {t('vault.portfolioMove.moveOut.action')}
          </Button>
        )}
      </div>
      {moveOutOpen ? (
        vaultsQuery.isPending ? (
          <p className="bt-meta">{t('common.loading')}</p>
        ) : vaultsQuery.isError || vault === null ? (
          <div className="bt-soft flex flex-wrap items-center justify-between gap-3" role="alert">
            <span>{t('vault.manager.loadError')}</span>
            <Button onClick={() => void vaultsQuery.refetch()} size="sm" type="button">
              {t('common.retry')}
            </Button>
          </div>
        ) : (
          <PortfolioVaultMoveWizard
            mode="out"
            onCancel={() => setMoveOutOpen(false)}
            onSubmit={async ({ stepUp }) => {
              if (!capture) throw new Error('portfolio-vault-move-unavailable');
              await submitPortfolioMoveOut({ portfolio, vault, stepUp, capture });
              setMoveOutOpen(false);
              onMoved?.();
            }}
            portfolioName={alias}
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
        )
      ) : null}
    </section>
  );
}
