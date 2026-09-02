import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { createPortal, flushSync } from 'react-dom';

import { QRCodeSVG } from 'qrcode.react';

import type { VaultKeyFingerprint } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { Button, Disclosure, Field, Input } from '../../../ui/origin';
import { useOverlayEscape } from '../../../ui/overlayStack';
import { useFocusTrap } from '../../../ui/useFocusTrap';
import {
  serializeVaultTransferPayloadWithinBudget,
  VAULT_TRANSFER_QR_EXPIRY_MS,
  VAULT_TRANSFER_QR_OPTIONS,
  VAULT_TRANSFER_STEP_UP_MAX_AGE_MS,
  VaultTransferSenderBlockedError,
  type VaultTransferQrCustody,
  type VaultTransferQrSource,
} from '../qr';
import { vaultRetryTimeLabel } from './retryTime';

export type { VaultTransferQrSource } from '../qr';

const LOCKED_OUT_ERROR_KEY = 'vault.transfer.sender.errors.lockedOut';

export interface VaultTransferQrProps {
  vaultId: string;
  vaultName?: string;
  keyFingerprint?: VaultKeyFingerprint;
  source: VaultTransferQrSource;
  now?: () => number;
  onClosed?: () => void;
}

type TransferPhase =
  | 'closed'
  | 'checking'
  | 'password'
  | 'visible'
  | 'expired'
  | 'blocked'
  | 'locked-out'
  | 'reset-done';

interface VisibleSecret {
  mnemonic: string;
  payload: string;
  source: VaultTransferQrSource;
  vaultId: string;
  vaultName: string | undefined;
  keyFingerprint: VaultKeyFingerprint | undefined;
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
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const requestGeneration = useRef(0);
  const freshPasswordAt = useRef<number | null>(null);
  const overlayOpen = useRef(false);
  const binding = useRef({ source, vaultId, vaultName, keyFingerprint });
  const currentSecret =
    secret?.source === source &&
    secret.vaultId === vaultId &&
    secret.vaultName === vaultName &&
    secret.keyFingerprint === keyFingerprint
      ? secret
      : null;
  const open = phase !== 'closed';
  const { containerRef, onKeyDown } = useFocusTrap<HTMLDivElement>({
    active: open,
    inertBackground: true,
  });

  const close = useCallback(() => {
    overlayOpen.current = false;
    requestGeneration.current += 1;
    setSecret(null);
    setDevicePassword('');
    setErrorKey(null);
    setRetryAt(null);
    setManualOpen(false);
    setPhase('closed');
    onClosed?.();
  }, [onClosed]);

  useOverlayEscape(open, close, containerRef);

