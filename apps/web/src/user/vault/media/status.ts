import type { ParanoidVaultMediaState, VaultConfig, VaultMedium } from '@bettertrack/contracts';

import type { DriveAuthorizationState } from '../drive';
import type { EndpointVaultState } from '../keystore';
import type { VaultSyncStatus } from '../sync';

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

/** The four states the owner-kept chip composes across the account's vaults. */
export type VaultChipState = 'needs-attention' | 'syncing' | 'locked' | 'synced';

/**
 * The aggregate is discriminated so callers cannot render an unnamed
 * attention state or a locked state without its mandatory count.
 */
export type VaultChipAggregate =
  | { state: 'needs-attention'; vaultId: string; vaultName: string }
  | { state: 'syncing' }
  | { state: 'locked'; count: number }
  | { state: 'synced' };

export type VaultChipProblem = Extract<VaultSyncStatus, 'conflict' | 'corrupt' | 'unresolved'>;

export type VaultChipSyncAction =
  | { kind: 'authorize-drive'; connectionId: string }
  | { kind: 'open-restore-picker' };

export interface VaultChipRow {
  vaultId: string;
  vaultName: string;
  state: VaultChipState;
  media: readonly VaultMedium[];
  perMedium: Record<VaultMedium, VaultMediumSyncState>;
  lastWriteAt: string | null;
  pendingWrites: boolean;
  problem: VaultChipProblem | null;
  /** E3's state-to-action value, passed through without reinterpretation. */
  custodyAction: EndpointVaultState['requiredAction'];
  syncAction: VaultChipSyncAction | null;
}

export interface VaultSyncChipProjection {
  aggregate: VaultChipAggregate;
  /** Counted from custody state even when attention or syncing wins overall. */
  lockedCount: number;
  rows: readonly VaultChipRow[];
}

export interface PerVaultSyncProjectionInput {
  vault: Pick<VaultConfig, 'id' | 'name' | 'driveConnectionId'> & {
    /** `local` is reserved; the sync chip only projects today's shipped media. */
    media: readonly VaultMedium[];
  };
  endpointState: EndpointVaultState;
  /** Null when the endpoint cannot open this vault's encrypted document set. */
  syncStatus: VaultSyncStatus | null;
  /** Authorization belongs to this vault's bound Drive connection, not the account. */
  driveAuthorization: DriveAuthorizationState;
  online: boolean;
  operationPending?: boolean;
  pendingWrites?: boolean;
  lastWriteAt?: string | null;
}

const VAULT_CHIP_STATE_RANK: Readonly<Record<VaultChipState, number>> = {
  synced: 0,
  locked: 1,
  syncing: 2,
  'needs-attention': 3,
};

