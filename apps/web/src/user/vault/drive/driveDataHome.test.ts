import { webcrypto } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { base64ToBytes } from '../bytes';
import { decodeVaultEnvelope, encodeVaultEnvelope } from '../envelope';
import { vaultInteroperabilityFixture } from '@bettertrack/domain/vaultVectors';
import {
  encodeVaultDocEnvelope,
  VAULT_CONTENT_CIPHER,
  VAULT_DOC_FORMAT_VERSION,
  type VaultDocKind,
} from '@bettertrack/contracts';
import { deriveAccountBinding } from '../keys';
import {
  createDriveDataHome,
  driveOwnerDigest,
  driveVaultDigest,
  driveVaultFileName,
  type DriveDataHomeOptions,
} from './driveDataHome';

const ACCOUNT_A = '018f0000-0000-7000-8000-0000000000a1';
const ACCOUNT_B = '018f0000-0000-7000-8000-0000000000b2';
const VAULT_A = '018f0000-0000-7000-8000-0000000000c3';
const VAULT_B = '018f0000-0000-7000-8000-0000000000d4';
const DOC_A = '018f0000-0000-7000-8000-0000000000e5';
const DOC_B = '018f0000-0000-7000-8000-0000000000f6';
let accountFileName = '';
let accountOwnerDigest = '';
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
    appProperties: {
      ownerDigest: accountOwnerDigest,
      vaultVersion: '1',
      formatVersion: '1',
    },
    ...overrides,
  };
}

async function envelopeV2Doc(
  accountId: string,
  vaultId: string,
  docId: string,
  docVersion = 1,
  docKind: VaultDocKind = 'header',
): Promise<Uint8Array> {
  return encodeVaultDocEnvelope(
    {
      formatVersion: VAULT_DOC_FORMAT_VERSION,
      cipher: VAULT_CONTENT_CIPHER,
      iv: 'AA',
      keyId: '018f0000-0000-7000-8000-000000000201',
      keySlots: [
        {
          keyId: '018f0000-0000-7000-8000-000000000201',
          slot: 'seed-v1',
          wrappedKc: 'opaque-wrapped-key',
        },
      ],
      vaultId,
      docId,
      docKind,
      accountBinding: await deriveAccountBinding(accountId),
      docVersion,
      schemaVersion: 1,
      deviceId: '018f0000-0000-7000-8000-000000000202',
      writeId: `018f0000-0000-7000-8000-${String(docVersion).padStart(12, '0')}`,
      writtenAt: '2026-08-20T12:00:00.000Z',
    },
    new Uint8Array([1, 7, 3, 9]),
  );
}

