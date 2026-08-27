import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  PARANOID_TRANSITION_ERROR_CODES,
  passwordSchema,
  vaultMediaSetSchema,
  type VaultMediaSet,
} from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { ApiError, markRateLimitHandledLocally } from '../../../lib/apiClient';
import { apiPortfolioStore } from '../../../lib/portfolioStore';
import { enableParanoidMode } from '../../../lib/userApi';
import { Button, CHECKBOX_STYLE, TextField } from '../../components/ui';
import { useAuth } from '../../AuthContext';
import { deliverClientDownload } from '../export/deliver';
import { createServerBlobDataHome } from '../serverBlobDataHome';
import { useVaultRuntime } from '../VaultRuntimeProvider';
import type { DataHome } from '../dataHome';
import {
  enablePreparedVault,
  prepareVaultMaterial,
  VaultEnableError,
  type PreparedVaultMaterial,
  type VaultEnableStage,
} from './enable';
import { captureNormalVault, VaultCaptureUnstableError } from './migration';

const KILL_LIST_KEYS = [
  'sharing',
  'serverReads',
  'imports',
  'automation',
  'publicProfile',
] as const;

interface EnableErrorCopy {
  key: string;
  vars?: Record<string, string | number>;
}

type DrivePreparationState = 'idle' | 'preparing' | 'ready' | 'failed';

