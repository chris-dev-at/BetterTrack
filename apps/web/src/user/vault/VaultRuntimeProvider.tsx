import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { VAULT_FORMAT_VERSION } from '@bettertrack/contracts';

import { createIndexedDbVaultCustody, type DeviceVaultCustody } from './custody';
import {
  createDriveDataHome,
  createGoogleDriveTokenClient,
  type DriveDataHome,
  type DriveAuthorizationState,
  type GoogleDriveTokenClient,
} from './drive';
import { VaultCryptoError } from './errors';
import { createLocalDataHome } from './localDataHome';
import { clearLocalVaultScope } from './localDataHome';
import { VaultLockCore } from './lock';
import type { DriveConnectionController } from './media/driveConnection';
import {
  createUnlockedVaultDriveRuntime,
  type UnlockedVaultDriveRuntime,
  type UnlockedVaultDriveRuntimeOptions,
  type VaultDriveSyncCoordinator,
} from './media/runtime';
import { createServerBlobDataHome } from './serverBlobDataHome';
import type { DataHome } from './dataHome';
import type { VaultSyncState } from './sync';
import { VAULT_LOCK_REQUEST_EVENT } from './lockSignal';
import { equalBytes } from './bytes';
import { zeroBytes } from './bytes';
import {
  changeVaultPassphrase as rewrapVaultPassphrase,
  rotateVaultKey as reencryptWithRotatedKey,
} from './rekey';
import { serializeRecoveryKit, type RecoveryKitDownload } from './recovery';
import {
  VaultRuntimeContext,
  type VaultDriveUnlockOptions,
  type VaultRuntime,
} from './VaultRuntimeContext';

export {
  useOptionalVaultRuntime,
  useVaultRuntime,
  type VaultDriveUnlockOptions,
  type VaultRuntime,
} from './VaultRuntimeContext';

const KEY_ID_STORAGE_PREFIX = 'bettertrack:vault-key:';
const CUSTODY_DEVICE_STORAGE_PREFIX = 'bettertrack:vault-custody-device:';
const LOCK_SIGNAL_STORAGE_PREFIX = 'bettertrack:vault-lock:';
const DEVICE_LOCKED_STORAGE_PREFIX = 'bettertrack:vault-device-locked:';

export interface VaultRuntimeProviderDependencies {
  clientId?: string | null;
  custody?: DeviceVaultCustody;
  tokens?: GoogleDriveTokenClient;
  drive?: DriveDataHome;
  server?: DataHome;
  readEnvelope?: (userId: string) => Promise<Uint8Array>;
  createRuntime?: (
    vaultKey: Parameters<typeof createUnlockedVaultDriveRuntime>[0],
    keyId: string,
    options: UnlockedVaultDriveRuntimeOptions,
  ) => UnlockedVaultDriveRuntime;
}

/**
 * Production owner for the unlocked vault-key lifecycle. A successful unlock
 * installs the Drive/media/sync composition through this exact core; leaving
 * the authenticated shell removes both the key and browser-only Drive token.
 */
