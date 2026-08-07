import { lazy, Suspense, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { useT } from '../../../i18n';
import { usePrivacyMode } from '../../vault/usePrivacyMode';
import { useOptionalVaultRuntime } from '../../vault/VaultRuntimeContext';
import { Alert } from '../../components/ui';
import { Button, SkeletonBlock, Switch } from '../../../ui/origin';
import { useAuth } from '../../AuthContext';
import { VAULT_HOW_IT_WORKS_PATH } from '../../vault/v2/ui/routes';
import { VAULT_ENABLE_PARAM } from '../matchControlPanel';
import { PanelGroup, PanelHead, Row } from './panelKit';

export type Notice = { tone: 'error' | 'success' | 'info'; key: string } | null;

/**
 * Both vault halves are their own chunks. Everything above them in this file
 * is plain account preference, so a normal-mode account opening Privacy — the
 * only place discreet mode lives — downloads none of the client-encryption
 * stack; the wizard arrives with the deliberate setup gesture, the management
 * section only for an account that is already paranoid (#1089).
 */
const ParanoidEnableWizard = lazy(() =>
  import('../../vault/ui/ParanoidEnableWizard').then((module) => ({
    default: module.ParanoidEnableWizard,
  })),
);
const PrivacyVaultSection = lazy(() =>
  import('./PrivacyVaultSection').then((module) => ({ default: module.PrivacyVaultSection })),
);

/**
 * Control Center → Privacy: the compact entry point for both privacy modes.
 *
 * Discreet mode is a plain account preference, so the panel must render for a
 * normal account with NO vault runtime above it — it reads the runtime
 * optionally and every vault surface below is gated on it. `AccountModeRoot`
 * mounts that runtime for a paranoid account, and for a normal account only
 * once the user asks for the setup wizard (`?enable=1`), which is why the
 * wizard's open/closed state lives in the URL rather than in `useState`.
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

      {notice ? <Alert tone={notice.tone}>{t(notice.key)}</Alert> : null}

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
              Vaults v2 (docs/VAULTS_V2_DESIGN.md §4): paranoid mode is chosen
              PER PORTFOLIO now, so this panel no longer owns an account-level
              enable wizard. It signposts the per-portfolio flow and keeps one
              entry point for accounts still on the legacy account-wide vault.
            */}
            <Row hint={t('vault.v2.control.pointerHint')} label={t('vault.v2.control.pointer')}>
              <Link className="bt-btn bt-btn--sm" to="/portfolio/settings">
                {t('vault.v2.control.pointerAction')}
              </Link>
            </Row>
            <Row hint={t('vault.v2.control.explainerHint')} label={t('vault.v2.explainerLink')}>
              <Link className="bt-btn bt-btn--sm" to={VAULT_HOW_IT_WORKS_PATH}>
                {t('vault.v2.control.open')}
              </Link>
            </Row>
            <Row hint={t('vault.v2.control.legacyHint')} label={t('vault.v2.control.legacy')}>
              <Button
                aria-busy={wizard}
                disabled={wizard}
                onClick={() => setWizard(true)}
                size="sm"
              >
                {wizard ? t('common.loading') : t('vault.v2.control.legacyAction')}
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
