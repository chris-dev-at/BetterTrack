import type { VaultDocumentV1 } from '@bettertrack/contracts';

import type { DataHome, DataHomeMedium } from './dataHome';
import { decryptVaultDocument, type VaultKeyMaterial } from './crypto';
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

/** Future server-history and Drive sources plug into this without picker changes. */
export interface RestoreCandidateSource {
  readonly id: string;
  list(): Promise<RestoreCandidate[]>;
}

export interface RestorePicker {
  listCandidates(): Promise<RestoreCandidate[]>;
  restore(candidate: RestoreCandidate, options: RestoreOptions): Promise<RestoreResult>;
}

export interface RestoreOptions {
  vaultKey: VaultKeyMaterial;
  /** The currently active remote version; restore writes only its monotonic successor. */
  activeVersion: number | null;
  /** Re-encrypts the validated document at `max(candidate, active) + 1`. */
  encrypt(document: VaultDocumentV1, vaultVersion: number): Promise<Uint8Array>;
  /** Called only after the remote CAS write succeeds. */
  activate(document: VaultDocumentV1, envelope: Uint8Array, version: number): Promise<void> | void;
}

export type RestoreResult =
  | { status: 'restored'; version: number }
  | { status: 'cancelled' }
  | { status: 'invalid-selection'; reason: string }
  | { status: 'conflict'; currentVersion: number | null }
  | { status: 'transport-failure'; message: string };

/**
 * Restore is deliberately validate-first then monotonic-CAS-write. A wrong key,
 * corrupt candidate, unsupported envelope, cancellation, or CAS loss cannot
 * mutate active in-memory/local state.
 */
export function createRestorePicker(
  sources: readonly RestoreCandidateSource[],
  destination: DataHome,
): RestorePicker {
  return {
    async listCandidates() {
      const candidates = (await Promise.all(sources.map((source) => source.list()))).flat();
      return candidates.sort(compareCandidates);
    },

    async restore(candidate, options) {
      if (candidate.status !== 'available') {
        return {
          status: 'invalid-selection',
          reason: candidate.reason ?? 'Candidate is not readable.',
        };
      }
      let document: VaultDocumentV1;
      try {
        document = (await decryptVaultDocument(candidate.envelope, options.vaultKey)).document;
      } catch (cause) {
        return {
          status: 'invalid-selection',
          reason: cause instanceof Error ? cause.message : 'Candidate could not be decrypted.',
        };
      }
      const version = Math.max(candidate.version ?? 0, options.activeVersion ?? 0) + 1;
      let envelope: Uint8Array;
      try {
        envelope = await options.encrypt(document, version);
      } catch (cause) {
        return {
          status: 'invalid-selection',
          reason: cause instanceof Error ? cause.message : 'Candidate could not be re-encrypted.',
        };
      }
      const written = await destination.write(envelope, { ifVersion: options.activeVersion });
      switch (written.status) {
        case 'ok':
          await options.activate(document, envelope, version);
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
    async list() {
      const candidates = await store.list();
      return candidates.map(toRestoreCandidate);
    },
  };
}

/** The current server blob is a source; server-history requires a later API contract. */
export function createCurrentServerRestoreCandidateSource(
  server: DataHome,
): RestoreCandidateSource {
  return {
    id: 'current-server',
    async list() {
      const result = await server.read();
      switch (result.status) {
        case 'ok':
          return [
            {
              id: `server-current-${result.info.version}`,
              source: 'current-server',
              medium: 'server',
              envelope: result.envelope,
              version: result.info.version,
              updatedAt: result.info.updatedAt,
              status: 'available',
            },
          ];
        case 'corrupt':
          return result.envelope == null
            ? []
            : [
                {
                  id: `server-current-corrupt-${result.version ?? 'unknown'}`,
                  source: 'current-server',
                  medium: 'server',
                  envelope: result.envelope,
                  version: result.version,
                  updatedAt: result.updatedAt,
                  status: result.reason === 'unsupported-version' ? 'unsupported' : 'corrupt',
                  reason: result.message,
                },
              ];
        case 'absent':
        case 'transport-failure':
          return [];
      }
    },
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
    status: candidate.status === 'unsupported' ? 'unsupported' : candidate.status,
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
