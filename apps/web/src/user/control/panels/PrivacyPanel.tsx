import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { passwordSchema } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { deliverClientDownload } from '../../vault/export/deliver';
import { useVaultMoneySession } from '../../vault/engine/VaultMoneyEngineProvider';
import { usePrivacyMode } from '../../vault/usePrivacyMode';
import { useVaultRuntime } from '../../vault/VaultRuntimeProvider';
import { ParanoidEnableWizard } from '../../vault/ui/ParanoidEnableWizard';
import { disableUnlockedVault } from '../../vault/ui/disable';
import { Alert, CHECKBOX_STYLE } from '../../components/ui';
import { Button, Field, Input, Switch } from '../../../ui/origin';
import { useAuth } from '../../AuthContext';
import { PanelFold, PanelForm, PanelGroup, PanelHead, PanelNote, Row } from './panelKit';

const OFF_KEYS = ['sharing', 'publicProfile', 'serverAnalytics', 'imports', 'automation'] as const;

type Notice = { tone: 'error' | 'success' | 'info'; key: string } | null;

/** Control Center → Privacy: the compact entry point for both privacy modes. */
export function PrivacyPanel() {
  const t = useT();
  const { user, toggleDiscreetMode } = useAuth();
  const privacy = usePrivacyMode(true, user?.id ?? null);
  const runtime = useVaultRuntime();
  const money = useVaultMoneySession();
  const [searchParams] = useSearchParams();
  const [wizard, setWizard] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const discreet = user?.discreetMode === true;

  return (
    <div className="bt-cc-panel">
      <PanelHead title={t('control.privacy')} />

      <PanelGroup>
        <Row hint={t('privacy.discreet.body')} label={t('privacy.discreet.title')}>
          <Switch
            aria-label={t('privacy.discreet.title')}
            checked={discreet}
            onChange={() => {
              void toggleDiscreetMode().catch(() => undefined);
            }}
          />
        </Row>
      </PanelGroup>

      {notice ? <Alert tone={notice.tone}>{t(notice.key)}</Alert> : null}

      {privacy.privacyMode === 'normal' ? (
        wizard ? (
          <ParanoidEnableWizard
            onCancel={() => setWizard(false)}
            onEnabled={(receipt) => {
              privacy.acceptEnabled(receipt);
              setNotice({ tone: 'success', key: 'vault.enable.done' });
              void privacy.refetch();
            }}
          />
        ) : (
          <PanelGroup label={t('vault.settings.title')}>
            <Row hint={t('vault.settings.normalHint')} label={t('vault.settings.normal')}>
              <Button onClick={() => setWizard(true)} size="sm" variant="primary">
                {t('vault.settings.enable')}
              </Button>
            </Row>
          </PanelGroup>
        )
      ) : null}

      {privacy.privacyMode === 'paranoid' && privacy.mediaState != null ? (
        <>
          <PanelGroup label={t('vault.settings.title')}>
            <Row
              hint={t('vault.settings.mediaHint')}
              label={t(`vault.settings.media.${mediaLabel(privacy.mediaState.mediaSet)}`)}
            >
              <Link className="bt-link text-sm" to="/control/connections">
                {t('vault.settings.manageMedia')}
              </Link>
            </Row>
            <PanelFold summary={t('vault.settings.whatsOff')}>
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {OFF_KEYS.map((key) => (
                  <li key={key}>{t(`vault.settings.off.${key}`)}</li>
                ))}
              </ul>
            </PanelFold>
            <VaultRestoreEntry
              open={searchParams.get('restore') === '1'}
              onNotice={setNotice}
              runtime={runtime}
            />
          </PanelGroup>

          <VaultSecurityActions onNotice={setNotice} runtime={runtime} />

          <VaultDestructiveActions
            accountId={user?.id ?? null}
            document={money?.sync.state.active?.document ?? null}
            onDisabled={async () => {
              await runtime.cleanupAfterDisable();
              privacy.acceptNormal();
              void privacy.refetch();
            }}
            onNotice={setNotice}
            onStartFresh={async () => {
              if (money == null) throw new Error('locked');
              await money.sync.mutate(({ document }) => ({
                ...document,
                entities: {},
                mergeLog: [],
              }));
            }}
          />
        </>
      ) : null}
    </div>
  );
}

