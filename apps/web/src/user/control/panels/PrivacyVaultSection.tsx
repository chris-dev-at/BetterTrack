import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';

import { useQueryClient } from '@tanstack/react-query';

import { passwordSchema } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { deliverClientDownload } from '../../vault/export/deliver';
import { useVaultMoneySession } from '../../vault/engine/VaultMoneyEngineContext';
import { hasUnambiguousBranch, type VaultSyncStatus } from '../../vault/sync';
import type { VaultRuntime } from '../../vault/VaultRuntimeContext';
import { disableUnlockedVault } from '../../vault/ui/disable';
import { CHECKBOX_STYLE } from '../../components/ui';
import { Button, Field, Input } from '../../../ui/origin';
import type { Notice } from './PrivacyPanel';
import { PanelFold, PanelForm, PanelGroup, PanelNote, Row } from './panelKit';
import { VaultTransferActions } from './VaultTransferActions';

const OFF_KEYS = ['sharing', 'publicProfile', 'serverAnalytics', 'imports', 'automation'] as const;

/**
 * Everything Control Center → Privacy shows to an ALREADY paranoid account:
 * storage, recovery kit, passphrase/key rotation and the two destructive
 * flows. Its own module because it is the only half of the panel that needs
 * the vault money session and the disable transition — `PrivacyPanel` reaches
 * it through `lazy()`, so a normal account flipping discreet mode never
 * downloads the client-encryption stack (#1089).
 */
export function PrivacyVaultSection({
  accountId,
  mediaSet,
  onDisabled,
  onNotice,
  restoreOpen,
  runtime,
}: {
  accountId: string | null;
  mediaSet: readonly string[];
  /** Runs after the server committed disable — flips the cached mode. */
  onDisabled(): Promise<void>;
  onNotice(notice: Notice): void;
  restoreOpen: boolean;
  runtime: VaultRuntime;
}) {
  const t = useT();
  const money = useVaultMoneySession();
  const queryClient = useQueryClient();

  return (
    <>
      <PanelGroup label={t('vault.settings.title')}>
        <Row
          hint={t('vault.settings.mediaHint')}
          label={t(`vault.settings.media.${mediaLabel(mediaSet)}`)}
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
        <VaultRestoreEntry open={restoreOpen} onNotice={onNotice} runtime={runtime} />
      </PanelGroup>

      <VaultSecurityActions onNotice={onNotice} runtime={runtime} />

      <VaultDestructiveActions
        accountId={accountId}
        document={money?.sync.state.active?.document ?? null}
        syncStatus={money?.sync.state.status ?? null}
        onDisabled={onDisabled}
        onNotice={onNotice}
        // Through the store's delete idiom, never a raw document rewrite:
        // an entity-union merge reads tombstones, not absence, so a
        // second device would otherwise resurrect the whole vault on its
        // next unlock. The same mutation seeds one empty default portfolio
        // so the emptied vault stays usable and still disable-able
        // (see `VaultPortfolioStore.discardAllData`).
        onStartFresh={async () => {
          if (money == null) throw new Error('locked');
          await money.store.discardAllData();
          // Every cached read still describes rows that are now
          // tombstoned, so drop the lot: what the app shows afterwards is
          // the single seeded portfolio, not a list of dead ids.
          await queryClient.invalidateQueries();
        }}
      />
    </>
  );
}

function VaultRestoreEntry({
  open,
  runtime,
  onNotice,
}: {
  open: boolean;
  runtime: VaultRuntime;
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
  runtime: VaultRuntime;
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

      <VaultTransferActions onNotice={onNotice} />

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
  syncStatus,
  onDisabled,
  onNotice,
  onStartFresh,
}: {
  accountId: string | null;
  document: Parameters<typeof disableUnlockedVault>[0] | null;
  // The real union, not `string`: the single-branch predicate below is only a
  // guard if a status that no longer exists fails to compile.
  syncStatus: VaultSyncStatus | null;
  onDisabled(): Promise<void>;
  onNotice(notice: Notice): void;
  onStartFresh(): Promise<void>;
}) {
  const t = useT();
  const [freshConfirmed, setFreshConfirmed] = useState(false);
  const [disableConfirmed, setDisableConfirmed] = useState(false);
  const [working, setWorking] = useState(false);
  // Disable rehydrates the ACTIVE branch and the server then drops the blob and
  // its history, so a split the user has not resolved would lose the other side
  // for good. Same single-branch predicate the unlocked session initializes on.
  const disableBlocked = !hasUnambiguousBranch(syncStatus);

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
    if (accountId == null || document == null || disableBlocked) return;
    setWorking(true);
    onNotice(null);
    try {
      await disableUnlockedVault(document, accountId);
    } catch {
      onNotice({ tone: 'error', key: 'vault.settings.disableError' });
      setWorking(false);
      return;
    }
    // Past this line the server has COMMITTED the rehydration — the account is
    // already normal and the ciphertext is gone. Post-commit cleanup therefore
    // sits OUTSIDE the guarded try: `vault.settings.disableError` says "your
    // data is still encrypted", and it must never appear once that is false.
    // `working` deliberately stays true — the mode flip unmounts this subtree.
    try {
      await onDisabled();
    } catch {
      // Best-effort local tidying (Drive delete, cache wipe). The transition
      // stands regardless; the next mount re-resolves the mode from the server.
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
          {disableBlocked ? <PanelNote warn>{t('vault.settings.disableBlocked')}</PanelNote> : null}
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
            disabled={
              working ||
              !disableConfirmed ||
              document == null ||
              accountId == null ||
              disableBlocked
            }
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
