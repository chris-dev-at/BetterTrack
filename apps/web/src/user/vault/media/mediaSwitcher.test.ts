import type {
  RetiredServerVaultPurgeResponse,
  VaultMediaPatchRequest,
  VaultMediaStateResponse,
  VaultMedium,
} from '@bettertrack/contracts';
import { describe, expect, it } from 'vitest';

import type {
  DataHome,
  DataHomeInfoResult,
  DataHomeReadResult,
  DataHomeWriteOptions,
  DataHomeWriteResult,
} from '../dataHome';
import type { DriveDataHome, DriveDeleteResult } from '../drive';
import { createVaultMediaSwitcher, type VaultMediaApi } from './mediaSwitcher';
import type { AuthenticatedVaultCopy } from './verification';

function bytes(version: number, write: number): Uint8Array {
  return new Uint8Array([version, write]);
}

class MemoryHome implements DataHome {
  readonly medium: VaultMedium;
  value: Uint8Array | null;
  writes = 0;
  readFailure: DataHomeReadResult | null = null;
  writeFailure: DataHomeWriteResult | null = null;
  mutateAfterWrite: ((value: Uint8Array) => Uint8Array) | null = null;

  constructor(medium: VaultMedium, value: Uint8Array | null) {
    this.medium = medium;
    this.value = value?.slice() ?? null;
  }

  async read(): Promise<DataHomeReadResult> {
    if (this.readFailure) return this.readFailure;
    if (!this.value) return { status: 'absent', medium: this.medium };
    return {
      status: 'ok',
      medium: this.medium,
      envelope: this.value.slice(),
      info: this.infoValue(),
    };
  }

  async write(envelope: Uint8Array, options: DataHomeWriteOptions): Promise<DataHomeWriteResult> {
    this.writes += 1;
    if (this.writeFailure) return this.writeFailure;
    const currentVersion = this.value?.[0] ?? null;
    const nextVersion = envelope[0]!;
    if (
      currentVersion !== options.ifVersion ||
      (options.ifVersion !== null && nextVersion <= options.ifVersion)
    ) {
      return { status: 'conflict', medium: this.medium, currentVersion };
    }
    this.value = (this.mutateAfterWrite?.(envelope) ?? envelope).slice();
    return { status: 'ok', medium: this.medium, info: this.infoValue() };
  }

  async info(): Promise<DataHomeInfoResult> {
    return this.value
      ? { status: 'ok', medium: this.medium, info: this.infoValue() }
      : { status: 'absent', medium: this.medium };
  }

  private infoValue() {
    return {
      medium: this.medium,
      version: this.value![0]!,
      sizeBytes: this.value!.byteLength,
      updatedAt: '2026-07-27T10:00:00.000Z',
    };
  }
}

class MemoryDriveHome extends MemoryHome implements DriveDataHome {
  override readonly medium = 'drive' as const;
  deleteFailure = false;
  deletes = 0;

  constructor(value: Uint8Array | null) {
    super('drive', value);
  }

  async delete(): Promise<DriveDeleteResult> {
    this.deletes += 1;
    if (this.deleteFailure) {
      return {
        status: 'transport-failure',
        failure: { code: 'api-failure', message: 'Drive delete failed.' },
      };
    }
    const deleted = this.value !== null;
    this.value = null;
    return { status: 'ok', deleted };
  }
}

class FakeMediaApi implements VaultMediaApi {
  state: VaultMediaStateResponse;
  requests: VaultMediaPatchRequest[] = [];
  failPatch = false;
  failPurge = false;
  serverDisposition: 'active' | 'retired' | 'absent';
  retiredPresent = false;

  constructor(
    mediaSet: VaultMediaStateResponse['mediaSet'],
    private readonly server: MemoryHome,
  ) {
    this.serverDisposition = mediaSet.includes('server') ? 'active' : 'absent';
    this.state = {
      mediaSet,
      driveAttestedVersion: mediaSet.includes('drive') ? (server.value?.[0] ?? 1) : null,
      retiredServer: null,
    };
  }

