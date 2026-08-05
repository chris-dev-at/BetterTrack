import { useEffect, useRef, useState } from 'react';

import { useI18n, useT } from '../../../i18n';
import { Button } from '../../../ui/origin';
import { Alert } from '../../components/ui';
import { vaultMoneyErrorKey } from '../../vault/engine/errorCopy';
import type { VaultMoneyFailure } from '../../vault/engine/errors';
import { useVaultMoneySession } from '../../vault/engine/VaultMoneyEngineProvider';
import { createClientCleartextExport } from '../../vault/export/cleartext';
import { deliverClientDownload } from '../../vault/export/deliver';
import { PanelNote, Row } from './panelKit';

/**
 * Client-side cleartext export for paranoid accounts (PD7, paranoid design
 * §12): a JSON + CSV zip built entirely in browser memory from the unlocked
 * vault — the server never sees cleartext portfolio data, and nothing is
 * persisted beyond the transient download. Locked vaults cannot export.
 */
export function ParanoidAccountExport() {
  const t = useT();
  const { locale } = useI18n();
  const session = useVaultMoneySession();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<VaultMoneyFailure | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Locking drops `session` while this row stays mounted, and leaving the panel
  // unmounts it — both must abort an in-flight generation before any bytes are
  // handed over, so the cleanup is keyed on the session identity.
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [session],
  );

  const exportLocale = locale === 'de' ? 'de' : 'en';

  async function onExport() {
    if (session === null || busy) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setFailure(null);
    try {
      const result = await createClientCleartextExport(session.sync, {
        locale: exportLocale,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!result.ok) {
        setFailure(result.error);
        return;
      }
      deliverClientDownload(result.value.bytes, result.value.mediaType, result.value.filename);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setBusy(false);
    }
  }

  return (
    <Row
      hint={t('settings.export.cleartext.description')}
      label={t('settings.export.cleartext.title')}
      stack
    >
      {failure ? <Alert tone="error">{t(vaultMoneyErrorKey(failure))}</Alert> : null}

      {session === null ? (
        <PanelNote>{t('settings.export.cleartext.locked')}</PanelNote>
      ) : (
        <div>
          <Button disabled={busy} onClick={() => void onExport()} size="sm" type="button">
            {busy
              ? t('settings.export.cleartext.generating')
              : t('settings.export.cleartext.button')}
          </Button>
        </div>
      )}
    </Row>
  );
}
