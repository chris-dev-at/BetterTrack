import { useEffect, useMemo, useState } from 'react';

import type { VaultConfig } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { Button } from '../../../ui/origin';
import { vaultTransferRuntime, type VaultTransferRuntime } from '../../vault/qr/runtime';
import { createVaultTransferQrSource } from '../../vault/qr/senderSource';
import { VaultReceivePhrase } from '../../vault/ui/VaultReceivePhrase';
import { VaultTransferQr } from '../../vault/ui/VaultTransferQr';
import type { Notice } from './PrivacyPanel';
import { PanelFold, PanelList, PanelListItem, PanelNote } from './panelKit';

export function VaultTransferActions({
  onNotice,
  runtime = vaultTransferRuntime,
}: {
  onNotice(notice: Notice): void;
  runtime?: VaultTransferRuntime;
}) {
  const t = useT();
  const [vaults, setVaults] = useState<readonly VaultConfig[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [receiverOpen, setReceiverOpen] = useState(false);

  useEffect(() => {
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
  }, [runtime]);

  return (
    <PanelFold summary={t('vault.transfer.settings.title')}>
      <div className="flex flex-col gap-4">
        <PanelNote>{t('vault.transfer.settings.hint')}</PanelNote>

        {receiverOpen ? (
          <VaultReceivePhrase
            fetchHeaderEnvelope={runtime.fetchHeaderEnvelope}
            keystore={runtime.keystore}
            onCancel={() => setReceiverOpen(false)}
            onOpened={() => {
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
  const source = useMemo(
    () => createVaultTransferQrSource({ keystore: runtime.keystore, vaultId: vault.id }),
    [runtime.keystore, vault.id],
  );

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
        <VaultTransferQr
          keyFingerprint={vault.keyFingerprint}
          source={source}
          vaultId={vault.id}
          vaultName={vault.name}
        />
      </div>
    </PanelListItem>
  );
}
