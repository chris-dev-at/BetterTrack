import {
  inspectVaultDocEnvelope,
  VAULT_ACCOUNT_BINDING_INFO_PREFIX,
  VAULT_DOC_FORMAT_VERSION,
  type DriveConnection,
} from '@bettertrack/contracts';

import { createGoogleDriveTokenClient, type GoogleDriveTokenClient } from '../drive/gisTokenClient';
import { driveTokenClientIdentity } from '../media/driveConnectionRegistry';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_OWNER_CONTEXT = 'bettertrack-drive-owner-v1:';
const DRIVE_VAULT_DIGEST_CONTEXT = 'bettertrack-drive-vault-id-v1:';
const DRIVE_SCAN_LIMIT = '100';

interface DriveFileProjection {
  id?: unknown;
  trashed?: unknown;
  appProperties?: unknown;
}

export interface VaultDriveHeaderRequest {
  accountId: string;
  connection: DriveConnection;
  vaultId: string;
  docId: string;
  signal?: AbortSignal;
}

export interface VaultDriveHeaderReader {
  readHeader(request: VaultDriveHeaderRequest): Promise<Uint8Array>;
  /** Drops every browser-memory Drive capability synchronously. */
  clear(): void;
}

export interface CreateVaultDriveHeaderReaderOptions {
  clientId: string;
  fetch?: typeof globalThis.fetch;
  tokenClient?: (connection: DriveConnection) => GoogleDriveTokenClient;
}

/**
 * Narrow E7 read adapter for E5's connection-bound, visible-folder documents.
 * It never receives or persists a refresh token or file id. Each read proves
 * that the GIS capability still names the server-bound Google principal, then
 * selects the exact authenticated envelope-v2 header from opaque digest tags.
 */
