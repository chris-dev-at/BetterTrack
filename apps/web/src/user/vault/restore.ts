import {
  parseVaultEtag,
  VAULT_HISTORY_CREATED_AT_HEADER,
  VAULT_HISTORY_MEDIUM_HEADER,
  VAULT_HISTORY_PAGE_MAX,
  VAULT_HISTORY_SIZE_BYTES_HEADER,
  vaultHistoryListResponseSchema,
  vaultHistoryMetadataSchema,
  type VaultDocument,
  type VaultHistoryMetadata,
} from '@bettertrack/contracts';

import { apiBaseUrl } from '../../lib/runtimeConfig';
import { decryptVaultDocument, type VaultKeyMaterial } from './crypto';
import type { DataHome, DataHomeMedium, DataHomeTransportFailure } from './dataHome';
import { inspectVaultEnvelope } from './envelope';
import type { QuarantinedVaultCandidate, VaultQuarantineStore } from './quarantine';

const VAULT_HISTORY_PATH = '/vault/history';
const SERVER_HISTORY_SOURCE = 'server-history';
// Match the API's hard retention ceiling while also bounding malformed cursor
// chains that never terminate or return fewer items than a real page.
const SERVER_HISTORY_CANDIDATE_MAX = 1_000;
const SERVER_HISTORY_PAGE_COUNT_MAX = Math.ceil(
  SERVER_HISTORY_CANDIDATE_MAX / VAULT_HISTORY_PAGE_MAX,
);

export type RestoreCandidateStatus = 'available' | 'corrupt' | 'unreadable' | 'unsupported';

export interface RestoreCandidate {
  id: string;
  source: string;
  medium: DataHomeMedium;
  envelope: Uint8Array;
  version: number | null;
  updatedAt: string | null;
  status: RestoreCandidateStatus;
  reason?: string;
}

export type RestoreCandidateSourceResult =
  | { status: 'ok'; source: string; medium: DataHomeMedium; candidates: RestoreCandidate[] }
  | { status: 'absent'; source: string; medium: DataHomeMedium }
  | {
      status: 'corrupt';
      source: string;
      medium: DataHomeMedium;
      candidate?: RestoreCandidate;
      reason: string;
    }
  | {
      status: 'transport-failure';
      source: string;
      medium: DataHomeMedium;
      failure: DataHomeTransportFailure;
    };

/** Future blind history sources plug into this seam without picker changes. */
export interface RestoreCandidateSource {
  readonly id: string;
  readonly medium: DataHomeMedium;
  list(): Promise<RestoreCandidateSourceResult>;
}

export interface RestoreCandidateList {
  candidates: RestoreCandidate[];
  sources: RestoreCandidateSourceResult[];
}

export interface RestorePicker {
  listCandidates(): Promise<RestoreCandidateList>;
  restore(candidate: RestoreCandidate | null, options: RestoreOptions): Promise<RestoreResult>;
}

export interface RestoreOptions {
  vaultKey: VaultKeyMaterial;
  /** Exact current destination version previously observed by the caller. */
  activeVersion: number | null;
  encrypt(document: VaultDocument, vaultVersion: number): Promise<Uint8Array>;
  /** Runs only after the monotonic remote CAS succeeds. */
  activate(document: VaultDocument, envelope: Uint8Array, version: number): Promise<void> | void;
}

export type RestoreResult =
  | { status: 'restored'; version: number }
  | { status: 'cancelled' }
  | { status: 'invalid-selection'; reason: string }
  | { status: 'conflict'; currentVersion: number | null }
  | { status: 'transport-failure'; message: string };

/**
 * Validate and decrypt first, then write a new monotonic version through the
 * caller's exact CAS token. No failed selection can activate local plaintext.
 */