export function VaultRuntimeProvider({
  authenticated,
  userId = null,
  dependencies,
  children,
}: {
  authenticated: boolean;
  userId?: string | null;
  dependencies?: VaultRuntimeProviderDependencies;
  children: ReactNode;
}) {
  const [core] = useState(
    () => new VaultLockCore({ custody: dependencies?.custody ?? createIndexedDbVaultCustody() }),
  );
  const [connection, setConnection] = useState<DriveConnectionController | null>(null);
  const [sync, setSync] = useState<VaultDriveSyncCoordinator | null>(null);
  const [phase, setPhase] = useState<'locked' | 'unlocking' | 'unlocked'>('locked');
  const [driveAuthorization, setDriveAuthorization] =
    useState<DriveAuthorizationState>('consent-required');
  const [syncState, setSyncState] = useState<VaultSyncState | null>(null);
  const runtimeRef = useRef<UnlockedVaultDriveRuntime | null>(null);
  const operationGenerationRef = useRef(0);
  const tokensRef = useRef<GoogleDriveTokenClient | null>(dependencies?.tokens ?? null);
  const driveRef = useRef<{ userId: string; home: DriveDataHome } | null>(null);

  const clientId =
    dependencies?.clientId === undefined
      ? (import.meta.env.VITE_GOOGLE_DRIVE_CLIENT_ID?.trim() ?? null)
      : dependencies.clientId;

  const tokens = useCallback(
    (requireConfigured = false): GoogleDriveTokenClient => {
      if (requireConfigured && !clientId) {
        throw new VaultCryptoError('locked', 'Google Drive is not configured for this deployment.');
      }
      tokensRef.current ??= createGoogleDriveTokenClient({ clientId: clientId ?? '' });
      return tokensRef.current;
    },
    [clientId],
  );

  const drive = useCallback(
    (accountId: string, requireConfigured = false): DriveDataHome => {
      if (requireConfigured && !clientId) {
        throw new VaultCryptoError('locked', 'Google Drive is not configured for this deployment.');
      }
      if (dependencies?.drive) return dependencies.drive;
      if (driveRef.current?.userId !== accountId) {
        driveRef.current = {
          userId: accountId,
          home: createDriveDataHome({ accountId, tokens: tokens(requireConfigured) }),
        };
      }
      return driveRef.current.home;
    },
    [clientId, dependencies?.drive, tokens],
  );

  const lock = useCallback(
    async (options: { broadcast?: boolean } = {}) => {
      operationGenerationRef.current += 1;
      // Revoke every plaintext seam before the first await. The gate can paint
      // in the same React turn while IndexedDB custody cleanup finishes.
      setPhase('locked');
      setConnection(null);
      setSync(null);
      setSyncState(null);
      runtimeRef.current?.dispose();
      runtimeRef.current = null;
      driveRef.current = null;
      tokensRef.current?.clear();
      setDriveAuthorization('consent-required');
      if (options.broadcast !== false && userId != null) {
        rememberDeviceLocked(userId);
        broadcastLock(userId);
      }
      // Plaintext access is already synchronously revoked. A browser storage
      // failure must not become an unhandled rejection; the persistent lock
      // marker above also prevents a stale custody key from reopening the vault.
      await core.lock(userId == null ? undefined : custodyDeviceId(userId)).catch(() => undefined);
    },
    [core, userId],
  );

  useLayoutEffect(() => {
    if (!authenticated) void lock();
    return () => {
      void lock({ broadcast: false });
    };
  }, [authenticated, lock, userId]);

  // Manual lock in one tab immediately revokes the decrypted session in every
  // other tab for the same account. The signal contains no secret or money.
  useEffect(() => {
    if (!authenticated || userId == null) return;
    const key = `${LOCK_SIGNAL_STORAGE_PREFIX}${userId}`;
    const onStorage = (event: StorageEvent) => {
      if (event.key === key) void lock({ broadcast: false });
    };
    globalThis.addEventListener('storage', onStorage);
    return () => globalThis.removeEventListener('storage', onStorage);
  }, [authenticated, lock, userId]);

  useEffect(() => {
    const onRequest = () => {
      void lock();
    };
    globalThis.addEventListener(VAULT_LOCK_REQUEST_EVENT, onRequest);
    return () => globalThis.removeEventListener(VAULT_LOCK_REQUEST_EVENT, onRequest);
  }, [lock]);

  useEffect(() => {
    if (connection == null || sync == null) return;
    const refresh = () => {
      let next: VaultSyncState | null;
      try {
        next = sync.state;
      } catch {
        next = null;
      }
      // The replica coordinator hands out a fresh `{ ...state }` snapshot on
      // every read, so storing it unconditionally would re-render every
      // `useVaultRuntime()` consumer once a second for as long as the vault is
      // unlocked. Its fields ARE stable references, so returning the previous
      // state when nothing moved lets React bail out of the render entirely.
      setSyncState((previous) => (sameSyncState(previous, next) ? previous : next));
      setDriveAuthorization(connection.authorization);
    };
    refresh();
    const unsubscribe = connection.subscribeAuthorization(refresh);
    const timer = globalThis.setInterval(refresh, 1_000);
    globalThis.addEventListener('online', refresh);
    globalThis.addEventListener('offline', refresh);
    return () => {
      unsubscribe();
      globalThis.clearInterval(timer);
      globalThis.removeEventListener('online', refresh);
      globalThis.removeEventListener('offline', refresh);
    };
  }, [connection, sync]);

  const runUnlock = useCallback(
    async (
      unlockOptions: VaultDriveUnlockOptions,
      unlockCore: (envelope: Uint8Array, deviceId: string) => Promise<void>,
    ): Promise<DriveConnectionController> => {
      if (!authenticated || userId == null) {
        throw new VaultCryptoError('locked', 'An authenticated vault owner is required.');
      }

      const operationGeneration = operationGenerationRef.current + 1;
      operationGenerationRef.current = operationGeneration;
      const ownerId = userId;
      const needsDrive = unlockOptions.authorizeDrive || unlockOptions.driveOnly;
      const tokenClient = tokens(needsDrive);
      const driveHome = drive(ownerId, needsDrive);
      const deviceId = custodyDeviceId(ownerId);
      let installed: UnlockedVaultDriveRuntime | null = null;
      setPhase('unlocking');
      const requireCurrentOperation = () => {
        if (operationGenerationRef.current !== operationGeneration) {
          throw new VaultCryptoError('locked', 'Vault unlock was cancelled.');
        }
      };
      try {
        // Start GIS authorization before any storage/KDF await so this remains
        // attached to the explicit Connect/Sign-in/Disconnect user gesture.
        if (unlockOptions.authorizeDrive) {
          const authorized = await tokenClient.authorize();
          if (authorized.status !== 'ok') {
            throw new VaultCryptoError('locked', authorized.message);
          }
          requireCurrentOperation();
        }

        const envelope = unlockOptions.driveOnly
          ? await readDriveEnvelope(driveHome, requireCurrentOperation)
          : await (
              dependencies?.readEnvelope ??
              ((accountId) =>
                readProductionEnvelope(
                  accountId,
                  dependencies?.server ?? createServerBlobDataHome(),
                  requireCurrentOperation,
                ))
            )(ownerId);
        requireCurrentOperation();
        await unlockCore(envelope, deviceId);
        requireCurrentOperation();

        installed = await core.withVaultKey((vaultKey, keyId) =>
          (dependencies?.createRuntime ?? createUnlockedVaultDriveRuntime)(vaultKey, keyId, {
            userId: ownerId,
            clientId: clientId ?? '',
            tokens: tokenClient,
            drive: driveHome,
            server: dependencies?.server,
          }),
        );
        requireCurrentOperation();
        runtimeRef.current?.dispose();
        runtimeRef.current = installed;
        await installed.ready;
        requireCurrentOperation();

        if (core.state.status === 'unlocked') rememberKeyId(ownerId, core.state.keyId);
        setConnection(installed.controller);
        setSync(installed.sync);
        setSyncState(installed.syncState);
        setDriveAuthorization(installed.controller.authorization);
        setPhase('unlocked');
        return installed.controller;
      } catch (cause) {
        installed?.dispose();
        if (runtimeRef.current === installed) runtimeRef.current = null;
        if (operationGenerationRef.current === operationGeneration) {
          operationGenerationRef.current += 1;
          setConnection(null);
          setSync(null);
          setSyncState(null);
          runtimeRef.current?.dispose();
          runtimeRef.current = null;
          tokenClient.clear();
          setDriveAuthorization('consent-required');
          setPhase('locked');
          await core.lock(deviceId);
        }
        throw cause;
      }
    },
    [
      authenticated,
      clientId,
      core,
      dependencies?.createRuntime,
      dependencies?.readEnvelope,
      dependencies?.server,
      drive,
      tokens,
      userId,
    ],
  );

  const unlockWithPassphrase = useCallback(
    async (passphrase: string, unlockOptions: VaultDriveUnlockOptions) => {
      const unlocked = await runUnlock(unlockOptions, (envelope, deviceId) =>
        core.unlockWithPassphrase(
          envelope,
          passphrase,
          undefined,
          unlockOptions.keepUnlocked === true,
          deviceId,
        ),
      );
      if (userId != null && unlockOptions.keepUnlocked === true) forgetDeviceLocked(userId);
      return unlocked;
    },
    [core, runUnlock, userId],
  );

  const unlockWithRecoveryKit = useCallback(
    async (recoveryKit: Uint8Array, unlockOptions: VaultDriveUnlockOptions) => {
      const unlocked = await runUnlock(unlockOptions, (envelope, deviceId) =>
        core.unlockWithRecoveryKit(
          envelope,
          recoveryKit,
          unlockOptions.keepUnlocked === true,
          deviceId,
        ),
      );
      if (userId != null && unlockOptions.keepUnlocked === true) forgetDeviceLocked(userId);
      return unlocked;
    },
    [core, runUnlock, userId],
  );

  const unlockFromDevice = useCallback(
    async (unlockOptions: Omit<VaultDriveUnlockOptions, 'keepUnlocked'>): Promise<boolean> => {
      if (userId == null || isDeviceLocked(userId)) return false;
      try {
        await runUnlock(unlockOptions, (envelope, deviceId) =>
          core.unlockFromDevice(deviceId, envelope),
        );
        return true;
      } catch {
        return false;
      }
    },
    [core, runUnlock, userId],
  );

  const reconnect = useCallback(async (): Promise<VaultSyncState> => {
    if (runtimeRef.current == null) {
      throw new VaultCryptoError('locked', 'Vault is locked.');
    }
    const state = await runtimeRef.current.reconnect();
    setSyncState(state);
    return state;
  }, []);

  const authorizeDriveStorage = useCallback(async (): Promise<DataHome> => {
    if (!authenticated || userId == null) {
      throw new VaultCryptoError('locked', 'An authenticated vault owner is required.');
    }
    const tokenClient = tokens(true);
    const authorized = await tokenClient.authorize();
    setDriveAuthorization(tokenClient.state);
    if (authorized.status !== 'ok') {
      throw new VaultCryptoError('locked', authorized.message);
    }
    return drive(userId, true);
  }, [authenticated, drive, tokens, userId]);

  const cleanupAfterDisable = useCallback(async (): Promise<void> => {
    if (userId == null) return;
    const active = runtimeRef.current?.sync.state.active ?? null;
    // Resolve the Drive home the same way the `drive` accessor does: an
    // injected dependency first, the built ref second. Reading `driveRef`
    // directly skipped the injected seam — the accessor never populates the
    // ref when `dependencies.drive` exists — so the composed boundary double
    // (PD9) saw no delete while production, which always builds the ref, did.
    const driveHome =
      dependencies?.drive ?? (driveRef.current?.userId === userId ? driveRef.current.home : null);
    if (active != null && driveHome != null) {
      try {
        const replicas = await driveHome.observeReplicas();
        await replicas.deleteIfUnchanged(async (observations) =>
          observations.every(
            (observation) =>
              observation.status === 'ok' && equalBytes(observation.envelope, active.envelope),
          ),
        );
      } catch {
        // Disable already committed. Drive cleanup is explicitly best-effort.
      }
    }
    const keyId = core.state.status === 'unlocked' ? core.state.keyId : rememberedKeyId(userId);
    if (keyId != null) {
      await clearLocalVaultScope(`vault:${userId}:${keyId}`).catch(() => undefined);
    }
    forgetKeyId(userId);
    await lock();
  }, [core, dependencies?.drive, lock, userId]);

  const downloadRecoveryKit = useCallback(
    () =>
      core.withVaultKey((vaultKey, keyId) => {
        if (!(vaultKey instanceof Uint8Array)) {
          throw new VaultCryptoError(
            'custody-failed',
            'Enter the vault passphrase before exporting a new recovery kit.',
          );
        }
        return serializeRecoveryKit({
          keyId,
          vaultKey,
          formatVersion: VAULT_FORMAT_VERSION,
        });
      }),
    [core],
  );

  const changePassphrase = useCallback(
    async (currentPassphrase: string, nextPassphrase: string): Promise<void> => {
      const installed = runtimeRef.current;
      const active = installed?.sync.state.active;
      if (installed == null || installed.replaceEnvelope == null || active == null) {
        throw new VaultCryptoError('locked', 'Unlock the vault before changing its passphrase.');
      }
      const result = await rewrapVaultPassphrase({
        envelope: active.envelope,
        oldPassphrase: currentPassphrase,
        newPassphrase: nextPassphrase,
        metadata: nextRekeyMetadata(active.header.vaultVersion, installed.sync.deviceId),
      });
      try {
        await installed.replaceEnvelope(result.envelope);
      } finally {
        zeroBytes(result.vaultKey);
      }
      await lock();
    },
    [lock],
  );

  const rotateKey = useCallback(
    async (
      passphrase: string,
      receiveRecoveryKit: (kit: RecoveryKitDownload) => Promise<void> | void,
    ): Promise<void> => {
      const installed = runtimeRef.current;
      const active = installed?.sync.state.active;
      if (installed == null || installed.replaceEnvelope == null || active == null) {
        throw new VaultCryptoError('locked', 'Unlock the vault before rotating its key.');
      }
      const result = await reencryptWithRotatedKey({
        envelope: active.envelope,
        passphrase,
        metadata: nextRekeyMetadata(active.header.vaultVersion, installed.sync.deviceId),
      });
      try {
        await receiveRecoveryKit(
          serializeRecoveryKit({
            keyId: result.header.keyId,
            vaultKey: result.vaultKey,
            formatVersion: VAULT_FORMAT_VERSION,
          }),
        );
        await installed.replaceEnvelope(result.envelope);
        if (userId != null) rememberKeyId(userId, result.header.keyId);
      } finally {
        zeroBytes(result.vaultKey);
      }
      await lock();
    },
    [lock, userId],
  );

  const value = useMemo<VaultRuntime>(
    () => ({
      core,
      connection,
      sync,
      lockState: core.state,
      phase,
      driveAuthorization,
      syncState,
      unlockWithPassphrase,
      unlockWithRecoveryKit,
      unlockFromDevice,
      authorizeDriveStorage,
      reconnect,
      downloadRecoveryKit,
      changePassphrase,
      rotateKey,
      cleanupAfterDisable,
      lock,
    }),
    [
      connection,
      core,
      authorizeDriveStorage,
      changePassphrase,
      cleanupAfterDisable,
      downloadRecoveryKit,
      driveAuthorization,
      lock,
      phase,
      reconnect,
      rotateKey,
      sync,
      syncState,
      unlockFromDevice,
      unlockWithPassphrase,
      unlockWithRecoveryKit,
    ],
  );

  return <VaultRuntimeContext.Provider value={value}>{children}</VaultRuntimeContext.Provider>;
}

