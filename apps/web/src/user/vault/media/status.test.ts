import { describe, expect, it } from 'vitest';

import type { ParanoidVaultMediaState } from '@bettertrack/contracts';

import type { EndpointVaultState } from '../keystore';
import type { VaultSyncStatus } from '../sync';
import {
  projectVaultMediaSyncStatus,
  projectVaultSyncChip,
  type PerVaultSyncProjectionInput,
} from './status';

const both: ParanoidVaultMediaState = {
  mediaSet: ['server', 'drive'],
  driveAttestedVersion: 7,
  server: { disposition: 'active', candidate: null, retired: null },
};

describe('Drive-aware vault sync status', () => {
  it.each(['token-expired', 'gesture-required', 'consent-required'] as const)(
    'maps %s to needs attention with the explicit Google sign-in message',
    (driveAuthorization) => {
      expect(
        projectVaultMediaSyncStatus({
          media: both,
          syncStatus: 'pending-offline',
          driveAuthorization,
          online: true,
        }),
      ).toEqual({
        overall: 'needs-attention',
        perMedium: { server: 'syncing', drive: 'needs-attention' },
        lastWriteAt: null,
        messageKey: 'vault.sync.drive.signIn',
      });
    },
  );

  it('keeps an offline pending write visibly pending on every selected medium', () => {
    expect(
      projectVaultMediaSyncStatus({
        media: both,
        syncStatus: 'pending-offline',
        driveAuthorization: 'connected',
        online: false,
        lastWriteAt: '2026-07-28T10:00:00.000Z',
      }),
    ).toEqual({
      overall: 'offline',
      perMedium: { server: 'offline', drive: 'offline' },
      lastWriteAt: '2026-07-28T10:00:00.000Z',
      messageKey: 'vault.sync.offline',
    });
  });

  it('reports each selected medium as synced only after coordinator acknowledgement', () => {
    expect(
      projectVaultMediaSyncStatus({
        media: both,
        syncStatus: 'synced',
        driveAuthorization: 'connected',
        online: true,
      }),
    ).toMatchObject({
      overall: 'synced',
      perMedium: { server: 'synced', drive: 'synced' },
      messageKey: 'vault.sync.synced',
    });
  });

  it('does not mislabel an unresolved CAS conflict as ordinary syncing', () => {
    expect(
      projectVaultMediaSyncStatus({
        media: both,
        syncStatus: 'conflict',
        driveAuthorization: 'connected',
        online: true,
      }),
    ).toMatchObject({
      overall: 'needs-attention',
      perMedium: { server: 'needs-attention', drive: 'needs-attention' },
      messageKey: 'vault.sync.needsAttention',
    });
  });
});

const OPEN_ENDPOINT = {
  status: 'stored+wrapped',
  session: 'unlocked',
  requiredAction: { kind: 'open-silently' },
} satisfies EndpointVaultState;

const LOCKED_ENDPOINT = {
  status: 'stored+wrapped',
  session: 'locked',
  requiredAction: { kind: 'unlock', credential: 'device-password' },
} satisfies EndpointVaultState;

