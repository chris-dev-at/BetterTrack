import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { useQueryClient } from '@tanstack/react-query';

import { useT, type TranslateVars } from '../../../i18n';
import { Button, Field, Input, ODialog, Switch } from '../../../ui/origin';
import { EndpointKeystoreError } from '../keystore/errors';
import { endpointVaultKeystore } from '../keystore/runtime';
import { vaultStateActionHref } from '../vaultStateAffordance';
import { vaultRetryTimeLabel } from './retryTime';
import { VAULT_ENDPOINT_STATE_QUERY_PREFIX } from './useVaultEndpointState';

interface UnlockFailure {
  key: string;
  vars?: TranslateVars;
  /** A lockout is not a retry: the endpoint has withdrawn the password field. */
  withdrawn: boolean;
}

/**
 * The unlock, where the user already is (#4).
 *
 * The owner's acceptance oracle is one sentence — "i want to open the portfolio
 * and i get prompted for the password if not unlocked and then it unlocks the
 * portfolio ez" — and the shape that satisfies it is a prompt, not a journey.
 * Before this, the only affordance on a locked stub was an anchor into
 * `/control/privacy`, where the password field sat below three "isn't available
 * yet" paragraphs and success left the user standing in the Control Center.
 *
 * This dialog therefore does exactly one thing: take the device password and
 * unlock. It NEVER navigates. The page that hosts it re-resolves in place —
 * `unlock()` raises the keystore's vault-opened edge, and this closes by
 * invalidating the endpoint-state queries the surrounding surfaces read.
 *
 * The settings surface stays the SECONDARY path, reached from the fold below,
 * and remains the only place that owns the settings-sized flows: entering the
 * twelve words, scanning a QR, resetting this device's custody.
 *
 * FAILURES STAY IN HERE. The wrong-password ladder and the §12 lockout that
 * already exist in the keystore surface as an inline alert with the retry
 * instant — and a lockout withdraws the field, because inviting a password no
 * verification will look at is the thing the settings surface was fixed for
 * (#1526).
 */