/** Drive-aware projection consumed by the shared shield sync chip. */
export function projectVaultMediaSyncStatus(
  input: VaultMediaSyncProjectionInput,
): VaultMediaSyncProjection {
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

/**
 * Data-only projection for the one owner-kept sync chip across N vaults.
 * E8 owns the render; keeping this composition headless lets it retain the
 * existing DOM/classes while consuming one aggregate plus ordered popover rows.
 */
export function projectVaultSyncChip(
  inputs: readonly PerVaultSyncProjectionInput[],
): VaultSyncChipProjection {
  const lockedCount = inputs.reduce(
    (count, input) => count + (endpointVaultIsLocked(input.endpointState) ? 1 : 0),
    0,
  );
  const rows = inputs.map(projectVaultSyncRow).sort(compareVaultRows);
  const worstRank = rows.reduce(
    (rank, row) => Math.max(rank, VAULT_CHIP_STATE_RANK[row.state]),
    VAULT_CHIP_STATE_RANK.synced,
  );
  const worst = rows.find((row) => VAULT_CHIP_STATE_RANK[row.state] === worstRank);

  let aggregate: VaultChipAggregate;
  if (worst?.state === 'needs-attention') {
    aggregate = {
      state: 'needs-attention',
      vaultId: worst.vaultId,
      vaultName: worst.vaultName,
    };
  } else if (worst?.state === 'syncing') {
    aggregate = { state: 'syncing' };
  } else if (worst?.state === 'locked') {
    aggregate = { state: 'locked', count: lockedCount };
  } else {
    aggregate = { state: 'synced' };
  }

  return { aggregate, lockedCount, rows };
}

function projectVaultSyncRow(input: PerVaultSyncProjectionInput): VaultChipRow {
  const locked = endpointVaultIsLocked(input.endpointState);
  const pendingWrites = input.pendingWrites === true || input.syncStatus === 'pending-offline';
  const pending = input.operationPending === true || pendingWrites;
  const driveNeedsAuthorization =
    input.vault.media.includes('drive') && input.driveAuthorization !== 'connected';
  const statusNeedsAttention = vaultSyncStatusNeedsAttention(input.syncStatus, locked, pending);
  const attention = driveNeedsAuthorization || statusNeedsAttention;
  const syncing = pending || !input.online;
  const problem = vaultChipProblem(input.syncStatus);

  let state: VaultChipState;
  if (attention) state = 'needs-attention';
  else if (syncing) state = 'syncing';
  else if (locked) state = 'locked';
  else state = 'synced';

  const perMedium = {
    server: projectVaultMediumState(input, 'server', locked, pending),
    drive: projectVaultMediumState(input, 'drive', locked, pending),
  } satisfies Record<VaultMedium, VaultMediumSyncState>;

  let syncAction: VaultChipSyncAction | null = null;
  if (driveNeedsAuthorization) {
    syncAction =
      input.vault.driveConnectionId == null
        ? { kind: 'open-restore-picker' }
        : { kind: 'authorize-drive', connectionId: input.vault.driveConnectionId };
  } else if (statusNeedsAttention) {
    syncAction = { kind: 'open-restore-picker' };
  }

  return {
    vaultId: input.vault.id,
    vaultName: input.vault.name,
    state,
    media: input.vault.media,
    perMedium,
    lastWriteAt: input.lastWriteAt ?? null,
    pendingWrites,
    problem,
    custodyAction: input.endpointState.requiredAction,
    syncAction,
  };
}

function projectVaultMediumState(
  input: PerVaultSyncProjectionInput,
  medium: VaultMedium,
  locked: boolean,
  pending: boolean,
): VaultMediumSyncState {
  if (!input.vault.media.includes(medium)) return 'disconnected';
  if (medium === 'drive' && input.driveAuthorization !== 'connected') {
    return 'needs-attention';
  }
  if (vaultSyncStatusNeedsAttention(input.syncStatus, locked, pending)) {
    return 'needs-attention';
  }
  if (!input.online) return 'offline';
  if (pending) return 'syncing';
  if (input.syncStatus === 'synced') return 'synced';
  if (locked && (input.syncStatus == null || input.syncStatus === 'locked')) {
    return 'disconnected';
  }
  return 'needs-attention';
}

function vaultSyncStatusNeedsAttention(
  status: VaultSyncStatus | null,
  locked: boolean,
  pending: boolean,
): boolean {
  if (status === 'conflict' || status === 'corrupt' || status === 'unresolved') return true;
  if (status === 'empty') return true;
  if (!locked && status === 'locked') return true;
  return !locked && status == null && !pending;
}

function vaultChipProblem(status: VaultSyncStatus | null): VaultChipProblem | null {
  return status === 'conflict' || status === 'corrupt' || status === 'unresolved' ? status : null;
}

function endpointVaultIsLocked(state: EndpointVaultState): boolean {
  if (state.status === 'stored+plain') return false;
  if (state.status === 'stored+wrapped') return state.session === 'locked';
  return true;
}

function compareVaultRows(left: VaultChipRow, right: VaultChipRow): number {
  if (left.vaultName < right.vaultName) return -1;
  if (left.vaultName > right.vaultName) return 1;
  if (left.vaultId < right.vaultId) return -1;
  if (left.vaultId > right.vaultId) return 1;
  return 0;
}
