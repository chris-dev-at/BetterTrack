import { useState, type FormEvent } from 'react';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';

import type { DeleteAccountRequest } from '@bettertrack/contracts';

import { Wordmark } from '../../components/Wordmark';
import { useT, type TranslateFn } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import { getTwoFactorStatus } from '../../lib/twoFactorApi';
import { deleteAccount } from '../../lib/userApi';
import { useAuth } from '../AuthContext';
import { Alert, Button, TextField } from '../components/ui';

/** Friendly messages for the codes `DELETE /account` can return. */
function deleteErrorMessage(t: TranslateFn, err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'CONFIRMATION_MISMATCH') return t('deleteAccount.error.confirmMismatch');
    if (err.code === 'INVALID_CREDENTIALS') return t('deleteAccount.error.wrongPassword');
    if (err.code === 'TWO_FACTOR_INVALID_CODE') return t('deleteAccount.error.wrongCode');
    if (err.status === 429) return t('deleteAccount.error.tooMany');
  }
  return t('common.genericError');
}

/**
 * `/account/delete` — self-service account deletion (PROJECTPLAN.md §13.4
 * V4-P2c, #362). This is the STABLE PUBLIC DELETION URL the Google Play listing
 * points at: an anonymous visit bounces through /login and lands back here; a
 * signed-in user gets the full flow. Server-side gates mirror the form: typed
 * username confirmation + re-auth (current password, or a fresh authenticator
 * code for a 2FA-enrolled account). Deletion is irreversible — the strong
 * warning spells out exactly what is removed.
 */
export function DeleteAccountPage() {
  const t = useT();
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  const [confirmUsername, setConfirmUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [useCode, setUseCode] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only a TOTP-enrolled account can re-auth with a code instead of a password.
  const twoFactor = useQuery({
    queryKey: ['auth', '2fa', 'status'],
    queryFn: ({ signal }) => getTwoFactorStatus(signal),
    staleTime: 30_000,
  });
  const codeAvailable = twoFactor.data?.totpEnabled === true;

  const mutation = useMutation({
    mutationFn: (body: DeleteAccountRequest) => deleteAccount(body),
    onSuccess: async () => {
      // The server already revoked every session — reset local auth state (the
      // logout call itself just 401s harmlessly) and land on the login screen.
      await logout();
      navigate('/login', { replace: true });
    },
    onError: (err) => setError(deleteErrorMessage(t, err)),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (user && confirmUsername.trim().toLowerCase() !== user.username.toLowerCase()) {
      setError(t('deleteAccount.error.confirmMismatch'));
      return;
    }
    mutation.mutate(
      useCode && codeAvailable
        ? { confirmUsername: confirmUsername.trim(), code: code.trim() }
        : { confirmUsername: confirmUsername.trim(), password },
    );
  }

  return (
    <div className="min-h-screen bg-[#0b0e14] px-4 pb-12 pt-[10vh] sm:pt-[14vh]">
      <div className="mx-auto w-full max-w-md">
        <div className="mb-8 text-center">
          <Wordmark edition="Web" className="text-2xl" />
        </div>

        <div className="flex flex-col gap-5 rounded-xl border border-red-900/60 bg-neutral-900 p-6">
          <div className="flex flex-col gap-1">
            <h1 className="text-lg font-semibold text-red-400">{t('deleteAccount.title')}</h1>
            <p className="text-sm text-neutral-400">{t('deleteAccount.subtitle')}</p>
          </div>

          <Alert tone="error">
            <span className="font-semibold">{t('deleteAccount.warning.headline')}</span>
            <ul className="mt-2 list-disc pl-5 text-sm">
              <li>{t('deleteAccount.warning.data')}</li>
              <li>{t('deleteAccount.warning.social')}</li>
              <li>{t('deleteAccount.warning.access')}</li>
              <li>{t('deleteAccount.warning.chat')}</li>
            </ul>
          </Alert>

          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <TextField
              label={t('deleteAccount.confirmLabel', { username: user?.username ?? '' })}
              name="confirmUsername"
              autoComplete="off"
              value={confirmUsername}
              onChange={(e) => setConfirmUsername(e.target.value)}
              required
            />

            {useCode && codeAvailable ? (
              <TextField
                label={t('deleteAccount.codeLabel')}
                name="code"
                autoComplete="one-time-code"
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
              />
            ) : (
              <TextField
                label={t('deleteAccount.passwordLabel')}
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            )}

            {codeAvailable ? (
              <button
                type="button"
                onClick={() => setUseCode((v) => !v)}
                className="w-fit text-xs font-medium text-sky-400 hover:text-sky-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
              >
                {useCode ? t('deleteAccount.usePassword') : t('deleteAccount.useCode')}
              </button>
            ) : null}

            {error ? <Alert tone="error">{error}</Alert> : null}

            <div className="flex items-center gap-3">
              <Button
                type="submit"
                variant="secondary"
                className="text-red-300 ring-red-900 hover:bg-red-950"
                disabled={mutation.isPending}
              >
                {mutation.isPending ? t('deleteAccount.submitting') : t('deleteAccount.submit')}
              </Button>
              <Link
                to="/settings/account"
                className="text-sm font-medium text-neutral-400 hover:text-neutral-200"
              >
                {t('common.cancel')}
              </Link>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