export function createRestorePicker(
  sources: readonly RestoreCandidateSource[],
  destination: DataHome,
): RestorePicker {
  return {
    async listCandidates() {
      const results = await Promise.all(sources.map((source) => source.list()));
      return {
        sources: results,
        candidates: results
          .flatMap((result) =>
            result.status === 'ok'
              ? result.candidates
              : result.status === 'corrupt' && result.candidate != null
                ? [result.candidate]
                : [],
          )
          .sort(compareCandidates),
      };
    },

    async restore(candidate, options) {
      if (candidate === null) return { status: 'cancelled' };
      if (candidate.status === 'unsupported') {
        return {
          status: 'invalid-selection',
          reason: candidate.reason ?? 'Candidate is not readable.',
        };
      }

      // Quarantine status records why a previous observation failed. A later
      // key or authenticated envelope validation may recover unreadable bytes
      // or bytes retained alongside corrupt external version metadata.
      let decrypted: Awaited<ReturnType<typeof decryptVaultDocument>>;
      try {
        decrypted = await decryptVaultDocument(candidate.envelope, options.vaultKey);
      } catch (cause) {
        return {
          status: 'invalid-selection',
          reason: cause instanceof Error ? cause.message : 'Candidate could not be decrypted.',
        };
      }

      const version = Math.max(decrypted.header.vaultVersion, options.activeVersion ?? 0) + 1;
      let envelope: Uint8Array;
      try {
        envelope = await options.encrypt(decrypted.document, version);
      } catch (cause) {
        return {
          status: 'invalid-selection',
          reason: cause instanceof Error ? cause.message : 'Candidate could not be re-encrypted.',
        };
      }

      const written = await destination.write(envelope, {
        ifVersion: options.activeVersion,
      });
      switch (written.status) {
        case 'ok':
          await options.activate(decrypted.document, envelope, version);
          return { status: 'restored', version };
        case 'conflict':
          return { status: 'conflict', currentVersion: written.currentVersion };
        case 'corrupt':
          return { status: 'invalid-selection', reason: written.message };
        case 'transport-failure':
          return { status: 'transport-failure', message: written.failure.message };
      }
    },
  };
}

export function createQuarantinedRestoreCandidateSource(
  store: VaultQuarantineStore,
): RestoreCandidateSource {
  return {
    id: 'quarantined-local',
    medium: 'local',
    async list() {
      try {
        return {
          status: 'ok',
          source: 'quarantined-local',
          medium: 'local',
          candidates: (await store.list()).map(toRestoreCandidate),
        };
      } catch (cause) {
        return {
          status: 'transport-failure',
          source: 'quarantined-local',
          medium: 'local',
          failure: {
            message: 'Could not read quarantined vault candidates.',
            cause,
          },
        };
      }
    },
  };
}

/** Current server blob only; blind server history belongs to #745. */
export function createCurrentServerRestoreCandidateSource(
  server: DataHome,
): RestoreCandidateSource {
  return {
    id: 'current-server',
    medium: 'server',
    async list() {
      const result = await server.read();
      switch (result.status) {
        case 'ok':
          return {
            status: 'ok',
            source: 'current-server',
            medium: 'server',
            candidates: [
              {
                id: `server-current-${result.info.version}`,
                source: 'current-server',
                medium: 'server',
                envelope: result.envelope,
                version: result.info.version,
                updatedAt: result.info.updatedAt,
                status: 'available',
              },
            ],
          };
        case 'corrupt':
          return {
            status: 'corrupt',
            source: 'current-server',
            medium: 'server',
            candidate:
              result.envelope == null
                ? undefined
                : {
                    id: `server-current-corrupt-${result.version ?? 'unknown'}`,
                    source: 'current-server',
                    medium: 'server',
                    envelope: result.envelope,
                    version: result.version,
                    updatedAt: result.updatedAt,
                    status: result.reason === 'unsupported-version' ? 'unsupported' : 'corrupt',
                    reason: result.message,
                  },
            reason: result.message,
          };
        case 'absent':
          return { status: 'absent', source: 'current-server', medium: 'server' };
        case 'transport-failure':
          return {
            status: 'transport-failure',
            source: 'current-server',
            medium: 'server',
            failure: result.failure,
          };
      }
    },
  };
}

export interface ServerHistoryRestoreCandidateSourceOptions {
  url?: string;
  fetch?: typeof fetch;
}

type ServerHistoryCandidateRead =
  | { status: 'ok'; candidate: RestoreCandidate }
  | { status: 'transport-failure'; failure: DataHomeTransportFailure };

