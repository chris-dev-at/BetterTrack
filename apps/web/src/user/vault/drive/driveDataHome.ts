import { VAULT_FORMAT_VERSION } from '@bettertrack/contracts';

import { equalBytes } from '../bytes';
import type {
  DataHome,
  DataHomeCorruptCandidate,
  DataHomeInfo,
  DataHomeInfoResult,
  DataHomeReadResult,
  DataHomeTransportFailure,
  DataHomeWriteOptions,
  DataHomeWriteResult,
} from '../dataHome';
import { inspectVaultEnvelope } from '../envelope';
import type {
  DriveAccessTokenResult,
  DriveTokenUnavailableReason,
  GoogleDriveTokenClient,
} from './tokenClient';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const DUPLICATE_RECOVERY_ATTEMPTS = 4;
export const DRIVE_VAULT_FILE_NAME = 'bettertrack-vault.bin';

interface DriveFileMetadata {
  id: string;
  version: number;
  formatVersion: number;
  headRevisionId: string;
  modifiedTime: string | null;
  sizeBytes: number;
}

type MetadataResult =
  | { status: 'ok'; file: DriveFileMetadata }
  | { status: 'absent' }
  | Extract<DataHomeInfoResult, { status: 'corrupt' | 'transport-failure' }>;

type ListedFilesResult =
  | { status: 'ok'; files: DriveFileMetadata[] }
  | Extract<DataHomeInfoResult, { status: 'corrupt' | 'transport-failure' }>;

type DuplicateRecoveryResult = MetadataResult | { status: 'retry' };

export interface DriveDuplicateCandidate {
  envelope: Uint8Array;
  info: DataHomeInfo;
}

export type DriveDuplicateResolver = (
  candidates: readonly DriveDuplicateCandidate[],
) => Promise<{ envelope: Uint8Array; version: number }>;

export type DriveDataHomeDeleteResult =
  | { status: 'ok'; medium: 'drive' }
  | { status: 'absent'; medium: 'drive' }
  | Extract<DataHomeInfoResult, { status: 'corrupt' | 'transport-failure' }>;

export interface DriveDataHome extends DataHome {
  readonly medium: 'drive';
  /** Best-effort cleanup used only after server-only is already durable. */
  delete(): Promise<DriveDataHomeDeleteResult>;
}

export interface DriveDataHomeOptions {
  tokens: Pick<GoogleDriveTokenClient, 'token' | 'invalidate'>;
  fetch?: typeof fetch;
  boundary?: () => string;
  /**
   * Unlocked, authentication-aware resolver. The adapter invokes it before
   * consolidating files created by an absent-file race on two owner devices.
   */
  resolveDuplicates?: DriveDuplicateResolver;
}

/**
 * One-file Google Drive app-data `DataHome`. File ids and bearer credentials
 * are contained here and are never returned in DataHome metadata.
 */
