import {
  encodeVaultEnvelope,
  VAULT_CONTENT_CIPHER,
  VAULT_DOCUMENT_VERSION,
  VAULT_FORMAT_VERSION,
} from '@bettertrack/contracts';
import { describe, expect, it, vi } from 'vitest';

import { createDriveDataHome, DRIVE_VAULT_FILE_NAME } from './driveDataHome';

const UUID_A = '018f0000-0000-7000-8000-00000000000a';
const UUID_B = '018f0000-0000-7000-8000-00000000000b';
const UUID_C = '018f0000-0000-7000-8000-00000000000c';
const AT = '2026-07-26T10:00:00.000Z';

function envelope(version: number, byte = 7): Uint8Array {
  return encodeVaultEnvelope(
    {
      formatVersion: VAULT_FORMAT_VERSION,
      cipher: VAULT_CONTENT_CIPHER,
      iv: 'aXYtOTZiaXQ=',
      keyId: UUID_A,
      wrappedKeys: [
        {
          keyId: UUID_A,
          kdf: { alg: 'argon2id', m: 65536, t: 3, p: 1, salt: 'c2FsdA==' },
          wrappedVk: 'd3JhcHBlZA==',
        },
      ],
      vaultVersion: version,
      schemaVersion: VAULT_DOCUMENT_VERSION,
      deviceId: UUID_B,
      writeId: UUID_C,
      writtenAt: AT,
    },
    new Uint8Array(17).fill(byte),
  );
}

function metadata(version: number, revision = `rev-${version}`) {
  return {
    id: 'drive-file-internal',
    name: DRIVE_VAULT_FILE_NAME,
    appProperties: {
      vaultVersion: String(version),
      formatVersion: String(VAULT_FORMAT_VERSION),
    },
    headRevisionId: revision,
    modifiedTime: AT,
    size: String(envelope(version).byteLength),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function tokens(
  result:
    | { status: 'ok'; accessToken: string; expiresAt: number }
    | {
        status: 'unavailable';
        reason: 'consent-required' | 'token-expired' | 'gesture-required' | 'offline';
        message: string;
      } = { status: 'ok', accessToken: 'browser-memory-token', expiresAt: Date.now() + 60_000 },
) {
  return {
    token: vi.fn(async () => result),
    invalidate: vi.fn(),
  };
}

describe('Google Drive app-data DataHome', () => {
  it('creates and reads one opaque appDataFolder file with version app properties', async () => {
    const bytes = envelope(3);
    const writeFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ files: [] }))
      .mockResolvedValueOnce(json(metadata(3)));
    const home = createDriveDataHome({
      tokens: tokens(),
      fetch: writeFetch,
      boundary: () => 'deterministic-boundary',
    });

    await expect(home.write(bytes, { ifVersion: null })).resolves.toMatchObject({
      status: 'ok',
      medium: 'drive',
      info: { version: 3 },
    });
    expect(String(writeFetch.mock.calls[0]![0])).toContain('spaces=appDataFolder');
    expect(String(writeFetch.mock.calls[1]![0])).toContain('uploadType=multipart');
    expect(writeFetch.mock.calls[1]![1]).toMatchObject({ method: 'POST' });
    const uploadBody = writeFetch.mock.calls[1]![1]!.body as Blob;
    const multipart = await blobText(uploadBody);
    expect(multipart).toContain(`"name":"${DRIVE_VAULT_FILE_NAME}"`);
    expect(multipart).toContain('"parents":["appDataFolder"]');
    expect(multipart).toContain('"vaultVersion":"3"');
    expect(multipart).toContain('"formatVersion":"1"');

    const readFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ files: [metadata(3)] }))
      .mockResolvedValueOnce(new Response(bytes));
    const reader = createDriveDataHome({ tokens: tokens(), fetch: readFetch });
    const read = await reader.read();
    expect(read).toMatchObject({
      status: 'ok',
      medium: 'drive',
      info: { version: 3, updatedAt: AT },
    });
    if (read.status === 'ok') expect(read.envelope).toEqual(bytes);
  });

  it('re-reads app properties and headRevisionId before update and reports a race', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ files: [metadata(1, 'revision-a')] }))
      .mockResolvedValueOnce(json({ files: [metadata(1, 'revision-b')] }));
    const home = createDriveDataHome({ tokens: tokens(), fetch });

    await expect(home.write(envelope(2), { ifVersion: 1 })).resolves.toEqual({
      status: 'conflict',
      medium: 'drive',
      currentVersion: 1,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps missing, malformed metadata, corrupt bytes, token expiry, and API failure distinct', async () => {
    const missing = createDriveDataHome({
      tokens: tokens(),
      fetch: vi.fn<typeof fetch>().mockResolvedValue(json({ files: [] })),
    });
    await expect(missing.read()).resolves.toEqual({ status: 'absent', medium: 'drive' });

    const malformed = createDriveDataHome({
      tokens: tokens(),
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(json({ files: [{ ...metadata(1), appProperties: {} }] })),
    });
    await expect(malformed.info()).resolves.toMatchObject({
      status: 'corrupt',
      reason: 'malformed-metadata',
    });

    const corruptBytes = createDriveDataHome({
      tokens: tokens(),
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(json({ files: [metadata(1)] }))
        .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]))),
    });
    await expect(corruptBytes.read()).resolves.toMatchObject({
      status: 'corrupt',
      reason: 'corrupt-bytes',
    });

    const expiredTokens = tokens();
    const expired = createDriveDataHome({
      tokens: expiredTokens,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 })),
    });
    await expect(expired.info()).resolves.toMatchObject({
      status: 'transport-failure',
      failure: { kind: 'token-expired' },
    });
    expect(expiredTokens.invalidate).toHaveBeenCalledOnce();

    const failed = createDriveDataHome({
      tokens: tokens(),
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 })),
    });
    await expect(failed.info()).resolves.toMatchObject({
      status: 'transport-failure',
      failure: { kind: 'api-failure', httpStatus: 503 },
    });
  });

  it('does not call Drive when consent is absent, offline, or a gesture is required', async () => {
    for (const reason of ['consent-required', 'offline', 'gesture-required'] as const) {
      const fetch = vi.fn<typeof globalThis.fetch>();
      const home = createDriveDataHome({
        tokens: tokens({ status: 'unavailable', reason, message: reason }),
        fetch,
      });
      await expect(home.read()).resolves.toMatchObject({
        status: 'transport-failure',
        failure: { kind: reason },
      });
      expect(fetch).not.toHaveBeenCalled();
    }
  });
});

function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}