async function readDriveEnvelope(
  drive: DriveDataHome,
  requireCurrentOperation: () => void,
): Promise<Uint8Array> {
  const result = await drive.read();
  requireCurrentOperation();
  if (result.status === 'ok') return result.envelope;
  throw new VaultCryptoError(
    'locked',
    result.status === 'transport-failure'
      ? result.failure.message
      : 'No authenticated Google Drive vault envelope is available.',
  );
}

async function readProductionEnvelope(
  userId: string,
  server: DataHome,
  requireCurrentOperation: () => void,
): Promise<Uint8Array> {
  const serverResult = await server.read();
  requireCurrentOperation();
  if (serverResult.status === 'ok') return serverResult.envelope;

  // A same-device Drive-only reload can unlock from the encrypted PD5 cache.
  // A fresh device takes the explicit GIS path above instead.
  const keyId = rememberedKeyId(userId);
  if (keyId != null) {
    const local = await createLocalDataHome({ scope: `vault:${userId}:${keyId}` }).read();
    requireCurrentOperation();
    if (local.status === 'ok') return local.envelope;
  }

  throw new VaultCryptoError('locked', 'No encrypted vault envelope is available for this device.');
}

/**
 * Whether two sync snapshots describe the same state. The snapshot object is
 * recreated on every read, but `active` / `pending` are only replaced when the
 * engine actually publishes a new state, so identity on those three fields is
 * exact — nothing the UI reads can change without one of them changing.
 */
