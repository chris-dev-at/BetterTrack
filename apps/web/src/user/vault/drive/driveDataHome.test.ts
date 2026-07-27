import { beforeEach, describe, expect, it, vi } from 'vitest';

import { base64ToBytes } from '../bytes';
import { decodeVaultEnvelope, encodeVaultEnvelope } from '../envelope';
import { vaultInteroperabilityFixture } from '../vectors';
import { createDriveDataHome, DRIVE_VAULT_FILE_NAME } from './driveDataHome';

const envelope = base64ToBytes(
  vaultInteroperabilityFixture.initial.envelopeBase64,
  'envelope-invalid',
);
const decoded = decodeVaultEnvelope(envelope);
const envelopeV2 = encodeVaultEnvelope({ ...decoded.header, vaultVersion: 2 }, decoded.ciphertext);

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
    name: DRIVE_VAULT_FILE_NAME,
    size: String(envelope.byteLength),
    modifiedTime: '2026-07-27T10:00:00.000Z',
    headRevisionId: 'revision-1',
    appProperties: { vaultVersion: '1', formatVersion: '1' },
    ...overrides,
  };
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

describe('Drive appdata DataHome', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('reads one appDataFolder file and validates app properties against opaque bytes', async () => {
    const tokens = tokenSource();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ files: [metadata()] }))
      .mockResolvedValueOnce(new Response(envelope.slice(), { status: 200 }));
    const home = createDriveDataHome({ tokens, fetch });

    const result = await home.read();
    expect(result).toMatchObject({
      status: 'ok',
      medium: 'drive',
      info: { version: 1, sizeBytes: envelope.byteLength },
    });
    if (result.status === 'ok') expect(result.envelope).toEqual(envelope);
    expect(fetch.mock.calls[0]![0]).toContain('spaces=appDataFolder');
    expect(fetch.mock.calls[0]![0]).toContain('appDataFolder');
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get('Authorization')).toBe(
      'Bearer browser-memory-token',
    );
  });

  it('creates one multipart appdata file with version properties and no history clone', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ files: [] }))
      .mockResolvedValueOnce(json(metadata()));
    const home = createDriveDataHome({
      tokens: tokenSource(),
      fetch,
      boundary: () => 'fixed-boundary',
    });

    await expect(home.write(envelope, { ifVersion: null })).resolves.toMatchObject({
      status: 'ok',
      info: { version: 1 },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]![0]).toContain('uploadType=multipart');
    expect(fetch.mock.calls[1]![1]?.method).toBe('POST');
    const body = fetch.mock.calls[1]![1]?.body;
    expect(body).toBeInstanceOf(Blob);
    const text = await blobText(body as Blob);
    expect(text).toContain('"parents":["appDataFolder"]');
    expect(text).toContain('"vaultVersion":"1"');
    expect(text).toContain('"formatVersion":"1"');
    expect(text).not.toContain('revisions');
  });

  it('detects a revision move before update and returns a mergeable CAS conflict', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ files: [metadata()] }))
      .mockResolvedValueOnce(json(metadata({ headRevisionId: 'revision-2' })));
    const home = createDriveDataHome({ tokens: tokenSource(), fetch });

    await expect(home.write(envelopeV2, { ifVersion: 1 })).resolves.toEqual({
      status: 'conflict',
      medium: 'drive',
      currentVersion: 1,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps consent, expiry, offline, malformed metadata and corrupt bytes typed', async () => {
    const consent = createDriveDataHome({
      tokens: {
        getAccessToken: () => ({
          status: 'consent-required',
          message: 'consent',
        }),
        markExpired: vi.fn(),
      },
      fetch: vi.fn(),
    });
    await expect(consent.read()).resolves.toMatchObject({
      status: 'transport-failure',
      failure: { code: 'consent-required' },
    });
    const gesture = createDriveDataHome({
      tokens: {
        getAccessToken: () => ({
          status: 'gesture-required',
          message: 'gesture',
        }),
        markExpired: vi.fn(),
      },
      fetch: vi.fn(),
    });
    await expect(gesture.read()).resolves.toMatchObject({
      status: 'transport-failure',
      failure: { code: 'gesture-required' },
    });

    const offline = createDriveDataHome({
      tokens: tokenSource(),
      fetch: vi.fn(),
      isOnline: () => false,
    });
    await expect(offline.read()).resolves.toMatchObject({
      status: 'transport-failure',
      failure: { code: 'offline' },
    });

    const missing = createDriveDataHome({
      tokens: tokenSource(),
      fetch: vi.fn().mockResolvedValue(json({ files: [] })),
    });
    await expect(missing.read()).resolves.toEqual({ status: 'absent', medium: 'drive' });

    const malformed = createDriveDataHome({
      tokens: tokenSource(),
      fetch: vi.fn().mockResolvedValue(json({ files: [metadata({ headRevisionId: '' })] })),
    });
    await expect(malformed.info()).resolves.toMatchObject({
      status: 'corrupt',
      reason: 'malformed-metadata',
    });

    const corrupt = createDriveDataHome({
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
    const expired = createDriveDataHome({
      tokens,
      fetch: vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
    });
    await expect(expired.read()).resolves.toMatchObject({
      status: 'transport-failure',
      failure: { code: 'token-expired' },
    });
    expect(tokens.markExpired).toHaveBeenCalled();

    const apiFailure = createDriveDataHome({
      tokens: tokenSource(),
      fetch: vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
    });
    await expect(apiFailure.read()).resolves.toMatchObject({
      status: 'transport-failure',
      failure: { code: 'api-failure', httpStatus: 503 },
    });
  });
});
