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

const TO_IDENTITY = { googleSub: 'drive-z-permission-id', email: 'drive-z@example.test' };

async function envelope(docVersion = 4): Promise<Uint8Array> {
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
      docVersion,
      schemaVersion: 1,
      deviceId: '018f0000-0000-7000-8000-000000000312',
      writeId: `018f0000-0000-7000-8000-00000000031${docVersion}`,
      writtenAt: '2026-08-20T12:00:00.000Z',
    },
    new Uint8Array([9, 8, 7]),
  );
}

/** The doc as it currently stands on Y; the identity-echo rewrite advances it. */
interface SourceState {
  bytes: Uint8Array;
  version: number;
}

function sourceHome(
  state: SourceState,
  events: string[],
  cleanup: DriveDeleteResult = { status: 'ok', deleted: true },
): DriveDataHome {
  const info = () => ({
    medium: 'drive' as const,
    version: state.version,
    sizeBytes: state.bytes.byteLength,
    updatedAt: null,
  });
  const current = (): DataHomeReadResult => ({
    status: 'ok',
    medium: 'drive',
    envelope: state.bytes,
    info: info(),
  });
  return {
    medium: 'drive',
    read: vi.fn(async () => current()),
    info: vi.fn(async () => ({ status: 'ok' as const, medium: 'drive' as const, info: info() })),
    write: vi.fn(
      async (): Promise<DataHomeWriteResult> => ({
        status: 'ok',
        medium: 'drive',
        info: info(),
      }),
    ),
    observeReplicas: vi.fn(async () => {
      const frozen = current();
      events.push('observe-y');
      return {
        observations: [frozen],
        converge: vi.fn(
          async (): Promise<DataHomeWriteResult> => ({
            status: 'ok',
            medium: 'drive',
            info: info(),
          }),
        ),
        deleteIfUnchanged: vi.fn(async (verify) => {
          events.push('delete-y');
          expect(await verify([frozen])).toBe(true);
          return cleanup;
        }),
      };
    }),
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

const EXPECTED_STATE = {
  media: ['server' as const, 'drive' as const],
  driveConnectionId: FROM_ID,
  mediaAttestedAt: '2026-08-20T11:00:00.000Z',
};

describe('Drive connection media migration', () => {
  it('rewrites the §8 identity echo, verifies Z before the flip, then reports Y cleanup failure', async () => {
    // The echo rewrite is a normal replicated write: it lands on the CURRENT
    // Drive (Y) and the server, advancing the doc to v5 — so the bytes copied
    // to Z, and the version attested at the flip, are the ones naming Z.
    const state: SourceState = { bytes: await envelope(4), version: 4 };
    const rewritten = await envelope(5);
    const events: string[] = [];
    const target = targetHome(rewritten, events);
    const transition = vi.fn(async () => {
      events.push('bind-z');
      return committedState();
    });
    const rewriteDriveIdentityEcho = vi.fn(async () => {
      events.push('rewrite-echo');
      state.bytes = rewritten;
      state.version = 5;
    });

    const result = await migrateDriveConnection({
      vaultId: VAULT_ID,
      transitionId: TRANSITION_ID,
      fromConnectionId: FROM_ID,
      toConnectionId: TO_ID,
      headerDocId: DOC_ID,
      toIdentity: TO_IDENTITY,
      expected: EXPECTED_STATE,
      documents: [
        {
          docId: DOC_ID,
          source: sourceHome(state, events, {
            status: 'transport-failure',
            failure: { code: 'api-failure', message: 'Drive Y delete failed.' },
          }),
          target,
        },
      ],
      authenticate: vi.fn(async () => true),
      rewriteDriveIdentityEcho,
      transition,
    });

    expect(events).toEqual([
      'rewrite-echo',
      'observe-y',
      'read-z-empty',
      'write-z',
      'readback-z',
      'bind-z',
      'delete-y',
    ]);
    expect(rewriteDriveIdentityEcho).toHaveBeenCalledWith(TO_IDENTITY);
    expect(result).toEqual({
      status: 'ok',
      state: committedState(),
      cleanupFailures: [{ docId: DOC_ID, message: 'Drive Y delete failed.' }],
    });
    // Z received the post-rewrite bytes, not the copy that still named Y.
    expect(vi.mocked(target.write).mock.calls[0]![0]).toEqual(rewritten);
    expect(transition).toHaveBeenCalledWith(
      expect.objectContaining({
        next: { media: ['server', 'drive'], driveConnectionId: TO_ID },
        verification: {
          kind: 'drive',
          driveConnectionId: TO_ID,
          docs: [
            {
              docId: DOC_ID,
              docVersion: 5,
              writeId: '018f0000-0000-7000-8000-000000000315',
            },
          ],
        },
      }),
    );
  });

  it('writes nothing to Z and never flips when the identity echo cannot be rewritten', async () => {
    const state: SourceState = { bytes: await envelope(4), version: 4 };
    const events: string[] = [];
    const target = targetHome(state.bytes, events);
    const transition = vi.fn(async () => committedState());

    const result = await migrateDriveConnection({
      vaultId: VAULT_ID,
      transitionId: TRANSITION_ID,
      fromConnectionId: FROM_ID,
      toConnectionId: TO_ID,
      headerDocId: DOC_ID,
      toIdentity: TO_IDENTITY,
      expected: EXPECTED_STATE,
      documents: [{ docId: DOC_ID, source: sourceHome(state, events), target }],
      authenticate: vi.fn(async () => true),
      rewriteDriveIdentityEcho: vi.fn(async () => {
        throw new Error('The header write did not reach every medium.');
      }),
      transition,
    });

    // A header still naming Y on Z would break words-plus-Google-login
    // discovery after the move, so nothing downstream may run.
    expect(result).toEqual({
      status: 'failed',
      stage: 'identity-echo',
      docId: DOC_ID,
      message: 'The header write did not reach every medium.',
    });
    expect(events).toEqual([]);
    expect(target.write).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
  });

  it('refuses a same-connection move instead of deleting the only copy', async () => {
    const state: SourceState = { bytes: await envelope(4), version: 4 };
    const events: string[] = [];
    const source = sourceHome(state, events);
    const rewriteDriveIdentityEcho = vi.fn(async () => undefined);

    // Source and target resolve to the SAME Drive object, so the copy would be
    // skipped as already-equal and the cleanup would then delete it precisely
    // because nothing had changed — reported as a successful move.
    await expect(
      migrateDriveConnection({
        vaultId: VAULT_ID,
        transitionId: TRANSITION_ID,
        fromConnectionId: FROM_ID,
        toConnectionId: FROM_ID,
        headerDocId: DOC_ID,
        toIdentity: TO_IDENTITY,
        expected: EXPECTED_STATE,
        documents: [{ docId: DOC_ID, source, target: source }],
        authenticate: vi.fn(async () => true),
        rewriteDriveIdentityEcho,
        transition: vi.fn(async () => committedState()),
      }),
    ).rejects.toThrow(/source and target connection must differ/u);
    expect(rewriteDriveIdentityEcho).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('refuses a document set that does not carry the header doc', async () => {
    const state: SourceState = { bytes: await envelope(4), version: 4 };
    const events: string[] = [];

    await expect(
      migrateDriveConnection({
        vaultId: VAULT_ID,
        transitionId: TRANSITION_ID,
        fromConnectionId: FROM_ID,
        toConnectionId: TO_ID,
        headerDocId: '018f0000-0000-7000-8000-000000000399',
        toIdentity: TO_IDENTITY,
        expected: EXPECTED_STATE,
        documents: [
          {
            docId: DOC_ID,
            source: sourceHome(state, events),
            target: targetHome(state.bytes, events),
          },
        ],
        authenticate: vi.fn(async () => true),
        rewriteDriveIdentityEcho: vi.fn(async () => undefined),
        transition: vi.fn(async () => committedState()),
      }),
    ).rejects.toThrow(/must carry the vault header document/u);
  });

  it('never flips or deletes when target readback fails', async () => {
    const state: SourceState = { bytes: await envelope(4), version: 4 };
    const events: string[] = [];
    const target = targetHome(state.bytes, events);
    vi.mocked(target.read)
      .mockResolvedValueOnce({ status: 'absent', medium: 'drive' })
      .mockResolvedValueOnce({ status: 'absent', medium: 'drive' });
    const transition = vi.fn(async () => committedState());

    const result = await migrateDriveConnection({
      vaultId: VAULT_ID,
      transitionId: TRANSITION_ID,
      fromConnectionId: FROM_ID,
      toConnectionId: TO_ID,
      headerDocId: DOC_ID,
      toIdentity: TO_IDENTITY,
      expected: { ...EXPECTED_STATE, mediaAttestedAt: null },
      documents: [{ docId: DOC_ID, source: sourceHome(state, events), target }],
      authenticate: vi.fn(async () => true),
      rewriteDriveIdentityEcho: vi.fn(async () => undefined),
      transition,
    });

    expect(result).toMatchObject({ status: 'failed', stage: 'target-readback', docId: DOC_ID });
    expect(transition).not.toHaveBeenCalled();
    expect(events).not.toContain('delete-y');
  });
});
