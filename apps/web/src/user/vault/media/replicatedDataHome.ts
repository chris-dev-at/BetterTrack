import type { VaultMediaStateResponse } from '@bettertrack/contracts';

import { equalBytes } from '../bytes';
import type { DataHome, DataHomeReadResult, DataHomeWriteResult } from '../dataHome';
import type { DriveDataHome } from '../drive';
import { copiesMatch, type VaultEnvelopeAuthenticator } from './verification';
import type { VaultMediaApi } from './mediaSwitcher';

export interface ReplicatedVaultDataHomeOptions {
  api: Pick<VaultMediaApi, 'getState'>;
  server: DataHome;
  drive: DriveDataHome;
  authenticate: VaultEnvelopeAuthenticator;
}

/**
 * Media-aware primary for the existing PD5 sync coordinator. A write in `both`
 * is acknowledged only after identical Drive bytes are read back; a secondary
 * failure stays indeterminate so the encrypted local candidate remains pending
 * and the next unlock/gesture retries reconciliation.
 */
export function createReplicatedVaultDataHome(options: ReplicatedVaultDataHomeOptions): DataHome {
  return {
    medium: 'server',

    async read() {
      const media = await readMediaState();
      if ('status' in media) return media;
      if (only(media, 'drive')) return options.drive.read();
      if (only(media, 'server')) return options.server.read();
      return readBoth();
    },

    async write(envelope, writeOptions) {
      const media = await readMediaState();
      if ('status' in media) return media;
      if (only(media, 'drive')) return options.drive.write(envelope, writeOptions);
      const serverWrite = await options.server.write(envelope, writeOptions);
      if (serverWrite.status !== 'ok' || only(media, 'server')) return serverWrite;

      const driveBefore = await options.drive.read();
      if (driveBefore.status === 'ok' && equalBytes(driveBefore.envelope, envelope)) {
        return serverWrite;
      }
      if (driveBefore.status === 'ok' && driveBefore.info.version >= serverWrite.info.version) {
        return pendingWrite('Drive changed while the server write was being replicated.');
      }
      if (driveBefore.status !== 'ok' && driveBefore.status !== 'absent') {
        return pendingWrite(resultMessage(driveBefore));
      }
      const driveWrite = await options.drive.write(envelope, {
        ifVersion: driveBefore.status === 'ok' ? driveBefore.info.version : null,
      });
      if (driveWrite.status !== 'ok') return pendingWrite(resultMessage(driveWrite));
      const roundTrip = await options.drive.read();
      if (roundTrip.status !== 'ok' || !equalBytes(roundTrip.envelope, envelope)) {
        return pendingWrite(
          roundTrip.status === 'ok'
            ? 'Drive returned different bytes after replication.'
            : resultMessage(roundTrip),
        );
      }
      return serverWrite;
    },

    async info() {
      const read = await this.read();
      return read.status === 'ok'
        ? { status: 'ok' as const, medium: read.medium, info: read.info }
        : read;
    },
  };

  async function readMediaState(): Promise<
    VaultMediaStateResponse | Extract<DataHomeReadResult, { status: 'transport-failure' }>
  > {
    try {
      return await options.api.getState();
    } catch (cause) {
      return readFailure('Could not read paranoid media state.', cause);
    }
  }

  async function readBoth(): Promise<DataHomeReadResult> {
    const [server, drive] = await Promise.all([options.server.read(), options.drive.read()]);
    if (server.status === 'ok' && drive.status === 'ok') {
      if (equalBytes(server.envelope, drive.envelope)) return authenticated(server);

      const [serverCopy, driveCopy] = await Promise.all([
        authenticate(server),
        authenticate(drive),
      ]);
      if (serverCopy === null || driveCopy === null) {
        return corrupt(server, 'A live vault replica failed authenticated decryption.');
      }
      if (copiesMatch(serverCopy, driveCopy)) return server;
      if (serverCopy.vaultVersion === driveCopy.vaultVersion) {
        return corrupt(
          server,
          'Live vault replicas diverged at the same version and require recovery.',
        );
      }

      const [source, target] =
        serverCopy.vaultVersion > driveCopy.vaultVersion
          ? ([server, options.drive] as const)
          : ([drive, options.server] as const);
      const repaired = await target.write(source.envelope, {
        ifVersion: target === options.drive ? drive.info.version : server.info.version,
      });
      if (repaired.status !== 'ok') return readFailure(resultMessage(repaired));
      const roundTrip = await target.read();
      if (roundTrip.status !== 'ok' || !equalBytes(roundTrip.envelope, source.envelope)) {
        return readFailure(
          roundTrip.status === 'ok'
            ? 'A repaired vault medium returned different bytes.'
            : resultMessage(roundTrip),
        );
      }
      return source;
    }
    if (server.status === 'ok' && drive.status === 'absent') {
      return copyMissing(server, options.drive);
    }
    if (drive.status === 'ok' && server.status === 'absent') {
      return copyMissing(drive, options.server);
    }
    if (server.status === 'absent' && drive.status === 'absent') {
      return { status: 'absent', medium: 'server' };
    }
    return server.status !== 'ok' && server.status !== 'absent' ? server : drive;
  }

  async function copyMissing(
    source: Extract<DataHomeReadResult, { status: 'ok' }>,
    target: DataHome,
  ): Promise<DataHomeReadResult> {
    const checked = await authenticated(source);
    if (checked.status !== 'ok') return checked;
    const write = await target.write(source.envelope, { ifVersion: null });
    if (write.status !== 'ok') return readFailure(resultMessage(write));
    const roundTrip = await target.read();
    if (roundTrip.status !== 'ok' || !equalBytes(roundTrip.envelope, source.envelope)) {
      return readFailure(
        roundTrip.status === 'ok'
          ? 'A repaired vault medium returned different bytes.'
          : resultMessage(roundTrip),
      );
    }
    return authenticated(roundTrip);
  }

  async function authenticated(
    read: Extract<DataHomeReadResult, { status: 'ok' }>,
  ): Promise<DataHomeReadResult> {
    return (await authenticate(read)) === null
      ? corrupt(read, 'A live vault replica failed authenticated decryption.')
      : read;
  }

  async function authenticate(read: Extract<DataHomeReadResult, { status: 'ok' }>) {
    try {
      const copy = await options.authenticate(read.envelope);
      return copy.vaultVersion === read.info.version ? copy : null;
    } catch {
      return null;
    }
  }
}

