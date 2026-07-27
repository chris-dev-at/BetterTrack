import type {
  RetiredServerVaultPurgeResponse,
  VaultMediaPatchRequest,
  VaultMediaStateResponse,
  VaultMedium,
} from '@bettertrack/contracts';

import type { DataHome, DataHomeReadResult, DataHomeWriteResult } from '../dataHome';
import type { DriveDataHome, DriveDeleteResult } from '../drive';
import {
  copiesMatch,
  mediaVerification,
  type AuthenticatedVaultCopy,
  type VaultEnvelopeAuthenticator,
} from './verification';

export interface VaultMediaApi {
  getState(): Promise<VaultMediaStateResponse>;
  patch(request: VaultMediaPatchRequest): Promise<VaultMediaStateResponse>;
  purgeDriveRetired(
    proof: ReturnType<typeof mediaVerification>,
  ): Promise<RetiredServerVaultPurgeResponse>;
}

export interface VaultMediaSwitcherOptions {
  api: VaultMediaApi;
  server: DataHome;
  drive: DriveDataHome;
  authenticate: VaultEnvelopeAuthenticator;
  now?: () => string;
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
      media: VaultMediaStateResponse;
      driveLeftover: false;
    }
  | {
      status: 'drive-leftover';
      media: VaultMediaStateResponse;
      driveLeftover: true;
      stage: 'delete-drive';
      message: string;
    }
  | {
      status: 'failed';
      media: VaultMediaStateResponse;
      driveLeftover: false;
      stage: Exclude<VaultMediaSwitchFailureStage, 'delete-drive'>;
      message: string;
      cause?: unknown;
    }
  | {
      status: 'last-medium';
      media: VaultMediaStateResponse;
      driveLeftover: false;
    };

export interface VaultMediaSwitcher {
  add(medium: VaultMedium): Promise<VaultMediaSwitchResult>;
  remove(medium: VaultMedium): Promise<VaultMediaSwitchResult>;
  purgeRetiredServer(): Promise<
    | { status: 'ok'; result: RetiredServerVaultPurgeResponse }
    | {
        status: 'failed';
        stage: 'read-source' | 'authenticate-source' | 'purge-retired';
        cause?: unknown;
      }
  >;
}

/**
 * Deterministic migrate-then-drop orchestration. Every remote write is read back
 * and authenticated before durable media metadata changes; every removal
 * verifies both copies immediately, and Drive deletion happens only after PATCH.
 */
export function createVaultMediaSwitcher(options: VaultMediaSwitcherOptions): VaultMediaSwitcher {
  const now = options.now ?? (() => new Date().toISOString());
  const homes: Record<VaultMedium, DataHome> = {
    server: options.server,
    drive: options.drive,
  };

  return {
    async add(medium) {
      const media = await options.api.getState();
      if (media.mediaSet.includes(medium)) {
        return success('noop', media);
      }
      const sourceMedium = media.mediaSet[0]!;
      const sourceResult = await readAuthenticated(homes[sourceMedium]);
      if (sourceResult.status === 'failed') {
        return failure(media, sourceResult.stage, sourceResult.message, sourceResult.cause);
      }
      const source = sourceResult.copy;
      const target = homes[medium];
      const targetBefore = await target.read();
      let targetCopy: AuthenticatedVaultCopy | null = null;

      if (targetBefore.status === 'ok') {
        const authenticated = await authenticate(targetBefore);
        if (authenticated.status === 'failed') {
          return failure(media, 'authenticate-source', authenticated.message, authenticated.cause);
        }
        targetCopy = authenticated.copy;
      } else if (targetBefore.status !== 'absent') {
        return failure(media, 'write-target', outcomeMessage(targetBefore));
      }

      if (targetCopy === null || !copiesMatch(source, targetCopy)) {
        const written = await target.write(source.envelope, {
          ifVersion: targetCopy?.vaultVersion ?? null,
        });
        if (written.status !== 'ok') {
          return failure(media, 'write-target', outcomeMessage(written));
        }
      }

      const readBack = await readAuthenticated(target);
      if (readBack.status === 'failed') {
        return failure(media, 'read-back', readBack.message, readBack.cause);
      }
      if (!copiesMatch(source, readBack.copy)) {
        return failure(
          media,
          'verify-round-trip',
          'The target medium did not return the authenticated vault copy that was written.',
        );
      }

      try {
        const updated = await options.api.patch({
          expectedMediaSet: media.mediaSet,
          mediaSet: canonicalMediaSet([...media.mediaSet, medium]),
          verification: mediaVerification(medium, readBack.copy, now()),
        });
        return success('ok', updated);
      } catch (cause) {
        return failure(
          media,
          'patch-media',
          'The verified copy was left in place, but the durable media set did not change.',
          cause,
        );
      }
    },

    async remove(medium) {
      const media = await options.api.getState();
      if (!media.mediaSet.includes(medium)) {
        if (medium === 'drive') {
          const cleanup = await options.drive.delete();
          if (cleanup.status === 'transport-failure') {
            return driveLeftover(media, cleanup);
          }
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

      let updated: VaultMediaStateResponse;
      try {
        updated = await options.api.patch({
          expectedMediaSet: media.mediaSet,
          mediaSet: [remaining],
          verification: mediaVerification(remaining, remainingResult.copy, now()),
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
      const read = await options.drive.read();
      if (read.status !== 'ok') {
        return { status: 'failed', stage: 'read-source', cause: read };
      }
      let copy: AuthenticatedVaultCopy;
      try {
        copy = await options.authenticate(read.envelope);
      } catch (cause) {
        return { status: 'failed', stage: 'authenticate-source', cause };
      }
      try {
        return {
          status: 'ok',
          result: await options.api.purgeDriveRetired(mediaVerification('drive', copy, now())),
        };
      } catch (cause) {
        return { status: 'failed', stage: 'purge-retired', cause };
      }
    },
  };

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
      return { status: 'ok', copy: await options.authenticate(read.envelope) };
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

function canonicalMediaSet(media: VaultMedium[]): VaultMediaStateResponse['mediaSet'] {
  return media.includes('server') && media.includes('drive') ? ['server', 'drive'] : [media[0]!];
}

function success(status: 'ok' | 'noop', media: VaultMediaStateResponse): VaultMediaSwitchResult {
  return { status, media, driveLeftover: false };
}

function failure(
  media: VaultMediaStateResponse,
  stage: Exclude<VaultMediaSwitchFailureStage, 'delete-drive'>,
  message: string,
  cause?: unknown,
): VaultMediaSwitchResult {
  return { status: 'failed', media, driveLeftover: false, stage, message, cause };
}

function driveLeftover(
  media: VaultMediaStateResponse,
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
