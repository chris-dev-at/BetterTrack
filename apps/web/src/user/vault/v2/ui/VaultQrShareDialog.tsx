import { VAULT2_QR_TTL_MS } from '@bettertrack/contracts';
import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';

import { useT } from '../../../../i18n';
import { Button, Field, Input, ODialog } from '../../../../ui/origin';
import { reauthenticate } from '../api';
import type { VaultKeyring } from '../keyring';
import { buildVaultQrPayload, generateQrPin } from '../qr';

/**
 * QR handoff to another device (`docs/VAULTS_V2_DESIGN.md` r2 §10).
 *
 * The r2 shape is deliberately two screens:
 *
 *  1. **the code** — `btvault1:{"qr":1,…,"w":…}`, where `w` is the passphrase
 *     wrapped under a one-time 6-digit PIN. Photographing this screen gets an
 *     attacker nothing.
 *  2. **the PIN** — shown only after the sender taps "reveal", read out loud or
 *     typed on the other device.
 *
 * Gates, all mandatory:
 *  - the vault must be UNLOCKED here (otherwise there are no words);
 *  - the account password must verify server-side, and if the verifier is
 *    unavailable the dialog REFUSES rather than degrading to an ungated reveal;
 *  - the whole handoff expires after {@link VAULT2_QR_TTL_MS} (120 s).
 *
 * The code is an inline SVG from `qrcode.react`, so nothing is fetched — the
 * app CSP forbids external assets, and the payload never leaves the page.
 */

export interface VaultQrShareDialogProps {
  open: boolean;
  onClose: () => void;
  vaultId: string;
  vaultName: string;
  keyring: VaultKeyring;
}

type Phase =
  | { kind: 'reauth' }
  | { kind: 'code'; payload: string; pin: string; expiresAt: number; pinRevealed: boolean }
  | { kind: 'expired' };

export function VaultQrShareDialog({
  open,
  onClose,
  vaultId,
  vaultName,
  keyring,
}: VaultQrShareDialogProps) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>({ kind: 'reauth' });
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    if (!open) {
      setPhase({ kind: 'reauth' });
      setPassword('');
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    if (phase.kind !== 'code') return;
    const tick = () => {
      const left = phase.expiresAt - Date.now();
      if (left <= 0) {
        setPhase({ kind: 'expired' });
        setRemaining(0);
        return;
      }
      setRemaining(Math.ceil(left / 1000));
    };
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [phase]);

  async function reveal() {
    setBusy(true);
    setError(null);
    try {
      const result = await reauthenticate(password);
      if (result.status === 'invalid') {
        setError(t('vault.v2.qr.errors.invalidPassword'));
        return;
      }
      if (result.status === 'rate-limited') {
        setError(t('vault.v2.qr.errors.rateLimited'));
        return;
      }
      if (result.status === 'unavailable') {
        // Fail closed. An unimplemented verifier is not permission to skip the
        // gate on a surface whose only job is to hand over a live secret.
        setError(t('vault.v2.qr.errors.reauthUnavailable'));
        return;
      }

      const pin = generateQrPin();
      const payload = await buildVaultQrPayload({
        vaultId,
        name: vaultName,
        passphrase: keyring.revealPassphrase(vaultId),
        pin,
      });
      setPassword('');
      setPhase({
        kind: 'code',
        payload,
        pin,
        expiresAt: Date.now() + VAULT2_QR_TTL_MS,
        pinRevealed: false,
      });
    } catch {
      setError(t('vault.v2.qr.errors.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ODialog
      foot={
        <div className="flex w-full items-center justify-between gap-3">
          <Button onClick={onClose} variant="quiet">
            {t('common.close')}
          </Button>
          {phase.kind === 'reauth' ? (
            <Button
              disabled={password.length === 0 || busy}
              loading={busy}
              onClick={() => void reveal()}
              variant="primary"
            >
              {t('vault.v2.qr.actions.start')}
            </Button>
          ) : null}
          {phase.kind === 'code' && !phase.pinRevealed ? (
            <Button onClick={() => setPhase({ ...phase, pinRevealed: true })} variant="primary">
              {t('vault.v2.qr.actions.revealPin')}
            </Button>
          ) : null}
          {phase.kind === 'expired' ? (
            <Button onClick={() => setPhase({ kind: 'reauth' })} variant="primary">
              {t('vault.v2.qr.actions.again')}
            </Button>
          ) : null}
        </div>
      }
      onClose={onClose}
      open={open}
      title={t('vault.v2.qr.title', { name: vaultName })}
    >
      <div className="flex flex-col gap-4">
        {phase.kind === 'reauth' ? (
          <>
            <p className="bt-soft text-sm">{t('vault.v2.qr.body')}</p>
            <Field
              hint={t('vault.v2.qr.passwordHint')}
              htmlFor="vault-qr-password"
              label={t('vault.v2.qr.password')}
            >
              <Input
                autoComplete="current-password"
                id="vault-qr-password"
                onChange={(event) => setPassword(event.target.value)}
                type="password"
                value={password}
              />
            </Field>
            {error ? (
              <p className="bt-field__error" role="alert">
                {error}
              </p>
            ) : null}
          </>
        ) : null}

        {phase.kind === 'code' ? (
          <div className="flex flex-col items-center gap-3">
            <p className="bt-soft text-sm">{t('vault.v2.qr.scanFirst')}</p>
            {/*
              The code renders in the library's default black-on-white. That is
              deliberately NOT theme-tokenized: a themed QR is an unreliable QR,
              and the contrast a scanner needs is functional, not stylistic.
            */}
            <div
              aria-label={t('vault.v2.qr.codeLabel', { name: vaultName })}
              className="bt-panel"
              role="img"
              style={{ padding: 12, lineHeight: 0 }}
            >
              <QRCodeSVG marginSize={2} size={220} value={phase.payload} />
            </div>

            <p aria-live="polite" className="bt-meta" role="status">
              {t('vault.v2.qr.expires', { seconds: remaining })}
            </p>

            {phase.pinRevealed ? (
              <div className="bt-panel bt-panel--soft flex flex-col items-center gap-1">
                <p className="bt-label">{t('vault.v2.qr.pinLabel')}</p>
                <p className="bt-h2 tracking-widest tabular-nums">{phase.pin}</p>
                <p className="bt-row-sub">{t('vault.v2.qr.pinHint')}</p>
              </div>
            ) : (
              <p className="bt-row-sub">{t('vault.v2.qr.pinPending')}</p>
            )}

            <p className="bt-field__error">{t('vault.v2.qr.screenshotWarning')}</p>
          </div>
        ) : null}

        {phase.kind === 'expired' ? (
          <p className="bt-soft text-sm" role="status">
            {t('vault.v2.qr.expired')}
          </p>
        ) : null}
      </div>
    </ODialog>
  );
}
