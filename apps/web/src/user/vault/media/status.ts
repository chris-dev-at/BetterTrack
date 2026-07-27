import type { VaultMediaStateResponse, VaultMedium } from '@bettertrack/contracts';

import type { DriveAuthorizationState } from '../drive';
import type { VaultSyncStatus } from '../sync';

export type VaultMediumSyncState =
  | 'disconnected'
  | 'synced'
  | 'syncing'
  | 'offline'
  | 'needs-attention';

export interface VaultMediaSyncProjection {
  overall: Exclude<VaultMediumSyncState, 'disconnected'>;
  perMedium: Record<VaultMedium, VaultMediumSyncState>;
  lastWriteAt: string | null;
  /** i18n key for the shared chip/popover; never hardcoded UI copy. */
  messageKey: string;
}

export interface VaultMediaSyncProjectionInput {
  media: VaultMediaStateResponse;
  syncStatus: VaultSyncStatus;
  driveAuthorization: DriveAuthorizationState;
  online: boolean;
  operationPending?: boolean;
  lastWriteAt?: string | null;
}

/** Drive-aware projection consumed by the later shared shield sync chip. */
export function projectVaultMediaSyncStatus(
  input: VaultMediaSyncProjectionInput,
): VaultMediaSyncProjection {
  const selected = (medium: VaultMedium) => input.media.mediaSet.includes(medium);
  const pending =
    input.operationPending === true ||
    input.syncStatus === 'pending-offline' ||
    input.syncStatus === 'conflict';

  let drive: VaultMediumSyncState = 'disconnected';
  if (selected('drive')) {
    if (!input.online) drive = 'offline';
    else if (input.driveAuthorization !== 'connected') drive = 'needs-attention';
    else if (pending) drive = 'syncing';
    else drive = input.syncStatus === 'synced' ? 'synced' : 'needs-attention';
  }

  let server: VaultMediumSyncState = 'disconnected';
  if (selected('server')) {
    if (!input.online) server = 'offline';
    else if (pending) server = 'syncing';
    else server = input.syncStatus === 'synced' ? 'synced' : 'needs-attention';
  }

  const states = [server, drive];
  if (states.includes('needs-attention')) {
    return {
      overall: 'needs-attention',
      perMedium: { server, drive },
      lastWriteAt: input.lastWriteAt ?? null,
      messageKey:
        selected('drive') && input.driveAuthorization !== 'connected'
          ? 'vault.sync.drive.signIn'
          : 'vault.sync.needsAttention',
    };
  }
  if (states.includes('offline')) {
    return {
      overall: 'offline',
      perMedium: { server, drive },
      lastWriteAt: input.lastWriteAt ?? null,
      messageKey: 'vault.sync.offline',
    };
  }
  if (states.includes('syncing')) {
    return {
      overall: 'syncing',
      perMedium: { server, drive },
      lastWriteAt: input.lastWriteAt ?? null,
      messageKey: 'vault.sync.syncing',
    };
  }
  return {
    overall: 'synced',
    perMedium: { server, drive },
    lastWriteAt: input.lastWriteAt ?? null,
    messageKey: 'vault.sync.synced',
  };
}
