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
import type { DriveAccessTokenResult, GoogleDriveTokenClient } from './gisTokenClient';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const FILE_FIELDS = 'id,name,size,modifiedTime,headRevisionId,appProperties';
const DUPLICATE_SCAN_LIMIT = '100';
const DRIVE_VAULT_FILE_CONTEXT = 'bettertrack-drive-vault-account-v1:';
const DRIVE_VAULT_FILE_PREFIX = 'bettertrack-vault-';
const DRIVE_VAULT_FILE_SUFFIX = '.btenc';

interface DriveFile {
  id: string;
  name: string;
  size?: string;
  modifiedTime?: string;
  headRevisionId?: string;
  appProperties?: Record<string, string>;
}

interface ValidDriveFile {
  id: string;
  version: number;
  formatVersion: number;
  sizeBytes: number;
  updatedAt: string | null;
  headRevisionId: string;
}

type DriveFileResult =
  | { status: 'ok'; file: ValidDriveFile; files: readonly ValidDriveFile[] }
  | { status: 'absent' }
  | { status: 'corrupt'; result: DataHomeCorruptCandidate }
  | { status: 'failure'; failure: DataHomeTransportFailure };

export type DriveDeleteResult =
  | { status: 'ok'; deleted: boolean }
  | { status: 'transport-failure'; failure: DataHomeTransportFailure };

export interface DriveReplicaCycle {
  /**
   * Every same-name Drive object, in deterministic metadata order. The PD5
   * coordinator must authenticate and reconcile every observation before it
   * invokes `converge`.
   */
  readonly observations: readonly DataHomeReadResult[];
  /**
   * Publish already-authenticated/reconciled bytes to one canonical object,
   * then remove the other objects only after a verified read-back.
   */
  converge(envelope: Uint8Array): Promise<DataHomeWriteResult>;
}

export interface DriveDataHome extends DataHome {
  readonly medium: 'drive';
  observeReplicas(): Promise<DriveReplicaCycle>;
  delete(): Promise<DriveDeleteResult>;
}

export interface DriveDataHomeOptions {
  /** BetterTrack account id; hashed before it is used as a Drive selector. */
  accountId: string;
  tokens: Pick<GoogleDriveTokenClient, 'getAccessToken' | 'markExpired'>;
  fetch?: typeof fetch;
  isOnline?: () => boolean;
  boundary?: () => string;
}

/**
 * One-file Google Drive appdata adapter. File ids and access tokens stay inside
 * this browser boundary; callers see only the generic encrypted `DataHome`.
 */
