import { useState } from 'react';

import { useT } from '../../i18n';
import { Wordmark } from '../../components/Wordmark';
import { useAuth } from '../AuthContext';
import { Alert, Button } from '../components/ui';
import { EmailEnrollForm, RecoveryCodesPanel, TotpEnrollForm } from '../components/twoFactor';

type WizardView = 'choose' | 'totp' | 'email' | 'recovery-codes';

/**
 * Forced two-factor enrollment wizard (§6.12, #400). A logged-in admin with no
 * confirmed 2FA method is trapped here above routing until one is set up: enroll
 * an authenticator app and/or a 2FA email. The first method confirmed hands back
 * recovery codes shown exactly once; acknowledging them re-resolves the session
 * and opens the console. Two-factor is mandatory — there is no skip.
 */
export function TwoFactorSetupPage() {
  const t = useT();
  const { completeTwoFactorSetup, logout } = useAuth();
  const [view, setView] = useState<WizardView>('choose');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [proceeding, setProceeding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A method just confirmed. The first method returns fresh recovery codes to show
  // once; a later one returns null, so proceed straight into the console.
  function onMethodEnrolled(codes: string[] | null) {
    if (codes && codes.length > 0) {
      setRecoveryCodes(codes);
      setView('recovery-codes');
    } else {
      void proceed();
    }
  }

  async function proceed() {
    setError(null);
    setProceeding(true);
    try {
      await completeTwoFactorSetup();
      // Success flips the AuthContext status to authenticated, so this unmounts.
    } catch {
      setError(t('admin.twoFactor.setup.finishError'));
      setProceeding(false);
    }
  }

  return (
    <div className="safe-pt-10 safe-pb-10 safe-px-4 grid min-h-screen place-items-center bg-neutral-950">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <Wordmark edition="Admin" className="text-2xl" />
        </div>
        <div className="flex flex-col gap-5 rounded-lg border border-neutral-800 bg-neutral-900 p-6">
          <div className="flex flex-col gap-1">
            <h1 className="text-lg font-semibold text-neutral-100">
              {t('admin.twoFactor.setup.title')}
            </h1>
            <p className="text-sm text-neutral-400">{t('admin.twoFactor.setup.intro')}</p>
          </div>

          {error ? <Alert tone="error">{error}</Alert> : null}

          {view === 'recovery-codes' && recoveryCodes ? (
            <RecoveryCodesPanel
              codes={recoveryCodes}
              onDone={() => {
                setRecoveryCodes(null);
                void proceed();
              }}
            />
          ) : view === 'totp' ? (
            <div className="flex flex-col gap-4 rounded-md border border-neutral-800 bg-neutral-950 p-4">
              <h2 className="text-sm font-semibold text-neutral-100">
                {t('admin.twoFactor.totp.cardTitle')}
              </h2>
              <TotpEnrollForm onEnrolled={onMethodEnrolled} onCancel={() => setView('choose')} />
            </div>
          ) : view === 'email' ? (
            <div className="flex flex-col gap-4 rounded-md border border-neutral-800 bg-neutral-950 p-4">
              <h2 className="text-sm font-semibold text-neutral-100">
                {t('admin.twoFactor.email.cardTitle')}
              </h2>
              <p className="text-xs text-neutral-500">
                {t('admin.twoFactor.email.cardDescription')}
              </p>
              <EmailEnrollForm
                requireProof={false}
                onEnrolled={onMethodEnrolled}
                onCancel={() => setView('choose')}
              />
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-neutral-400">{t('admin.twoFactor.setup.chooseMethod')}</p>
              <button
                type="button"
                disabled={proceeding}
                onClick={() => setView('totp')}
                className="flex flex-col gap-0.5 rounded-md border border-neutral-700 bg-neutral-950 px-4 py-3 text-left transition-colors hover:border-neutral-600 disabled:opacity-60"
              >
                <span className="text-sm font-medium text-neutral-100">
                  {t('admin.twoFactor.totp.cardTitle')}
                </span>
                <span className="text-xs text-neutral-500">
                  {t('admin.twoFactor.totp.cardDescription')}
                </span>
              </button>
              <button
                type="button"
                disabled={proceeding}
                onClick={() => setView('email')}
                className="flex flex-col gap-0.5 rounded-md border border-neutral-700 bg-neutral-950 px-4 py-3 text-left transition-colors hover:border-neutral-600 disabled:opacity-60"
              >
                <span className="text-sm font-medium text-neutral-100">
                  {t('admin.twoFactor.email.cardTitle')}
                </span>
                <span className="text-xs text-neutral-500">
                  {t('admin.twoFactor.email.cardDescription')}
                </span>
              </button>
            </div>
          )}

          <div className="border-t border-neutral-800 pt-4">
            <Button
              type="button"
              variant="ghost"
              onClick={() => void logout()}
              disabled={proceeding}
            >
              {t('admin.twoFactor.setup.signOut')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
