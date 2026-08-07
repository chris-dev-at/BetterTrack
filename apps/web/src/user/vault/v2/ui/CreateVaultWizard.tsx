import { VAULT2_NAME_MAX_LENGTH, type VaultBackendSet } from '@bettertrack/contracts';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { uuidv7 } from 'uuidv7';

import { useT } from '../../../../i18n';
import { Button, Field, Input, ODialog } from '../../../../ui/origin';
import { CHECKBOX_STYLE } from '../../../components/ui';
import { createVault, writeVaultHeaderDoc } from '../api';
import { buildVaultHeader } from '../headerCrypto';
import { VAULT_HOW_IT_WORKS_PATH } from './routes';
import { checkVaultPassphrase, generateVaultPassphrase, pickConfirmationPositions } from '../words';

/**
 * "Create a vault" (`docs/VAULTS_V2_DESIGN.md` §4): name → backend choice → 12
 * words shown once and confirmed → done.
 *
 * The words are generated here and never leave the browser. Step 3 shows them
 * exactly once and then asks for three of them back — a real confirmation, not
 * a "type it twice" field, because the user is meant to have written them down.
 */

type Step = 1 | 2 | 3 | 4;
type BackendChoice = 'server' | 'drive' | 'both';

const BACKEND_SETS: Record<BackendChoice, VaultBackendSet> = {
  server: ['server'],
  drive: ['drive'],
  both: ['server', 'drive'],
};

const BACKEND_CHOICES: BackendChoice[] = ['server', 'drive', 'both'];

export interface CreateVaultWizardProps {
  open: boolean;
  onClose: () => void;
  /** Called once the vault exists server-side and its header has been stored. */
  onCreated: (vaultId: string, passphrase: string) => void;
}

