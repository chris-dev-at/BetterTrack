import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';

import {
  MIN_PASSWORD_LENGTH,
  PASSKEY_NAME_MAX,
  TOTP_CODE_LENGTH,
  type ChangePasswordRequest,
  type Passkey,
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
import { changePassword, deletePasskey, listPasskeys, renamePasskey } from '../../../lib/userApi';
import { Skeleton } from '../../../ui';
import { Button, Field, Input } from '../../../ui/origin';
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

/** Friendly message for the codes `POST /auth/change-password` can return. */
function changeErrorMessage(t: TranslateFn, err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'INVALID_CREDENTIALS') return t('settings.password.currentWrong');
    if (err.code === 'WEAK_PASSWORD') return err.message;
    if (err.status >= 500) return t('common.genericError');
  }
  return t('settings.password.changeFailed');
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
  const [error, setError] = useState<string | null>(null);
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
    setError(null);
    setDone(false);
    if (newPassword !== confirmPassword) {
      setError(t('settings.password.mismatch'));
      return;
    }
    mutation.mutate(
      { currentPassword, newPassword },
      { onError: (err) => setError(changeErrorMessage(t, err)) },
    );
  }

  return (
    <PanelGroup label={t('settings.password.title')}>
      <Row stack>
        {error ? <Alert tone="error">{error}</Alert> : null}
        {done ? <Alert tone="success">{t('settings.password.success')}</Alert> : null}
        <PanelForm onSubmit={onSubmit}>
          <Field htmlFor="currentPassword" label={t('settings.password.current')}>
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
          <Field htmlFor="confirmPassword" label={t('settings.password.confirm')}>
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
  const [error, setError] = useState<string | null>(null);

  const enroll = useMutation({
    mutationFn: enrollTwoFactor,
    onError: () => setError(t('settings.security.twoFactor.totp.enrollError')),
  });
  const enrollStart = enroll.mutate;

  // Kick off enrollment once, when the wizard first mounts.
  useEffect(() => {
    enrollStart();
  }, [enrollStart]);

  const confirm = useMutation({
    mutationFn: () => confirmTwoFactor({ code }),
    onSuccess: (data) => onEnrolled(data.recoveryCodes),
    onError: (err) => setError(twoFactorErrorMessage(t, err)),
  });

  if (!enroll.data) {
    return enroll.isError ? <Alert tone="error">{error}</Alert> : <Skeleton height="h-16" />;
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    confirm.mutate();
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={onSubmit}>
      {error ? <Alert tone="error">{error}</Alert> : null}
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

/**
 * Control Center → Sign-in (PROJECTPLAN.md §6.1, §6.11). Answers one question:
 * HOW do I prove it's me? The password, the two independently-toggleable
 * two-factor methods with their shared recovery codes, and the passkeys.
 *
 * Where the account is currently signed in — and the PIN app lock — is the
 * Sessions panel's job.
 */
export function SignInPanel() {
  const t = useT();
  return (
    <div className="bt-cc-panel">
      <PanelHead title={t('control.signIn')} />
      <ChangePasswordGroup />
      <TwoFactorGroup />
      <PasskeysGroup />
    </div>
  );
}
