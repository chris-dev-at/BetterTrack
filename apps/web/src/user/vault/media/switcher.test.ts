import type {
  ParanoidMediaStatusResponse,
  PatchParanoidMediaRequest,
  VaultMediaState,
} from '@bettertrack/contracts';
import { describe, expect, it } from 'vitest';

import { base64ToBytes } from '../bytes';
import type {
  DataHome,
  DataHomeInfo,
  DataHomeReadResult,
  DataHomeWriteOptions,
  DataHomeWriteResult,
} from '../dataHome';
import type { DriveDataHome, DriveDataHomeDeleteResult } from '../drive/driveDataHome';
import { vaultInteroperabilityFixture } from '../vectors';
import {
  createVaultEnvelopeAuthenticator,
  createVaultMediaSwitcher,
  type VaultEnvelopeAuthenticator,
} from './switcher';

function bytes(version: number, write = 10): Uint8Array {
  return new Uint8Array([version, write, 99]);
}

interface MemoryHome extends DataHome {
  value: Uint8Array | null;
  writes: number;
}

function memoryHome(
  medium: 'server' | 'drive',
  initial: Uint8Array | null,
  options: {
    transformWrite?: (value: Uint8Array) => Uint8Array;
    indeterminateWrite?: boolean;
  } = {},
): MemoryHome {
  return {
    medium,
    value: initial?.slice() ?? null,
    writes: 0,
    async read(): Promise<DataHomeReadResult> {
      if (this.value === null) return { status: 'absent', medium };
      return {
        status: 'ok',
        medium,
        envelope: this.value.slice(),
        info: info(medium, this.value),
      };
    },
    async write(
      envelope: Uint8Array,
      { ifVersion }: DataHomeWriteOptions,
    ): Promise<DataHomeWriteResult> {
      const currentVersion = this.value?.[0] ?? null;
      if (currentVersion !== ifVersion) {
        return { status: 'conflict', medium, currentVersion };
      }
      this.writes += 1;
      this.value = (options.transformWrite?.(envelope) ?? envelope).slice();
      if (options.indeterminateWrite) {
        return {
          status: 'transport-failure',
          medium,
          failure: {
            kind: 'api-failure',
            message: 'response lost',
            indeterminate: true,
          },
        };
      }
      return { status: 'ok', medium, info: info(medium, this.value) };
    },
    async info() {
      const read = await this.read();
      return read.status === 'ok' ? { status: 'ok' as const, medium, info: read.info } : read;
    },
  };
}

function driveHome(
  initial: Uint8Array | null,
  options: Parameters<typeof memoryHome>[2] & { deleteFails?: boolean } = {},
): DriveDataHome & MemoryHome {
  const home = memoryHome('drive', initial, options);
  return {
    ...home,
    medium: 'drive',
    async delete(): Promise<DriveDataHomeDeleteResult> {
      if (options.deleteFails) {
        return {
          status: 'transport-failure',
          medium: 'drive',
          failure: { kind: 'api-failure', message: 'delete failed' },
        };
      }
      if (this.value === null) return { status: 'absent', medium: 'drive' };
      this.value = null;
      return { status: 'ok', medium: 'drive' };
    },
  };
}

function info(medium: 'server' | 'drive', value: Uint8Array): DataHomeInfo {
  return {
    medium,
    version: value[0]!,
    sizeBytes: value.byteLength,
    updatedAt: '2026-07-26T10:00:00.000Z',
  };
}

const authenticate: VaultEnvelopeAuthenticator = async (envelope) => ({
  version: envelope[0]!,
  writeId: `write-${envelope[1]}`,
  sha256: Array.from(envelope).join('.'),
});

