import {
  encodeVaultEnvelope,
  VAULT_CONTENT_CIPHER,
  VAULT_DOCUMENT_VERSION,
  VAULT_FORMAT_VERSION,
} from '@bettertrack/contracts';
import { describe, expect, it, vi } from 'vitest';

import { inspectVaultEnvelope } from '../envelope';
import {
  createDriveDataHome,
  DRIVE_VAULT_FILE_NAME,
  type DriveDuplicateResolver,
} from './driveDataHome';

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

function metadata(
  version: number,
  revision = `rev-${version}`,
  id = 'drive-file-internal',
  sizeBytes = envelope(version).byteLength,
) {
  return {
    id,
    name: DRIVE_VAULT_FILE_NAME,
    appProperties: {
      vaultVersion: String(version),
      formatVersion: String(VAULT_FORMAT_VERSION),
    },
    headRevisionId: revision,
    modifiedTime: AT,
    size: String(sizeBytes),
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

function concurrentDriveBackend() {
  interface StoredFile {
    id: string;
    envelope: Uint8Array;
    version: number;
    revision: number;
  }

  const files = new Map<string, StoredFile>();
  const waitForBothInitialLists = barrier(2);
  const waitForBothCreates = barrier(2);
  let initialListSnapshots = 0;

  function listed(file: StoredFile) {
    return metadata(file.version, `revision-${file.revision}`, file.id, file.envelope.byteLength);
  }

  function fetchFor(device: 'a' | 'b'): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/drive/v3/files?') && !url.includes('/upload/')) {
        if (files.size === 0 && initialListSnapshots < 2) {
          initialListSnapshots += 1;
          await waitForBothInitialLists();
          return json({ files: [] });
        }
        return json({ files: [...files.values()].reverse().map(listed) });
      }

      if (url.includes('/upload/drive/v3/files') && method === 'POST') {
        const bytes = await multipartEnvelope(init);
        const version = envelopeVersion(bytes);
        const file: StoredFile = {
          id: `file-${device}`,
          envelope: bytes,
          version,
          revision: 1,
        };
        files.set(file.id, file);
        await waitForBothCreates();
        return json(listed(file));
      }

      const id = fileIdFrom(url);
      if (url.includes('/upload/drive/v3/files/') && method === 'PATCH') {
        const current = files.get(id);
        if (!current) return new Response(null, { status: 404 });
        const bytes = await multipartEnvelope(init);
        const updated: StoredFile = {
          ...current,
          envelope: bytes,
          version: envelopeVersion(bytes),
          revision: current.revision + 1,
        };
        files.set(id, updated);
        return json(listed(updated));
      }
      if (method === 'DELETE') {
        return files.delete(id)
          ? new Response(null, { status: 204 })
          : new Response(null, { status: 404 });
      }
      if (url.endsWith('?alt=media')) {
        const file = files.get(id);
        return file ? new Response(file.envelope.slice()) : new Response(null, { status: 404 });
      }
      return new Response(null, { status: 500 });
    }) as typeof fetch;
  }

  return {
    fetchFor,
    fileCount: () => files.size,
    onlyEnvelope: () => [...files.values()][0]?.envelope.slice() ?? null,
  };
}

describe('Google Drive app-data DataHome', () => {
  it('creates and reads one opaque appDataFolder file with version app properties', async () => {
    const bytes = envelope(3);
    const writeFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ files: [] }))
      .mockResolvedValueOnce(json(metadata(3)))
      .mockResolvedValueOnce(json({ files: [metadata(3)] }))
      .mockResolvedValueOnce(new Response(bytes));
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

  it('merges and consolidates a two-device absent-file create race', async () => {
    const backend = concurrentDriveBackend();
    const left = envelope(1, 11);
    const right = envelope(1, 22);
    const merged = envelope(2, 33);
    const resolveDuplicates = vi.fn<DriveDuplicateResolver>(async (candidates) => {
      expect(candidates).toHaveLength(2);
      expect(candidates.map(({ envelope: bytes }) => bytes)).toEqual([left, right]);
      return { envelope: merged, version: 2 };
    });
    const homeA = createDriveDataHome({
      tokens: tokens(),
      fetch: backend.fetchFor('a'),
      boundary: () => 'device-a-boundary',
      resolveDuplicates,
    });
    const homeB = createDriveDataHome({
      tokens: tokens(),
      fetch: backend.fetchFor('b'),
      boundary: () => 'device-b-boundary',
      resolveDuplicates,
    });

    const results = await Promise.all([
      homeA.write(left, { ifVersion: null }),
      homeB.write(right, { ifVersion: null }),
    ]);
    expect(results).toEqual([
      { status: 'conflict', medium: 'drive', currentVersion: 2 },
      { status: 'conflict', medium: 'drive', currentVersion: 2 },
    ]);
    expect(resolveDuplicates).toHaveBeenCalled();
    expect(backend.fileCount()).toBe(1);
    expect(backend.onlyEnvelope()).toEqual(merged);

    const read = await homeA.read();
    expect(read).toMatchObject({ status: 'ok', info: { version: 2 } });
    if (read.status === 'ok') expect(read.envelope).toEqual(merged);
    await expect(homeB.info()).resolves.toMatchObject({
      status: 'ok',
      info: { version: 2 },
    });

    const advanced = envelope(3, 44);
    await expect(homeB.write(advanced, { ifVersion: 2 })).resolves.toMatchObject({
      status: 'ok',
      info: { version: 3 },
    });
    expect(backend.fileCount()).toBe(1);
    expect(backend.onlyEnvelope()).toEqual(advanced);
    await expect(homeA.delete()).resolves.toEqual({ status: 'ok', medium: 'drive' });
    expect(backend.fileCount()).toBe(0);
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

function barrier(parties: number): () => Promise<void> {
  let arrivals = 0;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrivals += 1;
    if (arrivals === parties) release();
    await waiting;
  };
}

function fileIdFrom(url: string): string {
  const match = /\/files\/([^?]+)/.exec(url);
  if (!match?.[1]) throw new Error(`Missing Drive file id in ${url}`);
  return decodeURIComponent(match[1]);
}

async function multipartEnvelope(init: RequestInit | undefined): Promise<Uint8Array> {
  if (!(init?.body instanceof Blob)) throw new Error('Expected a multipart Blob upload.');
  const contentType = new Headers(init.headers).get('Content-Type');
  const boundary = /boundary=([^;]+)/.exec(contentType ?? '')?.[1];
  if (!boundary) throw new Error('Expected a multipart boundary.');
  const bytes = new Uint8Array(await blobArrayBuffer(init.body));
  const prefix = new TextEncoder().encode('Content-Type: application/octet-stream\r\n\r\n');
  const suffix = new TextEncoder().encode(`\r\n--${boundary}--`);
  const start = indexOfBytes(bytes, prefix);
  const end = indexOfBytes(bytes, suffix, start + prefix.length);
  if (start < 0 || end < 0) throw new Error('Malformed multipart upload.');
  return bytes.slice(start + prefix.length, end);
}

function blobArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let index = from; index <= haystack.length - needle.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

function envelopeVersion(bytes: Uint8Array): number {
  const inspected = inspectVaultEnvelope(bytes);
  if (inspected.status === 'update-required') throw new Error('Unexpected future vault envelope.');
  return inspected.envelope.header.vaultVersion;
}
