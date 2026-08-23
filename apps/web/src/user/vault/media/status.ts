import type { ParanoidVaultMediaState, VaultConfig, VaultMedium } from '@bettertrack/contracts';
import { VAULT_SERVER_ACCEPTED_MEDIA } from '@bettertrack/contracts';

import type { DriveAuthorizationState } from '../drive';
import type { EndpointVaultState } from '../keystore';
import type { VaultSyncStatus } from '../sync';
import { vaultStateAffordance } from '../vaultStateAffordance';

/**
 * Every sync state the chip can render, as a value — the union below is derived
 * from it, so the two cannot drift. `VaultSyncChip` builds
 * `vault.sync.status.<state>` as a template-literal key (for the button label,
 * its aria-label and each medium row), which the EN⇄DE parity test cannot see:
 * a key absent from *both* catalogs is parity-clean and still paints the raw
 * dot-path. `i18n/registry.test.ts` iterates this tuple instead — the same
 * drift-guard shape as `VAULT_ENABLE_STAGES`.
 */
export const VAULT_MEDIUM_SYNC_STATES = [
  'disconnected',
  'synced',
  'syncing',
  'offline',
  'needs-attention',
] as const;

export type VaultMediumSyncState = (typeof VAULT_MEDIUM_SYNC_STATES)[number];

export interface VaultMediaSyncProjection {
  overall: Exclude<VaultMediumSyncState, 'disconnected'>;
  perMedium: Record<VaultMedium, VaultMediumSyncState>;
  lastWriteAt: string | null;
  /** i18n key for the shared chip/popover; never hardcoded UI copy. */
  messageKey: string;
}

export interface VaultMediaSyncProjectionInput {
  media: ParanoidVaultMediaState;
  syncStatus: VaultSyncStatus;
  driveAuthorization: DriveAuthorizationState;
  online: boolean;
  operationPending?: boolean;
  lastWriteAt?: string | null;
}

export const VAULT_AGGREGATE_SYNC_STATES = ['synced', 'locked', 'syncing', 'attention'] as const;
export type VaultAggregateSyncState = (typeof VAULT_AGGREGATE_SYNC_STATES)[number];

export interface VaultDirectorySyncInput {
  vault: VaultConfig;
  endpointState: EndpointVaultState;
  /** Per-vault coordinator result; absent means the last attested set is current. */
  syncState?: 'synced' | 'syncing' | 'attention';
  driveAuthorization?: DriveAuthorizationState;
  lastWriteAt?: string | null;
}

export interface VaultDirectorySyncRow {
  vault: VaultConfig;
  endpointState: EndpointVaultState;
  state: VaultAggregateSyncState;
  perMedium: Partial<Record<VaultMedium, VaultMediumSyncState>>;
  lastWriteAt: string | null;
  messageKey: string;
  recoveryAction: 'drive-sign-in' | 'restore' | null;
}

export interface VaultAggregateSyncProjection {
  overall: VaultAggregateSyncState;
  lockedCount: number;
  attentionVaultName: string | null;
  rows: VaultDirectorySyncRow[];
  messageKey: string;
}

export interface VaultAggregateSyncProjectionInput {
  vaults: readonly VaultDirectorySyncInput[];
}

/** Drive-aware projection consumed by the shared shield sync chip. */
export function projectVaultMediaSyncStatus(
  input: VaultMediaSyncProjectionInput,
): VaultMediaSyncProjection;
export function projectVaultMediaSyncStatus(
  input: VaultAggregateSyncProjectionInput,
): VaultAggregateSyncProjection;
export function projectVaultMediaSyncStatus(
  input: VaultMediaSyncProjectionInput | VaultAggregateSyncProjectionInput,
): VaultMediaSyncProjection | VaultAggregateSyncProjection {
  if ('vaults' in input) return projectVaultDirectorySyncStatus(input.vaults);

  const selected = (medium: VaultMedium) => input.media.mediaSet.includes(medium);
  const pending = input.operationPending === true || input.syncStatus === 'pending-offline';

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

function projectVaultDirectorySyncStatus(
  inputs: readonly VaultDirectorySyncInput[],
): VaultAggregateSyncProjection {
  const rows = inputs.map(projectVaultDirectoryRow);
  const attention = rows.find((row) => row.state === 'attention');
  const overall: VaultAggregateSyncState = attention
    ? 'attention'
    : rows.some((row) => row.state === 'syncing')
      ? 'syncing'
      : rows.some((row) => row.state === 'locked')
        ? 'locked'
        : 'synced';
  return {
    overall,
    lockedCount: rows.filter((row) => row.state === 'locked').length,
    attentionVaultName: attention?.vault.name ?? null,
    rows,
    messageKey: `vault.sync.aggregate.${overall}`,
  };
}

function projectVaultDirectoryRow(input: VaultDirectorySyncInput): VaultDirectorySyncRow {
  const driveNeedsSignIn =
    input.vault.media.includes('drive') &&
    input.driveAuthorization !== undefined &&
    input.driveAuthorization !== 'connected';
  const action = vaultStateAffordance(input.endpointState).action;
  const locked = action === 'unlock' || action === 'provide-phrase' || action === 'reset-endpoint';
  const state: VaultAggregateSyncState =
    driveNeedsSignIn || input.syncState === 'attention'
      ? 'attention'
      : input.syncState === 'syncing'
        ? 'syncing'
        : locked
          ? 'locked'
          : 'synced';
  const mediumSyncState: VaultMediumSyncState =
    input.syncState === 'attention'
      ? 'needs-attention'
      : input.syncState === 'syncing'
        ? 'syncing'
        : 'synced';
  const perMedium: Partial<Record<VaultMedium, VaultMediumSyncState>> = {};
  for (const medium of VAULT_SERVER_ACCEPTED_MEDIA.filter((candidate) =>
    input.vault.media.includes(candidate),
  )) {
    perMedium[medium] =
      medium === 'drive' && driveNeedsSignIn ? 'needs-attention' : mediumSyncState;
  }
  return {
    vault: input.vault,
    endpointState: input.endpointState,
    state,
    perMedium,
    lastWriteAt: input.lastWriteAt ?? input.vault.mediaAttestedAt,
    messageKey: driveNeedsSignIn ? 'vault.sync.drive.signIn' : `vault.sync.aggregate.row.${state}`,
    recoveryAction: driveNeedsSignIn
      ? 'drive-sign-in'
      : input.syncState === 'attention'
        ? 'restore'
        : null,
  };
}
