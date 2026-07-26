import type { VaultMediaState } from '@bettertrack/contracts';

import type { GoogleDriveTokenClient } from '../drive/tokenClient';
import { googleDriveClientId } from '../drive/tokenClient';
import type { MediaSwitchResult, VaultMediaSwitcher } from './switcher';

export type DriveConnectionState =
  | 'disconnected'
  | 'connected'
  | 'needs-sign-in'
  | 'offline'
  | 'unavailable';

export interface VaultDriveConnectionController {
  prepare(): Promise<void>;
  state(media: VaultMediaState): DriveConnectionState;
  connect(): Promise<MediaSwitchResult>;
  disconnect(): Promise<MediaSwitchResult>;
}

let activeController: VaultDriveConnectionController | null = null;

/**
 * The unlocked PD5/PD8 vault runtime installs this narrow controller. Settings
 * can then request a switch without ever receiving the vault key, Drive token,
 * file id or raw envelope.
 */
export function installVaultDriveConnectionController(
  controller: VaultDriveConnectionController,
): () => void {
  activeController = controller;
  return () => {
    if (activeController === controller) activeController = null;
  };
}

export function driveConnectionState(media: VaultMediaState): DriveConnectionState {
  if (activeController) return activeController.state(media);
  return media.mediaSet.includes('drive') ? 'needs-sign-in' : 'disconnected';
}

export function driveConnectionConfigured(): boolean {
  return googleDriveClientId() !== null;
}

export async function prepareDriveConnection(): Promise<void> {
  await activeController?.prepare();
}

export async function connectDriveConnection(): Promise<MediaSwitchResult> {
  if (!activeController) return unavailableResult();
  return activeController.connect();
}

export async function disconnectDriveConnection(): Promise<MediaSwitchResult> {
  if (!activeController) return unavailableResult();
  return activeController.disconnect();
}

export function createVaultDriveConnectionController(options: {
  tokens: GoogleDriveTokenClient;
  switcher: VaultMediaSwitcher;
}): VaultDriveConnectionController {
  return {
    prepare: () => options.tokens.prepare(),

    state(media) {
      if (!media.mediaSet.includes('drive')) return 'disconnected';
      switch (options.tokens.status().status) {
        case 'ready':
          return 'connected';
        case 'offline':
          return 'offline';
        case 'consent-required':
        case 'token-expired':
        case 'gesture-required':
          return 'needs-sign-in';
        case 'authorization-failed':
          return 'unavailable';
      }
    },

    async connect() {
      const authorized = await options.tokens.authorize();
      if (authorized.status !== 'ok') {
        return {
          status: 'failed',
          reason: authorized.reason,
          authoritativeState: null,
        };
      }
      return options.switcher.add('drive');
    },

    async disconnect() {
      const result = await options.switcher.remove('drive');
      if (result.status === 'ok' || result.status === 'no-op') {
        await options.tokens.disconnect();
      }
      // A leftover ciphertext warning intentionally keeps the token live so the
      // user can retry cleanup from their own Drive.
      return result;
    },
  };
}

function unavailableResult(): Extract<MediaSwitchResult, { status: 'failed' }> {
  return {
    status: 'failed',
    reason: 'source-unavailable',
    authoritativeState: null,
  };
}
