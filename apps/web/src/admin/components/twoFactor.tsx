import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import { QRCodeSVG } from 'qrcode.react';

import { TOTP_CODE_LENGTH } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import * as api from '../../lib/adminApi';
import { ApiError } from '../../lib/apiClient';
import { Alert, Button, Spinner, TextField } from './ui';

/**
 * Shared building blocks for the admin two-factor surfaces (§6.12, #400): the
 * TOTP enroll form (QR + manual key + confirm), the email-method enroll/confirm
 * form, and the one-time recovery-code panel. Reused by both the forced-enrollment
 * wizard ({@link TwoFactorSetupPage}) and the Security settings page so the two
 * flows stay byte-identical.
 */

/** Map an API failure to a user-facing message: the API's own text for < 500, else generic. */
export function twoFactorErrorMessage(t: TranslateFn, err: unknown): string {
  if (err instanceof ApiError && err.status < 500) return err.message;
  return t('common.genericError');
}

/**
 * Recovery codes, shown exactly once after the first method is enabled or a
 * regenerate. Copy/download are conveniences; "done" acknowledges they're saved.
 */
export function RecoveryCodesPanel({
  codes,
  onDone,
}: {
  codes: readonly string[];
  onDone: () => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  function handleDownload() {
    try {
      const blob = new Blob([codes.join('\n') + '\n'], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'bettertrack-admin-recovery-codes.txt';
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      // Download is a convenience; copy still works if it's unavailable.
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Alert tone="info">{t('admin.twoFactor.recoveryCodes.saveNotice')}</Alert>
      <div className="grid grid-cols-2 gap-2 rounded-md border border-neutral-800 bg-neutral-950 p-4 font-mono text-sm text-neutral-100">
        {codes.map((code) => (
          <span key={code}>{code}</span>
        ))}
      </div>
      <div className="flex flex-wrap gap-3">
        <Button type="button" variant="secondary" onClick={handleCopy}>
          {copied
            ? t('admin.twoFactor.recoveryCodes.copied')
            : t('admin.twoFactor.recoveryCodes.copy')}
        </Button>
        <Button type="button" variant="secondary" onClick={handleDownload}>
          {t('admin.twoFactor.recoveryCodes.download')}
        </Button>
        <Button type="button" onClick={onDone}>
          {t('admin.twoFactor.recoveryCodes.done')}
        </Button>
      </div>
    </div>
  );
}

/** Authenticator (TOTP) enroll form: fetch a secret, show the QR/key, confirm a code. */
export function TotpEnrollForm({
  onEnrolled,
  onCancel,
}: {
  /** Receives the fresh recovery codes when this was the first method, else null. */
  onEnrolled: (recoveryCodes: string[] | null) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [enroll, setEnroll] = useState<{ otpauthUri: string; secret: string } | null>(null);
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Kick off enrollment once, when the form first mounts.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const data = await api.enrollTotp();
        if (active) setEnroll(data);
      } catch {
        if (active) setEnrollError(t('admin.twoFactor.totp.enrollError'));
      }
    })();
    return () => {
      active = false;
    };
  }, [t]);

  if (!enroll) {
    return enrollError ? <Alert tone="error">{enrollError}</Alert> : <Spinner />;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { recoveryCodes } = await api.confirmTotp({ code });
      onEnrolled(recoveryCodes);
    } catch (err) {
      setError(twoFactorErrorMessage(t, err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <p className="text-sm text-neutral-400">{t('admin.twoFactor.totp.scanInstructions')}</p>
      {/* QR needs a light quiet-zone to scan reliably against the dark theme. */}
      <div className="self-start rounded-md bg-white p-3">
        <QRCodeSVG
          value={enroll.otpauthUri}
          size={176}
          marginSize={0}
          aria-label={t('admin.twoFactor.totp.qrAriaLabel')}
        />
      </div>
      <details className="rounded-md border border-neutral-800 bg-neutral-950 p-4">
        <summary className="cursor-pointer text-xs font-medium text-neutral-400">
          {t('admin.twoFactor.totp.manualEntryToggle')}
        </summary>
        <div className="mt-3 flex flex-col gap-1.5">
          <span className="text-xs font-medium text-neutral-500">
            {t('admin.twoFactor.totp.setupKeyLabel')}
          </span>
          <code className="break-all text-sm text-neutral-100">{enroll.secret}</code>
          <span className="mt-2 text-xs font-medium text-neutral-500">
            {t('admin.twoFactor.totp.otpauthUriLabel')}
          </span>
          <code className="break-all text-xs text-neutral-400">{enroll.otpauthUri}</code>
        </div>
      </details>
      <TextField
        label={t('admin.twoFactor.totp.confirmationCodeLabel')}
        name="totp-code"
        autoComplete="one-time-code"
        inputMode="numeric"
        autoFocus
        value={code}
        onChange={(e) => setCode(e.target.value)}
        hint={t('admin.twoFactor.totp.confirmationCodeHint')}
      />
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={submitting || code.length !== TOTP_CODE_LENGTH}>
          {submitting ? t('admin.twoFactor.confirming') : t('admin.twoFactor.confirmAndEnable')}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

/**
 * Email-method enroll form: name the 2FA email (with a fresh proof when already
 * enrolled — a change must clear a current second factor, #400), receive a code,
 * then confirm it. `requireProof` gates the proof field.
 */
export function EmailEnrollForm({
  requireProof,
  initialEmail,
  onEnrolled,
  onCancel,
}: {
  requireProof: boolean;
  initialEmail?: string | null;
  onEnrolled: (recoveryCodes: string[] | null) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [phase, setPhase] = useState<'start' | 'confirm'>('start');
  const [email, setEmail] = useState(initialEmail ?? '');
  const [proof, setProof] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onStart(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.startEmailTwoFactor({
        email: email.trim(),
        ...(requireProof ? { proof: proof.trim() } : {}),
      });
      setPhase('confirm');
    } catch (err) {
      setError(twoFactorErrorMessage(t, err));
    } finally {
      setSubmitting(false);
    }
  }

  async function onConfirm(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { recoveryCodes } = await api.confirmEmailTwoFactor({ code });
      onEnrolled(recoveryCodes);
    } catch (err) {
      setError(twoFactorErrorMessage(t, err));
    } finally {
      setSubmitting(false);
    }
  }

  if (phase === 'confirm') {
    return (
      <form onSubmit={onConfirm} className="flex flex-col gap-4">
        {error ? <Alert tone="error">{error}</Alert> : null}
        <p className="text-sm text-neutral-400">
          {t('admin.twoFactor.email.confirmInstructions', { email: email.trim() })}
        </p>
        <TextField
          label={t('admin.twoFactor.email.codeLabel')}
          name="email-code"
          autoComplete="one-time-code"
          inputMode="numeric"
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value)}
          hint={t('admin.twoFactor.email.codeHint')}
        />
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={submitting || code.length !== TOTP_CODE_LENGTH}>
            {submitting ? t('admin.twoFactor.confirming') : t('admin.twoFactor.confirmAndEnable')}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={onStart} className="flex flex-col gap-4">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <TextField
        label={t('admin.twoFactor.email.emailLabel')}
        name="two-factor-email"
        type="email"
        autoComplete="email"
        autoFocus
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      {requireProof ? (
        <TextField
          label={t('admin.twoFactor.email.proofLabel')}
          name="two-factor-proof"
          autoComplete="one-time-code"
          value={proof}
          onChange={(e) => setProof(e.target.value)}
          hint={t('admin.twoFactor.email.proofHint')}
        />
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button
          type="submit"
          disabled={
            submitting || email.trim().length === 0 || (requireProof && proof.trim().length < 6)
          }
        >
          {submitting
            ? t('admin.twoFactor.email.sendingCode')
            : t('admin.twoFactor.email.sendCode')}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}
