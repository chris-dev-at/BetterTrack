import { webcrypto } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { VaultDocument, VaultWrappedKey } from '@bettertrack/contracts';

import type { DataHome, DataHomeMedium, DataHomeReadResult } from '../dataHome';
import type { NormalVaultCapture } from './migration';
import {
  emptyVaultDocument,
  enablePreparedVault,
  type PreparedVaultMaterial,
  VaultEnableError,
} from './enable';

const KEY_ID = '018f0000-0000-7000-8000-000000000001';
const DEVICE_ID = '018f0000-0000-7000-8000-000000000002';
const WRITE_ID = '018f0000-0000-7000-8000-000000000003';
const USER_ID = '018f0000-0000-7000-8000-000000000004';
const PORTFOLIO_ID = '018f0000-0000-7000-8000-000000000005';
const ORDER_ID = '018f0000-0000-7000-8000-000000000006';
const MISSING_ASSET_ID = '018f0000-0000-7000-8000-000000000007';
const AT = '2026-07-30T09:00:00.000Z';
const REVISION = 'r3v1s10n-token';
const CREDENTIAL = { password: 'account-password' };

/** The smallest document the unlock validator accepts: one live portfolio. */
function migratedDocument(): VaultDocument {
  return {
    ...emptyVaultDocument(),
    entities: {
      portfolio: [
        {
          id: PORTFOLIO_ID,
          rev: 1,
          editedAt: AT,
          editedBy: DEVICE_ID,
          deletedAt: null,
          data: {
            userId: USER_ID,
            name: 'Main',
            visibility: 'private',
            sortOrder: 0,
            defaultPayFromCash: false,
            archivedAt: null,
          },
        },
      ],
    },
  };
}

/**
 * The defect class this issue exists for: a pending buy-asset standing order
 * whose asset the migration never snapshotted. Such a document unlocks as
 * `VAULT_CORRUPT` (`engine/session.ts` graph validation) — which, after the
 * enable commit, is unrecoverable account destruction.
 */
function documentWithDanglingOrderAsset(): VaultDocument {
  const document = migratedDocument();
  document.entities.standingOrder = [
    {
      id: ORDER_ID,
      rev: 1,
      editedAt: AT,
      editedBy: DEVICE_ID,
      deletedAt: null,
      data: {
        userId: USER_ID,
        portfolioId: PORTFOLIO_ID,
        kind: 'buy-asset',
        assetId: MISSING_ASSET_ID,
        amount: '100',
        currency: 'EUR',
        label: null,
        cadence: 'monthly',
        anchorDay: 1,
        startDate: '2026-08-01',
        endDate: null,
        status: 'active',
        lastRunAt: null,
        lastPeriodKey: null,
        createdAt: AT,
        updatedAt: AT,
      },
    },
  ];
  return document;
}
const WRAPPED_KEY: VaultWrappedKey = {
  keyId: KEY_ID,
  kdf: {
    alg: 'argon2id',
    m: 65_536,
    t: 3,
    p: 1,
    salt: 'AAAAAAAAAAAAAAAAAAAAAA==',
  },
  wrappedVk: 'AA',
};

beforeEach(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
});

