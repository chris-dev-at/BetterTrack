import {
  inspectVaultDocEnvelope,
  VAULT_ACCOUNT_BINDING_INFO_PREFIX,
  VAULT_DOC_FORMAT_VERSION,
  VAULT_FORMAT_VERSION,
  type VaultDocKind,
} from '@bettertrack/contracts';

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
const FILE_FIELDS = 'id,name,size,modifiedTime,headRevisionId,trashed,appProperties';
const DUPLICATE_SCAN_LIMIT = '100';
const DRIVE_VAULT_FILE_CONTEXT = 'bettertrack-drive-vault-account-v1:';
const DRIVE_VAULT_DOC_FILE_CONTEXT = 'bettertrack-drive-vault-v2:';
const DRIVE_OWNER_CONTEXT = 'bettertrack-drive-owner-v1:';
const DRIVE_VAULT_DIGEST_CONTEXT = 'bettertrack-drive-vault-id-v1:';
const DRIVE_VAULT_FILE_PREFIX = 'bettertrack-vault-';
const DRIVE_VAULT_FILE_SUFFIX = '.btenc';
const DRIVE_FOLDER_NAME = 'BetterTrack Vaults';
const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
const DRIVE_FOLDER_MARKER = 'bettertrack-vaults-v1';

interface DriveFile {
  id: string;
  name: string;
  size?: string;
  modifiedTime?: string;
  headRevisionId?: string;
  trashed?: boolean;
  appProperties?: Record<string, string>;
}

interface ValidDriveFile {
  id: string;
  version: number;
  formatVersion: number;
  sizeBytes: number;
  updatedAt: string | null;
  headRevisionId: string;
  ownerDigest: string;
  vaultDigest: string | null;
  docKind: VaultDocKind | null;
}

interface DriveAddress {
  mode: 'legacy' | 'doc';
  accountId: string;
  vaultId: string | null;
  docId: string | null;
  docKind: VaultDocKind | null;
  fileName: string;
  ownerDigest: string;
  vaultDigest: string | null;
  accountBinding: string | null;
}

type DriveFileResult =
  | {
      status: 'ok';
      file: ValidDriveFile;
      files: readonly ValidDriveFile[];
      /**
       * Bodies already fetched while resolving the document address, keyed by
       * file id. Reusing them keeps a document read at one body download
       * instead of two; a caller that finds no entry simply downloads.
       */
      bodies?: ReadonlyMap<string, Uint8Array>;
    }
  | { status: 'absent' }
  | { status: 'corrupt'; result: DataHomeCorruptCandidate }
  | { status: 'failure'; failure: DataHomeTransportFailure };

export type DriveDeleteResult =
  | { status: 'ok'; deleted: boolean }
  | { status: 'transport-failure'; failure: DataHomeTransportFailure };

export type DriveReplicaVerifier = (
  observations: readonly DataHomeReadResult[],
) => Promise<boolean>;

export interface DriveReplicaCycle {
  /**
   * Every same-address Drive object, in deterministic metadata order. The PD5
   * coordinator must authenticate and reconcile every observation before it
   * invokes `converge`.
   */
  readonly observations: readonly DataHomeReadResult[];
  /**
   * Publish already-authenticated/reconciled bytes to one canonical object,
   * then remove the other objects only after a verified read-back.
   */
  converge(envelope: Uint8Array): Promise<DataHomeWriteResult>;
  /**
   * Delete the single frozen object only after its complete revision/byte
   * observation is unchanged and the caller authenticates that exact copy
   * again. File and revision ids remain private to this adapter.
   */
  deleteIfUnchanged(verify: DriveReplicaVerifier): Promise<DriveDeleteResult>;
}

export interface DriveDataHome extends DataHome {
  readonly medium: 'drive';
  observeReplicas(): Promise<DriveReplicaCycle>;
}

