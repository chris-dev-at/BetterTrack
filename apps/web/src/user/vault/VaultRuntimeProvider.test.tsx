import { webcrypto } from 'node:crypto';

import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { base64ToBytes } from './bytes';
import type { DataHomeReadResult } from './dataHome';
import type { DriveAccessTokenResult, DriveDataHome, GoogleDriveTokenClient } from './drive';
import type { DriveConnectionController, UnlockedVaultDriveRuntime } from './media';
import {
  useVaultRuntime,
  VaultRuntimeProvider,
  type VaultRuntimeProviderDependencies,
} from './VaultRuntimeProvider';
import fixture from './vectors.fixture.json';

const envelope = base64ToBytes(fixture.initial.envelopeBase64, 'envelope-invalid');

beforeEach(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
});

describe('VaultRuntimeProvider Drive bootstrap', () => {
  it('authorizes and reads Drive before unlocking a fresh Drive-only device', async () => {
    const events: string[] = [];
    let authorization: GoogleDriveTokenClient['state'] = 'consent-required';
    const tokens: GoogleDriveTokenClient = {
      get state() {
        return authorization;
      },
      getAccessToken: vi.fn(
        (): DriveAccessTokenResult =>
          authorization === 'connected'
            ? { status: 'ok', accessToken: 'memory-only', expiresAt: Date.now() + 60_000 }
            : { status: authorization, message: 'sign in' },
      ),
      authorize: vi.fn(async (): Promise<DriveAccessTokenResult> => {
        events.push('authorize');
        authorization = 'connected';
        return { status: 'ok', accessToken: 'memory-only', expiresAt: Date.now() + 60_000 };
      }),
      clear: vi.fn(() => {
        authorization = 'consent-required';
      }),
      markExpired: vi.fn(() => {
        authorization = 'token-expired';
      }),
    };
    const drive: DriveDataHome = {
      medium: 'drive',
      read: vi.fn(async (): Promise<DataHomeReadResult> => {
        events.push('drive-read');
        return {
          status: 'ok',
          medium: 'drive',
          envelope,
          info: {
            medium: 'drive',
            version: fixture.initial.header.vaultVersion,
            sizeBytes: envelope.byteLength,
            updatedAt: fixture.initial.header.writtenAt,
          },
        };
      }),
      write: vi.fn(),
      info: vi.fn(),
      delete: vi.fn(),
    };
    const controller = connection();
    const dispose = vi.fn();
    const createRuntime: NonNullable<VaultRuntimeProviderDependencies['createRuntime']> = vi.fn(
      (_vaultKey, keyId): UnlockedVaultDriveRuntime => {
        events.push('runtime');
        expect(keyId).toBe(fixture.initial.header.keyId);
        return {
          controller,
          ready: Promise.resolve(),
          syncState: { status: 'synced', active: null, pending: null },
          reconnect: vi.fn(async () => ({
            status: 'synced' as const,
            active: null,
            pending: null,
          })),
          dispose,
        };
      },
    );
    const serverRead = vi.fn();
    const rendered = render(
      <VaultRuntimeProvider
        authenticated
        userId="018f0000-0000-7000-8000-000000000099"
        dependencies={{
          clientId: 'browser-client-id',
          tokens,
          drive,
          readEnvelope: serverRead,
          createRuntime,
        }}
      >
        <UnlockHarness />
      </VaultRuntimeProvider>,
    );

    await userEvent.setup().click(screen.getByRole('button', { name: 'unlock' }));
    expect(await screen.findByText('unlocked')).toBeInTheDocument();

    expect(events).toEqual(['authorize', 'drive-read', 'runtime']);
    expect(serverRead).not.toHaveBeenCalled();
    expect(createRuntime).toHaveBeenCalledTimes(1);

    rendered.unmount();
    await waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
    expect(tokens.clear).toHaveBeenCalled();
  });
});

function UnlockHarness() {
  const runtime = useVaultRuntime();
  const [unlocked, setUnlocked] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void runtime
          .unlockWithPassphrase(fixture.passphrase, {
            authorizeDrive: true,
            driveOnly: true,
          })
          .then(() => setUnlocked(true));
      }}
    >
      {unlocked ? 'unlocked' : 'unlock'}
    </button>
  );
}

function connection(): DriveConnectionController {
  return {
    authorization: 'connected',
    connect: vi.fn(async () => ({
      status: 'authorization-required' as const,
      authorization: 'gesture-required' as const,
    })),
    disconnect: vi.fn(async () => ({
      status: 'authorization-required' as const,
      authorization: 'gesture-required' as const,
    })),
    useDriveOnly: vi.fn(async () => ({
      status: 'authorization-required' as const,
      authorization: 'gesture-required' as const,
    })),
    addServerCopy: vi.fn(async () => ({
      status: 'authorization-required' as const,
      authorization: 'gesture-required' as const,
    })),
    resume: vi.fn(async () => ({ status: 'ok' as const })),
    purgeRetiredServer: vi.fn(async () => ({
      status: 'authorization-required' as const,
      authorization: 'gesture-required' as const,
    })),
  };
}