describe('per-vault sync-chip projection', () => {
  it('orders rows deterministically and applies attention > syncing > locked > synced', () => {
    const synced = perVault({ id: vaultId(5), name: 'Synced', syncStatus: 'synced' });
    const locked = perVault({
      id: vaultId(4),
      name: 'Locked',
      endpointState: LOCKED_ENDPOINT,
      syncStatus: 'synced',
    });
    const syncing = perVault({
      id: vaultId(3),
      name: 'Syncing',
      syncStatus: 'pending-offline',
    });
    const zuluAttention = perVault({
      id: vaultId(2),
      name: 'Zulu attention',
      syncStatus: 'corrupt',
    });
    const alphaAttention = perVault({
      id: vaultId(1),
      name: 'Alpha attention',
      syncStatus: 'conflict',
    });

    const allStates = projectVaultSyncChip([
      zuluAttention,
      synced,
      locked,
      syncing,
      alphaAttention,
    ]);
    expect(allStates.aggregate).toEqual({
      state: 'needs-attention',
      vaultId: vaultId(1),
      vaultName: 'Alpha attention',
    });
    expect(allStates.lockedCount).toBe(1);
    expect(allStates.rows.map(({ vaultName, state }) => [vaultName, state])).toEqual([
      ['Alpha attention', 'needs-attention'],
      ['Locked', 'locked'],
      ['Synced', 'synced'],
      ['Syncing', 'syncing'],
      ['Zulu attention', 'needs-attention'],
    ]);

    expect(projectVaultSyncChip([synced, locked, syncing]).aggregate).toEqual({
      state: 'syncing',
    });
    expect(projectVaultSyncChip([synced, locked]).aggregate).toEqual({
      state: 'locked',
      count: 1,
    });
    expect(projectVaultSyncChip([synced]).aggregate).toEqual({ state: 'synced' });
    expect(projectVaultSyncChip([]).aggregate).toEqual({ state: 'synced' });
  });

  it('counts locked custody independently and preserves its required action verbatim', () => {
    const custodyAction = {
      kind: 'provide-phrase',
      methods: ['enter-words', 'scan-qr'],
    } as const;
    const endpointState = {
      status: 'not-on-this-endpoint',
      requiredAction: custodyAction,
    } satisfies EndpointVaultState;

    const projection = projectVaultSyncChip([
      perVault({
        id: vaultId(1),
        name: 'Drive vault',
        media: ['server', 'drive'],
        driveConnectionId: vaultId(91),
        driveAuthorization: 'token-expired',
        endpointState,
        online: false,
        syncStatus: 'synced',
      }),
    ]);

    expect(projection.aggregate).toEqual({
      state: 'needs-attention',
      vaultId: vaultId(1),
      vaultName: 'Drive vault',
    });
    expect(projection.lockedCount).toBe(1);
    expect(projection.rows[0]).toMatchObject({
      state: 'needs-attention',
      perMedium: { server: 'offline', drive: 'needs-attention' },
      syncAction: { kind: 'authorize-drive', connectionId: vaultId(91) },
    });
    expect(projection.rows[0]?.custodyAction).toBe(custodyAction);
  });

  it('projects locked unknown media without inventing sync acknowledgement', () => {
    const projection = projectVaultSyncChip([
      perVault({
        id: vaultId(1),
        name: 'Cold vault',
        media: ['server', 'drive'],
        driveConnectionId: vaultId(91),
        endpointState: LOCKED_ENDPOINT,
        syncStatus: null,
      }),
    ]);

    expect(projection).toMatchObject({
      aggregate: { state: 'locked', count: 1 },
      lockedCount: 1,
      rows: [
        {
          state: 'locked',
          perMedium: { server: 'disconnected', drive: 'disconnected' },
          pendingWrites: false,
          problem: null,
          syncAction: null,
        },
      ],
    });
  });

  it('counts every locked vault and keeps same-name rows deterministic by id', () => {
    const projection = projectVaultSyncChip([
      perVault({
        id: vaultId(2),
        name: 'Cold copy',
        endpointState: LOCKED_ENDPOINT,
        syncStatus: null,
      }),
      perVault({
        id: vaultId(1),
        name: 'Cold copy',
        endpointState: LOCKED_ENDPOINT,
        syncStatus: null,
      }),
    ]);

    expect(projection.aggregate).toEqual({ state: 'locked', count: 2 });
    expect(projection.lockedCount).toBe(2);
    expect(projection.rows.map(({ vaultId: id }) => id)).toEqual([vaultId(1), vaultId(2)]);
    expect(projection.rows.map(({ custodyAction }) => custodyAction)).toEqual([
      LOCKED_ENDPOINT.requiredAction,
      LOCKED_ENDPOINT.requiredAction,
    ]);
  });

  it('keeps conflicts above pending work and supplies the restore affordance', () => {
    const projection = projectVaultSyncChip([
      perVault({
        id: vaultId(1),
        name: 'Split copy',
        operationPending: true,
        pendingWrites: true,
        syncStatus: 'unresolved',
        lastWriteAt: '2026-08-21T12:00:00.000Z',
      }),
    ]);

    expect(projection.rows[0]).toMatchObject({
      state: 'needs-attention',
      lastWriteAt: '2026-08-21T12:00:00.000Z',
      pendingWrites: true,
      problem: 'unresolved',
      syncAction: { kind: 'open-restore-picker' },
    });
  });
});

function perVault({
  id,
  name,
  media = ['server'],
  driveConnectionId = null,
  endpointState = OPEN_ENDPOINT,
  syncStatus = 'synced',
  driveAuthorization = 'connected',
  online = true,
  operationPending,
  pendingWrites,
  lastWriteAt,
}: {
  id: string;
  name: string;
  media?: PerVaultSyncProjectionInput['vault']['media'];
  driveConnectionId?: string | null;
  endpointState?: EndpointVaultState;
  syncStatus?: VaultSyncStatus | null;
  driveAuthorization?: PerVaultSyncProjectionInput['driveAuthorization'];
  online?: boolean;
  operationPending?: boolean;
  pendingWrites?: boolean;
  lastWriteAt?: string | null;
}): PerVaultSyncProjectionInput {
  return {
    vault: { id, name, media, driveConnectionId },
    endpointState,
    syncStatus,
    driveAuthorization,
    online,
    operationPending,
    pendingWrites,
    lastWriteAt,
  };
}

function vaultId(suffix: number): string {
  return `019c8190-0000-7000-8000-${suffix.toString().padStart(12, '0')}`;
}
