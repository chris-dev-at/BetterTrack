import type {
  ParanoidMediaStateResponse,
  ParanoidMediaTransitionRequest,
  ParanoidServerCandidateMetadata,
  ParanoidVaultMediaState,
  RetiredServerPurgeRequest,
  VaultMedium,
} from '@bettertrack/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { ParanoidServerCandidateReadback } from '../../../lib/userApi';
import type {
  DataHome,
  DataHomeInfoResult,
  DataHomeReadResult,
  DataHomeWriteOptions,
  DataHomeWriteResult,
} from '../dataHome';
import type { DriveDataHome, DriveDeleteResult, DriveReplicaCycle } from '../drive';
import { createVaultMediaSwitcher, type VaultMediaApi } from './mediaSwitcher';
import type { VaultRetirementProofManager } from './retirementProof';
import type { AuthenticatedVaultCopy } from './verification';

function bytes(version: number, write: number): Uint8Array {
  return new Uint8Array([version, write]);
}

class MemoryHome implements DataHome {
  readonly medium: VaultMedium;
  value: Uint8Array | null;
  writes = 0;
  reads = 0;
  readFailure: DataHomeReadResult | null = null;
  writeFailure: DataHomeWriteResult | null = null;
  mutateAfterWrite: ((value: Uint8Array) => Uint8Array) | null = null;
  mutateOnRead: ((value: Uint8Array, reads: number) => Uint8Array) | null = null;

  constructor(medium: VaultMedium, value: Uint8Array | null) {
    this.medium = medium;
    this.value = value?.slice() ?? null;
  }

