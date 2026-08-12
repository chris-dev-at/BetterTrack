import { webcrypto } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import type {
  ParanoidMediaStateResponse,
  VaultDocument,
  VaultEnvelopeHeader,
  VaultMedium,
} from '@bettertrack/contracts';

import { base64ToBytes } from '../bytes';
import { encryptVaultDocument } from '../crypto';
import type {
  DataHome,
  DataHomeInfoResult,
  DataHomeReadResult,
  DataHomeWriteOptions,
  DataHomeWriteResult,
} from '../dataHome';
import { inspectVaultEnvelope } from '../envelope';
import {
  createLocalDataHome,
  type LocalDataHomeStorage,
  type LocalVaultRecord,
} from '../localDataHome';
import { createMemoryVaultQuarantineStore } from '../quarantine';
import { createVaultSyncEngine } from '../sync';
import { vaultInteroperabilityFixture as fixture } from '@bettertrack/domain/vaultVectors';
import type { DriveDataHome, DriveReplicaCycle } from '../drive';
import {
  createReplicaReconcileCoordinator,
  createReplicatedVaultDataHome,
} from './replicatedDataHome';
import { createVaultRetirementProofManager } from './retirementProof';

const vaultKey = base64ToBytes(fixture.vaultKeyBase64, 'envelope-invalid');
const baseHeader = fixture.initial.header as VaultEnvelopeHeader;
const DEVICE_ID = '018f0000-0000-7000-8000-0000000000d1';

class MemoryRemote implements DataHome {
  readonly medium: VaultMedium;
  envelope: Uint8Array | null;
  failure = false;
  corrupt = false;
  afterWrite?: (envelope: Uint8Array) => Promise<void> | void;

  constructor(medium: VaultMedium, envelope: Uint8Array | null) {
    this.medium = medium;
    this.envelope = envelope?.slice() ?? null;
  }

  async read(): Promise<DataHomeReadResult> {
    if (this.failure) {
      return {
        status: 'transport-failure',
        medium: this.medium,
        failure: { code: 'offline', message: `${this.medium} offline` },
      };
    }
    if (this.corrupt) {
      return {
        status: 'corrupt',
        medium: this.medium,
        envelope: this.envelope?.slice(),
        version: this.envelope ? version(this.envelope) : null,
        updatedAt: null,
        reason: 'corrupt-bytes',
        message: `${this.medium} corrupt`,
      };
    }
    if (!this.envelope) return { status: 'absent', medium: this.medium };
    return {
      status: 'ok',
      medium: this.medium,
      envelope: this.envelope.slice(),
      info: info(this.medium, this.envelope),
    };
  }

  async write(envelope: Uint8Array, options: DataHomeWriteOptions): Promise<DataHomeWriteResult> {
    if (this.failure) {
      return {
        status: 'transport-failure',
        medium: this.medium,
        failure: { code: 'offline', message: `${this.medium} offline` },
      };
    }
    const current = this.envelope ? version(this.envelope) : null;
    const next = version(envelope);
    if (current !== options.ifVersion || (current !== null && next <= current)) {
      return { status: 'conflict', medium: this.medium, currentVersion: current };
    }
    this.envelope = envelope.slice();
    const afterWrite = this.afterWrite;
    this.afterWrite = undefined;
    await afterWrite?.(envelope.slice());
    return { status: 'ok', medium: this.medium, info: info(this.medium, envelope) };
  }

  async info(): Promise<DataHomeInfoResult> {
    const read = await this.read();
    return read.status === 'ok' ? { status: 'ok', medium: this.medium, info: read.info } : read;
  }
}

class MemoryDrive extends MemoryRemote implements DriveDataHome {
  override readonly medium = 'drive' as const;
  extraReplica: Uint8Array | null = null;

  constructor(envelope: Uint8Array | null) {
    super('drive', envelope);
  }

  async observeReplicas(): Promise<DriveReplicaCycle> {
    const observations = [await this.read()];
    if (this.extraReplica != null) {
      observations.push({
        status: 'ok',
        medium: 'drive',
        envelope: this.extraReplica.slice(),
        info: info('drive', this.extraReplica),
      });
    }
    return {
      observations,
      async converge() {
        throw new Error('The single-file test Drive cannot converge duplicates.');
      },
      async deleteIfUnchanged() {
        throw new Error('Replica cleanup is not used by coordinator tests.');
      },
    };
  }
}

class DuplicateMemoryDrive extends MemoryDrive {
  convergeCalls = 0;
  private replicas: DataHomeReadResult[];