export function createDriveDataHome(options: DriveDataHomeOptions): DriveDataHome {
  const accountId = options.accountId.trim();
  if (accountId.length === 0) throw new Error('A Drive vault account scope is required.');
  const request = options.fetch ?? globalThis.fetch;
  const isOnline =
    options.isOnline ??
    (() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  const boundary = options.boundary ?? (() => `bettertrack-${crypto.randomUUID()}`);
  const fileNamePromise = driveVaultFileName(accountId);

  return {
    medium: 'drive',

    async read(): Promise<DataHomeReadResult> {
      const replicas = await observeReplicas();
      return cloneReadResult(
        replicas.observations.find((observation) => observation.status === 'ok') ??
          replicas.observations[0]!,
      );
    },

    observeReplicas,

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
          'corrupt-bytes',
          'The Drive vault version must advance its compare-and-swap version.',
        );
      }

      const observed = await findFile();
      if (observed.status === 'failure') return transport(observed.failure);
      if (observed.status === 'corrupt') return observed.result;
      if (observed.status === 'absent') {
        if (ifVersion !== null) {
          return { status: 'conflict', medium: 'drive', currentVersion: null };
        }
        return upload(envelope, outgoing, null);
      }
      // A duplicate set is not one CAS target. Keep every branch intact for
      // observeReplicas()/the PD5 merge path instead of selecting and deleting
      // from metadata alone.
      if (observed.files.length > 1) {
        return {
          status: 'conflict',
          medium: 'drive',
          currentVersion: observed.file.version,
        };
      }
      if (ifVersion === null || observed.file.version !== ifVersion) {
        return {
          status: 'conflict',
          medium: 'drive',
          currentVersion: observed.file.version,
        };
      }

      // Drive has no true CAS. Re-read both appProperties and the native
      // revision immediately before update; any detected movement enters the
      // existing merge/retry coordinator instead of force-overwriting.
      const refreshed = await getFile(observed.file.id);
      if (refreshed.status === 'failure') return transport(refreshed.failure);
      if (refreshed.status === 'absent') {
        return { status: 'conflict', medium: 'drive', currentVersion: null };
      }
      if (refreshed.status === 'corrupt') return refreshed.result;
      if (
        refreshed.file.version !== observed.file.version ||
        refreshed.file.formatVersion !== observed.file.formatVersion ||
        refreshed.file.headRevisionId !== observed.file.headRevisionId
      ) {
        return {
          status: 'conflict',
          medium: 'drive',
          currentVersion: refreshed.file.version,
        };
      }
      return upload(envelope, outgoing, observed.file.id);
    },

    async info(): Promise<DataHomeInfoResult> {
      const read = await this.read();
      return read.status === 'ok' ? { status: 'ok', medium: 'drive', info: read.info } : read;
    },

    async delete(): Promise<DriveDeleteResult> {
      const found = await findFile();
      if (found.status === 'absent') return { status: 'ok', deleted: false };
      if (found.status === 'failure') {
        return { status: 'transport-failure', failure: found.failure };
      }
      if (found.status === 'corrupt') {
        return {
          status: 'transport-failure',
          failure: { code: 'api-failure', message: found.result.message },
        };
      }
      let deletedAny = false;
      for (const file of found.files) {
        const deleted = await driveFetch(`${DRIVE_API}/files/${encodeURIComponent(file.id)}`, {
          method: 'DELETE',
        });
        if (deleted.status === 'failure') {
          return { status: 'transport-failure', failure: deleted.failure };
        }
        if (deleted.response.status === 404) continue;
        if (!deleted.response.ok) {
          return {
            status: 'transport-failure',
            failure: httpFailure(deleted.response, 'Drive vault deletion failed.'),
          };
        }
        deletedAny = true;
      }
      return { status: 'ok', deleted: deletedAny };
    },
  };

  async function observeReplicas(): Promise<DriveReplicaCycle> {
    const found = await findFile();
    if (found.status === 'absent') {
      return fixedReplicaCycle([{ status: 'absent', medium: 'drive' }]);
    }
    if (found.status === 'failure') {
      return fixedReplicaCycle([transport(found.failure)]);
    }
    if (found.status === 'corrupt') {
      return fixedReplicaCycle([found.result]);
    }

    const observations = await Promise.all(found.files.map(download));
    return {
      observations: observations.map(cloneReadResult),
      converge: (envelope) => convergeDuplicateFiles(found.files, observations, envelope),
    };
  }

  function fixedReplicaCycle(observations: readonly DataHomeReadResult[]): DriveReplicaCycle {
    return {
      observations,
      async converge() {
        return transport({
          code: 'api-failure',
          message: 'Drive convergence requires more than one observed object.',
        });
      },
    };
  }

  async function findFile(): Promise<DriveFileResult> {
    const fileName = await fileNamePromise;
    const params = new URLSearchParams({
      spaces: 'appDataFolder',
      q: `name = '${fileName}' and trashed = false`,
      fields: `files(${FILE_FIELDS})`,
      pageSize: DUPLICATE_SCAN_LIMIT,
    });
    const listed = await driveFetch(`${DRIVE_API}/files?${params.toString()}`);
    if (listed.status === 'failure') return listed;
    if (!listed.response.ok) {
      return {
        status: 'failure',
        failure: httpFailure(listed.response, 'Drive appdata lookup failed.'),
      };
    }

    let payload: unknown;
    try {
      payload = await listed.response.json();
    } catch (cause) {
      return {
        status: 'failure',
        failure: {
          code: 'api-failure',
          message: 'Drive appdata lookup returned invalid JSON.',
          cause,
        },
      };
    }
    const files =
      typeof payload === 'object' &&
      payload !== null &&
      Array.isArray((payload as { files?: unknown }).files)
        ? (payload as { files: unknown[] }).files
        : null;
    if (files === null) {
      return {
        status: 'corrupt',
        result: corrupt(
          undefined,
          null,
          'malformed-metadata',
          'Drive appdata contains invalid vault metadata.',
        ),
      };
    }
    if (files.length === 0) return { status: 'absent' };

    const validated: ValidDriveFile[] = [];
    for (const file of files) {
      const result = validateFile(file, fileName);
      if (result.status !== 'ok') return result;
      validated.push(result.file);
    }
    const ordered = [...validated].sort(compareDriveFiles);
    return { status: 'ok', file: ordered[0]!, files: ordered };
  }

  async function getFile(id: string): Promise<DriveFileResult> {
    const fileName = await fileNamePromise;
    const response = await driveFetch(
      `${DRIVE_API}/files/${encodeURIComponent(id)}?fields=${encodeURIComponent(FILE_FIELDS)}`,
    );
    if (response.status === 'failure') return response;
    if (response.response.status === 404) return { status: 'absent' };
    if (!response.response.ok) {
      return {
        status: 'failure',
        failure: httpFailure(response.response, 'Drive metadata refresh failed.'),
      };
    }
    try {
      return validateFile(await response.response.json(), fileName);
    } catch (cause) {
      return {
        status: 'failure',
        failure: {
          code: 'api-failure',
          message: 'Drive metadata refresh returned invalid JSON.',
          cause,
        },
      };
    }
  }

  async function download(file: ValidDriveFile): Promise<DataHomeReadResult> {
    const downloaded = await driveFetch(
      `${DRIVE_API}/files/${encodeURIComponent(file.id)}?alt=media`,
    );
    if (downloaded.status === 'failure') return transport(downloaded.failure);
    if (downloaded.response.status === 404) return { status: 'absent', medium: 'drive' };
    if (!downloaded.response.ok) {
      return transport(httpFailure(downloaded.response, 'Drive vault download failed.'));
    }

    let envelope: Uint8Array;
    try {
      envelope = new Uint8Array(await downloaded.response.arrayBuffer());
    } catch (cause) {
      return transport({
        code: 'api-failure',
        message: 'Drive vault bytes could not be read.',
        cause,
      });
    }
    const inspected = inspectEnvelope(envelope, file);
    if ('status' in inspected) return inspected;
    return { status: 'ok', medium: 'drive', envelope, info: inspected };
  }

  async function upload(
    envelope: Uint8Array,
    outgoing: DataHomeInfo,
    fileId: string | null,
  ): Promise<DataHomeWriteResult> {
    const acknowledged = await sendUpload(envelope, outgoing, fileId);
    if (acknowledged.status === 'failure') return transport(acknowledged.failure);
    if (acknowledged.status === 'corrupt') return acknowledged.result;
    if (acknowledged.status === 'absent') {
      return transport({
        code: 'api-failure',
        message: 'Drive upload returned no file metadata.',
        indeterminate: true,
      });
    }

    // A PATCH response describes the revision this request created, not
    // necessarily the revision that is current after another writer's TOCTOU
    // update. Re-list and download current bytes before reporting success.
    const confirmed = await findFile();
    if (confirmed.status === 'failure') {
      return transport({ ...confirmed.failure, indeterminate: true });
    }
    if (confirmed.status === 'corrupt') return confirmed.result;
    if (confirmed.status === 'absent') {
      return transport({
        code: 'api-failure',
        message: 'Drive could not confirm the written vault file.',
        indeterminate: true,
      });
    }
    if (
      confirmed.files.length > 1 ||
      confirmed.file.id !== acknowledged.file.id ||
      confirmed.file.version !== outgoing.version
    ) {
      return {
        status: 'conflict',
        medium: 'drive',
        currentVersion: confirmed.file.version,
      };
    }

    const roundTrip = await download(confirmed.file);
    if (roundTrip.status !== 'ok') {
      if (roundTrip.status === 'corrupt') return roundTrip;
      return transport({
        code: 'api-failure',
        message:
          roundTrip.status === 'transport-failure'
            ? roundTrip.failure.message
            : 'Drive could not read back the written vault file.',
        indeterminate: true,
      });
    }
    if (!equalBytes(roundTrip.envelope, envelope)) {
      return {
        status: 'conflict',
        medium: 'drive',
        currentVersion: roundTrip.info.version,
      };
    }
    return { status: 'ok', medium: 'drive', info: roundTrip.info };
  }

  async function sendUpload(
    envelope: Uint8Array,
    outgoing: DataHomeInfo,
    fileId: string | null,
  ): Promise<DriveFileResult> {
    const fileName = await fileNamePromise;
    const marker = boundary();
    const metadata = {
      ...(fileId === null ? { name: fileName, parents: ['appDataFolder'] } : {}),
      appProperties: {
        vaultVersion: String(outgoing.version),
        formatVersion: String(VAULT_FORMAT_VERSION),
      },
    };
    const body = new Blob([
      `--${marker}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify(metadata),
      `\r\n--${marker}\r\nContent-Type: application/octet-stream\r\n\r\n`,
      envelope.slice(),
      `\r\n--${marker}--`,
    ]);
    const endpoint =
      fileId === null
        ? `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}`
        : `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(fileId)}?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}`;
    const uploaded = await driveFetch(endpoint, {
      method: fileId === null ? 'POST' : 'PATCH',
      headers: { 'Content-Type': `multipart/related; boundary=${marker}` },
      body,
    });
    if (uploaded.status === 'failure') {
      return {
        status: 'failure',
        failure: { ...uploaded.failure, indeterminate: true },
      };
    }
    if (!uploaded.response.ok) {
      return {
        status: 'failure',
        failure: httpFailure(uploaded.response, 'Drive vault upload failed.', true),
      };
    }

    let acknowledged: DriveFileResult;
    try {
      acknowledged = validateFile(await uploaded.response.json(), fileName);
    } catch (cause) {
      return {
        status: 'failure',
        failure: {
          code: 'api-failure',
          message: 'Drive upload returned invalid metadata.',
          cause,
          indeterminate: true,
        },
      };
    }
    if (acknowledged.status !== 'ok') return acknowledged;
    if (acknowledged.file.version !== outgoing.version) {
      return {
        status: 'corrupt',
        result: corrupt(
          envelope,
          acknowledged.file.version,
          'version-mismatch',
          'Drive acknowledged a different vault version.',
        ),
      };
    }
    return acknowledged;
  }

  async function convergeDuplicateFiles(
    frozenFiles: readonly ValidDriveFile[],
    observations: readonly DataHomeReadResult[],
    envelope: Uint8Array,
  ): Promise<DataHomeWriteResult> {
    const outgoing = inspectOutgoing(envelope);
    if ('status' in outgoing) return outgoing;
    if (frozenFiles.length < 2 || observations.length !== frozenFiles.length) {
      return transport({
        code: 'api-failure',
        message: 'Drive duplicate reconciliation has no complete observation set.',
      });
    }

    const interrupted = observations.find(
      (observation) => observation.status === 'transport-failure',
    );
    if (interrupted?.status === 'transport-failure') return transport(interrupted.failure);
    const readable = observations
      .map((observation, index) => ({ observation, index }))
      .filter(
        (
          candidate,
        ): candidate is {
          observation: Extract<DataHomeReadResult, { status: 'ok' }>;
          index: number;
        } => candidate.observation.status === 'ok',
      );
    if (readable.length === 0) {
      const corruptObservation = observations.find(
        (observation): observation is DataHomeCorruptCandidate => observation.status === 'corrupt',
      );
      return (
        corruptObservation ??
        transport({
          code: 'api-failure',
          message: 'Drive duplicate reconciliation found no readable candidate.',
        })
      );
    }

    const beforeWrite = await findFile();
    const beforeFailure = driveFileFailure(beforeWrite);
    if (beforeFailure) return beforeFailure;
    if (beforeWrite.status !== 'ok' || !sameFileSet(beforeWrite.files, frozenFiles)) {
      return duplicateConflict(beforeWrite);
    }

    const exactMatch = readable.find(({ observation }) =>
      equalBytes(observation.envelope, envelope),
    );
    const matching = exactMatch ?? readable[0]!;
    const canonicalBefore = frozenFiles[matching.index]!;
    let canonicalAfter = canonicalBefore;
    if (exactMatch == null) {
      const highestReadableVersion = Math.max(
        ...readable.map(({ observation }) => observation.info.version),
      );
      if (outgoing.version <= highestReadableVersion) {
        return {
          status: 'conflict',
          medium: 'drive',
          currentVersion: highestReadableVersion,
        };
      }
      const acknowledged = await sendUpload(envelope, outgoing, canonicalBefore.id);
      const uploadFailure = driveFileFailure(acknowledged);
      if (uploadFailure) return uploadFailure;
      if (acknowledged.status !== 'ok' || acknowledged.file.id !== canonicalBefore.id) {
        return duplicateConflict(acknowledged);
      }
      canonicalAfter = acknowledged.file;
    }

    const canonicalRead = await getFile(canonicalBefore.id);
    const canonicalFailure = driveFileFailure(canonicalRead);
    if (canonicalFailure) return canonicalFailure;
    if (
      canonicalRead.status !== 'ok' ||
      canonicalRead.file.version !== outgoing.version ||
      canonicalRead.file.headRevisionId !== canonicalAfter.headRevisionId
    ) {
      return duplicateConflict(canonicalRead);
    }
    const canonicalRoundTrip = await download(canonicalRead.file);
    if (canonicalRoundTrip.status !== 'ok') {
      return canonicalRoundTrip.status === 'corrupt'
        ? canonicalRoundTrip
        : transport({
            code: 'api-failure',
            message:
              canonicalRoundTrip.status === 'transport-failure'
                ? canonicalRoundTrip.failure.message
                : 'Drive could not read back the converged vault file.',
            indeterminate: true,
          });
    }
    if (!equalBytes(canonicalRoundTrip.envelope, envelope)) {
      return duplicateConflict(canonicalRead);
    }

    // This is the destructive barrier. Every candidate has already been
    // presented to the authenticated PD5 coordinator, the canonical bytes have
    // been read back, and every object/revision is revalidated before a loser
    // is removed.
    const beforeDelete = await findFile();
    const deleteBarrierFailure = driveFileFailure(beforeDelete);
    if (deleteBarrierFailure) return deleteBarrierFailure;
    if (
      beforeDelete.status !== 'ok' ||
      !sameConvergenceSet(beforeDelete.files, frozenFiles, canonicalRead.file)
    ) {
      return duplicateConflict(beforeDelete);
    }

    for (const duplicate of beforeDelete.files) {
      if (duplicate.id === canonicalRead.file.id) continue;
      const deleted = await driveFetch(`${DRIVE_API}/files/${encodeURIComponent(duplicate.id)}`, {
        method: 'DELETE',
      });
      if (deleted.status === 'failure') {
        return transport({ ...deleted.failure, indeterminate: true });
      }
      if (deleted.response.status !== 404 && !deleted.response.ok) {
        return transport(
          httpFailure(
            deleted.response,
            'Drive duplicate-vault cleanup failed after convergence.',
            true,
          ),
        );
      }
    }

    const confirmed = await findFile();
    const confirmationFailure = driveFileFailure(confirmed);
    if (confirmationFailure) return confirmationFailure;
    if (
      confirmed.status !== 'ok' ||
      confirmed.files.length !== 1 ||
      confirmed.file.id !== canonicalRead.file.id ||
      confirmed.file.version !== outgoing.version
    ) {
      return duplicateConflict(confirmed);
    }
    const finalRoundTrip = await download(confirmed.file);
    if (finalRoundTrip.status !== 'ok') {
      return finalRoundTrip.status === 'corrupt'
        ? finalRoundTrip
        : transport({
            code: 'api-failure',
            message:
              finalRoundTrip.status === 'transport-failure'
                ? finalRoundTrip.failure.message
                : 'Drive could not confirm duplicate convergence.',
            indeterminate: true,
          });
    }
    if (!equalBytes(finalRoundTrip.envelope, envelope)) {
      return duplicateConflict(confirmed);
    }
    return { status: 'ok', medium: 'drive', info: finalRoundTrip.info };
  }

  function driveFileFailure(result: DriveFileResult): DataHomeWriteResult | null {
    if (result.status === 'failure') return transport(result.failure);
    if (result.status === 'corrupt') return result.result;
    return null;
  }

  function duplicateConflict(result: DriveFileResult): DataHomeWriteResult {
    return {
      status: 'conflict',
      medium: 'drive',
      currentVersion: result.status === 'ok' ? result.file.version : null,
    };
  }

  async function driveFetch(
    url: string,
    init: RequestInit = {},
  ): Promise<
    { status: 'ok'; response: Response } | { status: 'failure'; failure: DataHomeTransportFailure }
  > {
    if (!isOnline()) {
      return {
        status: 'failure',
        failure: { code: 'offline', message: 'Google Drive is offline.' },
      };
    }
    const access = options.tokens.getAccessToken();
    if (access.status !== 'ok') {
      return { status: 'failure', failure: tokenFailure(access) };
    }

    let response: Response;
    try {
      response = await request(url, {
        ...init,
        headers: {
          ...headersObject(init.headers),
          Authorization: `Bearer ${access.accessToken}`,
        },
      });
    } catch (cause) {
      return {
        status: 'failure',
        failure: {
          code: isOnline() ? 'api-failure' : 'offline',
          message: isOnline() ? 'Google Drive could not be reached.' : 'Google Drive is offline.',
          cause,
          indeterminate: init.method === 'POST' || init.method === 'PATCH',
        },
      };
    }
    if (response.status === 401) {
      options.tokens.markExpired();
      return {
        status: 'failure',
        failure: {
          code: 'token-expired',
          httpStatus: 401,
          message: 'The Google Drive access token expired.',
        },
      };
    }
    if (response.status === 403) {
      return {
        status: 'failure',
        failure: {
          code: 'permission-denied',
          httpStatus: 403,
          message: 'Google Drive appdata access was denied.',
        },
      };
    }
    return { status: 'ok', response };
  }
}

/** Highest version/newest Drive timestamp wins; id is the stable final tie-break. */
function compareDriveFiles(left: ValidDriveFile, right: ValidDriveFile): number {
  if (left.version !== right.version) return right.version - left.version;
  const updated = (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '');
  return updated !== 0 ? updated : left.id.localeCompare(right.id);
}

function sameFileSet(
  current: readonly ValidDriveFile[],
  frozen: readonly ValidDriveFile[],
): boolean {
  return (
    current.length === frozen.length &&
    current.every((file) => {
      const expected = frozen.find((candidate) => candidate.id === file.id);
      return expected != null && sameDriveFile(file, expected);
    })
  );
}

function sameConvergenceSet(
  current: readonly ValidDriveFile[],
  frozen: readonly ValidDriveFile[],
  canonical: ValidDriveFile,
): boolean {
  return (
    current.length === frozen.length &&
    current.every((file) => {
      const expected =
        file.id === canonical.id ? canonical : frozen.find((candidate) => candidate.id === file.id);
      return expected != null && sameDriveFile(file, expected);
    })
  );
}

function sameDriveFile(left: ValidDriveFile, right: ValidDriveFile): boolean {
  return (
    left.id === right.id &&
    left.version === right.version &&
    left.formatVersion === right.formatVersion &&
    left.sizeBytes === right.sizeBytes &&
    left.updatedAt === right.updatedAt &&
    left.headRevisionId === right.headRevisionId
  );
}

function validateFile(value: unknown, expectedName: string): DriveFileResult {
  if (typeof value !== 'object' || value === null) {
    return malformedMetadata('Drive returned a non-object vault file.');
  }
  const file = value as Partial<DriveFile>;
  const version = Number(file.appProperties?.vaultVersion);
  const formatVersion = Number(file.appProperties?.formatVersion);
  const sizeBytes = Number(file.size ?? 0);
  if (
    typeof file.id !== 'string' ||
    file.id.length === 0 ||
    file.name !== expectedName ||
    !Number.isInteger(version) ||
    version < 1 ||
    formatVersion !== VAULT_FORMAT_VERSION ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes <= 0 ||
    typeof file.headRevisionId !== 'string' ||
    file.headRevisionId.length === 0
  ) {
    return malformedMetadata('Drive vault appProperties or revision metadata is malformed.');
  }
  const valid: ValidDriveFile = {
    id: file.id,
    version,
    formatVersion,
    sizeBytes,
    updatedAt:
      typeof file.modifiedTime === 'string' && !Number.isNaN(Date.parse(file.modifiedTime))
        ? file.modifiedTime
        : null,
    headRevisionId: file.headRevisionId,
  };
  return { status: 'ok', file: valid, files: [valid] };
}

/** Stable, opaque selector within one Google principal's shared appDataFolder. */
export async function driveVaultFileName(
  accountId: string,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<string> {
  const scoped = new TextEncoder().encode(`${DRIVE_VAULT_FILE_CONTEXT}${accountId}`);
  const digest = new Uint8Array(await subtle.digest('SHA-256', scoped));
  return `${DRIVE_VAULT_FILE_PREFIX}${base64url(digest)}${DRIVE_VAULT_FILE_SUFFIX}`;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function malformedMetadata(message: string): DriveFileResult {
  return {
    status: 'corrupt',
    result: corrupt(undefined, null, 'malformed-metadata', message),
  };
}

function inspectOutgoing(envelope: Uint8Array): DataHomeInfo | DataHomeCorruptCandidate {
  try {
    const inspected = inspectVaultEnvelope(envelope);
    if (inspected.status === 'update-required') {
      return corrupt(
        envelope,
        null,
        'unsupported-version',
        'The Drive vault was written by a newer app version.',
      );
    }
    return {
      medium: 'drive',
      version: inspected.envelope.header.vaultVersion,
      sizeBytes: envelope.byteLength,
      updatedAt: inspected.envelope.header.writtenAt,
    };
  } catch (cause) {
    return corrupt(
      envelope,
      null,
      'corrupt-bytes',
      cause instanceof Error ? cause.message : 'Drive vault bytes are corrupt.',
    );
  }
}

function inspectEnvelope(
  envelope: Uint8Array,
  file: ValidDriveFile,
): DataHomeInfo | DataHomeCorruptCandidate {
  const inspected = inspectOutgoing(envelope);
  if ('status' in inspected) return inspected;
  if (inspected.version !== file.version || file.formatVersion !== VAULT_FORMAT_VERSION) {
    return corrupt(
      envelope,
      file.version,
      'version-mismatch',
      'Drive appProperties do not match the opaque vault envelope.',
    );
  }
  return { ...inspected, updatedAt: file.updatedAt ?? inspected.updatedAt };
}

function cloneReadResult(result: DataHomeReadResult): DataHomeReadResult {
  if (result.status === 'ok') {
    return {
      ...result,
      envelope: result.envelope.slice(),
      info: { ...result.info },
    };
  }
  if (result.status === 'corrupt') {
    return {
      ...result,
      envelope: result.envelope?.slice(),
    };
  }
  return result;
}

function corrupt(
  envelope: Uint8Array | undefined,
  version: number | null,
  reason: DataHomeCorruptCandidate['reason'],
  message: string,
): DataHomeCorruptCandidate {
  return {
    status: 'corrupt',
    medium: 'drive',
    envelope,
    version,
    updatedAt: null,
    reason,
    message,
  };
}

function transport(
  failure: DataHomeTransportFailure,
): Extract<DataHomeWriteResult, { status: 'transport-failure' }> {
  return { status: 'transport-failure', medium: 'drive', failure };
}

function tokenFailure(
  result: Exclude<DriveAccessTokenResult, { status: 'ok' }>,
): DataHomeTransportFailure {
  return {
    code: result.status === 'consent-required' ? 'consent-required' : result.status,
    message: result.message,
  };
}

function httpFailure(
  response: Response,
  message: string,
  indeterminate = false,
): DataHomeTransportFailure {
  return {
    code: 'api-failure',
    httpStatus: response.status,
    message,
    indeterminate,
  };
}

function headersObject(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(new Headers(headers).entries());
}
