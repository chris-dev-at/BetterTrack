import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { createIndexedDbVaultCustody, type DeviceVaultCustody } from './custody';
import {
  createDriveDataHome,
  createGoogleDriveTokenClient,
  type DriveDataHome,
  type GoogleDriveTokenClient,
} from './drive';
import { VaultCryptoError } from './errors';
import { createLocalDataHome } from './localDataHome';
import { VaultLockCore } from './lock';
import type { DriveConnectionController } from './media/driveConnection';
import {
  createUnlockedVaultDriveRuntime,
  type UnlockedVaultDriveRuntime,
  type UnlockedVaultDriveRuntimeOptions,
} from './media/runtime';
import { createServerBlobDataHome } from './serverBlobDataHome';
import type { DataHome } from './dataHome';

const KEY_ID_STORAGE_PREFIX = 'bettertrack:vault-key:';

export interface VaultDriveUnlockOptions {
  /** Mint/reuse a browser-memory Drive token during this user gesture. */
  authorizeDrive: boolean;
  /** A fresh Drive-only device must fetch its first unlock envelope from Drive. */
  driveOnly: boolean;
}

export interface VaultRuntime {
  readonly core: VaultLockCore;
  readonly connection: DriveConnectionController | null;
  unlockWithPassphrase(
    passphrase: string,
    options: VaultDriveUnlockOptions,
  ): Promise<DriveConnectionController>;
  lock(): Promise<void>;
}

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

const VaultRuntimeContext = createContext<VaultRuntime | null>(null);

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
  const runtimeRef = useRef<UnlockedVaultDriveRuntime | null>(null);
  const operationGenerationRef = useRef(0);
  const tokensRef = useRef<GoogleDriveTokenClient | null>(dependencies?.tokens ?? null);
  const driveRef = useRef<DriveDataHome | null>(dependencies?.drive ?? null);

  const clientId =
    dependencies?.clientId === undefined
      ? (import.meta.env.VITE_GOOGLE_DRIVE_CLIENT_ID?.trim() ?? null)
      : dependencies.clientId;

  const tokens = useCallback((): GoogleDriveTokenClient => {
    if (!clientId) {
      throw new VaultCryptoError('locked', 'Google Drive is not configured for this deployment.');
    }
    tokensRef.current ??= createGoogleDriveTokenClient({ clientId });
    return tokensRef.current;
  }, [clientId]);

  const drive = useCallback((): DriveDataHome => {
    driveRef.current ??= createDriveDataHome({ tokens: tokens() });
    return driveRef.current;
  }, [tokens]);

  const lock = useCallback(async () => {
    operationGenerationRef.current += 1;
    setConnection(null);
    runtimeRef.current?.dispose();
    runtimeRef.current = null;
    tokensRef.current?.clear();
    await core.lock();
  }, [core]);

  useLayoutEffect(() => {
    if (!authenticated) void lock();
    return () => {
      void lock();
    };
  }, [authenticated, lock, userId]);

  const unlockWithPassphrase = useCallback(
    async (
      passphrase: string,
      unlockOptions: VaultDriveUnlockOptions,
    ): Promise<DriveConnectionController> => {
      if (!authenticated || userId == null) {
        throw new VaultCryptoError('locked', 'An authenticated vault owner is required.');
      }
      if (!clientId) {
        throw new VaultCryptoError('locked', 'Google Drive is not configured for this deployment.');
      }

      const operationGeneration = operationGenerationRef.current;
      const ownerId = userId;
      const tokenClient = tokens();
      let installed: UnlockedVaultDriveRuntime | null = null;
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
          ? await readDriveEnvelope(drive(), requireCurrentOperation)
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
        await core.unlockWithPassphrase(envelope, passphrase);
        requireCurrentOperation();

        installed = await core.withVaultKey((vaultKey, keyId) =>
          (dependencies?.createRuntime ?? createUnlockedVaultDriveRuntime)(vaultKey, keyId, {
            userId: ownerId,
            clientId,
            tokens: tokenClient,
            drive: driveRef.current ?? undefined,
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
        return installed.controller;
      } catch (cause) {
        installed?.dispose();
        if (runtimeRef.current === installed) runtimeRef.current = null;
        if (operationGenerationRef.current === operationGeneration) {
          operationGenerationRef.current += 1;
          setConnection(null);
          runtimeRef.current?.dispose();
          runtimeRef.current = null;
          tokenClient.clear();
          await core.lock();
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

  const value = useMemo<VaultRuntime>(
    () => ({ core, connection, unlockWithPassphrase, lock }),
    [connection, core, lock, unlockWithPassphrase],
  );

  return <VaultRuntimeContext.Provider value={value}>{children}</VaultRuntimeContext.Provider>;
}

export function useVaultRuntime(): VaultRuntime {
  const runtime = useContext(VaultRuntimeContext);
  if (!runtime) throw new Error('useVaultRuntime must be used within VaultRuntimeProvider.');
  return runtime;
}

/** Optional form lets isolated pages/tests inject a controller without a provider. */
export function useOptionalVaultRuntime(): VaultRuntime | null {
  return useContext(VaultRuntimeContext);
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

function rememberKeyId(userId: string, keyId: string): void {
  try {
    globalThis.localStorage?.setItem(`${KEY_ID_STORAGE_PREFIX}${userId}`, keyId);
  } catch {
    // Non-sensitive routing metadata is optional.
  }
}

function rememberedKeyId(userId: string): string | null {
  try {
    return globalThis.localStorage?.getItem(`${KEY_ID_STORAGE_PREFIX}${userId}`) ?? null;
  } catch {
    return null;
  }
}
