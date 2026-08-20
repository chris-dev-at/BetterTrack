import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { createPortal, flushSync } from 'react-dom';

import { QRCodeSVG } from 'qrcode.react';

import type { VaultKeyFingerprint } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { Button, Field, Input } from '../../../ui/origin';
import { useOverlayEscape } from '../../../ui/overlayStack';
import { useFocusTrap } from '../../../ui/useFocusTrap';
import {
  serializeVaultTransferPayload,
  VAULT_TRANSFER_NAME_MAX_CHARS,
  VAULT_TRANSFER_QR_EXPIRY_MS,
  VAULT_TRANSFER_QR_OPTIONS,
  VAULT_TRANSFER_STEP_UP_MAX_AGE_MS,
  type VaultTransferQrSource,
} from '../qr';

export type { VaultTransferQrSource } from '../qr';

export interface VaultTransferQrProps {
  vaultId: string;
  vaultName?: string;
  keyFingerprint?: VaultKeyFingerprint;
  source: VaultTransferQrSource;
  now?: () => number;
  onClosed?: () => void;
}

type TransferPhase = 'closed' | 'checking' | 'password' | 'visible' | 'expired' | 'blocked';

interface VisibleSecret {
  mnemonic: string;
  payload: string;
}

/**
 * E7 sender entry + secret-bearing full-screen renderer. Its source contract is
 * intentionally local-only: rendering performs no request, persistence, copy,
 * analytics or logging action. E8 supplies the per-vault manager adapter.
 */
