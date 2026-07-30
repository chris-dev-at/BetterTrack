import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { QRCodeSVG } from 'qrcode.react';

import { PIN_LENGTH, TOTP_CODE_LENGTH } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import type { TranslateFn } from '../../../i18n';
import { ApiError } from '../../../lib/apiClient';
import { setPin } from '../../../lib/userApi';
import { confirmTwoFactor, enrollTwoFactor, getTwoFactorStatus } from '../../../lib/twoFactorApi';
import { Badge } from '../../../ui/origin';
import { useAuth } from '../../AuthContext';
import { PinInput } from '../../components/PinInput';
import { Alert, Button } from '../../components/ui';
import type { FirstRunStepProps } from '../types';

const ME_KEY = ['auth', 'me'] as const;
const TWO_FACTOR_KEY = ['auth', '2fa', 'status'] as const;

/**
 * Which sub-task is open. `rows` is the calm default — two lines, nothing
 * expanded — so the screen only ever asks one thing at a time.
 */
type Panel = 'rows' | 'pin' | 'totp' | 'codes';

function pinErrorMessage(t: TranslateFn, err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return t('firstrun.security.pin.rateLimited');
    if (err.status >= 500) return t('common.genericError');
  }
  return t('firstrun.security.pin.failed');
}

function totpErrorMessage(t: TranslateFn, err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return t('firstrun.security.twoFactor.rateLimited');
    if (err.status >= 500) return t('common.genericError');
  }
  return t('firstrun.security.twoFactor.invalidCode');
}

/**
 * Step 3 — the second lock. Both offers are the REAL flows, not stand-ins:
 * the PIN writes through `PUT /auth/pin` (argon2id-hashed server-side exactly
 * like a password) and the authenticator through `POST /auth/2fa/enroll` +
 * `/confirm`, the same endpoints Settings → Security drives.
 *
 * Two deliberate choices:
 *
 *  - **Each is independently skippable.** Neither is required to continue; the
 *    step reports `complete` if either lock is on (set here or already enabled)
 *    and `skipped` otherwise.
 *  - **Recovery codes are never swallowed.** Enabling the first 2FA method is
 *    the only moment the server ever hands them out, so the panel switches to
 *    showing them and the user has to dismiss that view deliberately. Dropping
 *    them to keep the wizard short would be a real lockout risk.
 *
 * In-panel actions are `secondary` on purpose: the frame's Continue is the one
 * gold CTA on the screen.
 */
