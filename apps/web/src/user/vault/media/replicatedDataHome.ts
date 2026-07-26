import { equalBytes } from '../bytes';
import type { VaultEnvelopeHeader, VaultMediaState } from '@bettertrack/contracts';
import { decryptVaultDocument, encryptVaultDocument, type VaultKeyMaterial } from '../crypto';
import type { DataHome, DataHomeReadResult, DataHomeWriteResult } from '../dataHome';
import type { DriveDataHome } from '../drive/driveDataHome';
import { mergeVaultDocuments } from '../merge';
import type {
  AuthenticatedEnvelope,
  VaultEnvelopeAuthenticator,
  VaultMediaStateApi,
} from './switcher';

export interface ReplicatedVaultDataHomeOptions {
  state: VaultMediaStateApi;
  server: DataHome;
  drive: DriveDataHome;
  authenticate: VaultEnvelopeAuthenticator;
  resolveDivergence: VaultReplicaDivergenceResolver;
}

type ReadableReplica = Extract<DataHomeReadResult, { status: 'ok' }>;

export interface ResolvedVaultReplicas {
  envelope: Uint8Array;
  version: number;
}

export type VaultReplicaDivergenceResolver = (
  server: ReadableReplica,
  drive: ReadableReplica,
) => Promise<ResolvedVaultReplicas>;

export interface VaultReplicaMergeResolverOptions {
  vaultKey: VaultKeyMaterial;
  deviceId: string;
  writeId: () => string;
  now?: () => string;
}

/**
 * Authentication-aware PD5 resolver for two live remote branches. It first
 * decrypts both candidates, then delegates dominance/divergence selection to
 * the same entity-atomic merge engine used by normal sync. Only its resolved
 * successor is handed back for cross-medium repair.
 */
export function createVaultReplicaMergeResolver(
  options: VaultReplicaMergeResolverOptions,
): VaultReplicaDivergenceResolver {
  const now = options.now ?? (() => new Date().toISOString());
  return async (server, drive) => {
    const [serverVault, driveVault] = await Promise.all([
      decryptVaultDocument(server.envelope, options.vaultKey),
      decryptVaultDocument(drive.envelope, options.vaultKey),
    ]);
    if (
      serverVault.header.vaultVersion !== server.info.version ||
      driveVault.header.vaultVersion !== drive.info.version
    ) {
      throw new Error('Authenticated replica metadata does not match its envelope.');
    }
    const merged = mergeVaultDocuments({
      left: serverVault.document,
      leftVersion: serverVault.header.vaultVersion,
      right: driveVault.document,
      rightVersion: driveVault.header.vaultVersion,
      deviceId: options.deviceId,
      mergedAt: now(),
    });
    if (!merged.divergent) {
      const selected =
        serverVault.header.vaultVersion >= driveVault.header.vaultVersion ? server : drive;
      return {
        envelope: selected.envelope.slice(),
        version: selected.info.version,
      };
    }

    const baseHeader = newestHeader(serverVault.header, driveVault.header);
    const encrypted = await encryptVaultDocument({
      document: merged.document,
      vaultKey: options.vaultKey,
      header: {
        keyId: baseHeader.keyId,
        wrappedKeys: baseHeader.wrappedKeys,
        vaultVersion: merged.vaultVersion,
        deviceId: options.deviceId,
        writeId: options.writeId(),
        writtenAt: now(),
      },
    });
    return {
      envelope: encrypted.envelope,
      version: encrypted.header.vaultVersion,
    };
  };
}

