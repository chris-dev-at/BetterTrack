import type { EndpointVaultState } from '../vault/keystore';
import type { PortfolioVaultStub } from './lockedPortfolio';

import { useT } from '../../i18n';
import { Badge, Button, PageHead } from '../../ui/origin';
import { VaultStateAction } from '../vault/ui/VaultStateAction';
import { useVaultEndpointState } from '../vault/ui/useVaultEndpointState';
import { portfolioDisplayName } from './lockedPortfolio';

export function LockedPortfolioStub({
  portfolio,
  state: suppliedState,
}: {
  portfolio: PortfolioVaultStub;
  state?: EndpointVaultState;
}) {
  const t = useT();
  const stateQuery = useVaultEndpointState(suppliedState ? null : portfolio.vaultId);
  const state = suppliedState ?? stateQuery.data;
  const alias = portfolioDisplayName(portfolio, t('vault.lockedStub.fallbackAlias'));

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
      </div>
    </section>
  );
}
