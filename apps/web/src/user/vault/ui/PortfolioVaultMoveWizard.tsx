import { useState } from 'react';
import { Link } from 'react-router-dom';

import {
  VAULT_SERVER_CANDIDATE_TTL_MS,
  type VaultMediaList,
  type VaultStepUpCredential,
} from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { Button, Field, Input, Select } from '../../../ui/origin';
import { CHECKBOX_STYLE } from '../../components/ui';

/** Stated in the copy, derived from the server's TTL so the two cannot drift. */
const VAULT_SERVER_CANDIDATE_TTL_MINUTES = Math.round(VAULT_SERVER_CANDIDATE_TTL_MS / 60_000);

/**
 * "Drive is the ONLY medium", stated positively. `!media.includes('server')`
 * would hand the Drive-only retention copy to any future non-server medium
 * (the reserved `local`), which is not what the sentence promises.
 */
export function isDriveOnlyVaultMedia(media: VaultMediaList): boolean {
  return media.length === 1 && media[0] === 'drive';
}

export interface VaultMovePrecondition {
  id: string;
  messageKey: string;
  /**
   * The step that clears this precondition. Omitted only when there is nothing
   * the user can do about it — then the reason is still stated, and the commit
   * still stays blocked; it is never a link that leads nowhere.
   */
  fixLabelKey?: string;
  fixHref?: string;
}

export interface VaultMoveTarget {
  id: string;
  name: string;
  /**
   * Drive is the target's only medium. The move-in then leaves a short-lived,
   * inactive encrypted staging copy on the server until its TTL (#1491), and
   * the ceremony says so before the destructive step rather than after it.
   */
  driveOnly?: boolean;
}

type MoveWizardProps = {
  portfolioName: string;
  /** Blocking steps, each stated on its own row; the commit stays closed. */
  preconditions?: readonly VaultMovePrecondition[];
  onCancel(): void;
} & (
  | {
      mode: 'in';
      vaults: readonly VaultMoveTarget[];
      vaultName?: never;
      /** Per-target on this side; the chosen entry carries it. */
      driveOnly?: never;
      unlocked?: never;
      /** Lets the mount site re-derive preconditions for the chosen target. */
      onTargetChange?(vaultId: string | null): void;
      onSubmit(input: { vaultId: string; stepUp: VaultStepUpCredential }): Promise<void>;
    }
  | {
      mode: 'out';
      vaults?: never;
      vaultName: string;
      /** Drive is the source vault's only medium — see {@link VaultMoveTarget}. */
      driveOnly?: boolean;
      unlocked: boolean;
      onSubmit(input: { stepUp: VaultStepUpCredential }): Promise<void>;
    }
);

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
  const preconditions = props.preconditions ?? [];
  const blocked =
    preconditions.length > 0 || (props.mode === 'in' ? vaultId === '' : !props.unlocked);
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
            onChange={(event) => {
              setVaultId(event.target.value);
              props.onTargetChange?.(event.target.value === '' ? null : event.target.value);
            }}
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

      {preconditions.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {preconditions.map((precondition) => (
            <li
              className="bt-panel flex flex-wrap items-center justify-between gap-3 p-3"
              key={precondition.id}
            >
              <span className="text-sm">{t(precondition.messageKey)}</span>
              {precondition.fixHref && precondition.fixLabelKey ? (
                <Link className="bt-link text-sm" to={precondition.fixHref}>
                  {t(precondition.fixLabelKey)}
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {props.mode === 'in' ? (
        <>
          <p className="bt-gold-note">{t('vault.portfolioMove.moveIn.warning')}</p>
          {props.vaults.find((vault) => vault.id === vaultId)?.driveOnly ? (
            <p className="bt-row-sub">
              {t('vault.portfolioMove.moveIn.driveOnlyRetention', {
                minutes: VAULT_SERVER_CANDIDATE_TTL_MINUTES,
              })}
            </p>
          ) : null}
        </>
      ) : (
        <>
          {!props.unlocked ? (
            <p className="bt-gold-note">{t('vault.portfolioMove.moveOut.unlockRequired')}</p>
          ) : null}
          <p className="bt-gold-note">{t('vault.portfolioMove.moveOut.warning')}</p>
          {props.driveOnly ? (
            <p className="bt-row-sub">
              {t('vault.portfolioMove.moveOut.driveOnlyRetention', {
                minutes: VAULT_SERVER_CANDIDATE_TTL_MINUTES,
              })}
            </p>
          ) : null}
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
