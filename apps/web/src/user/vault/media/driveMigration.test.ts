import { webcrypto } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  encodeVaultDocEnvelope,
  VAULT_CONTENT_CIPHER,
  type PerVaultMediaState,
} from '@bettertrack/contracts';

import type { DataHomeReadResult, DataHomeWriteResult } from '../dataHome';
import type { DriveDataHome, DriveDeleteResult } from '../drive';
import { deriveAccountBinding } from '../keys';
import { migrateDriveConnection } from './driveMigration';

const ACCOUNT_ID = '018f0000-0000-7000-8000-000000000301';
const VAULT_ID = '018f0000-0000-7000-8000-000000000302';
const DOC_ID = '018f0000-0000-7000-8000-000000000303';
const FROM_ID = '018f0000-0000-7000-8000-000000000304';
const TO_ID = '018f0000-0000-7000-8000-000000000305';
const TRANSITION_ID = '018f0000-0000-7000-8000-000000000306';

beforeEach(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
});

async function envelope(): Promise<Uint8Array> {
  return encodeVaultDocEnvelope(
    {
      formatVersion: 2,
      cipher: VAULT_CONTENT_CIPHER,
      iv: 'AA',
      keyId: '018f0000-0000-7000-8000-000000000311',
      keySlots: [
        {
          keyId: '018f0000-0000-7000-8000-000000000311',
          slot: 'seed-v1',
          wrappedKc: 'opaque',
        },
      ],
      vaultId: VAULT_ID,
      docId: DOC_ID,
      docKind: 'header',
      accountBinding: await deriveAccountBinding(ACCOUNT_ID),
      docVersion: 4,
      schemaVersion: 1,
      deviceId: '018f0000-0000-7000-8000-000000000312',
      writeId: '018f0000-0000-7000-8000-000000000313',
      writtenAt: '2026-08-20T12:00:00.000Z',
    },
    new Uint8Array([9, 8, 7]),
  );
}

function sourceHome(
  bytes: Uint8Array,
  events: string[],
  cleanup: DriveDeleteResult = { status: 'ok', deleted: true },
): DriveDataHome {
  const read: DataHomeReadResult = {
    status: 'ok',
    medium: 'drive',
    envelope: bytes,
    info: { medium: 'drive', version: 4, sizeBytes: bytes.byteLength, updatedAt: null },
  };
  return {
    medium: 'drive',
    read: vi.fn(async () => read),
    info: vi.fn(async () => ({
      status: 'ok' as const,
      medium: 'drive' as const,
      info: read.info,
    })),
    write: vi.fn(
      async (): Promise<DataHomeWriteResult> => ({
        status: 'ok',
        medium: 'drive',
        info: read.info,
      }),
    ),
    observeReplicas: vi.fn(async () => ({
      observations: [read],
      converge: vi.fn(
        async (): Promise<DataHomeWriteResult> => ({
          status: 'ok',
          medium: 'drive',
          info: read.info,
        }),
      ),
      deleteIfUnchanged: vi.fn(async (verify) => {
        events.push('delete-y');
        expect(await verify([read])).toBe(true);
        return cleanup;
      }),
    })),
  };
}

function targetHome(bytes: Uint8Array, events: string[]): DriveDataHome {
  let stored = false;
  const read = async (): Promise<DataHomeReadResult> => {
    events.push(stored ? 'readback-z' : 'read-z-empty');
    return stored
      ? {
          status: 'ok',
          medium: 'drive',
          envelope: bytes.slice(),
          info: { medium: 'drive', version: 4, sizeBytes: bytes.byteLength, updatedAt: null },
        }
      : { status: 'absent', medium: 'drive' };
  };
  return {
    medium: 'drive',
    read: vi.fn(read),
    info: vi.fn(async () => {
      const result = await read();
      return result.status === 'ok'
        ? { status: 'ok' as const, medium: 'drive' as const, info: result.info }
        : result;
    }),
    write: vi.fn(async () => {
      events.push('write-z');
      stored = true;
      return {
        status: 'ok' as const,
        medium: 'drive' as const,
        info: {
          medium: 'drive' as const,
          version: 4,
          sizeBytes: bytes.byteLength,
          updatedAt: null,
        },
      };
    }),
    observeReplicas: vi.fn(),
  };
}

function committedState(): PerVaultMediaState {
  return {
    vaultId: VAULT_ID,
    media: ['server', 'drive'],
    driveConnectionId: TO_ID,
    mediaAttestedAt: '2026-08-20T12:01:00.000Z',
    mediaAttestedDriveConnectionId: TO_ID,
    server: { disposition: 'active', candidates: [], retirement: null },
  };
}

describe('Drive connection media migration', () => {
  it('writes and verifies Z before flipping the binding, then reports Y cleanup failure', async () => {
    const bytes = await envelope();
    const events: string[] = [];
    const transition = vi.fn(async () => {
      events.push('bind-z');
      return committedState();
    });

    const result = await migrateDriveConnection({
      vaultId: VAULT_ID,
      transitionId: TRANSITION_ID,
      fromConnectionId: FROM_ID,
      toConnectionId: TO_ID,
      expected: {
        media: ['server', 'drive'],
        driveConnectionId: FROM_ID,
        mediaAttestedAt: '2026-08-20T11:00:00.000Z',
      },
      documents: [
        {
          docId: DOC_ID,
          source: sourceHome(bytes, events, {
            status: 'transport-failure',
            failure: { code: 'api-failure', message: 'Drive Y delete failed.' },
          }),
          target: targetHome(bytes, events),
        },
      ],
      authenticate: vi.fn(async () => true),
      transition,
    });

    expect(events).toEqual(['read-z-empty', 'write-z', 'readback-z', 'bind-z', 'delete-y']);
    expect(result).toEqual({
      status: 'ok',
      state: committedState(),
      cleanupFailures: [{ docId: DOC_ID, message: 'Drive Y delete failed.' }],
    });
    expect(transition).toHaveBeenCalledWith(
      expect.objectContaining({
        next: { media: ['server', 'drive'], driveConnectionId: TO_ID },
        verification: {
          kind: 'drive',
          driveConnectionId: TO_ID,
          docs: [{ docId: DOC_ID, docVersion: 4, writeId: expect.any(String) }],
        },
      }),
    );
  });

  it('never flips or deletes when target readback fails', async () => {
    const bytes = await envelope();
    const events: string[] = [];
    const target = targetHome(bytes, events);
    vi.mocked(target.read)
      .mockResolvedValueOnce({ status: 'absent', medium: 'drive' })
      .mockResolvedValueOnce({ status: 'absent', medium: 'drive' });
    const transition = vi.fn(async () => committedState());

    const result = await migrateDriveConnection({
      vaultId: VAULT_ID,
      transitionId: TRANSITION_ID,
      fromConnectionId: FROM_ID,
      toConnectionId: TO_ID,
      expected: {
        media: ['server', 'drive'],
        driveConnectionId: FROM_ID,
        mediaAttestedAt: null,
      },
      documents: [{ docId: DOC_ID, source: sourceHome(bytes, events), target }],
      authenticate: vi.fn(async () => true),
      transition,
    });

    expect(result).toMatchObject({ status: 'failed', stage: 'target-readback', docId: DOC_ID });
    expect(transition).not.toHaveBeenCalled();
    expect(events).not.toContain('delete-y');
  });
});
