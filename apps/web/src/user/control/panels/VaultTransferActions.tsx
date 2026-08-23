import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';

import type { VaultConfig } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { Button, Field, Input } from '../../../ui/origin';
import { vaultTransferRuntime, type VaultTransferRuntime } from '../../vault/qr/runtime';
import { createVaultTransferQrSource } from '../../vault/qr/senderSource';
import { VaultReceivePhrase } from '../../vault/ui/VaultReceivePhrase';
import { EndpointKeystoreResetFold, VaultTransferQr } from '../../vault/ui/VaultTransferQr';
import type { Notice } from './PrivacyPanel';
import { PanelFold, PanelList, PanelListItem, PanelNote } from './panelKit';

export function VaultTransferActions({
  accountId = null,
  onNotice,
  runtime = vaultTransferRuntime,
}: {
  accountId?: string | null;
  onNotice(notice: Notice): void;
  runtime?: VaultTransferRuntime;
}) {
  const t = useT();
  const [vaults, setVaults] = useState<readonly VaultConfig[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [expanded, setExpanded] = useState(false);
  const [receiverOpen, setReceiverOpen] = useState(false);

  useLayoutEffect(() => {
    runtime.setAccountId(accountId);
  }, [accountId, runtime]);

  useEffect(() => {
    if (!expanded) return;
    let current = true;
    setLoadState('loading');
    void runtime.listVaults().then(
      (next) => {
        if (!current) return;
        setVaults(next);
        setLoadState('ready');
      },
      () => {
        if (!current) return;
        setVaults([]);
        setLoadState('error');
      },
    );
    return () => {
      current = false;
    };
  }, [expanded, runtime]);

  return (
    <PanelFold
      onToggle={(open) => {
        setExpanded(open);
        if (!open) setReceiverOpen(false);
      }}
      summary={t('vault.transfer.settings.title')}
    >
      {expanded ? (
        <div className="flex flex-col gap-4">
          <PanelNote>{t('vault.transfer.settings.hint')}</PanelNote>

          {receiverOpen ? (
            <VaultReceivePhrase
              fetchHeaderEnvelope={runtime.fetchHeaderEnvelope}
              keystore={runtime.keystore}
              onCancel={() => setReceiverOpen(false)}
              onOpened={(receipt) => {
                // `store*AfterVerifiedOpen` has installed K_c in this keystore;
                // retain the authenticated receipt in the owning app runtime so
                // the receive action itself establishes the live per-vault session.
                runtime.registerOpenedVault(receipt.opened);
                setReceiverOpen(false);
                onNotice({ tone: 'success', key: 'vault.transfer.settings.received' });
              }}
            />
          ) : (
            <>
              <div>
                <Button
                  onClick={() => {
                    onNotice(null);
                    setReceiverOpen(true);
                  }}
                  size="sm"
                  type="button"
                >
                  {t('vault.transfer.settings.receive')}
                </Button>
              </div>

              {loadState === 'loading' ? (
                <PanelNote>{t('vault.transfer.settings.loading')}</PanelNote>
              ) : null}
              {loadState === 'error' ? (
                <PanelNote warn>{t('vault.transfer.settings.unavailable')}</PanelNote>
              ) : null}
              {loadState === 'ready' && vaults.length === 0 ? (
                <PanelNote>{t('vault.transfer.settings.empty')}</PanelNote>
              ) : null}

              {vaults.length > 0 ? (
                <PanelList>
                  {vaults.map((vault) => (
                    <VaultTransferRow key={vault.id} runtime={runtime} vault={vault} />
                  ))}
                </PanelList>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </PanelFold>
  );
}

function VaultTransferRow({
  runtime,
  vault,
}: {
  runtime: VaultTransferRuntime;
  vault: VaultConfig;
}) {
  const t = useT();
  const passwordId = useId();
  const attempt = useRef(0);
  const ownsSessionChange = useRef(false);
  const [phase, setPhase] = useState<
    'checking' | 'password' | 'ready' | 'missing' | 'error' | 'ended'
  >('checking');
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState(false);
  const source = useMemo(
    () => createVaultTransferQrSource({ keystore: runtime.keystore, vaultId: vault.id }),
    [runtime.keystore, vault.id],
  );
  const openSession = useCallback(
    async (devicePassword?: string) => {
      const currentAttempt = ++attempt.current;
      setPhase('checking');
      setPasswordError(false);
      try {
        // The receiver or another vault surface may already have installed K_c.
        // Re-register that authenticated receipt with the owning app runtime.
        try {
          const opened = await runtime.keystore.withContentKey(vault.id, (_key, keyId) => ({
            vaultId: vault.id,
            keyId,
            keyFingerprint: vault.keyFingerprint,
          }));
          if (attempt.current !== currentAttempt) return;
          if (!runtime.isVaultOpen(vault.id)) runtime.registerOpenedVault(opened);
          setPhase('ready');
          return;
        } catch {
          // A closed session falls through to its binding §12 affordance.
        }

        const state = await runtime.keystore.stateFor(vault.id);
        if (attempt.current !== currentAttempt) return;
        if (state.status === 'not-on-this-endpoint') {
          setPhase('missing');
          return;
        }
        if (state.status === 'endpoint-keystore-invalid') {
          setPhase('error');
          return;
        }
        if (state.status === 'stored+wrapped' && state.session === 'locked') {
          if (devicePassword === undefined) {
            setPhase('password');
            return;
          }
          ownsSessionChange.current = true;
          try {
            await runtime.keystore.unlock(devicePassword);
          } finally {
            ownsSessionChange.current = false;
          }
          if (attempt.current !== currentAttempt) return;
        }

        // Plain custody opens silently; wrapped custody reaches this point only
        // after its endpoint password session is live. Header verification still
        // happens before K_c becomes available to the sender.
        const opened = await runtime.keystore.openStoredVault(
          vault.id,
          runtime.fetchHeaderEnvelope,
          vault.keyFingerprint,
        );
        if (attempt.current !== currentAttempt) return;
        if (!runtime.isVaultOpen(vault.id)) runtime.registerOpenedVault(opened);
        setPassword('');
        setPhase('ready');
      } catch {
        if (attempt.current !== currentAttempt) return;
        if (devicePassword !== undefined) {
          setPassword('');
          setPasswordError(true);
          setPhase('password');
        } else {
          setPhase('error');
        }
      }
    },
    [runtime, vault.id, vault.keyFingerprint],
  );

  /**
   * §12's keystore reset. This row owns the session change so its own
   * revocation listener does not paint "session ended" over the outcome; the
   * re-read then lands on the honest not-on-this-endpoint affordance.
   */
  const resetKeystore = useCallback(async () => {
    ownsSessionChange.current = true;
    try {
      await runtime.keystore.reset();
    } finally {
      ownsSessionChange.current = false;
    }
    await openSession();
  }, [openSession, runtime.keystore]);

  useEffect(() => {
    void openSession();
    const unsubscribe = runtime.keystore.subscribeToSessionEnd(() => {
      if (ownsSessionChange.current) return;
      attempt.current += 1;
      setPassword('');
      setPasswordError(false);
      // A real app lock must stay a revocation boundary. In particular, plain
      // custody can open without a password, so never auto-open from this
      // callback; require a fresh user gesture instead.
      setPhase('ended');
    });
    return () => {
      attempt.current += 1;
      unsubscribe();
    };
  }, [openSession, runtime.keystore]);

  function submitPassword(event: FormEvent) {
    event.preventDefault();
    if (password.length === 0) return;
    void openSession(password);
  }

  return (
    <PanelListItem
      main={
        <>
          <span className="bt-row-title">{vault.name}</span>
          <span className="bt-meta bt-num break-all">{vault.id}</span>
        </>
      }
    >
      <div className="mt-3">
        {phase === 'checking' ? (
          <PanelNote>{t('vault.transfer.settings.opening')}</PanelNote>
        ) : null}
        {phase === 'missing' ? (
          <PanelNote>{t('vault.transfer.settings.notOnEndpoint')}</PanelNote>
        ) : null}
        {phase === 'error' ? (
          <PanelNote warn>{t('vault.transfer.settings.openError')}</PanelNote>
        ) : null}
        {phase === 'ended' ? (
          <div className="flex flex-col items-start gap-3">
            <PanelNote>{t('vault.transfer.settings.sessionEnded')}</PanelNote>
            <Button onClick={() => void openSession()} size="sm" type="button">
              {t('vault.transfer.settings.reopen')}
            </Button>
          </div>
        ) : null}
        {phase === 'password' ? (
          <form className="flex max-w-sm flex-col gap-3" onSubmit={submitPassword}>
            <Field
              htmlFor={passwordId}
              hint={t('vault.transfer.settings.unlockHint')}
              label={t('vault.transfer.sender.devicePassword')}
            >
              <Input
                autoComplete="current-password"
                id={passwordId}
                onChange={(event) => setPassword(event.target.value)}
                required
                type="password"
                value={password}
              />
            </Field>
            {passwordError ? (
              <PanelNote warn>{t('vault.transfer.settings.unlockError')}</PanelNote>
            ) : null}
            <Button disabled={password.length === 0} size="sm" type="submit">
              {t('vault.transfer.settings.unlock')}
            </Button>
            {/* Binding §12: every device-password prompt offers the reset. */}
            <EndpointKeystoreResetFold onReset={resetKeystore} />
          </form>
        ) : null}
        {phase === 'ready' ? (
          <VaultTransferQr
            keyFingerprint={vault.keyFingerprint}
            source={source}
            vaultId={vault.id}
            vaultName={vault.name}
          />
        ) : null}
      </div>
    </PanelListItem>
  );
}