function harness(
  initial: VaultMediaState,
  options: {
    server?: MemoryHome;
    drive?: DriveDataHome & MemoryHome;
    patchFailure?: 'before' | 'after';
  } = {},
) {
  let state = structuredClone(initial);
  const server =
    options.server ??
    memoryHome(
      'server',
      initial.mediaSet.includes('server') ? bytes(initial.driveAttestedVersion ?? 5) : null,
    );
  let serverHistoryExists = server.value != null;
  const drive = options.drive ?? driveHome(initial.mediaSet.includes('drive') ? bytes(5) : null);
  const patches: PatchParanoidMediaRequest[] = [];
  const stateApi = {
    async get(): Promise<ParanoidMediaStatusResponse> {
      return { privacyMode: 'paranoid', mediaState: structuredClone(state) };
    },
    async patch(request: PatchParanoidMediaRequest): Promise<VaultMediaState> {
      patches.push(request);
      if (options.patchFailure === 'before') throw new Error('PATCH failed');
      state = {
        mediaSet: [...request.nextMediaSet],
        driveAttestedVersion: request.nextMediaSet.includes('drive')
          ? request.verification.version
          : null,
      };
      if (!request.nextMediaSet.includes('server')) {
        server.value = null;
        serverHistoryExists = false;
      }
      if (options.patchFailure === 'after') throw new Error('response lost');
      return structuredClone(state);
    },
  };
  return {
    stateApi,
    server,
    drive,
    patches,
    get state() {
      return state;
    },
    get serverHistoryExists() {
      return serverHistoryExists;
    },
  };
}

