import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

import { useT } from '../../i18n';
import * as api from '../../lib/adminApi';
import { useResource } from '../useResource';
import { Alert, Button, PageHeader, Spinner, TextField } from '../components/ui';
import {
  EmailEnrollForm,
  RecoveryCodesPanel,
  TotpEnrollForm,
  twoFactorErrorMessage,
} from '../components/twoFactor';

/** Shared shell for a single 2FA method row. */
function MethodCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-neutral-800 bg-neutral-900 p-5">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold text-neutral-100">{title}</h3>
        <p className="text-xs text-neutral-500">{description}</p>
      </div>
      {children}
    </div>
  );
}

/** Code-entry form authorizing a TOTP disable (the first half of a re-enroll). */
function TotpDisableForm({
  onDisabled,
  onCancel,
}: {
  onDisabled: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.disableTotp({ code: code.trim() });
      onDisabled();
    } catch (err) {
      setError(twoFactorErrorMessage(t, err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <p className="text-sm text-neutral-400">{t('admin.twoFactor.totp.disableToReenroll')}</p>
      <TextField
        label={t('admin.twoFactor.totp.disableCodeLabel')}
        name="totp-disable-code"
        autoComplete="one-time-code"
        autoFocus
        value={code}
        onChange={(e) => setCode(e.target.value)}
      />
      <div className="flex flex-wrap gap-3">
        <Button type="submit" variant="secondary" disabled={submitting || code.trim().length < 6}>
          {submitting
            ? t('admin.twoFactor.totp.confirming')
            : t('admin.twoFactor.totp.disableAndContinue')}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

type TotpView = 'status' | 'disabling' | 'enrolling';

/** Authenticator-app (TOTP) method: enroll, or re-enroll (disable-then-enroll). */
function TotpMethodCard({
  enabled,
  onFirstRecoveryCodes,
  reload,
}: {
  enabled: boolean;
  onFirstRecoveryCodes: (codes: string[]) => void;
  reload: () => void;
}) {
  const t = useT();
  const [view, setView] = useState<TotpView>('status');
  const [notice, setNotice] = useState<string | null>(null);

  function afterEnroll(codes: string[] | null) {
    setView('status');
    if (codes) onFirstRecoveryCodes(codes);
    else setNotice(t('admin.twoFactor.totp.enabledNotice'));
    reload();
  }

  return (
    <MethodCard
      title={t('admin.twoFactor.totp.cardTitle')}
      description={t('admin.twoFactor.totp.cardDescription')}
    >
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {view === 'enrolling' ? (
        <TotpEnrollForm onEnrolled={afterEnroll} onCancel={() => setView('status')} />
      ) : view === 'disabling' ? (
        // Re-enroll: disable with a current code, then immediately start a fresh
        // enroll so the account never sits without the authenticator on purpose.
        <TotpDisableForm
          onDisabled={() => setView('enrolling')}
          onCancel={() => setView('status')}
        />
      ) : enabled ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-neutral-400">{t('admin.twoFactor.totp.enabledLabel')}</p>
          <div>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setNotice(null);
                setView('disabling');
              }}
            >
              {t('admin.twoFactor.totp.reenroll')}
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button
            type="button"
            onClick={() => {
              setNotice(null);
              setView('enrolling');
            }}
          >
            {t('admin.twoFactor.totp.setup')}
          </Button>
        </div>
      )}
    </MethodCard>
  );
}

type EmailView = 'status' | 'editing';

/** Email-code method: set/change the 2FA email (a change needs a fresh proof), or turn it off. */
function EmailMethodCard({
  enabled,
  twoFactorEmail,
  totpEnabled,
  onFirstRecoveryCodes,
  reload,
}: {
  enabled: boolean;
  twoFactorEmail: string | null;
  totpEnabled: boolean;
  onFirstRecoveryCodes: (codes: string[]) => void;
  reload: () => void;
}) {
  const t = useT();
  const [view, setView] = useState<EmailView>('status');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [disabling, setDisabling] = useState(false);

  function afterEnroll(codes: string[] | null) {
    setView('status');
    if (codes) onFirstRecoveryCodes(codes);
    else setNotice(t('admin.twoFactor.email.enabledNotice'));
    reload();
  }

  async function onDisable() {
    setError(null);
    setNotice(null);
    setDisabling(true);
    try {
      await api.disableEmailTwoFactor();
      setNotice(t('admin.twoFactor.email.disabledNotice'));
      reload();
    } catch (err) {
      setError(twoFactorErrorMessage(t, err));
    } finally {
      setDisabling(false);
    }
  }

  return (
    <MethodCard
      title={t('admin.twoFactor.email.cardTitle')}
      description={t('admin.twoFactor.email.cardDescription')}
    >
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      <p className="text-sm text-neutral-400">
        {twoFactorEmail
          ? t('admin.twoFactor.email.currentEmail', { email: twoFactorEmail })
          : t('admin.twoFactor.email.noEmail')}
      </p>
      {view === 'editing' ? (
        // Reaching this page means the admin is enrolled (≥1 method is mandatory),
        // so setting or changing the 2FA email always requires a fresh proof (#400).
        <EmailEnrollForm
          requireProof
          initialEmail={twoFactorEmail}
          onEnrolled={afterEnroll}
          onCancel={() => setView('status')}
        />
      ) : (
        <div className="flex flex-wrap gap-3">
          <Button
            type="button"
            variant={enabled ? 'secondary' : 'primary'}
            onClick={() => {
              setNotice(null);
              setError(null);
              setView('editing');
            }}
          >
            {enabled ? t('admin.twoFactor.email.change') : t('admin.twoFactor.email.setup')}
          </Button>
          {/* Only offer turn-off while the authenticator is on, so the UI can never
              drop the admin below the mandatory one method (they'd re-enter the
              wizard). Removing the last method is a break-glass operation. */}
          {enabled && totpEnabled ? (
            <Button
              type="button"
              variant="ghost"
              disabled={disabling}
              onClick={() => void onDisable()}
            >
              {disabling
                ? t('admin.twoFactor.email.turningOff')
                : t('admin.twoFactor.email.turnOff')}
            </Button>
          ) : null}
        </div>
      )}
    </MethodCard>
  );
}

/** Recovery-code control: shows remaining count and regenerates (shown once). */
function RecoveryCodesControl({
  remaining,
  onRegenerated,
}: {
  remaining: number;
  onRegenerated: (codes: string[]) => void;
}) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);

  async function onRegenerate() {
    setError(null);
    setRegenerating(true);
    try {
      const { recoveryCodes } = await api.regenerateRecoveryCodes();
      onRegenerated(recoveryCodes);
    } catch {
      setError(t('admin.twoFactor.recoveryCodes.regenerateError'));
    } finally {
      setRegenerating(false);
    }
  }

  return (
    <MethodCard
      title={t('admin.twoFactor.recoveryCodes.cardTitle')}
      description={t('admin.twoFactor.recoveryCodes.cardDescription')}
    >
      <p className="text-sm text-neutral-400">
        {t(
          remaining === 1
            ? 'admin.twoFactor.recoveryCodes.remainingOne'
            : 'admin.twoFactor.recoveryCodes.remainingOther',
          { count: remaining },
        )}
      </p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div>
        <Button
          type="button"
          variant="secondary"
          disabled={regenerating}
          onClick={() => void onRegenerate()}
        >
          {regenerating
            ? t('admin.twoFactor.recoveryCodes.regenerating')
            : t('admin.twoFactor.recoveryCodes.regenerate')}
        </Button>
      </div>
    </MethodCard>
  );
}

