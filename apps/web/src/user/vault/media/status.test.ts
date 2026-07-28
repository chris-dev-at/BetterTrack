import { describe, expect, it } from 'vitest';

import type { ParanoidVaultMediaState } from '@bettertrack/contracts';

import { projectVaultMediaSyncStatus } from './status';

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
