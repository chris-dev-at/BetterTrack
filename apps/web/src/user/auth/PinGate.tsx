import { useState } from 'react';

import { PIN_LENGTH } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import { Wordmark } from '../../components/Wordmark';
import { ApiError } from '../../lib/apiClient';
import { useAuth } from '../AuthContext';
import { PinInput } from '../components/PinInput';
import { Alert, Button, cx } from '../components/ui';

/** Friendly message for the codes `POST /auth/pin/verify` can return. */
function pinErrorMessage(t: TranslateFn, err: unknown): string {
  if (err instanceof ApiError) {
    // The fallback case navigates away (the session was dropped); this message
    // only flashes if that transition hasn't rendered yet.
    if (err.code === 'PIN_FALLBACK_LOGIN') return t('auth.pin.fallbackError');
    if (err.code === 'INVALID_PIN') return t('auth.pin.invalidPin');
    if (err.status === 429) return t('auth.pin.rateLimited');
    if (err.status >= 500) return t('common.genericError');
  }
  return t('auth.pin.verifyFailed');
}

/**
 * PIN gate (PROJECTPLAN.md §6.1). The PIN is a privacy curtain — it keeps a
 * passer-by from reading your balances on a screen you left open — not a security
 * boundary (that's the session, untouched here). While the account has the PIN on
 * and the app has sat idle past the configured window (owner directive #304), the
 * app traps every route here, mirroring the forced-password-change trap.
 *
 * The lock screen is a deliberate, centered card on the app's dark backdrop: the
 * BetterTrack wordmark, an "Enter your PIN" heading, and {@link PIN_LENGTH} large,
 * evenly-spaced boxes that submit automatically once the last is filled — no
 * button press (#288). A wrong PIN shakes the card, clears the boxes and refocuses
 * the first; five wrong PINs in a row drop the session server-side and bounce the
 * user to the full login screen. The user can always sign out instead.
 */
export function PinGate() {
  const t = useT();
  const { user, verifyPin, logout } = useAuth();

  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Bumping this remounts the PinInput, which clears every box and refocuses the
  // first — the reset after a wrong PIN.
  const [attempt, setAttempt] = useState(0);
  // Drives the brief shake on the card after a wrong PIN; cleared when the CSS
  // animation ends so a later reject can retrigger it.
  const [shake, setShake] = useState(false);

  async function submit(value: string) {
    // Guard against a double-fire (auto-complete + a stray Enter/click).
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      // Success releases the trap via the AuthContext.
      await verifyPin({ pin: value });
    } catch (err) {
      setError(pinErrorMessage(t, err));
      setPin('');
      setAttempt((n) => n + 1);
      setShake(true);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#0b0e14] px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <Wordmark edition="Web" className="text-2xl" />
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (pin.length === PIN_LENGTH) void submit(pin);
          }}
          onAnimationEnd={() => setShake(false)}
          className={cx(
            'flex flex-col gap-6 rounded-xl border border-neutral-800 bg-neutral-900 p-8 shadow-xl shadow-black/30',
            shake && 'pin-shake',
          )}
        >
          <div className="flex flex-col gap-1 text-center">
            <h1 className="text-lg font-semibold text-neutral-100">{t('auth.pin.heading')}</h1>
            <p className="text-sm text-neutral-500">
              {user
                ? t('auth.pin.promptWithUser', { username: user.username, length: PIN_LENGTH })
                : t('auth.pin.prompt', { length: PIN_LENGTH })}
            </p>
          </div>

          {error ? <Alert tone="error">{error}</Alert> : null}

          <div className="flex justify-center">
            <PinInput
              key={attempt}
              label={t('auth.pin.inputLabel')}
              length={PIN_LENGTH}
              value={pin}
              onChange={setPin}
              onComplete={(value) => void submit(value)}
              disabled={submitting}
              autoFocus
            />
          </div>

          <Button type="button" variant="ghost" onClick={() => void logout()} disabled={submitting}>
            {t('auth.common.signOut')}
          </Button>
        </form>
      </div>
    </div>
  );
}
