import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';

import {
  DEFAULT_PIN_WINDOW_MINUTES,
  MIN_PASSWORD_LENGTH,
  PASSKEY_NAME_MAX,
  PIN_LENGTH,
  TOTP_CODE_LENGTH,
  type ChangePasswordRequest,
  type Passkey,
  type SetPinRequest,
  type TwoFactorStatusResponse,
} from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import type { TranslateFn } from '../../../i18n';
import { ApiError } from '../../../lib/apiClient';
import { formatDateTime } from '../../../lib/format';
import {
  browserSupportsWebAuthn,
  isPasskeyCancellation,
  registerPasskey,
} from '../../../lib/passkeys';
import {
  confirmEmailTwoFactor,
  confirmTwoFactor,
  disableEmailTwoFactor,
  disableTwoFactor,
  enrollEmailTwoFactor,
  enrollTwoFactor,
  getTwoFactorStatus,
  regenerateRecoveryCodes,
} from '../../../lib/twoFactorApi';
import {
  changePassword,
  deletePasskey,
  disablePin,
  getMe,
  listPasskeys,
  renamePasskey,
  setPin,
  setPinLockIdleMinutes,
} from '../../../lib/userApi';
import { Skeleton } from '../../../ui';
import { Button, Field, Input, Select } from '../../../ui/origin';
import { type AttributedError, useFieldErrors } from '../../components/fieldErrors';
import { PinInput } from '../../components/PinInput';
import { Alert } from '../../components/ui';
import {
  PanelFold,
  PanelForm,
  PanelGroup,
  PanelHead,
  PanelList,
  PanelListItem,
  PanelNote,
  Row,
} from './panelKit';

const ME_KEY = ['auth', 'me'] as const;
const TWO_FACTOR_KEY = ['auth', '2fa', 'status'] as const;
const PASSKEYS_KEY = ['auth', 'passkeys'] as const;

/** The controls a change-password failure can be attributed to. */
type PasswordField = 'currentPassword' | 'newPassword' | 'confirmPassword';

/**
 * Friendly message for the codes `POST /auth/change-password` can return, with
 * the field that owns it (FRONTEND-09): a rejected credential is about the
 * current-password box, a policy rejection about the new one, an outage about
 * the submission.
 */
function changeErrorMessage(t: TranslateFn, err: unknown): AttributedError<PasswordField> {
  if (err instanceof ApiError) {
    if (err.code === 'INVALID_CREDENTIALS') {
      return { field: 'currentPassword', message: t('settings.password.currentWrong') };
    }
    if (err.code === 'WEAK_PASSWORD') return { field: 'newPassword', message: err.message };
    if (err.status >= 500) return { field: null, message: t('common.genericError') };
  }
  return { field: null, message: t('settings.password.changeFailed') };
}

/**
 * Change password (§6.11). Moved here from the Account panel: a password is a
 * credential, not an identity field. Success rotates the session server-side, so
 * the identity is refetched.
 */
function ChangePasswordGroup() {
  const t = useT();
  const queryClient = useQueryClient();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const { formRef, alertRef, fieldError, formError, fail, clear } = useFieldErrors<PasswordField>();
  const [done, setDone] = useState(false);

  const mutation = useMutation({
    mutationFn: (body: ChangePasswordRequest) => changePassword(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ME_KEY });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setDone(true);
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    clear();
    setDone(false);
    if (newPassword !== confirmPassword) {
      // The confirmation is the box that disagrees — the new password may be fine.
      fail('confirmPassword', t('settings.password.mismatch'));
      return;
    }
    mutation.mutate(
      { currentPassword, newPassword },
      {
        onError: (err) => {
          const attributed = changeErrorMessage(t, err);
          fail(attributed.field, attributed.message);
        },
      },
    );
  }

  return (
    <PanelGroup label={t('settings.password.title')}>
      <Row stack>
        {formError ? (
          <div ref={alertRef} tabIndex={-1}>
            <Alert tone="error">{formError}</Alert>
          </div>
        ) : null}
        {done ? <Alert tone="success">{t('settings.password.success')}</Alert> : null}
        <PanelForm formRef={formRef} onSubmit={onSubmit}>
          <Field
            error={fieldError('currentPassword')}
            htmlFor="currentPassword"
            label={t('settings.password.current')}
          >
            <Input
              autoComplete="current-password"
              id="currentPassword"
              name="currentPassword"
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
              type="password"
              value={currentPassword}
            />
          </Field>
          <Field
            error={fieldError('newPassword')}
            hint={t('settings.password.hint', { count: MIN_PASSWORD_LENGTH })}
            htmlFor="newPassword"
            label={t('settings.password.new')}
          >
            <Input
              autoComplete="new-password"
              id="newPassword"
              minLength={MIN_PASSWORD_LENGTH}
              name="newPassword"
              onChange={(e) => setNewPassword(e.target.value)}
              required
              type="password"
              value={newPassword}
            />
          </Field>
          <Field
            error={fieldError('confirmPassword')}
            htmlFor="confirmPassword"
            label={t('settings.password.confirm')}
          >
            <Input
              autoComplete="new-password"
              id="confirmPassword"
              minLength={MIN_PASSWORD_LENGTH}
              name="confirmPassword"
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              type="password"
              value={confirmPassword}
            />
          </Field>
          {/* The panel's single primary action; every other block stays quiet. */}
          <Button
            className="self-start"
            disabled={mutation.isPending}
            size="sm"
            type="submit"
            variant="primary"
          >
            {mutation.isPending ? t('settings.password.submitting') : t('settings.password.submit')}
          </Button>
        </PanelForm>
      </Row>
    </PanelGroup>
  );
}

