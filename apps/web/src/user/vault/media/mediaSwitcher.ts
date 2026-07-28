import type {
  ParanoidMediaStateResponse,
  ParanoidMediaTransitionRequest,
  ParanoidServerCandidateMetadata,
  ParanoidVaultMediaState,
  RetiredServerPurgeChallengeResponse,
  RetiredServerPurgeRequest,
  VaultMedium,
} from '@bettertrack/contracts';

import type { ParanoidServerCandidateReadback } from '../../../lib/userApi';
import type { DataHome, DataHomeReadResult, DataHomeWriteResult } from '../dataHome';
import type { DriveDataHome, DriveDeleteResult } from '../drive';
import type { VaultRetirementProofManager } from './retirementProof';
import {
  copiesMatch,
  type AuthenticatedVaultCopy,
  type VaultEnvelopeAuthenticator,
} from './verification';

export interface VaultMediaApi {
  getState(): Promise<ParanoidMediaStateResponse>;
  transition(request: ParanoidMediaTransitionRequest): Promise<ParanoidVaultMediaState>;
  stageServerCandidate(
    envelope: Uint8Array,
    retirementProofPublicKey: string,
  ): Promise<ParanoidServerCandidateMetadata>;
  readServerCandidate(
    candidate: ParanoidServerCandidateMetadata,
  ): Promise<ParanoidServerCandidateReadback>;
  requestPurgeChallenge(retiredVersion: number): Promise<RetiredServerPurgeChallengeResponse>;
  purgeRetired(request: RetiredServerPurgeRequest): Promise<void>;
}

export interface VaultMediaSwitcherOptions {
  api: VaultMediaApi;
  server: DataHome;
  drive: DriveDataHome;
  authenticate: VaultEnvelopeAuthenticator;
  retirementProof: VaultRetirementProofManager;
}

export type VaultMediaSwitchFailureStage =
  | 'read-source'
  | 'authenticate-source'
  | 'write-target'
  | 'read-back'
  | 'verify-round-trip'
  | 'patch-media'
  | 'delete-drive'
  | 'purge-retired';

export type VaultMediaSwitchResult =
  | {
      status: 'ok' | 'noop';
      media: ParanoidVaultMediaState;
      driveLeftover: false;
    }
  | {
      status: 'drive-leftover';
      media: ParanoidVaultMediaState;
      driveLeftover: true;
      stage: 'delete-drive';
      message: string;
    }
  | {
      status: 'failed';
      media: ParanoidVaultMediaState | null;
      driveLeftover: false;
      stage: Exclude<VaultMediaSwitchFailureStage, 'delete-drive'>;
      message: string;
      cause?: unknown;
    }
  | {
      status: 'last-medium';
      media: ParanoidVaultMediaState;
      driveLeftover: false;
    };

export type VaultRetiredPurgeResult =
  | { status: 'ok'; media: ParanoidVaultMediaState }
  | {
      status: 'failed';
      media: ParanoidVaultMediaState | null;
      stage: 'read-source' | 'authenticate-source' | 'purge-retired';
      cause?: unknown;
    };

export interface VaultMediaSwitcher {
  add(medium: VaultMedium): Promise<VaultMediaSwitchResult>;
  remove(medium: VaultMedium): Promise<VaultMediaSwitchResult>;
  purgeRetiredServer(): Promise<VaultRetiredPurgeResult>;
}

/**
 * Deterministic migrate-then-drop orchestration. Every remote write is read
 * back and authenticated before durable media metadata changes. Candidate and
 * retirement transitions are delegated to the atomic server foundation.
 */
