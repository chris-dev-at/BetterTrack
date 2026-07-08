import { useState } from 'react';
import type { FormEvent } from 'react';

import { MIN_PASSWORD_LENGTH } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import { useAuth } from '../AuthContext';
import { Alert, AuthCard, Button, TextField } from '../components/ui';

/** Friendly message for the codes `POST /auth/change-password` can return. */
function changeErrorMessage(t: TranslateFn, err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'WEAK_PASSWORD') return err.message;
    if (err.status >= 500) return t('common.genericError');
  }
  return t('auth.forcedPasswordChange.failed');
}

/**
 * Forced password change (PROJECTPLAN.md §6.1). The app traps every route here
 * while the session carries `mustChangePassword`; the screen is escapable only
 * by a successful change (which clears the flag) or by signing out. Because the
 * user just proved the temp password by signing in, the session itself is the
 * proof — the current password is never asked for again (#248 item 7). The new
 * password is confirmed client-side; the policy/blocklist is enforced server-side.
 */
export function ForcedPasswordChangePage() {
  const t = useT();
  const { user, changePassword, logout } = useAuth();

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirmPassword) {
      setError(t('auth.forcedPasswordChange.mismatch'));
      return;
    }
    setSubmitting(true);
    try {
      // Success rotates the session and releases the trap via the AuthContext.
      await changePassword({ newPassword });
    } catch (err) {
      setError(changeErrorMessage(t, err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthCard subtitle={t('auth.forcedPasswordChange.subtitle')}>
      <form
        onSubmit={onSubmit}
        className="flex flex-col gap-4 rounded-lg border border-neutral-800 bg-neutral-900 p-6"
      >
        <Alert tone="info">
          {user
            ? t('auth.forcedPasswordChange.signedInAs', { email: user.email })
            : t('auth.forcedPasswordChange.infoNoUser')}
        </Alert>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <TextField
          label={t('auth.forcedPasswordChange.newPasswordLabel')}
          name="newPassword"
          type="password"
          autoComplete="new-password"
          autoFocus
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          minLength={MIN_PASSWORD_LENGTH}
          required
          hint={t('auth.common.minPasswordHint', { count: MIN_PASSWORD_LENGTH })}
        />
        <TextField
          label={t('auth.forcedPasswordChange.confirmPasswordLabel')}
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          minLength={MIN_PASSWORD_LENGTH}
          required
        />
        <Button type="submit" disabled={submitting}>
          {submitting
            ? t('auth.forcedPasswordChange.updating')
            : t('auth.forcedPasswordChange.submit')}
        </Button>
        <Button type="button" variant="ghost" onClick={() => void logout()} disabled={submitting}>
          {t('auth.common.signOut')}
        </Button>
      </form>
    </AuthCard>
  );
}
