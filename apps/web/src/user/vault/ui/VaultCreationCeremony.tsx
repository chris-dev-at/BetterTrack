import { useMemo, useState } from 'react';

import type { DriveConnection, VaultMedia } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import {
  Badge,
  Button,
  CheckRow,
  Choice,
  ChoiceGroup,
  Field,
  Input,
  Panel,
  Select,
  Stepper,
} from '../../../ui/origin';
import {
  createMnemonicWordChallenge,
  generateMnemonic,
  verifyMnemonicWordChallenge,
  type MnemonicWordChallenge,
} from '../bip39';
import { PER_VAULT_DRIVE_PROVISIONING_AVAILABLE } from '../capabilities';
import { VaultProvisionIncompleteError } from '../provisionErrors';

export interface VaultCreationInput {
  name: string;
  media: VaultMedia[];
  driveConnectionId: string | null;
  mnemonic: string;
  custody: 'wrapped' | 'plain';
  devicePassword?: string;
  plainRiskAcknowledged: boolean;
}

export function VaultCreationCeremony({
  connections,
  onCancel,
  onCreate,
  onCreated,
  driveProvisioningAvailable = PER_VAULT_DRIVE_PROVISIONING_AVAILABLE,
  phraseFactory = generateMnemonic,
  challengeFactory = createMnemonicWordChallenge,
}: {
  connections: readonly DriveConnection[];
  onCancel(): void;
  onCreate(input: VaultCreationInput): Promise<void>;
  onCreated(): void;
  driveProvisioningAvailable?: boolean;
  phraseFactory?: () => string;
  challengeFactory?: (mnemonic: string) => MnemonicWordChallenge;
}) {
  const t = useT();
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5 | 6>(1);
  const [name, setName] = useState('');
  const [mediaChoice, setMediaChoice] = useState<'server' | 'drive' | 'both'>('server');
  const [driveConnectionId, setDriveConnectionId] = useState('');
  const [mnemonic, setMnemonic] = useState('');
  const [challenge, setChallenge] = useState<MnemonicWordChallenge | null>(null);
  const [answer, setAnswer] = useState('');
  const [wrongWord, setWrongWord] = useState(false);
  const [lossAcknowledged, setLossAcknowledged] = useState(false);
  const [custody, setCustody] = useState<'wrapped' | 'plain'>('wrapped');
  const [devicePassword, setDevicePassword] = useState('');
  const [plainRiskAcknowledged, setPlainRiskAcknowledged] = useState(false);
  const [working, setWorking] = useState(false);
  // Two different failures, two different next steps: nothing was created and a
  // retry is right, or an empty vault was left behind and a retry would add a
  // second one instead of finishing the first.
  const [failure, setFailure] = useState<{ key: string; leftoverVault?: string } | null>(null);

  const words = useMemo(() => (mnemonic === '' ? [] : mnemonic.split(' ')), [mnemonic]);
  const needsDrive = mediaChoice !== 'server';
  const media: VaultMedia[] =
    mediaChoice === 'both' ? ['server', 'drive'] : [mediaChoice === 'drive' ? 'drive' : 'server'];

  function nextFromMedia() {
    if (needsDrive && driveConnectionId === '') return;
    const phrase = phraseFactory();
    setMnemonic(phrase);
    setStep(3);
  }

  function beginVerification() {
    setChallenge(challengeFactory(mnemonic));
    setAnswer('');
    setWrongWord(false);
    setStep(4);
  }

  function verifyWord() {
    if (!challenge || !verifyMnemonicWordChallenge(mnemonic, challenge, answer)) {
      setWrongWord(true);
      return;
    }
    setWrongWord(false);
    setStep(5);
  }

  async function create() {
    if (
      !lossAcknowledged ||
      (custody === 'wrapped' && devicePassword.length === 0) ||
      (custody === 'plain' && !plainRiskAcknowledged)
    ) {
      return;
    }
    setWorking(true);
    setFailure(null);
    try {
      await onCreate({
        name: name.trim(),
        media,
        driveConnectionId: needsDrive ? driveConnectionId : null,
        mnemonic,
        custody,
        devicePassword: custody === 'wrapped' ? devicePassword : undefined,
        plainRiskAcknowledged,
      });
      onCreated();
    } catch (error) {
      setFailure(
        error instanceof VaultProvisionIncompleteError
          ? { key: 'vault.creation.errorIncomplete', leftoverVault: error.vaultName }
          : { key: 'vault.creation.error' },
      );
    } finally {
      setWorking(false);
    }
  }

  return (
    <section aria-label={t('vault.creation.title')} className="bt-panel flex flex-col gap-4 p-4">
      {/* The same dot stepper the portfolio and import wizards wear, so a
          six-step ceremony reads as one of this app's flows rather than a bare
          "Step 3 of 6" label above a heading. */}
      <Stepper
        current={step}
        label={t('vault.creation.step', { current: step, total: 6 })}
        title={t(`vault.creation.steps.${step}`)}
        total={6}
      />

      {step === 1 ? (
        <Field htmlFor="vault-create-name" label={t('vault.creation.nameLabel')}>
          <Input
            autoFocus
            id="vault-create-name"
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
        </Field>
      ) : null}

      {step === 2 ? (
        <div className="flex flex-col gap-3">
          <ChoiceGroup label={t('vault.creation.steps.2')}>
            {(['server', 'both', 'drive'] as const).map((choice) => {
              const unavailable = choice !== 'server' && !driveProvisioningAvailable;
              return (
                <Choice
                  description={t(`vault.creation.media.${choice}`)}
                  disabled={unavailable}
                  key={choice}
                  muted={unavailable}
                  name="vault-create-media"
                  note={unavailable ? t('vault.creation.media.driveSoon') : undefined}
                  onSelect={() => setMediaChoice(choice)}
                  selected={mediaChoice === choice}
                  title={t(`vault.manager.media.${choice}`)}
                />
              );
            })}
          </ChoiceGroup>
          {needsDrive ? (
            <Field htmlFor="vault-create-drive" label={t('vault.creation.driveConnectionLabel')}>
              <Select
                id="vault-create-drive"
                onChange={(event) => setDriveConnectionId(event.target.value)}
                value={driveConnectionId}
              >
                <option value="">{t('vault.creation.driveConnectionPlaceholder')}</option>
                {connections.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connection.displayName
                      ? `${connection.displayName} · ${connection.email}`
                      : connection.email}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
        </div>
      ) : null}

      {step === 3 ? (
        <div className="flex flex-col gap-3">
          <p className="bt-gold-note">{t('vault.creation.wordsHint')}</p>
          {/* The one screen a user is asked to copy by hand. On its own surface,
              with the ordinals ranged right, the twelve words read as a block to
              transcribe rather than as loose text in a form. */}
          <Panel className="p-3" pad={false} soft>
            <ol className="grid grid-cols-2 gap-x-5 gap-y-1.5 sm:grid-cols-3">
              {words.map((word, index) => (
                <li className="flex items-baseline gap-2" key={`${index}-${word}`}>
                  <span className="bt-muted bt-num shrink-0 text-xs tabular-nums">
                    {index + 1}.
                  </span>
                  <span className="bt-num text-sm">{word}</span>
                </li>
              ))}
            </ol>
          </Panel>
        </div>
      ) : null}

      {step === 4 && challenge ? (
        <div className="flex flex-col gap-3">
          <Field
            htmlFor="vault-create-word"
            label={t('vault.creation.verifyLabel', { word: challenge.wordNumber })}
          >
            <Input
              autoComplete="off"
              autoFocus
              id="vault-create-word"
              onChange={(event) => {
                setAnswer(event.target.value);
                setWrongWord(false);
              }}
              value={answer}
            />
          </Field>
          {wrongWord ? (
            <p className="bt-neg text-sm" role="alert">
              {t('vault.creation.verifyWrong')}
            </p>
          ) : null}
        </div>
      ) : null}

      {step === 5 ? (
        <div className="flex flex-col gap-3">
          <Panel className="p-3" pad={false} soft>
            <p className="bt-soft text-sm">{t('vault.creation.lossContrast')}</p>
          </Panel>
          <CheckRow
            aria-label={t('vault.creation.lossAcknowledgment')}
            checked={lossAcknowledged}
            onChange={setLossAcknowledged}
            tone="gold"
          >
            {t('vault.creation.lossAcknowledgment')}
          </CheckRow>
        </div>
      ) : null}

      {step === 6 ? (
        <div className="flex flex-col gap-3">
          {/* The custody choice used to be ONE visible option plus a
              `<summary className="bt-link">Advanced device custody</summary>`
              hiding the other. A choice with a hidden branch is not a choice —
              and hiding this particular branch was worse than useless, since a
              user who wants it goes looking and a user who does not is not
              protected by a fold. Both options are on the page now: the
              unwrapped one carries its own "advanced" mark, muted ink and its
              warning, which de-emphasises it far more honestly than concealment
              did. */}
          <ChoiceGroup label={t('vault.creation.steps.6')}>
            <Choice
              description={t('vault.creation.custody.wrappedHint')}
              name="vault-create-custody"
              onSelect={() => setCustody('wrapped')}
              selected={custody === 'wrapped'}
              title={t('vault.creation.custody.wrapped')}
            />
            <Choice
              badge={<Badge outline>{t('vault.creation.custody.plainOption')}</Badge>}
              description={t('vault.creation.custody.plainWarning')}
              muted
              name="vault-create-custody"
              onSelect={() => setCustody('plain')}
              selected={custody === 'plain'}
              title={t('vault.creation.custody.plain')}
            />
          </ChoiceGroup>
          {custody === 'wrapped' ? (
            <Field htmlFor="vault-device-password" label={t('vault.creation.devicePassword')}>
              <Input
                autoComplete="new-password"
                id="vault-device-password"
                onChange={(event) => setDevicePassword(event.target.value)}
                type="password"
                value={devicePassword}
              />
            </Field>
          ) : null}
          {custody === 'plain' ? (
            <CheckRow
              checked={plainRiskAcknowledged}
              onChange={setPlainRiskAcknowledged}
              tone="gold"
            >
              {t('vault.creation.custody.plainAcknowledgment')}
            </CheckRow>
          ) : null}
          {failure ? (
            <p className="bt-neg text-sm" role="alert">
              {t(failure.key, { name: failure.leftoverVault ?? '' })}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        <Button disabled={working} onClick={onCancel} type="button" variant="quiet">
          {t('common.cancel')}
        </Button>
        {step > 1 ? (
          <Button
            disabled={working}
            onClick={() => setStep((step - 1) as 1 | 2 | 3 | 4 | 5 | 6)}
            type="button"
            variant="quiet"
          >
            {t('common.back')}
          </Button>
        ) : null}
        {step === 1 ? (
          <Button disabled={name.trim().length === 0} onClick={() => setStep(2)} type="button">
            {t('common.continue')}
          </Button>
        ) : step === 2 ? (
          <Button
            disabled={needsDrive && driveConnectionId === ''}
            onClick={nextFromMedia}
            type="button"
          >
            {t('common.continue')}
          </Button>
        ) : step === 3 ? (
          <Button onClick={beginVerification} type="button">
            {t('vault.creation.wordsStored')}
          </Button>
        ) : step === 4 ? (
          <Button disabled={answer.trim().length === 0} onClick={verifyWord} type="button">
            {t('vault.creation.verifyAction')}
          </Button>
        ) : step === 5 ? (
          <Button disabled={!lossAcknowledged} onClick={() => setStep(6)} type="button">
            {t('common.continue')}
          </Button>
        ) : (
          <Button
            disabled={
              working ||
              (custody === 'wrapped' && devicePassword.length === 0) ||
              (custody === 'plain' && !plainRiskAcknowledged)
            }
            onClick={() => void create()}
            type="button"
          >
            {working ? t('vault.creation.creating') : t('vault.creation.create')}
          </Button>
        )}
      </div>
    </section>
  );
}
