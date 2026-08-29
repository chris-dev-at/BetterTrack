import { useState } from 'react';

import { PIN_LENGTH } from '@bettertrack/contracts';
import type { MeResponse } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import { useAuth } from '../AuthContext';
import { type AttributedError, useFieldErrors } from '../components/fieldErrors';
import { PinInput } from '../components/PinInput';
import { Alert, AuthCard, Button } from '../components/ui';
import type { RememberedAccount } from './rememberedAccount';

/**
 * Friendly message for the codes `POST /auth/pin/quick-auth` can return, with
 * the rejected PIN attributed to the boxes that hold it (FRONTEND-09); a rate
 * limit or an outage belongs to the submission instead.
 */
function quickAuthErrorMessage(t: TranslateFn, err: unknown): AttributedError<'pin'> {
  if (err instanceof ApiError) {
    if (err.code === 'INVALID_PIN') return { field: 'pin', message: t('auth.pin.invalidPin') };
    if (err.status === 429) return { field: null, message: t('auth.pin.rateLimited') };
    if (err.status >= 500) return { field: null, message: t('common.genericError') };
  }
  return { field: null, message: t('auth.pin.verifyFailed') };
}

/** A lettered placeholder for the remembered account (there is no avatar system yet). */
function AccountAvatar({ username }: { username: string }) {
  const initial = username.trim().charAt(0).toUpperCase() || '?';
  return (
    <span aria-hidden className="bt-avatar bt-avatar--lg">
      {initial}
    </span>
  );
}

/**
 * OAuth account chooser — state-ladder step 2 (PROJECTPLAN.md §16; owner spec
 * #399 §B, V4-P2b). Shown ONLY when the device remembers a PIN user but there is
 * no valid session (state 1, a live PIN-gated session, uses the existing
 * "Welcome back — enter your PIN" gate; state 3, nothing remembered, is the blank
 * login). The chooser is ALWAYS interposed — never skipped — so switching
 * accounts stays one tap away.
 *
 * "Log in as [name]" pre-selects the identity only; authentication still follows:
 * a probe (`quickAuth` with no PIN) auto-passes when the ~15-min window from a
 * recent PIN entry is still open, otherwise the PIN input appears. The identity
 * is bound to the signed `bt_rdid` cookie server-side — this component never
 * sends it. "Another account" clears the memory and drops to a blank login.
 */