function VaultRestoreEntry({
  open,
  runtime,
  onNotice,
}: {
  open: boolean;
  runtime: ReturnType<typeof useVaultRuntime>;
  onNotice(notice: Notice): void;
}) {
  const t = useT();
  const [working, setWorking] = useState(false);

  async function inspectCopies() {
    setWorking(true);
    onNotice(null);
    try {
      const state = await runtime.reconnect();
      onNotice({
        tone: state.status === 'synced' ? 'success' : 'info',
        key:
          state.status === 'synced'
            ? 'vault.settings.restore.current'
            : 'vault.settings.restore.attention',
      });
    } catch {
      onNotice({ tone: 'error', key: 'vault.settings.restore.error' });
    } finally {
      setWorking(false);
    }
  }

  return (
    <PanelFold open={open} summary={t('vault.settings.restore.title')}>
      <PanelForm>
        <PanelNote>{t('vault.settings.restore.hint')}</PanelNote>
        <Button disabled={working} onClick={() => void inspectCopies()} size="sm" type="button">
          {working ? t('vault.settings.restore.checking') : t('vault.settings.restore.check')}
        </Button>
      </PanelForm>
    </PanelFold>
  );
}

function VaultSecurityActions({
  runtime,
  onNotice,
}: {
  runtime: ReturnType<typeof useVaultRuntime>;
  onNotice(notice: Notice): void;
}) {
  const t = useT();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [rotationPassphrase, setRotationPassphrase] = useState('');
  const [rotationAcknowledged, setRotationAcknowledged] = useState(false);
  const [working, setWorking] = useState(false);

  async function downloadKit() {
    setWorking(true);
    onNotice(null);
    try {
      const kit = await runtime.downloadRecoveryKit();
      deliverClientDownload(kit.bytes, kit.type, kit.filename);
      onNotice({ tone: 'success', key: 'vault.settings.kitDownloaded' });
    } catch {
      onNotice({ tone: 'error', key: 'vault.settings.kitRequiresPassphrase' });
    } finally {
      setWorking(false);
    }
  }

  async function changePassphrase(event: FormEvent) {
    event.preventDefault();
    if (next !== confirm || !passwordSchema.safeParse(next).success) {
      onNotice({ tone: 'error', key: 'vault.settings.passphraseInvalid' });
      return;
    }
    setWorking(true);
    onNotice(null);
    try {
      await runtime.changePassphrase(current, next);
      onNotice({ tone: 'success', key: 'vault.settings.passphraseChanged' });
    } catch {
      onNotice({ tone: 'error', key: 'vault.settings.passphraseError' });
    } finally {
      setWorking(false);
    }
  }

  async function rotate(event: FormEvent) {
    event.preventDefault();
    if (!rotationAcknowledged) return;
    setWorking(true);
    onNotice(null);
    try {
      await runtime.rotateKey(rotationPassphrase, (kit) => {
        deliverClientDownload(kit.bytes, kit.type, kit.filename);
      });
      onNotice({ tone: 'success', key: 'vault.settings.rotationDone' });
    } catch {
      onNotice({ tone: 'error', key: 'vault.settings.rotationError' });
    } finally {
      setWorking(false);
    }
  }

  return (
    <PanelGroup label={t('vault.settings.security')}>
      <Row hint={t('vault.settings.recoveryHint')} label={t('vault.settings.recoveryKit')}>
        <Button disabled={working} onClick={() => void downloadKit()} size="sm">
          {t('vault.settings.downloadKit')}
        </Button>
      </Row>

      <PanelFold summary={t('vault.settings.changePassphrase')}>
        <PanelForm onSubmit={changePassphrase}>
          <PanelNote>{t('vault.settings.passphraseHint')}</PanelNote>
          <Field htmlFor="vault-current-passphrase" label={t('vault.settings.currentPassphrase')}>
            <Input
              autoComplete="current-password"
              id="vault-current-passphrase"
              onChange={(event) => setCurrent(event.target.value)}
              required
              type="password"
              value={current}
            />
          </Field>
          <Field htmlFor="vault-new-passphrase" label={t('vault.settings.newPassphrase')}>
            <Input
              autoComplete="new-password"
              id="vault-new-passphrase"
              onChange={(event) => setNext(event.target.value)}
              required
              type="password"
              value={next}
            />
          </Field>
          <Field htmlFor="vault-confirm-passphrase" label={t('vault.settings.confirmPassphrase')}>
            <Input
              autoComplete="new-password"
              id="vault-confirm-passphrase"
              onChange={(event) => setConfirm(event.target.value)}
              required
              type="password"
              value={confirm}
            />
          </Field>
          <Button disabled={working} size="sm" type="submit">
            {t('vault.settings.changeAction')}
          </Button>
        </PanelForm>
      </PanelFold>

      <PanelFold summary={t('vault.settings.rotateKey')}>
        <PanelForm onSubmit={rotate}>
          <PanelNote warn>{t('vault.settings.rotationHint')}</PanelNote>
          <Field htmlFor="vault-rotation-passphrase" label={t('vault.unlock.passphrase')}>
            <Input
              autoComplete="current-password"
              id="vault-rotation-passphrase"
              onChange={(event) => setRotationPassphrase(event.target.value)}
              required
              type="password"
              value={rotationPassphrase}
            />
          </Field>
          <label className="bt-soft flex items-start gap-2 text-sm">
            <input
              checked={rotationAcknowledged}
              onChange={(event) => setRotationAcknowledged(event.target.checked)}
              style={CHECKBOX_STYLE}
              type="checkbox"
            />
            <span>{t('vault.settings.rotationAcknowledgment')}</span>
          </label>
          <Button
            disabled={working || rotationPassphrase.length === 0 || !rotationAcknowledged}
            size="sm"
            type="submit"
            variant="danger"
          >
            {t('vault.settings.rotateAction')}
          </Button>
        </PanelForm>
      </PanelFold>
    </PanelGroup>
  );
}