/**
 * Admin Security settings (§6.12, #400). Shows the mandatory 2FA status and lets
 * the admin manage the authenticator method (re-enroll), the 2FA email (set/change
 * with a fresh proof), and recovery codes (regenerate, shown once). Driven by
 * `GET /admin/security/2fa/status`, which is exempt from the setup gate.
 */
export function SecuritySettingsPage() {
  const t = useT();
  const status = useResource((signal) => api.getTwoFactorStatus(signal), []);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('admin.security.title')} description={t('admin.security.subtitle')} />

      {recoveryCodes ? (
        <RecoveryCodesPanel
          codes={recoveryCodes}
          onDone={() => {
            setRecoveryCodes(null);
            status.reload();
          }}
        />
      ) : status.loading ? (
        <Spinner label={t('common.loading')} />
      ) : status.error || !status.data ? (
        <Alert tone="error">
          {status.error ?? t('admin.security.loadError')}{' '}
          <button className="underline" onClick={status.reload}>
            {t('common.retry')}
          </button>
        </Alert>
      ) : (
        <>
          <Alert tone="info">{t('admin.security.statusDescription')}</Alert>
          <TotpMethodCard
            enabled={status.data.totpEnabled}
            onFirstRecoveryCodes={setRecoveryCodes}
            reload={status.reload}
          />
          <EmailMethodCard
            enabled={status.data.emailEnabled}
            twoFactorEmail={status.data.twoFactorEmail}
            totpEnabled={status.data.totpEnabled}
            onFirstRecoveryCodes={setRecoveryCodes}
            reload={status.reload}
          />
          <RecoveryCodesControl
            remaining={status.data.recoveryCodesRemaining}
            onRegenerated={setRecoveryCodes}
          />
        </>
      )}
    </div>
  );
}