function twoFactorErrorMessage(t: TranslateFn, err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status < 500) return err.message;
  }
  return t('common.genericError');
}

/** Recovery codes, shown exactly once after the first method is enabled or a regenerate. */
function RecoveryCodesReveal({ codes, onDone }: { codes: readonly string[]; onDone: () => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  function handleDownload() {
    try {
      const blob = new Blob([codes.join('\n') + '\n'], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'bettertrack-recovery-codes.txt';
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      // Download is a convenience affordance; copy still works if it's unavailable.
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Show-once: this is the only time these codes exist in the clear. */}
      <PanelNote warn>{t('settings.security.twoFactor.recoveryCodes.saveNotice')}</PanelNote>
      <div className="bt-cc-mono bt-num grid grid-cols-2 gap-1.5 sm:grid-cols-3">
        {codes.map((code) => (
          <span key={code}>{code}</span>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={handleCopy} size="sm" type="button">
          {copied
            ? t('settings.security.twoFactor.recoveryCodes.copied')
            : t('settings.security.twoFactor.recoveryCodes.copy')}
        </Button>
        <Button onClick={handleDownload} size="sm" type="button">
          {t('settings.security.twoFactor.recoveryCodes.download')}
        </Button>
        <Button onClick={onDone} size="sm" type="button" variant="quiet">
          {t('settings.security.twoFactor.recoveryCodes.done')}
        </Button>
      </div>
    </div>
  );
}

/** TOTP enroll wizard: scan the QR (or enter the key), then confirm a live code. */
function EnrollWizard({
  onEnrolled,
  onCancel,
}: {
  onEnrolled: (recoveryCodes: string[] | null) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [code, setCode] = useState('');
  // A rejected confirmation code belongs to the code boxes; a failed enrollment
  // start belongs to the step (there is no form to blame yet).
  const { formRef, alertRef, fieldError, formError, fail, clear } = useFieldErrors<'code'>();

  const enroll = useMutation({
    mutationFn: enrollTwoFactor,
    onError: () => fail(null, t('settings.security.twoFactor.totp.enrollError')),
  });
  const enrollStart = enroll.mutate;

  // Kick off enrollment once, when the wizard first mounts.
  useEffect(() => {
    enrollStart();
  }, [enrollStart]);

  const confirm = useMutation({
    mutationFn: () => confirmTwoFactor({ code }),
    onSuccess: (data) => onEnrolled(data.recoveryCodes),
    onError: (err) => fail('code', twoFactorErrorMessage(t, err)),
  });

  if (!enroll.data) {
    // No form to blame yet — but the alert still has to be reachable, so it
    // carries `alertRef` here too and the failure effect lands on it.
    return enroll.isError ? (
      <div ref={alertRef} tabIndex={-1}>
        <Alert tone="error">{formError}</Alert>
      </div>
    ) : (
      <Skeleton height="h-16" />
    );
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    clear();
    confirm.mutate();
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={onSubmit} ref={formRef}>
      {formError ? (
        <div ref={alertRef} tabIndex={-1}>
          <Alert tone="error">{formError}</Alert>
        </div>
      ) : null}
      <PanelNote>{t('settings.security.twoFactor.totp.scanInstructions')}</PanelNote>
      {/* QR needs a light quiet-zone to scan reliably against the dark theme. */}
      <div className="self-start rounded bg-white" style={{ padding: 10 }}>
        <QRCodeSVG
          aria-label={t('settings.security.twoFactor.totp.qrAriaLabel')}
          marginSize={0}
          size={132}
          value={enroll.data.otpauthUri}
        />
      </div>
      <PanelFold summary={t('settings.security.twoFactor.totp.manualEntryToggle')}>
        <div className="flex flex-col gap-1">
          <span className="bt-label">{t('settings.security.twoFactor.totp.setupKeyLabel')}</span>
          <code className="bt-cc-mono bt-num">{enroll.data.secret}</code>
          <span className="bt-label" style={{ marginTop: 6 }}>
            {t('settings.security.twoFactor.totp.otpauthUriLabel')}
          </span>
          <code className="bt-cc-mono">{enroll.data.otpauthUri}</code>
        </div>
      </PanelFold>
      <PinInput
        autoFocus
        error={fieldError('code')}
        hint={t('settings.security.twoFactor.totp.confirmationCodeHint')}
        label={t('settings.security.twoFactor.totp.confirmationCodeLabel')}
        length={TOTP_CODE_LENGTH}
        onChange={setCode}
        value={code}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={confirm.isPending || code.length !== TOTP_CODE_LENGTH}
          size="sm"
          type="submit"
        >
          {confirm.isPending
            ? t('settings.security.twoFactor.confirming')
            : t('settings.security.twoFactor.confirmAndEnable')}
        </Button>
        <Button onClick={onCancel} size="sm" type="button" variant="quiet">
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

/** Inline code-entry form used to authorize disabling the authenticator method. */
function DisableForm({ onDisabled, onCancel }: { onDisabled: () => void; onCancel: () => void }) {
  const t = useT();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const disable = useMutation({
    mutationFn: () => disableTwoFactor({ code }),
    onSuccess: onDisabled,
    onError: (err) => setError(twoFactorErrorMessage(t, err)),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    disable.mutate();
  }

  return (
    <PanelForm onSubmit={onSubmit}>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {/* Explicit `for`/`id`: the popup's Field renders a sibling label, so an
          implicit (nested) association would not exist. */}
      <Field
        htmlFor="totp-disable-code"
        label={t('settings.security.twoFactor.totp.disableCodeLabel')}
      >
        <Input
          autoComplete="off"
          id="totp-disable-code"
          onChange={(e) => setCode(e.target.value)}
          type="text"
          value={code}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={disable.isPending || code.length < 6}
          size="sm"
          type="submit"
          variant="danger"
        >
          {disable.isPending
            ? t('settings.security.pin.disabling')
            : t('settings.security.twoFactor.totp.turnOffFull')}
        </Button>
        <Button onClick={onCancel} size="sm" type="button" variant="quiet">
          {t('common.cancel')}
        </Button>
      </div>
    </PanelForm>
  );
}

type AuthenticatorView = 'status' | 'enrolling' | 'disabling';

/** Authenticator-app (TOTP) method (§6.1, #298). */
function AuthenticatorRow({
  enabled,
  onFirstRecoveryCodes,
  refresh,
}: {
  enabled: boolean;
  onFirstRecoveryCodes: (codes: string[]) => void;
  refresh: () => void;
}) {
  const t = useT();
  const [view, setView] = useState<AuthenticatorView>('status');
  const [notice, setNotice] = useState<string | null>(null);

  const busy = view !== 'status';

  return (
    <Row
      hint={t('settings.security.twoFactor.totp.cardDescription')}
      label={t('settings.security.twoFactor.totp.cardTitle')}
      stack={busy}
    >
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {view === 'enrolling' ? (
        <EnrollWizard
          onCancel={() => setView('status')}
          onEnrolled={(codes) => {
            setView('status');
            if (codes) onFirstRecoveryCodes(codes);
            else setNotice(t('settings.security.twoFactor.totp.enabledNotice'));
            refresh();
          }}
        />
      ) : view === 'disabling' ? (
        <DisableForm
          onCancel={() => setView('status')}
          onDisabled={() => {
            setView('status');
            setNotice(t('settings.security.twoFactor.totp.disabledNotice'));
            refresh();
          }}
        />
      ) : !enabled ? (
        <Button
          onClick={() => {
            setNotice(null);
            setView('enrolling');
          }}
          size="sm"
          type="button"
        >
          {t('settings.security.twoFactor.totp.setup')}
        </Button>
      ) : (
        <>
          <span className="bt-pos" style={{ fontSize: 12.5 }}>
            {t('settings.security.twoFactor.enabledLabel')}
          </span>
          <Button
            onClick={() => {
              setNotice(null);
              setView('disabling');
            }}
            size="sm"
            type="button"
            variant="danger"
          >
            {t('settings.security.twoFactor.turnOff')}
          </Button>
        </>
      )}
    </Row>
  );
}

type EmailMethodView = 'status' | 'confirming';

/** Email-code method (§6.1, #298): prove mailbox access, then a code at each sign-in. */
function EmailMethodRow({
  enabled,
  onFirstRecoveryCodes,
  refresh,
}: {
  enabled: boolean;
  onFirstRecoveryCodes: (codes: string[]) => void;
  refresh: () => void;
}) {
  const t = useT();
  const [view, setView] = useState<EmailMethodView>('status');
  const [code, setCode] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const enroll = useMutation({
    mutationFn: enrollEmailTwoFactor,
    onSuccess: () => {
      setError(null);
      setView('confirming');
    },
    // A missing SMTP config surfaces as a clear TWO_FACTOR_EMAIL_UNAVAILABLE message.
    onError: (err) => setError(twoFactorErrorMessage(t, err)),
  });

  const confirm = useMutation({
    mutationFn: () => confirmEmailTwoFactor({ code }),
    onSuccess: (data) => {
      setView('status');
      setCode('');
      if (data.recoveryCodes) onFirstRecoveryCodes(data.recoveryCodes);
      else setNotice(t('settings.security.twoFactor.email.enabledNotice'));
      refresh();
    },
    onError: (err) => setError(twoFactorErrorMessage(t, err)),
  });

  const disable = useMutation({
    mutationFn: disableEmailTwoFactor,
    onSuccess: () => {
      setNotice(t('settings.security.twoFactor.email.disabledNotice'));
      setError(null);
      refresh();
    },
    onError: (err) => setError(twoFactorErrorMessage(t, err)),
  });

  function onConfirm(e: FormEvent) {
    e.preventDefault();
    setError(null);
    confirm.mutate();
  }

  return (
    <Row
      hint={t('settings.security.twoFactor.email.cardDescription')}
      label={t('settings.security.twoFactor.email.cardTitle')}
      stack={view === 'confirming'}
    >
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      {enabled ? (
        <>
          <span className="bt-pos" style={{ fontSize: 12.5 }}>
            {t('settings.security.twoFactor.enabledLabel')}
          </span>
          <Button
            disabled={disable.isPending}
            onClick={() => {
              setNotice(null);
              disable.mutate();
            }}
            size="sm"
            type="button"
            variant="danger"
          >
            {disable.isPending
              ? t('settings.security.twoFactor.turningOff')
              : t('settings.security.twoFactor.turnOff')}
          </Button>
        </>
      ) : view === 'confirming' ? (
        <form className="flex flex-col gap-3" onSubmit={onConfirm}>
          <PanelNote>{t('settings.security.twoFactor.email.confirmInstructions')}</PanelNote>
          <PinInput
            autoFocus
            hint={t('settings.security.twoFactor.email.codeHint')}
            label={t('settings.security.twoFactor.email.codeLabel')}
            length={TOTP_CODE_LENGTH}
            onChange={setCode}
            value={code}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={confirm.isPending || code.length !== TOTP_CODE_LENGTH}
              size="sm"
              type="submit"
            >
              {confirm.isPending
                ? t('settings.security.twoFactor.confirming')
                : t('settings.security.twoFactor.confirmAndEnable')}
            </Button>
            <Button
              onClick={() => {
                setView('status');
                setCode('');
                setError(null);
              }}
              size="sm"
              type="button"
              variant="quiet"
            >
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      ) : (
        <Button
          disabled={enroll.isPending}
          onClick={() => {
            setNotice(null);
            enroll.mutate();
          }}
          size="sm"
          type="button"
        >
          {enroll.isPending
            ? t('settings.security.twoFactor.email.sendingCode')
            : t('settings.security.twoFactor.email.setup')}
        </Button>
      )}
    </Row>
  );
}

/** Shared recovery-code row, shown while any method is on. */
function RecoveryCodesRow({
  remaining,
  onRegenerated,
}: {
  remaining: number;
  onRegenerated: (codes: string[]) => void;
}) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const regenerate = useMutation({
    mutationFn: regenerateRecoveryCodes,
    onSuccess: (data) => {
      setError(null);
      onRegenerated(data.recoveryCodes);
    },
    onError: () => setError(t('settings.security.twoFactor.recoveryCodes.regenerateError')),
  });

  return (
    <Row
      hint={t(
        remaining === 1
          ? 'settings.security.twoFactor.recoveryCodes.remainingOne'
          : 'settings.security.twoFactor.recoveryCodes.remainingOther',
        { count: remaining },
      )}
      label={t('settings.security.twoFactor.recoveryCodes.cardTitle')}
    >
      {error ? <span className="bt-field__error">{error}</span> : null}
      <Button
        disabled={regenerate.isPending}
        onClick={() => regenerate.mutate()}
        size="sm"
        type="button"
      >
        {regenerate.isPending
          ? t('settings.security.twoFactor.recoveryCodes.regenerating')
          : t('settings.security.twoFactor.recoveryCodes.regenerate')}
      </Button>
    </Row>
  );
}

/**
 * Two-factor authentication (PROJECTPLAN.md §6.1, §13.2 V2-P5, #298): two
 * independently-toggleable methods (authenticator app + email codes) with shared
 * recovery codes, driven by `GET /auth/2fa/status`. Recovery codes are shown once
 * when the first method is enabled (or on regenerate).
 */
function TwoFactorGroup() {
  const t = useT();
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: TWO_FACTOR_KEY,
    queryFn: ({ signal }) => getTwoFactorStatus(signal),
    staleTime: 10_000,
  });

  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: TWO_FACTOR_KEY });
  }

  const anyEnabled = (s: TwoFactorStatusResponse) => s.totpEnabled || s.emailEnabled;

  return (
    <PanelGroup label={t('settings.security.twoFactor.title')}>
      {recoveryCodes ? (
        <Row stack>
          <RecoveryCodesReveal
            codes={recoveryCodes}
            onDone={() => {
              setRecoveryCodes(null);
              refresh();
            }}
          />
        </Row>
      ) : status.isPending ? (
        <Row>
          <Skeleton height="h-10" />
        </Row>
      ) : status.isError ? (
        <Row stack>
          <PanelNote>{t('settings.security.twoFactor.loadError.title')}</PanelNote>
        </Row>
      ) : (
        <>
          <AuthenticatorRow
            enabled={status.data.totpEnabled}
            onFirstRecoveryCodes={setRecoveryCodes}
            refresh={refresh}
          />
          <EmailMethodRow
            enabled={status.data.emailEnabled}
            onFirstRecoveryCodes={setRecoveryCodes}
            refresh={refresh}
          />
          {anyEnabled(status.data) ? (
            <RecoveryCodesRow
              onRegenerated={setRecoveryCodes}
              remaining={status.data.recoveryCodesRemaining}
            />
          ) : null}
        </>
      )}
    </PanelGroup>
  );
}

/** Map a passkey add/manage failure to a localized message. */
function passkeyErrorMessage(t: TranslateFn, err: unknown): string {
  if (isPasskeyCancellation(err)) return t('settings.security.passkeys.cancelled');
  if (err instanceof ApiError) {
    if (err.status === 429) return t('settings.security.passkeys.rateLimited');
    if (err.code === 'PASSKEY_ALREADY_REGISTERED')
      return t('settings.security.passkeys.alreadyRegistered');
    if (err.status === 401) return t('settings.security.passkeys.wrongPassword');
    if (err.status >= 500) return t('common.genericError');
  }
  return t('settings.security.passkeys.genericError');
}

/** Add-a-passkey form: name + password re-auth, then the authenticator prompt. */
function AddPasskeyForm({ onAdded, onCancel }: { onAdded: () => void; onCancel: () => void }) {
  const t = useT();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: () => registerPasskey(name.trim(), { password }),
    onSuccess: onAdded,
    onError: (err) => setError(passkeyErrorMessage(t, err)),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    add.mutate();
  }

  return (
    <PanelForm onSubmit={onSubmit}>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Field htmlFor="passkey-add-name" label={t('settings.security.passkeys.nameLabel')}>
        <Input
          autoComplete="off"
          id="passkey-add-name"
          maxLength={PASSKEY_NAME_MAX}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('settings.security.passkeys.namePlaceholder')}
          type="text"
          value={name}
        />
      </Field>
      <Field
        hint={t('settings.security.passkeys.reauthHint')}
        htmlFor="passkey-add-password"
        label={t('settings.security.passkeys.passwordLabel')}
      >
        <Input
          autoComplete="current-password"
          id="passkey-add-password"
          onChange={(e) => setPassword(e.target.value)}
          type="password"
          value={password}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={add.isPending || name.trim().length === 0 || password.length === 0}
          size="sm"
          type="submit"
        >
          {add.isPending
            ? t('settings.security.passkeys.adding')
            : t('settings.security.passkeys.addSubmit')}
        </Button>
        <Button onClick={onCancel} size="sm" type="button" variant="quiet">
          {t('common.cancel')}
        </Button>
      </div>
    </PanelForm>
  );
}

/** One passkey row with inline rename + (re-auth-gated) delete. */
function PasskeyRow({
  passkey,
  isLast,
  refresh,
}: {
  passkey: Passkey;
  isLast: boolean;
  refresh: () => void;
}) {
  const t = useT();
  const [mode, setMode] = useState<'view' | 'rename' | 'delete'>('view');
  const [name, setName] = useState(passkey.name);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const rename = useMutation({
    mutationFn: () => renamePasskey(passkey.id, name.trim()),
    onSuccess: () => {
      setMode('view');
      refresh();
    },
    onError: (err) => setError(passkeyErrorMessage(t, err)),
  });

  const remove = useMutation({
    mutationFn: () => deletePasskey(passkey.id, { password }),
    onSuccess: refresh,
    onError: (err) => setError(passkeyErrorMessage(t, err)),
  });

  function reset() {
    setMode('view');
    setName(passkey.name);
    setPassword('');
    setError(null);
  }

  if (mode === 'rename') {
    return (
      <PanelListItem main={error ? <Alert tone="error">{error}</Alert> : null}>
        <PanelForm
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            rename.mutate();
          }}
        >
          <Field
            htmlFor={`passkey-rename-${passkey.id}`}
            label={t('settings.security.passkeys.nameLabel')}
          >
            <Input
              autoComplete="off"
              id={`passkey-rename-${passkey.id}`}
              maxLength={PASSKEY_NAME_MAX}
              onChange={(e) => setName(e.target.value)}
              type="text"
              value={name}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button disabled={rename.isPending || name.trim().length === 0} size="sm" type="submit">
              {rename.isPending
                ? t('settings.security.passkeys.renaming')
                : t('settings.security.passkeys.renameSave')}
            </Button>
            <Button onClick={reset} size="sm" type="button" variant="quiet">
              {t('common.cancel')}
            </Button>
          </div>
        </PanelForm>
      </PanelListItem>
    );
  }

  if (mode === 'delete') {
    return (
      <PanelListItem main={error ? <Alert tone="error">{error}</Alert> : null}>
        <PanelForm
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            remove.mutate();
          }}
        >
          {/* Losing the last passkey is a real consequence — say so. */}
          <PanelNote warn>
            {isLast
              ? t('settings.security.passkeys.lastWarning')
              : t('settings.security.passkeys.deleteConfirm')}
          </PanelNote>
          <Field
            htmlFor={`passkey-delete-${passkey.id}`}
            label={t('settings.security.passkeys.passwordLabel')}
          >
            <Input
              autoComplete="current-password"
              id={`passkey-delete-${passkey.id}`}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              value={password}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={remove.isPending || password.length === 0}
              size="sm"
              type="submit"
              variant="danger"
            >
              {remove.isPending
                ? t('settings.security.passkeys.deleting')
                : t('settings.security.passkeys.deleteSubmit')}
            </Button>
            <Button onClick={reset} size="sm" type="button" variant="quiet">
              {t('common.cancel')}
            </Button>
          </div>
        </PanelForm>
      </PanelListItem>
    );
  }

  return (
    <PanelListItem
      actions={
        <>
          <Button onClick={() => setMode('rename')} size="sm" type="button" variant="quiet">
            {t('settings.security.passkeys.rename')}
          </Button>
          <Button onClick={() => setMode('delete')} size="sm" type="button" variant="danger">
            {t('settings.security.passkeys.delete')}
          </Button>
        </>
      }
      main={
        <>
          <span className="bt-cc-row__label">{passkey.name}</span>
          <span className="bt-cc-row__hint">
            {t('settings.security.passkeys.added', { date: formatDateTime(passkey.createdAt) })}
            {' · '}
            {passkey.lastUsedAt
              ? t('settings.security.passkeys.lastUsed', {
                  date: formatDateTime(passkey.lastUsedAt),
                })
              : t('settings.security.passkeys.neverUsed')}
          </span>
        </>
      }
    />
  );
}

