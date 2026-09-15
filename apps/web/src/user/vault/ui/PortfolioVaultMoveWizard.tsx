import { useState } from 'react';

import {
  VAULT_SERVER_CANDIDATE_TTL_MS,
  type VaultMediaList,
  type VaultStepUpCredential,
} from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import {
  Badge,
  Button,
  CheckRow,
  Field,
  Input,
  LinkButton,
  Panel,
  Select,
} from '../../../ui/origin';
import { PortfolioMoveCaptureError } from '../portfolioMoveCapture';

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
  /**
   * The one refusal that must not read as "try again" (#1530). Everything else
   * this ceremony can fail with is either transient or clears on a retry with a
   * fresh readback; `VAULT_MEDIA_CAPTURE_IN_FLIGHT` clears only when SOMEBODY
   * finishes or cancels another portfolio's move, so the copy names those
   * portfolios and the commit button stays shut behind it.
   */
  const [blockedByMove, setBlockedByMove] = useState<readonly string[] | null>(null);
  const preconditions = props.preconditions ?? [];
  const blocked =
    preconditions.length > 0 || (props.mode === 'in' ? vaultId === '' : !props.unlocked);
  const confirmationMissing = props.mode === 'out' && !serverReadableAcknowledged;

  async function submit() {
    const value = credential.trim();
    if (value === '' || blocked || confirmationMissing) return;
    setWorking(true);
    setFailed(false);
    setBlockedByMove(null);
    try {
      const stepUp = { [credentialKind]: value } as VaultStepUpCredential;
      if (props.mode === 'in') await props.onSubmit({ vaultId, stepUp });
      else await props.onSubmit({ stepUp });
    } catch (cause) {
      if (
        cause instanceof PortfolioMoveCaptureError &&
        cause.code === 'VAULT_MOVE_CAPTURE_IN_FLIGHT'
      ) {
        setBlockedByMove(cause.blockingPortfolios);
      } else {
        setFailed(true);
      }
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

      {/* The blockers, as a checklist. Every row here is by definition unmet —
          the mount site only passes what still stands in the way — so each
          carries the same "needed" mark, its sentence, and the ONE step that
          clears it. A precondition with no fix keeps the mark and the sentence
          and simply offers nothing: it is never a link that leads nowhere. */}
      {preconditions.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {preconditions.map((precondition) => (
            <li key={precondition.id}>
              <Panel className="flex flex-wrap items-center justify-between gap-3 p-3" pad={false}>
                <span className="flex min-w-0 items-start gap-2.5">
                  <Badge tone="neg">{t('vault.portfolioMove.preconditionBlocked')}</Badge>
                  <span className="bt-soft min-w-0 text-sm">{t(precondition.messageKey)}</span>
                </span>
                {precondition.fixHref && precondition.fixLabelKey ? (
                  <LinkButton size="sm" to={precondition.fixHref} variant="quiet">
                    {t(precondition.fixLabelKey)}
                  </LinkButton>
                ) : null}
              </Panel>
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
          <CheckRow
            checked={serverReadableAcknowledged}
            onChange={setServerReadableAcknowledged}
            tone="gold"
          >
            {t('vault.portfolioMove.moveOut.confirm')}
          </CheckRow>
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
      {blockedByMove ? (
        <p className="bt-neg text-sm" role="alert">
          {blockedByMove.length > 0
            ? t('vault.portfolioMove.moveIn.captureInFlight', {
                portfolios: blockedByMove.join(', '),
              })
            : t('vault.portfolioMove.moveIn.captureInFlightUnnamed')}
        </p>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        <Button disabled={working} onClick={props.onCancel} type="button" variant="quiet">
          {t('common.cancel')}
        </Button>
        <Button
          disabled={
            working ||
            blocked ||
            confirmationMissing ||
            credential.trim() === '' ||
            blockedByMove !== null
          }
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