function only(media: VaultMediaStateResponse, medium: 'server' | 'drive'): boolean {
  return media.mediaSet.length === 1 && media.mediaSet[0] === medium;
}

function corrupt(
  read: Extract<DataHomeReadResult, { status: 'ok' }>,
  message: string,
): Extract<DataHomeReadResult, { status: 'corrupt' }> {
  return {
    status: 'corrupt',
    medium: read.medium,
    envelope: read.envelope,
    version: read.info.version,
    updatedAt: read.info.updatedAt,
    reason: 'corrupt-bytes',
    message,
  };
}

function readFailure(
  message: string,
  cause?: unknown,
): Extract<DataHomeReadResult, { status: 'transport-failure' }> {
  return {
    status: 'transport-failure',
    medium: 'server',
    failure: { code: 'api-failure', message, cause },
  };
}

function pendingWrite(
  message: string,
): Extract<DataHomeWriteResult, { status: 'transport-failure' }> {
  return {
    status: 'transport-failure',
    medium: 'server',
    failure: { code: 'api-failure', message, indeterminate: true },
  };
}

function resultMessage(
  result: Exclude<DataHomeReadResult | DataHomeWriteResult, { status: 'ok' }>,
): string {
  switch (result.status) {
    case 'absent':
      return 'A vault medium is absent.';
    case 'conflict':
      return `Vault replication lost a CAS race at version ${result.currentVersion ?? 'none'}.`;
    case 'corrupt':
      return result.message;
    case 'transport-failure':
      return result.failure.message;
  }
}
