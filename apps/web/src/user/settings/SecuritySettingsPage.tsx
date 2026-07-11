import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';

import {
  DEFAULT_PIN_WINDOW_MINUTES,
  PIN_LENGTH,
  TOTP_CODE_LENGTH,
  type SetPinRequest,
  type TwoFactorStatusResponse,
} from '@bettertrack/contracts';

import { useT } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import { formatDateTime } from '../../lib/format';
import {
  confirmEmailTwoFactor,
  confirmTwoFactor,
  disableEmailTwoFactor,
  disableTwoFactor,
  enrollEmailTwoFactor,
  enrollTwoFactor,
  getTwoFactorStatus,
  regenerateRecoveryCodes,
} from '../../lib/twoFactorApi';
import {
  disablePin,
  getMe,
  getSession,
  listSessions,
  revokeOtherSessions,
  revokeSession,
  setPin,
  setPinLockIdleMinutes,
} from '../../lib/userApi';
import { EmptyState, Skeleton } from '../../ui';
import { PinInput } from '../components/PinInput';
import { Alert, Button } from '../components/ui';

const ME_KEY = ['auth', 'me'] as const;
const SESSION_KEY = ['auth', 'session'] as const;
const SESSIONS_KEY = ['auth', 'sessions'] as const;
const TWO_FACTOR_KEY = ['auth', '2fa', 'status'] as const;

function pinErrorMessage(t: TranslateFn, err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'WEAK_PASSWORD' || err.code === 'VALIDATION_ERROR') return err.message;
    if (err.status >= 500) return t('common.genericError');
  }
  return t('settings.security.pin.genericError');
}

/** Signed-in-since / expiry line, read from `GET /auth/session`. */
function SessionInfo() {
  const t = useT();
  const query = useQuery({
    queryKey: SESSION_KEY,
    queryFn: ({ signal }) => getSession(signal),
    staleTime: 30_000,
  });

  return (
    <section className="flex flex-col gap-3 rounded-md border border-neutral-800 bg-neutral-900 p-5">
      <h3 className="text-sm font-semibold text-neutral-100">
        {t('settings.security.session.title')}
      </h3>
      {query.isPending ? (
        <Skeleton height="h-6" />
      ) : query.isError ? (
        <EmptyState
          title={t('settings.security.session.loadError.title')}
          description={t('settings.retryHint')}
        />
      ) : (
        <p className="text-sm text-neutral-400">
          {/* Ephemeral sessions die on browser close and are server-capped
              (≤6h) — reporting the persistent 30-day window would lie (V4-P2b). */}
          {t(
            query.data.persistent
              ? 'settings.security.session.info'
              : 'settings.security.session.infoEphemeral',
            {
              signedInAt: formatDateTime(query.data.signedInAt),
              expiresAt: formatDateTime(query.data.expiresAt),
            },
          )}
        </p>
      )}
    </section>
  );
}

/**
 * Active-sessions manager (PROJECTPLAN.md §6.1, §6.11 Security, V3-P11a). Lists
 * the caller's own sessions with a device label, sign-in + last-seen times and a
 * current-device marker; each other device can be logged out individually, or
 * all at once. The current session isn't revoked from here — use Log out.
 */