export function createVaultDriveHeaderReader(
  options: CreateVaultDriveHeaderReaderOptions,
): VaultDriveHeaderReader {
  const request = options.fetch ?? globalThis.fetch;
  const clients = new Map<string, { googleSub: string; client: GoogleDriveTokenClient }>();

  function clientFor(connection: DriveConnection): GoogleDriveTokenClient {
    const current = clients.get(connection.id);
    if (current?.googleSub === connection.googleSub) return current.client;
    current?.client.clear();
    const client =
      options.tokenClient?.(connection) ??
      createGoogleDriveTokenClient({
        clientId: options.clientId,
        ...driveTokenClientIdentity(connection),
      });
    clients.set(connection.id, { googleSub: connection.googleSub, client });
    return client;
  }

  return {
    async readHeader({ accountId, connection, vaultId, docId, signal }) {
      assertNotAborted(signal);
      if (options.clientId.trim() === '' && options.tokenClient == null) {
        throw new Error('Google Drive is not configured for this deployment.');
      }

      const client = clientFor(connection);
      let access = client.getAccessToken();
      if (access.status !== 'ok') access = await client.authorize();
      if (access.status !== 'ok') throw new Error(access.message);
      assertNotAborted(signal);

      await verifyBoundIdentity(client, connection, access.accessToken, signal);
      const [ownerDigest, vaultDigest, accountBinding] = await Promise.all([
        sha256Base64Url(`${DRIVE_OWNER_CONTEXT}${accountId}`),
        sha256Base64Url(`${DRIVE_VAULT_DIGEST_CONTEXT}${accountId}:${vaultId}`),
        sha256Base64Url(`${VAULT_ACCOUNT_BINDING_INFO_PREFIX}${accountId}`),
      ]);
      assertNotAborted(signal);

      const query = [
        propertyFilter('ownerDigest', ownerDigest),
        propertyFilter('formatVersion', String(VAULT_DOC_FORMAT_VERSION)),
        propertyFilter('vaultDigest', vaultDigest),
        propertyFilter('docKind', 'header'),
        'trashed = false',
      ].join(' and ');
      const params = new URLSearchParams({
        q: query,
        pageSize: DRIVE_SCAN_LIMIT,
        fields: 'nextPageToken,files(id,trashed,appProperties)',
      });
      const listed = await driveFetch(
        `${DRIVE_API}/files?${params.toString()}`,
        client,
        access.accessToken,
        signal,
      );
      const payload = await parseJson(listed, 'Google Drive returned invalid vault metadata.');
      const nextPageToken = objectValue(payload, 'nextPageToken');
      if (typeof nextPageToken === 'string' && nextPageToken.length > 0) {
        throw new Error(`Google Drive returned more than ${DRIVE_SCAN_LIMIT} header candidates.`);
      }
      const files = objectValue(payload, 'files');
      if (!Array.isArray(files)) throw new Error('Google Drive returned invalid vault metadata.');

      const matches: Array<{ envelope: Uint8Array; version: number; id: string }> = [];
      for (const value of files) {
        assertNotAborted(signal);
        const file = asDriveFile(value);
        if (file == null || file.trashed === true) continue;
        const properties = asStringRecord(file.appProperties);
        if (
          properties == null ||
          properties.ownerDigest !== ownerDigest ||
          properties.vaultDigest !== vaultDigest ||
          properties.docKind !== 'header' ||
          properties.formatVersion !== String(VAULT_DOC_FORMAT_VERSION)
        ) {
          continue;
        }
        const metadataVersion = Number(properties.docVersion);
        if (!Number.isInteger(metadataVersion) || metadataVersion < 1) continue;

        const downloaded = await driveFetch(
          `${DRIVE_API}/files/${encodeURIComponent(file.id)}?alt=media`,
          client,
          access.accessToken,
          signal,
        );
        const envelope = new Uint8Array(await downloaded.arrayBuffer());
        assertNotAborted(signal);
        try {
          const inspected = inspectVaultDocEnvelope(envelope);
          if (
            inspected.status === 'supported' &&
            inspected.header.accountBinding === accountBinding &&
            inspected.header.vaultId === vaultId &&
            inspected.header.docId === docId &&
            inspected.header.docKind === 'header' &&
            inspected.header.docVersion === metadataVersion
          ) {
            matches.push({ envelope, version: metadataVersion, id: file.id });
          }
        } catch {
          // The digest tags deliberately group same-kind docs. Only an exact,
          // authenticated header match belongs to this resolver invocation.
        }
      }

      matches.sort(
        (left, right) => right.version - left.version || left.id.localeCompare(right.id),
      );
      const selected = matches[0];
      if (selected == null) throw new Error('No reachable Google Drive vault header was found.');
      return selected.envelope.slice();
    },

    clear() {
      for (const { client } of clients.values()) client.clear();
      clients.clear();
    },
  };

  async function verifyBoundIdentity(
    client: GoogleDriveTokenClient,
    connection: DriveConnection,
    accessToken: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const response = await driveFetch(
      `${DRIVE_API}/about?fields=user(permissionId,emailAddress)`,
      client,
      accessToken,
      signal,
    );
    const payload = await parseJson(response, 'Google Drive returned invalid identity data.');
    const user = objectValue(payload, 'user');
    const permissionId = objectValue(user, 'permissionId');
    if (permissionId !== connection.googleSub) {
      client.clear();
      throw new Error(`Sign in to Google (${connection.email}) to open this vault.`);
    }
  }

  async function driveFetch(
    url: string,
    client: GoogleDriveTokenClient,
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    assertNotAborted(signal);
    const response = await request(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal,
    });
    if (response.status === 401) client.markExpired();
    if (!response.ok)
      throw new Error(`Google Drive request failed with status ${response.status}.`);
    return response;
  }
}

function asDriveFile(
  value: unknown,
): { id: string; trashed: boolean; appProperties: unknown } | null {
  if (typeof value !== 'object' || value === null) return null;
  const file = value as DriveFileProjection;
  if (typeof file.id !== 'string' || file.id.length === 0) return null;
  return { id: file.id, trashed: file.trashed === true, appProperties: file.appProperties };
}

function asStringRecord(value: unknown): Record<string, string> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  return entries.every(([, item]) => typeof item === 'string') ? Object.fromEntries(entries) : null;
}

function objectValue(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : null;
}

async function parseJson(response: Response, message: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(message);
  }
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function propertyFilter(key: string, value: string): string {
  return `appProperties has { key='${key}' and value='${value}' }`;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The vault header request was canceled.', 'AbortError');
}