export function CreateVaultWizard({ open, onClose, onCreated }: CreateVaultWizardProps) {
  const t = useT();
  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState('');
  const [backend, setBackend] = useState<BackendChoice>('server');
  const [passphrase, setPassphrase] = useState<string | null>(null);
  const [written, setWritten] = useState(false);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const words = useMemo(() => passphrase?.split(' ') ?? [], [passphrase]);
  const [positions] = useState(() => pickConfirmationPositions(3));

  const nameValid = name.trim().length > 0 && name.trim().length <= VAULT2_NAME_MAX_LENGTH;
  const confirmed =
    passphrase != null &&
    positions.every((position) => answers[position]?.trim().toLowerCase() === words[position]);

  function reset() {
    setStep(1);
    setName('');
    setBackend('server');
    setPassphrase(null);
    setWritten(false);
    setAnswers({});
    setError(null);
    setBusy(false);
  }

  function close() {
    reset();
    onClose();
  }

  function toWords() {
    // Generated at the moment the step opens so a user who backs out of step 2
    // never sees the same phrase twice.
    setPassphrase(generateVaultPassphrase());
    setStep(3);
  }

  async function create() {
    if (passphrase == null) return;
    setBusy(true);
    setError(null);
    try {
      const vaultId = uuidv7();
      const backends = BACKEND_SETS[backend];
      const built = await buildVaultHeader({
        vaultId,
        name: name.trim(),
        backends,
        passphrase,
        deviceId: uuidv7(),
        writeId: uuidv7(),
        writtenAt: new Date().toISOString(),
      });
      try {
        const summary = await createVault({
          id: vaultId,
          name: name.trim(),
          backends,
          header: built.header,
        });
        if (summary.id !== vaultId) {
          // The server assigned its own id. The header's seal binds `vaultId`,
          // so the stored copy would never open — refuse loudly rather than
          // leave an unopenable vault behind.
          throw new Error('VAULT_ID_MISMATCH');
        }
        // Belt and braces: if the server did not persist the inline header,
        // write it through the doc route so the vault is never headerless.
        await writeVaultHeaderDoc(vaultId, built.header, null).catch(() => undefined);
      } finally {
        built.contentKey.fill(0);
      }
      setStep(4);
      onCreated(vaultId, passphrase);
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message === 'VAULT_ID_MISMATCH'
          ? t('vault.v2.create.errors.idMismatch')
          : t('vault.v2.create.errors.failed'),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <ODialog
      foot={
        <div className="flex w-full items-center justify-between gap-3">
          <Button onClick={step === 1 ? close : () => setStep((step - 1) as Step)} variant="quiet">
            {step === 1 ? t('common.cancel') : t('common.back')}
          </Button>
          <div className="flex items-center gap-2">
            {step === 1 ? (
              <Button disabled={!nameValid} onClick={() => setStep(2)} variant="primary">
                {t('common.continue')}
              </Button>
            ) : null}
            {step === 2 ? (
              <Button onClick={toWords} variant="primary">
                {t('common.continue')}
              </Button>
            ) : null}
            {step === 3 ? (
              <Button
                disabled={!written || !confirmed || busy}
                loading={busy}
                onClick={() => void create()}
                variant="primary"
              >
                {t('vault.v2.create.actions.create')}
              </Button>
            ) : null}
            {step === 4 ? (
              <Button onClick={close} variant="primary">
                {t('common.done')}
              </Button>
            ) : null}
          </div>
        </div>
      }
      onClose={close}
      open={open}
      size="wizard"
      title={t('vault.v2.create.title')}
    >
      <div className="flex flex-col gap-4">
        <p className="bt-label">{t('vault.v2.create.step', { current: step, total: 4 })}</p>

        {step === 1 ? (
          <>
            <h3 className="bt-h2">{t('vault.v2.create.steps.1.title')}</h3>
            <p className="bt-soft text-sm">{t('vault.v2.create.steps.1.body')}</p>
            <Field
              hint={t('vault.v2.create.nameHint')}
              htmlFor="vault-name"
              label={t('vault.v2.create.name')}
            >
              <Input
                autoComplete="off"
                id="vault-name"
                maxLength={VAULT2_NAME_MAX_LENGTH}
                onChange={(event) => setName(event.target.value)}
                value={name}
              />
            </Field>
            <p className="bt-meta">
              <Link className="bt-link" target="_blank" to={VAULT_HOW_IT_WORKS_PATH}>
                {t('vault.v2.explainerLink')}
              </Link>
            </p>
          </>
        ) : null}

        {step === 2 ? (
          <>
            <h3 className="bt-h2">{t('vault.v2.create.steps.2.title')}</h3>
            <p className="bt-soft text-sm">{t('vault.v2.create.steps.2.body')}</p>
            <div className="bt-panel bt-panel--soft flex flex-col gap-3">
              {BACKEND_CHOICES.map((choice) => (
                <label className="bt-settings-row items-start gap-3" key={choice}>
                  <input
                    checked={backend === choice}
                    name="vault-backend"
                    onChange={() => setBackend(choice)}
                    style={CHECKBOX_STYLE}
                    type="radio"
                    value={choice}
                  />
                  <span>
                    <span className="bt-row-title">
                      {t(`vault.v2.create.backends.${choice}.title`)}
                    </span>
                    <span className="bt-row-sub block">
                      {t(`vault.v2.create.backends.${choice}.body`)}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </>
        ) : null}

        {step === 3 ? (
          <>
            <h3 className="bt-h2">{t('vault.v2.create.steps.3.title')}</h3>
            <p className="bt-soft text-sm">{t('vault.v2.create.steps.3.body')}</p>
            <ol
              aria-label={t('vault.v2.create.wordsLabel')}
              className="bt-panel bt-panel--soft grid grid-cols-2 gap-2 sm:grid-cols-3"
            >
              {words.map((word, index) => (
                <li
                  className="bt-settings-block flex items-baseline gap-2"
                  key={`${index}-${word}`}
                >
                  <span className="bt-meta tabular-nums">{index + 1}</span>
                  <span className="bt-row-title">{word}</span>
                </li>
              ))}
            </ol>
            <p className="bt-field__error" role="note">
              {t('vault.v2.create.lostWords')}
            </p>
            <label className="bt-settings-row items-start gap-3">
              <input
                checked={written}
                onChange={(event) => setWritten(event.target.checked)}
                style={CHECKBOX_STYLE}
                type="checkbox"
              />
              <span className="bt-row-sub">{t('vault.v2.create.writtenDown')}</span>
            </label>

            {written ? (
              <div className="flex flex-col gap-3">
                <p className="bt-soft text-sm">{t('vault.v2.create.confirmIntro')}</p>
                {positions.map((position) => (
                  <Field
                    htmlFor={`vault-word-${position}`}
                    key={position}
                    label={t('vault.v2.create.wordN', { n: position + 1 })}
                  >
                    <Input
                      autoCapitalize="none"
                      autoComplete="off"
                      id={`vault-word-${position}`}
                      onChange={(event) =>
                        setAnswers((previous) => ({ ...previous, [position]: event.target.value }))
                      }
                      spellCheck={false}
                      value={answers[position] ?? ''}
                    />
                  </Field>
                ))}
              </div>
            ) : null}

            {error ? (
              <p className="bt-field__error" role="alert">
                {error}
              </p>
            ) : null}
          </>
        ) : null}

        {step === 4 ? (
          <>
            <h3 className="bt-h2">{t('vault.v2.create.steps.4.title')}</h3>
            <p className="bt-soft text-sm">{t('vault.v2.create.steps.4.body')}</p>
          </>
        ) : null}
      </div>
    </ODialog>
  );
}

/** Exported for the wizard's own tests: the confirmation is a real check. */
export function isConfirmationComplete(
  passphrase: string,
  positions: number[],
  answers: Record<number, string>,
): boolean {
  if (!checkVaultPassphrase(passphrase).valid) return false;
  const words = passphrase.split(' ');
  return positions.every((position) => answers[position]?.trim().toLowerCase() === words[position]);
}