function SessionsSection() {
  const t = useT();
  const queryClient = useQueryClient();
  const [confirmingOthers, setConfirmingOthers] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: SESSIONS_KEY,
    queryFn: ({ signal }) => listSessions(signal),
    staleTime: 30_000,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });

  const revokeOne = useMutation({
    mutationFn: (id: string) => revokeSession(id),
    onSuccess: () => {
      setError(null);
      void refresh();
    },
    onError: () => setError(t('settings.security.sessions.revokeOneError')),
  });

  const revokeOthers = useMutation({
    mutationFn: () => revokeOtherSessions(),
    onSuccess: () => {
      setError(null);
      setConfirmingOthers(false);
      void refresh();
    },
    onError: () => setError(t('settings.security.sessions.revokeOthersError')),
  });

  const sessions = query.data ?? [];
  const otherCount = sessions.filter((s) => !s.current).length;

  return (
    <section className="flex flex-col gap-4 rounded-md border border-neutral-800 bg-neutral-900 p-5">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold text-neutral-100">
          {t('settings.security.sessions.title')}
        </h3>
        <p className="text-xs text-neutral-500">{t('settings.security.sessions.description')}</p>
      </div>

      {error ? <Alert tone="error">{error}</Alert> : null}

      {query.isPending ? (
        <Skeleton height="h-20" />
      ) : query.isError ? (
        <EmptyState
          title={t('settings.security.sessions.loadError.title')}
          description={t('settings.retryHint')}
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {sessions.map((session) => (
            <li
              key={session.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-neutral-800 bg-neutral-950 p-3"
            >
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium text-neutral-100">
                  <span>{session.device}</span>
                  {session.current ? (
                    <span className="ml-2 rounded-full bg-sky-500/15 px-2 py-0.5 text-xs font-medium text-sky-300">
                      {t('settings.security.sessions.currentDevice')}
                    </span>
                  ) : null}
                  {/* Persistent vs ephemeral ("stay signed in") — V4-P2b, §399 §A. */}
                  <span className="ml-2 rounded-full bg-neutral-800 px-2 py-0.5 text-xs font-medium text-neutral-400">
                    {session.persistent
                      ? t('settings.security.sessions.persistent')
                      : t('settings.security.sessions.ephemeral')}
                  </span>
                </span>
                <span className="text-xs text-neutral-500">
                  {t('settings.security.sessions.timestamps', {
                    createdAt: formatDateTime(session.createdAt),
                    lastSeenAt: formatDateTime(session.lastSeenAt),
                  })}
                </span>
              </div>
              {session.current ? null : (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={revokeOne.isPending}
                  onClick={() => {
                    setError(null);
                    revokeOne.mutate(session.id);
                  }}
                >
                  {t('settings.security.sessions.logOut')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {otherCount > 0 ? (
        confirmingOthers ? (
          <div className="flex flex-col gap-3 border-t border-neutral-800 pt-4">
            <p className="text-sm text-neutral-400">
              {t(
                otherCount === 1
                  ? 'settings.security.sessions.confirmLogoutOthersOne'
                  : 'settings.security.sessions.confirmLogoutOthersOther',
                { count: otherCount },
              )}
            </p>
            <div className="flex flex-wrap gap-3">
              <Button
                type="button"
                variant="secondary"
                disabled={revokeOthers.isPending}
                onClick={() => revokeOthers.mutate()}
              >
                {revokeOthers.isPending
                  ? t('settings.security.sessions.loggingOut')
                  : t('settings.security.sessions.logOutAllOthers')}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setConfirmingOthers(false)}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="border-t border-neutral-800 pt-4">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setError(null);
                setConfirmingOthers(true);
              }}
            >
              {t('settings.security.sessions.logOutAllOthers')}
            </Button>
          </div>
        )
      ) : null}
    </section>
  );
}

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
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (body: SetPinRequest) => setPin(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ME_KEY });
      setPinValue('');
      setConfirm('');
      onDone(t('settings.security.pin.savedNotice'));
    },
    onError: (err) => setError(pinErrorMessage(t, err)),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (pin !== confirm) {
      setError(t('settings.security.pin.mismatch'));
      return;
    }
    mutation.mutate({ pin });
  }

  const tooShort = pin.length !== PIN_LENGTH || confirm.length !== PIN_LENGTH;

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <PinInput
        label={t('settings.security.pin.pinLabel')}
        length={PIN_LENGTH}
        value={pin}
        onChange={setPinValue}
        hint={t('settings.security.pin.exactDigitsHint', { length: PIN_LENGTH })}
      />
      <PinInput
        label={t('settings.security.pin.confirmLabel')}
        length={PIN_LENGTH}
        value={confirm}
        onChange={setConfirm}
      />
      <div>
        <Button type="submit" disabled={mutation.isPending || tooShort}>
          {mutation.isPending ? t('common.saving') : submitLabel}
        </Button>
      </div>
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
 * PIN idle-lock control (§6.1, §13.2 V2-P2; owner directive #304). Picks how long
 * the app may sit idle before the PIN is asked again. Active use never locks; only
 * inactivity does. `null` means the default ({@link DEFAULT_PIN_WINDOW_MINUTES}).
 * Only rendered while the PIN is on.
 */
function PinWindowSection({ windowMinutes }: { windowMinutes: number | null }) {
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
    <div className="flex flex-col gap-3 border-t border-neutral-800 pt-4">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-neutral-100">
          {t('settings.security.pin.lockAfterInactivity')}
        </span>
        <span className="text-xs text-neutral-500">
          {t('settings.security.pin.lockDescription')}
        </span>
      </div>

      <label className="flex items-center gap-2 text-sm text-neutral-400">
        {t('settings.security.pin.idleForLabel')}
        <select
          aria-label={t('settings.security.pin.unlockWindowAriaLabel')}
          value={selected}
          disabled={mutation.isPending}
          onChange={(e) => mutation.mutate(Number(e.target.value))}
          className="rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm text-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          {(WINDOW_MINUTE_OPTIONS as readonly number[]).includes(selected) ? null : (
            <option value={selected}>{windowOptionLabel(t, selected)}</option>
          )}
          {WINDOW_MINUTE_OPTIONS.map((m) => (
            <option key={m} value={m}>
              {windowOptionLabel(t, m)}
            </option>
          ))}
        </select>
      </label>

      {error ? <Alert tone="error">{error}</Alert> : null}
    </div>
  );
}

