import type {
  ParanoidServerCandidateMetadata,
  VaultMediaPatchRequest,
  VaultMediaStateResponse,
} from '@bettertrack/contracts';
import { describe, expect, it } from 'vitest';

import { base64ToBytes } from '../bytes';
import type {
  DataHome,
  DataHomeInfoResult,
  DataHomeReadResult,
  DataHomeWriteOptions,
  DataHomeWriteResult,
} from '../dataHome';
import type { DriveDataHome, DriveDeleteResult, GoogleDriveTokenClient } from '../drive';
import fixture from '../vectors.fixture.json';
import { getDriveConnectionController } from './driveConnection';
import { installUnlockedVaultDriveRuntime } from './runtime';
import type { VaultMediaApi } from './mediaSwitcher';

class MemoryHome implements DataHome {
  readonly medium: 'server' | 'drive';

  constructor(
    medium: 'server' | 'drive',
    protected value: Uint8Array | null,
  ) {
    this.medium = medium;
  }

  async read(): Promise<DataHomeReadResult> {
    if (!this.value) return { status: 'absent', medium: this.medium };
    return {
      status: 'ok',
      medium: this.medium,
      envelope: this.value.slice(),
      info: {
        medium: this.medium,
        version: 1,
        sizeBytes: this.value.byteLength,
        updatedAt: '2026-07-24T10:00:00.000Z',
      },
    };
  }

  async write(envelope: Uint8Array, _options: DataHomeWriteOptions): Promise<DataHomeWriteResult> {
    this.value = envelope.slice();
    return {
      status: 'ok',
      medium: this.medium,
      info: {
        medium: this.medium,
        version: 1,
        sizeBytes: envelope.byteLength,
        updatedAt: '2026-07-24T10:00:00.000Z',
      },
    };
  }

  async info(): Promise<DataHomeInfoResult> {
    const read = await this.read();
    return read.status === 'ok' ? { status: 'ok', medium: this.medium, info: read.info } : read;
  }
}

class MemoryDrive extends MemoryHome implements DriveDataHome {
  override readonly medium = 'drive' as const;

  constructor(value: Uint8Array | null) {
    super('drive', value);
  }

  async delete(): Promise<DriveDeleteResult> {
    const deleted = this.value !== null;
    this.value = null;
    return { status: 'ok', deleted };
  }
}

describe('unlocked Drive runtime composition', () => {
  it('installs the production controller, resumes sync after a gesture, and disposes on lock', async () => {
    const envelope = base64ToBytes(fixture.initial.envelopeBase64, 'envelope-invalid');
    const vaultKey = base64ToBytes(fixture.vaultKeyBase64, 'envelope-invalid');
    const server = new MemoryHome('server', envelope);
    const drive = new MemoryDrive(null);
    let media: VaultMediaStateResponse = {
      mediaSet: ['server'],
      driveAttestedVersion: null,
      retiredServer: null,
    };
    const api: VaultMediaApi = {
      async getState() {
        return structuredClone(media);
      },
      async patch(request: VaultMediaPatchRequest) {
        media = {
          mediaSet: request.mediaSet,
          driveAttestedVersion: request.mediaSet.includes('drive')
            ? (request.verification?.vaultVersion ?? null)
            : null,
          retiredServer: null,
        };
        return structuredClone(media);
      },
      async purgeDriveRetired() {
        return { media: structuredClone(media), purgedVersions: 0, purgedBytes: 0 };
      },
      async stageServerCandidate(): Promise<ParanoidServerCandidateMetadata> {
        throw new Error('not used');
      },
      async readServerCandidate() {
        throw new Error('not used');
      },
      async discardServerCandidate() {},
    };
    let authorization: GoogleDriveTokenClient['state'] = 'consent-required';
    let clears = 0;
    const tokens: GoogleDriveTokenClient = {
      get state() {
        return authorization;
      },
      getAccessToken() {
        return {
          status: 'consent-required',
          message: 'not used by injected Drive home',
        };
      },
      async authorize() {
        authorization = 'connected';
        return { status: 'ok', accessToken: 'memory-only', expiresAt: Date.now() + 60_000 };
      },
      clear() {
        authorization = 'consent-required';
        clears += 1;
      },
      markExpired() {
        authorization = 'token-expired';
      },
    };
    let reconnects = 0;

    const dispose = installUnlockedVaultDriveRuntime(vaultKey, fixture.initial.header.keyId, {
      clientId: 'browser-client-id',
      tokens,
      server,
      drive,
      api,
      sync: {
        async reconnect() {
          reconnects += 1;
        },
      },
    });
    await Promise.resolve();
    const controller = getDriveConnectionController();
    expect(controller).not.toBeNull();
    await expect(controller!.connect()).resolves.toMatchObject({ status: 'ok' });
    expect(media.mediaSet).toEqual(['server', 'drive']);
    expect(reconnects).toBeGreaterThanOrEqual(2);

    dispose();
    expect(getDriveConnectionController()).toBeNull();
    expect(clears).toBe(1);
  });
});
