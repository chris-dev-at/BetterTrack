import type { VaultStepUpCredential } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { Field, Input, Select } from '../../../ui/origin';

/** Which member of {@link VaultStepUpCredential} the owner is supplying. */
export type StepUpCredentialKind = 'password' | 'code' | 'recoveryCode';

/**
 * The one credential control for every paranoid-design §15 gated operation —
 * vault deletion, portfolio move-in / move-out, and the Drive
 * disconnect-with-loss acknowledgement (#1632). Shared rather than copied so a
 * new gate cannot quietly ship a weaker or differently-labelled prompt: the
 * three factors a gate accepts are decided here, once.
 *
 * It is a pure control. Collecting the value is all it does; the credential is
 * verified only server-side, inside the same account lock as the destructive
 * write.
 */
export function StepUpCredentialFields({
  id,
  credentialKind,
  credential,
  onKindChange,
  onCredentialChange,
}: {
  id: string;
  credentialKind: StepUpCredentialKind;
  credential: string;
  onKindChange(kind: StepUpCredentialKind): void;
  onCredentialChange(value: string): void;
}) {
  const t = useT();
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <Field htmlFor={`${id}-kind`} label={t('vault.portfolioMove.credentialKind')}>
        <Select
          id={`${id}-kind`}
          onChange={(event) => onKindChange(event.target.value as StepUpCredentialKind)}
          value={credentialKind}
        >
          <option value="password">{t('vault.portfolioMove.credential.password')}</option>
          <option value="code">{t('vault.portfolioMove.credential.code')}</option>
          <option value="recoveryCode">{t('vault.portfolioMove.credential.recoveryCode')}</option>
        </Select>
      </Field>
      <Field htmlFor={`${id}-value`} label={t('vault.portfolioMove.credentialValue')}>
        <Input
          autoComplete={credentialKind === 'password' ? 'current-password' : 'one-time-code'}
          id={`${id}-value`}
          onChange={(event) => onCredentialChange(event.target.value)}
          type={credentialKind === 'password' ? 'password' : 'text'}
          value={credential}
        />
      </Field>
    </div>
  );
}

/** The collected pair as the contract's one-member credential object. */
export function stepUpCredentialOf(
  kind: StepUpCredentialKind,
  value: string,
): VaultStepUpCredential {
  return { [kind]: value.trim() } as VaultStepUpCredential;
}
