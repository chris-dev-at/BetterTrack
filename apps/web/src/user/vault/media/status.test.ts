import { describe, expect, it } from 'vitest';

import { projectDriveSyncStatus } from './status';

const durable = {
  mediaSet: ['server', 'drive'] as ('server' | 'drive')[],
  driveAttestedVersion: 4,
};

describe('Drive sync-chip projection', () => {
  it('maps expiry and gesture reauthorization to the explicit sign-in state', () => {
    for (const status of ['token-expired', 'gesture-required', 'consent-required'] as const) {
      expect(
        projectDriveSyncStatus({
          durable,
          token: { status },
          pendingLocalWrite: true,
          syncing: false,
          lastWriteAt: null,
        }),
      ).toMatchObject({
        state: 'needs-attention',
        messageKey: 'vault.sync.signInToGoogle',
        media: expect.arrayContaining([{ medium: 'drive', state: 'needs-sign-in' }]),
      });
    }
  });

  it('keeps offline writes pending and resumes their projection after a token returns', () => {
    const offline = projectDriveSyncStatus({
      durable,
      token: { status: 'offline' },
      pendingLocalWrite: true,
      syncing: false,
      lastWriteAt: '2026-07-26T10:00:00.000Z',
    });
    expect(offline.state).toBe('offline');

    const resumed = projectDriveSyncStatus({
      durable,
      token: { status: 'ready', expiresAt: Date.now() + 60_000 },
      pendingLocalWrite: true,
      syncing: false,
      lastWriteAt: offline.lastWriteAt,
    });
    expect(resumed).toMatchObject({
      state: 'syncing',
      messageKey: 'vault.sync.syncing',
      lastWriteAt: '2026-07-26T10:00:00.000Z',
    });
  });

  it('exposes both media and a true synced state only with no pending write', () => {
    expect(
      projectDriveSyncStatus({
        durable,
        token: { status: 'ready', expiresAt: Date.now() + 60_000 },
        pendingLocalWrite: false,
        syncing: false,
        lastWriteAt: null,
      }),
    ).toMatchObject({
      state: 'synced',
      media: [
        { medium: 'server', state: 'synced' },
        { medium: 'drive', state: 'synced' },
      ],
    });
  });
});