describe('paranoid enable ordering', () => {
  it('migrates, encrypts, writes and verifies every medium before the destructive commit', async () => {
    const server = memoryHome('server');
    const drive = memoryHome('drive');
    const stages: string[] = [];
    const commit = vi.fn(async () => ({
      mode: 'paranoid' as const,
      mediaSet: ['server', 'drive'] as Array<'server' | 'drive'>,
      vaultVersion: 1,
      completedAt: '2026-07-30T10:00:01.000Z',
      idempotent: false,
    }));

    await expect(
      enablePreparedVault(
        {
          mediaSet: ['server', 'drive'],
          material: material(),
          credential: CREDENTIAL,
          onStage: (stage) => stages.push(stage),
        },
        {
          server,
          drive,
          migrate: async () => capture(migratedDocument()),
          commit,
          now: () => '2026-07-30T10:00:00.000Z',
          id: idSequence(DEVICE_ID, WRITE_ID),
        },
      ),
    ).resolves.toMatchObject({ version: 1, receipt: { mode: 'paranoid' } });

    expect(stages).toEqual([
      'migrate',
      'validate',
      'encrypt',
      'write-server',
      'write-drive',
      'verify-server',
      'verify-drive',
      'commit',
    ]);
    expect(commit).toHaveBeenCalledOnce();
    expect(server.readCount()).toBe(2);
    expect(drive.readCount()).toBe(2);
    // The commit carries the token the CAPTURE was read at, not a fresh one.
    // The server re-derives it under the account lock, so a write that landed
    // anywhere in the (long, lock-free) window above refuses the transition
    // instead of purging rows this document never saw.
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({ normalDataRevision: REVISION, password: 'account-password' }),
    );
  });

  it('never commits or claims success when a selected medium fails read-back verification', async () => {
    const commit = vi.fn();
    const drive = memoryHome('drive', { corruptVerification: true });

    const failure = await captureError(() =>
      enablePreparedVault(
        {
          mediaSet: ['server', 'drive'],
          material: material(),
          credential: CREDENTIAL,
        },
        {
          server: memoryHome('server'),
          drive,
          migrate: async () => capture(migratedDocument()),
          commit,
          now: () => '2026-07-30T10:00:00.000Z',
          id: idSequence(DEVICE_ID, WRITE_ID),
        },
      ),
    );

    expect(failure).toBeInstanceOf(VaultEnableError);
    expect(failure).toMatchObject({ stage: 'verify-drive' });
    expect(commit).not.toHaveBeenCalled();
  });

  it('refuses a document its own unlock validator rejects — before any medium write', async () => {
    const server = memoryHome('server');
    const drive = memoryHome('drive');
    const commit = vi.fn();
    const stages: string[] = [];

    const failure = await captureError(() =>
      enablePreparedVault(
        {
          mediaSet: ['server', 'drive'],
          material: material(),
          credential: CREDENTIAL,
          onStage: (stage) => stages.push(stage),
        },
        {
          server,
          drive,
          migrate: async () => capture(documentWithDanglingOrderAsset()),
          commit,
          now: () => '2026-07-30T10:00:00.000Z',
          id: idSequence(DEVICE_ID, WRITE_ID),
        },
      ),
    );

    expect(failure).toBeInstanceOf(VaultEnableError);
    expect(failure).toMatchObject({
      stage: 'validate',
      message: expect.stringContaining('normal account is unchanged'),
    });
    // Nothing leaked and nothing happened: no write, no read, no commit.
    expect(stages).toEqual(['migrate', 'validate']);
    expect(server.writeCount()).toBe(0);
    expect(drive.writeCount()).toBe(0);
    expect(commit).not.toHaveBeenCalled();
  });

  it('refuses a document with zero portfolios instead of committing an unopenable vault', async () => {
    // A reachable-looking edge the round-6 defect proved matters: the server
    // materialises the default portfolio on every list, so a real migration
    // never sees zero — but if it ever did, the vault must stop HERE, not
    // unlock as VAULT_INVALID_OWNERSHIP after the purge.
    const server = memoryHome('server');
    const commit = vi.fn();

    const failure = await captureError(() =>
      enablePreparedVault(
        { mediaSet: ['server'], material: material(), credential: CREDENTIAL },
        {
          server,
          migrate: async () => capture(emptyVaultDocument()),
          commit,
          now: () => '2026-07-30T10:00:00.000Z',
          id: idSequence(DEVICE_ID, WRITE_ID),
        },
      ),
    );

    expect(failure).toBeInstanceOf(VaultEnableError);
    expect(failure).toMatchObject({ stage: 'validate' });
    expect(server.writeCount()).toBe(0);
    expect(commit).not.toHaveBeenCalled();
  });
});

/** A capture as `captureNormalVault` produces it: document + its CAS token. */
function capture(document: VaultDocument): NormalVaultCapture {
  return { document, normalDataRevision: REVISION };
}

function material(): PreparedVaultMaterial {
  return {
    keyId: KEY_ID,
    vaultKey: new Uint8Array(32).fill(7),
    wrappedKey: WRAPPED_KEY,
    recoveryKit: {
      bytes: new Uint8Array([1]),
      filename: 'bettertrack-recovery-kit.txt',
      type: 'text/plain;charset=utf-8',
    },
    dispose: vi.fn(),
  };
}

function memoryHome(
  medium: DataHomeMedium,
  options: { corruptVerification?: boolean } = {},
): DataHome & { readCount(): number; writeCount(): number } {
  let envelope: Uint8Array | null = null;
  let reads = 0;
  let writes = 0;
  return {
    medium,
    readCount: () => reads,
    writeCount: () => writes,
    async read(): Promise<DataHomeReadResult> {
      reads += 1;
      if (envelope == null) return { status: 'absent', medium };
      if (options.corruptVerification) {
        return {
          status: 'corrupt',
          medium,
          version: 1,
          updatedAt: null,
          reason: 'corrupt-bytes',
          message: 'read-back mismatch',
        };
      }
      return {
        status: 'ok',
        medium,
        envelope: envelope.slice(),
        info: { medium, version: 1, sizeBytes: envelope.byteLength, updatedAt: null },
      };
    },
    async write(next, { ifVersion }) {
      writes += 1;
      if (ifVersion !== null) return { status: 'conflict', medium, currentVersion: null };
      envelope = next.slice();
      return {
        status: 'ok',
        medium,
        info: { medium, version: 1, sizeBytes: next.byteLength, updatedAt: null },
      };
    },
    async info() {
      return envelope == null
        ? { status: 'absent' as const, medium }
        : {
            status: 'ok' as const,
            medium,
            info: { medium, version: 1, sizeBytes: envelope.byteLength, updatedAt: null },
          };
    },
  };
}

function idSequence(...ids: string[]): () => string {
  let index = 0;
  return () => ids[index++]!;
}

async function captureError(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to reject.');
}