export interface DriveDataHomeOptions {
  /** BetterTrack account id; hashed before it is used as a Drive selector. */
  accountId: string;
  /** Envelope-v2 address; supply all three together for a per-document home. */
  vaultId?: string;
  docId?: string;
  docKind?: VaultDocKind;
  tokens: Pick<GoogleDriveTokenClient, 'getAccessToken' | 'markExpired' | 'markRevoked'>;
  fetch?: typeof fetch;
  isOnline?: () => boolean;
  boundary?: () => string;
  /** Test/rehydration seam for an already-discovered visible folder id. */
  folderId?: string;
}

/**
 * One-file Google Drive adapter. New callers pass a per-vault document address;
 * the account-singleton form remains only until E9 retires envelope v1. File
 * ids and access tokens stay inside this browser boundary.
 */
export function createDriveDataHome(options: DriveDataHomeOptions): DriveDataHome {
  const accountId = options.accountId.trim();
  if (accountId.length === 0) throw new Error('A Drive vault account scope is required.');
  const request = options.fetch ?? globalThis.fetch;
  const isOnline =
    options.isOnline ??
    (() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  const boundary = options.boundary ?? (() => `bettertrack-${crypto.randomUUID()}`);
  const hasAnyDocAddress =
    options.vaultId != null || options.docId != null || options.docKind != null;
  const hasCompleteDocAddress =
    options.vaultId != null && options.docId != null && options.docKind != null;
  if (hasAnyDocAddress && !hasCompleteDocAddress) {
    throw new Error('A Drive document address requires vaultId, docId, and docKind together.');
  }
  const addressPromise = driveAddress(accountId, options.vaultId, options.docId, options.docKind);
  let cachedFolderId = options.folderId?.trim() || null;
  let cachedFileId: string | null = null;

  return {
    medium: 'drive',

    async read(): Promise<DataHomeReadResult> {
      const cached = await readCachedFile();
      if (cached) return cloneReadResult(cached);
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
      const address = await addressPromise;
      const outgoing = inspectOutgoing(envelope, address);
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
  };

  /**
   * Read the file this home last resolved, by id, skipping the list query.
   * A duplicate branch that outranks it therefore stays invisible to `read()`
   * until something lists again — which every path that can act on a duplicate
   * already does: `write()` lists for its CAS, and `observeReplicas()` (the
   * merge coordinator's entry point) is the one that resolves branches. Any
   * answer here is still a file that validated against this exact address.
   */
  async function readCachedFile(): Promise<DataHomeReadResult | null> {
    if (!cachedFileId) return null;
    const address = await addressPromise;
    const found = await getFile(cachedFileId);
    if (found.status === 'absent') return null;
    // The shortcut must never be worse than the path it replaces: a blipped
    // metadata request falls through to the list query, which reports its own
    // failure if the medium is really unreachable.
    if (found.status === 'failure') return null;
    if (found.status === 'corrupt') return found.result;
    if (address.mode === 'legacy') return download(found.file);
    const match = await fileMatchesAddress(found.file, address);
    if (match.status === 'failure') return transport(match.failure);
    if (match.status === 'corrupt') return match.result;
    if (match.status === 'skip') {
      cachedFileId = null;
      return null;
    }
    return download(found.file, match.envelope);
  }

  async function observeReplicas(): Promise<DriveReplicaCycle> {
    const found = await findFile();
    if (found.status === 'absent') {
      return fixedReplicaCycle([{ status: 'absent', medium: 'drive' }], async () => {
        const current = await findFile();
        return current.status === 'absent'
          ? { status: 'ok', deleted: false }
          : blockedDelete(current, 'Drive changed after the empty cleanup observation.');
      });
    }
    if (found.status === 'failure') {
      return fixedReplicaCycle([transport(found.failure)], async () => ({
        status: 'transport-failure',
        failure: found.failure,
      }));
    }
    if (found.status === 'corrupt') {
      return fixedReplicaCycle([found.result], async () => deletePending(found.result.message));
    }

    const observations = await Promise.all(
      found.files.map((file) => download(file, found.bodies?.get(file.id))),
    );
    return {
      observations: observations.map(cloneReadResult),
      converge: (envelope) => convergeDuplicateFiles(found.files, observations, envelope),
      deleteIfUnchanged: (verify) => deleteObservedFile(found.files, observations, verify),
    };
  }

  function fixedReplicaCycle(
    observations: readonly DataHomeReadResult[],
    deleteIfUnchanged: DriveReplicaCycle['deleteIfUnchanged'],
  ): DriveReplicaCycle {
    return {
      observations,
      async converge() {
        return transport({
          code: 'api-failure',
          message: 'Drive convergence requires more than one observed object.',
        });
      },
      deleteIfUnchanged,
    };
  }

  async function deleteObservedFile(
    frozenFiles: readonly ValidDriveFile[],
    frozenObservations: readonly DataHomeReadResult[],
    verify: DriveReplicaVerifier,
  ): Promise<DriveDeleteResult> {
    // Multi-object deletion cannot be atomic. Duplicate sets must first pass
    // through authenticated convergence, which leaves one canonical object.
    if (frozenFiles.length !== 1 || frozenObservations.length !== 1) {
      return deletePending('Drive cleanup requires one converged vault object.');
    }
    if (frozenObservations[0]?.status !== 'ok') {
      return deletePending('Drive cleanup requires one readable vault object.');
    }

    const beforeAuthentication = await findFile();
    if (
      beforeAuthentication.status !== 'ok' ||
      !sameFileSet(beforeAuthentication.files, frozenFiles)
    ) {
      return blockedDelete(beforeAuthentication, 'Drive changed before cleanup authentication.');
    }

    // The bodies the re-list already pulled for its address check are as fresh
    // as a second download of the same objects would be.
    const refreshedObservations = await Promise.all(
      beforeAuthentication.files.map((file) =>
        download(file, beforeAuthentication.bodies?.get(file.id)),
      ),
    );
    if (!sameReadableObservationSet(refreshedObservations, frozenObservations)) {
      return deletePending('Drive bytes changed before cleanup authentication.');
    }

    let authenticated = false;
    try {
      authenticated = await verify(refreshedObservations.map(cloneReadResult));
    } catch (cause) {
      return deletePending('Drive cleanup authentication failed.', cause);
    }
    if (!authenticated) {
      return deletePending('Drive cleanup authentication did not match the frozen copy.');
    }

    const beforeDelete = await findFile();
    if (beforeDelete.status !== 'ok' || !sameFileSet(beforeDelete.files, frozenFiles)) {
      return blockedDelete(beforeDelete, 'Drive changed at the cleanup barrier.');
    }
    const exact = await getFile(frozenFiles[0]!.id);
    if (
      exact.status !== 'ok' ||
      exact.files.length !== 1 ||
      !sameDriveFile(exact.file, frozenFiles[0]!)
    ) {
      return blockedDelete(exact, 'Drive changed at the cleanup barrier.');
    }
    const destructiveBarrier = await findFile();
    if (destructiveBarrier.status !== 'ok' || !sameFileSet(destructiveBarrier.files, frozenFiles)) {
      return blockedDelete(destructiveBarrier, 'Drive changed at the cleanup barrier.');
    }

    const deleted = await driveFetch(
      `${DRIVE_API}/files/${encodeURIComponent(frozenFiles[0]!.id)}`,
      { method: 'DELETE' },
    );
    if (deleted.status === 'failure') {
      return {
        status: 'transport-failure',
        failure: { ...deleted.failure, indeterminate: true },
      };
    }
    if (deleted.response.status === 404) {
      return deletePending('Drive changed while the frozen copy was being deleted.');
    }
    if (!deleted.response.ok) {
      return {
        status: 'transport-failure',
        failure: httpFailure(deleted.response, 'Drive vault deletion failed.', true),
      };
    }
    return { status: 'ok', deleted: true };
  }

  function blockedDelete(result: DriveFileResult, message: string): DriveDeleteResult {
    if (result.status === 'failure') {
      return { status: 'transport-failure', failure: result.failure };
    }
    if (result.status === 'corrupt') {
      return deletePending(result.result.message);
    }
    return deletePending(message);
  }

  function deletePending(message: string, cause?: unknown): DriveDeleteResult {
    return {
      status: 'transport-failure',
      failure: { code: 'api-failure', message, cause },
    };
  }

  async function findFile(): Promise<DriveFileResult> {
    const address = await addressPromise;
    const formatVersion = address.mode === 'doc' ? VAULT_DOC_FORMAT_VERSION : VAULT_FORMAT_VERSION;
    const filters = [
      appPropertyFilter('ownerDigest', address.ownerDigest),
      appPropertyFilter('formatVersion', String(formatVersion)),
      ...(address.vaultDigest ? [appPropertyFilter('vaultDigest', address.vaultDigest)] : []),
      ...(address.docKind ? [appPropertyFilter('docKind', address.docKind)] : []),
      'trashed = false',
    ];
    const params = new URLSearchParams({
      q: filters.join(' and '),
      fields: `files(${FILE_FIELDS})`,
      pageSize: DUPLICATE_SCAN_LIMIT,
    });
    const listed = await driveFetch(`${DRIVE_API}/files?${params.toString()}`);
    if (listed.status === 'failure') return listed;
    if (!listed.response.ok) {
      return {
        status: 'failure',
        failure: httpFailure(listed.response, 'Drive vault lookup failed.'),
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
          message: 'Drive vault lookup returned invalid JSON.',
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
          'Drive contains invalid vault metadata.',
        ),
      };
    }
    // `docId` is not an appProperty, so every document sharing (vaultDigest,
    // docKind) lands in this one page. Truncating it silently would let a real
    // object read `absent` and be re-created as a second live branch, so a
    // second page is refused loudly instead.
    const nextPageToken = (payload as { nextPageToken?: unknown }).nextPageToken;
    if (typeof nextPageToken === 'string' && nextPageToken.length > 0) {
      return {
        status: 'failure',
        failure: {
          code: 'api-failure',
          message: `Drive returned more than ${DUPLICATE_SCAN_LIMIT} vault objects for one address.`,
        },
      };
    }
    if (files.length === 0) return { status: 'absent' };

    const validated: ValidDriveFile[] = [];
    const bodies = new Map<string, Uint8Array>();
    for (const file of files) {
      const result = validateFile(file, address);
      // Trashed between the query and this response: not a live object, and
      // not a reason to hide the objects listed beside it.
      if (result.status === 'absent') continue;
      if (result.status !== 'ok') return result;
      if (address.mode === 'legacy') {
        validated.push(result.file);
        continue;
      }
      const match = await fileMatchesAddress(result.file, address);
      if (match.status === 'failure' || match.status === 'corrupt') return match;
      if (match.status === 'match') {
        validated.push(result.file);
        bodies.set(result.file.id, match.envelope);
      }
    }
    if (validated.length === 0) return { status: 'absent' };
    const ordered = [...validated].sort(compareDriveFiles);
    cachedFileId = ordered[0]!.id;
    return { status: 'ok', file: ordered[0]!, files: ordered, bodies };
  }

  async function getFile(id: string): Promise<DriveFileResult> {
    const address = await addressPromise;
    const response = await driveFetch(
      `${DRIVE_API}/files/${encodeURIComponent(id)}?fields=${encodeURIComponent(FILE_FIELDS)}`,
    );
    if (response.status === 'failure') return response;
    if (response.response.status === 404) return forgetIfCached(id, { status: 'absent' });
    if (!response.response.ok) {
      return {
        status: 'failure',
        failure: httpFailure(response.response, 'Drive metadata refresh failed.'),
      };
    }
    try {
      // A deleted *or* trashed file is absent; either way this id must stop
      // being the shortcut every later read takes.
      return forgetIfCached(id, validateFile(await response.response.json(), address));
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

  function forgetIfCached(id: string, result: DriveFileResult): DriveFileResult {
    if (result.status === 'absent' && cachedFileId === id) cachedFileId = null;
    return result;
  }

  /**
   * `docId` is deliberately absent from `appProperties` (§8: nothing but
   * digests on the object), so two documents that share (vaultDigest, docKind)
   * can be told apart only by their authenticated header. The bytes read here
   * are handed back so the caller does not fetch the same body twice.
   *
   * The cost is that a cold lookup pulls the body of every candidate sharing
   * (vaultDigest, docKind): warming a vault of N same-kind documents is O(N²)
   * downloads. A `docDigest` appProperty would keep the object digest-only and
   * make the list query exact; it changes the §8 object format, so it belongs
   * in the design note and with the per-document composition in E6 (#1416).
   */
  async function fileMatchesAddress(
    file: ValidDriveFile,
    address: DriveAddress,
  ): Promise<
    | { status: 'match'; envelope: Uint8Array }
    | { status: 'skip' }
    | Extract<DriveFileResult, { status: 'failure' | 'corrupt' }>
  > {
    const downloaded = await driveFetch(
      `${DRIVE_API}/files/${encodeURIComponent(file.id)}?alt=media`,
    );
    if (downloaded.status === 'failure') return downloaded;
    if (!downloaded.response.ok) {
      return {
        status: 'failure',
        failure: httpFailure(downloaded.response, 'Drive document-address lookup failed.'),
      };
    }
    try {
      const envelope = new Uint8Array(await downloaded.response.arrayBuffer());
      const inspected = inspectVaultDocEnvelope(envelope);
      return inspected.status === 'supported' &&
        inspected.header.vaultId === address.vaultId &&
        inspected.header.docId === address.docId &&
        inspected.header.docKind === address.docKind &&
        inspected.header.accountBinding === address.accountBinding
        ? { status: 'match', envelope }
        : { status: 'skip' };
    } catch (cause) {
      return {
        status: 'corrupt',
        result: corrupt(
          undefined,
          file.version,
          'corrupt-bytes',
          cause instanceof Error ? cause.message : 'Drive document bytes are corrupt.',
        ),
      };
    }
  }

  async function download(
    file: ValidDriveFile,
    prefetched?: Uint8Array,
  ): Promise<DataHomeReadResult> {
    let envelope: Uint8Array;
    if (prefetched) {
      envelope = prefetched;
    } else {
      const downloaded = await driveFetch(
        `${DRIVE_API}/files/${encodeURIComponent(file.id)}?alt=media`,
      );
      if (downloaded.status === 'failure') return transport(downloaded.failure);
      if (downloaded.response.status === 404) return { status: 'absent', medium: 'drive' };
      if (!downloaded.response.ok) {
        return transport(httpFailure(downloaded.response, 'Drive vault download failed.'));
      }
      try {
        envelope = new Uint8Array(await downloaded.response.arrayBuffer());
      } catch (cause) {
        return transport({
          code: 'api-failure',
          message: 'Drive vault bytes could not be read.',
          cause,
        });
      }
    }
    const inspected = inspectEnvelope(envelope, file, await addressPromise);
    if ('status' in inspected) return inspected;
    return { status: 'ok', medium: 'drive', envelope, info: inspected };
  }

  async function upload(
    envelope: Uint8Array,
    outgoing: DataHomeInfo,
    fileId: string | null,
  ): Promise<DataHomeWriteResult> {
    if (fileId === null) {
      // A second observation immediately before the first write narrows the
      // concurrent-create window. A race after this point is kept as a
      // duplicate branch and repaired by the authenticated merge coordinator.
      const rechecked = await findFile();
      if (rechecked.status === 'failure') return transport(rechecked.failure);
      if (rechecked.status === 'corrupt') return rechecked.result;
      if (rechecked.status === 'ok') {
        return {
          status: 'conflict',
          medium: 'drive',
          currentVersion: rechecked.file.version,
        };
      }
    }
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
    const address = await addressPromise;
    let folderId: string | null = null;
    if (fileId === null) {
      const ensured = await ensureFolder(address.ownerDigest);
      if (typeof ensured !== 'string') return ensured;
      folderId = ensured;
    }
    const marker = boundary();
    const metadata = {
      ...(fileId === null ? { name: address.fileName, parents: [folderId!] } : {}),
      appProperties:
        address.mode === 'doc'
          ? {
              ownerDigest: address.ownerDigest,
              vaultDigest: address.vaultDigest!,
              docKind: address.docKind!,
              docVersion: String(outgoing.version),
              formatVersion: String(VAULT_DOC_FORMAT_VERSION),
            }
          : {
              ownerDigest: address.ownerDigest,
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
    if (uploaded.status === 'failure' || !uploaded.response.ok) {
      // A create posts into the remembered visible folder. If that folder was
      // trashed or removed, every retry would keep addressing a dead parent
      // until the page reloads, so the cache is dropped and the next attempt
      // re-resolves (or re-creates) it.
      if (fileId === null) cachedFolderId = null;
      return uploaded.status === 'failure'
        ? { status: 'failure', failure: { ...uploaded.failure, indeterminate: true } }
        : {
            status: 'failure',
            failure: httpFailure(uploaded.response, 'Drive vault upload failed.', true),
          };
    }

    let acknowledged: DriveFileResult;
    try {
      acknowledged = validateFile(await uploaded.response.json(), address);
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
    cachedFileId = acknowledged.file.id;
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

  async function ensureFolder(ownerDigest: string): Promise<string | DriveFileResult> {
    if (cachedFolderId) return cachedFolderId;
    const query = new URLSearchParams({
      q: [
        `mimeType = '${DRIVE_FOLDER_MIME}'`,
        appPropertyFilter('ownerDigest', ownerDigest),
        appPropertyFilter('folderMarker', DRIVE_FOLDER_MARKER),
        'trashed = false',
      ].join(' and '),
      fields: 'files(id,appProperties)',
      pageSize: DUPLICATE_SCAN_LIMIT,
    });
    const listed = await driveFetch(`${DRIVE_API}/files?${query.toString()}`);
    if (listed.status === 'failure') return listed;
    if (!listed.response.ok) {
      return {
        status: 'failure',
        failure: httpFailure(listed.response, 'Drive folder lookup failed.'),
      };
    }
    let payload: { files?: unknown[] };
    try {
      payload = (await listed.response.json()) as { files?: unknown[] };
    } catch (cause) {
      return {
        status: 'failure',
        failure: { code: 'api-failure', message: 'Drive folder lookup failed.', cause },
      };
    }
    const existing = Array.isArray(payload.files)
      ? payload.files
          .map((file) =>
            typeof file === 'object' &&
            file !== null &&
            typeof (file as { id?: unknown }).id === 'string'
              ? ((file as { id: string }).id ?? null)
              : null,
          )
          .filter((id): id is string => Boolean(id))
          .sort()[0]
      : undefined;
    if (existing) {
      cachedFolderId = existing;
      return existing;
    }

    const created = await driveFetch(`${DRIVE_API}/files?fields=id%2CappProperties`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: DRIVE_FOLDER_NAME,
        mimeType: DRIVE_FOLDER_MIME,
        appProperties: { ownerDigest, folderMarker: DRIVE_FOLDER_MARKER },
      }),
    });
    if (created.status === 'failure') return created;
    if (!created.response.ok) {
      return {
        status: 'failure',
        failure: httpFailure(created.response, 'Drive folder creation failed.', true),
      };
    }
    try {
      const value = (await created.response.json()) as { id?: unknown };
      if (typeof value.id !== 'string' || value.id.length === 0) {
        throw new Error('missing folder id');
      }
      cachedFolderId = value.id;
      return value.id;
    } catch (cause) {
      return {
        status: 'failure',
        failure: {
          code: 'api-failure',
          message: 'Drive folder creation returned invalid metadata.',
          cause,
          indeterminate: true,
        },
      };
    }
  }

  async function convergeDuplicateFiles(
    frozenFiles: readonly ValidDriveFile[],
    observations: readonly DataHomeReadResult[],
    envelope: Uint8Array,
  ): Promise<DataHomeWriteResult> {
    const outgoing = inspectOutgoing(envelope, await addressPromise);
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
    if ((response.status === 400 || response.status === 401) && (await hasRevokedGrant(response))) {
      options.tokens.markRevoked();
      return {
        status: 'failure',
        failure: {
          code: 'revoked',
          httpStatus: response.status,
          message: 'The Google Drive connection was revoked. Sign in again to sync.',
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
          message: 'Google Drive file access was denied.',
        },
      };
    }
    return { status: 'ok', response };
  }
}

/**
 * Only an explicit `invalid_grant`/`invalid_token` envelope counts as proof of
 * revocation. Drive v3 answers BOTH an expired and a revoked token with a plain
 * 401 `UNAUTHENTICATED` / "Invalid Credentials", which cannot tell the two
 * apart, so that shape deliberately falls through to `markExpired()`: the
 * client silently re-mints, and GIS — the only party that actually knows —
 * reports `invalid_grant` on the token response and flips the connection to
 * `revoked` there (`gisTokenClient.ts`). Reading the ambiguous 401 as revocation
 * would strand a recoverable session behind a manual sign-in prompt.
 */
async function hasRevokedGrant(response: Response): Promise<boolean> {
  try {
    const payload = (await response.clone().json()) as {
      error?: string | { status?: string; message?: string };
      error_description?: string;
    };
    const detail =
      typeof payload.error === 'string'
        ? `${payload.error} ${payload.error_description ?? ''}`
        : `${payload.error?.status ?? ''} ${payload.error?.message ?? ''}`;
    return /invalid[_ -]?(grant|token)/iu.test(detail);
  } catch {
    return false;
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

function sameReadableObservationSet(
  current: readonly DataHomeReadResult[],
  frozen: readonly DataHomeReadResult[],
): boolean {
  return (
    current.length === frozen.length &&
    current.every((observation, index) => {
      const expected = frozen[index];
      return (
        observation.status === 'ok' &&
        expected?.status === 'ok' &&
        equalBytes(observation.envelope, expected.envelope) &&
        observation.info.version === expected.info.version &&
        observation.info.sizeBytes === expected.info.sizeBytes &&
        observation.info.updatedAt === expected.info.updatedAt
      );
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

function validateFile(value: unknown, address: DriveAddress): DriveFileResult {
  if (typeof value !== 'object' || value === null) {
    return malformedMetadata('Drive returned a non-object vault file.');
  }
  const file = value as Partial<DriveFile>;
  // The list query filters `trashed = false`, but `files.get` and `?alt=media`
  // keep answering for a file the owner moved to the Drive trash. A trashed
  // object is therefore not a live vault object anywhere: reporting it absent
  // keeps both resolution paths on the same answer, so a trashed copy surfaces
  // as "missing" instead of being read — or patched inside the trash — as live.
  if (file.trashed === true) return { status: 'absent' };
  const version = Number(
    address.mode === 'doc' ? file.appProperties?.docVersion : file.appProperties?.vaultVersion,
  );
  const formatVersion = Number(file.appProperties?.formatVersion);
  const sizeBytes = Number(file.size ?? 0);
  if (
    typeof file.id !== 'string' ||
    file.id.length === 0 ||
    typeof file.name !== 'string' ||
    !Number.isInteger(version) ||
    version < 1 ||
    formatVersion !== (address.mode === 'doc' ? VAULT_DOC_FORMAT_VERSION : VAULT_FORMAT_VERSION) ||
    file.appProperties?.ownerDigest !== address.ownerDigest ||
    (address.mode === 'doc' &&
      (file.appProperties?.vaultDigest !== address.vaultDigest ||
        file.appProperties?.docKind !== address.docKind)) ||
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
    ownerDigest: address.ownerDigest,
    vaultDigest: address.vaultDigest,
    docKind: address.docKind,
  };
  return { status: 'ok', file: valid, files: [valid] };
}

/** Stable, opaque selector. New files bind account + vault + document ids. */
export async function driveVaultFileName(
  accountId: string,
  vaultId?: string,
  docId?: string,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<string> {
  if ((vaultId == null) !== (docId == null)) {
    throw new Error('A Drive vault file name requires vaultId and docId together.');
  }
  const context =
    vaultId && docId
      ? `${DRIVE_VAULT_DOC_FILE_CONTEXT}${accountId}:${vaultId}:${docId}`
      : `${DRIVE_VAULT_FILE_CONTEXT}${accountId}`;
  const scoped = new TextEncoder().encode(context);
  const digest = new Uint8Array(await subtle.digest('SHA-256', scoped));
  return `${DRIVE_VAULT_FILE_PREFIX}${base64url(digest)}${DRIVE_VAULT_FILE_SUFFIX}`;
}

export async function driveOwnerDigest(
  accountId: string,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<string> {
  return sha256Base64Url(`${DRIVE_OWNER_CONTEXT}${accountId}`, subtle);
}

export async function driveVaultDigest(
  accountId: string,
  vaultId: string,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<string> {
  return sha256Base64Url(`${DRIVE_VAULT_DIGEST_CONTEXT}${accountId}:${vaultId}`, subtle);
}

async function driveAddress(
  accountId: string,
  vaultId?: string,
  docId?: string,
  docKind?: VaultDocKind,
): Promise<DriveAddress> {
  const ownerDigest = await driveOwnerDigest(accountId);
  if (vaultId && docId && docKind) {
    const [fileName, vaultDigest, accountBinding] = await Promise.all([
      driveVaultFileName(accountId, vaultId, docId),
      driveVaultDigest(accountId, vaultId),
      sha256Base64Url(`${VAULT_ACCOUNT_BINDING_INFO_PREFIX}${accountId}`),
    ]);
    return {
      mode: 'doc',
      accountId,
      vaultId,
      docId,
      docKind,
      fileName,
      ownerDigest,
      vaultDigest,
      accountBinding,
    };
  }
  return {
    mode: 'legacy',
    accountId,
    vaultId: null,
    docId: null,
    docKind: null,
    fileName: await driveVaultFileName(accountId),
    ownerDigest,
    vaultDigest: null,
    accountBinding: null,
  };
}

async function sha256Base64Url(
  value: string,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<string> {
  const digest = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return base64url(digest);
}

function appPropertyFilter(key: string, value: string): string {
  return `appProperties has { key='${key}' and value='${value}' }`;
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

function inspectOutgoing(
  envelope: Uint8Array,
  address: DriveAddress,
): DataHomeInfo | DataHomeCorruptCandidate {
  try {
    if (address.mode === 'doc') {
      const inspected = inspectVaultDocEnvelope(envelope);
      if (inspected.status === 'update-required') {
        return corrupt(
          envelope,
          null,
          'unsupported-version',
          'The Drive vault document was written by a newer app version.',
        );
      }
      if (
        inspected.header.vaultId !== address.vaultId ||
        inspected.header.docId !== address.docId ||
        inspected.header.docKind !== address.docKind ||
        inspected.header.accountBinding !== address.accountBinding
      ) {
        return corrupt(
          envelope,
          inspected.header.docVersion,
          'corrupt-bytes',
          'The encrypted Drive document does not match its account, vault, and document address.',
        );
      }
      return {
        medium: 'drive',
        version: inspected.header.docVersion,
        sizeBytes: envelope.byteLength,
        updatedAt: inspected.header.writtenAt,
      };
    }
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
  address: DriveAddress,
): DataHomeInfo | DataHomeCorruptCandidate {
  const inspected = inspectOutgoing(envelope, address);
  if ('status' in inspected) return inspected;
  if (
    inspected.version !== file.version ||
    file.formatVersion !==
      (address.mode === 'doc' ? VAULT_DOC_FORMAT_VERSION : VAULT_FORMAT_VERSION)
  ) {
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