describe('verified paranoid media switching', () => {
  it('covers server → both → Drive-only → both → server with the authoritative copy intact', async () => {
    const h = harness({ mediaSet: ['server'], driveAttestedVersion: null });
    const switcher = createVaultMediaSwitcher({
      state: h.stateApi,
      server: h.server,
      drive: h.drive,
      authenticate,
    });

    expect(await switcher.add('drive')).toMatchObject({
      status: 'ok',
      state: { mediaSet: ['server', 'drive'], driveAttestedVersion: 5 },
    });
    expect(h.drive.value).toEqual(bytes(5));
    expect(h.server.value).toEqual(bytes(5));
    expect(h.patches[0]?.verification).toEqual({ medium: 'drive', version: 5 });

    expect(await switcher.remove('server')).toMatchObject({
      status: 'ok',
      state: { mediaSet: ['drive'], driveAttestedVersion: 5 },
    });
    expect(h.server.value).toBeNull();
    expect(h.serverHistoryExists).toBe(false);
    expect(h.drive.value).toEqual(bytes(5));

    expect(await switcher.add('server')).toMatchObject({
      status: 'ok',
      state: { mediaSet: ['server', 'drive'], driveAttestedVersion: 5 },
    });
    expect(h.server.value).toEqual(bytes(5));
    expect(h.patches[2]?.verification).toEqual({ medium: 'server', version: 5 });

    expect(await switcher.remove('drive')).toMatchObject({
      status: 'ok',
      state: { mediaSet: ['server'], driveAttestedVersion: null },
    });
    expect(h.server.value).toEqual(bytes(5));
    expect(h.drive.value).toBeNull();
  });

  it('treats no-op and a committed PATCH with a lost response as retry-safe', async () => {
    const noOp = harness({
      mediaSet: ['server', 'drive'],
      driveAttestedVersion: 5,
    });
    const noOpSwitcher = createVaultMediaSwitcher({
      state: noOp.stateApi,
      server: noOp.server,
      drive: noOp.drive,
      authenticate,
    });
    await expect(noOpSwitcher.switchTo(['drive', 'server'])).resolves.toMatchObject({
      status: 'no-op',
    });
    expect(noOp.patches).toHaveLength(0);

    const retry = harness(
      { mediaSet: ['server'], driveAttestedVersion: null },
      { patchFailure: 'after' },
    );
    const retrySwitcher = createVaultMediaSwitcher({
      state: retry.stateApi,
      server: retry.server,
      drive: retry.drive,
      authenticate,
    });
    await expect(retrySwitcher.add('drive')).resolves.toMatchObject({
      status: 'ok',
      recoveredAfterPatchFailure: true,
    });
    expect(retry.patches).toHaveLength(1);
  });

  it('leaves the old set authoritative on verification, stale-version, and PATCH failures', async () => {
    const verification = harness(
      { mediaSet: ['server'], driveAttestedVersion: null },
      { drive: driveHome(null, { transformWrite: () => bytes(5, 44) }) },
    );
    const verificationSwitcher = createVaultMediaSwitcher({
      state: verification.stateApi,
      server: verification.server,
      drive: verification.drive,
      authenticate,
    });
    await expect(verificationSwitcher.add('drive')).resolves.toMatchObject({
      status: 'failed',
      reason: 'verification-failed',
      authoritativeState: { mediaSet: ['server'] },
    });
    expect(verification.patches).toHaveLength(0);
    expect(verification.server.value).toEqual(bytes(5));

    const stale = harness(
      { mediaSet: ['server'], driveAttestedVersion: null },
      { drive: driveHome(bytes(6)) },
    );
    const staleSwitcher = createVaultMediaSwitcher({
      state: stale.stateApi,
      server: stale.server,
      drive: stale.drive,
      authenticate,
    });
    await expect(staleSwitcher.add('drive')).resolves.toMatchObject({
      status: 'failed',
      reason: 'stale-version',
    });
    expect(stale.patches).toHaveLength(0);

    const interrupted = harness(
      { mediaSet: ['server'], driveAttestedVersion: null },
      { patchFailure: 'before' },
    );
    const interruptedSwitcher = createVaultMediaSwitcher({
      state: interrupted.stateApi,
      server: interrupted.server,
      drive: interrupted.drive,
      authenticate,
    });
    await expect(interruptedSwitcher.add('drive')).resolves.toMatchObject({
      status: 'failed',
      reason: 'patch-failed',
      authoritativeState: { mediaSet: ['server'] },
    });
    expect(interrupted.drive.value).toEqual(bytes(5));
    expect(interrupted.server.value).toEqual(bytes(5));
  });

  it('verifies an indeterminate upload and surfaces failed Drive cleanup honestly', async () => {
    const indeterminate = harness(
      { mediaSet: ['server'], driveAttestedVersion: null },
      { drive: driveHome(null, { indeterminateWrite: true }) },
    );
    const indeterminateSwitcher = createVaultMediaSwitcher({
      state: indeterminate.stateApi,
      server: indeterminate.server,
      drive: indeterminate.drive,
      authenticate,
    });
    await expect(indeterminateSwitcher.add('drive')).resolves.toMatchObject({ status: 'ok' });

    const cleanup = harness(
      { mediaSet: ['server', 'drive'], driveAttestedVersion: 5 },
      { drive: driveHome(bytes(5), { deleteFails: true }) },
    );
    const cleanupSwitcher = createVaultMediaSwitcher({
      state: cleanup.stateApi,
      server: cleanup.server,
      drive: cleanup.drive,
      authenticate,
    });
    await expect(cleanupSwitcher.remove('drive')).resolves.toMatchObject({
      status: 'ok-with-drive-leftover',
      state: { mediaSet: ['server'] },
    });
    expect(cleanup.state.mediaSet).toEqual(['server']);
    expect(cleanup.drive.value).toEqual(bytes(5));
  });

  it('rejects removing the last medium before any write or PATCH', async () => {
    const h = harness({ mediaSet: ['server'], driveAttestedVersion: null });
    const switcher = createVaultMediaSwitcher({
      state: h.stateApi,
      server: h.server,
      drive: h.drive,
      authenticate,
    });
    await expect(switcher.remove('server')).resolves.toMatchObject({
      status: 'failed',
      reason: 'last-medium',
    });
    expect(h.patches).toHaveLength(0);
  });

  it('authenticates and hashes both round-trip candidates with the real vault key', async () => {
    const fixture = vaultInteroperabilityFixture;
    const verifier = createVaultEnvelopeAuthenticator(
      base64ToBytes(fixture.vaultKeyBase64, 'envelope-invalid'),
    );
    const encrypted = base64ToBytes(fixture.initial.envelopeBase64, 'envelope-invalid');

    await expect(verifier(encrypted)).resolves.toEqual({
      version: fixture.initial.header.vaultVersion,
      writeId: fixture.initial.header.writeId,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    const tampered = encrypted.slice();
    const last = tampered.length - 1;
    tampered[last] = tampered[last]! ^ 1;
    await expect(verifier(tampered)).rejects.toThrow();
  });
});
