import type { VaultDocumentV1 } from '@bettertrack/contracts';

import { decryptVaultDocument, type VaultKeyMaterial } from './crypto';
import type { DataHome, DataHomeMedium, DataHomeTransportFailure } from './dataHome';
import type { QuarantinedVaultCandidate, VaultQuarantineStore } from './quarantine';

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
  encrypt(document: VaultDocumentV1, vaultVersion: number): Promise<Uint8Array>;
  /** Runs only after the monotonic remote CAS succeeds. */
  activate(document: VaultDocumentV1, envelope: Uint8Array, version: number): Promise<void> | void;
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
      if (candidate.status !== 'available') {
        return {
          status: 'invalid-selection',
          reason: candidate.reason ?? 'Candidate is not readable.',
        };
      }

      let decrypted: Awaited<ReturnType<typeof decryptVaultDocument>>;
      try {
        decrypted = await decryptVaultDocument(candidate.envelope, options.vaultKey);
      } catch (cause) {
        return {
          status: 'invalid-selection',
          reason: cause instanceof Error ? cause.message : 'Candidate could not be decrypted.',
        };
      }
      if (candidate.version !== null && candidate.version !== decrypted.header.vaultVersion) {
        return {
          status: 'invalid-selection',
          reason: 'Candidate metadata does not match its authenticated vault version.',
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

/** The only two candidate sources shipped by this issue. */
export function createRestoreCandidateSources(
  quarantine: VaultQuarantineStore,
  server: DataHome,
): readonly [RestoreCandidateSource, RestoreCandidateSource] {
  return [
    createQuarantinedRestoreCandidateSource(quarantine),
    createCurrentServerRestoreCandidateSource(server),
  ];
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
