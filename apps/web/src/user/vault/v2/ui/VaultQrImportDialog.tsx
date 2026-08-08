import { useEffect, useRef, useState } from 'react';

import { useT } from '../../../../i18n';
import { Button, Field, Input, ODialog } from '../../../../ui/origin';
import { CHECKBOX_STYLE } from '../../../components/ui';
import { RAW_STORAGE_ACKNOWLEDGEMENT, type VaultPassphraseVaultStore } from '../devicePassphrase';
import {
  isValidQrCode,
  parseVaultQrPayload,
  unwrapVaultQrPayload,
  VAULT2_QR_CODE_LENGTH,
  type VaultQrPayload,
} from '../qr';

/**
 * Receive a vault on THIS device (`docs/VAULTS_V2_DESIGN.md` §2/§5).
 *
 * Three input paths, in order of what a given browser can actually do:
 *  - camera scan via the native `BarcodeDetector`, when the browser has it and
 *    the page is in a secure context;
 *  - an image file (a photo of the other screen), decoded with the same API;
 *  - manual paste, which always works and is therefore never hidden.
 *
 * No decoding library is bundled and nothing is fetched: the CSP forbids
 * external assets, and a QR decoder is not worth a dependency when the fallback
 * is a paste field.
 *
 * The scanned passphrase is stored under this device's own password before the
 * dialog closes; it is never sent to the server.
 */

export interface VaultQrImportDialogProps {
  open: boolean;
  onClose: () => void;
  passphraseStore: VaultPassphraseVaultStore;
  onImported: (payload: VaultQrPayload) => void;
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource | Blob): Promise<{ rawValue: string }[]>;
}

type BarcodeDetectorCtor = new (options: { formats: string[] }) => BarcodeDetectorLike;

function barcodeDetector(): BarcodeDetectorLike | null {
  const ctor = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  if (ctor == null) return null;
  try {
    return new ctor({ formats: ['qr_code'] });
  } catch {
    return null;
  }
}