/** PIN enable / change / disable card, driven by `getMe`. */
function PinSection({
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
    onError: (err) => setError(pinErrorMessage(t, err)),
  });

  return (
    <section className="flex flex-col gap-4 rounded-md border border-neutral-800 bg-neutral-900 p-5">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold text-neutral-100">
          {t('settings.security.pin.title')}
        </h3>
        <p className="text-xs text-neutral-500">{t('settings.security.pin.description')}</p>
      </div>

      {notice ? <Alert tone="success">{notice}</Alert> : null}

      {!pinEnabled ? (
        <PinForm
          submitLabel={t('settings.security.pin.enable')}
          onDone={(message) => {
            setNotice(message);
          }}
        />
      ) : (
        <>
          {changing ? (
            <div className="flex flex-col gap-4">
              <PinForm
                submitLabel={t('settings.security.pin.saveNew')}
                onDone={(message) => {
                  setChanging(false);
                  setNotice(message);
                }}
              />
              <div>
                <Button type="button" variant="ghost" onClick={() => setChanging(false)}>
                  {t('common.cancel')}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-neutral-400">{t('settings.security.pin.isOn')}</p>
              {error ? <Alert tone="error">{error}</Alert> : null}
              <div className="flex flex-wrap gap-3">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setNotice(null);
                    setChanging(true);
                  }}
                >
                  {t('settings.security.pin.change')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={disable.isPending}
                  onClick={() => {
                    setNotice(null);
                    disable.mutate();
                  }}
                >
                  {disable.isPending
                    ? t('settings.security.pin.disabling')
                    : t('settings.security.pin.disable')}
                </Button>
              </div>
            </div>
          )}
          <PinWindowSection windowMinutes={idleMinutes} />
        </>
      )}
    </section>
  );
}

function twoFactorErrorMessage(t: TranslateFn, err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status < 500) return err.message;
  }
  return t('common.genericError');
}

/** Recovery codes, shown exactly once after the first method is enabled or a regenerate. */
function RecoveryCodesCard({ codes, onDone }: { codes: readonly string[]; onDone: () => void }) {
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
    <div className="flex flex-col gap-4">
      <Alert tone="info">{t('settings.security.twoFactor.recoveryCodes.saveNotice')}</Alert>
      <div className="grid grid-cols-2 gap-2 rounded-md border border-neutral-800 bg-neutral-950 p-4 font-mono text-sm text-neutral-100">
        {codes.map((code) => (
          <span key={code}>{code}</span>
        ))}
      </div>
      <div className="flex flex-wrap gap-3">
        <Button type="button" variant="secondary" onClick={handleCopy}>
          {copied
            ? t('settings.security.twoFactor.recoveryCodes.copied')
            : t('settings.security.twoFactor.recoveryCodes.copy')}
        </Button>
        <Button type="button" variant="secondary" onClick={handleDownload}>
          {t('settings.security.twoFactor.recoveryCodes.download')}
        </Button>
        <Button type="button" onClick={onDone}>
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
    return (
      <div className="flex flex-col gap-3">
        {enroll.isError ? <Alert tone="error">{error}</Alert> : <Skeleton height="h-24" />}
      </div>
    );
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    confirm.mutate();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <p className="text-sm text-neutral-400">
        {t('settings.security.twoFactor.totp.scanInstructions')}
      </p>
      {/* QR needs a light quiet-zone to scan reliably against the dark theme. */}
      <div className="self-start rounded-md bg-white p-3">
        <QRCodeSVG
          value={enroll.data.otpauthUri}
          size={176}
          marginSize={0}
          aria-label={t('settings.security.twoFactor.totp.qrAriaLabel')}
        />
      </div>
      <details className="rounded-md border border-neutral-800 bg-neutral-950 p-4">
        <summary className="cursor-pointer text-xs font-medium text-neutral-400">
          {t('settings.security.twoFactor.totp.manualEntryToggle')}
        </summary>
        <div className="mt-3 flex flex-col gap-1.5">
          <span className="text-xs font-medium text-neutral-500">
            {t('settings.security.twoFactor.totp.setupKeyLabel')}
          </span>
          <code className="break-all text-sm text-neutral-100">{enroll.data.secret}</code>
          <span className="mt-2 text-xs font-medium text-neutral-500">
            {t('settings.security.twoFactor.totp.otpauthUriLabel')}
          </span>
          <code className="break-all text-xs text-neutral-400">{enroll.data.otpauthUri}</code>
        </div>
      </details>
      <PinInput
        label={t('settings.security.twoFactor.totp.confirmationCodeLabel')}
        length={TOTP_CODE_LENGTH}
        value={code}
        onChange={setCode}
        hint={t('settings.security.twoFactor.totp.confirmationCodeHint')}
        autoFocus
      />
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={confirm.isPending || code.length !== TOTP_CODE_LENGTH}>
          {confirm.isPending
            ? t('settings.security.twoFactor.confirming')
            : t('settings.security.twoFactor.confirmAndEnable')}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
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
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <label className="flex flex-col gap-1.5 text-sm font-medium text-neutral-300">
        {t('settings.security.twoFactor.totp.disableCodeLabel')}
        <input
          type="text"
          autoComplete="off"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          className="rounded-md bg-neutral-950 px-3 py-2 text-sm text-neutral-100 ring-1 ring-inset ring-neutral-700 focus:outline-none focus:ring-2 focus:ring-sky-500"
        />
      </label>
      <div className="flex flex-wrap gap-3">
        <Button type="submit" variant="secondary" disabled={disable.isPending || code.length < 6}>
          {disable.isPending
            ? t('settings.security.pin.disabling')
            : t('settings.security.twoFactor.totp.turnOffFull')}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

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
    <div className="flex flex-col gap-3 rounded-md border border-neutral-800 bg-neutral-950 p-4">
      <div className="flex flex-col gap-0.5">
        <h4 className="text-sm font-semibold text-neutral-100">{title}</h4>
        <p className="text-xs text-neutral-500">{description}</p>
      </div>
      {children}
    </div>
  );
}

