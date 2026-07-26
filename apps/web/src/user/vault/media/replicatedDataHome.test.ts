import { describe, expect, it } from 'vitest';

import type {
  ParanoidMediaStatusResponse,
  PatchParanoidMediaRequest,
  VaultMediaState,
} from '@bettertrack/contracts';

import type {
  DataHome,
  DataHomeReadResult,
  DataHomeWriteOptions,
  DataHomeWriteResult,
} from '../dataHome';
import { base64ToBytes } from '../bytes';
import type { DriveDataHome } from '../drive/driveDataHome';
import { decodeVaultEnvelope, encodeVaultEnvelope } from '../envelope';
import { vaultInteroperabilityFixture } from '../vectors';
import { createReplicatedVaultDataHome } from './replicatedDataHome';
import {
  createVaultEnvelopeAuthenticator,
  type VaultEnvelopeAuthenticator,
  type VaultMediaStateApi,
} from './switcher';

function bytes(version: number, marker = version): Uint8Array {
  return new Uint8Array([version, marker]);
}

function memoryHome<M extends 'server' | 'drive'>(
  medium: M,
  initial: Uint8Array | null,
  versionOf: (envelope: Uint8Array) => number = (envelope) => envelope[0]!,
): DataHome & {
  readonly medium: M;
  value: Uint8Array | null;
  failNextWrite: boolean;
} {
  return {
    medium,
    value: initial,
    failNextWrite: false,
    async read(): Promise<DataHomeReadResult> {
      if (this.value === null) return { status: 'absent', medium };
      return {
        status: 'ok',
        medium,
        envelope: this.value.slice(),
        info: {
          medium,
          version: versionOf(this.value),
          sizeBytes: this.value.byteLength,
          updatedAt: '2026-07-26T10:00:00.000Z',
        },
      };
    },
    async write(
      envelope: Uint8Array,
      { ifVersion }: DataHomeWriteOptions,
    ): Promise<DataHomeWriteResult> {
      if (this.failNextWrite) {
        this.failNextWrite = false;
        return {
          status: 'transport-failure',
          medium,
          failure: { kind: 'offline', message: 'offline' },
        };
      }
      const currentVersion = this.value === null ? null : versionOf(this.value);
      if (currentVersion !== ifVersion) {
        return { status: 'conflict', medium, currentVersion };
      }
      this.value = envelope.slice();
      return {
        status: 'ok',
        medium,
        info: {
          medium,
          version: versionOf(envelope),
          sizeBytes: envelope.byteLength,
          updatedAt: '2026-07-26T10:01:00.000Z',
        },
      };
    },
    async info() {
      const read = await this.read();
      return read.status === 'ok' ? { status: 'ok' as const, medium, info: read.info } : read;
    },
  };
}

const authenticateBytes: VaultEnvelopeAuthenticator = async (envelope) => ({
  version: envelope[0]!,
  writeId: `write-${envelope[1] ?? 0}`,
  sha256: Array.from(envelope).join('-'),
});

function harness(initial: VaultMediaState) {
  let durable = structuredClone(initial);
  const state: VaultMediaStateApi = {
    async get(): Promise<ParanoidMediaStatusResponse> {
      return { privacyMode: 'paranoid', mediaState: structuredClone(durable) };
    },
    async prepare() {
      return { proof: 'p'.repeat(32), expiresAt: '2026-07-26T10:02:00.000Z' };
    },
    async patch(request: PatchParanoidMediaRequest) {
      durable = {
        mediaSet: [...request.nextMediaSet],
        driveAttestedVersion: request.verification.version,
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
  return {
    state,
    get durable() {
      return durable;
    },
  };
}

describe('replicated paranoid DataHome', () => {
  it('keeps a server-primary write pending until reconnect repairs Drive and attests it', async () => {
    const server = memoryHome('server', bytes(1));
    const driveBase = memoryHome('drive', bytes(1));
    const drive: DriveDataHome & typeof driveBase = Object.assign(driveBase, {
      async delete() {
        drive.value = null;
        return { status: 'ok' as const, medium: 'drive' as const };
      },
    });
    const h = harness({
      mediaSet: ['server', 'drive'],
      driveAttestedVersion: 1,
    });
    const replicated = createReplicatedVaultDataHome({
      state: h.state,
      server,
      drive,
      authenticate: authenticateBytes,
    });

    drive.failNextWrite = true;
    await expect(replicated.write(bytes(2), { ifVersion: 1 })).resolves.toMatchObject({
      status: 'transport-failure',
      failure: { indeterminate: true },
    });
    expect(server.value).toEqual(bytes(2));
    expect(drive.value).toEqual(bytes(1));
    expect(h.durable.driveAttestedVersion).toBe(1);

    await expect(replicated.read()).resolves.toMatchObject({
      status: 'ok',
      info: { version: 2 },
    });
    expect(drive.value).toEqual(bytes(2));
    expect(h.durable.driveAttestedVersion).toBe(2);
  });

  it('fails closed on different ciphertext at the same version', async () => {
    const server = memoryHome('server', bytes(3, 1));
    const driveBase = memoryHome('drive', bytes(3, 2));
    const drive: DriveDataHome & typeof driveBase = Object.assign(driveBase, {
      async delete() {
        return { status: 'ok' as const, medium: 'drive' as const };
      },
    });
    const h = harness({
      mediaSet: ['server', 'drive'],
      driveAttestedVersion: 2,
    });

    await expect(
      createReplicatedVaultDataHome({
        state: h.state,
        server,
        drive,
        authenticate: authenticateBytes,
      }).read(),
    ).resolves.toMatchObject({
      status: 'corrupt',
      reason: 'corrupt-bytes',
      version: 3,
    });
    expect(server.value).toEqual(bytes(3, 1));
    expect(drive.value).toEqual(bytes(3, 2));
  });

  it('quarantines a higher-version invalid-AEAD candidate without repairing either medium', async () => {
    const fixture = vaultInteroperabilityFixture;
    const vaultKey = base64ToBytes(fixture.vaultKeyBase64, 'envelope-invalid');
    const validEnvelope = base64ToBytes(fixture.initial.envelopeBase64, 'envelope-invalid');
    const decoded = decodeVaultEnvelope(validEnvelope);
    const tamperedEnvelope = encodeVaultEnvelope(
      {
        ...decoded.header,
        vaultVersion: decoded.header.vaultVersion + 1,
      },
      decoded.ciphertext,
    );
    const envelopeVersion = (envelope: Uint8Array) =>
      decodeVaultEnvelope(envelope).header.vaultVersion;
    const server = memoryHome('server', validEnvelope, envelopeVersion);
    const driveBase = memoryHome('drive', tamperedEnvelope, envelopeVersion);
    const drive: DriveDataHome & typeof driveBase = Object.assign(driveBase, {
      async delete() {
        return { status: 'ok' as const, medium: 'drive' as const };
      },
    });
    const h = harness({
      mediaSet: ['server', 'drive'],
      driveAttestedVersion: decoded.header.vaultVersion,
    });

    await expect(
      createReplicatedVaultDataHome({
        state: h.state,
        server,
        drive,
        authenticate: createVaultEnvelopeAuthenticator(vaultKey),
      }).read(),
    ).resolves.toMatchObject({
      status: 'corrupt',
      medium: 'drive',
      reason: 'corrupt-bytes',
      version: decoded.header.vaultVersion + 1,
    });
    expect(server.value).toEqual(validEnvelope);
    expect(drive.value).toEqual(tamperedEnvelope);
    expect(h.durable.driveAttestedVersion).toBe(decoded.header.vaultVersion);
  });
});
