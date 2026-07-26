import type { VaultMediaState, VaultMedium } from '@bettertrack/contracts';

import type { DriveTokenStatus } from '../drive/tokenClient';

export type ParanoidSyncChipState = 'synced' | 'syncing' | 'offline' | 'needs-attention';
export type MediumSyncState =
  | 'synced'
  | 'syncing'
  | 'offline'
  | 'needs-sign-in'
  | 'error'
  | 'inactive';

export interface MediumSyncProjection {
  medium: VaultMedium;
  state: MediumSyncState;
}

export interface ParanoidSyncStatusProjection {
  state: ParanoidSyncChipState;
  messageKey:
    | 'vault.sync.synced'
    | 'vault.sync.syncing'
    | 'vault.sync.offline'
    | 'vault.sync.signInToGoogle'
    | 'vault.sync.needsAttention';
  lastWriteAt: string | null;
  media: MediumSyncProjection[];
}

export interface ProjectDriveSyncStatusInput {
  durable: VaultMediaState;
  token: DriveTokenStatus;
  pendingLocalWrite: boolean;
  syncing: boolean;
  driveApiFailed?: boolean;
  lastWriteAt: string | null;
}

/** Pure projection consumed by the shared shield chip in the later PD8 shell. */
export function projectDriveSyncStatus(
  input: ProjectDriveSyncStatusInput,
): ParanoidSyncStatusProjection {
  const driveSelected = input.durable.mediaSet.includes('drive');
  const drive = driveSelected ? driveState(input) : 'inactive';
  const media: MediumSyncProjection[] = [
    {
      medium: 'server',
      state: input.durable.mediaSet.includes('server')
        ? input.syncing
          ? 'syncing'
          : 'synced'
        : 'inactive',
    },
    { medium: 'drive', state: drive },
  ];

  if (drive === 'offline') {
    return {
      state: 'offline',
      messageKey: 'vault.sync.offline',
      lastWriteAt: input.lastWriteAt,
      media,
    };
  }
  if (drive === 'needs-sign-in') {
    return {
      state: 'needs-attention',
      messageKey: 'vault.sync.signInToGoogle',
      lastWriteAt: input.lastWriteAt,
      media,
    };
  }
  if (drive === 'error') {
    return {
      state: 'needs-attention',
      messageKey: 'vault.sync.needsAttention',
      lastWriteAt: input.lastWriteAt,
      media,
    };
  }
  if (input.syncing || input.pendingLocalWrite || drive === 'syncing') {
    return {
      state: 'syncing',
      messageKey: 'vault.sync.syncing',
      lastWriteAt: input.lastWriteAt,
      media,
    };
  }
  return {
    state: 'synced',
    messageKey: 'vault.sync.synced',
    lastWriteAt: input.lastWriteAt,
    media,
  };
}

function driveState(input: ProjectDriveSyncStatusInput): MediumSyncState {
  if (input.token.status === 'offline') return 'offline';
  if (
    input.token.status === 'consent-required' ||
    input.token.status === 'token-expired' ||
    input.token.status === 'gesture-required'
  ) {
    return 'needs-sign-in';
  }
  if (input.token.status === 'authorization-failed' || input.driveApiFailed) return 'error';
  if (input.syncing || input.pendingLocalWrite) return 'syncing';
  return 'synced';
}