  constructor(observations: DataHomeReadResult[], fallback: Uint8Array) {
    super(fallback);
    this.replicas = observations;
  }

  get replicaCount(): number {
    return this.replicas.length;
  }

  override async observeReplicas(): Promise<DriveReplicaCycle> {
    const observations = this.replicas.map(cloneObservation);
    return {
      observations,
      converge: async (envelope) => {
        this.convergeCalls += 1;
        this.envelope = envelope.slice();
        const result: DataHomeReadResult = {
          status: 'ok',
          medium: 'drive',
          envelope: envelope.slice(),
          info: info('drive', envelope),
        };
        this.replicas = [result];
        return { status: 'ok', medium: 'drive', info: info('drive', envelope) };
      },
      async deleteIfUnchanged() {
        throw new Error('Replica cleanup is not used by coordinator tests.');
      },
    };
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
});

describe('replicated DataHome through the PD5 coordinator', () => {
  it.each([
    ['same-version', 2, 2],
    ['higher-version', 3, 2],
  ])('merges %s divergent replicas instead of choosing the higher copy', async (_name, a, b) => {
    const serverDocument = document('018f0000-0000-7000-8000-0000000000a1');
    const driveDocument = document('018f0000-0000-7000-8000-0000000000b1');
    const serverEnvelope = await encrypted(serverDocument, a, 0xa1);
    const driveEnvelope = await encrypted(driveDocument, b, 0xb1);
    const setup = coordinator(serverEnvelope, driveEnvelope);

    const state = await setup.coordinator.reconnect();
    expect(state.status).toBe('synced');
    expect(state.active?.document.entities.portfolio?.map((entity) => entity.id).sort()).toEqual([
      '018f0000-0000-7000-8000-0000000000a1',
      '018f0000-0000-7000-8000-0000000000b1',
    ]);
    expect(setup.coordinator.state).toMatchObject({ status: 'synced', pending: null });
    expect(setup.server.envelope).toEqual(setup.drive.envelope);
    expect(version(setup.server.envelope!)).toBe(Math.max(a, b) + 1);
  });

  it('keeps offline mutations encrypted and pending until the next Drive gesture', async () => {
    const initial = await encrypted(document('018f0000-0000-7000-8000-0000000000a1'), 1, 0xa1);
    const setup = coordinator(initial, initial);
    await setup.coordinator.reconnect();

    setup.drive.failure = true;
    await setup.coordinator.reconnect();
    const pending = await setup.coordinator.mutate(({ document: current }) => ({
      ...current,
      entities: {
        ...current.entities,
        portfolio: [
          ...(current.entities.portfolio ?? []),
          entity('018f0000-0000-7000-8000-0000000000c1'),
        ],
      },
    }));
    expect(pending.status).toBe('pending-offline');
    expect(pending.pending).not.toBeNull();
    expect(setup.coordinator.state).toEqual(pending);
    expect(setup.server.envelope).toEqual(initial);

    setup.drive.failure = false;
    const resumed = await setup.coordinator.reconnect();
    expect(resumed.status).toBe('synced');
    expect(resumed.pending).toBeNull();
    expect(setup.server.envelope).toEqual(setup.drive.envelope);
    expect(
      resumed.active?.document.entities.portfolio?.some(
        (candidate) => candidate.id === '018f0000-0000-7000-8000-0000000000c1',
      ),
    ).toBe(true);
  });

  it('refreshes observations for proof bootstrap and consecutive online mutations', async () => {
    const initial = await encrypted(document('018f0000-0000-7000-8000-0000000000a1'), 1, 0xa1);
    const setup = coordinator(initial, initial);
    const proof = createVaultRetirementProofManager(webcrypto.subtle as unknown as SubtleCrypto);
    const opened = await setup.coordinator.reconnect();
    const secured = await proof.ensure(opened.active!.document);
    let mutatorCalls = 0;

    const bootstrapped = await setup.coordinator.mutate(() => {
      mutatorCalls += 1;
      return secured.document;
    });
    expect(bootstrapped).toMatchObject({
      status: 'synced',
      active: { header: { vaultVersion: 2 }, document: { schemaVersion: 2 } },
    });
    expect(setup.server.envelope).toEqual(setup.drive.envelope);

    const first = await setup.coordinator.mutate(({ document: current }) => {
      mutatorCalls += 1;
      return appendEntity(current, '018f0000-0000-7000-8000-0000000000c1');
    });
    expect(first).toMatchObject({
      status: 'synced',
      active: { header: { vaultVersion: 3 } },
    });
    expect(setup.server.envelope).toEqual(setup.drive.envelope);

    const second = await setup.coordinator.mutate(({ document: current }) => {
      mutatorCalls += 1;
      return appendEntity(current, '018f0000-0000-7000-8000-0000000000d1');
    });
    expect(second).toMatchObject({
      status: 'synced',
      active: { header: { vaultVersion: 4 } },
    });
    expect(setup.coordinator.state).toEqual(second);
    expect(setup.server.envelope).toEqual(setup.drive.envelope);
    expect(mutatorCalls).toBe(3);
  });

  it('keeps a mutation pending when a replica moves after its write', async () => {
    const initial = await encrypted(document('018f0000-0000-7000-8000-0000000000a1'), 1, 0xa1);
    const concurrent = await encrypted(document('018f0000-0000-7000-8000-0000000000b1'), 3, 0xb1);
    const setup = coordinator(initial, initial);
    await setup.coordinator.reconnect();
    setup.drive.afterWrite = () => {
      setup.server.envelope = concurrent.slice();
    };

    const pending = await setup.coordinator.mutate(({ document: current }) =>
      appendEntity(current, '018f0000-0000-7000-8000-0000000000c1'),
    );

    expect(pending).toMatchObject({ status: 'pending-offline', pending: {} });
    expect(setup.coordinator.state).toEqual(pending);
    expect(version(setup.server.envelope!)).toBe(3);
    expect(version(setup.drive.envelope!)).toBe(2);

    const repaired = await setup.coordinator.reconnect();
    expect(repaired).toMatchObject({ status: 'synced', pending: null });
    expect(setup.server.envelope).toEqual(setup.drive.envelope);
  });

  it('does not acknowledge a write when a Drive duplicate appears before confirmation', async () => {
    const initial = await encrypted(document('018f0000-0000-7000-8000-0000000000a1'), 1, 0xa1);
    const setup = coordinator(initial, initial);
    await setup.coordinator.reconnect();
    setup.drive.afterWrite = (written) => {
      setup.drive.extraReplica = written.slice();
    };

    const pending = await setup.coordinator.mutate(({ document: current }) =>
      appendEntity(current, '018f0000-0000-7000-8000-0000000000c1'),
    );

    expect(pending).toMatchObject({
      status: 'pending-offline',
      pending: {},
      lastFailure: expect.stringMatching(/converged to one completely observed object/i),
    });
    expect(setup.coordinator.state).toEqual(pending);
    expect(setup.drive.extraReplica).not.toBeNull();
  });

  it('does not acknowledge a server-only write across a concurrent move to both media', async () => {
    const initial = await encrypted(document('018f0000-0000-7000-8000-0000000000a1'), 1, 0xa1);
    const setup = coordinator(initial, initial, ['server']);
    await setup.coordinator.reconnect();
    setup.server.afterWrite = () => {
      setup.media.mediaState!.mediaSet = ['server', 'drive'];
      setup.media.mediaState!.driveAttestedVersion = 1;
    };

    const pending = await setup.coordinator.mutate(({ document: current }) =>
      appendEntity(current, '018f0000-0000-7000-8000-0000000000c1'),
    );

    expect(pending).toMatchObject({ status: 'pending-offline', pending: {} });
    expect(setup.coordinator.state).toEqual(pending);
    expect(version(setup.server.envelope!)).toBe(2);
    expect(version(setup.drive.envelope!)).toBe(1);

    const repaired = await setup.coordinator.reconnect();
    expect(repaired).toMatchObject({ status: 'synced', pending: null });
    expect(setup.server.envelope).toEqual(setup.drive.envelope);
  });

  it('does not overwrite an unobserved Drive branch while a local mutation is pending', async () => {
    const initial = await encrypted(document('018f0000-0000-7000-8000-0000000000a1'), 1, 0xa1);
    const setup = coordinator(initial, initial);
    await setup.coordinator.reconnect();

    setup.drive.failure = true;
    await setup.coordinator.reconnect();
    await setup.coordinator.mutate(({ document: current }) => ({
      ...current,
      entities: {
        ...current.entities,
        portfolio: [
          ...(current.entities.portfolio ?? []),
          entity('018f0000-0000-7000-8000-0000000000c1'),
        ],
      },
    }));

    setup.drive.failure = false;
    setup.drive.envelope = await encrypted(
      document('018f0000-0000-7000-8000-0000000000b1'),
      2,
      0xb1,
    );
    const reconciled = await setup.coordinator.reconnect();

    expect(reconciled.status).toBe('synced');
    expect(
      reconciled.active?.document.entities.portfolio?.map((candidate) => candidate.id).sort(),
    ).toEqual([
      '018f0000-0000-7000-8000-0000000000a1',
      '018f0000-0000-7000-8000-0000000000b1',
      '018f0000-0000-7000-8000-0000000000c1',
    ]);
    expect(setup.server.envelope).toEqual(setup.drive.envelope);
    expect(version(setup.server.envelope!)).toBe(4);
  });

  it.each(['corrupt', 'authentication-failure'] as const)(
    'authenticates every Drive duplicate before converging a %s metadata winner',
    async (failure) => {
      const valid = await encrypted(document('018f0000-0000-7000-8000-0000000000a1'), 1, 0xa1);
      const badEnvelope = valid.slice();
      const lastIndex = badEnvelope.length - 1;
      badEnvelope[lastIndex] = (badEnvelope[lastIndex] ?? 0) ^ 0xff;
      const invalid: DataHomeReadResult =
        failure === 'corrupt'
          ? {
              status: 'corrupt',
              medium: 'drive',
              envelope: new Uint8Array([1, 2, 3]),
              version: 2,
              updatedAt: '2026-07-28T11:00:00.000Z',
              reason: 'corrupt-bytes',
              message: 'metadata winner is corrupt',
            }
          : {
              status: 'ok',
              medium: 'drive',
              envelope: badEnvelope,
              info: info('drive', badEnvelope),
            };
      const readable: DataHomeReadResult = {
        status: 'ok',
        medium: 'drive',
        envelope: valid.slice(),
        info: info('drive', valid),
      };
      const drive = new DuplicateMemoryDrive([invalid, readable], valid);
      const setup = coordinator(valid, valid, ['drive'], drive);

      const state = await setup.coordinator.reconnect();

      expect(state).toMatchObject({
        status: 'synced',
        active: { document: { entities: { portfolio: [{ id: expect.any(String) }] } } },
        pending: null,
      });
      expect(setup.coordinator.state).toEqual(state);
      expect(drive.convergeCalls).toBe(1);
      expect(drive.replicaCount).toBe(1);
      expect(drive.envelope).toEqual(valid);
    },
  );

  it.each(['absent', 'transport-failure', 'corrupt'] as const)(
    'does not let a healthy final Drive observation mask a server-first %s',
    async (failure) => {
      const initial = await encrypted(document('018f0000-0000-7000-8000-0000000000a1'), 1, 0xa1);
      const setup = coordinator(initial, initial);
      if (failure === 'absent') setup.server.envelope = null;
      if (failure === 'transport-failure') setup.server.failure = true;
      if (failure === 'corrupt') setup.server.corrupt = true;

      const state = await setup.coordinator.reconnect();

      const expectedPending = {
        status: 'pending-offline',
        active: { header: { vaultVersion: 1 } },
        pending: { header: { vaultVersion: 1 } },
      };
      expect(state).toMatchObject(expectedPending);
      expect(setup.coordinator.state).toEqual(state);
      expect(state.lastFailure).toContain(
        failure === 'absent'
          ? 'selected server vault replica is absent'
          : failure === 'transport-failure'
            ? 'server offline'
            : 'server corrupt',
      );
      expect(setup.drive.envelope).toEqual(initial);

      const mutated = await setup.coordinator.mutate(({ document: current }) => ({
        ...current,
        entities: {
          ...current.entities,
          portfolio: [
            ...(current.entities.portfolio ?? []),
            entity('018f0000-0000-7000-8000-0000000000c1'),
          ],
        },
      }));
      // An absent replica is repaired by the successful replicated write.
      // Unreachable or corrupt observations block that write and stay pending.
      expect(mutated.status).toBe(failure === 'absent' ? 'synced' : 'pending-offline');
      expect(setup.coordinator.state).toEqual(mutated);
      if (failure !== 'absent') {
        expect(setup.coordinator.state.pending).not.toBeNull();
      }

      setup.server.envelope ??= initial.slice();
      setup.server.failure = false;
      setup.server.corrupt = false;
      const repaired = await setup.coordinator.reconnect();

      expect(repaired).toMatchObject({ status: 'synced', pending: null });
      expect(setup.coordinator.state).toEqual(repaired);
      expect(setup.server.envelope).toEqual(setup.drive.envelope);
      expect(
        repaired.active?.document.entities.portfolio?.some(
          (candidate) => candidate.id === '018f0000-0000-7000-8000-0000000000c1',
        ),
      ).toBe(true);
    },
  );
});

