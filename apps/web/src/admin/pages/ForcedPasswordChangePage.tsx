import { useState } from 'react';
import type { FormEvent } from 'react';

import { MIN_PASSWORD_LENGTH } from '@bettertrack/contracts';

import { Wordmark } from '../../components/Wordmark';
import { ApiError } from '../../lib/apiClient';
import { NotAdminError, useAuth } from '../AuthContext';
import { Alert, Button, TextField } from '../components/ui';

/** Friendly message for the codes `POST /auth/change-password` can return. */
function changeErrorMessage(err: unknown): string {
  if (err instanceof NotAdminError) return err.message;
  if (err instanceof ApiError) {
    if (err.code === 'WEAK_PASSWORD') return err.message;
    if (err.status >= 500) return 'Something went wrong. Please try again.';
  }
  return 'Could not change your password. Please try again.';
}

/**
 * Forced password change for the admin area (PROJECTPLAN.md §6.1). An admin whose
 * password was reset lands here — trapped by the AuthContext until the change
 * clears the flag — so the account is recoverable in the admin panel itself
 * rather than bricked in the user-panel-rejects-admin loop (#248 item 6). The
 * temp-password login is the proof, so the current password is never asked for
 * again (#248 item 7); the policy/blocklist is enforced server-side.
 */
export function ForcedPasswordChangePage() {
  const { changePassword, logout } = useAuth();

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirmPassword) {
      setError('The new passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      // Success clears the flag and releases the trap via the AuthContext.
      await changePassword({ newPassword });
    } catch (err) {
      setError(changeErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="safe-pt safe-pb safe-px grid min-h-screen place-items-center bg-neutral-950 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <Wordmark edition="Admin" className="text-2xl" />
        </div>
        <form
          onSubmit={onSubmit}
          className="flex flex-col gap-4 rounded-lg border border-neutral-800 bg-neutral-900 p-6"
        >
          <Alert tone="info">Set a new password before continuing to the admin console.</Alert>
          {error ? <Alert tone="error">{error}</Alert> : null}
          <TextField
            label="New password"
            name="newPassword"
            type="password"
            autoComplete="new-password"
            autoFocus
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            minLength={MIN_PASSWORD_LENGTH}
            required
            hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
          />
          <TextField
            label="Confirm new password"
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            minLength={MIN_PASSWORD_LENGTH}
            required
          />
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Updating…' : 'Update password'}
          </Button>
          <Button type="button" variant="ghost" onClick={() => void logout()} disabled={submitting}>
            Sign out
          </Button>
        </form>
      </div>
    </div>
  );
}
