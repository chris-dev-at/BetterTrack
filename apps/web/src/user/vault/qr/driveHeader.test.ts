import { describe, expect, it, vi } from 'vitest';

import {
  encodeVaultDocEnvelope,
  VAULT_CONTENT_CIPHER,
  VAULT_DOC_FORMAT_VERSION,
  VAULT_DOC_SCHEMA_VERSION,
  VAULT_KEY_SLOT_SEED_V1,
  type DriveConnection,
} from '@bettertrack/contracts';

import { deriveAccountBinding } from '../keys/keyCore';
import type { GoogleDriveTokenClient } from '../drive/gisTokenClient';
import { createVaultDriveHeaderReader } from './driveHeader';

const ACCOUNT_ID = '018f6a3e-0000-7000-8000-00000000aaaa';
const VAULT_ID = '018f6a3e-1111-7000-8000-000000000001';
const DOC_ID = '018f6a3e-2222-7000-8000-000000000001';
const KEY_ID = '018f6a3e-3333-7000-8000-000000000001';
const DEVICE_ID = '018f6a3e-4444-7000-8000-000000000001';
const WRITE_ID = '018f6a3e-5555-7000-8000-000000000001';

const CONNECTION: DriveConnection = {
  id: '018f6a3e-6666-7000-8000-000000000001',
  googleSub: 'bound-google-permission-id',
  email: 'vault-owner@example.test',
  displayName: 'Vault owner',
  createdAt: '2026-08-20T12:00:00.000Z',
  lastVerifiedAt: '2026-08-20T12:00:00.000Z',
};

describe('connection-bound Drive header reader', () => {
  it('proves the bound Google identity and returns the exact envelope-v2 header doc', async () => {
    const envelope = await headerEnvelope();
    const [ownerDigest, vaultDigest] = await Promise.all([
      digest(`bettertrack-drive-owner-v1:${ACCOUNT_ID}`),
      digest(`bettertrack-drive-vault-id-v1:${ACCOUNT_ID}:${VAULT_ID}`),
    ]);
    const client = tokenClient();
    const request = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes('/about?')) {
        return Response.json({ user: { permissionId: CONNECTION.googleSub } });
      }
      if (url.includes('/files?')) {
        return Response.json({
          files: [
            {
              id: 'drive-file-id',
              trashed: false,
              appProperties: {
                ownerDigest,
                vaultDigest,
                docKind: 'header',
                formatVersion: String(VAULT_DOC_FORMAT_VERSION),
                docVersion: '1',
              },
            },
          ],
        });
      }
      if (url.endsWith('/files/drive-file-id?alt=media')) {
        return new Response(envelope.slice());
      }
      throw new Error(`Unexpected Drive URL: ${url}`);
    });
    const createClient = vi.fn(() => client);
    const reader = createVaultDriveHeaderReader({
      clientId: 'browser-client-id',
      fetch: request as typeof globalThis.fetch,
      tokenClient: createClient,
    });

    await expect(
      reader.readHeader({
        accountId: ACCOUNT_ID,
        connection: CONNECTION,
        vaultId: VAULT_ID,
        docId: DOC_ID,
      }),
    ).resolves.toEqual(envelope);

    expect(createClient).toHaveBeenCalledWith(CONNECTION);
    expect(request).toHaveBeenCalledTimes(3);
    expect(client.authorize).not.toHaveBeenCalled();
  });

  it('rejects a capability for a different Google principal', async () => {
    const client = tokenClient();
    const reader = createVaultDriveHeaderReader({
      clientId: 'browser-client-id',
      tokenClient: () => client,
      fetch: vi.fn(async () =>
        Response.json({ user: { permissionId: 'different-google-permission-id' } }),
      ) as typeof globalThis.fetch,
    });

    await expect(
      reader.readHeader({
        accountId: ACCOUNT_ID,
        connection: CONNECTION,
        vaultId: VAULT_ID,
        docId: DOC_ID,
      }),
    ).rejects.toThrow(`Sign in to Google (${CONNECTION.email})`);
    expect(client.clear).toHaveBeenCalledOnce();
  });
});

function tokenClient(): GoogleDriveTokenClient {
  return {
    state: 'connected',
    getAccessToken: vi.fn(() => ({
      status: 'ok' as const,
      accessToken: 'memory-only-token',
      expiresAt: Date.now() + 60_000,
    })),
    subscribe: vi.fn(() => () => undefined),
    prepare: vi.fn(async () => undefined),
    authorize: vi.fn(),
    identify: vi.fn(),
    clear: vi.fn(),
    markExpired: vi.fn(),
    markRevoked: vi.fn(),
  };
}

async function headerEnvelope(): Promise<Uint8Array> {
  return encodeVaultDocEnvelope(
    {
      formatVersion: VAULT_DOC_FORMAT_VERSION,
      cipher: VAULT_CONTENT_CIPHER,
      iv: 'AA',
      keyId: KEY_ID,
      keySlots: [{ keyId: KEY_ID, slot: VAULT_KEY_SLOT_SEED_V1, wrappedKc: 'AA' }],
      vaultId: VAULT_ID,
      docId: DOC_ID,
      docKind: 'header',
      accountBinding: await deriveAccountBinding(ACCOUNT_ID),
      docVersion: 1,
      schemaVersion: VAULT_DOC_SCHEMA_VERSION,
      deviceId: DEVICE_ID,
      writeId: WRITE_ID,
      writtenAt: '2026-08-20T12:00:00.000Z',
    },
    new Uint8Array([1, 2, 3]),
  );
}

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}
