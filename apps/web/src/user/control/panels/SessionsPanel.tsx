import { useState } from 'react';
import type { FormEvent } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { DEFAULT_PIN_WINDOW_MINUTES, PIN_LENGTH, type SetPinRequest } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import type { TranslateFn } from '../../../i18n';
import { ApiError } from '../../../lib/apiClient';
import { formatDateTime } from '../../../lib/format';
import {
  disablePin,
  getMe,
  getSession,
  listSessions,
  revokeOtherSessions,
  revokeSession,
  setPin,
  setPinLockIdleMinutes,
} from '../../../lib/userApi';
import { Skeleton } from '../../../ui';
import { Badge, Button, Select } from '../../../ui/origin';
import { PinInput } from '../../components/PinInput';
import { Alert } from '../../components/ui';
import { PanelGroup, PanelHead, PanelList, PanelListItem, PanelNote, Row } from './panelKit';

const ME_KEY = ['auth', 'me'] as const;
const SESSION_KEY = ['auth', 'session'] as const;
const SESSIONS_KEY = ['auth', 'sessions'] as const;

function pinErrorMessage(t: TranslateFn, err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'WEAK_PASSWORD' || err.code === 'VALIDATION_ERROR') return err.message;
    if (err.status >= 500) return t('common.genericError');
  }
  return t('settings.security.pin.genericError');
}

/** Signed-in-since / expiry line, read from `GET /auth/session`. */
function ThisSessionRow() {
  const t = useT();
  const query = useQuery({
    queryKey: SESSION_KEY,
    queryFn: ({ signal }) => getSession(signal),
    staleTime: 30_000,
  });

  return (
    <Row label={t('settings.security.session.title')}>
      {query.isPending ? (
        <Skeleton height="h-4" width="w-48" />
      ) : query.isError ? (
        <span className="bt-field__error">{t('settings.security.session.loadError.title')}</span>
      ) : (
        <span className="bt-cc-row__hint">
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
        </span>
      )}
    </Row>
  );
}

/**
 * Active-sessions manager (PROJECTPLAN.md §6.1, §6.11 Security, V3-P11a). Lists
 * the caller's own sessions with a device label, sign-in + last-seen times and a
 * current-device marker; each other device can be logged out individually, or
 * all at once. The current session isn't revoked from here — use Log out.
 */
function SessionsGroup() {
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
    <PanelGroup label={t('settings.security.sessions.title')}>
      <Row stack>
        {/* A security instruction, not narration — it tells the user what to DO. */}
        <PanelNote>{t('settings.security.sessions.description')}</PanelNote>
        {error ? <Alert tone="error">{error}</Alert> : null}
      </Row>

      {query.isPending ? (
        <Row>
          <Skeleton height="h-10" />
        </Row>
      ) : query.isError ? (
        <Row stack>
          <PanelNote>{t('settings.security.sessions.loadError.title')}</PanelNote>
        </Row>
      ) : (
        <PanelList>
          {sessions.map((session) => (
            <PanelListItem
              actions={
                session.current ? null : (
                  <Button
                    disabled={revokeOne.isPending}
                    onClick={() => {
                      setError(null);
                      revokeOne.mutate(session.id);
                    }}
                    size="sm"
                    type="button"
                    variant="danger"
                  >
                    {t('settings.security.sessions.logOut')}
                  </Button>
                )
              }
              key={session.id}
              main={
                <>
                  <span className="bt-cc-row__label flex flex-wrap items-center gap-2">
                    <span>{session.device}</span>
                    {session.current ? (
                      <Badge tone="gold">{t('settings.security.sessions.currentDevice')}</Badge>
                    ) : null}
                    {/* Persistent vs ephemeral ("stay signed in") — V4-P2b, §399 §A. */}
                    <Badge outline>
                      {session.persistent
                        ? t('settings.security.sessions.persistent')
                        : t('settings.security.sessions.ephemeral')}
                    </Badge>
                  </span>
                  <span className="bt-cc-row__hint">
                    {t('settings.security.sessions.timestamps', {
                      createdAt: formatDateTime(session.createdAt),
                      lastSeenAt: formatDateTime(session.lastSeenAt),
                    })}
                  </span>
                </>
              }
            />
          ))}
        </PanelList>
      )}

      {otherCount > 0 ? (
        <Row stack>
          {confirmingOthers ? (
            <div className="flex flex-col gap-2">
              <PanelNote>
                {t(
                  otherCount === 1
                    ? 'settings.security.sessions.confirmLogoutOthersOne'
                    : 'settings.security.sessions.confirmLogoutOthersOther',
                  { count: otherCount },
                )}
              </PanelNote>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={revokeOthers.isPending}
                  onClick={() => revokeOthers.mutate()}
                  size="sm"
                  type="button"
                  variant="danger"
                >
                  {revokeOthers.isPending
                    ? t('settings.security.sessions.loggingOut')
                    : t('settings.security.sessions.logOutAllOthers')}
                </Button>
                <Button
                  onClick={() => setConfirmingOthers(false)}
                  size="sm"
                  type="button"
                  variant="quiet"
                >
                  {t('common.cancel')}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              className="self-start"
              onClick={() => {
                setError(null);
                setConfirmingOthers(true);
              }}
              size="sm"
              type="button"
              variant="danger"
            >
              {t('settings.security.sessions.logOutAllOthers')}
            </Button>
          )}
        </Row>
      ) : null}
    </PanelGroup>
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
    <form className="flex flex-col gap-3" onSubmit={onSubmit}>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <PinInput
        hint={t('settings.security.pin.exactDigitsHint', { length: PIN_LENGTH })}
        label={t('settings.security.pin.pinLabel')}
        length={PIN_LENGTH}
        onChange={setPinValue}
        value={pin}
      />
      <PinInput
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
    onError: (err) => setError(pinErrorMessage(t, err)),
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
 * Control Center → Sessions (PROJECTPLAN.md §6.1, §6.11). Answers one question:
 * WHERE am I signed in, and when does this device lock? The current session, the
 * full device list with per-device and log-out-all-others revocation, and the
 * PIN app lock with its idle window.
 *
 * The credentials themselves (password, two-factor, passkeys) are the Sign-in
 * panel's job — "how I prove it's me" and "where am I signed in" are two
 * different questions and used to share one 1300-line page.
 */
export function SessionsPanel() {
  const t = useT();
  const me = useQuery({
    queryKey: ME_KEY,
    queryFn: ({ signal }) => getMe(signal),
    staleTime: 30_000,
  });

  return (
    <div className="bt-cc-panel">
      <PanelHead title={t('control.sessions')} />

      <PanelGroup>
        <ThisSessionRow />
      </PanelGroup>

      <SessionsGroup />

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