export function createDriveDataHome(options: DriveDataHomeOptions): DriveDataHome {
  const request = options.fetch ?? globalThis.fetch;
  const boundary = options.boundary ?? (() => `bettertrack-${crypto.randomUUID()}`);

  async function authorizedFetch(
    url: string,
    init: RequestInit = {},
  ): Promise<
    { status: 'ok'; response: Response } | { status: 'failure'; failure: DataHomeTransportFailure }
  > {
    const token = await options.tokens.token();
    if (token.status !== 'ok') {
      return { status: 'failure', failure: tokenFailure(token) };
    }
    try {
      const response = await request(url, {
        ...init,
        headers: {
          ...headersObject(init.headers),
          Authorization: `Bearer ${token.accessToken}`,
        },
      });
      if (response.status === 401) {
        options.tokens.invalidate();
        return {
          status: 'failure',
          failure: {
            kind: 'token-expired',
            httpStatus: 401,
            message: 'Google Drive rejected the expired access token.',
          },
        };
      }
      return { status: 'ok', response };
    } catch (cause) {
      return {
        status: 'failure',
        failure: {
          kind: globalThis.navigator?.onLine === false ? 'offline' : 'api-failure',
          message:
            globalThis.navigator?.onLine === false
              ? 'Google Drive is unavailable while offline.'
              : 'Google Drive could not be reached.',
          cause,
          indeterminate: init.method === 'PATCH' || init.method === 'POST',
        },
      };
    }
  }

  async function listFiles(): Promise<ListedFilesResult> {
    const params = new URLSearchParams({
      spaces: 'appDataFolder',
      q: `name = '${DRIVE_VAULT_FILE_NAME}' and trashed = false`,
      fields: 'nextPageToken,files(id,name,appProperties,headRevisionId,modifiedTime,size)',
      pageSize: '1000',
    });
    const fetched = await authorizedFetch(`${DRIVE_API}/files?${params}`);
    if (fetched.status === 'failure') return transport(fetched.failure);
    if (!fetched.response.ok)
      return apiFailure('Google Drive file lookup failed.', fetched.response);

    let payload: unknown;
    try {
      payload = await fetched.response.json();
    } catch (cause) {
      return corrupt(
        undefined,
        null,
        'malformed-metadata',
        'Google Drive returned malformed file metadata.',
        cause,
      );
    }
    if (!isRecord(payload) || !Array.isArray(payload.files)) {
      return corrupt(
        undefined,
        null,
        'malformed-metadata',
        'Google Drive returned malformed file metadata.',
      );
    }
    if (typeof payload.nextPageToken === 'string' && payload.nextPageToken.length > 0) {
      return corrupt(
        undefined,
        null,
        'malformed-metadata',
        'Google Drive contains too many BetterTrack vault files to recover safely.',
      );
    }

    const files: DriveFileMetadata[] = [];
    for (const value of payload.files) {
      const parsed = parseMetadata(value);
      if (parsed.status !== 'ok') {
        return parsed.status === 'absent'
          ? corrupt(
              undefined,
              null,
              'malformed-metadata',
              'Google Drive returned an empty vault file entry.',
            )
          : parsed;
      }
      files.push(parsed.file);
    }
    files.sort((left, right) => left.id.localeCompare(right.id));
    return { status: 'ok', files };
  }

  async function listMetadata(): Promise<MetadataResult> {
    for (let attempt = 0; attempt < DUPLICATE_RECOVERY_ATTEMPTS; attempt += 1) {
      const listed = await listFiles();
      if (listed.status !== 'ok') return listed;
      if (listed.files.length === 0) return { status: 'absent' };
      if (listed.files.length === 1) return { status: 'ok', file: listed.files[0]! };

      const recovered = await recoverDuplicates(listed.files);
      if (recovered.status !== 'retry') return recovered;
    }
    return transport({
      kind: 'api-failure',
      message: 'Google Drive vault files kept changing during duplicate recovery.',
    });
  }

  async function recoverDuplicates(
    initialFiles: readonly DriveFileMetadata[],
  ): Promise<DuplicateRecoveryResult> {
    const readable: {
      file: DriveFileMetadata;
      read: Extract<DataHomeReadResult, { status: 'ok' }>;
    }[] = [];
    for (const file of initialFiles) {
      const read = await readFile(file);
      if (read.status === 'absent') return { status: 'retry' };
      if (read.status !== 'ok') return read;
      readable.push({ file, read });
    }

    let resolved = {
      envelope: readable[0]!.read.envelope.slice(),
      version: readable[0]!.read.info.version,
    };
    if (!readable.every(({ read }) => equalBytes(read.envelope, resolved.envelope))) {
      if (!options.resolveDuplicates) {
        return corrupt(
          undefined,
          Math.max(...readable.map(({ read }) => read.info.version)),
          'malformed-metadata',
          'Google Drive contains divergent BetterTrack vault files that require an unlocked recovery.',
        );
      }
      try {
        resolved = await options.resolveDuplicates(
          readable.map(({ read }) => ({
            envelope: read.envelope.slice(),
            info: { ...read.info },
          })),
        );
      } catch (cause) {
        return corrupt(
          undefined,
          Math.max(...readable.map(({ read }) => read.info.version)),
          'corrupt-bytes',
          'Google Drive duplicate vault files could not be authenticated and reconciled.',
          cause,
        );
      }
    }

    const outgoing = inspectOutgoing(resolved.envelope);
    const highestParent = Math.max(...readable.map(({ read }) => read.info.version));
    if (
      'status' in outgoing ||
      outgoing.version !== resolved.version ||
      resolved.version < highestParent
    ) {
      return corrupt(
        resolved.envelope,
        'status' in outgoing ? outgoing.version : resolved.version,
        'version-mismatch',
        'Google Drive duplicate recovery returned an invalid vault successor.',
      );
    }

    const stable = await listFiles();
    if (stable.status !== 'ok') return stable;
    if (stable.files.length === 1) return { status: 'ok', file: stable.files[0]! };
    if (!sameFileSet(initialFiles, stable.files)) return { status: 'retry' };

    const canonical = stable.files[0]!;
    const canonicalRead = readable.find(({ file }) => file.id === canonical.id)!.read;
    if (!equalBytes(canonicalRead.envelope, resolved.envelope)) {
      const written = await upload(
        canonical,
        resolved.envelope,
        resolved.version,
        outgoing.formatVersion,
      );
      if (written.status === 'conflict') return { status: 'retry' };
      if (written.status !== 'ok') return written;
    }

    const afterWrite = await listFiles();
    if (afterWrite.status !== 'ok') return afterWrite;
    if (afterWrite.files.length === 0) return { status: 'retry' };
    const afterCanonical = afterWrite.files.find((file) => file.id === canonical.id);
    if (!afterCanonical) return { status: 'retry' };
    if (
      afterWrite.files.length > 1 &&
      !sameNonCanonicalFiles(stable.files, afterWrite.files, canonical.id)
    ) {
      return { status: 'retry' };
    }

    const roundTrip = await readFile(afterCanonical);
    if (roundTrip.status === 'absent') return { status: 'retry' };
    if (roundTrip.status !== 'ok') return roundTrip;
    if (!equalBytes(roundTrip.envelope, resolved.envelope)) return { status: 'retry' };

    if (afterWrite.files.length === 1) {
      return { status: 'ok', file: afterCanonical };
    }
    const beforeDelete = await listFiles();
    if (beforeDelete.status !== 'ok') return beforeDelete;
    if (beforeDelete.files.length === 1) {
      return { status: 'ok', file: beforeDelete.files[0]! };
    }
    if (!sameFileSet(afterWrite.files, beforeDelete.files)) return { status: 'retry' };

    for (const duplicate of beforeDelete.files) {
      if (duplicate.id === canonical.id) continue;
      const deleted = await deleteFile(duplicate.id);
      if (deleted.status !== 'ok' && deleted.status !== 'absent') return deleted;
    }

    const final = await listFiles();
    if (final.status !== 'ok') return final;
    if (final.files.length !== 1 || final.files[0]!.id !== canonical.id) {
      return { status: 'retry' };
    }
    return { status: 'ok', file: final.files[0]! };
  }

  async function readFile(file: DriveFileMetadata): Promise<DataHomeReadResult> {
    const fetched = await authorizedFetch(
      `${DRIVE_API}/files/${encodeURIComponent(file.id)}?alt=media`,
    );
    if (fetched.status === 'failure') return transport(fetched.failure);
    if (fetched.response.status === 404) return { status: 'absent', medium: 'drive' };
    if (!fetched.response.ok) {
      return apiFailure('Google Drive vault read failed.', fetched.response);
    }
    let envelope: Uint8Array;
    try {
      envelope = new Uint8Array(await fetched.response.arrayBuffer());
    } catch (cause) {
      return transport({
        kind: 'api-failure',
        message: 'Google Drive vault bytes could not be read.',
        cause,
      });
    }
    return inspectRead(envelope, file);
  }

  async function deleteFile(fileId: string): Promise<DriveDataHomeDeleteResult> {
    const fetched = await authorizedFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`, {
      method: 'DELETE',
    });
    if (fetched.status === 'failure') return transport(fetched.failure);
    if (fetched.response.status === 404) return { status: 'absent', medium: 'drive' };
    if (!fetched.response.ok) {
      return apiFailure('Google Drive vault deletion failed.', fetched.response);
    }
    return { status: 'ok', medium: 'drive' };
  }

  async function upload(
    file: DriveFileMetadata | null,
    envelope: Uint8Array,
    version: number,
    formatVersion: number,
  ): Promise<DataHomeWriteResult> {
    const multipartBoundary = boundary();
    const metadata: Record<string, unknown> = {
      name: DRIVE_VAULT_FILE_NAME,
      appProperties: {
        vaultVersion: String(version),
        formatVersion: String(formatVersion),
      },
    };
    if (file === null) metadata.parents = ['appDataFolder'];
    const body = multipartBody(multipartBoundary, metadata, envelope);
    const path =
      file === null
        ? `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,name,appProperties,headRevisionId,modifiedTime,size`
        : `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(file.id)}?uploadType=multipart&fields=id,name,appProperties,headRevisionId,modifiedTime,size`;
    const fetched = await authorizedFetch(path, {
      method: file === null ? 'POST' : 'PATCH',
      headers: { 'Content-Type': `multipart/related; boundary=${multipartBoundary}` },
      body,
    });
    if (fetched.status === 'failure') return transport(fetched.failure);
    if (!fetched.response.ok)
      return apiFailure('Google Drive vault write failed.', fetched.response);

    let payload: unknown;
    try {
      payload = await fetched.response.json();
    } catch (cause) {
      return corrupt(
        envelope,
        version,
        'malformed-metadata',
        'Google Drive acknowledged the write with malformed metadata.',
        cause,
      );
    }
    const parsed = parseMetadata(payload, envelope);
    if (parsed.status !== 'ok') {
      return parsed.status === 'absent'
        ? corrupt(
            envelope,
            version,
            'malformed-metadata',
            'Google Drive acknowledged the write without file metadata.',
          )
        : parsed;
    }
    if (parsed.file.version !== version || parsed.file.formatVersion !== formatVersion) {
      return corrupt(
        envelope,
        parsed.file.version,
        'version-mismatch',
        'Google Drive app properties do not match the written vault envelope.',
      );
    }
    return { status: 'ok', medium: 'drive', info: infoOf(parsed.file, envelope.byteLength) };
  }

  return {
    medium: 'drive',

    async read(): Promise<DataHomeReadResult> {
      const metadata = await listMetadata();
      if (metadata.status === 'absent') return { status: 'absent', medium: 'drive' };
      if (metadata.status !== 'ok') return metadata;
      return readFile(metadata.file);
    },

    async write(
      envelope: Uint8Array,
      { ifVersion }: DataHomeWriteOptions,
    ): Promise<DataHomeWriteResult> {
      const outgoing = inspectOutgoing(envelope);
      if ('status' in outgoing) return outgoing;
      if (ifVersion !== null && outgoing.version <= ifVersion) {
        return corrupt(
          envelope,
          outgoing.version,
          'version-mismatch',
          'A Google Drive vault write must advance the expected version.',
        );
      }

      const first = await listMetadata();
      if (first.status !== 'ok' && first.status !== 'absent') return first;
      if (ifVersion === null && first.status === 'ok') {
        return { status: 'conflict', medium: 'drive', currentVersion: first.file.version };
      }
      if (ifVersion !== null && (first.status === 'absent' || first.file.version !== ifVersion)) {
        return {
          status: 'conflict',
          medium: 'drive',
          currentVersion: first.status === 'ok' ? first.file.version : null,
        };
      }

      if (first.status === 'ok') {
        // Drive has no conditional update primitive. Re-read both app
        // properties and headRevisionId immediately before PATCH; a detected
        // change becomes a normal CAS conflict for the shared merge coordinator.
        const second = await listMetadata();
        if (second.status !== 'ok') {
          if (second.status === 'absent') {
            return { status: 'conflict', medium: 'drive', currentVersion: null };
          }
          return second;
        }
        if (
          second.file.version !== first.file.version ||
          second.file.headRevisionId !== first.file.headRevisionId
        ) {
          return {
            status: 'conflict',
            medium: 'drive',
            currentVersion: second.file.version,
          };
        }
        return upload(second.file, envelope, outgoing.version, outgoing.formatVersion);
      }

      const created = await upload(null, envelope, outgoing.version, outgoing.formatVersion);
      if (created.status !== 'ok') return created;

      // A name is not unique in Drive. Re-observe after POST so two absent-file
      // creators either converge to the same verified file or report a normal
      // CAS conflict; never acknowledge bytes that duplicate recovery replaced.
      const settled = await listMetadata();
      if (settled.status === 'absent') {
        return { status: 'conflict', medium: 'drive', currentVersion: null };
      }
      if (settled.status !== 'ok') return settled;
      const roundTrip = await readFile(settled.file);
      if (roundTrip.status === 'absent') {
        return { status: 'conflict', medium: 'drive', currentVersion: null };
      }
      if (roundTrip.status !== 'ok') return roundTrip;
      if (!equalBytes(roundTrip.envelope, envelope)) {
        return {
          status: 'conflict',
          medium: 'drive',
          currentVersion: roundTrip.info.version,
        };
      }
      return { status: 'ok', medium: 'drive', info: roundTrip.info };
    },

    async info(): Promise<DataHomeInfoResult> {
      const metadata = await listMetadata();
      if (metadata.status === 'absent') return { status: 'absent', medium: 'drive' };
      if (metadata.status !== 'ok') return metadata;
      return { status: 'ok', medium: 'drive', info: infoOf(metadata.file) };
    },

    async delete(): Promise<DriveDataHomeDeleteResult> {
      const listed = await listFiles();
      if (listed.status !== 'ok') return listed;
      if (listed.files.length === 0) return { status: 'absent', medium: 'drive' };
      for (const file of listed.files) {
        const deleted = await deleteFile(file.id);
        if (deleted.status !== 'ok' && deleted.status !== 'absent') return deleted;
      }
      return { status: 'ok', medium: 'drive' };
    },
  };
}

export const driveDataHome = createDriveDataHome;

function inspectOutgoing(
  envelope: Uint8Array,
): { version: number; formatVersion: number; updatedAt: string } | DataHomeCorruptCandidate {
  try {
    const inspected = inspectVaultEnvelope(envelope);
    if (inspected.status === 'update-required') {
      return corrupt(
        envelope,
        null,
        'unsupported-version',
        'The vault was written by a newer app version.',
      );
    }
    return {
      version: inspected.envelope.header.vaultVersion,
      formatVersion: inspected.envelope.header.formatVersion,
      updatedAt: inspected.envelope.header.writtenAt,
    };
  } catch (cause) {
    return corrupt(
      envelope,
      null,
      'malformed-envelope',
      cause instanceof Error ? cause.message : 'The vault envelope is malformed.',
    );
  }
}

function inspectRead(envelope: Uint8Array, metadata: DriveFileMetadata): DataHomeReadResult {
  const outgoing = inspectOutgoing(envelope);
  if ('status' in outgoing) {
    return {
      ...outgoing,
      reason: outgoing.reason === 'malformed-envelope' ? 'corrupt-bytes' : outgoing.reason,
      version: metadata.version,
      updatedAt: metadata.modifiedTime,
    };
  }
  if (outgoing.version !== metadata.version || outgoing.formatVersion !== metadata.formatVersion) {
    return corrupt(
      envelope,
      metadata.version,
      'version-mismatch',
      'Google Drive app properties do not match the vault envelope.',
      undefined,
      metadata.modifiedTime,
    );
  }
  return {
    status: 'ok',
    medium: 'drive',
    envelope,
    info: infoOf(metadata, envelope.byteLength),
  };
}

function parseMetadata(value: unknown, envelope?: Uint8Array): MetadataResult {
  if (!isRecord(value)) {
    return corrupt(
      envelope,
      null,
      'malformed-metadata',
      'Google Drive returned malformed file metadata.',
    );
  }
  const properties = isRecord(value.appProperties) ? value.appProperties : null;
  const version = positiveInteger(properties?.vaultVersion);
  const formatVersion = positiveInteger(properties?.formatVersion);
  const sizeBytes = nonNegativeInteger(value.size);
  const modifiedTime =
    typeof value.modifiedTime === 'string' && !Number.isNaN(Date.parse(value.modifiedTime))
      ? value.modifiedTime
      : null;
  if (
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    value.name !== DRIVE_VAULT_FILE_NAME ||
    typeof value.headRevisionId !== 'string' ||
    value.headRevisionId.length === 0 ||
    version === null ||
    formatVersion !== VAULT_FORMAT_VERSION ||
    sizeBytes === null
  ) {
    return corrupt(
      envelope,
      version,
      'malformed-metadata',
      'Google Drive vault metadata is incomplete or malformed.',
      undefined,
      modifiedTime,
    );
  }
  return {
    status: 'ok',
    file: {
      id: value.id,
      version,
      formatVersion,
      headRevisionId: value.headRevisionId,
      modifiedTime,
      sizeBytes,
    },
  };
}

function infoOf(file: DriveFileMetadata, exactSize = file.sizeBytes): DataHomeInfo {
  return {
    medium: 'drive',
    version: file.version,
    sizeBytes: exactSize,
    updatedAt: file.modifiedTime,
  };
}

function sameFileSet(
  left: readonly DriveFileMetadata[],
  right: readonly DriveFileMetadata[],
): boolean {
  return (
    left.length === right.length &&
    left.every((file, index) => sameFileMetadata(file, right[index]))
  );
}

function sameNonCanonicalFiles(
  left: readonly DriveFileMetadata[],
  right: readonly DriveFileMetadata[],
  canonicalId: string,
): boolean {
  const leftRest = left.filter((file) => file.id !== canonicalId);
  const rightRest = right.filter((file) => file.id !== canonicalId);
  return sameFileSet(leftRest, rightRest);
}

function sameFileMetadata(left: DriveFileMetadata, right: DriveFileMetadata | undefined): boolean {
  return (
    right !== undefined &&
    left.id === right.id &&
    left.version === right.version &&
    left.formatVersion === right.formatVersion &&
    left.headRevisionId === right.headRevisionId &&
    left.modifiedTime === right.modifiedTime &&
    left.sizeBytes === right.sizeBytes
  );
}

function multipartBody(
  boundary: string,
  metadata: Record<string, unknown>,
  envelope: Uint8Array,
): Blob {
  const prefix =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n--${boundary}\r\n` +
    'Content-Type: application/octet-stream\r\n\r\n';
  return new Blob([prefix, envelope.slice().buffer, `\r\n--${boundary}--`]);
}

