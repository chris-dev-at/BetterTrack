import { useState } from 'react';

import { PIN_LENGTH } from '@bettertrack/contracts';

import { ApiError } from '../../lib/apiClient';
import { useAuth } from '../AuthContext';
import { PinInput } from '../components/PinInput';
import { Alert, AuthCard, Button } from '../components/ui';

/** Friendly message for the codes `POST /auth/pin/verify` can return. */
function pinErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    // The fallback case navigates away (the session was dropped); this message
    // only flashes if that transition hasn't rendered yet.
    if (err.code === 'PIN_FALLBACK_LOGIN')
      return 'Too many incorrect PINs. Please sign in with your password.';
    if (err.code === 'INVALID_PIN') return 'Incorrect PIN. Please try again.';
    if (err.status === 429) return 'Too many attempts. Please wait a moment and try again.';
    if (err.status >= 500) return 'Something went wrong. Please try again.';
  }
  return 'Could not verify your PIN. Please try again.';
}

/**
 * PIN gate (PROJECTPLAN.md §6.1). While the account has the PIN enabled and the
 * current unlock window has lapsed, the app traps every route here (mirroring
 * the forced-password-change trap). The PIN is exactly {@link PIN_LENGTH} digits
 * and submits automatically once the fourth box is filled — no button press
 * needed (#288). A correct PIN releases the trap and opens a fresh unlock window;
 * a wrong PIN clears the boxes and refocuses the first; five wrong PINs in a row
 * drop the session server-side and bounce the user to the full login screen. The
 * user can always sign out instead.
 */
export function PinGate() {
  const { user, verifyPin, logout } = useAuth();

  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Bumping this remounts the PinInput, which clears every box and refocuses the
  // first — the reset after a wrong PIN.
  const [attempt, setAttempt] = useState(0);

  async function submit(value: string) {
    // Guard against a double-fire (auto-complete + a stray Enter/click).
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      // Success releases the trap via the AuthContext.
      await verifyPin({ pin: value });
    } catch (err) {
      setError(pinErrorMessage(err));
      setPin('');
      setAttempt((n) => n + 1);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthCard subtitle="Enter your PIN">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (pin.length === PIN_LENGTH) void submit(pin);
        }}
        className="flex flex-col gap-4 rounded-lg border border-neutral-800 bg-neutral-900 p-6"
      >
        <Alert tone="info">
          {user ? <>Welcome back, {user.username}. </> : null}
          Enter your PIN to continue.
        </Alert>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <PinInput
          key={attempt}
          label="PIN"
          length={PIN_LENGTH}
          value={pin}
          onChange={setPin}
          onComplete={(value) => void submit(value)}
          disabled={submitting}
          autoFocus
          hint={`${PIN_LENGTH} digits.`}
        />
        <Button type="button" variant="ghost" onClick={() => void logout()} disabled={submitting}>
          Sign out
        </Button>
      </form>
    </AuthCard>
  );
}
