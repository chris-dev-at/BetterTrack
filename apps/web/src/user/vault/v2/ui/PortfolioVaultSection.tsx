import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { useT } from '../../../../i18n';
import { Badge, Button, Icon, SectionHead, SkeletonBlock } from '../../../../ui/origin';
import { resolveVaultSectionState, type VaultSectionState } from '../sectionState';
import { CreateVaultWizard } from './CreateVaultWizard';
import { MoveIntoVaultDialog } from './MoveIntoVaultDialog';
import { VAULT_HOW_IT_WORKS_PATH } from './routes';
import { useVaults } from './VaultsProvider';
import { VaultQrShareDialog } from './VaultQrShareDialog';
import { VaultUnlockDialog } from './VaultUnlockDialog';

/**
 * "Vault / Paranoid mode" on EVERY portfolio's settings page, always visible
 * (`docs/VAULTS_V2_DESIGN.md` §4 — the owner's explicit discoverability order).
 *
 * The section never hides: a user who has no vaults sees the explainer teaser
 * and the create CTA, which is the only way the feature gets discovered at all.
 * Which of the six states renders is decided by
 * {@link resolveVaultSectionState}, so the behaviour is unit-testable without a
 * DOM.
 */

export interface PortfolioVaultSectionProps {
  portfolioId: string;
  portfolioName: string;
  /** True while the account is still on the v1 account-level paranoid mode. */
  legacyParanoid?: boolean;
}

