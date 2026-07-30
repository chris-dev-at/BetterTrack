import { webcrypto } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { VaultWrappedKey } from '@bettertrack/contracts';

import type { DataHome, DataHomeMedium, DataHomeReadResult } from '../dataHome';
import {
  emptyVaultDocument,
  enablePreparedVault,
  type PreparedVaultMaterial,
  VaultEnableError,
} from './enable';

const KEY_ID = '018f0000-0000-7000-8000-000000000001';
const DEVICE_ID = '018f0000-0000-7000-8000-000000000002';
const WRITE_ID = '018f0000-0000-7000-8000-000000000003';
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
          onStage: (stage) => stages.push(stage),
        },
        {
          server,
          drive,
          migrate: async () => emptyVaultDocument(),
          commit,
          now: () => '2026-07-30T10:00:00.000Z',
          id: idSequence(DEVICE_ID, WRITE_ID),
        },
      ),
    ).resolves.toMatchObject({ version: 1, receipt: { mode: 'paranoid' } });

    expect(stages).toEqual([
      'migrate',
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
  });

  it('never commits or claims success when a selected medium fails read-back verification', async () => {
    const commit = vi.fn();
    const drive = memoryHome('drive', { corruptVerification: true });

    const failure = await captureError(() =>
      enablePreparedVault(
        {
          mediaSet: ['server', 'drive'],
          material: material(),
        },
        {
          server: memoryHome('server'),
          drive,
          migrate: async () => emptyVaultDocument(),
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
});

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
): DataHome & { readCount(): number } {
  let envelope: Uint8Array | null = null;
  let reads = 0;
  return {
    medium,
    readCount: () => reads,
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