function createTestDriveDataHome(options: Omit<DriveDataHomeOptions, 'accountId'>) {
  return createDriveDataHome({
    accountId: ACCOUNT_A,
    folderId: 'visible-bettertrack-folder',
    ...options,
  });
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
    markRevoked: vi.fn(),
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
          appProperties: {
            ownerDigest: accountOwnerDigest,
            vaultVersion: '2',
            formatVersion: '1',
          },
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
              appProperties: {
                ownerDigest: accountOwnerDigest,
                vaultVersion: '2',
                formatVersion: '1',
              },
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

/**
 * A Drive that lets two homes reach the visible-folder lookup at the same
 * moment. Every folder-marker list is answered in pairs, so both parties
 * observe "no folder" before either creates one, and both creates have landed
 * before either reconciliation read returns — the collision the per-home cache
 * cannot prevent, made deterministic instead of timing-dependent.
 */
class ConcurrentFolderDrive {
  private readonly folders = new Set<string>();
  private readonly files = new Map<
    string,
    { metadata: ReturnType<typeof metadata>; envelope: Uint8Array; parent: string }
  >();
  private waiting: Array<() => void> = [];
  private nextFolder = 1;
  private nextFile = 1;
  readonly folderCreates: string[] = [];
  readonly folderDeletes: string[] = [];

  constructor(private readonly parties: number) {}

  folderIds(): readonly string[] {
    return [...this.folders].sort();
  }

  fileParents(): readonly string[] {
    return [...this.files.values()].map((file) => file.parent).sort();
  }

  fetchFor(outgoingEnvelope: Uint8Array): typeof globalThis.fetch {
    return vi.fn((input, init) => this.handle(outgoingEnvelope, String(input), init));
  }

  private pair(): Promise<void> {
    return new Promise((resolve) => {
      this.waiting.push(resolve);
      if (this.waiting.length < this.parties) return;
      const arrived = this.waiting;
      this.waiting = [];
      for (const release of arrived) release();
    });
  }

  private async handle(
    outgoingEnvelope: Uint8Array,
    url: string,
    init?: RequestInit,
  ): Promise<Response> {
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.includes('/drive/v3/files?')) {
      const query = new URL(url).searchParams.get('q') ?? '';
      if (query.includes('folderMarker')) {
        await this.pair();
        return json({ files: this.folderIds().map((id) => ({ id })) });
      }
      if (query.includes('in parents')) {
        const parent = /'([^']+)' in parents/u.exec(query)?.[1];
        return json({
          files: [...this.files.values()]
            .filter((file) => file.parent === parent)
            .map((file) => ({ id: file.metadata.id })),
        });
      }
      const docKind = /key='docKind' and value='([^']+)'/u.exec(query)?.[1];
      return json({
        files: [...this.files.values()]
          .filter((file) => file.metadata.appProperties.docKind === docKind)
          .map((file) => file.metadata),
      });
    }

    if (method === 'POST' && url.includes('/upload/drive/v3/files?')) {
      if (!(init?.body instanceof Blob)) throw new Error('Expected a multipart Drive upload.');
      const body = await blobText(init.body);
      const id = `concurrent-file-${this.nextFile++}`;
      const file = metadata({
        id,
        name: /"name":"([^"]+)"/u.exec(body)?.[1] ?? '',
        size: String(outgoingEnvelope.byteLength),
        headRevisionId: `concurrent-revision-${id}`,
        appProperties: {
          ownerDigest: /"ownerDigest":"([^"]+)"/u.exec(body)?.[1] ?? '',
          vaultDigest: /"vaultDigest":"([^"]+)"/u.exec(body)?.[1] ?? '',
          docKind: /"docKind":"([^"]+)"/u.exec(body)?.[1] ?? '',
          docVersion: /"docVersion":"([^"]+)"/u.exec(body)?.[1] ?? '',
          formatVersion: /"formatVersion":"([^"]+)"/u.exec(body)?.[1] ?? '',
        },
      });
      this.files.set(id, {
        metadata: file,
        envelope: outgoingEnvelope.slice(),
        parent: /"parents":\["([^"]+)"\]/u.exec(body)?.[1] ?? '',
      });
      return json(file);
    }

    if (method === 'POST' && url.includes('/drive/v3/files?fields=id')) {
      const id = `bettertrack-folder-${this.nextFolder++}`;
      this.folders.add(id);
      this.folderCreates.push(id);
      return json({ id });
    }

    const id = decodeURIComponent(/\/drive\/v3\/files\/([^?]+)/u.exec(url)?.[1] ?? '');
    if (method === 'DELETE') {
      this.folders.delete(id);
      this.folderDeletes.push(id);
      return new Response(null, { status: 204 });
    }
    const file = this.files.get(id);
    if (!file) return new Response(null, { status: 404 });
    if (url.includes('alt=media')) return new Response(file.envelope.slice(), { status: 200 });
    return json(file.metadata);
  }
}

