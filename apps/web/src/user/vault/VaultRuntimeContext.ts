import { createContext, useContext } from 'react';

import type { DataHome } from './dataHome';
import type { DriveAuthorizationState } from './drive';
import type { VaultLockCore, VaultLockState } from './lock';
import type { DriveConnectionController } from './media/driveConnection';
import type { VaultDriveSyncCoordinator } from './media/runtime';
import type { RecoveryKitDownload } from './recovery';
import type { VaultSyncState } from './sync';
import type { VaultTransferRuntime } from './qr/runtime';

export interface VaultDriveUnlockOptions {
  /** Mint/reuse a browser-memory Drive token during this user gesture. */
  authorizeDrive: boolean;
  /** A fresh Drive-only device must fetch its first unlock envelope from Drive. */
  driveOnly: boolean;
  /** Persist a non-extractable device key after this authenticated unlock. */
  keepUnlocked?: boolean;
}

export interface VaultRuntime {
  readonly core: VaultLockCore;
  /** Endpoint-wide per-vault key session; owned by the live app runtime. */
  readonly transfer: VaultTransferRuntime;
  readonly connection: DriveConnectionController | null;
  /** The unlocked session's PD5 sync seam — null while locked. */
  readonly sync: VaultDriveSyncCoordinator | null;
  readonly lockState: VaultLockState;
  readonly phase: 'locked' | 'unlocking' | 'unlocked';
  readonly driveAuthorization: DriveAuthorizationState;
  readonly syncState: VaultSyncState | null;
  unlockWithPassphrase(
    passphrase: string,
    options: VaultDriveUnlockOptions,
  ): Promise<DriveConnectionController>;
  unlockWithRecoveryKit(
    recoveryKit: Uint8Array,
    options: VaultDriveUnlockOptions,
  ): Promise<DriveConnectionController>;
  /** Try the optional non-extractable device key without prompting. */
  unlockFromDevice(options: Omit<VaultDriveUnlockOptions, 'keepUnlocked'>): Promise<boolean>;
  /** User-gesture GIS authorization used by the pre-enable media round trip. */
  authorizeDriveStorage(): Promise<DataHome>;
  reconnect(): Promise<VaultSyncState>;
  downloadRecoveryKit(): Promise<RecoveryKitDownload>;
  changePassphrase(currentPassphrase: string, nextPassphrase: string): Promise<void>;
  rotateKey(
    passphrase: string,
    receiveRecoveryKit: (kit: RecoveryKitDownload) => Promise<void> | void,
  ): Promise<void>;
  /** Best-effort encrypted-copy cleanup after the server committed disable. */
  cleanupAfterDisable(): Promise<void>;
  lock(options?: { broadcast?: boolean }): Promise<void>;
}

export const VaultRuntimeContext = createContext<VaultRuntime | null>(null);

export function useVaultRuntime(): VaultRuntime {
  const runtime = useContext(VaultRuntimeContext);
  if (!runtime) throw new Error('useVaultRuntime must be used within VaultRuntimeProvider.');
  return runtime;
}

/** Optional form lets normal-mode surfaces render without loading the vault runtime. */
export function useOptionalVaultRuntime(): VaultRuntime | null {
  return useContext(VaultRuntimeContext);
}