  async getState(): Promise<VaultMediaStateResponse> {
    return structuredClone(this.state);
  }

  async patch(request: VaultMediaPatchRequest): Promise<VaultMediaStateResponse> {
    this.requests.push(structuredClone(request));
    if (this.failPatch) throw new Error('PATCH interrupted');
    if (!sameSet(request.expectedMediaSet, this.state.mediaSet)) throw new Error('stale set');
    const removedServer =
      this.state.mediaSet.includes('server') && !request.mediaSet.includes('server');
    const addedServer =
      !this.state.mediaSet.includes('server') && request.mediaSet.includes('server');
    if (removedServer) {
      this.serverDisposition = 'retired';
      this.retiredPresent = true;
      this.server.value = null;
    } else if (addedServer) {
      this.serverDisposition = 'active';
    }
    this.state = {
      mediaSet: request.mediaSet,
      driveAttestedVersion: request.mediaSet.includes('drive')
        ? (request.verification?.vaultVersion ?? this.state.driveAttestedVersion)
        : null,
      retiredServer: this.retiredPresent
        ? {
            latestVersion: request.verification?.vaultVersion ?? 1,
            retiredAt: '2026-07-27T10:00:00.000Z',
            purgeEligibleAt: '2026-08-03T10:00:00.000Z',
          }
        : null,
    };
    return this.getState();
  }

