import { useEffect, useRef, useState, type FormEvent } from 'react';

import type { VaultMediaSet } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { Alert, AuthCard, Button, CHECKBOX_STYLE, TextField } from '../../components/ui';
import { VaultCryptoError } from '../errors';
import { useVaultRuntime } from '../VaultRuntimeProvider';

export function VaultUnlockGate({
  mediaSet,
  onRestore,
}: {
  mediaSet: VaultMediaSet;
  onRestore?: () => void;
}) {
  const t = useT();
  const runtime = useVaultRuntime();
  const [passphrase, setPassphrase] = useState('');
  const [keepUnlocked, setKeepUnlocked] = useState(false);
  const [recoveryKit, setRecoveryKit] = useState<Uint8Array | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const trustedAttempted = useRef(false);
  const driveSelected = mediaSet.includes('drive');
  const busy = runtime.phase === 'unlocking';

  useEffect(() => {
    if (trustedAttempted.current || runtime.phase !== 'locked') return;
    trustedAttempted.current = true;
    void runtime.unlockFromDevice({ authorizeDrive: false, driveOnly: false });
  }, [runtime]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setErrorKey(null);
    try {
      const options = {
        authorizeDrive: driveSelected,
        driveOnly: mediaSet.length === 1 && driveSelected,
        keepUnlocked,
      };
      if (recoveryKit != null) {
        await runtime.unlockWithRecoveryKit(recoveryKit, options);
      } else {
        await runtime.unlockWithPassphrase(passphrase, options);
      }
    } catch (cause) {
      setErrorKey(unlockErrorKey(cause));
    }
  }

  return (
    <AuthCard subtitle={t('vault.unlock.title')}>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <p className="bt-soft text-sm">{t('vault.unlock.description')}</p>

        <TextField
          autoComplete="current-password"
          disabled={busy || recoveryKit != null}
          label={t('vault.unlock.passphrase')}
          onChange={(event) => setPassphrase(event.target.value)}
          required={recoveryKit == null}
          type="password"
          value={passphrase}
        />

        <label className="bt-soft flex items-start gap-2 text-sm">
          <input
            checked={keepUnlocked}
            disabled={busy}
            onChange={(event) => setKeepUnlocked(event.target.checked)}
            style={CHECKBOX_STYLE}
            type="checkbox"
          />
          <span>
            {t('vault.unlock.keepUnlocked')}
            <span className="bt-muted mt-1 block text-xs">
              {t('vault.unlock.keepUnlockedHint')}
            </span>
          </span>
        </label>

        <div className="bt-panel flex flex-col gap-2 p-3">
          <label className="bt-row-title" htmlFor="vault-recovery-kit">
            {t('vault.unlock.recoveryKit')}
          </label>
          <input
            accept=".txt,text/plain"
            disabled={busy}
            id="vault-recovery-kit"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file == null) {
                setRecoveryKit(null);
                return;
              }
              void file.arrayBuffer().then((buffer) => setRecoveryKit(new Uint8Array(buffer)));
            }}
            type="file"
          />
          <p className="bt-row-sub">{t('vault.unlock.recoveryKitHint')}</p>
        </div>

        {driveSelected ? (
          <p className="bt-muted text-xs">{t('vault.unlock.driveGesture')}</p>
        ) : null}
        {errorKey ? <Alert tone="error">{t(errorKey)}</Alert> : null}

        <Button disabled={busy || (recoveryKit == null && passphrase.length === 0)} type="submit">
          {busy ? t('vault.unlock.unlocking') : t('vault.unlock.action')}
        </Button>
        {onRestore ? (
          <button className="bt-link text-sm" onClick={onRestore} type="button">
            {t('vault.unlock.restore')}
          </button>
        ) : null}
      </form>
    </AuthCard>
  );
}

function unlockErrorKey(cause: unknown): string {
  if (!(cause instanceof VaultCryptoError)) return 'vault.unlock.errors.unavailable';
  switch (cause.code) {
    case 'authentication-failed':
      return 'vault.unlock.errors.wrongPassphrase';
    case 'recovery-kit-invalid':
      return 'vault.unlock.errors.recoveryKit';
    case 'update-required':
      return 'vault.unlock.errors.updateRequired';
    case 'document-invalid':
    case 'envelope-invalid':
      return 'vault.unlock.errors.corrupt';
    case 'custody-failed':
      return 'vault.unlock.errors.custody';
    case 'storage-failed':
    case 'locked':
    case 'kdf-failed':
    case 'unsupported-crypto':
      return 'vault.unlock.errors.unavailable';
  }
}