function coordinator(
  serverEnvelope: Uint8Array,
  driveEnvelope: Uint8Array,
  mediaSet: ['server'] | ['drive'] | ['server', 'drive'] = ['server', 'drive'],
  driveOverride?: MemoryDrive,
) {
  const server = new MemoryRemote('server', serverEnvelope);
  const drive = driveOverride ?? new MemoryDrive(driveEnvelope);
  const media: ParanoidMediaStateResponse = {
    privacyMode: 'paranoid',
    mediaState: {
      mediaSet,
      driveAttestedVersion: mediaSet.some((medium) => medium === 'drive')
        ? version(driveEnvelope)
        : null,
      server: { disposition: 'active', candidate: null, retired: null },
    },
  };
  const primary = createReplicatedVaultDataHome({
    api: { getState: async () => structuredClone(media) },
    server,
    drive,
  });
  const engine = createVaultSyncEngine({
    local: createLocalDataHome({
      scope: crypto.randomUUID(),
      storage: memoryLocalStorage(),
    }),
    primary,
    vaultKey,
    deviceId: DEVICE_ID,
    writeId: writeIdSequence(),
    now: () => '2026-07-28T10:00:00.000Z',
    quarantine: createMemoryVaultQuarantineStore(),
    documentReconciler: (merged, context) => ({
      document: merged,
      mutations: context.mutations,
    }),
    requiresCompleteMutationProvenance: false,
  });
  return {
    server,
    drive,
    media,
    engine,
    coordinator: createReplicaReconcileCoordinator(engine, primary),
  };
}

