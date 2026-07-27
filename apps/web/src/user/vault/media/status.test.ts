import type { VaultMediaStateResponse } from '@bettertrack/contracts';
import { describe, expect, it } from 'vitest';

import { projectVaultMediaSyncStatus } from './status';

const media: VaultMediaStateResponse = {
  mediaSet: ['server', 'drive'],
  driveAttestedVersion: 3,
  retiredServer: null,
};

describe('Drive sync status projection', () => {
  it('maps expiry and gesture-required authorization to the sign-in attention state', () => {
    for (const driveAuthorization of ['token-expired', 'gesture-required'] as const) {
      expect(
        projectVaultMediaSyncStatus({
          media,
          syncStatus: 'pending-offline',
          driveAuthorization,
          online: true,
        }),
      ).toMatchObject({
        overall: 'needs-attention',
        messageKey: 'vault.sync.drive.signIn',
        perMedium: { drive: 'needs-attention' },
      });
    }
  });

  it('keeps offline writes pending and returns to syncing after a gesture', () => {
    expect(
      projectVaultMediaSyncStatus({
        media,
        syncStatus: 'pending-offline',
        driveAuthorization: 'connected',
        online: false,
      }),
    ).toMatchObject({ overall: 'offline', perMedium: { drive: 'offline' } });
    expect(
      projectVaultMediaSyncStatus({
        media,
        syncStatus: 'pending-offline',
        driveAuthorization: 'connected',
        online: true,
      }),
    ).toMatchObject({ overall: 'syncing', perMedium: { drive: 'syncing' } });
  });
});
