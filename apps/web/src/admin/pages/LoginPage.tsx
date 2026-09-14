import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';

import { Wordmark } from '../../components/Wordmark';
import { useT, type TranslateFn } from '../../i18n';
import * as api from '../../lib/adminApi';
import { ApiError } from '../../lib/apiClient';
import { NotAdminError, useAuth } from '../AuthContext';
import { Alert, Button, Spinner, TextField } from '../components/ui';

/**
 * The web bundle's own commit, baked in at build time (Vite `VITE_BUILD_SHA`).
 * Shortened to 7 chars; `"unknown"` in dev/test or an unstamped build.
 */
const WEB_SHA = (import.meta.env.VITE_BUILD_SHA ?? 'unknown').slice(0, 7);

function loginErrorMessage(t: TranslateFn, err: unknown): string {
  if (err instanceof NotAdminError) return t('auth.adminLogin.notAdmin');
  if (err instanceof ApiError) {
    if (err.status === 429) return t('auth.login.rateLimited');
    if (err.status === 403 && err.code === 'ACCOUNT_DISABLED') {
      return t('auth.login.accountDisabled');
    }
    if (err.status === 401 || err.code === 'INVALID_CREDENTIALS') {
      return t('auth.adminLogin.invalidCredentials');
    }
  }
  return t('auth.adminLogin.genericError');
}

/**
 * Admin sign-in. Its own minimal, app-shell-free screen (PROJECTPLAN.md §6.12).
 * Already-authenticated admins are bounced straight to the users page.
 */
export function LoginPage() {
  const t = useT();
  const { status, login, signedOutReason } = useAuth();
  const navigate = useNavigate();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // The live API commit, fetched from the public GET /api/v1/version. Rendered in
  // the footer only once it arrives; a failed fetch stays silent (marker is a
  // nice-to-have on this public page, never a blocker to signing in).
  const [apiSha, setApiSha] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const { shortCommit } = await api.getVersion(controller.signal);
        setApiSha(shortCommit);
      } catch {
        // Fail silent — no API marker segment when the version fetch fails.
      }
    })();
    return () => controller.abort();
  }, []);

  if (status === 'loading') {
    return (
      <main
        className="grid min-h-screen place-items-center bg-neutral-950"
        aria-labelledby="admin-login-heading"
      >
        <h1 id="admin-login-heading" className="sr-only">
          {t('auth.adminLogin.heading')}
        </h1>
        <Spinner label={t('auth.common.checkingSession')} />
      </main>
    );
  }
  if (status === 'authenticated') return <Navigate to="/admin/users" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login({ identifier, password });
      // A reset admin lands in the forced-change trap instead (status becomes
      // `password-change-required`); this navigation is a no-op for them.
      navigate('/admin/users', { replace: true });
    } catch (err) {
      setError(loginErrorMessage(t, err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main
      className="grid min-h-screen place-items-center bg-neutral-950 px-4"
      aria-labelledby="admin-login-heading"
    >
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <Wordmark edition="Admin" className="text-2xl" />
          <h1 id="admin-login-heading" className="sr-only">
            {t('auth.adminLogin.heading')}
          </h1>
        </div>
        <form
          onSubmit={onSubmit}
          className="flex flex-col gap-4 rounded-lg border border-neutral-800 bg-neutral-900 p-6"
        >
          {/* V5-P13c: the console signs itself out when the absolute admin
              window closes — say so here, rather than leaving the operator with
              a save that "failed". A credentials error from the attempt that
              follows replaces it. */}
          {!error && signedOutReason === 'expired' ? (
            <Alert tone="info">{t('auth.adminLogin.sessionExpired')}</Alert>
          ) : null}
          {error ? <Alert tone="error">{error}</Alert> : null}
          <TextField
            label={t('auth.login.identifierLabel')}
            name="identifier"
            autoComplete="username"
            autoFocus
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            required
          />
          <TextField
            label={t('auth.login.passwordLabel')}
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <Button type="submit" disabled={submitting}>
            {submitting ? t('auth.login.submitting') : t('auth.login.submit')}
          </Button>
        </form>
        {/* Deploy-verification marker: which web bundle + api commit is live. */}
        <p className="mt-6 text-center text-xs text-neutral-400">
          {apiSha ? `web ${WEB_SHA} · api ${apiSha}` : `web ${WEB_SHA}`}
        </p>
      </div>
    </main>
  );
}