export function createVaultMediaSwitcher(options: VaultMediaSwitcherOptions): VaultMediaSwitcher {
  const homes: Record<VaultMedium, DataHome> = {
    server: options.server,
    drive: options.drive,
  };

  return {
    async add(medium) {
      const mediaResult = await currentMedia();
      if ('failure' in mediaResult) return mediaResult.failure;
      const media = mediaResult.media;
      if (media.mediaSet.includes(medium)) return success('noop', media);

      const sourceMedium = media.mediaSet[0]!;
      const sourceResult = await readAuthenticated(homes[sourceMedium]);
      if (sourceResult.status === 'failed') {
        return failure(media, sourceResult.stage, sourceResult.message, sourceResult.cause);
      }
      if (medium === 'server') {
        return addServerFromDrive(media, sourceResult.copy);
      }
      return addDriveFromServer(media, sourceResult.copy);
    },

    async remove(medium) {
      const mediaResult = await currentMedia();
      if ('failure' in mediaResult) return mediaResult.failure;
      const media = mediaResult.media;

      if (!media.mediaSet.includes(medium)) {
        if (medium === 'drive') {
          const cleanup = await options.drive.delete();
          if (cleanup.status === 'transport-failure') return driveLeftover(media, cleanup);
        }
        return success('noop', media);
      }
      if (media.mediaSet.length === 1) {
        return { status: 'last-medium', media, driveLeftover: false };
      }

      const remaining = media.mediaSet.find((candidate) => candidate !== medium)!;
      const [remainingResult, removedResult] = await Promise.all([
        readAuthenticated(homes[remaining]),
        readAuthenticated(homes[medium]),
      ]);
      if (remainingResult.status === 'failed') {
        return failure(
          media,
          remainingResult.stage,
          remainingResult.message,
          remainingResult.cause,
        );
      }
      if (removedResult.status === 'failed') {
        return failure(media, removedResult.stage, removedResult.message, removedResult.cause);
      }
      if (!copiesMatch(remainingResult.copy, removedResult.copy)) {
        return failure(
          media,
          'verify-round-trip',
          'The remaining medium is not equally fresh, so removal was cancelled.',
        );
      }

      // The destination is checked again immediately before PATCH, not merely
      // trusted from the first comparison above.
      const freshRemaining = await readAuthenticated(homes[remaining]);
      if (freshRemaining.status === 'failed') {
        return failure(media, freshRemaining.stage, freshRemaining.message, freshRemaining.cause);
      }
      if (!copiesMatch(removedResult.copy, freshRemaining.copy)) {
        return failure(
          media,
          'verify-round-trip',
          'The remaining medium changed before removal could be recorded.',
        );
      }

      let updated: ParanoidVaultMediaState;
      try {
        updated = await options.api.transition({
          expected: selection(media),
          nextMediaSet: [remaining],
          verification:
            remaining === 'drive'
              ? { kind: 'drive', version: freshRemaining.copy.vaultVersion }
              : { kind: 'server', version: freshRemaining.copy.vaultVersion },
        });
      } catch (cause) {
        return failure(
          media,
          'patch-media',
          'The durable media set did not change; both copies remain selected.',
          cause,
        );
      }

      if (medium === 'drive') {
        const deleted = await options.drive.delete();
        if (deleted.status === 'transport-failure') return driveLeftover(updated, deleted);
      }
      return success('ok', updated);
    },

    async purgeRetiredServer() {
      const mediaResult = await currentMedia();
      if ('failure' in mediaResult) {
        return {
          status: 'failed',
          media: null,
          stage: 'purge-retired',
          cause: mediaResult.failure,
        };
      }
      const media = mediaResult.media;
      const retired = media.server.retired;
      if (retired == null || !media.mediaSet.includes('drive')) {
        return {
          status: 'failed',
          media,
          stage: 'purge-retired',
          cause: new Error('No Drive-backed retired server copy is available to purge.'),
        };
      }

      const read = await options.drive.read();
      if (read.status !== 'ok') {
        return { status: 'failed', media, stage: 'read-source', cause: read };
      }
      let copy: AuthenticatedVaultCopy;
      try {
        copy = await options.authenticate(read.envelope);
      } catch (cause) {
        return { status: 'failed', media, stage: 'authenticate-source', cause };
      }
      if (copy.vaultVersion < retired.version) {
        return {
          status: 'failed',
          media,
          stage: 'authenticate-source',
          cause: new Error('The authenticated Drive copy is older than the retired server copy.'),
        };
      }

      try {
        const challenge = await options.api.requestPurgeChallenge(retired.version);
        const signature = await options.retirementProof.sign({
          retiredVersion: retired.version,
          observedVersion: copy.vaultVersion,
          challenge: challenge.challenge,
        });
        await options.api.purgeRetired({
          retiredVersion: retired.version,
          observedVersion: copy.vaultVersion,
          challenge: challenge.challenge,
          signature,
        });
        const after = await currentMedia();
        if ('failure' in after) throw new Error('Could not refresh paranoid media state.');
        return { status: 'ok', media: after.media };
      } catch (cause) {
        return { status: 'failed', media, stage: 'purge-retired', cause };
      }
    },
  };

  async function addDriveFromServer(
    media: ParanoidVaultMediaState,
    source: AuthenticatedVaultCopy,
  ): Promise<VaultMediaSwitchResult> {
    const targetBefore = await options.drive.read();
    let targetMatches = false;
    if (targetBefore.status === 'ok') {
      const authenticated = await authenticate(targetBefore);
      if (authenticated.status === 'failed') {
        return failure(media, authenticated.stage, authenticated.message, authenticated.cause);
      }
      targetMatches = copiesMatch(source, authenticated.copy);
      if (!targetMatches) {
        // Drive is not selected yet, so a stale leftover is not authoritative.
        // Delete it before a create-only write; the active server copy remains
        // untouched if either operation fails.
        const deleted = await options.drive.delete();
        if (deleted.status === 'transport-failure') {
          return failure(media, 'write-target', deleted.failure.message);
        }
      }
    } else if (targetBefore.status !== 'absent') {
      return failure(media, 'write-target', outcomeMessage(targetBefore));
    }

    if (!targetMatches) {
      const written = await options.drive.write(source.envelope, { ifVersion: null });
      if (written.status !== 'ok') {
        return failure(media, 'write-target', outcomeMessage(written));
      }
    }

    const readBack = await readAuthenticated(options.drive);
    if (readBack.status === 'failed') {
      return failure(media, 'read-back', readBack.message, readBack.cause);
    }
    if (!copiesMatch(source, readBack.copy)) {
      return failure(
        media,
        'verify-round-trip',
        'Drive did not return the authenticated vault copy that was written.',
      );
    }

    try {
      return success(
        'ok',
        await options.api.transition({
          expected: selection(media),
          nextMediaSet: canonicalMediaSet([...media.mediaSet, 'drive']),
          verification: { kind: 'drive', version: readBack.copy.vaultVersion },
        }),
      );
    } catch (cause) {
      return failure(
        media,
        'patch-media',
        'The verified Drive copy was left in place, but the media set did not change.',
        cause,
      );
    }
  }

  async function addServerFromDrive(
    media: ParanoidVaultMediaState,
    source: AuthenticatedVaultCopy,
  ): Promise<VaultMediaSwitchResult> {
    const publicKey = options.retirementProof.publicKey;
    if (publicKey == null) {
      return failure(
        media,
        'write-target',
        'The unlocked vault retirement proof key is unavailable.',
      );
    }

    let candidate: ParanoidServerCandidateMetadata;
    try {
      candidate = await options.api.stageServerCandidate(source.envelope, publicKey);
    } catch (cause) {
      return failure(
        media,
        'write-target',
        'The encrypted server candidate could not be staged.',
        cause,
      );
    }

    let readback: ParanoidServerCandidateReadback;
    let staged: AuthenticatedVaultCopy;
    try {
      readback = await options.api.readServerCandidate(candidate);
      staged = await options.authenticate(readback.envelope);
    } catch (cause) {
      return failure(
        media,
        'read-back',
        'The staged server candidate could not be authenticated.',
        cause,
      );
    }
    if (staged.vaultVersion !== candidate.version || !copiesMatch(source, staged)) {
      return failure(
        media,
        'verify-round-trip',
        'The staged server candidate did not match the authenticated Drive source.',
      );
    }

    const freshDrive = await readAuthenticated(options.drive);
    if (freshDrive.status === 'failed' || !copiesMatch(staged, freshDrive.copy)) {
      return failure(
        media,
        'verify-round-trip',
        'The Drive source changed before the server candidate could be promoted.',
        freshDrive.status === 'failed' ? freshDrive.cause : undefined,
      );
    }

    try {
      return success(
        'ok',
        await options.api.transition({
          expected: selection(media),
          nextMediaSet: canonicalMediaSet([...media.mediaSet, 'server']),
          verification: readback.verification,
        }),
      );
    } catch (cause) {
      return failure(
        media,
        'patch-media',
        'The inactive server candidate was not promoted.',
        cause,
      );
    }
  }

  async function currentMedia(): Promise<
    | { media: ParanoidVaultMediaState }
    | { failure: Extract<VaultMediaSwitchResult, { status: 'failed' }> }
  > {
    try {
      const response = await options.api.getState();
      if (response.privacyMode !== 'paranoid' || response.mediaState == null) {
        return {
          failure: failure(null, 'read-source', 'Vault media switching requires paranoid mode.'),
        };
      }
      return { media: response.mediaState };
    } catch (cause) {
      return {
        failure: failure(
          null,
          'read-source',
          'The durable vault media state could not be read.',
          cause,
        ),
      };
    }
  }

  async function readAuthenticated(home: DataHome): Promise<
    | { status: 'ok'; copy: AuthenticatedVaultCopy }
    | {
        status: 'failed';
        stage: 'read-source' | 'authenticate-source';
        message: string;
        cause?: unknown;
      }
  > {
    const read = await home.read();
    if (read.status !== 'ok') {
      return { status: 'failed', stage: 'read-source', message: outcomeMessage(read) };
    }
    return authenticate(read);
  }

  async function authenticate(read: Extract<DataHomeReadResult, { status: 'ok' }>): Promise<
    | { status: 'ok'; copy: AuthenticatedVaultCopy }
    | {
        status: 'failed';
        stage: 'authenticate-source';
        message: string;
        cause?: unknown;
      }
  > {
    try {
      const copy = await options.authenticate(read.envelope);
      if (copy.vaultVersion !== read.info.version) {
        throw new Error('Authenticated envelope version does not match medium metadata.');
      }
      return { status: 'ok', copy };
    } catch (cause) {
      return {
        status: 'failed',
        stage: 'authenticate-source',
        message: 'The encrypted vault copy could not be authenticated and decrypted.',
        cause,
      };
    }
  }
}