/** Passkeys / WebAuthn manager (§13.4 V4-P4). */
function PasskeysGroup() {
  const t = useT();
  const queryClient = useQueryClient();
  const [supported] = useState(() => browserSupportsWebAuthn());
  const [adding, setAdding] = useState(false);
  const query = useQuery({
    queryKey: PASSKEYS_KEY,
    queryFn: ({ signal }) => listPasskeys(signal),
    staleTime: 10_000,
  });

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: PASSKEYS_KEY });
  }

  return (
    <PanelGroup label={t('settings.security.passkeys.title')}>
      <Row stack>
        {/* What a passkey IS — the one line that earns its pixels here. */}
        <PanelNote>{t('settings.security.passkeys.description')}</PanelNote>
      </Row>

      {query.isPending ? (
        <Row>
          <Skeleton height="h-10" />
        </Row>
      ) : query.isError ? (
        <Row stack>
          <PanelNote>{t('settings.security.passkeys.loadError')}</PanelNote>
        </Row>
      ) : (
        <>
          {query.data.length === 0 ? (
            <Row stack>
              <PanelNote>{t('settings.security.passkeys.empty')}</PanelNote>
            </Row>
          ) : (
            <PanelList>
              {query.data.map((p) => (
                <PasskeyRow
                  isLast={query.data.length === 1}
                  key={p.id}
                  passkey={p}
                  refresh={refresh}
                />
              ))}
            </PanelList>
          )}
          <Row stack>
            {!supported ? (
              <PanelNote>{t('settings.security.passkeys.unsupported')}</PanelNote>
            ) : adding ? (
              <AddPasskeyForm
                onAdded={() => {
                  setAdding(false);
                  refresh();
                }}
                onCancel={() => setAdding(false)}
              />
            ) : (
              <Button
                className="self-start"
                onClick={() => setAdding(true)}
                size="sm"
                type="button"
              >
                {t('settings.security.passkeys.addButton')}
              </Button>
            )}
          </Row>
        </>
      )}
    </PanelGroup>
  );
}

