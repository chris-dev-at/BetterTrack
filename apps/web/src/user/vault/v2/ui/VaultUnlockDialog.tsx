import type { VaultHeaderDoc } from '@bettertrack/contracts';
import { useState } from 'react';

import { useT } from '../../../../i18n';
import { Button, Field, Input, ODialog } from '../../../../ui/origin';
import { CHECKBOX_STYLE } from '../../../components/ui';
import { RAW_STORAGE_ACKNOWLEDGEMENT, type VaultPassphraseVaultStore } from '../devicePassphrase';
import type { VaultKeyring } from '../keyring';
import { checkVaultPassphrase, VAULT2_PASSPHRASE_WORD_COUNT } from '../words';

/**
 * Unlock a vault (`docs/VAULTS_V2_DESIGN.md` §4). Two routes in:
 *
 *  - the passphrase stored on THIS device — password-wrapped by default, so the
 *    user types their device password; or
 *  - the 12 words, typed or pasted.
 *
 * Remembering the vault afterwards is offered in both storage modes, and the
 * raw mode is gated behind a separate, explicitly worded checkbox plus the
 * module-level acknowledgement constant.
 */

export interface VaultUnlockDialogProps {
  open: boolean;
  onClose: () => void;
  header: VaultHeaderDoc;
  vaultName: string;
  keyring: VaultKeyring;
  passphraseStore: VaultPassphraseVaultStore;
  rememberedOnDevice: boolean;
  onUnlocked: () => void;
}

type Mode = 'device' | 'words';

export function VaultUnlockDialog({
  open,
  onClose,
  header,
  vaultName,
  keyring,
  passphraseStore,
  rememberedOnDevice,
  onUnlocked,
}: VaultUnlockDialogProps) {
  const t = useT();
  const [mode, setMode] = useState<Mode>(rememberedOnDevice ? 'device' : 'words');
  const [devicePassword, setDevicePassword] = useState('');
  const [phrase, setPhrase] = useState('');
  const [remember, setRemember] = useState(false);
  const [rememberRaw, setRememberRaw] = useState(false);
  const [newDevicePassword, setNewDevicePassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checked = checkVaultPassphrase(phrase);
  const canSubmit =
    mode === 'device' ? devicePassword.length > 0 : checked.valid && !rememberRequiresPassword();

  function rememberRequiresPassword(): boolean {
    return remember && !rememberRaw && newDevicePassword.length === 0;
  }

  function close() {
    setDevicePassword('');
    setPhrase('');
    setError(null);
    setBusy(false);
    onClose();
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const passphrase =
        mode === 'device'
          ? await passphraseStore.open({ vaultId: header.vaultId, devicePassword })
          : phrase;

      await keyring.unlock(header, passphrase);

      if (mode === 'words' && remember) {
        if (rememberRaw) {
          await passphraseStore.putRaw({
            vaultId: header.vaultId,
            passphrase,
            acknowledgement: RAW_STORAGE_ACKNOWLEDGEMENT,
          });
        } else {
          await passphraseStore.putWrapped({
            vaultId: header.vaultId,
            passphrase,
            devicePassword: newDevicePassword,
          });
        }
      }
      onUnlocked();
      close();
    } catch {
      // One message for every failure: a wrong phrase, a wrong device password
      // and a tampered header must not be distinguishable.
      setError(t('vault.v2.unlock.errors.failed'));
    } finally {
      setBusy(false);
    }
  }

  const phraseError =
    phrase.length === 0 || checked.valid
      ? undefined
      : checked.problem.kind === 'word-count'
        ? t('vault.v2.unlock.errors.wordCount', {
            expected: VAULT2_PASSPHRASE_WORD_COUNT,
            count: checked.problem.count,
          })
        : checked.problem.kind === 'unknown-words'
          ? t('vault.v2.unlock.errors.unknownWords', { words: checked.problem.words.join(', ') })
          : t('vault.v2.unlock.errors.checksum');

  return (
    <ODialog
      foot={
        <div className="flex w-full items-center justify-between gap-3">
          <Button onClick={close} variant="quiet">
            {t('common.cancel')}
          </Button>
          <Button
            disabled={!canSubmit || busy}
            loading={busy}
            onClick={() => void submit()}
            variant="primary"
          >
            {t('vault.v2.unlock.actions.unlock')}
          </Button>
        </div>
      }
      onClose={close}
      open={open}
      title={t('vault.v2.unlock.title', { name: vaultName })}
    >
      <div className="flex flex-col gap-4">
        {rememberedOnDevice ? (
          <div className="flex gap-2">
            <Button
              aria-pressed={mode === 'device'}
              onClick={() => setMode('device')}
              size="sm"
              variant={mode === 'device' ? 'primary' : 'quiet'}
            >
              {t('vault.v2.unlock.modes.device')}
            </Button>
            <Button
              aria-pressed={mode === 'words'}
              onClick={() => setMode('words')}
              size="sm"
              variant={mode === 'words' ? 'primary' : 'quiet'}
            >
              {t('vault.v2.unlock.modes.words')}
            </Button>
          </div>
        ) : null}

        {mode === 'device' ? (
          <Field
            hint={t('vault.v2.unlock.devicePasswordHint')}
            htmlFor="vault-device-password"
            label={t('vault.v2.unlock.devicePassword')}
          >
            <Input
              autoComplete="current-password"
              id="vault-device-password"
              onChange={(event) => setDevicePassword(event.target.value)}
              type="password"
              value={devicePassword}
            />
          </Field>
        ) : (
          <>
            <Field
              error={phraseError}
              hint={t('vault.v2.unlock.phraseHint')}
              htmlFor="vault-phrase"
              label={t('vault.v2.unlock.phrase')}
            >
              <Input
                autoCapitalize="none"
                autoComplete="off"
                id="vault-phrase"
                onChange={(event) => setPhrase(event.target.value)}
                spellCheck={false}
                value={phrase}
              />
            </Field>

            <label className="bt-settings-row items-start gap-3">
              <input
                checked={remember}
                onChange={(event) => setRemember(event.target.checked)}
                style={CHECKBOX_STYLE}
                type="checkbox"
              />
              <span className="bt-row-sub">{t('vault.v2.unlock.remember')}</span>
            </label>

            {remember ? (
              <div className="bt-panel bt-panel--soft flex flex-col gap-3">
                {rememberRaw ? null : (
                  <Field
                    hint={t('vault.v2.unlock.newDevicePasswordHint')}
                    htmlFor="vault-new-device-password"
                    label={t('vault.v2.unlock.newDevicePassword')}
                  >
                    <Input
                      autoComplete="new-password"
                      id="vault-new-device-password"
                      onChange={(event) => setNewDevicePassword(event.target.value)}
                      type="password"
                      value={newDevicePassword}
                    />
                  </Field>
                )}
                <label className="bt-settings-row items-start gap-3">
                  <input
                    checked={rememberRaw}
                    onChange={(event) => setRememberRaw(event.target.checked)}
                    style={CHECKBOX_STYLE}
                    type="checkbox"
                  />
                  <span>
                    <span className="bt-row-title">{t('vault.v2.unlock.rawTitle')}</span>
                    <span className="bt-field__error block">{t('vault.v2.unlock.rawWarning')}</span>
                  </span>
                </label>
              </div>
            ) : null}
          </>
        )}

        {error ? (
          <p className="bt-field__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </ODialog>
  );
}