function selection(media: ParanoidVaultMediaState) {
  return {
    mediaSet: [...media.mediaSet],
    driveAttestedVersion: media.driveAttestedVersion,
  };
}

function canonicalMediaSet(media: VaultMedium[]): ParanoidVaultMediaState['mediaSet'] {
  return media.includes('server') && media.includes('drive') ? ['server', 'drive'] : [media[0]!];
}

function success(status: 'ok' | 'noop', media: ParanoidVaultMediaState): VaultMediaSwitchResult {
  return { status, media, driveLeftover: false };
}

function failure(
  media: ParanoidVaultMediaState | null,
  stage: Exclude<VaultMediaSwitchFailureStage, 'delete-drive'>,
  message: string,
  cause?: unknown,
): Extract<VaultMediaSwitchResult, { status: 'failed' }> {
  return { status: 'failed', media, driveLeftover: false, stage, message, cause };
}

function driveLeftover(
  media: ParanoidVaultMediaState,
  result: Extract<DriveDeleteResult, { status: 'transport-failure' }>,
): VaultMediaSwitchResult {
  return {
    status: 'drive-leftover',
    media,
    driveLeftover: true,
    stage: 'delete-drive',
    message: result.failure.message,
  };
}

function outcomeMessage(result: DataHomeReadResult | DataHomeWriteResult): string {
  switch (result.status) {
    case 'ok':
      return '';
    case 'absent':
      return 'The encrypted vault copy is missing.';
    case 'conflict':
      return 'The target medium changed during the operation.';
    case 'corrupt':
      return result.message;
    case 'transport-failure':
      return result.failure.message;
  }
}