function pinErrorMessage(t: TranslateFn, err: unknown): AttributedError<PinField> {
  if (err instanceof ApiError) {
    // A rejected PIN is about the digits the user chose, not the confirmation.
    if (err.code === 'WEAK_PASSWORD' || err.code === 'VALIDATION_ERROR') {
      return { field: 'pin', message: err.message };
    }
    if (err.status >= 500) return { field: null, message: t('common.genericError') };
  }
  return { field: null, message: t('settings.security.pin.genericError') };
}

/** The controls a PIN failure can be attributed to. */
type PinField = 'pin' | 'confirm';

/** Set/change form used both to enable a PIN and to change an existing one. */
function PinForm({
  submitLabel,
  onDone,
}: {
  submitLabel: string;
  onDone: (message: string) => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [pin, setPinValue] = useState('');
  const [confirm, setConfirm] = useState('');
  const { formRef, alertRef, fieldError, formError, fail, clear } = useFieldErrors<PinField>();

  const mutation = useMutation({
    mutationFn: (body: SetPinRequest) => setPin(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ME_KEY });
      setPinValue('');
      setConfirm('');
      onDone(t('settings.security.pin.savedNotice'));
    },
    onError: (err) => {
      const attributed = pinErrorMessage(t, err);
      fail(attributed.field, attributed.message);
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    clear();
    if (pin !== confirm) {
      // The confirmation is the box that disagrees — the PIN itself may be fine.
      fail('confirm', t('settings.security.pin.mismatch'));
      return;
    }
    mutation.mutate({ pin });
  }

  const tooShort = pin.length !== PIN_LENGTH || confirm.length !== PIN_LENGTH;

  return (
    <form className="flex flex-col gap-3" onSubmit={onSubmit} ref={formRef}>
      {formError ? (
        <div ref={alertRef} tabIndex={-1}>
          <Alert tone="error">{formError}</Alert>
        </div>
      ) : null}
      {/* Labels are "PIN" / "Confirm PIN" — deliberately NOT password-shaped, so
          they never collide with this panel's two "Current password" fields. */}
      <PinInput
        error={fieldError('pin')}
        hint={t('settings.security.pin.exactDigitsHint', { length: PIN_LENGTH })}
        label={t('settings.security.pin.pinLabel')}
        length={PIN_LENGTH}
        onChange={setPinValue}
        value={pin}
      />
      <PinInput
        error={fieldError('confirm')}
        label={t('settings.security.pin.confirmLabel')}
        length={PIN_LENGTH}
        onChange={setConfirm}
        value={confirm}
      />
      <Button
        className="self-start"
        disabled={mutation.isPending || tooShort}
        size="sm"
        type="submit"
      >
        {mutation.isPending ? t('common.saving') : submitLabel}
      </Button>
    </form>
  );
}

/** Preset unlock-window lengths (minutes) offered for the PIN. */
const WINDOW_MINUTE_OPTIONS = [1, 5, 10, 15, 30, 60] as const;

function windowOptionLabel(t: TranslateFn, minutes: number): string {
  if (minutes === 60) return t('settings.security.pin.windowHour');
  return t(
    minutes === 1
      ? 'settings.security.pin.windowMinuteOne'
      : 'settings.security.pin.windowMinuteOther',
    { count: minutes },
  );
}

/**
 * PIN idle-lock row (§6.1, §13.2 V2-P2; owner directive #304). Picks how long
 * the app may sit idle before the PIN is asked again. Active use never locks;
 * only inactivity does. `null` means the default
 * ({@link DEFAULT_PIN_WINDOW_MINUTES}). Only rendered while the PIN is on.
 */
function PinWindowRow({ windowMinutes }: { windowMinutes: number | null }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (minutes: number) => setPinLockIdleMinutes({ idleMinutes: minutes }),
    onSuccess: (data) => {
      queryClient.setQueryData(ME_KEY, data);
      setError(null);
    },
    onError: () => setError(t('settings.security.pin.windowError')),
  });

  const selected = windowMinutes ?? DEFAULT_PIN_WINDOW_MINUTES;

  return (
    <Row
      hint={t('settings.security.pin.lockDescription')}
      label={t('settings.security.pin.lockAfterInactivity')}
    >
      <Select
        aria-label={t('settings.security.pin.unlockWindowAriaLabel')}
        disabled={mutation.isPending}
        onChange={(e) => mutation.mutate(Number(e.target.value))}
        style={{ width: 'auto' }}
        value={selected}
      >
        {(WINDOW_MINUTE_OPTIONS as readonly number[]).includes(selected) ? null : (
          <option value={selected}>{windowOptionLabel(t, selected)}</option>
        )}
        {WINDOW_MINUTE_OPTIONS.map((m) => (
          <option key={m} value={m}>
            {windowOptionLabel(t, m)}
          </option>
        ))}
      </Select>
      {error ? (
        <span className="bt-field__error">{t('settings.security.pin.windowError')}</span>
      ) : null}
    </Row>
  );
}

