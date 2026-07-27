import { describe, expect, it, vi } from 'vitest';

import type { GoogleDriveTokenClient } from '../drive';
import { createDriveConnectionController } from './driveConnection';
import type { VaultMediaSwitcher } from './mediaSwitcher';

const media = {
  mediaSet: ['server', 'drive'] as ('server' | 'drive')[],
  driveAttestedVersion: 2,
  retiredServer: null,
};

describe('Drive connection resume seam', () => {
  it('resumes the existing PD5 coordinator after a user-gesture token succeeds', async () => {
    const resumeSync = vi.fn(async () => undefined);
    const tokens: GoogleDriveTokenClient = {
      state: 'connected',
      getAccessToken: vi.fn(),
      authorize: vi.fn(
        async () =>
          ({
            status: 'ok',
            accessToken: 'memory-only',
            expiresAt: Date.now() + 60_000,
          }) as const,
      ),
      clear: vi.fn(),
      markExpired: vi.fn(),
    };
    const switcher = {
      add: vi.fn(async () => ({ status: 'noop', media, driveLeftover: false })),
      remove: vi.fn(),
      purgeRetiredServer: vi.fn(),
    } as unknown as VaultMediaSwitcher;
    const controller = createDriveConnectionController({ tokens, switcher, resumeSync });

    await expect(controller.connect()).resolves.toMatchObject({ status: 'noop' });
    expect(resumeSync).toHaveBeenCalledTimes(1);
  });

  it('never starts a media transition while consent or a gesture is still required', async () => {
    const add = vi.fn();
    const tokens: GoogleDriveTokenClient = {
      state: 'gesture-required',
      getAccessToken: vi.fn(),
      authorize: vi.fn(
        async () =>
          ({
            status: 'gesture-required',
            message: 'gesture required',
          }) as const,
      ),
      clear: vi.fn(),
      markExpired: vi.fn(),
    };
    const controller = createDriveConnectionController({
      tokens,
      switcher: {
        add,
        remove: vi.fn(),
        purgeRetiredServer: vi.fn(),
      } as unknown as VaultMediaSwitcher,
    });

    await expect(controller.connect()).resolves.toEqual({
      status: 'authorization-required',
      authorization: 'gesture-required',
    });
    expect(add).not.toHaveBeenCalled();
  });
});