function tokenFailure(
  result: Extract<DriveAccessTokenResult, { status: 'unavailable' }>,
): DataHomeTransportFailure {
  return {
    kind: result.reason,
    message: result.message,
  };
}

function transport(
  failure: DataHomeTransportFailure,
): Extract<DataHomeInfoResult, { status: 'transport-failure' }> {
  return { status: 'transport-failure', medium: 'drive', failure };
}

function apiFailure(
  message: string,
  response: Response,
): Extract<DataHomeInfoResult, { status: 'transport-failure' }> {
  return transport({
    kind: response.status === 401 ? 'token-expired' : 'api-failure',
    message,
    httpStatus: response.status,
  });
}

function corrupt(
  envelope: Uint8Array | undefined,
  version: number | null,
  reason: DataHomeCorruptCandidate['reason'],
  message: string,
  cause?: unknown,
  updatedAt: string | null = null,
): DataHomeCorruptCandidate {
  return {
    status: 'corrupt',
    medium: 'drive',
    envelope,
    version,
    updatedAt,
    reason,
    message: cause instanceof Error ? `${message} ${cause.message}` : message,
  };
}

function positiveInteger(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

function nonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function headersObject(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(new Headers(headers).entries());
}

export function driveFailureReason(
  failure: DataHomeTransportFailure,
): DriveTokenUnavailableReason | 'api-failure' {
  switch (failure.kind) {
    case 'consent-required':
    case 'token-expired':
    case 'gesture-required':
    case 'offline':
    case 'authorization-failed':
      return failure.kind;
    default:
      return 'api-failure';
  }
}