/** PIN enable / change / disable group, driven by `getMe`. */
function PinGroup({
  pinEnabled,
  idleMinutes,
}: {
  pinEnabled: boolean;
  idleMinutes: number | null;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [changing, setChanging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const disable = useMutation({
    mutationFn: () => disablePin(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ME_KEY });
      setChanging(false);
      setError(null);
      setNotice(t('settings.security.pin.disabledNotice'));
    },
    // Disabling is a button, not a form — there is no field to blame, so only
    // the message is used here.
    onError: (err) => setError(pinErrorMessage(t, err).message),
  });

  return (
    <PanelGroup label={t('settings.security.pin.title')}>
      <Row stack>
        {/* The real constraint: a PIN is a privacy curtain, not a second factor. */}
        <PanelNote>{t('settings.security.pin.description')}</PanelNote>
        {notice ? <Alert tone="success">{notice}</Alert> : null}
        {!pinEnabled ? (
          <PinForm
            onDone={(message) => {
              setNotice(message);
            }}
            submitLabel={t('settings.security.pin.enable')}
          />
        ) : changing ? (
          <div className="flex flex-col gap-3">
            <PinForm
              onDone={(message) => {
                setChanging(false);
                setNotice(message);
              }}
              submitLabel={t('settings.security.pin.saveNew')}
            />
            <Button
              className="self-start"
              onClick={() => setChanging(false)}
              size="sm"
              type="button"
              variant="quiet"
            >
              {t('common.cancel')}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col items-start gap-2">
            {/* Element kept a <p> on purpose: security copy keeps its semantics. */}
            <p className="bt-pos" style={{ fontSize: 12.5 }}>
              {t('settings.security.pin.isOn')}
            </p>
            {error ? <Alert tone="error">{error}</Alert> : null}
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => {
                  setNotice(null);
                  setChanging(true);
                }}
                size="sm"
                type="button"
              >
                {t('settings.security.pin.change')}
              </Button>
              <Button
                disabled={disable.isPending}
                onClick={() => {
                  setNotice(null);
                  disable.mutate();
                }}
                size="sm"
                type="button"
                variant="danger"
              >
                {disable.isPending
                  ? t('settings.security.pin.disabling')
                  : t('settings.security.pin.disable')}
              </Button>
            </div>
          </div>
        )}
      </Row>
      {pinEnabled ? <PinWindowRow windowMinutes={idleMinutes} /> : null}
    </PanelGroup>
  );
}

