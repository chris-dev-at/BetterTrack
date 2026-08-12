import { webcrypto } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { base64ToBytes } from '../bytes';
import { decodeVaultEnvelope, encodeVaultEnvelope } from '../envelope';
import { vaultInteroperabilityFixture } from '@bettertrack/domain/vaultVectors';
import {
  createDriveDataHome,
  driveVaultFileName,
  type DriveDataHomeOptions,
} from './driveDataHome';

const ACCOUNT_A = '018f0000-0000-7000-8000-0000000000a1';
const ACCOUNT_B = '018f0000-0000-7000-8000-0000000000b2';
let accountFileName = '';
const envelope = base64ToBytes(
  vaultInteroperabilityFixture.initial.envelopeBase64,
  'envelope-invalid',
);
const decoded = decodeVaultEnvelope(envelope);
const envelopeV2 = encodeVaultEnvelope({ ...decoded.header, vaultVersion: 2 }, decoded.ciphertext);
const concurrentCreateEnvelope = encodeVaultEnvelope(
  { ...decoded.header, writeId: '018f0000-0000-7000-8000-0000000000bb' },
  decoded.ciphertext,
);
const concurrentUpdateEnvelope = encodeVaultEnvelope(
  {
    ...decoded.header,
    vaultVersion: 2,
    writeId: '018f0000-0000-7000-8000-0000000000cc',
  },
  decoded.ciphertext,
);

function metadata(
  overrides: Partial<{
    id: string;
    name: string;
    size: string;
    modifiedTime: string;
    headRevisionId: string;
    appProperties: Record<string, string>;
  }> = {},
) {
  return {
    id: 'drive-file-id',
    name: accountFileName,
    size: String(envelope.byteLength),
    modifiedTime: '2026-07-27T10:00:00.000Z',
    headRevisionId: 'revision-1',
    appProperties: { vaultVersion: '1', formatVersion: '1' },
    ...overrides,
  };
}

function createTestDriveDataHome(options: Omit<DriveDataHomeOptions, 'accountId'>) {
  return createDriveDataHome({ accountId: ACCOUNT_A, ...options });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function tokenSource() {
  return {
    getAccessToken: vi.fn(
      () =>
        ({
          status: 'ok',
          accessToken: 'browser-memory-token',
          expiresAt: Date.now() + 60_000,
        }) as const,
    ),
    markExpired: vi.fn(),
  };
}

function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result)));
    reader.addEventListener('error', () => reject(reader.error));
    reader.readAsText(blob);
  });
}

class ConcurrentCreateDrive {
  private readonly files = new Map<
    string,
    { metadata: ReturnType<typeof metadata>; envelope: Uint8Array }
  >();
  private initialLists: Array<(response: Response) => void> = [];
  private uploads: Array<{
    resolve: (response: Response) => void;
    metadata: ReturnType<typeof metadata>;
  }> = [];
  private initialListCompleted = false;

  get fileCount(): number {
    return this.files.size;
  }

  fetchFor(writer: 'a' | 'b', writerEnvelope: Uint8Array): typeof globalThis.fetch {
    return vi.fn((input, init) => this.handle(writer, writerEnvelope, String(input), init));
  }

  private async handle(
    writer: 'a' | 'b',
    writerEnvelope: Uint8Array,
    url: string,
    init?: RequestInit,
  ): Promise<Response> {
    const method = init?.method ?? 'GET';
    const isList = method === 'GET' && url.includes('/drive/v3/files?');
    if (isList && !this.initialListCompleted) {
      return new Promise((resolve) => {
        this.initialLists.push(resolve);
        if (this.initialLists.length === 2) {
          this.initialListCompleted = true;
          for (const release of this.initialLists.splice(0)) release(json({ files: [] }));
        }
      });
    }

    if (method === 'POST' && url.includes('/upload/drive/v3/files?')) {
      const id = `drive-file-${writer}`;
      const file = metadata({
        id,
        size: String(writerEnvelope.byteLength),
        headRevisionId: `revision-${writer}`,
      });
      this.files.set(id, { metadata: file, envelope: writerEnvelope.slice() });
      return new Promise((resolve) => {
        this.uploads.push({ resolve, metadata: file });
        if (this.uploads.length === 2) {
          for (const upload of this.uploads.splice(0)) upload.resolve(json(upload.metadata));
        }
      });
    }

    if (isList) {
      return json({ files: [...this.files.values()].map((file) => file.metadata) });
    }

    const id = decodeURIComponent(url.match(/\/drive\/v3\/files\/([^?]+)/)?.[1] ?? '');
    if (method === 'DELETE') {
      const deleted = this.files.delete(id);
      return new Response(null, { status: deleted ? 204 : 404 });
    }
    const file = this.files.get(id);
    if (!file) return new Response(null, { status: 404 });
    if (url.includes('alt=media')) return new Response(file.envelope.slice(), { status: 200 });
    return json(file.metadata);
  }
}

