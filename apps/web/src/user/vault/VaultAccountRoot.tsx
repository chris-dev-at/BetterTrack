import { useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';

import { apiPortfolioStore } from '../../lib/portfolioStore';
import { useT } from '../../i18n';
import { useAuth } from '../AuthContext';
import { AuthCard, Button, Splash } from '../components/ui';
import { DeleteAccountPage } from '../settings/DeleteAccountPage';
import { PortfolioStoreProvider } from '../portfolio/PortfolioStoreProvider';
import { VaultMoneyEngineProvider, useVaultMoneySession } from './engine/VaultMoneyEngineProvider';
import { createParanoidAppPortfolioStore } from './engine/paranoidPortfolioStore';
import { removePlaintextQueries } from './plaintextQueries';
import { ResolvedPrivacyModeProvider, type PrivacyModeState } from './usePrivacyMode';
import { VaultRuntimeProvider } from './VaultRuntimeProvider';
import { useVaultRuntime } from './VaultRuntimeContext';
import { discardLockedVault } from './ui/disable';
import { ParanoidNavigationGate } from './ui/ParanoidSurfaceGate';
import { VaultUnlockGate } from './ui/VaultUnlockGate';

/**
 * Heavy vault boundary. `AccountModeRoot` imports this module only after the
 * account resolves to paranoid mode (or the user deliberately opens the
 * enable flow), so normal sessions never evaluate the crypto/money stack.
 */
export function VaultAccountRoot({
  children,
  privacy,
}: {
  children: ReactNode;
  privacy: PrivacyModeState;
}) {
  const { status, user } = useAuth();
  return (
    <VaultRuntimeProvider
      authenticated={status === 'authenticated'}
      userId={status === 'authenticated' ? user?.id : null}
    >
      <VaultMoneyEngineProvider>
        <VaultModeRoot privacy={privacy}>{children}</VaultModeRoot>
      </VaultMoneyEngineProvider>
    </VaultRuntimeProvider>
  );
}

/**
 * The loaded vault-mode gate. Exported for the focused privacy/phase matrix;
 * production callers mount {@link VaultAccountRoot} so the providers exist
 * before a paranoid account attempts its trusted-device unlock.
 */
export function VaultModeRoot({
  children,
  privacy,
}: {
  children: ReactNode;
  privacy: PrivacyModeState;
}) {
  const t = useT();
  const location = useLocation();
  const { status, user } = useAuth();
  const runtime = useVaultRuntime();
  const moneySession = useVaultMoneySession();
  const cache = useQueryClient();
  const paranoidStore = useMemo(
    () => (moneySession == null ? null : createParanoidAppPortfolioStore(moneySession)),
    [moneySession],
  );

  // Evict every plaintext money query the moment no decrypted session backs
  // it. A normal account entering the enable flow begins locked, so it keeps
  // its server cache until the transition actually creates a vault session.
  const sawDecryptedSession = useRef(false);
  useLayoutEffect(() => {
    if (runtime.phase === 'unlocked') {
      sawDecryptedSession.current = true;
      return;
    }
    if (runtime.phase !== 'locked') return;
    if (privacy.privacyMode !== 'paranoid' && !sawDecryptedSession.current) return;
    sawDecryptedSession.current = false;
    removePlaintextQueries(cache);
  }, [cache, privacy.privacyMode, runtime.phase]);
  useLayoutEffect(
    () => () => {
      if (sawDecryptedSession.current) removePlaintextQueries(cache);
    },
    [cache],
  );

  useLayoutEffect(() => {
    if (
      status === 'authenticated' &&
      privacy.privacyMode === 'normal' &&
      runtime.phase === 'unlocked'
    ) {
      // A disable completed in another tab/device. Revoke the decrypted
      // session before allowing the API-backed subtree to continue.
      void runtime.lock({ broadcast: false });
    }
    // Deliberately ignore `unlocking`: during enable the mode update and first
    // unlock overlap briefly. Cancelling that in-flight operation would force
    // the user to unlock again with the passphrase they just created.
  }, [privacy.privacyMode, runtime, status]);

  if (status !== 'authenticated') {
    return (
      <ResolvedPrivacyModeProvider mode="normal">
        <PortfolioStoreProvider store={apiPortfolioStore}>{children}</PortfolioStoreProvider>
      </ResolvedPrivacyModeProvider>
    );
  }
  if (privacy.isPending) return <Splash />;
  if (privacy.isError || privacy.privacyMode == null) {
    return (
      <AuthCard subtitle={t('vault.gate.unavailableTitle')}>
        <div className="flex flex-col gap-4">
          <p className="bt-soft text-sm">{t('vault.gate.unavailableBody')}</p>
          <Button onClick={() => void privacy.refetch()}>{t('common.retry')}</Button>
        </div>
      </AuthCard>
    );
  }
  if (privacy.privacyMode === 'normal') {
    if (runtime.phase !== 'locked') return <Splash />;
    return (
      <ResolvedPrivacyModeProvider accountId={user?.id ?? null} mode="normal">
        <PortfolioStoreProvider store={apiPortfolioStore}>{children}</PortfolioStoreProvider>
      </ResolvedPrivacyModeProvider>
    );
  }
  if (privacy.mediaState == null) {
    return (
      <AuthCard subtitle={t('vault.gate.unavailableTitle')}>
        <p className="bt-soft text-sm">{t('vault.gate.invalidMedia')}</p>
      </AuthCard>
    );
  }
  if (runtime.phase !== 'unlocked' || paranoidStore == null) {
    // Account deletion reads no money data and remains reachable while locked.
    if (location.pathname === '/account/delete') return <DeleteAccountPage />;
    return (
      <VaultUnlockGate
        mediaSet={privacy.mediaState.mediaSet}
        onStartFresh={
          user?.id == null
            ? undefined
            : async (credential) => {
                await discardLockedVault(user.id, credential);
                await runtime.cleanupAfterDisable();
                privacy.acceptNormal();
                void privacy.refetch();
              }
        }
      />
    );
  }
  return (
    <ResolvedPrivacyModeProvider
      accountId={user?.id ?? null}
      mediaState={privacy.mediaState}
      mode="paranoid"
    >
      <PortfolioStoreProvider store={paranoidStore}>
        <ParanoidNavigationGate>{children}</ParanoidNavigationGate>
      </PortfolioStoreProvider>
    </ResolvedPrivacyModeProvider>
  );
}