/**
 * Blind retained server history. The list response carries safe metadata only;
 * each candidate body remains opaque bytes until the picker validates and
 * decrypts the selected envelope.
 */
export function createServerHistoryRestoreCandidateSource(
  options: ServerHistoryRestoreCandidateSourceOptions = {},
): RestoreCandidateSource {
  const url = options.url ?? `${apiBaseUrl()}${VAULT_HISTORY_PATH}`;
  const request = options.fetch ?? globalThis.fetch;

  return {
    id: SERVER_HISTORY_SOURCE,
    medium: 'server',
    async list() {
      const metadata: VaultHistoryMetadata[] = [];
      const seenVersions = new Set<number>();
      const seenCursors = new Set<number>();
      let cursor: number | null = null;

      for (
        let pageCount = 0;
        pageCount < SERVER_HISTORY_PAGE_COUNT_MAX && metadata.length < SERVER_HISTORY_CANDIDATE_MAX;
        pageCount += 1
      ) {
        const limit = Math.min(
          VAULT_HISTORY_PAGE_MAX,
          SERVER_HISTORY_CANDIDATE_MAX - metadata.length,
        );
        let response: Response;
        try {
          response = await request(serverHistoryPageUrl(url, limit, cursor), {
            credentials: 'include',
          });
        } catch (cause) {
          return historyTransportFailure('GET vault history failed.', cause);
        }

        if (response.status === 404) {
          return { status: 'absent', source: SERVER_HISTORY_SOURCE, medium: 'server' };
        }
        if (!response.ok) {
          return historyTransportFailure('GET vault history failed.', undefined, response.status);
        }

        let page: ReturnType<typeof vaultHistoryListResponseSchema.parse>;
        try {
          page = vaultHistoryListResponseSchema.parse(await response.json());
        } catch (cause) {
          return historyMetadataCorrupt(cause);
        }

        for (const item of page.items) {
          if (metadata.length >= SERVER_HISTORY_CANDIDATE_MAX) break;
          if (seenVersions.has(item.version)) {
            return historyMetadataCorrupt(new Error(`duplicate version ${item.version}`));
          }
          seenVersions.add(item.version);
          metadata.push(item);
        }

        if (page.nextCursor === null) break;
        if (seenCursors.has(page.nextCursor)) {
          return historyMetadataCorrupt(new Error(`repeated cursor ${page.nextCursor}`));
        }
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }

      const candidates: RestoreCandidate[] = [];
      for (const item of metadata) {
        const loaded = await readServerHistoryCandidate(url, item, request);
        if (loaded.status === 'transport-failure') {
          return {
            status: 'transport-failure',
            source: SERVER_HISTORY_SOURCE,
            medium: 'server',
            failure: loaded.failure,
          };
        }
        candidates.push(loaded.candidate);
      }
      return {
        status: 'ok',
        source: SERVER_HISTORY_SOURCE,
        medium: 'server',
        candidates,
      };
    },
  };
}

/**
 * Assemble the two existing sources plus the history source when its transport
 * is available. Keeping the third argument optional preserves existing callers
 * while the restore surface is integrated incrementally.
 */
export function createRestoreCandidateSources(
  quarantine: VaultQuarantineStore,
  server: DataHome,
  history?: RestoreCandidateSource,
): readonly RestoreCandidateSource[] {
  const sources: RestoreCandidateSource[] = [
    createQuarantinedRestoreCandidateSource(quarantine),
    createCurrentServerRestoreCandidateSource(server),
  ];
  if (history) sources.push(history);
  return sources;
}

function serverHistoryPageUrl(baseUrl: string, limit: number, cursor: number | null): string {
  const separator = baseUrl.includes('?') ? '&' : '?';
  const cursorQuery = cursor === null ? '' : `&cursor=${cursor}`;
  return `${baseUrl}${separator}limit=${limit}${cursorQuery}`;
}

