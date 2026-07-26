import { describe, expect, it, vi } from 'vitest';

import type {
  ParanoidMediaStatusResponse,
  PatchParanoidMediaRequest,
  PrepareParanoidMediaVerificationRequest,
  VaultMediaState,
} from '@bettertrack/contracts';

import { base64ToBytes } from '../bytes';
import type {
  DataHome,
  DataHomeReadResult,
  DataHomeWriteOptions,
  DataHomeWriteResult,
} from '../dataHome';
import type { DriveDataHome } from '../drive/driveDataHome';
import {
  createGoogleDriveTokenClient,
  type GoogleDriveTokenClient,
  type GoogleIdentityServices,
} from '../drive/tokenClient';
import { vaultInteroperabilityFixture } from '../vectors';
import {
  connectDriveConnection,
  createVaultDriveConnectionController,
  driveSyncStatus,
  installUnlockedVaultDriveRuntime,
} from './runtime';
import type { VaultMediaStateApi, VaultMediaSwitcher } from './switcher';

function memoryHome<M extends 'server' | 'drive'>(
  medium: M,
  initial: Uint8Array | null,
): DataHome & { readonly medium: M; value: Uint8Array | null } {
  return {
    medium,
    value: initial?.slice() ?? null,
    async read(): Promise<DataHomeReadResult> {
      if (this.value === null) return { status: 'absent', medium };
      return {
        status: 'ok',
        medium,
        envelope: this.value.slice(),
        info: {
          medium,
          version: 1,
          sizeBytes: this.value.byteLength,
          updatedAt: '2026-07-24T10:00:00.000Z',
        },
      };
    },
    async write(
      envelope: Uint8Array,
      { ifVersion }: DataHomeWriteOptions,
    ): Promise<DataHomeWriteResult> {
      const currentVersion = this.value === null ? null : 1;
      if (currentVersion !== ifVersion) {
        return { status: 'conflict', medium, currentVersion };
      }
      this.value = envelope.slice();
      return {
        status: 'ok',
        medium,
        info: {
          medium,
          version: 1,
          sizeBytes: envelope.byteLength,
          updatedAt: '2026-07-24T10:00:00.000Z',
        },
      };
    },
    async info() {
      const result = await this.read();
      return result.status === 'ok' ? { status: 'ok' as const, medium, info: result.info } : result;
    },
  };
}

