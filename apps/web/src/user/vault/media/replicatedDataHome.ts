import type { ParanoidVaultMediaState, VaultMedium } from '@bettertrack/contracts';

import { equalBytes } from '../bytes';
import type {
  DataHome,
  DataHomeInfoResult,
  DataHomeReadResult,
  DataHomeWriteOptions,
  DataHomeWriteResult,
} from '../dataHome';
import { inspectVaultEnvelope } from '../envelope';
import type { DriveDataHome } from '../drive';
import type { VaultSyncEngine, VaultSyncState } from '../sync';
import type { VaultMediaApi } from './mediaSwitcher';

interface ReplicaObservation {
  medium: VaultMedium;
  result: DataHomeReadResult;
}

interface ReconcileCycle {
  media: ParanoidVaultMediaState;
  observations: ReplicaObservation[];
  selectedIndex: number;
}

export interface ReplicatedVaultDataHome extends DataHome {
  /**
   * Freeze one set of per-medium CAS observations for a coordinator pass.
   * `write()` consumes only these tokens; it never discovers its own CAS state.
   */
  beginReconcileCycle(): Promise<void>;
  /**
   * Present the next distinct replica to the same PD5 engine. This is how
   * same-version and higher-version divergence enters its normal merge/retry
   * path instead of being repaired by "highest version wins".
   */
  advanceReplicaObservation(): boolean;
  /**
   * Preserve any selected-medium failure that was not repaired by the
   * coordinator pass. A healthy later replica must not mask missing,
   * unreachable, or corrupt earlier media.
   */
  finalizeReconcileState(state: VaultSyncState): VaultSyncState;
}

export interface ReplicatedVaultDataHomeOptions {
  api: Pick<VaultMediaApi, 'getState'>;
  server: DataHome;
  drive: DriveDataHome;
}

/**
 * Media-aware primary for the existing PD5 sync coordinator. The adapter never
 * merges decrypted documents. It presents each encrypted replica in turn, and
 * the coordinator performs its existing authenticated entity merge before a
 * write is acknowledged across every selected medium.
 */
export function createReplicatedVaultDataHome(
  options: ReplicatedVaultDataHomeOptions,
): ReplicatedVaultDataHome {
  const homes: Record<VaultMedium, DataHome> = {
    server: options.server,
    drive: options.drive,
  };
  let cycle: ReconcileCycle | null = null;

  return {
    medium: 'server',

    async beginReconcileCycle() {
      const response = await options.api.getState();
      if (response.privacyMode !== 'paranoid' || response.mediaState == null) {
        cycle = {
          media: fallbackMedia(),
          selectedIndex: 0,
          observations: [
            {
              medium: 'server',
              result: failure('Vault replication requires paranoid mode.'),
            },
          ],
        };
        return;
      }

      const media = response.mediaState;
      const results = await Promise.all(
        media.mediaSet.map(async (medium) => ({
          medium,
          result: await homes[medium].read(),
        })),
      );
      cycle = {
        media,
        selectedIndex: 0,
        observations: results,
      };
    },

    advanceReplicaObservation() {
      if (cycle == null || cycle.selectedIndex + 1 >= cycle.observations.length) return false;
      cycle.selectedIndex += 1;
      return true;
    },

    finalizeReconcileState(state) {
      return aggregateReplicaFailures(state, cycle?.observations ?? []);
    },

    async read(): Promise<DataHomeReadResult> {
      if (cycle == null) await this.beginReconcileCycle();
      return cloneRead(cycle!.observations[cycle!.selectedIndex]!.result);
    },

    async write(
      envelope: Uint8Array,
      { ifVersion }: DataHomeWriteOptions,
    ): Promise<DataHomeWriteResult> {
      if (cycle == null) {
        return writeFailure('Vault replica CAS observations are unavailable.');
      }
      const selected = cycle.observations[cycle.selectedIndex]!.result;
      const selectedVersion = observedVersion(selected);
      if (selectedVersion === undefined) {
        return writeFailure('The selected vault replica has no usable CAS version.');
      }
      if (selectedVersion !== ifVersion) {
        return {
          status: 'conflict',
          medium: 'server',
          currentVersion: highestObservedVersion(cycle.observations),
        };
      }

      // A first replica may cause the PD5 engine to prepare a push before the
      // later replicas have entered its authenticated merge path. Defer that
      // push without changing any medium; the outer coordinator immediately
      // advances to the next frozen observation. Only the final observation may
      // acknowledge a write across the whole selected set.
      if (cycle.selectedIndex + 1 < cycle.observations.length) {
        return writeFailure('Vault replica reconciliation is still in progress.');
      }

      // Do not start a partial replication when one selected medium was already
      // known to be unreachable/corrupt. The encrypted local candidate stays
      // pending until the next unlock or authorization gesture.
      for (const observation of cycle.observations) {
        if (observation.result.status === 'transport-failure') {
          return {
            status: 'transport-failure',
            medium: 'server',
            failure: observation.result.failure,
          };
        }
        if (observation.result.status === 'corrupt') {
          return {
            ...observation.result,
            medium: 'server',
          };
        }
      }

      let wroteAny = false;
      for (const observation of cycle.observations) {
        const before = observation.result;
        if (before.status === 'ok' && equalBytes(before.envelope, envelope)) continue;
        const expected = before.status === 'ok' ? before.info.version : null;
        const result = await homes[observation.medium].write(envelope, {
          ifVersion: expected,
        });
        if (result.status === 'conflict') {
          cycle = null;
          return {
            status: 'conflict',
            medium: 'server',
            currentVersion: result.currentVersion,
          };
        }
        if (result.status === 'corrupt') {
          cycle = null;
          return { ...result, medium: 'server' };
        }
        if (result.status === 'transport-failure') {
          cycle = null;
          return {
            status: 'transport-failure',
            medium: 'server',
            failure: {
              ...result.failure,
              indeterminate: wroteAny || result.failure.indeterminate,
            },
          };
        }
        wroteAny = true;
      }

      const inspected = inspectVaultEnvelope(envelope);
      if (inspected.status === 'update-required') {
        cycle = null;
        return {
          status: 'corrupt',
          medium: 'server',
          envelope: envelope.slice(),
          version: null,
          updatedAt: null,
          reason: 'unsupported-version',
          message: 'The replicated vault was written by a newer app version.',
        };
      }
      cycle = null;
      return {
        status: 'ok',
        medium: 'server',
        info: {
          medium: 'server',
          version: inspected.envelope.header.vaultVersion,
          sizeBytes: envelope.byteLength,
          updatedAt: inspected.envelope.header.writtenAt,
        },
      };
    },

    async info(): Promise<DataHomeInfoResult> {
      const read = await this.read();
      return read.status === 'ok' ? { status: 'ok', medium: read.medium, info: read.info } : read;
    },
  };
}