export function OAuthAccountChooser({
  account,
  onAuthenticated,
  onAnotherAccount,
}: {
  account: RememberedAccount;
  /** The remembered PIN user signed in — hand the resolved user to the OAuth flow. */
  onAuthenticated: (me: MeResponse) => void;
  /** "Another account" (or a stale/forgotten binding) — forget + fall to blank login. */
  onAnotherAccount: () => void;
}) {
  const t = useT();
  const { quickAuth } = useAuth();

  // 'choose' = the Log-in-as / Another-account buttons; 'pin' = the PIN input,
  // shown once a probe reports the auto-pass window is closed.
  const [view, setView] = useState<'choose' | 'pin'>('choose');
  const [pin, setPin] = useState('');
  const { formRef, alertRef, fieldError, formError, fail, clear } = useFieldErrors<'pin'>();
  const [busy, setBusy] = useState(false);
  // Remount the PinInput to clear the boxes after a wrong PIN (mirrors PinGate).
  const [attempt, setAttempt] = useState(0);

  /**
   * `canBlamePin` is false on the probe: no PIN was sent and the boxes are not
   * even mounted yet, so nothing on screen can carry the failure.
   */
  function handleError(err: unknown, canBlamePin: boolean) {
    // A gone/expired server binding means the local memory is stale: forget it
    // and fall back to a blank login rather than trap the user on a dead chooser.
    if (err instanceof ApiError && err.code === 'REMEMBER_DEVICE_UNKNOWN') {
      onAnotherAccount();
      return;
    }
    const attributed = quickAuthErrorMessage(t, err);
    fail(canBlamePin ? attributed.field : null, attributed.message);
  }

  // Tapping the remembered name: probe the ~15-min window first (owner: "tapping
  // your name while the PIN timer is still running ⇒ auto-login"). The chooser
  // itself was still shown — this fires only on the tap.
  async function handleLoginAs() {
    if (busy) return;
    clear();
    setBusy(true);
    try {
      const outcome = await quickAuth({});
      if (outcome.status === 'authenticated') {
        onAuthenticated(outcome.me);
      } else {
        // Window closed — collect the PIN.
        setView('pin');
      }
    } catch (err) {
      handleError(err, false);
    } finally {
      setBusy(false);
    }
  }

  async function submitPin(value: string) {
    if (busy) return;
    clear();
    setBusy(true);
    try {
      const outcome = await quickAuth({ pin: value });
      if (outcome.status === 'authenticated') {
        onAuthenticated(outcome.me);
        return;
      }
      // A PIN was sent but the server still asks for one — treat as a failed
      // attempt on the boxes (defensive; the server does not do this in practice).
      fail('pin', t('auth.pin.verifyFailed'));
      setPin('');
      setAttempt((n) => n + 1);
    } catch (err) {
      handleError(err, true);
      setPin('');
      setAttempt((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }

  if (view === 'pin') {
    return (
      <AuthCard subtitle={t('auth.oauthChooser.subtitle')}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (pin.length === PIN_LENGTH) void submitPin(pin);
          }}
          className="flex flex-col gap-4"
          ref={formRef}
        >
          <div className="flex items-center gap-3">
            <AccountAvatar username={account.username} />
            <p className="bt-soft text-sm">
              {t('auth.oauthChooser.pinPrompt', {
                username: account.username,
                length: PIN_LENGTH,
              })}
            </p>
          </div>
          {formError ? (
            <div ref={alertRef} tabIndex={-1}>
              <Alert tone="error">{formError}</Alert>
            </div>
          ) : null}
          <div className="flex justify-center">
            <PinInput
              key={attempt}
              error={fieldError('pin')}
              label={t('auth.pin.inputLabel')}
              length={PIN_LENGTH}
              value={pin}
              onChange={setPin}
              onComplete={(value) => void submitPin(value)}
              disabled={busy}
              autoFocus
            />
          </div>
          <Button type="button" variant="ghost" onClick={onAnotherAccount} disabled={busy}>
            {t('auth.oauthChooser.anotherAccount')}
          </Button>
        </form>
      </AuthCard>
    );
  }

  return (
    <AuthCard subtitle={t('auth.oauthChooser.subtitle')}>
      <div className="flex flex-col gap-4">
        <p className="bt-muted text-sm">{t('auth.oauthChooser.prompt')}</p>
        {/* The probe step has no form, so this wrapper is the focus target the
            failure effect falls back to. */}
        {formError ? (
          <div ref={alertRef} tabIndex={-1}>
            <Alert tone="error">{formError}</Alert>
          </div>
        ) : null}
        <button
          type="button"
          onClick={() => void handleLoginAs()}
          disabled={busy}
          className="bt-btn w-full disabled:opacity-60"
          // The remembered identity is the screen's main tap target: the system
          // control surface (border, hover, focus, disabled) relaxed into a
          // left-aligned, two-line row.
          style={{
            justifyContent: 'flex-start',
            minHeight: 0,
            padding: 11,
            gap: 12,
            textAlign: 'left',
            whiteSpace: 'normal',
          }}
        >
          <AccountAvatar username={account.username} />
          <span className="flex flex-col">
            <span className="bt-row-title">
              {t('auth.oauthChooser.loginAs', { username: account.username })}
            </span>
            <span className="bt-row-sub">
              {busy ? t('auth.oauthChooser.checking') : t('auth.oauthChooser.pinHint')}
            </span>
          </span>
        </button>
        <Button type="button" variant="ghost" onClick={onAnotherAccount} disabled={busy}>
          {t('auth.oauthChooser.anotherAccount')}
        </Button>
      </div>
    </AuthCard>
  );
}
