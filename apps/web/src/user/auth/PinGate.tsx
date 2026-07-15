import { useCallback, useEffect, useRef, useState } from 'react';

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
 *
 * **Page-wide capture (V4-P0 (a)):** a document keydown listener routes digit
 * keystrokes into the PIN boxes even when focus is elsewhere on the gate (a
 * scrolled body, the Sign-out button) — so "typing anywhere" fills the PIN and
 * Backspace edits it. Native input focus still wins when a box itself is focused,
 * so the per-box masking rules keep applying.
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
  // The page-wide keydown handler runs off refs so a single listener can read
  // the latest state without re-registering on every keystroke.
  const pinRef = useRef(pin);
  const submittingRef = useRef(submitting);
  useEffect(() => {
    pinRef.current = pin;
  }, [pin]);
  useEffect(() => {
    submittingRef.current = submitting;
  }, [submitting]);

  const submit = useCallback(
    async (value: string) => {
      // Guard against a double-fire (auto-complete + a stray Enter/click).
      if (submittingRef.current) return;
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
    },
    [t, verifyPin],
  );

  // Page-wide keystroke capture (V4-P0 (a)). Digit keys land in the PIN state;
  // Backspace edits it — whether focus is on a PIN box, the Sign-out button, or
  // the body. When a PIN box itself has focus, defer to its own onChange so the
  // per-box masking rules run. pinRef is bumped SYNCHRONOUSLY inside the handler
  // so a rapid burst of keystrokes doesn't read a stale value before React commits.
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      // Native input handling wins when a PIN box (or any input) is focused.
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      // Ignore browser shortcuts (Ctrl-R, Cmd-Q, …). Shift is fine (row keys).
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (submittingRef.current) return;

      if (/^[0-9]$/.test(e.key) && pinRef.current.length < PIN_LENGTH) {
        e.preventDefault();
        const next = (pinRef.current + e.key).slice(0, PIN_LENGTH);
        pinRef.current = next;
        setPin(next);
        if (next.length === PIN_LENGTH) void submit(next);
      } else if (e.key === 'Backspace' && pinRef.current.length > 0) {
        e.preventDefault();
        const next = pinRef.current.slice(0, -1);
        pinRef.current = next;
        setPin(next);
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [submit]);

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