  useLayoutEffect(() => {
    const previous = binding.current;
    const bindingChanged =
      previous.source !== source ||
      previous.vaultId !== vaultId ||
      previous.vaultName !== vaultName ||
      previous.keyFingerprint !== keyFingerprint;
    binding.current = { source, vaultId, vaultName, keyFingerprint };

    if (bindingChanged) {
      overlayOpen.current = false;
      freshPasswordAt.current = null;
      setSecret(null);
      setDevicePassword('');
      setErrorKey(null);
      setRetryAt(null);
      setManualOpen(false);
      setPhase('closed');
    }

    const unsubscribe = source.subscribeToSessionEnd(() => {
      const shouldBlock = overlayOpen.current;
      requestGeneration.current += 1;
      freshPasswordAt.current = null;
      flushSync(() => {
        setSecret(null);
        setDevicePassword('');
        setManualOpen(false);
        if (shouldBlock) {
          setErrorKey('vault.transfer.sender.errors.unlockRequired');
          setRetryAt(null);
          setPhase('blocked');
        }
      });
    });

    return () => {
      unsubscribe();
      overlayOpen.current = false;
      requestGeneration.current += 1;
      freshPasswordAt.current = null;
    };
  }, [keyFingerprint, source, vaultId, vaultName]);

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
    setRetryAt(null);
    setPhase('blocked');
  }

  /**
   * §12: never answer a device-password lockout with "unlock the vault first".
   * A locked-out endpoint keeps its live content-key session, so the honest
   * state names the lockout, carries its deadline and offers the keystore reset.
   */
  function blockFromCause(generation: number, cause: unknown, fallbackErrorKey: string) {
    if (requestGeneration.current !== generation) return;
    if (cause instanceof VaultTransferSenderBlockedError && cause.reason === 'locked-out') {
      freshPasswordAt.current = null;
      setSecret(null);
      setDevicePassword('');
      setErrorKey(LOCKED_OUT_ERROR_KEY);
      setRetryAt(cause.retryAt);
      setPhase('locked-out');
      return;
    }
    block(generation, fallbackErrorKey);
  }

  function requirePasswordStepUp(generation: number) {
    if (requestGeneration.current !== generation) return;
    freshPasswordAt.current = null;
    setSecret(null);
    setDevicePassword('');
    setErrorKey(null);
    setRetryAt(null);
    setPhase('password');
  }

  async function resetEndpointKeystore() {
    requestGeneration.current += 1;
    freshPasswordAt.current = null;
    await source.resetEndpointKeystore();
    setSecret(null);
    setDevicePassword('');
    setErrorKey(null);
    setRetryAt(null);
    setManualOpen(false);
    setPhase('reset-done');
  }

  async function reveal(generation: number) {
    let mnemonic: string;
    let finalCustody: VaultTransferQrCustody;
    try {
      const initialCustody = await source.requireLiveUnlock();
      if (requestGeneration.current !== generation) return;
      if (initialCustody === 'wrapped' && !hasFreshPasswordStepUp()) {
        requirePasswordStepUp(generation);
        return;
      }
      if (initialCustody === 'plain') freshPasswordAt.current = null;
      mnemonic = await source.readMnemonic();
      if (requestGeneration.current !== generation) return;
      finalCustody = await source.requireLiveUnlock();
    } catch (cause) {
      blockFromCause(generation, cause, 'vault.transfer.sender.errors.unlockRequired');
      return;
    }
    if (requestGeneration.current !== generation) return;

    let payload: string;
    try {
      payload = serializeVaultTransferPayloadWithinBudget({
        mnemonic,
        vaultId,
        ...(vaultName === undefined ? {} : { name: vaultName }),
        ...(keyFingerprint === undefined ? {} : { fingerprint: keyFingerprint }),
      });
    } catch {
      block(generation, 'vault.transfer.sender.errors.payload');
      return;
    }
    if (requestGeneration.current !== generation) return;
    if (finalCustody === 'wrapped' && !hasFreshPasswordStepUp()) {
      requirePasswordStepUp(generation);
      return;
    }
    if (finalCustody === 'plain') freshPasswordAt.current = null;
    setDevicePassword('');
    setSecret({ mnemonic, payload, source, vaultId, vaultName, keyFingerprint });
    setErrorKey(null);
    setRetryAt(null);
    setPhase('visible');
  }

  async function requestShow(showWords: boolean) {
    overlayOpen.current = true;
    const generation = ++requestGeneration.current;
    setSecret(null);
    setErrorKey(null);
    setRetryAt(null);
    setManualOpen(showWords);
    setPhase('checking');
    let custody: VaultTransferQrCustody;
    try {
      custody = await source.requireLiveUnlock();
    } catch (cause) {
      blockFromCause(generation, cause, 'vault.transfer.sender.errors.unlockRequired');
      return;
    }
    if (requestGeneration.current !== generation) return;
    if (custody === 'wrapped' && !hasFreshPasswordStepUp()) {
      requirePasswordStepUp(generation);
      return;
    }
    if (custody === 'plain') freshPasswordAt.current = null;
    await reveal(generation);
  }

  async function submitPassword(event: FormEvent) {
    event.preventDefault();
    if (devicePassword.length === 0) return;
    const generation = ++requestGeneration.current;
    setErrorKey(null);
    setRetryAt(null);
    setPhase('checking');
    let custody: VaultTransferQrCustody;
    try {
      custody = await source.requireLiveUnlock();
    } catch (cause) {
      blockFromCause(generation, cause, 'vault.transfer.sender.errors.unlockRequired');
      return;
    }
    if (requestGeneration.current !== generation) return;
    if (custody === 'plain') {
      freshPasswordAt.current = null;
      setDevicePassword('');
      await reveal(generation);
      return;
    }
    try {
      await source.verifyDevicePassword(devicePassword);
    } catch (cause) {
      if (requestGeneration.current !== generation) return;
      if (cause instanceof VaultTransferSenderBlockedError && cause.reason === 'locked-out') {
        blockFromCause(generation, cause, 'vault.transfer.sender.errors.password');
        return;
      }
      freshPasswordAt.current = null;
      setDevicePassword('');
      setErrorKey('vault.transfer.sender.errors.password');
      setPhase('password');
      return;
    }
    if (requestGeneration.current !== generation) return;
    setDevicePassword('');
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
              className="bt-app fixed inset-0 z-[90] flex min-h-0 flex-col overflow-y-auto px-4 py-5 sm:px-8"
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
                    {t(
                      errorKey,
                      retryAt == null ? undefined : { time: vaultRetryTimeLabel(retryAt) },
                    )}
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
                    {/* §12: the prompt ALWAYS offers "Forgot the password?". */}
                    <EndpointKeystoreResetFold onReset={resetEndpointKeystore} />
                  </form>
                ) : null}

                {phase === 'visible' && currentSecret != null ? (
                  <>
                    {/* Was `border-amber-600 bg-amber-950/50 text-amber-100` —
                        three hand-mixed colours from outside the palette, so
                        the most serious banner in the app was the one screen
                        that did not look like the app. Gold has tokens, and
                        they follow the theme. */}
                    <p
                      className="bt-panel bt-gold-note w-full p-4 text-sm font-semibold"
                      style={{
                        borderColor: 'var(--bt-border-accent)',
                        background: 'var(--bt-gold-soft)',
                      }}
                    >
                      {t('vault.transfer.sender.banner')}
                    </p>
                    <div className="rounded-xl bg-white p-2 shadow-2xl">
                      <QRCodeSVG
                        aria-label={t('vault.transfer.sender.qrAria')}
                        boostLevel={VAULT_TRANSFER_QR_OPTIONS.boostErrorCorrectionLevel}
                        level={VAULT_TRANSFER_QR_OPTIONS.errorCorrectionLevel}
                        marginSize={4}
                        size={280}
                        value={currentSecret.payload}
                      />
                    </div>
                    <p aria-live="polite" className="bt-muted text-sm">
                      {t('vault.transfer.sender.expires')}
                    </p>
                    <div className="w-full">
                      <Disclosure
                        onToggle={setManualOpen}
                        open={manualOpen}
                        summary={t('vault.transfer.manualWords')}
                      >
                        <dl className="text-sm">
                          <dt className="bt-muted">{t('vault.transfer.sender.vaultId')}</dt>
                          <dd className="bt-num mt-1 break-all">{currentSecret.vaultId}</dd>
                        </dl>
                        {/* The QR is SVG geometry; this list is the ONLY textual
                          copy of the phrase, so it exists in the DOM only while
                          the user has actually asked for the words. `Disclosure`
                          is a native `<details>`, and a CLOSED one still yields
                          its text to content scripts, innerText automation and
                          find-in-page — so the fold is not the guard here, this
                          conditional is. */}
                        {manualOpen ? (
                          <ol className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
                            {currentSecret.mnemonic.split(' ').map((word, index) => (
                              <li className="bt-num text-sm" key={`${index}-${word}`}>
                                <span className="bt-muted mr-2">{index + 1}.</span>
                                {word}
                              </li>
                            ))}
                          </ol>
                        ) : null}
                      </Disclosure>
                    </div>
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

                {/* Wait or reset — the two actions the endpoint state itself
                    names. Never "Show again", which would repeat the refusal. */}
                {phase === 'locked-out' ? (
                  <div className="flex w-full max-w-md flex-col items-center gap-4">
                    <Button onClick={() => void requestShow(manualOpen)} variant="primary">
                      {t('common.retry')}
                    </Button>
                    <EndpointKeystoreResetFold onReset={resetEndpointKeystore} />
                  </div>
                ) : null}

                {phase === 'reset-done' ? (
                  <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
                    <p aria-live="polite" className="bt-soft">
                      {t('vault.transfer.reset.done')}
                    </p>
                    <Button onClick={close} variant="primary">
                      {t('common.close')}
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

/**
 * §12's "Forgot the password?" → keystore reset, folded away until asked for.
 * It is the ONLY escape from a wrapped endpoint whose password is gone, so
 * every device-password prompt E7 renders carries it: the recorded v2
 * anti-pattern is a locked vault with no unlock path. The one-sentence
 * explanation is mandatory — a user must be able to tell this apart from
 * destroying the vault, which it emphatically is not.
 */
export function EndpointKeystoreResetFold({ onReset }: { onReset: () => Promise<void> }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState(false);

  async function run() {
    setWorking(true);
    setFailed(false);
    try {
      await onReset();
    } catch {
      setFailed(true);
      setWorking(false);
    }
  }

  if (!open) {
    return (
      <Button
        className="self-start"
        onClick={() => setOpen(true)}
        size="sm"
        type="button"
        variant="quiet"
      >
        {t('vault.transfer.reset.forgot')}
      </Button>
    );
  }

  return (
    <div className="bt-panel flex w-full flex-col gap-3 p-4 text-sm">
      <p className="bt-soft">{t('vault.transfer.reset.explain')}</p>
      {failed ? (
        <p className="bt-neg" role="alert">
          {t('vault.transfer.reset.error')}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={working}
          onClick={() => void run()}
          size="sm"
          type="button"
          variant="danger"
        >
          {working ? t('vault.transfer.reset.working') : t('vault.transfer.reset.action')}
        </Button>
        <Button
          disabled={working}
          onClick={() => setOpen(false)}
          size="sm"
          type="button"
          variant="quiet"
        >
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}