export function VaultQrImportDialog({
  open,
  onClose,
  passphraseStore,
  onImported,
}: VaultQrImportDialogProps) {
  const t = useT();
  const [pasted, setPasted] = useState('');
  const [payload, setPayload] = useState<VaultQrPayload | null>(null);
  const [pin, setPin] = useState('');
  const [passphrase, setPassphrase] = useState<string | null>(null);
  const [devicePassword, setDevicePassword] = useState('');
  const [storeRaw, setStoreRaw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [scanning, setScanning] = useState(false);

  const cameraAvailable =
    barcodeDetector() != null && typeof navigator !== 'undefined' && navigator.mediaDevices != null;

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setScanning(false);
  };

  useEffect(() => stopCamera, []);
  useEffect(() => {
    if (!open) {
      stopCamera();
      setPasted('');
      setPayload(null);
      setPin('');
      setPassphrase(null);
      setDevicePassword('');
      setError(null);
    }
  }, [open]);

  function accept(value: string) {
    const parsed = parseVaultQrPayload(value);
    if (!parsed.ok) {
      setError(t(`vault.v2.import.errors.${parsed.reason}`));
      return;
    }
    setError(null);
    setPayload(parsed.payload);
    stopCamera();
  }

  async function startCamera() {
    const detector = barcodeDetector();
    if (detector == null) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
      streamRef.current = stream;
      setScanning(true);
      const video = videoRef.current;
      if (video != null) {
        video.srcObject = stream;
        await video.play();
      }
      const loop = async () => {
        if (streamRef.current == null || video == null) return;
        try {
          const found = await detector.detect(video);
          const first = found[0]?.rawValue;
          if (first != null) {
            accept(first);
            return;
          }
        } catch {
          // A transient decode failure is normal while the user aims.
        }
        requestAnimationFrame(() => void loop());
      };
      void loop();
    } catch {
      setError(t('vault.v2.import.errors.camera'));
      stopCamera();
    }
  }

  async function readFile(file: File) {
    const detector = barcodeDetector();
    if (detector == null) {
      setError(t('vault.v2.import.errors.noDecoder'));
      return;
    }
    try {
      const found = await detector.detect(file);
      const first = found[0]?.rawValue;
      if (first == null) {
        setError(t('vault.v2.import.errors.notFound'));
        return;
      }
      accept(first);
    } catch {
      setError(t('vault.v2.import.errors.notFound'));
    }
  }

  /** Step two of the r2 §10 handoff: the PIN the sender read out. */
  async function unwrap() {
    if (payload == null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await unwrapVaultQrPayload(payload, pin);
      if (!result.ok) {
        setError(
          t(
            `vault.v2.import.errors.${result.reason === 'code-format' ? 'pinFormat' : result.reason === 'passphrase' ? 'passphrase' : 'pinWrong'}`,
          ),
        );
        return;
      }
      setPassphrase(result.passphrase);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (payload == null || passphrase == null) return;
    setBusy(true);
    setError(null);
    try {
      if (storeRaw) {
        await passphraseStore.putRaw({
          vaultId: payload.vaultId,
          passphrase,
          acknowledgement: RAW_STORAGE_ACKNOWLEDGEMENT,
        });
      } else {
        await passphraseStore.putWrapped({
          vaultId: payload.vaultId,
          passphrase,
          devicePassword,
        });
      }
      onImported(payload);
      onClose();
    } catch {
      setError(t('vault.v2.import.errors.store'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ODialog
      foot={
        <div className="flex w-full items-center justify-between gap-3">
          <Button onClick={onClose} variant="quiet">
            {t('common.cancel')}
          </Button>
          {payload != null && passphrase == null ? (
            <Button
              disabled={busy || !isValidQrCode(pin)}
              loading={busy}
              onClick={() => void unwrap()}
              variant="primary"
            >
              {t('vault.v2.import.actions.unlockCode')}
            </Button>
          ) : null}
          {passphrase != null ? (
            <Button
              disabled={busy || (!storeRaw && devicePassword.length === 0)}
              loading={busy}
              onClick={() => void save()}
              variant="primary"
            >
              {t('vault.v2.import.actions.save')}
            </Button>
          ) : null}
        </div>
      }
      onClose={onClose}
      open={open}
      title={t('vault.v2.import.title')}
    >
      <div className="flex flex-col gap-4">
        {payload == null ? (
          <>
            <p className="bt-soft text-sm">{t('vault.v2.import.body')}</p>

            {cameraAvailable ? (
              <div className="flex flex-col gap-2">
                {scanning ? (
                  <video
                    aria-label={t('vault.v2.import.cameraLabel')}
                    className="w-full rounded"
                    muted
                    playsInline
                    ref={videoRef}
                  />
                ) : null}
                <Button
                  icon="eye"
                  onClick={() => (scanning ? stopCamera() : void startCamera())}
                  size="sm"
                >
                  {scanning ? t('vault.v2.import.actions.stop') : t('vault.v2.import.actions.scan')}
                </Button>
              </div>
            ) : null}

            <Field htmlFor="vault-qr-file" label={t('vault.v2.import.file')}>
              <input
                accept="image/*"
                id="vault-qr-file"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file != null) void readFile(file);
                }}
                type="file"
              />
            </Field>

            <Field
              hint={t('vault.v2.import.pasteHint')}
              htmlFor="vault-qr-paste"
              label={t('vault.v2.import.paste')}
            >
              <Input
                autoComplete="off"
                id="vault-qr-paste"
                onChange={(event) => setPasted(event.target.value)}
                spellCheck={false}
                value={pasted}
              />
            </Field>
            <Button disabled={pasted.trim().length === 0} onClick={() => accept(pasted)} size="sm">
              {t('vault.v2.import.actions.use')}
            </Button>
          </>
        ) : passphrase == null ? (
          <>
            <p className="bt-row-title">{t('vault.v2.import.found', { name: payload.name })}</p>
            <p className="bt-soft text-sm">{t('vault.v2.import.pinIntro')}</p>
            <Field
              hint={t('vault.v2.import.pinHint')}
              htmlFor="vault-import-pin"
              label={t('vault.v2.import.pin')}
            >
              <Input
                autoComplete="one-time-code"
                id="vault-import-pin"
                autoCapitalize="characters"
                maxLength={VAULT2_QR_CODE_LENGTH + 1}
                onChange={(event) => setPin(event.target.value)}
                value={pin}
              />
            </Field>
          </>
        ) : (
          <>
            <p className="bt-row-title">{t('vault.v2.import.found', { name: payload.name })}</p>
            <p className="bt-soft text-sm">{t('vault.v2.import.storeIntro')}</p>
            {storeRaw ? null : (
              <Field
                hint={t('vault.v2.import.devicePasswordHint')}
                htmlFor="vault-import-password"
                label={t('vault.v2.import.devicePassword')}
              >
                <Input
                  autoComplete="new-password"
                  id="vault-import-password"
                  onChange={(event) => setDevicePassword(event.target.value)}
                  type="password"
                  value={devicePassword}
                />
              </Field>
            )}
            <label className="bt-settings-row items-start gap-3">
              <input
                checked={storeRaw}
                onChange={(event) => setStoreRaw(event.target.checked)}
                style={CHECKBOX_STYLE}
                type="checkbox"
              />
              <span>
                <span className="bt-row-title">{t('vault.v2.unlock.rawTitle')}</span>
                <span className="bt-field__error block">{t('vault.v2.unlock.rawWarning')}</span>
              </span>
            </label>
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
