import { useState } from 'react';
import type { FormEvent } from 'react';

import { useT } from '../../i18n';
import { Wordmark } from '../../components/Wordmark';
import { ApiError } from '../../lib/apiClient';
import { useAuth } from '../AuthContext';
import { Alert, Button, TextField } from '../components/ui';

/**
 * Login-time 2FA challenge for an enrolled admin (§6.12, #400). The password step
 * returned a challenge instead of a session; this screen collects the second
 * factor — a TOTP/emailed code, an emailed code on request, or a recovery code —
 * and promotes the pending challenge to a real session. Trapped above routing by
 * the AuthContext, exactly like the forced-change screen.
 */
export function TwoFactorChallengePage() {
  const t = useT();
  const { twoFactorChallenge, verifyTwoFactor, requestTwoFactorEmailCode, clearSession } =
    useAuth();

  const totpAvailable = twoFactorChallenge?.channels.includes('totp') ?? false;
  const emailAvailable = twoFactorChallenge?.channels.includes('email') ?? false;
  const recoveryAvailable = twoFactorChallenge?.channels.includes('recovery') ?? false;

  const [useRecovery, setUseRecovery] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);

  // Defensive: only mounted while a challenge is pending, but never render a form
  // without one.
  if (!twoFactorChallenge) return null;

  // Tailor the prompt to the channels this admin actually enabled.
  const codePrompt = totpAvailable
    ? emailAvailable
      ? t('admin.twoFactor.challenge.promptTotpAndEmail')
      : t('admin.twoFactor.challenge.promptTotpOnly')
    : t('admin.twoFactor.challenge.promptEmailOnly');

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setSubmitting(true);
    try {
      await verifyTwoFactor(useRecovery ? { recoveryCode: value.trim() } : { code: value.trim() });
      // Success flips the AuthContext status, so this screen unmounts.
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setError(t('admin.twoFactor.challenge.tooManyCodes'));
      } else if (err instanceof ApiError && err.code === 'TWO_FACTOR_PENDING_INVALID') {
        setError(t('admin.twoFactor.challenge.sessionExpired'));
      } else {
        setError(t('admin.twoFactor.challenge.invalidCode'));
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function onEmailCode() {
    setError(null);
    setInfo(null);
    setSendingCode(true);
    try {
      await requestTwoFactorEmailCode();
      setInfo(t('admin.twoFactor.challenge.emailCodeSent'));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'TWO_FACTOR_PENDING_INVALID') {
        setError(t('admin.twoFactor.challenge.sessionExpired'));
      } else {
        setError(t('admin.twoFactor.challenge.emailCodeFailed'));
      }
    } finally {
      setSendingCode(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-neutral-950 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <Wordmark edition="Admin" className="text-2xl" />
        </div>
        <form
          onSubmit={onSubmit}
          className="flex flex-col gap-4 rounded-lg border border-neutral-800 bg-neutral-900 p-6"
        >
          <p className="text-sm font-semibold text-neutral-100">
            {t('admin.twoFactor.challenge.title')}
          </p>
          {error ? <Alert tone="error">{error}</Alert> : null}
          {info ? <Alert tone="info">{info}</Alert> : null}
          <p className="text-sm text-neutral-400">
            {useRecovery ? t('admin.twoFactor.challenge.recoveryPrompt') : codePrompt}
          </p>
          <TextField
            label={
              useRecovery
                ? t('admin.twoFactor.challenge.recoveryCodeLabel')
                : t('admin.twoFactor.challenge.codeLabel')
            }
            name={useRecovery ? 'recoveryCode' : 'code'}
            autoComplete="one-time-code"
            inputMode={useRecovery ? 'text' : 'numeric'}
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            required
          />
          <Button type="submit" disabled={submitting || value.trim().length === 0}>
            {submitting
              ? t('admin.twoFactor.challenge.verifying')
              : t('admin.twoFactor.challenge.verify')}
          </Button>
          {emailAvailable && !useRecovery ? (
            <Button type="button" variant="secondary" onClick={onEmailCode} disabled={sendingCode}>
              {sendingCode
                ? t('admin.twoFactor.challenge.sendingEmailCode')
                : t('admin.twoFactor.challenge.emailMeACode')}
            </Button>
          ) : null}
          {recoveryAvailable ? (
            <button
              type="button"
              className="text-center text-sm font-medium text-sky-400 hover:text-sky-300"
              onClick={() => {
                setUseRecovery((v) => !v);
                setValue('');
                setError(null);
                setInfo(null);
              }}
            >
              {useRecovery
                ? t('admin.twoFactor.challenge.useAuthenticatorOrEmail')
                : t('admin.twoFactor.challenge.useRecoveryCode')}
            </button>
          ) : null}
          <button
            type="button"
            className="text-center text-sm font-medium text-neutral-400 hover:text-neutral-200"
            onClick={() => clearSession()}
          >
            {t('admin.twoFactor.challenge.backToSignIn')}
          </button>
        </form>
      </div>
    </div>
  );
}
