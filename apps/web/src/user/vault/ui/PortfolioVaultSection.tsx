import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useQueries, useQuery } from '@tanstack/react-query';

import type { PortfolioSummary, VaultConfig } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { listVaults, VAULTS_QUERY_KEY } from '../../../lib/vaultApi';
import { Button, SectionHead, SkeletonBlock } from '../../../ui/origin';
import { isVaultedPortfolio } from '../../portfolio/lockedPortfolio';
import { portfolioSearch } from '../../portfolio/PortfolioSwitcher';
import { endpointVaultKeystore } from '../keystore/runtime';
import {
  moveInPreconditions,
  resolvePortfolioVaultMoveCapture,
  submitPortfolioMoveIn,
  type PortfolioVaultMoveCapture,
} from '../portfolioVaultMove';
import { isDriveOnlyVaultMedia, PortfolioVaultMoveWizard } from './PortfolioVaultMoveWizard';
import { vaultEndpointStateQueryKey } from './useVaultEndpointState';

/**
 * Portfolio settings → Private vault: the move-IN entry point (§9).
 *
 * It renders only for an account that already owns a vault — creating one lives
 * in Control Center → Privacy, and a section explaining vaults to everyone else
 * would be exactly the bloat the anti-bloat rule forbids. A portfolio that is
 * already inside a vault never reaches this page (the workspace renders its
 * locked stub instead), which is where move-OUT lives.
 */
export function PortfolioVaultSection({
  portfolio,
  onMoved,
  capture = resolvePortfolioVaultMoveCapture(),
}: {
  portfolio: PortfolioSummary;
  onMoved(): void;
  capture?: PortfolioVaultMoveCapture | null;
}) {
  const t = useT();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [selectedVaultId, setSelectedVaultId] = useState<string | null>(null);
  const vaultsQuery = useQuery({
    queryKey: VAULTS_QUERY_KEY,
    queryFn: ({ signal }) => listVaults(signal),
    staleTime: 600_000,
  });
  const vaults = vaultsQuery.data ?? [];
  const endpointStates = useQueries({
    queries: vaults.map((vault) => ({
      queryKey: vaultEndpointStateQueryKey(vault.id),
      queryFn: () => endpointVaultKeystore.stateFor(vault.id),
      staleTime: 5_000,
    })),
  });

  if (isVaultedPortfolio(portfolio)) return null;
  if (vaultsQuery.isPending) return <SkeletonBlock height={64} />;
  // No vault, or the directory is unreachable: the move-in entry stays absent
  // rather than opening a picker with nothing to pick.
  if (vaultsQuery.isError || vaults.length === 0) return null;

  const selectedIndex = vaults.findIndex((vault) => vault.id === selectedVaultId);
  const selected: VaultConfig | null = selectedIndex < 0 ? null : (vaults[selectedIndex] ?? null);

  return (
    <section aria-label={t('portfolio.settings.vaultHeading')} className="bt-section">
      <SectionHead title={t('portfolio.settings.vaultHeading')} />
      {/* The chosen target's device state decides whether the move can run at
          all, so its own loading/retry sits with the picker. */}
      {open && selectedIndex >= 0 && endpointStates[selectedIndex]?.isPending ? (
        <SkeletonBlock height={24} />
      ) : null}
      {open && selectedIndex >= 0 && endpointStates[selectedIndex]?.isError ? (
        <div className="bt-soft flex flex-wrap items-center justify-between gap-3" role="alert">
          <span>{t('vault.portfolioMove.targetStateError')}</span>
          <Button
            onClick={() => void endpointStates[selectedIndex]?.refetch()}
            size="sm"
            type="button"
          >
            {t('common.retry')}
          </Button>
        </div>
      ) : null}
      {open ? (
        <PortfolioVaultMoveWizard
          mode="in"
          onCancel={() => setOpen(false)}
          onSubmit={async ({ vaultId, stepUp }) => {
            const vault = vaults.find((candidate) => candidate.id === vaultId);
            if (!vault || !capture) throw new Error('portfolio-vault-move-unavailable');
            await submitPortfolioMoveIn({ portfolio, vault, stepUp, capture });
            setOpen(false);
            onMoved();
            // LEAVE THE PAGE THE MOVE JUST RETIRED (failure map #5). A vaulted
            // portfolio has no Settings route — the workspace collapses its
            // local nav to Overview and renders nothing for every other tab —
            // so a successful move-in left the user standing on a settings page
            // that had just emptied itself down to the strip and the footer.
            // That blank page is almost certainly the "I moved a portfolio into
            // a vault and I couldn't load it anymore" the owner reported.
            // Overview is the one surface this portfolio still has, and it is
            // also where the move's result is visible.
            navigate({ pathname: '/portfolio', search: portfolioSearch(portfolio.id) });
          }}
          onTargetChange={setSelectedVaultId}
          portfolioName={portfolio.name}
          preconditions={moveInPreconditions({
            portfolio,
            vault: selected,
            vaultState: selectedIndex < 0 ? undefined : endpointStates[selectedIndex]?.data,
            capture,
          })}
          vaults={vaults.map((vault) => ({
            id: vault.id,
            name: vault.name,
            driveOnly: isDriveOnlyVaultMedia(vault.media),
          }))}
        />
      ) : (
        <div className="bt-settings-row">
          <p className="bt-meta">{t('portfolio.settings.vaultHint')}</p>
          <Button onClick={() => setOpen(true)}>{t('vault.portfolioMove.moveIn.action')}</Button>
        </div>
      )}
    </section>
  );
}
