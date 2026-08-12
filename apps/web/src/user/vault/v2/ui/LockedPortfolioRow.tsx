import { useMemo, useState } from 'react';

import { useT } from '../../../../i18n';
import { Icon } from '../../../../ui/origin';
import { lockedPortfolioIndex, type LockedPortfolioRow } from '../sectionState';
import { useVaults } from './VaultsProvider';
import { VaultUnlockDialog } from './VaultUnlockDialog';

/**
 * Locked vaulted portfolios on money surfaces (`docs/VAULTS_V2_DESIGN.md` §4):
 * "locked rows (alias + lock glyph) everywhere money renders; unlock prompt on
 * interaction".
 *
 * `useLockedPortfolios` is the hook every list calls; `LockedPortfolioCell` is
 * the shared row treatment so the dashboard, the portfolio list and the
 * analytics pickers cannot drift into three different lock affordances.
 */

export interface LockedPortfolios {
  index: ReadonlyMap<string, LockedPortfolioRow>;
  /** Render the unlock dialog for a row. Returns the element to mount. */
  isLocked: (portfolioId: string) => boolean;
}

export function useLockedPortfolios(): LockedPortfolios {
  const vaults = useVaults();
  const index = useMemo(() => lockedPortfolioIndex(vaults?.vaults ?? []), [vaults?.vaults]);
  return {
    index,
    isLocked: (portfolioId: string) => index.get(portfolioId)?.locked === true,
  };
}

export interface LockedPortfolioCellProps {
  row: LockedPortfolioRow;
  /** Rendered after a successful unlock (usually a list refresh). */
  onUnlocked?: () => void;
}

/**
 * One locked row. It is a button, not a link: activating it opens the unlock
 * prompt rather than navigating into a surface that would only render zeroes.
 */
export function LockedPortfolioCell({ row, onUnlocked }: LockedPortfolioCellProps) {
  const t = useT();
  const vaults = useVaults();
  const [unlocking, setUnlocking] = useState(false);
  const knowledge = vaults?.vaults.find((vault) => vault.summary.id === row.vaultId) ?? null;

  // r2 §8: an unreadable blob is its own state. It must never be rendered as an
  // empty portfolio or a zero balance, and unlocking will not fix it, so the
  // row offers no unlock affordance.
  if (row.unavailable) {
    return (
      <div
        aria-label={t('vault.v2.unavailable.aria', { alias: row.alias })}
        className="bt-settings-row"
        data-unavailable="true"
        role="status"
      >
        <span className="flex items-center gap-2">
          <Icon name="warning" size={15} />
          <span>
            <span className="bt-row-title">{row.alias}</span>
            <span className="bt-field__error block">{t('vault.v2.unavailable.title')}</span>
          </span>
        </span>
      </div>
    );
  }

  return (
    <>
      <button
        aria-label={t('vault.v2.locked.aria', { alias: row.alias, vault: row.vaultName })}
        className="bt-settings-row w-full text-left"
        data-locked="true"
        onClick={() => setUnlocking(true)}
        type="button"
      >
        <span className="flex items-center gap-2">
          <Icon name="lock" size={15} />
          <span>
            <span className="bt-row-title">{row.alias}</span>
            <span className="bt-row-sub block">
              {t('vault.v2.locked.hint', { vault: row.vaultName })}
            </span>
          </span>
        </span>
        <span className="bt-meta">{t('vault.v2.locked.action')}</span>
      </button>

      {unlocking && vaults != null && knowledge?.header != null ? (
        <VaultUnlockDialog
          header={knowledge.header}
          keyring={vaults.keyring}
          onClose={() => setUnlocking(false)}
          onUnlocked={() => {
            void vaults.refresh();
            onUnlocked?.();
          }}
          open
          passphraseStore={vaults.passphraseStore}
          rememberedOnDevice={knowledge.rememberedOnDevice}
          vaultName={knowledge.summary.name}
        />
      ) : null}
    </>
  );
}