export function PortfolioVaultSection({
  portfolioId,
  portfolioName,
  legacyParanoid = false,
}: PortfolioVaultSectionProps) {
  const t = useT();
  const vaults = useVaults();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [unlockVaultId, setUnlockVaultId] = useState<string | null>(null);
  const [moveVaultId, setMoveVaultId] = useState<string | null>(null);
  const [qrVaultId, setQrVaultId] = useState<string | null>(null);

  const state: VaultSectionState = useMemo(
    () =>
      resolveVaultSectionState({
        portfolioId,
        status: vaults?.status ?? 'ready',
        vaults: vaults?.vaults ?? [],
        legacyParanoid,
      }),
    [legacyParanoid, portfolioId, vaults?.status, vaults?.vaults],
  );

  const knowledgeFor = (vaultId: string) =>
    vaults?.vaults.find((vault) => vault.summary.id === vaultId) ?? null;

  return (
    <section aria-label={t('vault.v2.section.heading')} className="bt-section">
      <SectionHead sub={t('vault.v2.section.sub')} title={t('vault.v2.section.heading')} />

      <div className="bt-panel flex flex-col gap-3">
        {state.kind === 'loading' ? <SkeletonBlock height={72} /> : null}

        {state.kind === 'error' ? (
          <p className="bt-field__error" role="alert">
            {t('vault.v2.section.error')}
          </p>
        ) : null}

        {state.kind === 'legacy' ? (
          <>
            <p className="bt-row-sub">{t('vault.v2.section.legacy.body')}</p>
            <div>
              <Link className="bt-btn" to="/control/privacy">
                {t('vault.v2.section.legacy.action')}
              </Link>
            </div>
          </>
        ) : null}

        {state.kind === 'no-vaults' ? (
          <>
            <p className="bt-row-sub">{t('vault.v2.section.teaser.body')}</p>
            <ul className="bt-band">
              {(['encrypted', 'separate', 'words'] as const).map((point) => (
                <li className="bt-band__row bt-row-sub" key={point}>
                  {t(`vault.v2.section.teaser.points.${point}`)}
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center gap-3">
              <Button icon="shield" onClick={() => setWizardOpen(true)} variant="primary">
                {t('vault.v2.section.actions.create')}
              </Button>
              <Link className="bt-link" to={VAULT_HOW_IT_WORKS_PATH}>
                {t('vault.v2.explainerLink')}
              </Link>
            </div>
          </>
        ) : null}

        {state.kind === 'joinable' ? (
          <>
            <p className="bt-row-sub">{t('vault.v2.section.joinable.body')}</p>
            <ul className="bt-band">
              {state.choices.map((choice) => (
                <li className="bt-band__row bt-settings-row" key={choice.vaultId}>
                  <span>
                    <span className="bt-row-title">{choice.name}</span>
                    <span className="bt-row-sub block">
                      {t(`vault.v2.backends.${backendKey(choice.backends)}`)}
                    </span>
                  </span>
                  <Button onClick={() => setMoveVaultId(choice.vaultId)} size="sm">
                    {t('vault.v2.section.actions.move')}
                  </Button>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => setWizardOpen(true)} size="sm" variant="quiet">
                {t('vault.v2.section.actions.createAnother')}
              </Button>
              <Link className="bt-link" to={VAULT_HOW_IT_WORKS_PATH}>
                {t('vault.v2.explainerLink')}
              </Link>
            </div>
          </>
        ) : null}

        {state.kind === 'vaulted-locked' || state.kind === 'vaulted-unlocked' ? (
          <>
            <div className="bt-settings-row">
              <span>
                <span className="bt-row-title">{state.vaultName}</span>
                <span className="bt-row-sub block">
                  {t('vault.v2.section.vaulted.alias', {
                    alias: state.alias ?? portfolioName,
                  })}
                </span>
              </span>
              <Badge tone={state.kind === 'vaulted-unlocked' ? 'pos' : 'neutral'}>
                {state.kind === 'vaulted-unlocked'
                  ? t('vault.v2.section.vaulted.unlocked')
                  : t('vault.v2.section.vaulted.locked')}
              </Badge>
            </div>

            <p className="bt-meta">
              <Icon name="cloud" size={14} /> {t(`vault.v2.backends.${backendKey(state.backends)}`)}
            </p>

            <div className="flex flex-wrap items-center gap-2">
              {state.kind === 'vaulted-locked' ? (
                <Button
                  icon="key"
                  onClick={() => setUnlockVaultId(state.vaultId)}
                  variant="primary"
                >
                  {t('vault.v2.section.actions.unlock')}
                </Button>
              ) : (
                <>
                  <Button icon="share" onClick={() => setQrVaultId(state.vaultId)}>
                    {t('vault.v2.section.actions.qr')}
                  </Button>
                  <Button
                    onClick={() => setMoveVaultId(null)}
                    title={t('vault.v2.section.actions.moveOutHint')}
                    variant="quiet"
                  >
                    {t('vault.v2.section.actions.moveOut')}
                  </Button>
                </>
              )}
              <Link className="bt-link" to={VAULT_HOW_IT_WORKS_PATH}>
                {t('vault.v2.explainerLink')}
              </Link>
            </div>
          </>
        ) : null}
      </div>

      <CreateVaultWizard
        onClose={() => setWizardOpen(false)}
        onCreated={() => void vaults?.refresh()}
        open={wizardOpen}
      />

      {unlockVaultId != null && vaults != null ? (
        <UnlockHost
          onClose={() => setUnlockVaultId(null)}
          vaultId={unlockVaultId}
          vaults={vaults}
        />
      ) : null}

      {moveVaultId != null && vaults != null ? (
        <MoveIntoVaultDialog
          knowledge={knowledgeFor(moveVaultId)}
          keyring={vaults.keyring}
          onClose={() => setMoveVaultId(null)}
          onMoved={() => void vaults.refresh()}
          open
          portfolioId={portfolioId}
          portfolioName={portfolioName}
        />
      ) : null}

      {qrVaultId != null && vaults != null ? (
        <VaultQrShareDialog
          keyring={vaults.keyring}
          onClose={() => setQrVaultId(null)}
          open
          vaultId={qrVaultId}
          vaultName={knowledgeFor(qrVaultId)?.summary.name ?? ''}
        />
      ) : null}
    </section>
  );
}

function UnlockHost({
  vaultId,
  vaults,
  onClose,
}: {
  vaultId: string;
  vaults: NonNullable<ReturnType<typeof useVaults>>;
  onClose: () => void;
}) {
  const knowledge = vaults.vaults.find((vault) => vault.summary.id === vaultId);
  if (knowledge?.header == null) return null;
  return (
    <VaultUnlockDialog
      header={knowledge.header}
      keyring={vaults.keyring}
      onClose={onClose}
      onUnlocked={() => void vaults.refresh()}
      open
      passphraseStore={vaults.passphraseStore}
      rememberedOnDevice={knowledge.rememberedOnDevice}
      vaultName={knowledge.summary.name}
    />
  );
}

/** `server` | `drive` | `both` as one i18n key. */
export function backendKey(backends: readonly string[]): 'server' | 'drive' | 'both' {
  const hasServer = backends.includes('server');
  const hasDrive = backends.includes('drive');
  if (hasServer && hasDrive) return 'both';
  return hasDrive ? 'drive' : 'server';
}