/**
 * The §4 primary/secondary policy over the generic PD5 DataHome seam. Server is
 * primary whenever active; Drive-only delegates directly to Drive. In `both`,
 * an acknowledged server write is not acknowledged to the sync engine until
 * identical Drive bytes are read back and the durable Drive attestation is
 * refreshed. A secondary failure is therefore returned as indeterminate, which
 * keeps the encrypted local candidate pending; the next reconnect repairs the
 * stale secondary before reporting synced. Reads authenticate and merge every
 * divergent candidate before either live medium can be repaired.
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
        const authenticated = await authenticateRead(server);
        if (authenticated.status === 'corrupt') return authenticated;
        return (await attestRead(media, server)) ?? server;
      }

      const [authenticatedServer, authenticatedDrive] = await Promise.all([
        authenticateRead(server),
        authenticateRead(drive),
      ]);
      if (authenticatedServer.status === 'corrupt') return authenticatedServer;
      if (authenticatedDrive.status === 'corrupt') return authenticatedDrive;
      let resolved: ResolvedVaultReplicas;
      try {
        resolved = await options.resolveDivergence(server, drive);
      } catch {
        return readFailure('Authenticated vault replicas could not be reconciled.');
      }
      const authenticatedResolved = await authenticateEnvelope(resolved.envelope, resolved.version);
      if (authenticatedResolved.status === 'corrupt') return authenticatedResolved;

      const serverResolved = equalBytes(server.envelope, resolved.envelope)
        ? server
        : await replaceReplica(options.server, server, resolved);
      if (serverResolved.status !== 'ok') return serverResolved;
      const driveResolved = equalBytes(drive.envelope, resolved.envelope)
        ? drive
        : await replaceReplica(options.drive, drive, resolved);
      if (driveResolved.status !== 'ok') return driveResolved;
      if (!equalBytes(serverResolved.envelope, driveResolved.envelope)) {
        return readFailure('Reconciled vault media returned different bytes.');
      }
      return (await attestRead(media, serverResolved)) ?? serverResolved;
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
    const authenticatedSource = await authenticateRead(source);
    if (authenticatedSource.status === 'corrupt') return authenticatedSource;
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
    const authenticatedRoundTrip = await authenticateRead(roundTrip);
    if (authenticatedRoundTrip.status === 'corrupt') return authenticatedRoundTrip;
    return (await attestRead(media, source)) ?? source;
  }

  async function authenticateRead(
    read: Extract<DataHomeReadResult, { status: 'ok' }>,
  ): Promise<
    | { status: 'ok'; authenticated: AuthenticatedEnvelope }
    | Extract<DataHomeReadResult, { status: 'corrupt' }>
  > {
    try {
      const authenticated = await options.authenticate(read.envelope);
      if (authenticated.version !== read.info.version) {
        return corruptCandidate(
          read,
          `The authenticated vault version does not match the ${read.medium} medium metadata.`,
        );
      }
      return { status: 'ok', authenticated };
    } catch {
      return corruptCandidate(
        read,
        `The ${read.medium} vault candidate failed authenticated decryption.`,
      );
    }
  }

  async function authenticateEnvelope(
    envelope: Uint8Array,
    version: number,
  ): Promise<
    | { status: 'ok'; authenticated: AuthenticatedEnvelope }
    | Extract<DataHomeReadResult, { status: 'corrupt' }>
  > {
    const candidate: ReadableReplica = {
      status: 'ok',
      medium: 'server',
      envelope,
      info: {
        medium: 'server',
        version,
        sizeBytes: envelope.byteLength,
        updatedAt: null,
      },
    };
    return authenticateRead(candidate);
  }

  async function replaceReplica(
    target: DataHome,
    current: ReadableReplica,
    resolved: ResolvedVaultReplicas,
  ): Promise<DataHomeReadResult> {
    const repaired = await target.write(resolved.envelope, {
      ifVersion: current.info.version,
    });
    if (repaired.status !== 'ok') return readFailure(failureMessage(repaired));
    const roundTrip = await target.read();
    if (roundTrip.status !== 'ok' || !equalBytes(roundTrip.envelope, resolved.envelope)) {
      return readFailure(
        roundTrip.status === 'ok'
          ? 'A repaired vault medium returned different bytes.'
          : failureMessage(roundTrip),
      );
    }
    const authenticatedRoundTrip = await authenticateRead(roundTrip);
    return authenticatedRoundTrip.status === 'corrupt' ? authenticatedRoundTrip : roundTrip;
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

function corruptCandidate(
  candidate: Extract<DataHomeReadResult, { status: 'ok' }>,
  message: string,
): Extract<DataHomeReadResult, { status: 'corrupt' }> {
  return {
    status: 'corrupt',
    medium: candidate.medium,
    envelope: candidate.envelope,
    version: candidate.info.version,
    updatedAt: candidate.info.updatedAt,
    reason: 'corrupt-bytes',
    message,
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

function newestHeader(left: VaultEnvelopeHeader, right: VaultEnvelopeHeader): VaultEnvelopeHeader {
  if (left.vaultVersion !== right.vaultVersion) {
    return left.vaultVersion > right.vaultVersion ? left : right;
  }
  return left.writeId >= right.writeId ? left : right;
}