  async read(): Promise<DataHomeReadResult> {
    this.reads += 1;
    if (this.readFailure) return this.readFailure;
    if (!this.value) return { status: 'absent', medium: this.medium };
    this.value = (this.mutateOnRead?.(this.value, this.reads) ?? this.value).slice();
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

  protected infoValue() {
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
  beforeDelete: (() => void) | null = null;
  /**
   * Extra same-name appdata objects, as two devices concurrently creating the
   * file produce. `read()` keeps masking them the way the real adapter does;
   * only `observeReplicas()` reveals the unconverged set.
   */
  duplicates: Uint8Array[] = [];
  private revision = 1;

  constructor(value: Uint8Array | null) {
    super('drive', value);
  }

  async observeReplicas(): Promise<DriveReplicaCycle> {
    const observations = [
      await this.read(),
      ...this.duplicates.map((value) => duplicateObservation(value)),
    ];
    const frozenValue = this.value?.slice() ?? null;
    const frozenRevision = this.revision;
    return {
      observations,
      async converge() {
        throw new Error('The single-file test Drive cannot converge duplicates.');
      },
      deleteIfUnchanged: async (verify): Promise<DriveDeleteResult> => {
        const beforeDelete = this.beforeDelete;
        this.beforeDelete = null;
        beforeDelete?.();
        if (this.revision !== frozenRevision || !optionalBytesEqual(this.value, frozenValue)) {
          return cleanupMoved();
        }
        if (this.value == null) return { status: 'ok', deleted: false };
        const refreshed = [await this.read()];
        if (!(await verify(refreshed)) || this.revision !== frozenRevision) {
          return cleanupMoved();
        }
        if (this.deleteFailure) {
          return {
            status: 'transport-failure',
            failure: { code: 'api-failure', message: 'Drive delete failed.' },
          };
        }
        this.deletes += 1;
        this.value = null;
        this.revision += 1;
        return { status: 'ok', deleted: true };
      },
    };
  }

  advance(value: Uint8Array): void {
    this.value = value.slice();
    this.revision += 1;
  }
}

function duplicateObservation(value: Uint8Array): DataHomeReadResult {
  return {
    status: 'ok',
    medium: 'drive',
    envelope: value.slice(),
    info: {
      medium: 'drive',
      version: value[0]!,
      sizeBytes: value.byteLength,
      updatedAt: '2026-07-27T09:59:00.000Z',
    },
  };
}

function optionalBytesEqual(left: Uint8Array | null, right: Uint8Array | null): boolean {
  return (
    left === right ||
    (left != null &&
      right != null &&
      left.length === right.length &&
      left.every((value, index) => value === right[index]))
  );
}

function cleanupMoved(): Extract<DriveDeleteResult, { status: 'transport-failure' }> {
  return {
    status: 'transport-failure',
    failure: { code: 'api-failure', message: 'Drive changed before cleanup.' },
  };
}

class FakeMediaApi implements VaultMediaApi {
  media: ParanoidVaultMediaState;
  requests: ParanoidMediaTransitionRequest[] = [];
  purgeRequests: RetiredServerPurgeRequest[] = [];
  failTransition = false;
  failPurge = false;
  candidate: { metadata: ParanoidServerCandidateMetadata; envelope: Uint8Array } | null = null;

  constructor(
    mediaSet: ParanoidVaultMediaState['mediaSet'],
    private readonly server: MemoryHome,
    driveVersion: number | null,
  ) {
    this.media = {
      mediaSet,
      driveAttestedVersion: mediaSet.includes('drive') ? driveVersion : null,
      server: {
        disposition: mediaSet.includes('server') ? 'active' : 'empty',
        candidate: null,
        retired: null,
      },
    };
  }

  async getState(): Promise<ParanoidMediaStateResponse> {
    return { privacyMode: 'paranoid', mediaState: structuredClone(this.media) };
  }

  async transition(request: ParanoidMediaTransitionRequest): Promise<ParanoidVaultMediaState> {
    this.requests.push(structuredClone(request));
    if (this.failTransition) throw new Error('PATCH interrupted');
    if (
      JSON.stringify(request.expected.mediaSet) !== JSON.stringify(this.media.mediaSet) ||
      request.expected.driveAttestedVersion !== this.media.driveAttestedVersion
    ) {
      throw new Error('stale media selection');
    }

    const removedServer =
      this.media.mediaSet.includes('server') && !request.nextMediaSet.includes('server');
    const addedServer =
      !this.media.mediaSet.includes('server') && request.nextMediaSet.includes('server');
    if (removedServer) {
      const version = this.server.value?.[0] ?? 1;
      this.server.value = null;
      this.media.server = {
        disposition: 'retired',
        candidate: null,
        retired: {
          version,
          retiredAt: '2026-07-27T10:00:00.000Z',
          purgeAfter: '2026-08-03T10:00:00.000Z',
        },
      };
    } else if (addedServer) {
      if (
        request.verification.kind !== 'server-candidate' ||
        !this.candidate ||
        request.verification.candidateId !== this.candidate.metadata.candidateId
      ) {
        throw new Error('missing server candidate');
      }
      this.server.value = this.candidate.envelope.slice();
      this.candidate = null;
      this.media.server = {
        disposition: 'active',
        candidate: null,
        retired: this.media.server.retired,
      };
    }

    this.media = {
      ...this.media,
      mediaSet: request.nextMediaSet,
      driveAttestedVersion: request.nextMediaSet.includes('drive')
        ? request.verification.kind === 'drive'
          ? request.verification.version
          : this.media.driveAttestedVersion
        : null,
    };
    return structuredClone(this.media);
  }

  async stageServerCandidate(
    envelope: Uint8Array,
    retirementProofPublicKey: string,
  ): Promise<ParanoidServerCandidateMetadata> {
    expect(retirementProofPublicKey).toBe('proof-public-key');
    const metadata = {
      candidateId: '018f0000-0000-7000-8000-00000000000a',
      version: envelope[0]!,
      formatVersion: 1,
      sizeBytes: envelope.byteLength,
      expiresAt: '2026-07-27T10:15:00.000Z',
    };
    this.candidate = { metadata, envelope: envelope.slice() };
    return metadata;
  }

  async readServerCandidate(
    candidate: ParanoidServerCandidateMetadata,
  ): Promise<ParanoidServerCandidateReadback> {
    if (!this.candidate || candidate.candidateId !== this.candidate.metadata.candidateId) {
      throw new Error('candidate missing');
    }
    return {
      envelope: this.candidate.envelope.slice(),
      verification: {
        kind: 'server-candidate',
        candidateId: candidate.candidateId,
        readback: 'r'.repeat(40),
      },
    };
  }

  async requestPurgeChallenge(retiredVersion: number) {
    if (this.failPurge) throw new Error('retention gate');
    return {
      retiredVersion,
      challenge: 'c'.repeat(40),
      expiresAt: '2026-08-03T10:05:00.000Z',
    };
  }

  async purgeRetired(request: RetiredServerPurgeRequest): Promise<void> {
    if (this.failPurge) throw new Error('proof gate');
    this.purgeRequests.push(request);
    this.media.server = {
      disposition: 'empty',
      candidate: null,
      retired: null,
    };
  }
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
  } as AuthenticatedVaultCopy;
}

function proofManager(): VaultRetirementProofManager {
  return {
    publicKey: 'proof-public-key',
    ensure: vi.fn(),
    sign: vi.fn(async () => 's'.repeat(86)),
    clear: vi.fn(),
  };
}

function setup(
  mediaSet: ParanoidVaultMediaState['mediaSet'],
  serverValue: Uint8Array | null,
  driveValue: Uint8Array | null,
) {
  const server = new MemoryHome('server', serverValue);
  const drive = new MemoryDriveHome(driveValue);
  const api = new FakeMediaApi(mediaSet, server, driveValue?.[0] ?? null);
  const retirementProof = proofManager();
  const switcher = createVaultMediaSwitcher({
    api,
    server,
    drive,
    authenticate,
    retirementProof,
  });
  return { server, drive, api, retirementProof, switcher };
}

describe('verified vault media switch matrix', () => {
  it('covers server → both → Drive-only → both → server', async () => {
    const flow = setup(['server'], bytes(1, 1), null);

    expect(await flow.switcher.add('drive')).toMatchObject({
      status: 'ok',
      media: { mediaSet: ['server', 'drive'], server: { disposition: 'active' } },
    });
    expect(flow.drive.value).toEqual(bytes(1, 1));

    expect(await flow.switcher.remove('server')).toMatchObject({
      status: 'ok',
      media: { mediaSet: ['drive'], server: { disposition: 'retired' } },
    });
    expect(flow.server.value).toBeNull();
    expect(flow.drive.value).toEqual(bytes(1, 1));

    expect(await flow.switcher.add('server')).toMatchObject({
      status: 'ok',
      media: { mediaSet: ['server', 'drive'], server: { disposition: 'active' } },
    });
    expect(flow.server.value).toEqual(bytes(1, 1));

    expect(await flow.switcher.remove('drive')).toMatchObject({
      status: 'ok',
      media: { mediaSet: ['server'] },
    });
    expect(flow.drive.value).toBeNull();
    expect(flow.api.requests).toHaveLength(4);
  });

  it('makes interrupted operations retryable and completed operations no-ops', async () => {
    const flow = setup(['server'], bytes(1, 1), null);
    flow.api.failTransition = true;
    expect(await flow.switcher.add('drive')).toMatchObject({
      status: 'failed',
      stage: 'patch-media',
      media: { mediaSet: ['server'] },
    });
    expect(flow.drive.value).toEqual(bytes(1, 1));
    expect(flow.server.value).toEqual(bytes(1, 1));

    flow.api.failTransition = false;
    expect(await flow.switcher.add('drive')).toMatchObject({ status: 'ok' });
    expect(flow.drive.writes).toBe(1);
    expect(await flow.switcher.add('drive')).toMatchObject({ status: 'noop' });
  });

  it('keeps Drive-only authoritative when server promotion is interrupted', async () => {
    const flow = setup(['drive'], null, bytes(1, 1));
    flow.api.failTransition = true;
    expect(await flow.switcher.add('server')).toMatchObject({
      status: 'failed',
      stage: 'patch-media',
      media: { mediaSet: ['drive'] },
    });
    expect(flow.server.value).toBeNull();
    expect(flow.api.media.server.disposition).toBe('empty');

    flow.api.failTransition = false;
    expect(await flow.switcher.add('server')).toMatchObject({ status: 'ok' });
    expect(flow.server.value).toEqual(bytes(1, 1));
  });

  it('cancels before PATCH on failed authentication, read-back, or stale recheck', async () => {
    const unauthenticated = setup(['server'], bytes(1, 1), null);
    unauthenticated.drive.mutateAfterWrite = () => bytes(1, 255);
    expect(await unauthenticated.switcher.add('drive')).toMatchObject({
      status: 'failed',
      stage: 'read-back',
    });
    expect(unauthenticated.api.requests).toHaveLength(0);

    const stale = setup(['server', 'drive'], bytes(1, 1), bytes(1, 1));
    stale.drive.mutateOnRead = (value, reads) => (reads >= 2 ? bytes(2, 2) : value);
    expect(await stale.switcher.remove('server')).toMatchObject({
      status: 'failed',
      stage: 'verify-round-trip',
    });
    expect(stale.api.requests).toHaveLength(0);
    expect(stale.server.value).toEqual(bytes(1, 1));
  });

  it('replaces an unselected stale Drive leftover from the authoritative server copy', async () => {
    const flow = setup(['server'], bytes(2, 2), bytes(7, 7));
    expect(await flow.switcher.add('drive')).toMatchObject({ status: 'ok' });
    expect(flow.drive.deletes).toBe(1);
    expect(flow.drive.value).toEqual(bytes(2, 2));
  });

  it('surfaces failed Drive deletion after server-only PATCH and retries cleanup', async () => {
    const flow = setup(['server', 'drive'], bytes(1, 1), bytes(1, 1));
    flow.drive.deleteFailure = true;
    expect(await flow.switcher.remove('drive')).toMatchObject({
      status: 'drive-leftover',
      driveLeftover: true,
      media: { mediaSet: ['server'] },
    });
    expect(flow.server.value).toEqual(bytes(1, 1));
    expect(flow.drive.value).toEqual(bytes(1, 1));

    flow.drive.deleteFailure = false;
    expect(await flow.switcher.remove('drive')).toMatchObject({ status: 'noop' });
    expect(flow.drive.value).toBeNull();
  });

  it('leaves a newer Drive revision untouched when it advances after removal proof', async () => {
    const flow = setup(['server', 'drive'], bytes(1, 1), bytes(1, 1));
    flow.drive.beforeDelete = () => flow.drive.advance(bytes(2, 2));

    await expect(flow.switcher.remove('drive')).resolves.toMatchObject({
      status: 'drive-leftover',
      driveLeftover: true,
      media: { mediaSet: ['server'] },
    });

    expect(flow.drive.deletes).toBe(0);
    expect(flow.drive.value).toEqual(bytes(2, 2));
    expect(flow.server.value).toEqual(bytes(1, 1));
  });

  it('never removes the last medium and signs only a freshly authenticated Drive purge', async () => {
    const flow = setup(['drive'], null, bytes(3, 3));
    flow.api.media.server = {
      disposition: 'retired',
      candidate: null,
      retired: {
        version: 2,
        retiredAt: '2026-07-27T10:00:00.000Z',
        purgeAfter: '2026-08-03T10:00:00.000Z',
      },
    };
    expect(await flow.switcher.remove('drive')).toMatchObject({ status: 'last-medium' });

    flow.api.failPurge = true;
    await expect(flow.switcher.purgeRetiredServer()).resolves.toMatchObject({
      status: 'failed',
      stage: 'purge-retired',
    });
    expect(flow.api.media.server.disposition).toBe('retired');

    flow.api.failPurge = false;
    await expect(flow.switcher.purgeRetiredServer()).resolves.toMatchObject({
      status: 'ok',
      media: { server: { disposition: 'empty' } },
    });
    expect(flow.retirementProof.sign).toHaveBeenCalledWith({
      retiredVersion: 2,
      observedVersion: 3,
      challenge: 'c'.repeat(40),
    });
    expect(flow.api.purgeRequests[0]).toMatchObject({
      retiredVersion: 2,
      observedVersion: 3,
      signature: 's'.repeat(86),
    });
  });

  it('refuses to destroy the retired server copy while Drive holds an unconverged set', async () => {
    const flow = setup(['drive'], null, bytes(3, 3));
    flow.api.media.server = {
      disposition: 'retired',
      candidate: null,
      retired: {
        version: 2,
        retiredAt: '2026-07-27T10:00:00.000Z',
        purgeAfter: '2026-08-03T10:00:00.000Z',
      },
    };

    // Two devices created the appdata object concurrently. `read()` masks the
    // second branch, so only the complete observation set can gate the purge.
    flow.drive.duplicates = [bytes(3, 3)];
    await expect(flow.switcher.purgeRetiredServer()).resolves.toMatchObject({
      status: 'failed',
      stage: 'verify-round-trip',
    });

    // A divergent duplicate is refused on the same gate.
    flow.drive.duplicates = [bytes(4, 4)];
    await expect(flow.switcher.purgeRetiredServer()).resolves.toMatchObject({
      status: 'failed',
      stage: 'verify-round-trip',
    });

    // An unauthenticatable branch never signs an observed version either.
    flow.drive.duplicates = [bytes(3, 255)];
    await expect(flow.switcher.purgeRetiredServer()).resolves.toMatchObject({
      status: 'failed',
      stage: 'authenticate-drive',
    });

    expect(flow.retirementProof.sign).not.toHaveBeenCalled();
    expect(flow.api.purgeRequests).toHaveLength(0);
    expect(flow.api.media.server.disposition).toBe('retired');

    // Once Drive has converged to one authenticated object, the purge proceeds.
    flow.drive.duplicates = [];
    await expect(flow.switcher.purgeRetiredServer()).resolves.toMatchObject({
      status: 'ok',
      media: { server: { disposition: 'empty' } },
    });
    expect(flow.api.purgeRequests).toHaveLength(1);
  });
});
