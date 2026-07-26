import type {
  ParanoidMediaStatusResponse,
  PatchParanoidMediaRequest,
  ParanoidServerCandidateMetadata,
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
  /** Stage opaque bytes without activating the live server DataHome. */
  stageServer(envelope: Uint8Array): Promise<ParanoidServerCandidateMetadata>;
  /** Read the exact staged object back for authenticated browser verification. */
  readServerCandidate(candidate: ParanoidServerCandidateMetadata): Promise<Uint8Array>;
  /** Remove a failed/abandoned inactive candidate. */
  discardServerCandidate(candidateId: string): Promise<void>;
}

export interface VaultMediaTransitionStore {
  pendingDriveCleanup(): boolean;
  markDriveCleanup(): void;
  clearDriveCleanup(): void;
}

export interface VaultMediaSwitcherOptions {
  state: VaultMediaStateApi;
  server: DataHome;
  drive: DriveDataHome;
  authenticate: VaultEnvelopeAuthenticator;
  transitions?: VaultMediaTransitionStore;
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
  needsDriveCleanup(): boolean;
}

const DRIVE_CLEANUP_RECORD = 'drive-delete-pending-v1';

/**
 * Persist only the non-sensitive cleanup obligation, scoped by vault key id.
 * No token, Drive file id, envelope metadata, or portfolio-derived value enters
 * storage. The in-memory fallback preserves the obligation when storage access
 * is blocked by the browser.
 */
export function createBrowserVaultMediaTransitionStore(
  scope: string,
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = safeLocalStorage(),
): VaultMediaTransitionStore {
  const key = `bettertrack:vault-media-transition:${scope}`;
  let fallback = false;
  return {
    pendingDriveCleanup() {
      try {
        return storage?.getItem(key) === DRIVE_CLEANUP_RECORD || fallback;
      } catch {
        return fallback;
      }
    },
    markDriveCleanup() {
      fallback = true;
      try {
        storage?.setItem(key, DRIVE_CLEANUP_RECORD);
      } catch {
        // The in-memory fallback remains authoritative for this runtime.
      }
    },
    clearDriveCleanup() {
      fallback = false;
      try {
        storage?.removeItem(key);
      } catch {
        // The in-memory state is still cleared for this runtime.
      }
    },
  };
}

/**
 * §5 migrate-then-drop orchestration over the existing DataHome seam. It never
 * mutates the durable set until the target bytes have been read back,
 * authenticated and compared with the source.
 */
