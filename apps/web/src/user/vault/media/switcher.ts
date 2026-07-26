import type {
  ParanoidMediaStatusResponse,
  PatchParanoidMediaRequest,
  PrepareParanoidMediaVerificationRequest,
  PrepareParanoidMediaVerificationResponse,
  VaultMediaSet,
  VaultMediaState,
  VaultMedium,
} from '@bettertrack/contracts';

import { decryptVaultDocument, type VaultKeyMaterial } from '../crypto';
import type { DataHome, DataHomeReadResult, DataHomeWriteResult } from '../dataHome';
import type { DriveDataHome, DriveDataHomeDeleteResult } from '../drive/driveDataHome';

export interface AuthenticatedEnvelope {
  version: number;
  writeId: string;
  sha256: string;
}

export type VaultEnvelopeAuthenticator = (envelope: Uint8Array) => Promise<AuthenticatedEnvelope>;

export interface VaultMediaStateApi {
  get(): Promise<ParanoidMediaStatusResponse>;
  prepare(
    request: PrepareParanoidMediaVerificationRequest,
  ): Promise<PrepareParanoidMediaVerificationResponse>;
  patch(request: PatchParanoidMediaRequest): Promise<VaultMediaState>;
  /** Atomic Drive-only → both commit; no inactive server row is ever exposed. */
  addServer(envelope: Uint8Array): Promise<VaultMediaState>;
}

export interface VaultMediaSwitcherOptions {
  state: VaultMediaStateApi;
  server: DataHome;
  drive: DriveDataHome;
  authenticate: VaultEnvelopeAuthenticator;
}

export type MediaSwitchFailureReason =
  | 'normal-account'
  | 'last-medium'
  | 'invalid-transition'
  | 'source-unavailable'
  | 'verification-failed'
  | 'stale-version'
  | 'verification-proof-failed'
  | 'patch-failed'
  | 'consent-required'
  | 'token-expired'
  | 'gesture-required'
  | 'offline'
  | 'authorization-failed'
  | 'api-failure'
  | 'corrupt';

export type MediaSwitchResult =
  | { status: 'ok'; state: VaultMediaState; recoveredAfterPatchFailure: boolean }
  | { status: 'no-op'; state: VaultMediaState }
  | {
      status: 'ok-with-drive-leftover';
      state: VaultMediaState;
      deleteResult: Exclude<DriveDataHomeDeleteResult, { status: 'ok' | 'absent' }>;
    }
  | {
      status: 'failed';
      reason: MediaSwitchFailureReason;
      authoritativeState: VaultMediaState | null;
    };

export interface VaultMediaSwitcher {
  switchTo(nextMediaSet: VaultMediaSet): Promise<MediaSwitchResult>;
  add(medium: VaultMedium): Promise<MediaSwitchResult>;
  remove(medium: VaultMedium): Promise<MediaSwitchResult>;
}

/**
 * §5 migrate-then-drop orchestration over the existing DataHome seam. It never
 * mutates the durable set until the target bytes have been read back,
 * authenticated and compared with the source.
 */