export function VaultTransferQr({
  vaultId,
  vaultName,
  keyFingerprint,
  source,
  now = Date.now,
  onClosed,
}: VaultTransferQrProps) {
  const t = useT();
  const titleId = useId();
  const [phase, setPhase] = useState<TransferPhase>('closed');
  const [secret, setSecret] = useState<VisibleSecret | null>(null);
  const [devicePassword, setDevicePassword] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const freshPasswordAt = useRef<number | null>(null);
  const phaseRef = useRef<TransferPhase>(phase);
  phaseRef.current = phase;
  const open = phase !== 'closed';
  const { containerRef, onKeyDown } = useFocusTrap<HTMLDivElement>({
    active: open,
    inertBackground: true,
  });

  const close = useCallback(() => {
    requestGeneration.current += 1;
    setSecret(null);
    setDevicePassword('');
    setErrorKey(null);
    setManualOpen(false);
    setPhase('closed');
    onClosed?.();
  }, [onClosed]);

  useOverlayEscape(open, close, containerRef);

  useEffect(
    () =>
      source.subscribeToSessionEnd(() => {
        requestGeneration.current += 1;
        freshPasswordAt.current = null;
        flushSync(() => {
          setSecret(null);
          setDevicePassword('');
          setManualOpen(false);
          if (phaseRef.current !== 'closed') {
            setErrorKey('vault.transfer.sender.errors.unlockRequired');
            setPhase('blocked');
          }
        });
      }),
    [source],
  );

  useEffect(() => {
    if (phase !== 'visible') return;
    const timer = window.setTimeout(() => {
      requestGeneration.current += 1;
      setSecret(null);
      setDevicePassword('');
      setPhase('expired');
    }, VAULT_TRANSFER_QR_EXPIRY_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  function hasFreshPasswordStepUp(): boolean {
    const verifiedAt = freshPasswordAt.current;
    if (verifiedAt == null) return false;
    const age = now() - verifiedAt;
    return age >= 0 && age <= VAULT_TRANSFER_STEP_UP_MAX_AGE_MS;
  }

  function block(generation: number, nextErrorKey: string) {
    if (requestGeneration.current !== generation) return;
    setErrorKey(nextErrorKey);
    setPhase('blocked');
  }

  async function reveal(generation: number) {
    let mnemonic: string;
    try {
      await source.requireLiveUnlock();
      if (requestGeneration.current !== generation) return;
      mnemonic = await source.readMnemonic();
      if (requestGeneration.current !== generation) return;
      await source.requireLiveUnlock();
    } catch {
      block(generation, 'vault.transfer.sender.errors.unlockRequired');
      return;
    }
    if (requestGeneration.current !== generation) return;

    let payload: string;
    try {
      const name = transferNameHint(vaultName);
      payload = serializeVaultTransferPayload({
        mnemonic,
        vaultId,
        ...(name === undefined ? {} : { name }),
        ...(keyFingerprint === undefined ? {} : { fingerprint: keyFingerprint }),
      });
    } catch {
      block(generation, 'vault.transfer.sender.errors.payload');
      return;
    }
    if (requestGeneration.current !== generation) return;
    setDevicePassword('');
    setSecret({ mnemonic, payload });
    setErrorKey(null);
    setPhase('visible');
  }

  async function requestShow(showWords: boolean) {
    const generation = ++requestGeneration.current;
    setSecret(null);
    setErrorKey(null);
    setManualOpen(showWords);
    setPhase('checking');
    try {
      await source.requireLiveUnlock();
    } catch {
      block(generation, 'vault.transfer.sender.errors.unlockRequired');
      return;
    }
    if (requestGeneration.current !== generation) return;
    if (source.custody === 'wrapped' && !hasFreshPasswordStepUp()) {
      setPhase('password');
      return;
    }
    await reveal(generation);
  }

  async function submitPassword(event: FormEvent) {
    event.preventDefault();
    if (source.custody !== 'wrapped' || devicePassword.length === 0) return;
    const generation = ++requestGeneration.current;
    setErrorKey(null);
    setPhase('checking');
    try {
      await source.verifyDevicePassword(devicePassword);
    } catch {
      if (requestGeneration.current !== generation) return;
      freshPasswordAt.current = null;
      setDevicePassword('');
      setErrorKey('vault.transfer.sender.errors.password');
      setPhase('password');
      return;
    }
    if (requestGeneration.current !== generation) return;
    freshPasswordAt.current = now();
    await reveal(generation);
  }

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void requestShow(false)} size="sm" type="button">
          {t('vault.transfer.sender.showQr')}
        </Button>
        <Button onClick={() => void requestShow(true)} size="sm" type="button" variant="quiet">
          {t('vault.transfer.manualWords')}
        </Button>
      </div>

      {open
        ? createPortal(
            <div
              aria-labelledby={titleId}
              aria-modal="true"
              className="bt-app fixed inset-0 z-[90] flex min-h-0 flex-col overflow-y-auto bg-neutral-950 px-4 py-5 sm:px-8"
              data-vault-transfer-screen="sender"
              onKeyDown={onKeyDown}
              ref={containerRef}
              role="dialog"
              tabIndex={-1}
            >
              <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4">
                <h2 className="bt-page-title" id={titleId}>
                  {t('vault.transfer.sender.title')}
                </h2>
                <Button
                  aria-label={t('common.close')}
                  icon="x"
                  iconOnly
                  onClick={close}
                  variant="quiet"
                />
              </div>

              <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center gap-5 py-8">
                {errorKey ? (
                  <p
                    className="bt-neg w-full rounded-lg border border-red-800 bg-red-950/40 p-3"
                    role="alert"
                  >
                    {t(errorKey)}
                  </p>
                ) : null}

                {phase === 'checking' ? (
                  <p aria-live="polite" className="bt-muted">
                    {t('vault.transfer.sender.checking')}
                  </p>
                ) : null}

                {phase === 'password' ? (
                  <form className="flex w-full max-w-md flex-col gap-4" onSubmit={submitPassword}>
                    <p className="bt-soft text-sm">{t('vault.transfer.sender.passwordHint')}</p>
                    <Field
                      htmlFor="vault-transfer-device-password"
                      label={t('vault.transfer.sender.devicePassword')}
                    >
                      <Input
                        autoComplete="current-password"
                        autoFocus
                        id="vault-transfer-device-password"
                        onChange={(event) => setDevicePassword(event.target.value)}
                        required
                        type="password"
                        value={devicePassword}
                      />
                    </Field>
                    <Button disabled={devicePassword.length === 0} type="submit" variant="primary">
                      {manualOpen
                        ? t('vault.transfer.sender.verifyAndShowWords')
                        : t('vault.transfer.sender.verifyAndShowQr')}
                    </Button>
                  </form>
                ) : null}

                {phase === 'visible' && secret != null ? (
                  <>
                    <p className="w-full rounded-lg border border-amber-600 bg-amber-950/50 p-4 text-sm font-semibold text-amber-100">
                      {t('vault.transfer.sender.banner')}
                    </p>
                    <div className="rounded-xl bg-white p-2 shadow-2xl">
                      <QRCodeSVG
                        aria-label={t('vault.transfer.sender.qrAria')}
                        boostLevel={VAULT_TRANSFER_QR_OPTIONS.boostErrorCorrectionLevel}
                        level={VAULT_TRANSFER_QR_OPTIONS.errorCorrectionLevel}
                        marginSize={4}
                        size={280}
                        value={secret.payload}
                      />
                    </div>
                    <p aria-live="polite" className="bt-muted text-sm">
                      {t('vault.transfer.sender.expires')}
                    </p>
                    <details
                      className="w-full rounded-lg border border-neutral-800 p-4"
                      onToggle={(event) => setManualOpen(event.currentTarget.open)}
                      open={manualOpen}
                    >
                      <summary className="cursor-pointer font-medium">
                        {t('vault.transfer.manualWords')}
                      </summary>
                      <ol className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
                        {secret.mnemonic.split(' ').map((word, index) => (
                          <li className="bt-num text-sm" key={`${index}-${word}`}>
                            <span className="bt-muted mr-2">{index + 1}.</span>
                            {word}
                          </li>
                        ))}
                      </ol>
                    </details>
                  </>
                ) : null}

                {phase === 'expired' ? (
                  <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
                    <p aria-live="assertive" className="bt-soft">
                      {t('vault.transfer.sender.expired')}
                    </p>
                    <div className="flex flex-wrap justify-center gap-2">
                      <Button onClick={() => void requestShow(false)} variant="primary">
                        {t('vault.transfer.sender.showAgain')}
                      </Button>
                      <Button onClick={() => void requestShow(true)} variant="quiet">
                        {t('vault.transfer.manualWords')}
                      </Button>
                    </div>
                  </div>
                ) : null}

                {phase === 'blocked' ? (
                  <div className="flex w-full max-w-md flex-wrap justify-center gap-2">
                    <Button onClick={() => void requestShow(false)} variant="primary">
                      {t('vault.transfer.sender.showAgain')}
                    </Button>
                    <Button onClick={() => void requestShow(true)} variant="quiet">
                      {t('vault.transfer.manualWords')}
                    </Button>
                  </div>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/** The display name is only a wire hint; a legal longer vault name must never block transfer. */
function transferNameHint(vaultName: string | undefined): string | undefined {
  if (vaultName === undefined) return undefined;
  return [...vaultName].length <= VAULT_TRANSFER_NAME_MAX_CHARS ? vaultName : undefined;
}