async function encrypted(
  document: VaultDocument,
  vaultVersion: number,
  marker: number,
): Promise<Uint8Array> {
  return (
    await encryptVaultDocument({
      document,
      vaultKey,
      header: {
        keyId: baseHeader.keyId,
        wrappedKeys: baseHeader.wrappedKeys,
        vaultVersion,
        deviceId: DEVICE_ID,
        writeId: `018f0000-0000-7000-8000-0000000000${marker.toString(16)}`,
        writtenAt: '2026-07-28T10:00:00.000Z',
      },
    })
  ).envelope;
}

function document(id: string): VaultDocument {
  return {
    schemaVersion: 1,
    entities: { portfolio: [entity(id)] },
    mergeLog: [],
    mirrorProvenance: [],
  };
}

function entity(id: string) {
  return {
    id,
    rev: 1,
    editedAt: '2026-07-28T10:00:00.000Z',
    editedBy: DEVICE_ID,
    deletedAt: null,
    data: { name: id },
  };
}

function appendEntity(document: VaultDocument, id: string): VaultDocument {
  return {
    ...document,
    entities: {
      ...document.entities,
      portfolio: [...(document.entities.portfolio ?? []), entity(id)],
    },
  };
}

function version(envelope: Uint8Array): number {
  const inspected = inspectVaultEnvelope(envelope);
  if (inspected.status !== 'supported') throw new Error('unsupported test envelope');
  return inspected.envelope.header.vaultVersion;
}

