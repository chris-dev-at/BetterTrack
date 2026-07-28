import { describe, expect, it, vi } from 'vitest';

import type { ParanoidVaultMediaState } from '@bettertrack/contracts';

import type { DriveAccessTokenResult, GoogleDriveTokenClient } from '../drive';
import type { VaultSyncCandidate, VaultSyncState } from '../sync';
import { createDriveConnectionController } from './driveConnection';
import type {
  VaultMediaSwitcher,
  VaultMediaSwitchResult,
  VaultRetiredPurgeResult,
} from './mediaSwitcher';

const media: ParanoidVaultMediaState = {
  mediaSet: ['server', 'drive'],
  driveAttestedVersion: 3,
  server: { disposition: 'active', candidate: null, retired: null },
};

function setup({
  authorized = false,
  leftover = false,
  resumeFailure = null,
  resumeStatus = 'synced',
}: {
  authorized?: boolean;
  leftover?: boolean;
  resumeFailure?: Error | null;
  resumeStatus?: VaultSyncState['status'];
} = {}) {
  let state: GoogleDriveTokenClient['state'] = authorized ? 'connected' : 'token-expired';
  const clear = vi.fn(() => {
    state = 'consent-required';
  });
  const tokens: GoogleDriveTokenClient = {
    get state() {
      return state;
    },
    getAccessToken: vi.fn(
      (): DriveAccessTokenResult =>
        state === 'connected'
          ? { status: 'ok', accessToken: 'memory-only', expiresAt: Date.now() + 60_000 }
          : { status: state, message: 'sign in' },
    ),
    subscribe: vi.fn(() => () => undefined),
    authorize: vi.fn(async (): Promise<DriveAccessTokenResult> => {
      state = 'connected';
      return { status: 'ok', accessToken: 'memory-only', expiresAt: Date.now() + 60_000 };
    }),
    clear,
    markExpired: vi.fn(() => {
      state = 'token-expired';
    }),
  };
  const switcher: VaultMediaSwitcher = {
    add: vi.fn(
      async (): Promise<VaultMediaSwitchResult> => ({
        status: 'ok',
        media,
        driveLeftover: false,
      }),
    ),
    remove: vi.fn(
      async (): Promise<VaultMediaSwitchResult> =>
        leftover
          ? {
              status: 'drive-leftover',
              media,
              driveLeftover: true,
              stage: 'delete-drive',
              message: 'leftover',
            }
          : { status: 'ok', media, driveLeftover: false },
    ),
    purgeRetiredServer: vi.fn(
      async (): Promise<VaultRetiredPurgeResult> => ({ status: 'ok', media }),
    ),
  };
  const ready = vi.fn(async () => undefined);
  const active = {} as VaultSyncCandidate;
  const resumeState: VaultSyncState = {
    status: resumeStatus,
    active,
    pending: resumeStatus === 'synced' ? null : active,
  };
  const resumeSync = vi.fn(async () => {
    if (resumeFailure) throw resumeFailure;
    return resumeState;
  });
  const controller = createDriveConnectionController({ tokens, switcher, ready, resumeSync });
  return { controller, tokens, switcher, ready, resumeSync, clear };
}

describe('Drive connection controller', () => {
  it('uses an explicit authorization gesture, then resumes the existing sync coordinator', async () => {
    const setupResult = setup();

    await expect(setupResult.controller.connect()).resolves.toMatchObject({ status: 'ok' });

    expect(setupResult.tokens.authorize).toHaveBeenCalledTimes(1);
    expect(setupResult.ready).toHaveBeenCalledTimes(1);
    expect(setupResult.switcher.add).toHaveBeenCalledWith('drive');
    expect(setupResult.resumeSync).toHaveBeenCalledTimes(1);
  });

  it('keeps the token, reports a leftover, and resumes on the durable server-only set', async () => {
    const setupResult = setup({ authorized: true, leftover: true });

    await expect(setupResult.controller.disconnect()).resolves.toMatchObject({
      status: 'drive-leftover',
    });

    expect(setupResult.clear).not.toHaveBeenCalled();
    expect(setupResult.resumeSync).toHaveBeenCalledTimes(1);
  });

  it('drops the browser-only token after a verified Drive removal', async () => {
    const setupResult = setup({ authorized: true });

    await expect(setupResult.controller.disconnect()).resolves.toMatchObject({ status: 'ok' });

    expect(setupResult.clear).toHaveBeenCalledTimes(1);
    expect(setupResult.resumeSync).toHaveBeenCalledTimes(1);
  });

  it('routes both Drive-only and server-restoration choices through the media switcher', async () => {
    const setupResult = setup({ authorized: true });

    await setupResult.controller.useDriveOnly();
    await setupResult.controller.addServerCopy();

    expect(setupResult.switcher.remove).toHaveBeenCalledWith('server');
    expect(setupResult.switcher.add).toHaveBeenCalledWith('server');
    expect(setupResult.resumeSync).toHaveBeenCalledTimes(2);
  });

  it('preserves a committed switch when its follow-up synchronization fails', async () => {
    const resumeFailure = new Error('reconnect failed');
    const setupResult = setup({ authorized: true, resumeFailure });

    await expect(setupResult.controller.useDriveOnly()).resolves.toMatchObject({
      status: 'ok',
      media,
      driveLeftover: false,
      synchronization: { status: 'pending', cause: resumeFailure },
    });

    expect(setupResult.switcher.remove).toHaveBeenCalledWith('server');
    expect(setupResult.resumeSync).toHaveBeenCalledTimes(1);
  });

  it.each(['pending-offline', 'conflict'] as const)(
    'preserves a committed switch when synchronization resolves %s',
    async (resumeStatus) => {
      const setupResult = setup({ authorized: true, resumeStatus });

      await expect(setupResult.controller.useDriveOnly()).resolves.toMatchObject({
        status: 'ok',
        media,
        driveLeftover: false,
        synchronization: {
          status: 'pending',
          state: { status: resumeStatus, active: {}, pending: {} },
        },
      });

      expect(setupResult.resumeSync).toHaveBeenCalledTimes(1);
    },
  );

  it('does not suppress a committed Drive-leftover result when resuming fails', async () => {
    const setupResult = setup({
      authorized: true,
      leftover: true,
      resumeFailure: new Error('reconnect failed'),
    });

    await expect(setupResult.controller.disconnect()).resolves.toMatchObject({
      status: 'drive-leftover',
      driveLeftover: true,
      synchronization: { status: 'pending' },
    });

    expect(setupResult.clear).not.toHaveBeenCalled();
  });
});