function sameSyncState(left: VaultSyncState | null, right: VaultSyncState | null): boolean {
  if (left === right) return true;
  if (left == null || right == null) return false;
  return (
    left.status === right.status &&
    left.active === right.active &&
    left.pending === right.pending &&
    left.lastFailure === right.lastFailure
  );
}

function custodyDeviceId(userId: string): string {
  const key = `${CUSTODY_DEVICE_STORAGE_PREFIX}${userId}`;
  try {
    const stored = globalThis.localStorage?.getItem(key);
    if (stored) return stored;
    const created = globalThis.crypto.randomUUID();
    globalThis.localStorage?.setItem(key, created);
    return created;
  } catch {
    return globalThis.crypto.randomUUID();
  }
}

function broadcastLock(userId: string): void {
  try {
    globalThis.localStorage?.setItem(
      `${LOCK_SIGNAL_STORAGE_PREFIX}${userId}`,
      `${Date.now()}:${globalThis.crypto.randomUUID()}`,
    );
  } catch {
    // Cross-tab propagation is best-effort; this tab is already locked.
  }
}

function rememberDeviceLocked(userId: string): void {
  try {
    globalThis.localStorage?.setItem(`${DEVICE_LOCKED_STORAGE_PREFIX}${userId}`, '1');
  } catch {
    // If persistence is unavailable, custody is unavailable too; unlock fails closed.
  }
}