class CorruptWinnerDrive {
  readonly events: string[] = [];
  private readonly files = new Map<
    string,
    { metadata: ReturnType<typeof metadata>; envelope: Uint8Array }
  >([
    [
      'corrupt-winner',
      {
        metadata: metadata({
          id: 'corrupt-winner',
          size: '3',
          modifiedTime: '2026-07-27T12:00:00.000Z',
          headRevisionId: 'corrupt-revision',
          appProperties: { vaultVersion: '2', formatVersion: '1' },
        }),
        envelope: new Uint8Array([1, 2, 3]),
      },
    ],
    [
      'valid-loser',
      {
        metadata: metadata({
          id: 'valid-loser',
          size: String(envelope.byteLength),
          modifiedTime: '2026-07-27T11:00:00.000Z',
          headRevisionId: 'valid-revision',
        }),
        envelope: envelope.slice(),
      },
    ],
  ]);

  get fileIds(): string[] {
    return [...this.files.keys()].sort();
  }

  readonly fetch: typeof globalThis.fetch = vi.fn((input, init) =>
    this.handle(String(input), init),
  );

  private async handle(url: string, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.includes('/drive/v3/files?')) {
      this.events.push('list');
      return json({ files: [...this.files.values()].map((file) => file.metadata) });
    }

    const id = decodeURIComponent(url.match(/\/drive\/v3\/files\/([^?]+)/)?.[1] ?? '');
    if (method === 'DELETE') {
      this.events.push(`delete:${id}`);
      const deleted = this.files.delete(id);
      return new Response(null, { status: deleted ? 204 : 404 });
    }
    const file = this.files.get(id);
    if (!file) return new Response(null, { status: 404 });
    if (url.includes('alt=media')) {
      this.events.push(`download:${id}`);
      return new Response(file.envelope.slice(), { status: 200 });
    }
    this.events.push(`metadata:${id}`);
    return json(file.metadata);
  }
}

class ConcurrentUpdateDrive {
  private current = {
    metadata: metadata(),
    envelope: envelope.slice(),
  };
  private refreshes: Array<(response: Response) => void> = [];
  private patches: Array<{
    writer: 'a' | 'b';
    envelope: Uint8Array;
    resolve: (response: Response) => void;
  }> = [];
  private refreshed = false;

  fetchFor(writer: 'a' | 'b', writerEnvelope: Uint8Array): typeof globalThis.fetch {
    return vi.fn((input, init) => this.handle(writer, writerEnvelope, String(input), init));
  }

  private async handle(
    writer: 'a' | 'b',
    writerEnvelope: Uint8Array,
    url: string,
    init?: RequestInit,
  ): Promise<Response> {
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.includes('/drive/v3/files?')) {
      return json({ files: [this.current.metadata] });
    }
    if (
      method === 'GET' &&
      url.includes('/drive/v3/files/drive-file-id?fields=') &&
      !this.refreshed
    ) {
      return new Promise((resolve) => {
        this.refreshes.push(resolve);
        if (this.refreshes.length === 2) {
          this.refreshed = true;
          for (const release of this.refreshes.splice(0)) release(json(this.current.metadata));
        }
      });
    }
    if (method === 'PATCH') {
      return new Promise((resolve) => {
        this.patches.push({ writer, envelope: writerEnvelope.slice(), resolve });
        if (this.patches.length === 2) {
          const ordered = [...this.patches].sort((left, right) =>
            left.writer.localeCompare(right.writer),
          );
          for (const patch of ordered) {
            const responseMetadata = metadata({
              size: String(patch.envelope.byteLength),
              headRevisionId: `revision-2-${patch.writer}`,
              appProperties: { vaultVersion: '2', formatVersion: '1' },
            });
            this.current = {
              metadata: responseMetadata,
              envelope: patch.envelope.slice(),
            };
            patch.resolve(json(responseMetadata));
          }
          this.patches = [];
        }
      });
    }
    if (method === 'GET' && url.includes('alt=media')) {
      return new Response(this.current.envelope.slice(), { status: 200 });
    }
    if (method === 'GET' && url.includes('/drive/v3/files/drive-file-id?fields=')) {
      return json(this.current.metadata);
    }
    throw new Error(`Unexpected Drive request: ${method} ${url}`);
  }
}