type AuthenticatorView = 'status' | 'enrolling' | 'disabling';

/** Authenticator-app (TOTP) method (§6.1, #298). */
function AuthenticatorMethodCard({
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

  return (
    <MethodCard
      title={t('settings.security.twoFactor.totp.cardTitle')}
      description={t('settings.security.twoFactor.totp.cardDescription')}
    >
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {view === 'enrolling' ? (
        <EnrollWizard
          onEnrolled={(codes) => {
            setView('status');
            if (codes) onFirstRecoveryCodes(codes);
            else setNotice(t('settings.security.twoFactor.totp.enabledNotice'));
            refresh();
          }}
          onCancel={() => setView('status')}
        />
      ) : !enabled ? (
        <div>
          <Button
            type="button"
            onClick={() => {
              setNotice(null);
              setView('enrolling');
            }}
          >
            {t('settings.security.twoFactor.totp.setup')}
          </Button>
        </div>
      ) : view === 'disabling' ? (
        <DisableForm
          onDisabled={() => {
            setView('status');
            setNotice(t('settings.security.twoFactor.totp.disabledNotice'));
            refresh();
          }}
          onCancel={() => setView('status')}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-neutral-400">
            {t('settings.security.twoFactor.enabledLabel')}
          </p>
          <div>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setNotice(null);
                setView('disabling');
              }}
            >
              {t('settings.security.twoFactor.turnOff')}
            </Button>
          </div>
        </div>
      )}
    </MethodCard>
  );
}

type EmailMethodView = 'status' | 'confirming';

/** Email-code method (§6.1, #298): prove mailbox access, then a code at each sign-in. */
function EmailMethodCard({
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
    <MethodCard
      title={t('settings.security.twoFactor.email.cardTitle')}
      description={t('settings.security.twoFactor.email.cardDescription')}
    >
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      {enabled ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-neutral-400">
            {t('settings.security.twoFactor.enabledLabel')}
          </p>
          <div>
            <Button
              type="button"
              variant="ghost"
              disabled={disable.isPending}
              onClick={() => {
                setNotice(null);
                disable.mutate();
              }}
            >
              {disable.isPending
                ? t('settings.security.twoFactor.turningOff')
                : t('settings.security.twoFactor.turnOff')}
            </Button>
          </div>
        </div>
      ) : view === 'confirming' ? (
        <form onSubmit={onConfirm} className="flex flex-col gap-4">
          <p className="text-sm text-neutral-400">
            {t('settings.security.twoFactor.email.confirmInstructions')}
          </p>
          <PinInput
            label={t('settings.security.twoFactor.email.codeLabel')}
            length={TOTP_CODE_LENGTH}
            value={code}
            onChange={setCode}
            hint={t('settings.security.twoFactor.email.codeHint')}
            autoFocus
          />
          <div className="flex flex-wrap gap-3">
            <Button type="submit" disabled={confirm.isPending || code.length !== TOTP_CODE_LENGTH}>
              {confirm.isPending
                ? t('settings.security.twoFactor.confirming')
                : t('settings.security.twoFactor.confirmAndEnable')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setView('status');
                setCode('');
                setError(null);
              }}
            >
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      ) : (
        <div>
          <Button
            type="button"
            disabled={enroll.isPending}
            onClick={() => {
              setNotice(null);
              enroll.mutate();
            }}
          >
            {enroll.isPending
              ? t('settings.security.twoFactor.email.sendingCode')
              : t('settings.security.twoFactor.email.setup')}
          </Button>
        </div>
      )}
    </MethodCard>
  );
}

