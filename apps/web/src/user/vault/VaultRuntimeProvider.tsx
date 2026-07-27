import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { createIndexedDbVaultCustody, type DeviceVaultCustody } from './custody';
import { VaultCryptoError } from './errors';
import { createLocalDataHome } from './localDataHome';
import { VaultLockCore, type VaultLockCoreOptions } from './lock';
import {
  getDriveConnectionController,
  type DriveConnectionController,
} from './media/driveConnection';
import { createServerBlobDataHome } from './serverBlobDataHome';

const KEY_ID_STORAGE_PREFIX = 'bettertrack:vault-key:';

export interface VaultRuntime {
  readonly core: VaultLockCore;
  readonly connection: DriveConnectionController | null;
  /**
   * Unlock the current account's encrypted envelope through the exact core
   * owned by this provider. The installed controller is returned so the user
   * gesture can continue directly into Drive authorization/media migration.
   */
  unlockWithPassphrase(passphrase: string): Promise<DriveConnectionController>;
}

export interface VaultRuntimeProviderDependencies {
  custody?: DeviceVaultCustody;
  readEnvelope?: (userId: string) => Promise<Uint8Array>;
  installUnlockedRuntime?: VaultLockCoreOptions['installUnlockedRuntime'];
}

const VaultRuntimeContext = createContext<VaultRuntime | null>(null);

/**
 * Production owner for the unlocked vault-key lifecycle. A successful unlock
 * installs the Drive/media/sync composition through `VaultLockCore`; leaving
 * the authenticated shell removes that capability and clears the in-memory key.
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
    () =>
      new VaultLockCore({
        custody: dependencies?.custody ?? createIndexedDbVaultCustody(),
        installUnlockedRuntime: dependencies?.installUnlockedRuntime,
      }),
  );
  const [connection, setConnection] = useState<DriveConnectionController | null>(null);

  const lock = useCallback(async () => {
    // The controller is a capability. Hide it synchronously, before IndexedDB
    // custody cleanup completes.
    setConnection(null);
    await core.lock();
  }, [core]);

  useEffect(() => {
    if (!authenticated) void lock();
    return () => {
      void lock();
    };
  }, [authenticated, lock, userId]);

  const unlockWithPassphrase = useCallback(
    async (passphrase: string): Promise<DriveConnectionController> => {
      if (!authenticated || userId == null) {
        throw new VaultCryptoError('locked', 'An authenticated vault owner is required.');
      }
      const envelope = await (dependencies?.readEnvelope ?? readProductionEnvelope)(userId);
      await core.unlockWithPassphrase(envelope, passphrase);
      if (core.state.status === 'unlocked') rememberKeyId(userId, core.state.keyId);

      const installed = getDriveConnectionController();
      if (installed == null) {
        throw new VaultCryptoError(
          'locked',
          'The unlocked Google Drive vault runtime is unavailable.',
        );
      }
      setConnection(installed);
      return installed;
    },
    [authenticated, core, dependencies?.readEnvelope, userId],
  );

  const value = useMemo<VaultRuntime>(
    () => ({ core, connection, unlockWithPassphrase }),
    [connection, core, unlockWithPassphrase],
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

async function readProductionEnvelope(userId: string): Promise<Uint8Array> {
  const server = await createServerBlobDataHome().read();
  if (server.status === 'ok') return server.envelope;

  // Drive-only reloads have no active server row. The PD5 encrypted local cache
  // is the offline bootstrap copy; the remembered key id is non-sensitive
  // routing metadata written after an earlier successful unlock.
  const keyId = rememberedKeyId(userId);
  if (keyId != null) {
    const local = await createLocalDataHome({ scope: `vault:${keyId}` }).read();
    if (local.status === 'ok') return local.envelope;
  }

  throw new VaultCryptoError('locked', 'No encrypted vault envelope is available for this device.');
}

function rememberKeyId(userId: string, keyId: string): void {
  try {
    globalThis.localStorage?.setItem(`${KEY_ID_STORAGE_PREFIX}${userId}`, keyId);
  } catch {
    // Non-sensitive routing metadata is an optimization. A blocked storage
    // backend simply means the next Drive-only reload needs another bootstrap.
  }
}

function rememberedKeyId(userId: string): string | null {
  try {
    return globalThis.localStorage?.getItem(`${KEY_ID_STORAGE_PREFIX}${userId}`) ?? null;
  } catch {
    return null;
  }
}