class SharedAccountAppDataFolder {
  private readonly files = new Map<
    string,
    { metadata: ReturnType<typeof metadata>; envelope: Uint8Array }
  >();
  private nextId = 1;

  fileNames(): string[] {
    return [...this.files.values()].map((file) => file.metadata.name).sort();
  }

  fetchFor(outgoingEnvelope: Uint8Array): typeof globalThis.fetch {
    return vi.fn((input, init) => this.handle(outgoingEnvelope, String(input), init));
  }

  private async handle(
    outgoingEnvelope: Uint8Array,
    url: string,
    init?: RequestInit,
  ): Promise<Response> {
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.includes('/drive/v3/files?')) {
      const query = new URL(url).searchParams.get('q') ?? '';
      const selectedName = /^name = '([^']+)' and trashed = false$/.exec(query)?.[1];
      return json({
        files: [...this.files.values()]
          .map((file) => file.metadata)
          .filter((file) => file.name === selectedName),
      });
    }

    if (method === 'POST' && url.includes('/upload/drive/v3/files?')) {
      if (!(init?.body instanceof Blob)) throw new Error('Expected a multipart Drive upload.');
      const body = await blobText(init.body);
      const name = /"name":"([^"]+)"/.exec(body)?.[1];
      if (!name) throw new Error('Expected an account-scoped Drive file name.');
      const header = decodeVaultEnvelope(outgoingEnvelope).header;
      const id = `shared-drive-file-${this.nextId++}`;
      const file = metadata({
        id,
        name,
        size: String(outgoingEnvelope.byteLength),
        headRevisionId: `shared-revision-${id}`,
        appProperties: {
          vaultVersion: String(header.vaultVersion),
          formatVersion: String(header.formatVersion),
        },
      });
      this.files.set(id, { metadata: file, envelope: outgoingEnvelope.slice() });
      return json(file);
    }

    const id = decodeURIComponent(url.match(/\/drive\/v3\/files\/([^?]+)/)?.[1] ?? '');
    const file = this.files.get(id);
    if (!file) return new Response(null, { status: 404 });
    if (method === 'GET' && url.includes('alt=media')) {
      return new Response(file.envelope.slice(), { status: 200 });
    }
    if (method === 'GET') return json(file.metadata);
    throw new Error(`Unexpected shared Drive request: ${method} ${url}`);
  }
}