/** Shared recovery-code control, shown while any method is on. */
function RecoveryCodesControl({
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
    <MethodCard
      title={t('settings.security.twoFactor.recoveryCodes.cardTitle')}
      description={t('settings.security.twoFactor.recoveryCodes.cardDescription')}
    >
      <p className="text-sm text-neutral-400">
        {t(
          remaining === 1
            ? 'settings.security.twoFactor.recoveryCodes.remainingOne'
            : 'settings.security.twoFactor.recoveryCodes.remainingOther',
          { count: remaining },
        )}
      </p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div>
        <Button
          type="button"
          variant="secondary"
          disabled={regenerate.isPending}
          onClick={() => regenerate.mutate()}
        >
          {regenerate.isPending
            ? t('settings.security.twoFactor.recoveryCodes.regenerating')
            : t('settings.security.twoFactor.recoveryCodes.regenerate')}
        </Button>
      </div>
    </MethodCard>
  );
}

/**
 * Two-factor authentication card (PROJECTPLAN.md §6.1, §13.2 V2-P5, #298): two
 * independently-toggleable methods (authenticator app + email codes) with shared
 * recovery codes, driven by `GET /auth/2fa/status`. Recovery codes are shown once
 * when the first method is enabled (or on regenerate).
 */
function TwoFactorSection() {
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
    <section className="flex flex-col gap-4 rounded-md border border-neutral-800 bg-neutral-900 p-5">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold text-neutral-100">
          {t('settings.security.twoFactor.title')}
        </h3>
        <p className="text-xs text-neutral-500">{t('settings.security.twoFactor.description')}</p>
      </div>

      {recoveryCodes ? (
        <RecoveryCodesCard
          codes={recoveryCodes}
          onDone={() => {
            setRecoveryCodes(null);
            refresh();
          }}
        />
      ) : status.isPending ? (
        <Skeleton height="h-16" />
      ) : status.isError ? (
        <EmptyState
          title={t('settings.security.twoFactor.loadError.title')}
          description={t('settings.retryHint')}
        />
      ) : (
        <div className="flex flex-col gap-4">
          <AuthenticatorMethodCard
            enabled={status.data.totpEnabled}
            onFirstRecoveryCodes={setRecoveryCodes}
            refresh={refresh}
          />
          <EmailMethodCard
            enabled={status.data.emailEnabled}
            onFirstRecoveryCodes={setRecoveryCodes}
            refresh={refresh}
          />
          {anyEnabled(status.data) ? (
            <RecoveryCodesControl
              remaining={status.data.recoveryCodesRemaining}
              onRegenerated={setRecoveryCodes}
            />
          ) : null}
        </div>
      )}
    </section>
  );
}

/**
 * Settings → Security (PROJECTPLAN.md §6.11). Session info, PIN
 * enable/change/disable (§6.1), and two-factor auth (§13.2 V2-P5). All shapes
 * derive from `@bettertrack/contracts` via the web api-client.
 */
export function SecuritySettingsPage() {
  const t = useT();
  const me = useQuery({
    queryKey: ME_KEY,
    queryFn: ({ signal }) => getMe(signal),
    staleTime: 30_000,
  });

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-neutral-100">{t('settings.security.title')}</h2>
        <p className="text-sm text-neutral-500">{t('settings.security.subtitle')}</p>
      </div>

      <SessionInfo />

      <SessionsSection />

      {me.isPending ? (
        <Skeleton height="h-24" />
      ) : me.isError ? (
        <EmptyState
          title={t('settings.security.loadError.title')}
          description={t('settings.retryHint')}
        />
      ) : (
        <PinSection pinEnabled={me.data.pinEnabled} idleMinutes={me.data.pinLockIdleMinutes} />
      )}

      <TwoFactorSection />
    </div>
  );
}