async function readServerHistoryCandidate(
  baseUrl: string,
  metadata: VaultHistoryMetadata,
  request: typeof fetch,
): Promise<ServerHistoryCandidateRead> {
  let response: Response;
  try {
    response = await request(`${baseUrl.replace(/\/$/, '')}/${metadata.version}`, {
      credentials: 'include',
    });
  } catch (cause) {
    return {
      status: 'transport-failure',
      failure: { message: 'GET historical vault blob failed.', cause },
    };
  }
  if (!response.ok) {
    return {
      status: 'transport-failure',
      failure: {
        message: 'GET historical vault blob failed.',
        httpStatus: response.status,
      },
    };
  }

  let envelope: Uint8Array;
  try {
    envelope = new Uint8Array(await response.arrayBuffer());
  } catch (cause) {
    return {
      status: 'transport-failure',
      failure: { message: 'Could not read historical vault bytes.', cause },
    };
  }

  const external = vaultHistoryMetadataSchema.safeParse({
    version: parseVaultEtag(response.headers.get('ETag')),
    createdAt: response.headers.get(VAULT_HISTORY_CREATED_AT_HEADER),
    sizeBytes: Number(response.headers.get(VAULT_HISTORY_SIZE_BYTES_HEADER)),
    medium: response.headers.get(VAULT_HISTORY_MEDIUM_HEADER),
  });
  const baseCandidate = {
    id: `server-history-${metadata.version}`,
    source: SERVER_HISTORY_SOURCE,
    medium: 'server' as const,
    envelope,
    version: metadata.version,
    updatedAt: metadata.createdAt,
  };
  if (
    !external.success ||
    external.data.version !== metadata.version ||
    external.data.createdAt !== metadata.createdAt ||
    external.data.sizeBytes !== metadata.sizeBytes ||
    envelope.byteLength !== metadata.sizeBytes
  ) {
    return {
      status: 'ok',
      candidate: {
        ...baseCandidate,
        status: 'corrupt',
        reason: 'Historical vault response metadata does not match its list entry.',
      },
    };
  }

  try {
    const inspected = inspectVaultEnvelope(envelope);
    if (inspected.status === 'update-required') {
      return {
        status: 'ok',
        candidate: {
          ...baseCandidate,
          status: 'unsupported',
          reason: 'The historical vault was written by a newer app version.',
        },
      };
    }
    if (inspected.envelope.header.vaultVersion !== metadata.version) {
      return {
        status: 'ok',
        candidate: {
          ...baseCandidate,
          status: 'corrupt',
          reason: 'Historical vault envelope version does not match its metadata.',
        },
      };
    }
    return { status: 'ok', candidate: { ...baseCandidate, status: 'available' } };
  } catch (cause) {
    return {
      status: 'ok',
      candidate: {
        ...baseCandidate,
        status: 'corrupt',
        reason:
          cause instanceof Error
            ? `Historical vault envelope is invalid: ${cause.message}`
            : 'Historical vault envelope is invalid.',
      },
    };
  }
}

function historyMetadataCorrupt(
  cause: unknown,
): Extract<RestoreCandidateSourceResult, { status: 'corrupt' }> {
  return {
    status: 'corrupt',
    source: SERVER_HISTORY_SOURCE,
    medium: 'server',
    reason:
      cause instanceof Error
        ? `Vault history metadata is invalid: ${cause.message}`
        : 'Vault history metadata is invalid.',
  };
}

function historyTransportFailure(
  message: string,
  cause?: unknown,
  httpStatus?: number,
): Extract<RestoreCandidateSourceResult, { status: 'transport-failure' }> {
  return {
    status: 'transport-failure',
    source: SERVER_HISTORY_SOURCE,
    medium: 'server',
    failure: { message, cause, httpStatus },
  };
}

function toRestoreCandidate(candidate: QuarantinedVaultCandidate): RestoreCandidate {
  return {
    id: candidate.id,
    source: 'quarantined-local',
    medium: candidate.medium,
    envelope: candidate.envelope,
    version: candidate.version,
    updatedAt: candidate.updatedAt,
    status: candidate.status,
    reason: candidate.reason,
  };
}

function compareCandidates(left: RestoreCandidate, right: RestoreCandidate): number {
  const version = (right.version ?? -1) - (left.version ?? -1);
  if (version !== 0) return version;
  return (
    (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '') || left.id.localeCompare(right.id)
  );
}