class SharedPhysicalDrive {
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
      const selectedOwner = /key='ownerDigest' and value='([^']+)'/.exec(query)?.[1];
      return json({
        files: [...this.files.values()]
          .map((file) => file.metadata)
          .filter((file) => file.appProperties.ownerDigest === selectedOwner),
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
          ownerDigest: await driveOwnerDigest(
            name === (await driveVaultFileName(ACCOUNT_A)) ? ACCOUNT_A : ACCOUNT_B,
          ),
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

describe('Drive file DataHome', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
    accountFileName = await driveVaultFileName(ACCOUNT_A);
    accountOwnerDigest = await driveOwnerDigest(ACCOUNT_A);
  });

  it('reads by owner appProperties and validates them against opaque bytes', async () => {
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
    expect(fetch.mock.calls[0]![0]).toContain('ownerDigest');
    expect(fetch.mock.calls[0]![0]).not.toContain('name+%3D');
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get('Authorization')).toBe(
      'Bearer browser-memory-token',
    );
  });

  it('creates one multipart Drive file with version properties and no history clone', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ files: [] }))
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
    const body = fetch.mock.calls[2]![1]?.body;
    expect(body).toBeInstanceOf(Blob);
    const text = await blobText(body as Blob);
    expect(text).toContain('"parents":["visible-bettertrack-folder"]');
    expect(text).toContain(`"ownerDigest":"${accountOwnerDigest}"`);
    expect(text).toContain('"vaultVersion":"1"');
    expect(text).toContain('"formatVersion":"1"');
    expect(text).not.toContain('revisions');
  });

  it('isolates two BetterTrack accounts inside one shared physical Drive', async () => {
    const folder = new SharedPhysicalDrive();
    const homeA = createDriveDataHome({
      accountId: ACCOUNT_A,
      folderId: 'visible-bettertrack-folder',
      tokens: tokenSource(),
      fetch: folder.fetchFor(envelope),
    });
    const homeB = createDriveDataHome({
      accountId: ACCOUNT_B,
      folderId: 'visible-bettertrack-folder',
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

  it('uses the visible folder and digest-only envelope-v2 metadata, then survives renames', async () => {
    const bytes = await envelopeV2Doc(ACCOUNT_A, VAULT_A, DOC_A);
    const [ownerDigest, vaultDigest, fileName] = await Promise.all([
      driveOwnerDigest(ACCOUNT_A),
      driveVaultDigest(ACCOUNT_A, VAULT_A),
      driveVaultFileName(ACCOUNT_A, VAULT_A, DOC_A),
    ]);
    const driveFile = metadata({
      id: 'doc-file-id',
      name: fileName,
      size: String(bytes.byteLength),
      appProperties: {
        ownerDigest,
        vaultDigest,
        docKind: 'header',
        docVersion: '1',
        formatVersion: '2',
      },
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      // Initial lookup + the concurrent-create recheck.
      .mockResolvedValueOnce(json({ files: [] }))
      .mockResolvedValueOnce(json({ files: [] }))
      // Visible folder lookup, creation, and the post-create reconciliation
      // read that decides the winner of a concurrent create.
      .mockResolvedValueOnce(json({ files: [] }))
      .mockResolvedValueOnce(json({ id: 'bettertrack-folder' }))
      .mockResolvedValueOnce(json({ files: [{ id: 'bettertrack-folder' }] }))
      // Upload acknowledgement, appProperties confirmation scan/readback.
      .mockResolvedValueOnce(json(driveFile))
      .mockResolvedValueOnce(json({ files: [driveFile] }))
      .mockResolvedValueOnce(new Response(bytes.slice(), { status: 200 }))
      .mockResolvedValueOnce(new Response(bytes.slice(), { status: 200 }));
    const home = createDriveDataHome({
      accountId: ACCOUNT_A,
      vaultId: VAULT_A,
      docId: DOC_A,
      docKind: 'header',
      tokens: tokenSource(),
      fetch,
      boundary: () => 'v2-boundary',
    });

    await expect(home.write(bytes, { ifVersion: null })).resolves.toMatchObject({
      status: 'ok',
      info: { version: 1 },
    });

    const folderCreate = fetch.mock.calls.find(
      ([url, init]) => init?.method === 'POST' && String(url).includes('/drive/v3/files?fields=id'),
    );
    expect(JSON.parse(String(folderCreate?.[1]?.body))).toEqual({
      name: 'BetterTrack Vaults',
      mimeType: 'application/vnd.google-apps.folder',
      appProperties: { ownerDigest, folderMarker: 'bettertrack-vaults-v1' },
    });
    const upload = fetch.mock.calls.find(([url]) => String(url).includes('/upload/drive/v3/files'));
    const multipart = await blobText(upload?.[1]?.body as Blob);
    expect(multipart).toContain(`"name":"${fileName}"`);
    expect(multipart).toContain('"parents":["bettertrack-folder"]');
    expect(multipart).toContain(`"ownerDigest":"${ownerDigest}"`);
    expect(multipart).toContain(`"vaultDigest":"${vaultDigest}"`);
    expect(multipart).toContain('"docKind":"header"');
    expect(multipart).toContain('"docVersion":"1"');
    expect(multipart).not.toMatch(/email|vaultName|portfolio/i);
    expect(String(fetch.mock.calls[0]![0])).not.toContain(fileName);

    // A cached document read is metadata + exactly ONE body: the bytes the
    // address check downloads are the bytes the read returns.
    const renamed = { ...driveFile, name: 'owner-renamed-file.btenc' };
    const before = fetch.mock.calls.length;
    fetch
      .mockResolvedValueOnce(json(renamed))
      .mockResolvedValueOnce(new Response(bytes.slice(), { status: 200 }));
    await expect(home.read()).resolves.toMatchObject({ status: 'ok', info: { version: 1 } });
    expect(fetch.mock.calls.length - before).toBe(2);
    expect(String(fetch.mock.calls.at(-2)?.[0])).toContain('/files/doc-file-id?fields=');
    expect(String(fetch.mock.calls.at(-2)?.[0])).not.toContain(fileName);
    expect(String(fetch.mock.calls.at(-1)?.[0])).toContain('/files/doc-file-id?alt=media');
  });

  it('converges two concurrent first writes on one visible folder', async () => {
    const drive = new ConcurrentFolderDrive(2);
    const headerBytes = await envelopeV2Doc(ACCOUNT_A, VAULT_A, DOC_A, 1, 'header');
    const portfolioBytes = await envelopeV2Doc(ACCOUNT_A, VAULT_A, DOC_B, 1, 'portfolio');
    const home = (docId: string, docKind: VaultDocKind, bytes: Uint8Array) =>
      createDriveDataHome({
        accountId: ACCOUNT_A,
        vaultId: VAULT_A,
        docId,
        docKind,
        tokens: tokenSource(),
        fetch: drive.fetchFor(bytes),
        boundary: () => `concurrent-${docKind}-boundary`,
      });

    const [first, second] = await Promise.all([
      home(DOC_A, 'header', headerBytes).write(headerBytes, { ifVersion: null }),
      home(DOC_B, 'portfolio', portfolioBytes).write(portfolioBytes, { ifVersion: null }),
    ]);
    expect(first).toMatchObject({ status: 'ok', info: { version: 1 } });
    expect(second).toMatchObject({ status: 'ok', info: { version: 1 } });

    // The race really happened — two folders were POSTed…
    expect(drive.folderCreates).toEqual(['bettertrack-folder-1', 'bettertrack-folder-2']);
    // …and the owner is left with exactly one: the deterministic winner, with
    // the empty loser discarded by the home that created it.
    expect(drive.folderIds()).toEqual(['bettertrack-folder-1']);
    expect(drive.folderDeletes).toEqual(['bettertrack-folder-2']);

    // Both documents landed in the surviving folder, so nothing is stranded in
    // a folder that no later resolution will ever look at.
    expect(drive.fileParents()).toEqual(['bettertrack-folder-1', 'bettertrack-folder-1']);
  });

  it('reuses a renamed visible folder by appProperties instead of creating another', async () => {
    const bytes = await envelopeV2Doc(ACCOUNT_A, VAULT_A, DOC_B);
    const driveFile = metadata({
      id: 'second-doc-file',
      name: await driveVaultFileName(ACCOUNT_A, VAULT_A, DOC_B),
      size: String(bytes.byteLength),
      appProperties: {
        ownerDigest: await driveOwnerDigest(ACCOUNT_A),
        vaultDigest: await driveVaultDigest(ACCOUNT_A, VAULT_A),
        docKind: 'header',
        docVersion: '1',
        formatVersion: '2',
      },
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ files: [] }))
      .mockResolvedValueOnce(json({ files: [] }))
      .mockResolvedValueOnce(
        json({ files: [{ id: 'renamed-folder-id', name: 'My encrypted savings' }] }),
      )
      .mockResolvedValueOnce(json(driveFile))
      .mockResolvedValueOnce(json({ files: [driveFile] }))
      .mockResolvedValueOnce(new Response(bytes.slice(), { status: 200 }))
      .mockResolvedValueOnce(new Response(bytes.slice(), { status: 200 }));
    const home = createDriveDataHome({
      accountId: ACCOUNT_A,
      vaultId: VAULT_A,
      docId: DOC_B,
      docKind: 'header',
      tokens: tokenSource(),
      fetch,
      boundary: () => 'reused-folder-boundary',
    });

    await expect(home.write(bytes, { ifVersion: null })).resolves.toMatchObject({ status: 'ok' });

    const folderCreates = fetch.mock.calls.filter(
      ([url, init]) =>
        init?.method === 'POST' && String(url).includes('www.googleapis.com/drive/v3/files?'),
    );
    expect(folderCreates).toHaveLength(0);
    const upload = fetch.mock.calls.find(([url]) => String(url).includes('/upload/drive/v3/files'));
    expect(await blobText(upload?.[1]?.body as Blob)).toContain('"parents":["renamed-folder-id"]');
  });

  it('makes names collision-safe and refuses a foreign owner before any update', async () => {
    const [accountName, vaultName, docName, otherAccountName] = await Promise.all([
      driveVaultFileName(ACCOUNT_A, VAULT_A, DOC_A),
      driveVaultFileName(ACCOUNT_A, VAULT_B, DOC_A),
      driveVaultFileName(ACCOUNT_A, VAULT_A, DOC_B),
      driveVaultFileName(ACCOUNT_B, VAULT_A, DOC_A),
    ]);
    expect(accountName).toBe('bettertrack-vault-OEUtAU-s8kLWD_WshBFsy2_K9pK0l0kh7QtQ82VJKvU.btenc');
    await expect(driveOwnerDigest(ACCOUNT_A)).resolves.toBe(
      '0bzuQKYPonJTktDBgjmKTlMpk5PGw92OZL4ZuGIH55A',
    );
    expect(new Set([accountName, vaultName, docName, otherAccountName]).size).toBe(4);
    for (const name of [accountName, vaultName, docName, otherAccountName]) {
      expect(name).not.toMatch(new RegExp(`${ACCOUNT_A}|${ACCOUNT_B}|${VAULT_A}|${DOC_A}`));
    }

    const bytes = await envelopeV2Doc(ACCOUNT_A, VAULT_A, DOC_A, 2);
    const foreign = metadata({
      id: 'foreign-file',
      name: 'maliciously-renamed.btenc',
      size: String(bytes.byteLength),
      appProperties: {
        ownerDigest: await driveOwnerDigest(ACCOUNT_B),
        vaultDigest: await driveVaultDigest(ACCOUNT_A, VAULT_A),
        docKind: 'header',
        docVersion: '1',
        formatVersion: '2',
      },
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ files: [foreign] }));
    const home = createDriveDataHome({
      accountId: ACCOUNT_A,
      vaultId: VAULT_A,
      docId: DOC_A,
      docKind: 'header',
      tokens: tokenSource(),
      fetch,
      folderId: 'unused-folder',
    });

    await expect(home.write(bytes, { ifVersion: 1 })).resolves.toMatchObject({
      status: 'corrupt',
      reason: 'malformed-metadata',
    });
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  });

  it('does not expose a copied foreign document even when its selectors are forged', async () => {
    const foreignBytes = await envelopeV2Doc(ACCOUNT_B, VAULT_A, DOC_A);
    const copied = metadata({
      id: 'copied-foreign-file',
      name: 'harmless-looking-copy.btenc',
      size: String(foreignBytes.byteLength),
      appProperties: {
        ownerDigest: await driveOwnerDigest(ACCOUNT_A),
        vaultDigest: await driveVaultDigest(ACCOUNT_A, VAULT_A),
        docKind: 'header',
        docVersion: '1',
        formatVersion: '2',
      },
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ files: [copied] }))
      .mockResolvedValueOnce(new Response(foreignBytes.slice(), { status: 200 }));
    const home = createDriveDataHome({
      accountId: ACCOUNT_A,
      vaultId: VAULT_A,
      docId: DOC_A,
      docKind: 'header',
      tokens: tokenSource(),
      fetch,
      folderId: 'irrelevant-folder',
    });

    await expect(home.read()).resolves.toEqual({ status: 'absent', medium: 'drive' });
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
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

  it('treats a trashed Drive copy as missing on the cached path, not as a live read', async () => {
    const live = metadata();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      // A first read warms the cached file id from the list query.
      .mockResolvedValueOnce(json({ files: [live] }))
      .mockResolvedValueOnce(new Response(envelope.slice(), { status: 200 }))
      // The owner drags the visible file into the Drive trash; files.get and
      // ?alt=media both keep answering for it, the list query does not.
      .mockResolvedValueOnce(json({ ...live, trashed: true }))
      .mockResolvedValueOnce(json({ files: [] }))
      .mockResolvedValueOnce(json({ files: [] }));
    const home = createTestDriveDataHome({ tokens: tokenSource(), fetch });

    await expect(home.read()).resolves.toMatchObject({ status: 'ok', info: { version: 1 } });
    await expect(home.read()).resolves.toEqual({ status: 'absent', medium: 'drive' });
    await expect(home.write(envelopeV2, { ifVersion: 1 })).resolves.toEqual({
      status: 'conflict',
      medium: 'drive',
      currentVersion: null,
    });
    expect(String(fetch.mock.calls[2]![0])).toContain('trashed');
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  });

  it('refuses to patch a file that reached the trash between the list and the CAS refresh', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ files: [metadata()] }))
      .mockResolvedValueOnce(json({ ...metadata(), trashed: true }));
    const home = createTestDriveDataHome({ tokens: tokenSource(), fetch });

    await expect(home.write(envelopeV2, { ifVersion: 1 })).resolves.toEqual({
      status: 'conflict',
      medium: 'drive',
      currentVersion: null,
    });
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  });

  it('falls through to the list query when the cached metadata request blips', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ files: [metadata()] }))
      .mockResolvedValueOnce(new Response(envelope.slice(), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(json({ files: [metadata()] }))
      .mockResolvedValueOnce(new Response(envelope.slice(), { status: 200 }));
    const home = createTestDriveDataHome({ tokens: tokenSource(), fetch });

    await expect(home.read()).resolves.toMatchObject({ status: 'ok' });
    await expect(home.read()).resolves.toMatchObject({ status: 'ok', info: { version: 1 } });
    expect(String(fetch.mock.calls[3]![0])).toContain('/drive/v3/files?');
  });

  it('paginates an address with more than 100 documents without reading the target as absent', async () => {
    const docIds = [
      ...Array.from(
        { length: 100 },
        (_, index) => `018f0000-0000-7000-8000-${String(index + 300).padStart(12, '0')}`,
      ),
      DOC_A,
    ];
    const documents = await Promise.all(
      docIds.map(async (docId, index) => {
        const bytes = await envelopeV2Doc(ACCOUNT_A, VAULT_A, docId, 1, 'portfolio');
        return {
          bytes,
          file: metadata({
            id: `paged-drive-file-${index}`,
            size: String(bytes.byteLength),
            headRevisionId: `paged-revision-${index}`,
            appProperties: {
              ownerDigest: await driveOwnerDigest(ACCOUNT_A),
              vaultDigest: await driveVaultDigest(ACCOUNT_A, VAULT_A),
              docKind: 'portfolio',
              docVersion: '1',
              formatVersion: '2',
            },
          }),
        };
      }),
    );
    const bodies = new Map(documents.map(({ bytes, file }) => [file.id, bytes] as const));
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/drive/v3/files')) {
        return url.searchParams.get('pageToken') === 'page-2'
          ? json({ files: documents.slice(100).map(({ file }) => file) })
          : json({
              files: documents.slice(0, 100).map(({ file }) => file),
              nextPageToken: 'page-2',
            });
      }
      const fileId = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
      const bytes = bodies.get(fileId);
      return bytes
        ? new Response(bytes.slice(), { status: 200 })
        : new Response(null, { status: 404 });
    });
    const home = createDriveDataHome({
      accountId: ACCOUNT_A,
      vaultId: VAULT_A,
      docId: DOC_A,
      docKind: 'portfolio',
      tokens: tokenSource(),
      fetch,
      folderId: 'visible-bettertrack-folder',
    });

    const read = await home.read();
    expect(read).toMatchObject({ status: 'ok', info: { version: 1 } });
    if (read.status === 'ok') expect(read.envelope).toEqual(documents.at(-1)!.bytes);
    const listCalls = fetch.mock.calls.filter(([input]) =>
      new URL(String(input)).pathname.endsWith('/drive/v3/files'),
    );
    expect(listCalls).toHaveLength(2);
    expect(
      listCalls.map(([input]) => new URL(String(input)).searchParams.get('pageToken')),
    ).toEqual([null, 'page-2']);
    // Pagination works only if the partial-response mask explicitly asks for
    // the token; Drive omits it from `fields=files(...)` responses.
    const mask = new URL(String(listCalls[0]![0])).searchParams.get('fields');
    expect(mask?.startsWith('nextPageToken,files(')).toBe(true);
    expect(new URL(String(listCalls[0]![0])).searchParams.get('pageSize')).toBe('100');
  });

  it('re-resolves the visible folder after a create fails against the cached one', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      // First create: lookup, concurrent-create recheck, then a dead parent.
      .mockResolvedValueOnce(json({ files: [] }))
      .mockResolvedValueOnce(json({ files: [] }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      // Retry: lookup, recheck, folder re-resolution, upload, confirm, readback.
      .mockResolvedValueOnce(json({ files: [] }))
      .mockResolvedValueOnce(json({ files: [] }))
      .mockResolvedValueOnce(json({ files: [{ id: 'fresh-folder-id' }] }))
      .mockResolvedValueOnce(json(metadata()))
      .mockResolvedValueOnce(json({ files: [metadata()] }))
      .mockResolvedValueOnce(new Response(envelope.slice(), { status: 200 }));
    const home = createTestDriveDataHome({
      tokens: tokenSource(),
      fetch,
      boundary: () => 'retry-boundary',
    });

    await expect(home.write(envelope, { ifVersion: null })).resolves.toMatchObject({
      status: 'transport-failure',
    });
    await expect(home.write(envelope, { ifVersion: null })).resolves.toMatchObject({
      status: 'ok',
    });

    const uploads = fetch.mock.calls.filter(([url]) =>
      String(url).includes('/upload/drive/v3/files'),
    );
    expect(await blobText(uploads[0]![1]?.body as Blob)).toContain(
      '"parents":["visible-bettertrack-folder"]',
    );
    expect(await blobText(uploads[1]![1]?.body as Blob)).toContain('"parents":["fresh-folder-id"]');
  });

  it('keeps consent, expiry, offline, missing, malformed, corrupt, and API states distinct', async () => {
    const consent = createTestDriveDataHome({
      tokens: {
        getAccessToken: () => ({ status: 'consent-required', message: 'consent' }),
        markExpired: vi.fn(),
        markRevoked: vi.fn(),
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
        markRevoked: vi.fn(),
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

    const revokedTokens = tokenSource();
    const revoked = createTestDriveDataHome({
      tokens: revokedTokens,
      fetch: vi
        .fn()
        .mockResolvedValue(
          json({ error: 'invalid_grant', error_description: 'authorization revoked' }, 400),
        ),
    });
    await expect(revoked.read()).resolves.toMatchObject({
      status: 'transport-failure',
      failure: { code: 'revoked' },
    });
    expect(revokedTokens.markRevoked).toHaveBeenCalledTimes(1);

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