describe('unlocked Drive runtime composition', () => {
  it('keeps the token until a persisted Drive cleanup retry completes', async () => {
    let cleanupPending = true;
    const remove = vi
      .fn<VaultMediaSwitcher['remove']>()
      .mockResolvedValueOnce({
        status: 'ok-with-drive-leftover',
        state: { mediaSet: ['server'], driveAttestedVersion: null },
        deleteResult: {
          status: 'transport-failure',
          medium: 'drive',
          failure: { kind: 'api-failure', message: 'delete failed' },
        },
      })
      .mockImplementationOnce(async () => {
        cleanupPending = false;
        return {
          status: 'no-op',
          state: { mediaSet: ['server'], driveAttestedVersion: null },
        };
      });
    const switcher: VaultMediaSwitcher = {
      switchTo: vi.fn(),
      add: vi.fn(),
      remove,
      needsDriveCleanup: () => cleanupPending,
    };
    const disconnect = vi.fn(async () => undefined);
    const tokens: GoogleDriveTokenClient = {
      prepare: vi.fn(async () => undefined),
      token: vi.fn(),
      authorize: vi.fn(),
      disconnect,
      invalidate: vi.fn(),
      status: () => ({ status: 'ready', expiresAt: Date.now() + 60_000 }),
    };
    const controller = createVaultDriveConnectionController({ tokens, switcher });
    const media: VaultMediaState = { mediaSet: ['server'], driveAttestedVersion: null };

    expect(controller.state(media)).toBe('needs-attention');
    await expect(controller.disconnect()).resolves.toMatchObject({
      status: 'ok-with-drive-leftover',
    });
    expect(disconnect).not.toHaveBeenCalled();
    expect(controller.state(media)).toBe('needs-attention');

    await expect(controller.disconnect()).resolves.toMatchObject({ status: 'no-op' });
    expect(disconnect).toHaveBeenCalledOnce();
    expect(controller.state(media)).toBe('disconnected');
  });

  it('projects live GIS connectivity through the controller and sync chip', async () => {
    let online = true;
    let callback: ((response: Record<string, unknown>) => void) | undefined;
    const requestAccessToken = vi.fn();
    const google: GoogleIdentityServices = {
      accounts: {
        oauth2: {
          initTokenClient: vi.fn((config) => {
            callback = config.callback;
            return { requestAccessToken };
          }),
          revoke: vi.fn(),
        },
      },
    };
    const tokens = createGoogleDriveTokenClient({
      clientId: 'browser-client-id',
      google,
      online: () => online,
    });
    const authorization = tokens.authorize();
    await vi.waitFor(() => expect(requestAccessToken).toHaveBeenCalledOnce());
    callback?.({ access_token: 'memory-only-token', expires_in: 3600 });
    await expect(authorization).resolves.toMatchObject({ status: 'ok' });

    const failedSwitch = async () => ({
      status: 'failed' as const,
      reason: 'source-unavailable' as const,
      authoritativeState: null,
    });
    const switcher: VaultMediaSwitcher = {
      switchTo: failedSwitch,
      add: failedSwitch,
      remove: failedSwitch,
      needsDriveCleanup: () => false,
    };
    const controller = createVaultDriveConnectionController({
      tokens,
      switcher,
      sync: {
        reconnect: vi.fn(async () => undefined),
        snapshot: () => ({
          pendingLocalWrite: true,
          syncing: false,
          lastWriteAt: '2026-07-26T10:00:00.000Z',
        }),
      },
    });
    const media: VaultMediaState = {
      mediaSet: ['server', 'drive'],
      driveAttestedVersion: 1,
    };

    expect(controller.state(media)).toBe('connected');
    online = false;
    expect(tokens.status()).toEqual({ status: 'offline' });
    expect(controller.state(media)).toBe('offline');
    expect(controller.syncStatus(media)).toMatchObject({
      state: 'offline',
      messageKey: 'vault.sync.offline',
      media: expect.arrayContaining([{ medium: 'drive', state: 'offline' }]),
    });

    online = true;
    expect(controller.state(media)).toBe('connected');
    expect(controller.syncStatus(media).state).toBe('syncing');
  });

  it('installs the real switcher boundary and resumes pending sync after consent', async () => {
    const fixture = vaultInteroperabilityFixture;
    const envelope = base64ToBytes(fixture.initial.envelopeBase64, 'envelope-invalid');
    const server = memoryHome('server', envelope);
    const driveBase = memoryHome('drive', null);
    const drive: DriveDataHome & { value: Uint8Array | null } = Object.assign(driveBase, {
      async delete() {
        drive.value = null;
        return { status: 'ok' as const, medium: 'drive' as const };
      },
    });
    let durable: VaultMediaState = { mediaSet: ['server'], driveAttestedVersion: null };
    const prepared: PrepareParanoidMediaVerificationRequest[] = [];
    const state: VaultMediaStateApi = {
      async get(): Promise<ParanoidMediaStatusResponse> {
        return { privacyMode: 'paranoid', mediaState: structuredClone(durable) };
      },
      async prepare(request) {
        prepared.push(request);
        return { proof: 'p'.repeat(32), expiresAt: '2026-07-26T10:02:00.000Z' };
      },
      async patch(request: PatchParanoidMediaRequest) {
        const addsDrive =
          !durable.mediaSet.includes('drive') && request.nextMediaSet.includes('drive');
        durable = {
          mediaSet: [...request.nextMediaSet],
          driveAttestedVersion: !request.nextMediaSet.includes('drive')
            ? null
            : addsDrive
              ? durable.driveAttestedVersion
              : request.verification.version,
        };
        return structuredClone(durable);
      },
      async stageServer() {
        throw new Error('not used');
      },
      async readServerCandidate() {
        throw new Error('not used');
      },
      async discardServerCandidate() {
        throw new Error('not used');
      },
    };
    const tokens: GoogleDriveTokenClient = {
      prepare: vi.fn(async () => undefined),
      token: vi.fn(async () => ({
        status: 'ok' as const,
        accessToken: 'memory-only',
        expiresAt: Date.now() + 60_000,
      })),
      authorize: vi.fn(async () => ({
        status: 'ok' as const,
        accessToken: 'memory-only',
        expiresAt: Date.now() + 60_000,
      })),
      disconnect: vi.fn(async () => undefined),
      invalidate: vi.fn(),
      status: () => ({ status: 'ready', expiresAt: Date.now() + 60_000 }),
    };
    const reconnect = vi.fn(async () => undefined);
    const dispose = installUnlockedVaultDriveRuntime(
      base64ToBytes(fixture.vaultKeyBase64, 'envelope-invalid'),
      fixture.initial.header.keyId,
      {
        clientId: 'browser-client-id',
        tokens,
        server,
        drive,
        state,
        sync: {
          reconnect,
          snapshot: () => ({
            pendingLocalWrite: true,
            syncing: false,
            lastWriteAt: '2026-07-26T10:00:00.000Z',
          }),
        },
      },
    );
    expect(reconnect).toHaveBeenCalledOnce();

    await expect(connectDriveConnection()).resolves.toMatchObject({
      status: 'ok',
      state: { mediaSet: ['server', 'drive'], driveAttestedVersion: 1 },
    });
    expect(prepared).toHaveLength(2);
    expect(drive.value).toEqual(envelope);
    expect(reconnect).toHaveBeenCalledTimes(2);
    expect(driveSyncStatus(durable)).toMatchObject({
      state: 'syncing',
      lastWriteAt: '2026-07-26T10:00:00.000Z',
    });

    dispose();
    await expect(connectDriveConnection()).resolves.toMatchObject({
      status: 'failed',
      reason: 'source-unavailable',
    });
  });
});
