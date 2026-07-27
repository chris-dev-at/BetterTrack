import type { DriveAuthorizationState, GoogleDriveTokenClient } from '../drive';
import type { VaultMediaSwitcher, VaultMediaSwitchResult } from './mediaSwitcher';

export type DriveConnectionActionResult =
  | { status: 'authorization-required'; authorization: DriveAuthorizationState }
  | VaultMediaSwitchResult;

export interface DriveConnectionController {
  readonly authorization: DriveAuthorizationState;
  connect(): Promise<DriveConnectionActionResult>;
  disconnect(): Promise<VaultMediaSwitchResult>;
  resume(): Promise<void>;
}

export interface DriveConnectionControllerOptions {
  tokens: GoogleDriveTokenClient;
  switcher: VaultMediaSwitcher;
  /** Re-run the PD5 coordinator after a fresh gesture/token. */
  resumeSync?: () => Promise<void>;
}

export function createDriveConnectionController(
  options: DriveConnectionControllerOptions,
): DriveConnectionController {
  return {
    get authorization() {
      return options.tokens.state;
    },

    async connect() {
      const authorized = await options.tokens.authorize();
      if (authorized.status !== 'ok') {
        return {
          status: 'authorization-required',
          authorization: authorized.status,
        };
      }
      const result = await options.switcher.add('drive');
      if (result.status === 'ok' || result.status === 'noop') {
        await options.resumeSync?.();
      }
      return result;
    },

    async disconnect() {
      const result = await options.switcher.remove('drive');
      if ((result.status === 'ok' || result.status === 'noop') && !result.driveLeftover) {
        options.tokens.clear();
        await options.resumeSync?.();
      }
      return result;
    },

    async resume() {
      const authorized = await options.tokens.authorize();
      if (authorized.status === 'ok') await options.resumeSync?.();
    },
  };
}

// The provider-owned unlock lifecycle installs a controller here and removes it
// on lock. Keeping this registry capability-free while locked prevents Settings
// from manufacturing a second crypto/sync stack.
let activeDriveConnection: DriveConnectionController | null = null;

export function installDriveConnectionController(
  controller: DriveConnectionController,
): () => void {
  activeDriveConnection = controller;
  return () => {
    if (activeDriveConnection === controller) activeDriveConnection = null;
  };
}

export function getDriveConnectionController(): DriveConnectionController | null {
  return activeDriveConnection;
}