function info(medium: VaultMedium, envelope: Uint8Array) {
  const inspected = inspectVaultEnvelope(envelope);
  if (inspected.status !== 'supported') throw new Error('unsupported test envelope');
  return {
    medium,
    version: inspected.envelope.header.vaultVersion,
    sizeBytes: envelope.byteLength,
    updatedAt: inspected.envelope.header.writtenAt,
  };
}

function cloneObservation(result: DataHomeReadResult): DataHomeReadResult {
  if (result.status === 'ok') {
    return {
      ...result,
      envelope: result.envelope.slice(),
      info: { ...result.info },
    };
  }
  if (result.status === 'corrupt') {
    return { ...result, envelope: result.envelope?.slice() };
  }
  return result;
}

function writeIdSequence() {
  let next = 1;
  return () => `018f0000-0000-7000-8000-${String(next++).padStart(12, '0')}`;
}

function memoryLocalStorage(): LocalDataHomeStorage {
  let record: LocalVaultRecord | null = null;
  return {
    async read() {
      return cloneRecord(record);
    },
    async compareAndSwap(_scope, expectedVersion, build) {
      const currentVersion = record?.version ?? null;
      if (currentVersion !== expectedVersion) {
        return { status: 'conflict', currentVersion };
      }
      record = cloneRecord(build(cloneRecord(record)));
      return { status: 'ok' };
    },
  };
}

function cloneRecord(record: LocalVaultRecord | null): LocalVaultRecord | null {
  return record
    ? {
        ...record,
        envelope: record.envelope.slice(),
        lastKnownGood: record.lastKnownGood?.slice(),
      }
    : null;
}
