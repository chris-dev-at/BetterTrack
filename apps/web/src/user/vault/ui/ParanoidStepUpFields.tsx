import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { MAX_PASSWORD_LENGTH, type ParanoidTransitionCredential } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { getTwoFactorStatus } from '../../../lib/twoFactorApi';
import { TextField } from '../../components/ui';

/** Compact account-password/TOTP chooser shared by enable and disable. */
export function ParanoidStepUpFields({
  disabled = false,
  idPrefix,
  onChange,
}: {
  disabled?: boolean;
  idPrefix: string;
  onChange(credential: ParanoidTransitionCredential | null): void;
}) {
  const t = useT();
  const [mode, setMode] = useState<'password' | 'code'>('password');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const twoFactor = useQuery({
    queryKey: ['auth', '2fa', 'status'],
    queryFn: ({ signal }) => getTwoFactorStatus(signal),
    staleTime: 30_000,
    retry: false,
  });
  const codeAvailable = twoFactor.data?.totpEnabled === true;

  useEffect(() => {
    if (mode !== 'code' || codeAvailable) return;
    setMode('password');
    onChange(password.length > 0 ? { password } : null);
  }, [codeAvailable, mode, onChange, password]);

  const choose = (next: 'password' | 'code') => {
    setMode(next);
    onChange(
      next === 'code'
        ? code.trim().length > 0
          ? { code: code.trim() }
          : null
        : password.length > 0
          ? { password }
          : null,
    );
  };

  return (
    <div className="flex flex-col gap-2">
      {mode === 'code' && codeAvailable ? (
        <TextField
          autoComplete="one-time-code"
          disabled={disabled}
          id={`${idPrefix}-code`}
          inputMode="numeric"
          label={t('vault.stepUp.codeLabel')}
          maxLength={16}
          onChange={(event) => {
            const next = event.target.value;
            setCode(next);
            onChange(next.trim().length > 0 ? { code: next.trim() } : null);
          }}
          value={code}
        />
      ) : (
        <TextField
          autoComplete="current-password"
          disabled={disabled}
          id={`${idPrefix}-password`}
          label={t('vault.stepUp.passwordLabel')}
          maxLength={MAX_PASSWORD_LENGTH}
          onChange={(event) => {
            const next = event.target.value;
            setPassword(next);
            onChange(next.length > 0 ? { password: next } : null);
          }}
          type="password"
          value={password}
        />
      )}
      <p className="bt-muted text-xs">{t('vault.stepUp.hint')}</p>
      {codeAvailable ? (
        <button
          className="bt-link self-start text-xs"
          disabled={disabled}
          onClick={() => choose(mode === 'code' ? 'password' : 'code')}
          type="button"
        >
          {t(mode === 'code' ? 'vault.stepUp.usePassword' : 'vault.stepUp.useCode')}
        </button>
      ) : null}
    </div>
  );
}
