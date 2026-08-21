import { lazy, Suspense, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useT } from '../../../i18n';
import { usePrivacyMode } from '../../vault/usePrivacyMode';
import { useOptionalVaultRuntime } from '../../vault/VaultRuntimeContext';
import { Alert } from '../../components/ui';
import { Button, SkeletonBlock, Switch } from '../../../ui/origin';
import { useAuth } from '../../AuthContext';
import { VAULT_ENABLE_PARAM } from '../matchControlPanel';
import { PanelGroup, PanelHead, Row } from './panelKit';

export type Notice = { tone: 'error' | 'success' | 'info'; key: string } | null;

/**
 * Vault surfaces remain separate chunks. A normal-mode account opening Privacy
 * loads only the compact E7 transfer entry in addition to plain preferences;
 * the legacy account-vault wizard still arrives only with the setup gesture and
 * its management section only for an account that is already paranoid (#1089).
 */
const ParanoidEnableWizard = lazy(() =>
  import('../../vault/ui/ParanoidEnableWizard').then((module) => ({
    default: module.ParanoidEnableWizard,
  })),
);
const PrivacyVaultSection = lazy(() =>
  import('./PrivacyVaultSection').then((module) => ({ default: module.PrivacyVaultSection })),
);
const VaultManager = lazy(() =>
  import('../../vault/ui/VaultManager').then((module) => ({ default: module.VaultManager })),
);
const VaultTransferActions = lazy(() =>
  import('./VaultTransferActions').then((module) => ({ default: module.VaultTransferActions })),
);

/**
 * Control Center → Privacy: the compact entry point for both privacy modes.
 *
 * Discreet mode is a plain account preference, so the panel must render for a
 * normal account with NO legacy vault runtime above it. The per-vault transfer
 * surface falls back to its endpoint-wide runtime; account-level surfaces stay
 * gated on the optional legacy runtime. `AccountModeRoot` mounts that runtime
 * for a paranoid account, and for a normal account only once the user asks for
 * the setup wizard (`?enable=1`), which is why the wizard's open/closed state
 * lives in the URL rather than in `useState`.
 */
export function PrivacyPanel() {
  const t = useT();
  const { user, toggleDiscreetMode } = useAuth();
  const privacy = usePrivacyMode(true, user?.id ?? null);
  const runtime = useOptionalVaultRuntime();
  const [searchParams, setSearchParams] = useSearchParams();
  const [notice, setNotice] = useState<Notice>(null);
  const discreet = user?.discreetMode === true;
  const wizard = searchParams.get(VAULT_ENABLE_PARAM) === '1';

  /** `replace`: the whole overlay session stays ONE history entry (R2). */
  function setWizard(open: boolean) {
    setSearchParams(
      (params) => {
        const next = new URLSearchParams(params);
        if (open) next.set(VAULT_ENABLE_PARAM, '1');
        else next.delete(VAULT_ENABLE_PARAM);
        return next;
      },
      { replace: true },
    );
  }

  return (
    <div className="bt-cc-panel">
      <PanelHead title={t('control.privacy')} />

      <PanelGroup>
        <Row hint={t('privacy.discreet.body')} label={t('privacy.discreet.title')}>
          <Switch
            aria-label={t('privacy.discreet.title')}
            checked={discreet}
            onChange={() => {
              void toggleDiscreetMode().catch(() => undefined);
            }}
          />
        </Row>
      </PanelGroup>

      <Suspense fallback={<SkeletonBlock height={180} />}>
        <VaultManager />
      </Suspense>

      {notice ? <Alert tone={notice.tone}>{t(notice.key)}</Alert> : null}

      {/* E7 is per-vault and account-mode independent. Keeping this above the
          legacy v1 mode split makes receive reachable on a fresh endpoint;
          when the old runtime exists, its endpoint-wide session owns it. */}
      <Suspense fallback={<SkeletonBlock height={72} />}>
        <VaultTransferActions onNotice={setNotice} runtime={runtime?.transfer} />
      </Suspense>

      {privacy.privacyMode === 'normal' ? (
        // `runtime == null` while the enable request is still pulling the vault
        // chunk in: the entry row keeps its place until the providers exist,
        // with its button held busy so the pending gesture is visible and a
        // second click cannot re-request what is already on its way.
        wizard && runtime != null ? (
          <Suspense fallback={<SkeletonBlock height={180} />}>
            <ParanoidEnableWizard
              onCancel={() => setWizard(false)}
              onEnabled={(receipt) => {
                privacy.acceptEnabled(receipt);
                // Drop the request now that it is spent: the account is
                // paranoid from here, and a later disable inside the same
                // overlay session would otherwise land back on `?enable=1`
                // and re-open the setup wizard instead of the entry row.
                setWizard(false);
                setNotice({ tone: 'success', key: 'vault.enable.done' });
                void privacy.refetch();
              }}
            />
          </Suspense>
        ) : (
          <PanelGroup label={t('vault.settings.title')}>
            {/*
              The ONE paranoid entry point (owner ruling 2026-08-19, PROJECTPLAN
              §16). The per-portfolio "vaults v2" surface that used to signpost
              from here is gone, so this row owns the account-level V5-P13 setup
              wizard again — it is the only way into paranoid mode and must not
              be removed without replacing it.
            */}
            <Row hint={t('vault.settings.normalHint')} label={t('vault.settings.normal')}>
              <Button
                aria-busy={wizard}
                disabled={wizard}
                onClick={() => setWizard(true)}
                size="sm"
              >
                {wizard ? t('common.loading') : t('vault.settings.enable')}
              </Button>
            </Row>
          </PanelGroup>
        )
      ) : null}

      {privacy.privacyMode === 'paranoid' && privacy.mediaState != null && runtime != null ? (
        <Suspense fallback={<SkeletonBlock height={240} />}>
          <PrivacyVaultSection
            accountId={user?.id ?? null}
            mediaSet={privacy.mediaState.mediaSet}
            onDisabled={async () => {
              // The mode flip is NOT conditional on the local tidying: the
              // server already committed, so an account left rendering the
              // paranoid subtree because a Drive delete failed would be stuck
              // behind a lock whose vault no longer exists.
              try {
                await runtime.cleanupAfterDisable();
              } finally {
                privacy.acceptNormal();
                void privacy.refetch();
              }
            }}
            onNotice={setNotice}
            restoreOpen={searchParams.get('restore') === '1'}
            runtime={runtime}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