/**
 * Runs every selected replica through one existing sync-engine instance before
 * returning state to the UI. No intermediate "synced" result escapes while a
 * second divergent/offline replica remains unobserved.
 */
export function createReplicaReconcileCoordinator(
  engine: Pick<VaultSyncEngine, 'reconnect'>,
  primary: ReplicatedVaultDataHome,
): Pick<VaultSyncEngine, 'reconnect'> {
  return {
    async reconnect(): Promise<VaultSyncState> {
      await primary.beginReconcileCycle();
      let state = await engine.reconnect();
      while (
        state.status !== 'unresolved' &&
        state.status !== 'locked' &&
        primary.advanceReplicaObservation()
      ) {
        state = await engine.reconnect();
      }
      return primary.finalizeReconcileState(state);
    },
  };
}

function aggregateReplicaFailures(
  state: VaultSyncState,
  observations: readonly ReplicaObservation[],
): VaultSyncState {
  const failures = observations
    .map(replicaFailureMessage)
    .filter((message): message is string => message != null);
  if (failures.length === 0) return state;

  const lastFailure = [...new Set([state.lastFailure, ...failures].filter(Boolean))].join(' ');
  if (state.status !== 'synced') {
    return { ...state, lastFailure };
  }
  if (state.active == null) {
    return { ...state, status: 'corrupt', lastFailure };
  }
  return {
    ...state,
    status: 'pending-offline',
    pending: state.pending ?? state.active,
    lastFailure,
  };
}

function replicaFailureMessage(observation: ReplicaObservation): string | null {
  switch (observation.result.status) {
    case 'ok':
      return null;
    case 'absent':
      return `The selected ${observation.medium} vault replica is absent.`;
    case 'corrupt':
      return observation.result.message;
    case 'transport-failure':
      return observation.result.failure.message;
  }
}

function observedVersion(result: DataHomeReadResult): number | null | undefined {
  switch (result.status) {
    case 'ok':
      return result.info.version;
    case 'absent':
      return null;
    case 'corrupt':
      return result.version ?? undefined;
    case 'transport-failure':
      return undefined;
  }
}

function highestObservedVersion(observations: ReplicaObservation[]): number | null {
  const versions = observations
    .map(({ result }) => observedVersion(result))
    .filter((version): version is number => typeof version === 'number');
  return versions.length === 0 ? null : Math.max(...versions);
}

function cloneRead(result: DataHomeReadResult): DataHomeReadResult {
  return result.status === 'ok'
    ? {
        ...result,
        envelope: result.envelope.slice(),
        info: { ...result.info },
      }
    : result.status === 'corrupt'
      ? {
          ...result,
          envelope: result.envelope?.slice(),
        }
      : result;
}

function failure(message: string): Extract<DataHomeReadResult, { status: 'transport-failure' }> {
  return {
    status: 'transport-failure',
    medium: 'server',
    failure: { code: 'api-failure', message },
  };
}

function writeFailure(
  message: string,
): Extract<DataHomeWriteResult, { status: 'transport-failure' }> {
  return failure(message);
}

function fallbackMedia(): ParanoidVaultMediaState {
  return {
    mediaSet: ['server'],
    driveAttestedVersion: null,
    server: {
      disposition: 'empty',
      candidate: null,
      retired: null,
    },
  };
}
