import { lazy, Suspense, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useT } from '../../../i18n';
import { usePrivacyMode } from '../../vault/usePrivacyMode';
import { useOptionalVaultRuntime } from '../../vault/VaultRuntimeContext';
import { Alert } from '../../components/ui';
import { SkeletonBlock, Switch } from '../../../ui/origin';
import { useAuth } from '../../AuthContext';
import { PanelGroup, PanelHead, Row } from './panelKit';

export type Notice = { tone: 'error' | 'success' | 'info'; key: string } | null;

/**
 * Vault surfaces remain separate chunks. A normal-mode account opening Privacy
 * loads only the compact E7 transfer entry in addition to plain preferences;
 * the legacy account-vault management section arrives only for an account that
 * is already paranoid (#1089). The enable wizard is no longer among them — see
 * the ruling comment in the body.
 */
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
 * gated on the optional legacy runtime, which `AccountModeRoot` mounts for an
 * account that is ALREADY paranoid. A normal account has no account-level
 * section here at all any more — see the ruling comment in the body.
 */
export function PrivacyPanel() {
  const t = useT();
  const { user, toggleDiscreetMode } = useAuth();
  const privacy = usePrivacyMode(true, user?.id ?? null);
  const runtime = useOptionalVaultRuntime();
  const [searchParams] = useSearchParams();
  const [notice, setNotice] = useState<Notice>(null);
  const discreet = user?.discreetMode === true;

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
        <VaultTransferActions
          accountId={user?.id ?? null}
          onNotice={setNotice}
          runtime={runtime?.transfer}
        />
      </Suspense>

      {/*
        NO ACCOUNT-LEVEL ENABLE ENTRY (Chief ruling, PROJECTPLAN §16
        2026-08-30; supersedes the 2026-08-19 "ONE paranoid entry point" note
        that stood here).

        Two paranoid models were live on this one panel: the per-portfolio
        vaults above, and — directly under them — a "PARANOID MODE · Set up"
        row launching the account-level wizard whose first step still promises
        the account-wide feature kill (sharing off, public profile off) that
        the 2026-08-19 redefinition replaced with a per-portfolio kill. The
        legacy medium was also the only reachable Drive path
        (`PER_VAULT_DRIVE_PROVISIONING_AVAILABLE = false`), so a user following
        the more prominent-looking entry ended up fighting the re-auth of a
        superseded design.

        CLIENT ENTRY POINT ONLY. `POST /vault/enable` stays alive per §19 and
        every EXISTING account-level user keeps everything: the unlock gate,
        the management section below, disable, restore. This removes the way to
        newly opt IN from the UI — nothing else. Restoring it is one revert of
        this block plus its `ParanoidEnableWizard` import.
      */}
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