function forgetDeviceLocked(userId: string): void {
  try {
    globalThis.localStorage?.removeItem(`${DEVICE_LOCKED_STORAGE_PREFIX}${userId}`);
  } catch {
    // Keeping the marker is the fail-closed outcome.
  }
}

function isDeviceLocked(userId: string): boolean {
  try {
    return globalThis.localStorage?.getItem(`${DEVICE_LOCKED_STORAGE_PREFIX}${userId}`) === '1';
  } catch {
    return true;
  }
}

function rememberKeyId(userId: string, keyId: string): void {
  try {
    globalThis.localStorage?.setItem(`${KEY_ID_STORAGE_PREFIX}${userId}`, keyId);
  } catch {
    // Non-sensitive routing metadata is optional.
  }
}

function forgetKeyId(userId: string): void {
  try {
    globalThis.localStorage?.removeItem(`${KEY_ID_STORAGE_PREFIX}${userId}`);
  } catch {
    // Optional non-sensitive routing metadata may already be unavailable.
  }
}

function rememberedKeyId(userId: string): string | null {
  try {
    return globalThis.localStorage?.getItem(`${KEY_ID_STORAGE_PREFIX}${userId}`) ?? null;
  } catch {
    return null;
  }
}

function nextRekeyMetadata(vaultVersion: number, deviceId: string) {
  return {
    vaultVersion: vaultVersion + 1,
    deviceId,
    writeId: globalThis.crypto.randomUUID(),
    writtenAt: new Date().toISOString(),
  };
}