export function VaultUnlockDialog({
  onClose,
  vaultId,
  vaultName,
  onUnlocked,
}: {
  onClose: () => void;
  vaultId: string;
  /** The vault's cleartext alias, when the caller has it. */
  vaultName?: string | undefined;
  /** Fired after the endpoint session exists, for surfaces that track it. */
  onUnlocked?: (() => void) | undefined;
}) {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [password, setPassword] = useState('');
  const [keepUnlocked, setKeepUnlocked] = useState(false);
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<UnlockFailure | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // The prompt must be typeable the instant it appears — that is the whole
  // difference from a settings page whose field sits below the fold. ODialog's
  // focus trap has already claimed the panel by the time this runs (child
  // effects commit before the parent's), so this is the last word on focus.
  //
  // The typed password needs no explicit teardown: this component is mounted
  // only while the dialog is open, so closing it destroys the state outright.
  useEffect(() => {
    if (failure?.withdrawn !== true) {
      formRef.current?.querySelector<HTMLInputElement>('input[type="password"]')?.focus();
    }
  }, [failure?.withdrawn]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (working || password.length === 0) return;
    setWorking(true);
    setFailure(null);
    try {
      await endpointVaultKeystore.unlock(password, { keepUnlockedOnThisDevice: keepUnlocked });
      setPassword('');
      // The surfaces that read endpoint state repaint from here; the store
      // resolver hears the keystore's own vault-opened edge. Neither needs a
      // route change, which is the whole point of this dialog.
      void queryClient.invalidateQueries({ queryKey: VAULT_ENDPOINT_STATE_QUERY_PREFIX });
      onUnlocked?.();
      onClose();
    } catch (cause) {
      setFailure(unlockFailure(cause));
    } finally {
      setWorking(false);
    }
  }

  const withdrawn = failure?.withdrawn === true;

  return (
    <ODialog
      foot={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button
            onClick={() => {
              onClose();
              navigate(vaultStateActionHref(vaultId, withdrawn ? 'reset-endpoint' : 'unlock'));
            }}
            size="sm"
            type="button"
            variant="quiet"
          >
            {t('vault.unlockDialog.moreOptions')}
          </Button>
          <div className="flex flex-wrap gap-2">
            <Button onClick={onClose} type="button" variant="quiet">
              {t('common.cancel')}
            </Button>
            {withdrawn ? null : (
              <Button
                disabled={working || password.length === 0}
                form={`vault-unlock-form-${vaultId}`}
                type="submit"
              >
                {working ? t('vault.unlock.unlocking') : t('vault.unlock.action')}
              </Button>
            )}
          </div>
        </div>
      }
      onClose={onClose}
      open
      title={
        vaultName
          ? t('vault.unlockDialog.titleNamed', { name: vaultName })
          : t('vault.unlockDialog.title')
      }
    >
      <form
        className="flex flex-col gap-4"
        id={`vault-unlock-form-${vaultId}`}
        onSubmit={(event) => void submit(event)}
        ref={formRef}
      >
        <p className="bt-soft text-sm">{t('vault.unlockDialog.body')}</p>
        {withdrawn ? null : (
          <>
            <Field
              htmlFor={`vault-unlock-password-${vaultId}`}
              label={t('vault.manager.access.devicePassword')}
            >
              <Input
                autoComplete="current-password"
                disabled={working}
                id={`vault-unlock-password-${vaultId}`}
                onChange={(event) => setPassword(event.target.value)}
                type="password"
                value={password}
              />
            </Field>
            {/* The legacy gate's checkbox, same wording and same promise: the
                device key it writes is revoked by a manual lock, a sign-out or
                the PIN idle lock, and by nothing else. */}
            <div className="flex items-start gap-3">
              <Switch
                aria-label={t('vault.unlock.keepUnlocked')}
                checked={keepUnlocked}
                disabled={working}
                id={`vault-unlock-keep-${vaultId}`}
                onChange={setKeepUnlocked}
              />
              <label className="bt-soft text-sm" htmlFor={`vault-unlock-keep-${vaultId}`}>
                {t('vault.unlock.keepUnlocked')}
                <span className="bt-muted mt-1 block text-xs">
                  {t('vault.unlock.keepUnlockedHint')}
                </span>
              </label>
            </div>
          </>
        )}
        {failure ? (
          <p className="bt-neg text-sm" role="alert">
            {t(failure.key, failure.vars)}
          </p>
        ) : null}
      </form>
    </ODialog>
  );
}

/**
 * One refusal, named. §12's lockout has a code AND a deadline and the QR sender
 * already says so; collapsing it into "that did not work" would invite the user
 * to retype a password no verification will look at.
 */
function unlockFailure(cause: unknown): UnlockFailure {
  if (!(cause instanceof EndpointKeystoreError)) {
    return { key: 'vault.manager.access.error', withdrawn: false };
  }
  switch (cause.code) {
    case 'wrong-password':
      return { key: 'vault.unlockDialog.wrongPassword', withdrawn: false };
    case 'locked-out':
      return cause.details.retryAt == null
        ? { key: 'vault.manager.access.error', withdrawn: true }
        : {
            key: 'vault.manager.access.lockedOut',
            vars: { time: vaultRetryTimeLabel(cause.details.retryAt) },
            withdrawn: true,
          };
    case 'device-password-invalid':
      return { key: 'vault.unlockDialog.wrongPassword', withdrawn: false };
    // The user asked this endpoint for a promise it cannot keep. Nothing was
    // unlocked (custody is checked before the KDF runs), so the honest answer
    // is to say so and let them retry without the option.
    case 'custody-failed':
    case 'custody-unavailable':
      return { key: 'vault.unlockDialog.custodyUnavailable', withdrawn: false };
    default:
      return { key: 'vault.manager.access.error', withdrawn: false };
  }
}