export function ParanoidEnableWizard({
  onCancel,
  onEnabled,
}: {
  onCancel(): void;
  onEnabled(receipt: Awaited<ReturnType<typeof enablePreparedVault>>['receipt']): void;
}) {
  const t = useT();
  const { user } = useAuth();
  const runtime = useVaultRuntime();
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [includeDrive, setIncludeDrive] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [driveOnly, setDriveOnly] = useState(false);
  const [drive, setDrive] = useState<DataHome | null>(null);
  const [drivePreparation, setDrivePreparation] = useState<DrivePreparationState>('idle');
  const [authorizingDrive, setAuthorizingDrive] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [material, setMaterial] = useState<PreparedVaultMaterial | null>(null);
  const [kitDownloaded, setKitDownloaded] = useState(false);
  const [kitStored, setKitStored] = useState(false);
  const [lostKeyAcknowledged, setLostKeyAcknowledged] = useState(false);
  const [stage, setStage] = useState<VaultEnableStage | null>(null);
  const [captureCompletedRequests, setCaptureCompletedRequests] = useState(0);
  const [error, setError] = useState<EnableErrorCopy | null>(null);
  const drivePreparationGeneration = useRef(0);
  const enableOperationGeneration = useRef(0);

  const mediaSet = useMemo<VaultMediaSet>(
    () =>
      vaultMediaSetSchema.parse(
        driveOnly ? ['drive'] : includeDrive ? ['server', 'drive'] : ['server'],
      ),
    [driveOnly, includeDrive],
  );
  const passphraseValid =
    passwordSchema.safeParse(passphrase).success && passphrase === confirmation;
  const driveSelected = mediaSet.includes('drive');

  useEffect(
    () => () => {
      // A Google popup cannot be cancelled, but its result must never revive a
      // wizard that was dismissed while the popup was open. In particular, the
      // captured material is zeroed during unmount, so continuing would make a
      // vault from disposed key material.
      enableOperationGeneration.current += 1;
    },
    [],
  );

  useEffect(
    () => () => {
      material?.dispose();
    },
    [material],
  );

  function resetMaterial() {
    enableOperationGeneration.current += 1;
    material?.dispose();
    setMaterial(null);
    setKitDownloaded(false);
    setKitStored(false);
    setLostKeyAcknowledged(false);
  }

  const prepareDrive = useCallback(() => {
    const generation = ++drivePreparationGeneration.current;
    setDrive(null);
    setError(null);
    setDrivePreparation('preparing');
    void runtime
      .prepareDriveStorage()
      .then(() => {
        if (drivePreparationGeneration.current !== generation) return;
        setDrivePreparation('ready');
      })
      .catch(() => {
        if (drivePreparationGeneration.current !== generation) return;
        setDrive(null);
        setDrivePreparation('failed');
        setError({ key: 'vault.enable.errors.drivePreparation' });
      });
  }, [runtime.prepareDriveStorage]);

  useEffect(() => {
    if (!driveSelected) {
      drivePreparationGeneration.current += 1;
      setDrive(null);
      setDrivePreparation('idle');
      return;
    }
    prepareDrive();
    return () => {
      drivePreparationGeneration.current += 1;
    };
  }, [driveSelected, prepareDrive]);

  async function authorizeDrive() {
    if (drivePreparation !== 'ready') return;
    setError(null);
    setAuthorizingDrive(true);
    // Invoke the runtime before the first await so GIS starts from this explicit
    // medium-choice gesture, while no vault material or server transition exists.
    try {
      setDrive(await runtime.authorizeDriveStorage());
    } catch {
      setDrive(null);
      setError({ key: 'vault.enable.errors.driveAuthorization' });
    } finally {
      setAuthorizingDrive(false);
    }
  }

  async function downloadRecoveryKit() {
    setError(null);
    if (!passphraseValid) {
      setError({ key: 'vault.enable.passphraseMismatch' });
      return;
    }
    try {
      const next = material ?? (await prepareVaultMaterial(passphrase));
      if (material == null) setMaterial(next);
      deliverClientDownload(
        next.recoveryKit.bytes,
        next.recoveryKit.type,
        next.recoveryKit.filename,
      );
      setKitDownloaded(true);
    } catch {
      setError({ key: 'vault.enable.errors.encrypt' });
    }
  }

  async function enable() {
    if (
      user == null ||
      material == null ||
      !kitDownloaded ||
      !kitStored ||
      !lostKeyAcknowledged ||
      (driveSelected && drive == null)
    ) {
      return;
    }
    const selectedMaterial = material;
    const selectedMediaSet = mediaSet;
    const operationGeneration = ++enableOperationGeneration.current;
    const isCurrentOperation = () => enableOperationGeneration.current === operationGeneration;
    let selectedDrive = drive;
    if (driveSelected) {
      setAuthorizingDrive(true);
      // `authorize()` keeps an unexpired token without another popup. If the
      // early capability expired while the user protected their recovery kit,
      // this final explicit Enable gesture requests a fresh one before any
      // capture, encrypted write, or server transition starts.
      try {
        selectedDrive = await runtime.authorizeDriveStorage();
        if (!isCurrentOperation()) return;
        setDrive(selectedDrive);
      } catch {
        if (isCurrentOperation()) {
          // The early capability is no longer trustworthy. Clearing it keeps
          // step 2's Drive gate closed if the user goes back to reconnect.
          setDrive(null);
          setError({ key: 'vault.enable.errors.driveReauthorization' });
        }
        return;
      } finally {
        if (isCurrentOperation()) setAuthorizingDrive(false);
      }
    }
    if (!isCurrentOperation()) return;
    setStep(4);
    setError(null);
    setCaptureCompletedRequests(0);
    // NOT a cancel handle — nothing can abort this signal, matching the note
    // below. It exists only to tag the transition's own API calls so a 429 they
    // hit is answered by this wizard's stage copy instead of the app-wide
    // "you're doing that too fast" banner. The capture tags its own reads the
    // same way (`linkedCaptureSignal`); the commit is the only other request
    // this flow puts through `apiRequest` (both medium writes go out on raw
    // `fetch`), so between the two every stage that CAN be rate-limited is
    // covered.
    const rateLimitScope = markRateLimitHandledLocally(new AbortController().signal);
    let result: Awaited<ReturnType<typeof enablePreparedVault>>;
    try {
      // No `signal`: this transition has no cancel affordance by design — once
      // the migration is handed over, the server commit decides the outcome and
      // the wizard reports it. An AbortController nobody can trigger only reads
      // like cancellation exists.
      result = await enablePreparedVault(
        {
          mediaSet: selectedMediaSet,
          material: selectedMaterial,
          onStage: setStage,
        },
        {
          server: createServerBlobDataHome(),
          drive: driveSelected ? (selectedDrive ?? undefined) : undefined,
          migrate: (signal) =>
            captureNormalVault({
              userId: user.id,
              store: apiPortfolioStore,
              signal,
              onProgress: ({ completedRequests }) => setCaptureCompletedRequests(completedRequests),
            }),
          commit: (body) => enableParanoidMode(body, rateLimitScope),
        },
      );
    } catch (cause) {
      setError(enableErrorCopy(cause));
      return;
    }

    // The server transaction has committed. Switch the account-mode gate
    // immediately from the receipt; an authoritative refresh can follow in
    // the background without ever remounting normal portfolio endpoints.
    // This also ends this component: the paranoid branch swaps the whole
    // authenticated subtree (wizard, Privacy panel, its success notice) for
    // `VaultUnlockGate` while the automatic unlock below runs, so §13's "done"
    // half is shown THERE — see the hand-off note in `VaultUnlockGate`. The
    // order is not negotiable: unlocking first would leave the cached mode at
    // 'normal' with a decrypted session live, which `AccountModeRoot` revokes
    // on sight as a cross-device disable.
    onEnabled(result.receipt);
    try {
      await runtime.unlockWithPassphrase(passphrase, {
        authorizeDrive: false,
        driveOnly: selectedMediaSet.length === 1 && selectedMediaSet[0] === 'drive',
        keepUnlocked: false,
      });
    } catch {
      // The committed account remains paranoid and the normal unlock gate now
      // owns retry/error copy. Never rewrite this as a pre-commit failure.
      await runtime.lock({ broadcast: false });
    } finally {
      // Keep the envelope live only through the verified transition/unlock.
      result.envelope.fill(0);
      material.dispose();
    }
  }

  return (
    <div aria-label={t('vault.enable.title')} className="bt-panel flex flex-col gap-4 p-4">
      <div>
        <p className="bt-label">{t('vault.enable.step', { current: step, total: 4 })}</p>
        <h3 className="bt-h2">{t(`vault.enable.steps.${step}.title`)}</h3>
      </div>

      {step === 1 ? (
        <>
          <p className="bt-soft text-sm">{t('vault.enable.changesIntro')}</p>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {KILL_LIST_KEYS.map((key) => (
              <li key={key}>{t(`vault.enable.killList.${key}`)}</li>
            ))}
          </ul>
          <p className="bt-muted text-xs">{t('vault.enable.keptSummary')}</p>
        </>
      ) : null}

      {step === 2 ? (
        <div className="flex flex-col gap-3">
          <label className="bt-panel flex items-start gap-3 p-3">
            <input
              checked={!driveOnly}
              disabled={authorizingDrive}
              onChange={() => {
                setDriveOnly(false);
                setError(null);
              }}
              type="radio"
            />
            <span>
              <span className="bt-row-title">{t('vault.enable.media.server.title')}</span>
              <span className="bt-row-sub block">{t('vault.enable.media.server.body')}</span>
            </span>
          </label>
          {!driveOnly ? (
            <label className="bt-soft flex items-start gap-2 text-sm">
              <input
                checked={includeDrive}
                disabled={authorizingDrive}
                onChange={(event) => {
                  setIncludeDrive(event.target.checked);
                  setError(null);
                }}
                style={CHECKBOX_STYLE}
                type="checkbox"
              />
              <span>{t('vault.enable.media.driveCopy')}</span>
            </label>
          ) : null}
          {/* The Drive-only radio lives inside this fold. Collapsing it while
              Drive-only is the selection would leave the step with NO visible
              checked radio (the server radio renders `checked={!driveOnly}`),
              so the fold stays open until another medium is chosen. */}
          <details
            onToggle={(event) =>
              setAdvanced((event.currentTarget as HTMLDetailsElement).open || driveOnly)
            }
            open={advanced || driveOnly}
          >
            <summary className="bt-link cursor-pointer text-sm">
              {t('vault.enable.media.advanced')}
            </summary>
            <label className="bt-panel mt-2 flex items-start gap-3 p-3">
              <input
                checked={driveOnly}
                disabled={authorizingDrive}
                onChange={() => {
                  setDriveOnly(true);
                  setIncludeDrive(true);
                  setError(null);
                }}
                type="radio"
              />
              <span>
                <span className="bt-row-title">{t('vault.enable.media.driveOnly.title')}</span>
                <span className="bt-row-sub block">{t('vault.enable.media.driveOnly.body')}</span>
              </span>
            </label>
          </details>
          {driveSelected ? (
            <div aria-live="polite" className="bt-soft flex flex-col gap-2 p-3 text-sm">
              <p>
                {drivePreparation === 'idle' || drivePreparation === 'preparing'
                  ? t('vault.enable.media.preparingDrive')
                  : drive == null
                    ? t('vault.enable.media.driveAuthorizationRequired')
                    : t('vault.enable.media.driveConnected')}
              </p>
              <div>
                <Button
                  disabled={
                    authorizingDrive ||
                    drivePreparation === 'idle' ||
                    drivePreparation === 'preparing'
                  }
                  onClick={() =>
                    void (drivePreparation === 'failed' ? prepareDrive() : authorizeDrive())
                  }
                  variant="secondary"
                >
                  {authorizingDrive
                    ? t('vault.enable.media.connectingDrive')
                    : drivePreparation === 'idle' || drivePreparation === 'preparing'
                      ? t('vault.enable.media.preparingDrive')
                      : drivePreparation === 'failed'
                        ? t('vault.enable.media.retryDrivePreparation')
                        : drive == null
                          ? t('vault.enable.media.connectDrive')
                          : t('vault.enable.media.reconnectDrive')}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {step === 3 ? (
        <div className="flex flex-col gap-4">
          <p className="bt-soft text-sm">{t('vault.enable.passphraseDistinct')}</p>
          <TextField
            autoComplete="new-password"
            disabled={authorizingDrive}
            label={t('vault.enable.passphrase')}
            maxLength={MAX_PASSWORD_LENGTH}
            minLength={MIN_PASSWORD_LENGTH}
            onChange={(event) => {
              resetMaterial();
              setPassphrase(event.target.value);
            }}
            type="password"
            value={passphrase}
          />
          <TextField
            autoComplete="new-password"
            disabled={authorizingDrive}
            label={t('vault.enable.passphraseConfirm')}
            maxLength={MAX_PASSWORD_LENGTH}
            minLength={MIN_PASSWORD_LENGTH}
            onChange={(event) => {
              resetMaterial();
              setConfirmation(event.target.value);
            }}
            type="password"
            value={confirmation}
          />
          <Button
            disabled={authorizingDrive}
            onClick={() => void downloadRecoveryKit()}
            variant="secondary"
          >
            {kitDownloaded
              ? t('vault.enable.downloadAgain')
              : t('vault.enable.downloadRecoveryKit')}
          </Button>
          <label className="bt-soft flex items-start gap-2 text-sm">
            <input
              checked={kitStored}
              disabled={!kitDownloaded || authorizingDrive}
              onChange={(event) => setKitStored(event.target.checked)}
              style={CHECKBOX_STYLE}
              type="checkbox"
            />
            <span>{t('vault.enable.kitStored')}</span>
          </label>
          <label className="bt-panel flex items-start gap-2 p-3 text-sm">
            <input
              checked={lostKeyAcknowledged}
              disabled={authorizingDrive}
              onChange={(event) => setLostKeyAcknowledged(event.target.checked)}
              style={CHECKBOX_STYLE}
              type="checkbox"
            />
            <strong>{t('vault.enable.lostKeyAcknowledgment')}</strong>
          </label>
        </div>
      ) : null}

      {step === 4 ? (
        <div aria-live="polite" className="flex flex-col gap-3" role="status">
          <div className="h-1.5 overflow-hidden rounded-full bt-panel">
            <div
              className="h-full bg-[var(--bt-gold-graphic)] transition-all"
              style={{ width: `${progressForStage(stage)}%` }}
            />
          </div>
          <p className="bt-soft text-sm">
            {stage == null
              ? t('vault.enable.progress.preparing')
              : t(`vault.enable.progress.${stage}`)}
          </p>
          {stage === 'migrate' && captureCompletedRequests > 0 ? (
            <p className="bt-muted text-xs">
              {t(
                captureCompletedRequests === 1
                  ? 'vault.enable.progress.captureRequests.one'
                  : 'vault.enable.progress.captureRequests.other',
                { count: captureCompletedRequests },
              )}
            </p>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className="bt-field__error" role="alert">
          {t(error.key, error.vars)}
        </p>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        {step < 4 ? (
          <Button
            disabled={authorizingDrive}
            onClick={() => {
              if (authorizingDrive) return;
              enableOperationGeneration.current += 1;
              setAuthorizingDrive(false);
              if (step === 1) onCancel();
              else setStep((step - 1) as 1 | 2 | 3);
            }}
            variant="ghost"
          >
            {step === 1 ? t('common.cancel') : t('common.back')}
          </Button>
        ) : null}
        {step === 1 || step === 2 ? (
          <Button
            disabled={step === 2 && (authorizingDrive || (driveSelected && drive == null))}
            onClick={() => setStep((step + 1) as 2 | 3)}
          >
            {t('common.continue')}
          </Button>
        ) : null}
        {step === 3 ? (
          <Button
            disabled={
              !passphraseValid ||
              !kitDownloaded ||
              !kitStored ||
              !lostKeyAcknowledged ||
              authorizingDrive ||
              // A failed final reauthorization clears the previously connected
              // Drive home. Keep the transfer action unavailable until the user
              // returns to step 2 and reconnects it.
              (driveSelected && drive == null)
            }
            onClick={() => void enable()}
          >
            {t('vault.enable.action')}
          </Button>
        ) : null}
        {step === 4 && error ? (
          <Button
            onClick={() => {
              setError(null);
              setStage(null);
              setCaptureCompletedRequests(0);
              setStep(3);
            }}
            variant="secondary"
          >
            {t('common.retry')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function enableErrorCopy(cause: unknown): EnableErrorCopy {
  if (!(cause instanceof VaultEnableError)) return { key: 'vault.enable.errors.unknown' };
  // A 429 at ANY stage, not just the capture: the limiter answers before the
  // route runs, so the account is untouched wherever it fires — and because
  // every request this transition makes is tagged as locally handled, the
  // app-wide banner stayed silent. This copy is then the ONLY thing that names
  // the wait, so it must not be reachable only from `migrate`.
  if (cause.cause instanceof ApiError && cause.cause.status === 429) {
    return cause.cause.retryAfterSeconds == null
      ? { key: 'vault.enable.errors.rateLimitedUnknown' }
      : {
          key: 'vault.enable.errors.rateLimited',
          vars: { seconds: cause.cause.retryAfterSeconds },
        };
  }
  // The capture gave up because the account kept moving under it. Generic
  // "collection failed, retry when the connection recovers" copy would send the
  // user straight back into the same loop; name the other writer instead.
  if (cause.cause instanceof VaultCaptureUnstableError) {
    return { key: 'vault.enable.errors.captureUnstable' };
  }
  if (cause.stage === 'commit' && cause.cause instanceof ApiError) {
    switch (cause.cause.code) {
      case PARANOID_TRANSITION_ERROR_CODES.mirrorchainActive:
        return { key: 'vault.enable.errors.mirrorchainActive' };
      case PARANOID_TRANSITION_ERROR_CODES.importInFlight:
        return { key: 'vault.enable.errors.importInFlight' };
      case PARANOID_TRANSITION_ERROR_CODES.exportInFlight:
        return { key: 'vault.enable.errors.exportInFlight' };
      case PARANOID_TRANSITION_ERROR_CODES.mediaNotReady:
        return { key: 'vault.enable.errors.mediaNotReady' };
      case PARANOID_TRANSITION_ERROR_CODES.transitionConflict:
        return { key: 'vault.enable.errors.transitionConflict' };
      case PARANOID_TRANSITION_ERROR_CODES.normalDataChanged:
        return { key: 'vault.enable.errors.normalDataChanged' };
    }
  }
  return { key: `vault.enable.errors.${cause.stage}` };
}

function progressForStage(stage: VaultEnableStage | null): number {
  switch (stage) {
    case null:
      return 5;
    case 'migrate':
      return 20;
    case 'validate':
      return 30;
    case 'encrypt':
      return 40;
    case 'write-server':
    case 'write-drive':
      return 60;
    case 'verify-server':
    case 'verify-drive':
      return 80;
    case 'commit':
      return 95;
  }
}
