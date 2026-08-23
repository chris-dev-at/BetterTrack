import { describe, expect, it } from 'vitest';

import type { ParanoidVaultMediaState, VaultConfig } from '@bettertrack/contracts';

import type { EndpointVaultState } from '../keystore';

import { projectVaultMediaSyncStatus } from './status';

const both: ParanoidVaultMediaState = {
  mediaSet: ['server', 'drive'],
  driveAttestedVersion: 7,
  server: { disposition: 'active', candidate: null, retired: null },
};

const READY: EndpointVaultState = {
  status: 'stored+plain',
  requiredAction: { kind: 'open-silently' },
};
const LOCKED: EndpointVaultState = {
  status: 'not-on-this-endpoint',
  requiredAction: { kind: 'provide-phrase', methods: ['enter-words', 'scan-qr'] },
};

function vault(id: string, name: string, media: VaultConfig['media'] = ['server']): VaultConfig {
  return {
    id,
    name,
    headerDocId: `${id.slice(0, -1)}a`,
    commonDocId: `${id.slice(0, -1)}b`,
    media,
    driveConnectionId: media.includes('drive') ? '018f0000-0000-7000-8000-000000000099' : null,
    keyFingerprint: 'abcdefghijklmnop',
    retirementProofPublicKey: 'cHVibGljLWtleQ',
    retirementGeneration: 0,
    mediaAttestedAt: '2026-08-20T10:00:00.000Z',
    mediaAttestedDriveConnectionId: media.includes('drive')
      ? '018f0000-0000-7000-8000-000000000099'
      : null,
    createdAt: '2026-08-20T09:00:00.000Z',
    updatedAt: '2026-08-20T10:00:00.000Z',
  };
}

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

  it('applies attention > syncing > locked > synced across mixed vaults', () => {
    const synced = {
      vault: vault('018f0000-0000-7000-8000-000000000001', 'Synced'),
      endpointState: READY,
    };
    const locked = {
      vault: vault('018f0000-0000-7000-8000-000000000002', 'Locked'),
      endpointState: LOCKED,
    };
    const syncing = {
      vault: vault('018f0000-0000-7000-8000-000000000003', 'Syncing'),
      endpointState: READY,
      syncState: 'syncing' as const,
    };
    const attention = {
      vault: vault('018f0000-0000-7000-8000-000000000004', 'Drive', ['drive']),
      endpointState: READY,
      driveAuthorization: 'consent-required' as const,
    };

    expect(projectVaultMediaSyncStatus({ vaults: [synced, locked] })).toMatchObject({
      overall: 'locked',
      lockedCount: 1,
    });
    expect(projectVaultMediaSyncStatus({ vaults: [synced, locked, syncing] })).toMatchObject({
      overall: 'syncing',
    });
    expect(
      projectVaultMediaSyncStatus({ vaults: [synced, locked, syncing, attention] }),
    ).toMatchObject({
      overall: 'attention',
      attentionVaultName: 'Drive',
      rows: expect.arrayContaining([
        expect.objectContaining({
          vault: expect.objectContaining({ name: 'Drive' }),
          perMedium: { drive: 'needs-attention' },
          recoveryAction: 'drive-sign-in',
        }),
      ]),
    });
  });
});