export function createVaultMediaSwitcher(options: VaultMediaSwitcherOptions): VaultMediaSwitcher {
  let operationTail = Promise.resolve();
  const transitions = options.transitions ?? createBrowserVaultMediaTransitionStore('memory', null);

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

    needsDriveCleanup() {
      return transitions.pendingDriveCleanup();
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
    if (next.includes('drive') && transitions.pendingDriveCleanup()) {
      // Re-adding/retaining Drive cancels an earlier drop intent. The existing
      // file remains a live medium and must not be deleted by a stale cleanup.
      transitions.clearDriveCleanup();
    }
    if (sameSet(current.mediaSet, next)) {
      return !next.includes('drive') && transitions.pendingDriveCleanup()
        ? cleanupDrive(current, true, false)
        : { status: 'no-op', state: current };
    }

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

      // Drive-only → both uses a proof-bound inactive candidate. The live server
      // DataHome remains absent until the browser has read and authenticated the
      // exact staged object and PATCH promotes it atomically.
      if (verifiedMedium === 'server') {
        return addServerFromDrive(source, current, next);
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

    if (removed[0] === 'drive') {
      // Record the post-commit obligation BEFORE the PATCH. If its response and
      // the immediate state probe are both lost, a later same-target retry can
      // still finish deletion before the Drive token is revoked.
      transitions.markDriveCleanup();
    }
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
      return cleanupDrive(durable, false, recoveredAfterPatchFailure);
    }
    return { status: 'ok', state: durable, recoveredAfterPatchFailure };
  }

  async function addServerFromDrive(
    source: ReadAuthenticatedSuccess,
    current: VaultMediaState,
    next: VaultMediaSet,
  ): Promise<MediaSwitchResult> {
    let candidate: ParanoidServerCandidateMetadata;
    try {
      candidate = await options.state.stageServer(source.envelope);
    } catch {
      return failed('patch-failed', current);
    }

    let stagedEnvelope: Uint8Array;
    try {
      stagedEnvelope = await options.state.readServerCandidate(candidate);
    } catch {
      await safeDiscardCandidate(candidate.candidateId);
      return failed('verification-failed', current);
    }
    const staged = await authenticateEnvelope(stagedEnvelope, candidate.version);
    if (
      staged.status === 'failed' ||
      !sameAuthenticatedEnvelope(source.authenticated, staged.authenticated)
    ) {
      await safeDiscardCandidate(candidate.candidateId);
      return failed('verification-failed', current);
    }

    // Re-read the authoritative Drive source immediately before proof creation.
    // The candidate is immutable; any intervening Drive change makes this
    // candidate stale and it is discarded rather than promoted.
    const freshDrive = await readAuthenticated(options.drive);
    if (
      freshDrive.status === 'failed' ||
      !sameAuthenticatedEnvelope(staged.authenticated, freshDrive.authenticated)
    ) {
      await safeDiscardCandidate(candidate.candidateId);
      return failed('verification-failed', current);
    }

    const claim: PrepareParanoidMediaVerificationRequest = {
      expected: current,
      nextMediaSet: next,
      verification: {
        medium: 'server',
        version: staged.authenticated.version,
        serverCandidateId: candidate.candidateId,
      },
    };
    let prepared: PrepareParanoidMediaVerificationResponse;
    try {
      prepared = await options.state.prepare(claim);
    } catch {
      await safeDiscardCandidate(candidate.candidateId);
      return failed('verification-proof-failed', current);
    }

    try {
      const durable = await options.state.patch({
        ...claim,
        verification: { ...claim.verification, proof: prepared.proof },
      });
      return { status: 'ok', state: durable, recoveredAfterPatchFailure: false };
    } catch {
      // Promotion may have committed. If metadata cannot settle that ambiguity,
      // retain the exact staged id: a retry either discovers the final set or
      // reuses the still-inactive candidate until it expires.
      const observed = await safeGetState();
      return observed !== null && sameSet(observed.mediaSet, next)
        ? { status: 'ok', state: observed, recoveredAfterPatchFailure: true }
        : failed('patch-failed', observed ?? current);
    }
  }

  async function cleanupDrive(
    durable: VaultMediaState,
    resumed: boolean,
    recoveredAfterPatchFailure: boolean,
  ): Promise<MediaSwitchResult> {
    let deleted: DriveDataHomeDeleteResult;
    try {
      deleted = await options.drive.delete();
    } catch (cause) {
      deleted = {
        status: 'transport-failure',
        medium: 'drive',
        failure: {
          kind: 'api-failure',
          message: 'The encrypted Drive file could not be deleted.',
          cause,
        },
      };
    }
    if (deleted.status !== 'ok' && deleted.status !== 'absent') {
      return {
        status: 'ok-with-drive-leftover',
        state: durable,
        deleteResult: deleted,
      };
    }
    transitions.clearDriveCleanup();
    return resumed
      ? { status: 'no-op', state: durable }
      : { status: 'ok', state: durable, recoveredAfterPatchFailure };
  }

  async function safeDiscardCandidate(candidateId: string): Promise<void> {
    try {
      await options.state.discardServerCandidate(candidateId);
    } catch {
      // The candidate is inactive and expires server-side. Cleanup failure can
      // never make it authoritative or change the durable media set.
    }
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
    return authenticateEnvelope(read.envelope, read.info.version);
  }

  async function authenticateEnvelope(
    envelope: Uint8Array,
    expectedVersion: number,
  ): Promise<ReadAuthenticatedResult> {
    try {
      const authenticated = await options.authenticate(envelope);
      if (authenticated.version !== expectedVersion) {
        return failed('verification-failed', null);
      }
      return {
        status: 'ok',
        envelope: envelope.slice(),
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

function safeLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const source = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', source));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