export function SecurityStep({ report }: FirstRunStepProps) {
  const t = useT();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [panel, setPanel] = useState<Panel>('rows');
  const [pin, setPinValue] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  // `setPin` returns the fresh `me`, but the AuthContext user is only refreshed
  // on the next bootstrap — track the local truth so the row flips immediately.
  const [pinJustSet, setPinJustSet] = useState(false);

  const twoFactor = useQuery({
    queryKey: TWO_FACTOR_KEY,
    queryFn: ({ signal }) => getTwoFactorStatus(signal),
    staleTime: 30_000,
    retry: false,
  });

  const pinOn = pinJustSet || user?.pinEnabled === true;
  const totpOn = twoFactor.data?.totpEnabled === true || twoFactor.data?.emailEnabled === true;

  const savePin = useMutation({
    mutationFn: () => setPin({ pin }),
    onSuccess: (me) => {
      queryClient.setQueryData(ME_KEY, me);
      setPinJustSet(true);
      setPinValue('');
      setConfirmPin('');
      setPanel('rows');
    },
    onError: (err) => setError(pinErrorMessage(t, err)),
  });

  const enroll = useMutation({
    mutationFn: enrollTwoFactor,
    onError: () => setError(t('firstrun.security.twoFactor.enrollError')),
  });

  const confirm = useMutation({
    mutationFn: () => confirmTwoFactor({ code }),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: TWO_FACTOR_KEY });
      setCode('');
      // The one and only moment the recovery codes exist client-side.
      if (data.recoveryCodes && data.recoveryCodes.length > 0) {
        setRecoveryCodes(data.recoveryCodes);
        setPanel('codes');
      } else {
        setPanel('rows');
      }
    },
    onError: (err) => setError(totpErrorMessage(t, err)),
  });

  const busy = savePin.isPending || confirm.isPending;

  useEffect(() => {
    report({ status: pinOn || totpOn ? 'complete' : 'skipped', busy });
  }, [report, pinOn, totpOn, busy]);

  function openPin() {
    setError(null);
    setPinValue('');
    setConfirmPin('');
    setPanel('pin');
  }

  function openTotp() {
    setError(null);
    setCode('');
    setPanel('totp');
    enroll.mutate();
  }

  function submitPin() {
    setError(null);
    if (pin !== confirmPin) {
      setError(t('firstrun.security.pin.mismatch'));
      return;
    }
    savePin.mutate();
  }

  /**
   * Enter belongs to the open sub-task, not to the wizard: the frame's form
   * would otherwise advance the step out from under a half-finished PIN.
   */
  function runOnEnter(run: () => void) {
    return (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      run();
    };
  }

  const backToRows = (
    <Button type="button" variant="ghost" onClick={() => setPanel('rows')}>
      {t('common.back')}
    </Button>
  );

  if (panel === 'pin') {
    return (
      <div className="flex flex-col gap-4" onKeyDown={runOnEnter(submitPin)}>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <PinInput
          label={t('firstrun.security.pin.newLabel')}
          length={PIN_LENGTH}
          value={pin}
          onChange={setPinValue}
          autoFocus
          disabled={savePin.isPending}
        />
        <PinInput
          label={t('firstrun.security.pin.confirmLabel')}
          length={PIN_LENGTH}
          value={confirmPin}
          onChange={setConfirmPin}
          disabled={savePin.isPending}
        />
        <div className="flex flex-wrap gap-2.5">
          <Button
            type="button"
            variant="secondary"
            onClick={submitPin}
            disabled={
              savePin.isPending || pin.length !== PIN_LENGTH || confirmPin.length !== PIN_LENGTH
            }
          >
            {savePin.isPending ? t('common.saving') : t('firstrun.security.pin.save')}
          </Button>
          {backToRows}
        </div>
      </div>
    );
  }

  if (panel === 'totp') {
    return (
      <div className="flex flex-col gap-4" onKeyDown={runOnEnter(() => confirm.mutate())}>
        {error ? <Alert tone="error">{error}</Alert> : null}
        {enroll.data ? (
          <>
            <p className="bt-soft text-sm">{t('firstrun.security.twoFactor.scan')}</p>
            {/* A QR needs a light quiet zone to scan against the dark canvas. */}
            <div className="self-start rounded-md bg-white p-3">
              <QRCodeSVG
                value={enroll.data.otpauthUri}
                size={152}
                marginSize={0}
                aria-label={t('firstrun.security.twoFactor.qrAria')}
              />
            </div>
            <details>
              <summary className="bt-meta cursor-pointer">
                {t('firstrun.security.twoFactor.manualToggle')}
              </summary>
              <code className="bt-num mt-2 block break-all text-xs">{enroll.data.secret}</code>
            </details>
            <PinInput
              label={t('firstrun.security.twoFactor.codeLabel')}
              length={TOTP_CODE_LENGTH}
              value={code}
              onChange={setCode}
              autoFocus
              disabled={confirm.isPending}
            />
          </>
        ) : (
          <p className="bt-muted text-sm">{t('common.loading')}</p>
        )}
        <div className="flex flex-wrap gap-2.5">
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setError(null);
              confirm.mutate();
            }}
            disabled={confirm.isPending || code.length !== TOTP_CODE_LENGTH}
          >
            {confirm.isPending ? t('common.saving') : t('firstrun.security.twoFactor.confirm')}
          </Button>
          {backToRows}
        </div>
      </div>
    );
  }

  if (panel === 'codes' && recoveryCodes) {
    return (
      <div className="flex flex-col gap-4">
        <Alert tone="success">{t('firstrun.security.twoFactor.enabled')}</Alert>
        <p className="bt-soft text-sm">{t('firstrun.security.recoveryCodes.description')}</p>
        <ul className="bt-num grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
          {recoveryCodes.map((recoveryCode) => (
            <li key={recoveryCode}>{recoveryCode}</li>
          ))}
        </ul>
        <div>
          <Button type="button" variant="secondary" onClick={() => setPanel('rows')}>
            {t('firstrun.security.recoveryCodes.saved')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="bt-fr__row">
        <div>
          <div className="bt-fr__rowlabel">{t('firstrun.security.pin.title')}</div>
          <p className="bt-fr__rowsub">{t('firstrun.security.pin.description')}</p>
        </div>
        {pinOn ? (
          <Badge tone="pos">{t('firstrun.security.on')}</Badge>
        ) : (
          <Button type="button" variant="secondary" onClick={openPin}>
            {t('firstrun.security.setUp')}
          </Button>
        )}
      </div>
      <div className="bt-fr__row">
        <div>
          <div className="bt-fr__rowlabel">{t('firstrun.security.twoFactor.title')}</div>
          <p className="bt-fr__rowsub">{t('firstrun.security.twoFactor.description')}</p>
        </div>
        {totpOn ? (
          <Badge tone="pos">{t('firstrun.security.on')}</Badge>
        ) : (
          <Button type="button" variant="secondary" onClick={openTotp}>
            {t('firstrun.security.setUp')}
          </Button>
        )}
      </div>
    </div>
  );
}