/**
 * Control Center → Sign-in (PROJECTPLAN.md §6.1, §6.11). Answers one question:
 * HOW do I prove it's me? The password, the two independently-toggleable
 * two-factor methods with their shared recovery codes, the passkeys, and the PIN
 * app lock.
 *
 * The PIN sits LAST and keeps its "privacy curtain, not a second factor" line:
 * it moved here from Sessions on owner order (a PIN is a credential, not a
 * device listing), and the ordering keeps it from reading as a third factor
 * alongside the real ones. Where the account is signed in stays with Sessions.
 */
export function SignInPanel() {
  const t = useT();
  const me = useQuery({
    queryKey: ME_KEY,
    queryFn: ({ signal }) => getMe(signal),
    staleTime: 30_000,
  });

  return (
    <div className="bt-cc-panel">
      <PanelHead title={t('control.signIn')} />
      <ChangePasswordGroup />
      <TwoFactorGroup />
      <PasskeysGroup />

      {me.isPending ? (
        <Skeleton height="h-16" />
      ) : me.isError ? (
        <PanelNote>{t('settings.security.loadError.title')}</PanelNote>
      ) : (
        <PinGroup idleMinutes={me.data.pinLockIdleMinutes} pinEnabled={me.data.pinEnabled} />
      )}
    </div>
  );
}
