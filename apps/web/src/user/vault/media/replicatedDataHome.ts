import { equalBytes } from '../bytes';
import type { VaultMediaState } from '@bettertrack/contracts';
import type { DataHome, DataHomeReadResult, DataHomeWriteResult } from '../dataHome';
import type { DriveDataHome } from '../drive/driveDataHome';
import type { VaultMediaStateApi } from './switcher';

export interface ReplicatedVaultDataHomeOptions {
  state: VaultMediaStateApi;
  server: DataHome;
  drive: DriveDataHome;
}

/**
 * The §4 primary/secondary policy over the generic PD5 DataHome seam. Server is
 * primary whenever active; Drive-only delegates directly to Drive. In `both`,
 * an acknowledged server write is not acknowledged to the sync engine until
 * identical Drive bytes are read back and the durable Drive attestation is
 * refreshed. A secondary failure is therefore returned as indeterminate, which
 * keeps the encrypted local candidate pending; the next reconnect repairs the
 * stale secondary before reporting synced.
 */
export function createReplicatedVaultDataHome(options: ReplicatedVaultDataHomeOptions): DataHome {
  return {
    medium: 'server',

    async read(): Promise<DataHomeReadResult> {
      const media = await mediaState(options.state);
      if ('status' in media) return media;
      if (sameSet(media.mediaSet, ['drive'])) return options.drive.read();
      if (sameSet(media.mediaSet, ['server'])) return options.server.read();
      return readBoth(media);
    },

    async write(envelope, writeOptions): Promise<DataHomeWriteResult> {
      const media = await mediaState(options.state);
      if ('status' in media) return media;
      if (sameSet(media.mediaSet, ['drive'])) {
        return options.drive.write(envelope, writeOptions);
      }
      const serverWrite = await options.server.write(envelope, writeOptions);
      if (serverWrite.status !== 'ok' || sameSet(media.mediaSet, ['server'])) {
        return serverWrite;
      }

      const driveCurrent = await options.drive.read();
      if (driveCurrent.status === 'ok' && equalBytes(driveCurrent.envelope, envelope)) {
        return attestOrPending(media, serverWrite, envelope);
      }
      if (driveCurrent.status === 'ok' && driveCurrent.info.version >= serverWrite.info.version) {
        return pendingWrite('Drive changed while the server-primary write was being replicated.');
      }
      if (driveCurrent.status !== 'ok' && driveCurrent.status !== 'absent') {
        return pendingWrite(failureMessage(driveCurrent));
      }

      const driveWrite = await options.drive.write(envelope, {
        ifVersion: driveCurrent.status === 'ok' ? driveCurrent.info.version : null,
      });
      if (driveWrite.status !== 'ok') return pendingWrite(failureMessage(driveWrite));
      const verified = await options.drive.read();
      if (verified.status !== 'ok' || !equalBytes(verified.envelope, envelope)) {
        return pendingWrite(
          verified.status === 'ok'
            ? 'Drive returned different bytes after replication.'
            : failureMessage(verified),
        );
      }
      return attestOrPending(media, serverWrite, envelope);
    },

    async info() {
      const read = await this.read();
      return read.status === 'ok'
        ? { status: 'ok' as const, medium: read.medium, info: read.info }
        : read;
    },
  };

  async function readBoth(media: VaultMediaState): Promise<DataHomeReadResult> {
    const [server, drive] = await Promise.all([options.server.read(), options.drive.read()]);
    if (server.status === 'ok' && drive.status === 'ok') {
      if (equalBytes(server.envelope, drive.envelope)) {
        return (await attestRead(media, server)) ?? server;
      }
      if (server.info.version === drive.info.version) {
        return corruptDivergence(server);
      }
      const source = server.info.version > drive.info.version ? server : drive;
      const target = source === server ? options.drive : options.server;
      const targetVersion = source === server ? drive.info.version : server.info.version;
      const repaired = await target.write(source.envelope, {
        ifVersion: targetVersion,
      });
      if (repaired.status !== 'ok') return readFailure(failureMessage(repaired));
      const roundTrip = await target.read();
      if (roundTrip.status !== 'ok' || !equalBytes(roundTrip.envelope, source.envelope)) {
        return readFailure(
          roundTrip.status === 'ok'
            ? 'A repaired vault medium returned different bytes.'
            : failureMessage(roundTrip),
        );
      }
      return (await attestRead(media, source)) ?? source;
    }

    if (server.status === 'ok' && drive.status === 'absent') {
      return copyMissing(media, server, options.drive);
    }
    if (drive.status === 'ok' && server.status === 'absent') {
      return copyMissing(media, drive, options.server);
    }
    if (server.status === 'absent' && drive.status === 'absent') {
      return { status: 'absent', medium: 'server' };
    }
    return server.status !== 'ok' && server.status !== 'absent' ? server : drive;
  }

  async function copyMissing(
    media: VaultMediaState,
    source: Extract<DataHomeReadResult, { status: 'ok' }>,
    target: DataHome,
  ): Promise<DataHomeReadResult> {
    const written = await target.write(source.envelope, { ifVersion: null });
    if (written.status !== 'ok') return readFailure(failureMessage(written));
    const roundTrip = await target.read();
    if (roundTrip.status !== 'ok' || !equalBytes(roundTrip.envelope, source.envelope)) {
      return readFailure(
        roundTrip.status === 'ok'
          ? 'A repaired vault medium returned different bytes.'
          : failureMessage(roundTrip),
      );
    }
    return (await attestRead(media, source)) ?? source;
  }

  async function attestRead(
    media: VaultMediaState,
    source: Extract<DataHomeReadResult, { status: 'ok' }>,
  ): Promise<DataHomeReadResult | null> {
    try {
      await attest(media, source.info.version);
      return null;
    } catch {
      return readFailure('Could not refresh the verified Drive attestation.');
    }
  }

  async function attestOrPending(
    media: VaultMediaState,
    serverWrite: Extract<DataHomeWriteResult, { status: 'ok' }>,
    envelope: Uint8Array,
  ): Promise<DataHomeWriteResult> {
    try {
      await attest(media, serverWrite.info.version);
      return serverWrite;
    } catch {
      return pendingWrite(
        `Both media hold vault version ${serverWrite.info.version}, but its Drive attestation could not be committed (${envelope.byteLength} encrypted bytes remain pending).`,
      );
    }
  }

  async function attest(media: VaultMediaState, version: number): Promise<void> {
    if (media.driveAttestedVersion === version) return;
    const claim = {
      expected: media,
      nextMediaSet: media.mediaSet,
      verification: { medium: 'drive' as const, version },
    };
    const prepared = await options.state.prepare(claim);
    const next = await options.state.patch({
      ...claim,
      verification: { ...claim.verification, proof: prepared.proof },
    });
    if (next.driveAttestedVersion !== version) {
      throw new Error('Drive attestation did not advance.');
    }
  }
}

