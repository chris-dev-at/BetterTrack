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
import type { DriveDataHome, DriveReplicaCycle } from '../drive';
import type { VaultSyncEngine, VaultSyncState } from '../sync';
import type { VaultMediaApi } from './mediaSwitcher';

interface ReplicaObservation {
  medium: VaultMedium;
  result: DataHomeReadResult;
  synthetic?: 'drive-convergence';
}

interface ReconcileCycle {
  media: ParanoidVaultMediaState;
  observations: ReplicaObservation[];
  selectedIndex: number;
  driveReplicaCycle: DriveReplicaCycle | null;
}

const MAX_MUTATION_PREPARATION_ATTEMPTS = 4;

export interface ReplicatedVaultDataHome extends DataHome {
  /**
   * Freeze one set of per-medium CAS observations for a coordinator pass.
   * `write()` consumes only these tokens; it never discovers its own CAS state.
   */
  beginReconcileCycle(): Promise<void>;
  /** Whether the current frozen observations are still available for one write. */
  hasReconcileCycle(): boolean;
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

  async function readMediaState(): Promise<ParanoidVaultMediaState | null> {
    const response = await options.api.getState();
    return response.privacyMode === 'paranoid' ? response.mediaState : null;
  }

  async function verifyReplicatedWrite(
    frozen: ReconcileCycle,
    envelope: Uint8Array,
  ): Promise<DataHomeWriteResult> {
    let beforeRead: ParanoidVaultMediaState | null;
    try {
      beforeRead = await readMediaState();
    } catch (cause) {
      cycle = null;
      return replicationPending('Could not revalidate the selected vault media.', cause);
    }
    if (beforeRead == null || !sameMediaSet(beforeRead.mediaSet, frozen.media.mediaSet)) {
      cycle = null;
      return replicationPending('The selected vault media changed during replication.');
    }

    let batches: Array<{ medium: VaultMedium; results: readonly DataHomeReadResult[] }>;
    try {
      batches = await Promise.all(
        beforeRead.mediaSet.map(async (medium) =>
          medium === 'drive'
            ? {
                medium,
                results: (await options.drive.observeReplicas()).observations,
              }
            : {
                medium,
                results: [await homes[medium].read()],
              },
        ),
      );
    } catch (cause) {
      cycle = null;
      return replicationPending('Could not verify the replicated vault write.', cause);
    }
    const driveBatch = batches.find(({ medium }) => medium === 'drive');
    if (driveBatch != null && driveBatch.results.length !== 1) {
      cycle = null;
      return replicationPending(
        'The Drive vault has not converged to one completely observed object.',
      );
    }
    const observations = batches.flatMap(({ medium, results }) =>
      results.map((result) => ({ medium, result })),
    );

    let afterRead: ParanoidVaultMediaState | null;
    try {
      afterRead = await readMediaState();
    } catch (cause) {
      cycle = null;
      return replicationPending('Could not revalidate the selected vault media.', cause);
    }
    if (
      afterRead == null ||
      !sameMediaSet(afterRead.mediaSet, frozen.media.mediaSet) ||
      !sameMediaSet(afterRead.mediaSet, beforeRead.mediaSet)
    ) {
      cycle = null;
      return replicationPending('The selected vault media changed during replication.');
    }

    for (const observation of observations) {
      if (
        observation.result.status !== 'ok' ||
        !equalBytes(observation.result.envelope, envelope)
      ) {
        cycle = null;
        return replicationPending(replicaVerificationFailure(observation));
      }
    }

    cycle = null;
    const inspected = inspectVaultEnvelope(envelope);
    if (inspected.status === 'update-required') {
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
  }

  return {
    medium: 'server',

    async beginReconcileCycle() {
      const media = await readMediaState();
      if (media == null) {
        cycle = {
          media: fallbackMedia(),
          selectedIndex: 0,
          driveReplicaCycle: null,
          observations: [
            {
              medium: 'server',
              result: failure('Vault replication requires paranoid mode.'),
            },
          ],
        };
        return;
      }

      const batches = await Promise.all(
        media.mediaSet.map(async (medium) => {
          if (medium === 'server') {
            return {
              medium,
              driveReplicas: null,
              result: await homes.server.read(),
            };
          }
          const driveReplicas = await options.drive.observeReplicas();
          return { medium, driveReplicas, result: null };
        }),
      );
      const observations: ReplicaObservation[] = [];
      let driveReplicaCycle: DriveReplicaCycle | null = null;
      for (const batch of batches) {
        if (batch.driveReplicas == null) {
          observations.push({ medium: batch.medium, result: batch.result! });
          continue;
        }
        observations.push(
          ...batch.driveReplicas.observations.map((result) => ({
            medium: batch.medium,
            result,
          })),
        );
        if (batch.driveReplicas.observations.length > 1) {
          driveReplicaCycle = batch.driveReplicas;
          // The preceding candidates are read-only merge inputs. This final
          // absent observation makes the PD5 engine publish its authenticated
          // convergence exactly once through DriveReplicaCycle.converge().
          observations.push({
            medium: 'drive',
            result: { status: 'absent', medium: 'drive' },
            synthetic: 'drive-convergence',
          });
        }
      }
      cycle = {
        media,
        selectedIndex: 0,
        observations,
        driveReplicaCycle,
      };
    },

    hasReconcileCycle() {
      return cycle != null;
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
      const frozen = cycle;
      const selected = frozen.observations[frozen.selectedIndex]!.result;
      const selectedVersion = observedVersion(selected);
      if (selectedVersion === undefined) {
        return writeFailure('The selected vault replica has no usable CAS version.');
      }
      if (selectedVersion !== ifVersion) {
        return {
          status: 'conflict',
          medium: 'server',
          currentVersion: highestObservedVersion(frozen.observations),
        };
      }

      // A first replica may cause the PD5 engine to prepare a push before the
      // later replicas have entered its authenticated merge path. Defer that
      // push without changing any medium; the outer coordinator immediately
      // advances to the next frozen observation. Only the final observation may
      // acknowledge a write across the whole selected set.
      if (frozen.selectedIndex + 1 < frozen.observations.length) {
        return writeFailure('Vault replica reconciliation is still in progress.');
      }

      // Do not start a partial replication when one selected medium was already
      // known to be unreachable/corrupt. The encrypted local candidate stays
      // pending until the next unlock or authorization gesture.
      for (const observation of frozen.observations) {
        if (observation.synthetic === 'drive-convergence') continue;
        if (observation.medium === 'drive' && frozen.driveReplicaCycle != null) {
          // Corrupt duplicate bytes have already been quarantined by the PD5
          // engine and can be replaced after another candidate authenticates.
          // A transport failure leaves an unobserved branch, so convergence
          // must remain non-destructive.
          if (observation.result.status === 'transport-failure') {
            return {
              status: 'transport-failure',
              medium: 'server',
              failure: observation.result.failure,
            };
          }
          continue;
        }
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
      for (const medium of frozen.media.mediaSet) {
        const mediumObservations = frozen.observations.filter(
          (observation) => observation.medium === medium && observation.synthetic == null,
        );
        const before = mediumObservations[0]!.result;
        if (
          !(medium === 'drive' && frozen.driveReplicaCycle != null) &&
          before.status === 'ok' &&
          equalBytes(before.envelope, envelope)
        ) {
          continue;
        }
        const expected = before.status === 'ok' ? before.info.version : null;
        const result =
          medium === 'drive' && frozen.driveReplicaCycle != null
            ? await frozen.driveReplicaCycle.converge(envelope)
            : await homes[medium].write(envelope, { ifVersion: expected });
        if (result.status === 'conflict') {
          cycle = null;
          return replicationPending(`The ${medium} vault replica changed during replication.`);
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
      return verifyReplicatedWrite(frozen, envelope);
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
  engine: Pick<VaultSyncEngine, 'state' | 'reconnect' | 'mutate'>,
  primary: ReplicatedVaultDataHome,
): Pick<VaultSyncEngine, 'state' | 'reconnect' | 'mutate'> {
  // The last single-replica engine pass is an implementation detail. Only this
  // finalized aggregate may escape through a return value or a later state read.
  let state = engine.state;
  let operationTail = Promise.resolve();

  function snapshot(): VaultSyncState {
    return { ...state };
  }

  function publish(next: VaultSyncState): VaultSyncState {
    state = primary.finalizeReconcileState(next);
    return snapshot();
  }

  function serialize(operation: () => Promise<VaultSyncState>): Promise<VaultSyncState> {
    const result = operationTail.then(operation, operation);
    operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function reconcileFreshCycle(): Promise<VaultSyncState> {
    await primary.beginReconcileCycle();
    let next = await engine.reconnect();
    while (next.status !== 'unresolved' && primary.advanceReplicaObservation()) {
      next = await engine.reconnect();
    }
    return next;
  }

  return {
    get state() {
      return snapshot();
    },

    reconnect(): Promise<VaultSyncState> {
      return serialize(async () => {
        try {
          return publish(await reconcileFreshCycle());
        } catch (cause) {
          publish(engine.state);
          throw cause;
        }
      });
    },

    mutate(mutator): Promise<VaultSyncState> {
      return serialize(async () => {
        try {
          for (let attempt = 0; attempt < MAX_MUTATION_PREPARATION_ATTEMPTS; attempt += 1) {
            const prepared = await reconcileFreshCycle();
            if (prepared.status !== 'synced' || primary.hasReconcileCycle()) break;
            if (attempt === MAX_MUTATION_PREPARATION_ATTEMPTS - 1) {
              throw new Error('Vault replicas changed too often to prepare a safe mutation.');
            }
          }
          return publish(await engine.mutate(mutator));
        } catch (cause) {
          publish(engine.state);
          throw cause;
        }
      });
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

function replicationPending(
  message: string,
  cause?: unknown,
): Extract<DataHomeWriteResult, { status: 'transport-failure' }> {
  return {
    status: 'transport-failure',
    medium: 'server',
    failure: {
      code: 'api-failure',
      message,
      indeterminate: true,
      cause,
    },
  };
}

function replicaVerificationFailure(observation: ReplicaObservation): string {
  switch (observation.result.status) {
    case 'ok':
      return `The ${observation.medium} vault replica changed after it was written.`;
    case 'absent':
      return `The ${observation.medium} vault replica disappeared after it was written.`;
    case 'corrupt':
      return observation.result.message;
    case 'transport-failure':
      return observation.result.failure.message;
  }
}

function sameMediaSet(left: readonly VaultMedium[], right: readonly VaultMedium[]): boolean {
  return left.length === right.length && left.every((medium) => right.includes(medium));
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
