import { webcrypto } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import type {
  ParanoidMediaStatusResponse,
  PatchParanoidMediaRequest,
  VaultDocumentV1,
  VaultEntity,
  VaultMediaState,
} from '@bettertrack/contracts';

import { decryptVaultDocument, encryptVaultDocument } from '../crypto';
import type {
  DataHome,
  DataHomeReadResult,
  DataHomeWriteOptions,
  DataHomeWriteResult,
} from '../dataHome';
import { base64ToBytes } from '../bytes';
import type { DriveDataHome } from '../drive/driveDataHome';
import { decodeVaultEnvelope, encodeVaultEnvelope } from '../envelope';
import {
  deterministicRandom,
  VECTOR_DEVICE_ID,
  VECTOR_KEY_ID,
  VECTOR_WRITE_ID,
  vaultInteroperabilityFixture,
} from '../vectors';
import {
  createReplicatedVaultDataHome,
  createVaultReplicaMergeResolver,
  type VaultReplicaDivergenceResolver,
} from './replicatedDataHome';
import {
  createVaultEnvelopeAuthenticator,
  type VaultEnvelopeAuthenticator,
  type VaultMediaStateApi,
} from './switcher';

const DEVICE_B = '018f0000-0000-7000-8000-00000000000e';
const ENTITY_A = '018f0000-0000-7000-8000-000000000010';
const ENTITY_B = '018f0000-0000-7000-8000-000000000011';
const MERGE_WRITE_ID = '018f0000-0000-7000-8000-000000000012';
const TEST_KEY = base64ToBytes(vaultInteroperabilityFixture.vaultKeyBase64, 'envelope-invalid');
const WRAPPED_KEYS = vaultInteroperabilityFixture.initial.header.wrappedKeys;

beforeEach(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
});

function bytes(version: number, marker = version): Uint8Array {
  return new Uint8Array([version, marker]);
}

function entity(id: string, editedBy: string): VaultEntity {
  return {
    id,
    rev: 1,
    editedAt: '2026-07-26T10:00:00.000Z',
    editedBy,
    deletedAt: null,
    data: { amount: id },
  };
}

function document(rows: VaultEntity[]): VaultDocumentV1 {
  return { schemaVersion: 1, entities: { transaction: rows }, mergeLog: [] };
}

async function encrypted(
  value: VaultDocumentV1,
  version: number,
  deviceId: string,
  writeId: string,
): Promise<Uint8Array> {
  return (
    await encryptVaultDocument({
      document: value,
      vaultKey: TEST_KEY,
      header: {
        keyId: VECTOR_KEY_ID,
        wrappedKeys: WRAPPED_KEYS,
        vaultVersion: version,
        deviceId,
        writeId,
        writtenAt: '2026-07-26T10:00:00.000Z',
      },
      randomBytes: deterministicRandom(version * 31 + writeId.charCodeAt(writeId.length - 1)),
    })
  ).envelope;
}

const resolveHigherVersion: VaultReplicaDivergenceResolver = async (server, drive) => {
  const selected = server.info.version >= drive.info.version ? server : drive;
  return { envelope: selected.envelope.slice(), version: selected.info.version };
};

function mergeResolver(): VaultReplicaDivergenceResolver {
  return createVaultReplicaMergeResolver({
    vaultKey: TEST_KEY,
    deviceId: VECTOR_DEVICE_ID,
    writeId: () => MERGE_WRITE_ID,
    now: () => '2026-07-26T10:05:00.000Z',
  });
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
      resolveDivergence: resolveHigherVersion,
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

  it('merges valid non-dominating replicas at the same version before repairing either', async () => {
    const serverEnvelope = await encrypted(
      document([entity(ENTITY_A, VECTOR_DEVICE_ID)]),
      3,
      VECTOR_DEVICE_ID,
      VECTOR_WRITE_ID,
    );
    const driveEnvelope = await encrypted(
      document([entity(ENTITY_B, DEVICE_B)]),
      3,
      DEVICE_B,
      DEVICE_B,
    );
    const envelopeVersion = (envelope: Uint8Array) =>
      decodeVaultEnvelope(envelope).header.vaultVersion;
    const server = memoryHome('server', serverEnvelope, envelopeVersion);
    const driveBase = memoryHome('drive', driveEnvelope, envelopeVersion);
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
        authenticate: createVaultEnvelopeAuthenticator(TEST_KEY),
        resolveDivergence: mergeResolver(),
      }).read(),
    ).resolves.toMatchObject({
      status: 'ok',
      info: { version: 4 },
    });
    expect(server.value).toEqual(drive.value);
    const merged = await decryptVaultDocument(server.value!, TEST_KEY);
    expect(merged.header.vaultVersion).toBe(4);
    expect(merged.document.entities.transaction?.map((row) => row.id)).toEqual([
      ENTITY_A,
      ENTITY_B,
    ]);
    expect(merged.document.mergeLog.at(-1)?.parents).toEqual([3]);
    expect(h.durable.driveAttestedVersion).toBe(4);
  });

  it('merges valid non-dominating replicas at unequal versions without losing either branch', async () => {
    const serverEnvelope = await encrypted(
      document([entity(ENTITY_A, VECTOR_DEVICE_ID)]),
      4,
      VECTOR_DEVICE_ID,
      VECTOR_WRITE_ID,
    );
    const driveEnvelope = await encrypted(
      document([entity(ENTITY_B, DEVICE_B)]),
      3,
      DEVICE_B,
      DEVICE_B,
    );
    const envelopeVersion = (envelope: Uint8Array) =>
      decodeVaultEnvelope(envelope).header.vaultVersion;
    const server = memoryHome('server', serverEnvelope, envelopeVersion);
    const driveBase = memoryHome('drive', driveEnvelope, envelopeVersion);
    const drive: DriveDataHome & typeof driveBase = Object.assign(driveBase, {
      async delete() {
        return { status: 'ok' as const, medium: 'drive' as const };
      },
    });
    const h = harness({
      mediaSet: ['server', 'drive'],
      driveAttestedVersion: 3,
    });

    await expect(
      createReplicatedVaultDataHome({
        state: h.state,
        server,
        drive,
        authenticate: createVaultEnvelopeAuthenticator(TEST_KEY),
        resolveDivergence: mergeResolver(),
      }).read(),
    ).resolves.toMatchObject({
      status: 'ok',
      info: { version: 5 },
    });
    expect(server.value).toEqual(drive.value);
    const merged = await decryptVaultDocument(server.value!, TEST_KEY);
    expect(merged.header.vaultVersion).toBe(5);
    expect(merged.document.entities.transaction?.map((row) => row.id)).toEqual([
      ENTITY_A,
      ENTITY_B,
    ]);
    expect(merged.document.mergeLog.at(-1)?.parents).toEqual([3, 4]);
    expect(h.durable.driveAttestedVersion).toBe(5);
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
        resolveDivergence: createVaultReplicaMergeResolver({
          vaultKey,
          deviceId: VECTOR_DEVICE_ID,
          writeId: () => MERGE_WRITE_ID,
        }),
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