async function mediaState(
  state: VaultMediaStateApi,
): Promise<VaultMediaState | Extract<DataHomeReadResult, { status: 'transport-failure' }>> {
  try {
    const result = await state.get();
    if (result.privacyMode !== 'paranoid' || result.mediaState === null) {
      return readFailure('Paranoid media state is unavailable.');
    }
    return result.mediaState;
  } catch {
    return readFailure('Could not read paranoid media state.');
  }
}

function corruptDivergence(
  server: Extract<DataHomeReadResult, { status: 'ok' }>,
): Extract<DataHomeReadResult, { status: 'corrupt' }> {
  return {
    status: 'corrupt',
    medium: 'server',
    envelope: server.envelope,
    version: server.info.version,
    updatedAt: server.info.updatedAt,
    reason: 'corrupt-bytes',
    message: 'Server and Drive contain different ciphertext at the same vault version.',
  };
}

function readFailure(
  message: string,
): Extract<DataHomeReadResult, { status: 'transport-failure' }> {
  return {
    status: 'transport-failure',
    medium: 'server',
    failure: { kind: 'api-failure', message },
  };
}

function pendingWrite(
  message: string,
): Extract<DataHomeWriteResult, { status: 'transport-failure' }> {
  return {
    status: 'transport-failure',
    medium: 'server',
    failure: {
      kind: 'api-failure',
      message,
      indeterminate: true,
    },
  };
}

function failureMessage(
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

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((medium) => right.includes(medium)) &&
    right.every((medium) => left.includes(medium))
  );
}
