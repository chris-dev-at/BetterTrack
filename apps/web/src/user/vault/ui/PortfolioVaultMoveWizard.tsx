import { useState } from 'react';
import { Link } from 'react-router-dom';

import type { VaultStepUpCredential } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { Button, Field, Input, Select } from '../../../ui/origin';
import { CHECKBOX_STYLE } from '../../components/ui';

export interface VaultMovePrecondition {
  id: string;
  messageKey: string;
  fixLabelKey: string;
  fixHref: string;
}

export interface VaultMoveTarget {
  id: string;
  name: string;
}

type MoveWizardProps =
  | {
      mode: 'in';
      portfolioName: string;
      vaults: readonly VaultMoveTarget[];
      preconditions: readonly VaultMovePrecondition[];
      onCancel(): void;
      onSubmit(input: { vaultId: string; stepUp: VaultStepUpCredential }): Promise<void>;
    }
  | {
      mode: 'out';
      portfolioName: string;
      vaultName: string;
      unlocked: boolean;
      onCancel(): void;
      onSubmit(input: { stepUp: VaultStepUpCredential }): Promise<void>;
    };

export function PortfolioVaultMoveWizard(props: MoveWizardProps) {
  const t = useT();
  const [credentialKind, setCredentialKind] = useState<'password' | 'code' | 'recoveryCode'>(
    'password',
  );
  const [credential, setCredential] = useState('');
  const [vaultId, setVaultId] = useState('');
  const [serverReadableAcknowledged, setServerReadableAcknowledged] = useState(false);
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState(false);
  const blocked =
    props.mode === 'in' ? props.preconditions.length > 0 || vaultId === '' : !props.unlocked;
  const confirmationMissing = props.mode === 'out' && !serverReadableAcknowledged;

  async function submit() {
    const value = credential.trim();
    if (value === '' || blocked || confirmationMissing) return;
    setWorking(true);
    setFailed(false);
    try {
      const stepUp = { [credentialKind]: value } as VaultStepUpCredential;
      if (props.mode === 'in') await props.onSubmit({ vaultId, stepUp });
      else await props.onSubmit({ stepUp });
    } catch {
      setFailed(true);
    } finally {
      setWorking(false);
    }
  }

  return (
    <section
      aria-label={t(`vault.portfolioMove.move${props.mode === 'in' ? 'In' : 'Out'}.title`)}
      className="bt-panel flex flex-col gap-4 p-4"
    >
      <div>
        <h3 className="bt-h2">
          {t(`vault.portfolioMove.move${props.mode === 'in' ? 'In' : 'Out'}.title`)}
        </h3>
        <p className="bt-row-sub">
          {t('vault.portfolioMove.subject', {
            portfolio: props.portfolioName,
            vault:
              props.mode === 'in'
                ? (props.vaults.find((vault) => vault.id === vaultId)?.name ??
                  t('vault.portfolioMove.targetPlaceholder'))
                : props.vaultName,
          })}
        </p>
      </div>

      {props.mode === 'in' ? (
        <Field htmlFor="vault-move-target" label={t('vault.portfolioMove.targetLabel')}>
          <Select
            id="vault-move-target"
            onChange={(event) => setVaultId(event.target.value)}
            value={vaultId}
          >
            <option value="">{t('vault.portfolioMove.targetPlaceholder')}</option>
            {props.vaults.map((vault) => (
              <option key={vault.id} value={vault.id}>
                {vault.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      {props.mode === 'in' && props.preconditions.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {props.preconditions.map((precondition) => (
            <li
              className="bt-panel flex flex-wrap items-center justify-between gap-3 p-3"
              key={precondition.id}
            >
              <span className="text-sm">{t(precondition.messageKey)}</span>
              <Link className="bt-link text-sm" to={precondition.fixHref}>
                {t(precondition.fixLabelKey)}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}

      {props.mode === 'in' ? (
        <p className="bt-gold-note">{t('vault.portfolioMove.moveIn.warning')}</p>
      ) : (
        <>
          {!props.unlocked ? (
            <p className="bt-gold-note">{t('vault.portfolioMove.moveOut.unlockRequired')}</p>
          ) : null}
          <p className="bt-gold-note">{t('vault.portfolioMove.moveOut.warning')}</p>
          <label className="bt-soft flex items-start gap-2 text-sm">
            <input
              checked={serverReadableAcknowledged}
              onChange={(event) => setServerReadableAcknowledged(event.target.checked)}
              style={CHECKBOX_STYLE}
              type="checkbox"
            />
            <span>{t('vault.portfolioMove.moveOut.confirm')}</span>
          </label>
        </>
      )}

      <p className="bt-row-sub">{t('vault.portfolioMove.stepUpHint')}</p>
      <div className="grid gap-3 sm:grid-cols-[minmax(10rem,0.45fr)_1fr]">
        <Field
          htmlFor={`vault-move-credential-kind-${props.mode}`}
          label={t('vault.portfolioMove.credentialKind')}
        >
          <Select
            id={`vault-move-credential-kind-${props.mode}`}
            onChange={(event) =>
              setCredentialKind(event.target.value as 'password' | 'code' | 'recoveryCode')
            }
            value={credentialKind}
          >
            <option value="password">{t('vault.portfolioMove.credential.password')}</option>
            <option value="code">{t('vault.portfolioMove.credential.code')}</option>
            <option value="recoveryCode">{t('vault.portfolioMove.credential.recoveryCode')}</option>
          </Select>
        </Field>
        <Field
          htmlFor={`vault-move-credential-${props.mode}`}
          label={t('vault.portfolioMove.credentialValue')}
        >
          <Input
            autoComplete={credentialKind === 'password' ? 'current-password' : 'one-time-code'}
            id={`vault-move-credential-${props.mode}`}
            onChange={(event) => setCredential(event.target.value)}
            type={credentialKind === 'password' ? 'password' : 'text'}
            value={credential}
          />
        </Field>
      </div>

      {failed ? (
        <p className="bt-neg text-sm" role="alert">
          {t(`vault.portfolioMove.move${props.mode === 'in' ? 'In' : 'Out'}.error`)}
        </p>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        <Button disabled={working} onClick={props.onCancel} type="button" variant="quiet">
          {t('common.cancel')}
        </Button>
        <Button
          disabled={working || blocked || confirmationMissing || credential.trim() === ''}
          onClick={() => void submit()}
          type="button"
          variant={props.mode === 'out' ? 'danger' : 'primary'}
        >
          {working
            ? t(`vault.portfolioMove.move${props.mode === 'in' ? 'In' : 'Out'}.working`)
            : t(`vault.portfolioMove.move${props.mode === 'in' ? 'In' : 'Out'}.action`)}
        </Button>
      </div>
    </section>
  );
}