describe('Drive appdata DataHome', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
    accountFileName = await driveVaultFileName(ACCOUNT_A);
  });

  it('reads one appDataFolder file and validates app properties against opaque bytes', async () => {
    const tokens = tokenSource();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ files: [metadata()] }))
      .mockResolvedValueOnce(new Response(envelope.slice(), { status: 200 }));
    const home = createTestDriveDataHome({ tokens, fetch });

    const result = await home.read();
    expect(result).toMatchObject({
      status: 'ok',
      medium: 'drive',
      info: { version: 1, sizeBytes: envelope.byteLength },
    });
    if (result.status === 'ok') expect(result.envelope).toEqual(envelope);
    expect(fetch.mock.calls[0]![0]).toContain('spaces=appDataFolder');
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get('Authorization')).toBe(
      'Bearer browser-memory-token',
    );
  });

  it('creates one multipart appdata file with version properties and no history clone', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ files: [] }))
      .mockResolvedValueOnce(json(metadata()))
      .mockResolvedValueOnce(json({ files: [metadata()] }))
      .mockResolvedValueOnce(new Response(envelope.slice(), { status: 200 }));
    const home = createTestDriveDataHome({
      tokens: tokenSource(),
      fetch,
      boundary: () => 'fixed-boundary',
    });

    await expect(home.write(envelope, { ifVersion: null })).resolves.toMatchObject({
      status: 'ok',
      info: { version: 1 },
    });
    const body = fetch.mock.calls[1]![1]?.body;
    expect(body).toBeInstanceOf(Blob);
    const text = await blobText(body as Blob);
    expect(text).toContain('"parents":["appDataFolder"]');
    expect(text).toContain('"vaultVersion":"1"');
    expect(text).toContain('"formatVersion":"1"');
    expect(text).not.toContain('revisions');
  });

  it('isolates two BetterTrack accounts inside one shared appDataFolder', async () => {
    const folder = new SharedAccountAppDataFolder();
    const homeA = createDriveDataHome({
      accountId: ACCOUNT_A,
      tokens: tokenSource(),
      fetch: folder.fetchFor(envelope),
    });
    const homeB = createDriveDataHome({
      accountId: ACCOUNT_B,
      tokens: tokenSource(),
      fetch: folder.fetchFor(concurrentCreateEnvelope),
    });

    await expect(homeA.write(envelope, { ifVersion: null })).resolves.toMatchObject({
      status: 'ok',
      info: { version: 1 },
    });
    await expect(homeB.write(concurrentCreateEnvelope, { ifVersion: null })).resolves.toMatchObject(
      {
        status: 'ok',
        info: { version: 1 },
      },
    );

    const [nameA, nameB] = await Promise.all([
      driveVaultFileName(ACCOUNT_A),
      driveVaultFileName(ACCOUNT_B),
    ]);
    expect(nameA).not.toBe(nameB);
    expect(nameA).not.toContain(ACCOUNT_A);
    expect(nameB).not.toContain(ACCOUNT_B);
    expect(folder.fileNames()).toEqual([nameA, nameB].sort());

    const [readA, readB] = await Promise.all([homeA.read(), homeB.read()]);
    expect(readA).toMatchObject({ status: 'ok', info: { version: 1 } });
    expect(readB).toMatchObject({ status: 'ok', info: { version: 1 } });
    if (readA.status === 'ok') expect(readA.envelope).toEqual(envelope);
    if (readB.status === 'ok') expect(readB.envelope).toEqual(concurrentCreateEnvelope);
  });

  it('preserves concurrent creates until the coordinator publishes convergence', async () => {
    const drive = new ConcurrentCreateDrive();
    const homeA = createTestDriveDataHome({
      tokens: tokenSource(),
      fetch: drive.fetchFor('a', envelope),
    });
    const homeB = createTestDriveDataHome({
      tokens: tokenSource(),
      fetch: drive.fetchFor('b', concurrentCreateEnvelope),
    });

    const [createdA, createdB] = await Promise.all([
      homeA.write(envelope, { ifVersion: null }),
      homeB.write(concurrentCreateEnvelope, { ifVersion: null }),
    ]);

    expect(createdA).toEqual({ status: 'conflict', medium: 'drive', currentVersion: 1 });
    expect(createdB).toEqual({ status: 'conflict', medium: 'drive', currentVersion: 1 });
    expect(drive.fileCount).toBe(2);

    const replicas = await homeA.observeReplicas!();
    expect(replicas.observations).toHaveLength(2);
    await expect(replicas.converge(envelope)).resolves.toMatchObject({
      status: 'ok',
      info: { version: 1 },
    });
    expect(drive.fileCount).toBe(1);
  });

  it('keeps a valid duplicate and its revisions until corrupt-winner convergence is proven', async () => {
    const drive = new CorruptWinnerDrive();
    const home = createTestDriveDataHome({
      tokens: tokenSource(),
      fetch: drive.fetch,
    });

    const replicas = await home.observeReplicas!();

    expect(replicas.observations.map((candidate) => candidate.status)).toEqual(['corrupt', 'ok']);
    expect(drive.fileIds).toEqual(['corrupt-winner', 'valid-loser']);
    expect(drive.events).not.toContain('delete:valid-loser');
    expect(drive.events).not.toContain('delete:corrupt-winner');

    await expect(replicas.converge(envelope)).resolves.toMatchObject({
      status: 'ok',
      info: { version: 1 },
    });

    expect(drive.fileIds).toEqual(['valid-loser']);
    expect(drive.events.indexOf('delete:corrupt-winner')).toBeGreaterThan(
      drive.events.indexOf('download:valid-loser'),
    );
    expect(drive.events).not.toContain('delete:valid-loser');
  });

  it('post-verifies concurrent updates and never acknowledges the overwritten writer', async () => {
    const drive = new ConcurrentUpdateDrive();
    const homeA = createTestDriveDataHome({
      tokens: tokenSource(),
      fetch: drive.fetchFor('a', envelopeV2),
    });
    const homeB = createTestDriveDataHome({
      tokens: tokenSource(),
      fetch: drive.fetchFor('b', concurrentUpdateEnvelope),
    });

    const [updatedA, updatedB] = await Promise.all([
      homeA.write(envelopeV2, { ifVersion: 1 }),
      homeB.write(concurrentUpdateEnvelope, { ifVersion: 1 }),
    ]);
    const results = [updatedA, updatedB];
    expect(results.filter((result) => result.status === 'ok')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'conflict')).toHaveLength(1);
    const current = await homeA.read();
    expect(current.status).toBe('ok');
    if (current.status === 'ok') expect(current.envelope).toEqual(concurrentUpdateEnvelope);
  });

  it('detects a revision move before update and returns a mergeable CAS conflict', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ files: [metadata()] }))
      .mockResolvedValueOnce(json(metadata({ headRevisionId: 'revision-2' })));
    const home = createTestDriveDataHome({ tokens: tokenSource(), fetch });

    await expect(home.write(envelopeV2, { ifVersion: 1 })).resolves.toEqual({
      status: 'conflict',
      medium: 'drive',
      currentVersion: 1,
    });
  });

  it('does not delete when the frozen Drive revision moves at the cleanup barrier', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ files: [metadata()] }))
      .mockResolvedValueOnce(new Response(envelope.slice(), { status: 200 }))
      .mockResolvedValueOnce(json({ files: [metadata()] }))
      .mockResolvedValueOnce(new Response(envelope.slice(), { status: 200 }))
      .mockResolvedValueOnce(json({ files: [metadata()] }))
      .mockResolvedValueOnce(json(metadata()))
      .mockResolvedValueOnce(json({ files: [metadata({ headRevisionId: 'revision-advanced' })] }));
    const home = createTestDriveDataHome({ tokens: tokenSource(), fetch });
    const replicas = await home.observeReplicas();
    const verify = vi.fn(async () => true);

    await expect(replicas.deleteIfUnchanged(verify)).resolves.toMatchObject({
      status: 'transport-failure',
      failure: { message: expect.stringMatching(/changed/i) },
    });

    expect(verify).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  });

  it('keeps consent, expiry, offline, missing, malformed, corrupt, and API states distinct', async () => {
    const consent = createTestDriveDataHome({
      tokens: {
        getAccessToken: () => ({ status: 'consent-required', message: 'consent' }),
        markExpired: vi.fn(),
      },
      fetch: vi.fn(),
    });
    await expect(consent.read()).resolves.toMatchObject({
      status: 'transport-failure',
      failure: { code: 'consent-required' },
    });

    const gesture = createTestDriveDataHome({
      tokens: {
        getAccessToken: () => ({ status: 'gesture-required', message: 'gesture' }),
        markExpired: vi.fn(),
      },
      fetch: vi.fn(),
    });
    await expect(gesture.read()).resolves.toMatchObject({
      status: 'transport-failure',
      failure: { code: 'gesture-required' },
    });

    const offline = createTestDriveDataHome({
      tokens: tokenSource(),
      fetch: vi.fn(),
      isOnline: () => false,
    });
    await expect(offline.read()).resolves.toMatchObject({
      status: 'transport-failure',
      failure: { code: 'offline' },
    });

    const missing = createTestDriveDataHome({
      tokens: tokenSource(),
      fetch: vi.fn().mockResolvedValue(json({ files: [] })),
    });
    await expect(missing.read()).resolves.toEqual({ status: 'absent', medium: 'drive' });

    const malformed = createTestDriveDataHome({
      tokens: tokenSource(),
      fetch: vi.fn().mockResolvedValue(json({ files: [metadata({ headRevisionId: '' })] })),
    });
    await expect(malformed.info()).resolves.toMatchObject({
      status: 'corrupt',
      reason: 'malformed-metadata',
    });

    const corrupt = createTestDriveDataHome({
      tokens: tokenSource(),
      fetch: vi
        .fn()
        .mockResolvedValueOnce(json({ files: [metadata()] }))
        .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 })),
    });
    await expect(corrupt.read()).resolves.toMatchObject({
      status: 'corrupt',
      reason: 'corrupt-bytes',
    });

    const tokens = tokenSource();
    const expired = createTestDriveDataHome({
      tokens,
      fetch: vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
    });
    await expect(expired.read()).resolves.toMatchObject({
      status: 'transport-failure',
      failure: { code: 'token-expired' },
    });
    expect(tokens.markExpired).toHaveBeenCalled();

    const apiFailure = createTestDriveDataHome({
      tokens: tokenSource(),
      fetch: vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
    });
    await expect(apiFailure.read()).resolves.toMatchObject({
      status: 'transport-failure',
      failure: { code: 'api-failure', httpStatus: 503 },
    });
  });
});