function VaultDestructiveActions({
  accountId,
  document,
  onDisabled,
  onNotice,
  onStartFresh,
}: {
  accountId: string | null;
  document: Parameters<typeof disableUnlockedVault>[0] | null;
  onDisabled(): Promise<void>;
  onNotice(notice: Notice): void;
  onStartFresh(): Promise<void>;
}) {
  const t = useT();
  const [freshConfirmed, setFreshConfirmed] = useState(false);
  const [disableConfirmed, setDisableConfirmed] = useState(false);
  const [working, setWorking] = useState(false);

  async function startFresh() {
    setWorking(true);
    onNotice(null);
    try {
      await onStartFresh();
      setFreshConfirmed(false);
      onNotice({ tone: 'success', key: 'vault.settings.freshDone' });
    } catch {
      onNotice({ tone: 'error', key: 'vault.settings.freshError' });
    } finally {
      setWorking(false);
    }
  }

  async function disable() {
    if (accountId == null || document == null) return;
    setWorking(true);
    onNotice(null);
    try {
      await disableUnlockedVault(document, accountId);
      await onDisabled();
    } catch {
      onNotice({ tone: 'error', key: 'vault.settings.disableError' });
      setWorking(false);
    }
  }

  return (
    <PanelGroup label={t('vault.settings.danger')}>
      <PanelFold summary={t('vault.settings.startFresh')}>
        <PanelForm>
          <PanelNote warn>{t('vault.settings.startFreshWarning')}</PanelNote>
          <label className="bt-soft flex items-start gap-2 text-sm">
            <input
              checked={freshConfirmed}
              onChange={(event) => setFreshConfirmed(event.target.checked)}
              style={CHECKBOX_STYLE}
              type="checkbox"
            />
            <span>{t('vault.settings.startFreshConfirm')}</span>
          </label>
          <Button
            disabled={working || !freshConfirmed}
            onClick={() => void startFresh()}
            size="sm"
            type="button"
            variant="danger"
          >
            {t('vault.settings.startFreshAction')}
          </Button>
        </PanelForm>
      </PanelFold>

      <PanelFold summary={t('vault.settings.disable')}>
        <PanelForm>
          <PanelNote warn>{t('vault.settings.disableWarning')}</PanelNote>
          <label className="bt-soft flex items-start gap-2 text-sm">
            <input
              checked={disableConfirmed}
              onChange={(event) => setDisableConfirmed(event.target.checked)}
              style={CHECKBOX_STYLE}
              type="checkbox"
            />
            <span>{t('vault.settings.disableConfirm')}</span>
          </label>
          <Button
            disabled={working || !disableConfirmed || document == null || accountId == null}
            onClick={() => void disable()}
            size="sm"
            type="button"
            variant="danger"
          >
            {t('vault.settings.disableAction')}
          </Button>
        </PanelForm>
      </PanelFold>
    </PanelGroup>
  );
}

function mediaLabel(mediaSet: readonly string[]): 'server' | 'drive' | 'both' {
  if (mediaSet.length > 1) return 'both';
  return mediaSet[0] === 'drive' ? 'drive' : 'server';
}