export function createVaultMediaSwitcher(options: VaultMediaSwitcherOptions): VaultMediaSwitcher {
  let operationTail = Promise.resolve();

  return {
    switchTo(nextMediaSet) {
      return serialize(() => switchTo(nextMediaSet));
    },

    async add(medium) {
      const current = await options.state.get();
      if (current.privacyMode !== 'paranoid' || current.mediaState === null) {
        return failed('normal-account', null);
      }
      return this.switchTo(canonical([...current.mediaState.mediaSet, medium]));
    },

    async remove(medium) {
      const current = await options.state.get();
      if (current.privacyMode !== 'paranoid' || current.mediaState === null) {
        return failed('normal-account', null);
      }
      return this.switchTo(
        canonical(current.mediaState.mediaSet.filter((candidate) => candidate !== medium)),
      );
    },
  };

  function serialize(operation: () => Promise<MediaSwitchResult>): Promise<MediaSwitchResult> {
    const result = operationTail.then(operation);
    operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function switchTo(requested: VaultMediaSet): Promise<MediaSwitchResult> {
    const next = canonical(requested);
    if (next.length === 0) return failed('last-medium', null);
    const status = await options.state.get();
    if (status.privacyMode !== 'paranoid' || status.mediaState === null) {
      return failed('normal-account', null);
    }
    const current = status.mediaState;
    if (sameSet(current.mediaSet, next)) return { status: 'no-op', state: current };

    const added = next.filter((medium) => !current.mediaSet.includes(medium));
    const removed = current.mediaSet.filter((medium) => !next.includes(medium));
    if (added.length + removed.length !== 1) {
      return failed('invalid-transition', current);
    }
    let expectedState = current;

    const verifiedMedium = added[0] ?? next[0];
    if (verifiedMedium === undefined) return failed('last-medium', current);
    const verifiedHome = home(verifiedMedium);
    let expectedVerified: AuthenticatedEnvelope;
    let comparisonHome: DataHome;

    if (added.length === 1) {
      const sourceMedium = current.mediaSet[0];
      if (sourceMedium === undefined) return failed('source-unavailable', current);
      comparisonHome = home(sourceMedium);
      const source = await readAuthenticated(comparisonHome);
      if (source.status === 'failed') return { ...source, authoritativeState: current };

      // Drive-only → both cannot pre-write the live server DataHome: even a
      // PATCH transport failure would then violate Drive-only's physical
      // zero-server-bytes invariant. The API accepts the authenticated Drive
      // envelope through one raw-byte transaction that inserts it and activates
      // the medium atomically.
      if (verifiedMedium === 'server') {
        let durable: VaultMediaState;
        let recoveredAfterPatchFailure = false;
        try {
          durable = await options.state.addServer(source.envelope);
        } catch {
          const observed = await safeGetState();
          if (observed === null || !sameSet(observed.mediaSet, next)) {
            return failed('patch-failed', observed ?? current);
          }
          durable = observed;
          recoveredAfterPatchFailure = true;
        }
        const serverCopy = await readAuthenticated(options.server);
        if (
          serverCopy.status === 'failed' ||
          !sameAuthenticatedEnvelope(source.authenticated, serverCopy.authenticated)
        ) {
          return failed('verification-failed', durable);
        }
        return { status: 'ok', state: durable, recoveredAfterPatchFailure };
      }

      const copied = await ensureVerifiedCopy(source, verifiedHome);
      if (copied.status === 'failed') return { ...copied, authoritativeState: current };
      expectedVerified = copied.authenticated;
    } else {
      const removedMedium = removed[0];
      if (removedMedium === undefined) return failed('invalid-transition', current);
      comparisonHome = home(removedMedium);
      // Re-read both copies immediately before PATCH. This is deliberately not
      // cached from an earlier sync pass.
      const [source, remaining] = await Promise.all([
        readAuthenticated(comparisonHome),
        readAuthenticated(verifiedHome),
      ]);
      if (source.status === 'failed') return { ...source, authoritativeState: current };
      if (remaining.status === 'failed') return { ...remaining, authoritativeState: current };
      if (!sameAuthenticatedEnvelope(source.authenticated, remaining.authenticated)) {
        return failed('verification-failed', current);
      }
      expectedVerified = remaining.authenticated;
      if (
        removedMedium === 'server' &&
        current.driveAttestedVersion !== remaining.authenticated.version
      ) {
        const attested = await refreshDriveAttestation(current);
        if (attested.status === 'failed') return attested;
        expectedState = attested.state;
      }
    }

    const verified = await readAuthenticated(verifiedHome);
    if (verified.status === 'failed') return { ...verified, authoritativeState: current };
    if (!sameAuthenticatedEnvelope(expectedVerified, verified.authenticated)) {
      return failed('verification-failed', current);
    }
    const comparison = await readAuthenticated(comparisonHome);
    if (
      comparison.status === 'failed' ||
      !sameAuthenticatedEnvelope(verified.authenticated, comparison.authenticated)
    ) {
      return failed('verification-failed', current);
    }
    const claim: PrepareParanoidMediaVerificationRequest = {
      expected: expectedState,
      nextMediaSet: next,
      verification: {
        medium: verifiedMedium,
        version: verified.authenticated.version,
      },
    };
    let prepared: PrepareParanoidMediaVerificationResponse;
    try {
      prepared = await options.state.prepare(claim);
    } catch {
      return failed('verification-proof-failed', expectedState);
    }
    const request: PatchParanoidMediaRequest = {
      ...claim,
      verification: {
        ...claim.verification,
        proof: prepared.proof,
      },
    };

    let durable: VaultMediaState;
    let recoveredAfterPatchFailure = false;
    try {
      durable = await options.state.patch(request);
    } catch {
      // A response may be lost after commit. Resolve that ambiguity with a
      // metadata-only read; never repeat a destructive transition blindly.
      const observed = await safeGetState();
      if (observed === null || !sameSet(observed.mediaSet, next)) {
        return failed('patch-failed', observed ?? expectedState);
      }
      durable = observed;
      recoveredAfterPatchFailure = true;
    }

    // Adding Drive records it as live but deliberately does NOT make that first
    // transition proof destructive. Re-read/authenticate both now-durable media
    // and commit a separate same-set attestation. Only that durable second step
    // can later authorize removing server.
    if (added[0] === 'drive') {
      const attested = await refreshDriveAttestation(durable);
      if (attested.status === 'failed') return attested;
      durable = attested.state;
    }

    if (removed[0] === 'drive') {
      const deleted = await options.drive.delete();
      if (deleted.status !== 'ok' && deleted.status !== 'absent') {
        return {
          status: 'ok-with-drive-leftover',
          state: durable,
          deleteResult: deleted,
        };
      }
    }
    return { status: 'ok', state: durable, recoveredAfterPatchFailure };
  }

  function home(medium: VaultMedium): DataHome {
    return medium === 'server' ? options.server : options.drive;
  }

  async function ensureVerifiedCopy(
    source: ReadAuthenticatedSuccess,
    target: DataHome,
  ): Promise<ReadAuthenticatedResult> {
    const before = await target.read();
    if (before.status === 'ok') {
      const existing = await authenticateRead(before);
      if (existing.status === 'failed') return existing;
      if (sameAuthenticatedEnvelope(source.authenticated, existing.authenticated)) {
        return existing;
      }
      if (before.info.version >= source.authenticated.version) {
        return failed('stale-version', null);
      }
    } else if (before.status !== 'absent') {
      return readFailure(before);
    }

    const written = await target.write(source.envelope, {
      ifVersion: before.status === 'ok' ? before.info.version : null,
    });
    if (
      written.status !== 'ok' &&
      !(written.status === 'transport-failure' && written.failure.indeterminate === true)
    ) {
      return writeFailure(written);
    }

    // Even an acknowledged write is not trusted until the exact target is read
    // back and authenticated. An indeterminate upload follows the same probe.
    const after = await readAuthenticated(target);
    if (after.status === 'failed') return after;
    return sameAuthenticatedEnvelope(source.authenticated, after.authenticated)
      ? after
      : failed('verification-failed', null);
  }

  async function readAuthenticated(home: DataHome): Promise<ReadAuthenticatedResult> {
    const read = await home.read();
    return read.status === 'ok' ? authenticateRead(read) : readFailure(read);
  }

  async function authenticateRead(
    read: Extract<DataHomeReadResult, { status: 'ok' }>,
  ): Promise<ReadAuthenticatedResult> {
    try {
      const authenticated = await options.authenticate(read.envelope);
      if (authenticated.version !== read.info.version) {
        return failed('verification-failed', null);
      }
      return {
        status: 'ok',
        envelope: read.envelope.slice(),
        authenticated,
      };
    } catch {
      return failed('verification-failed', null);
    }
  }

  async function safeGetState(): Promise<VaultMediaState | null> {
    try {
      const observed = await options.state.get();
      return observed.privacyMode === 'paranoid' ? observed.mediaState : null;
    } catch {
      return null;
    }
  }

  async function refreshDriveAttestation(
    durable: VaultMediaState,
  ): Promise<
    { status: 'ok'; state: VaultMediaState } | Extract<MediaSwitchResult, { status: 'failed' }>
  > {
    const [server, drive] = await Promise.all([
      readAuthenticated(options.server),
      readAuthenticated(options.drive),
    ]);
    if (
      server.status === 'failed' ||
      drive.status === 'failed' ||
      !sameAuthenticatedEnvelope(server.authenticated, drive.authenticated)
    ) {
      return failed('verification-failed', durable);
    }
    const claim: PrepareParanoidMediaVerificationRequest = {
      expected: durable,
      nextMediaSet: durable.mediaSet,
      verification: {
        medium: 'drive',
        version: drive.authenticated.version,
      },
    };
    try {
      const prepared = await options.state.prepare(claim);
      const state = await options.state.patch({
        ...claim,
        verification: { ...claim.verification, proof: prepared.proof },
      });
      return { status: 'ok', state };
    } catch {
      const observed = await safeGetState();
      return observed &&
        sameSet(observed.mediaSet, durable.mediaSet) &&
        observed.driveAttestedVersion === drive.authenticated.version
        ? { status: 'ok', state: observed }
        : failed('verification-proof-failed', observed ?? durable);
    }
  }
}

type ReadAuthenticatedSuccess = {
  status: 'ok';
  envelope: Uint8Array;
  authenticated: AuthenticatedEnvelope;
};
type ReadAuthenticatedResult =
  | ReadAuthenticatedSuccess
  | {
      status: 'failed';
      reason: MediaSwitchFailureReason;
      authoritativeState: VaultMediaState | null;
    };

export function createVaultEnvelopeAuthenticator(
  vaultKey: VaultKeyMaterial,
): VaultEnvelopeAuthenticator {
  return async (envelope) => {
    const [decrypted, hash] = await Promise.all([
      decryptVaultDocument(envelope, vaultKey),
      sha256(envelope),
    ]);
    return {
      version: decrypted.header.vaultVersion,
      writeId: decrypted.header.writeId,
      sha256: hash,
    };
  };
}

function readFailure(
  result: Exclude<DataHomeReadResult, { status: 'ok' }>,
): ReadAuthenticatedResult {
  switch (result.status) {
    case 'absent':
      return failed('source-unavailable', null);
    case 'corrupt':
      return failed('corrupt', null);
    case 'transport-failure':
      return failed(transportReason(result.failure.kind), null);
  }
}

function writeFailure(
  result: Exclude<DataHomeWriteResult, { status: 'ok' }>,
): ReadAuthenticatedResult {
  switch (result.status) {
    case 'conflict':
      return failed('stale-version', null);
    case 'corrupt':
      return failed('corrupt', null);
    case 'transport-failure':
      return failed(transportReason(result.failure.kind), null);
  }
}

function transportReason(
  kind: Extract<DataHomeReadResult, { status: 'transport-failure' }>['failure']['kind'],
): MediaSwitchFailureReason {
  switch (kind) {
    case 'consent-required':
    case 'token-expired':
    case 'gesture-required':
    case 'offline':
    case 'authorization-failed':
    case 'api-failure':
      return kind;
    default:
      return 'api-failure';
  }
}

function sameAuthenticatedEnvelope(
  left: AuthenticatedEnvelope,
  right: AuthenticatedEnvelope,
): boolean {
  return (
    left.version === right.version && left.writeId === right.writeId && left.sha256 === right.sha256
  );
}

function sameSet(left: readonly VaultMedium[], right: readonly VaultMedium[]): boolean {
  return (
    left.length === right.length &&
    left.every((medium) => right.includes(medium)) &&
    right.every((medium) => left.includes(medium))
  );
}

function canonical(media: readonly VaultMedium[]): VaultMediaSet {
  return (['server', 'drive'] as const).filter(
    (medium, index, all) => media.includes(medium) && all.indexOf(medium) === index,
  );
}

function failed(
  reason: MediaSwitchFailureReason,
  authoritativeState: VaultMediaState | null,
): Extract<MediaSwitchResult, { status: 'failed' }> {
  return { status: 'failed', reason, authoritativeState };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const source = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', source));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
