import { useState } from 'react';
import type { FormEvent } from 'react';

import { MIN_PASSWORD_LENGTH } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import { useAuth } from '../AuthContext';
import { type AttributedError, useFieldErrors } from '../components/fieldErrors';
import { Alert, AuthCard, Button, TextField } from '../components/ui';

/** The controls a forced-change failure can be attributed to. */
type ChangeField = 'newPassword' | 'confirmPassword';

/**
 * Friendly message for the codes `POST /auth/change-password` can return, with
 * the field that owns it: a policy rejection belongs to the new-password box,
 * an outage to the submission.
 */
function changeErrorMessage(t: TranslateFn, err: unknown): AttributedError<ChangeField> {
  if (err instanceof ApiError) {
    if (err.code === 'WEAK_PASSWORD') return { field: 'newPassword', message: err.message };
    if (err.status >= 500) return { field: null, message: t('common.genericError') };
  }
  return { field: null, message: t('auth.forcedPasswordChange.failed') };
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
  const { formRef, alertRef, fieldError, formError, fail, clear } = useFieldErrors<ChangeField>();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    clear();
    if (newPassword !== confirmPassword) {
      // The confirmation is the box that disagrees — the new password itself
      // may well be fine.
      fail('confirmPassword', t('auth.forcedPasswordChange.mismatch'));
      return;
    }
    setSubmitting(true);
    try {
      // Success rotates the session and releases the trap via the AuthContext.
      await changePassword({ newPassword });
    } catch (err) {
      const attributed = changeErrorMessage(t, err);
      fail(attributed.field, attributed.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthCard subtitle={t('auth.forcedPasswordChange.subtitle')}>
      <form onSubmit={onSubmit} className="flex flex-col gap-4" ref={formRef}>
        <Alert tone="info">
          {user
            ? t('auth.forcedPasswordChange.signedInAs', { email: user.email })
            : t('auth.forcedPasswordChange.infoNoUser')}
        </Alert>
        {formError ? (
          <div ref={alertRef} tabIndex={-1}>
            <Alert tone="error">{formError}</Alert>
          </div>
        ) : null}
        <TextField
          error={fieldError('newPassword')}
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
          error={fieldError('confirmPassword')}
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