  async purgeDriveRetired(): Promise<RetiredServerVaultPurgeResponse> {
    if (this.failPurge) throw new Error('retention gate');
    const purgedVersions = this.retiredPresent ? 1 : 0;
    this.retiredPresent = false;
    this.serverDisposition = 'absent';
    this.state = { ...this.state, retiredServer: null };
    return {
      media: await this.getState(),
      purgedVersions,
      purgedBytes: purgedVersions * 2,
    };
  }
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

async function authenticate(envelope: Uint8Array): Promise<AuthenticatedVaultCopy> {
  if (envelope[1] === 255) throw new Error('authentication failed');
  return {
    envelope: envelope.slice(),
    vaultVersion: envelope[0]!,
    writeId: `write-${envelope[1]}`,
    envelopeSha256: Array.from(envelope, (value) => value.toString(16).padStart(2, '0'))
      .join('')
      .padEnd(64, '0'),
  };
}

function setup(
  mediaSet: VaultMediaStateResponse['mediaSet'],
  serverValue: Uint8Array | null,
  driveValue: Uint8Array | null,
) {
  const server = new MemoryHome('server', serverValue);
  const drive = new MemoryDriveHome(driveValue);
  const api = new FakeMediaApi(mediaSet, server);
  const switcher = createVaultMediaSwitcher({
    api,
    server,
    drive,
    authenticate,
    now: () => '2026-07-27T10:00:00.000Z',
  });
  return { server, drive, api, switcher };
}

describe('verified vault media switch matrix', () => {
  it('covers server → both → Drive-only → both → server', async () => {
    const flow = setup(['server'], bytes(1, 1), null);

    expect(await flow.switcher.add('drive')).toMatchObject({
      status: 'ok',
      media: { mediaSet: ['server', 'drive'] },
    });
    expect(flow.drive.value).toEqual(bytes(1, 1));
    expect(flow.api.serverDisposition).toBe('active');

    expect(await flow.switcher.remove('server')).toMatchObject({
      status: 'ok',
      media: { mediaSet: ['drive'] },
    });
    expect(flow.api.serverDisposition).toBe('retired');
    expect(flow.api.retiredPresent).toBe(true);
    expect(flow.drive.value).toEqual(bytes(1, 1));

    expect(await flow.switcher.add('server')).toMatchObject({
      status: 'ok',
      media: { mediaSet: ['server', 'drive'] },
    });
    expect(flow.api.serverDisposition).toBe('active');
    expect(flow.server.value).toEqual(bytes(1, 1));

    expect(await flow.switcher.remove('drive')).toMatchObject({
      status: 'ok',
      media: { mediaSet: ['server'] },
    });
    expect(flow.drive.value).toBeNull();
    expect(flow.api.serverDisposition).toBe('active');
    expect(flow.api.requests).toHaveLength(4);
    expect(Object.keys(flow.api.requests[0]!).sort()).toEqual([
      'expectedMediaSet',
      'mediaSet',
      'verification',
    ]);
  });

  it('makes an interrupted add retryable and a completed retry a no-op', async () => {
    const flow = setup(['server'], bytes(1, 1), bytes(1, 1));
    expect(await flow.switcher.add('drive')).toMatchObject({ status: 'ok' });
    expect(flow.drive.writes).toBe(0);
    expect(await flow.switcher.add('drive')).toMatchObject({ status: 'noop' });
    expect(flow.api.requests).toHaveLength(1);
  });

  it('leaves the old media authoritative on verification, stale-version and PATCH failure', async () => {
    const corrupt = setup(['server'], bytes(1, 1), null);
    corrupt.drive.mutateAfterWrite = () => bytes(1, 2);
    expect(await corrupt.switcher.add('drive')).toMatchObject({
      status: 'failed',
      stage: 'verify-round-trip',
      media: { mediaSet: ['server'] },
    });
    expect(corrupt.api.requests).toHaveLength(0);

    const stale = setup(['server'], bytes(1, 1), bytes(2, 2));
    expect(await stale.switcher.add('drive')).toMatchObject({
      status: 'failed',
      stage: 'write-target',
      media: { mediaSet: ['server'] },
    });
    expect(stale.api.requests).toHaveLength(0);

    const interrupted = setup(['server'], bytes(1, 1), null);
    interrupted.api.failPatch = true;
    expect(await interrupted.switcher.add('drive')).toMatchObject({
      status: 'failed',
      stage: 'patch-media',
      media: { mediaSet: ['server'] },
    });
    expect(interrupted.drive.value).toEqual(bytes(1, 1));
    expect(interrupted.api.serverDisposition).toBe('active');
    interrupted.api.failPatch = false;
    expect(await interrupted.switcher.add('drive')).toMatchObject({ status: 'ok' });
    expect(interrupted.drive.writes).toBe(1);
  });

  it('surfaces a failed Drive delete after the server-only PATCH and retries cleanup', async () => {
    const flow = setup(['server', 'drive'], bytes(1, 1), bytes(1, 1));
    flow.drive.deleteFailure = true;
    expect(await flow.switcher.remove('drive')).toMatchObject({
      status: 'drive-leftover',
      driveLeftover: true,
      media: { mediaSet: ['server'] },
    });
    expect(flow.api.serverDisposition).toBe('active');
    expect(flow.drive.value).toEqual(bytes(1, 1));

    flow.drive.deleteFailure = false;
    expect(await flow.switcher.remove('drive')).toMatchObject({ status: 'noop' });
    expect(flow.drive.value).toBeNull();
  });

  it('never removes the last medium and sends a decrypted Drive proof to gated purge', async () => {
    const flow = setup(['drive'], null, bytes(3, 3));
    expect(await flow.switcher.remove('drive')).toMatchObject({ status: 'last-medium' });
    expect(flow.api.requests).toHaveLength(0);

    flow.api.retiredPresent = true;
    flow.api.failPurge = true;
    await expect(flow.switcher.purgeRetiredServer()).resolves.toMatchObject({
      status: 'failed',
      stage: 'purge-retired',
    });
    expect(flow.api.retiredPresent).toBe(true);

    flow.api.failPurge = false;
    await expect(flow.switcher.purgeRetiredServer()).resolves.toMatchObject({
      status: 'ok',
      result: { purgedVersions: 1 },
    });
    expect(flow.api.retiredPresent).toBe(false);
  });

  it('rejects an unauthentic remaining copy before any removal PATCH', async () => {
    const flow = setup(['server', 'drive'], bytes(1, 1), bytes(1, 255));
    expect(await flow.switcher.remove('server')).toMatchObject({
      status: 'failed',
      stage: 'authenticate-source',
      media: { mediaSet: ['server', 'drive'] },
    });
    expect(flow.api.requests).toHaveLength(0);
    expect(flow.api.serverDisposition).toBe('active');
  });
});
