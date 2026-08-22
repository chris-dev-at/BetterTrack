import {
  inspectVaultDocEnvelope,
  type PerVaultMediaExpectedState,
  type PerVaultMediaState,
  type PerVaultMediaTransitionRequest,
} from '@bettertrack/contracts';

import { equalBytes } from '../bytes';
import type { DriveDataHome, DriveReplicaCycle } from '../drive';

export interface DriveMigrationDocument {
  docId: string;
  source: DriveDataHome;
  target: DriveDataHome;
}

/** The §8 identity echo carried, under encryption, by the vault header doc. */
export interface DriveMigrationIdentity {
  googleSub: string;
  email: string;
}

export interface DriveConnectionMigrationOptions {
  vaultId: string;
  transitionId: string;
  fromConnectionId: string;
  toConnectionId: string;
  /** Which document carries the §8 `driveConnection` echo; must be listed in `documents`. */
  headerDocId: string;
  /** The target principal the header must name once the move commits. */
  toIdentity: DriveMigrationIdentity;
  /**
   * CAS view of the media config, and it must still hold AFTER the identity
   * echo is rewritten: a doc write does not touch `mediaAttestedAt`, but a
   * caller that refreshes the attestation in the same step must re-read it.
   */
  expected: PerVaultMediaExpectedState;
  documents: readonly DriveMigrationDocument[];
  /** Authenticate the exact source envelope with the unlocked vault key. */
  authenticate(docId: string, envelope: Uint8Array): Promise<boolean>;
  /**
   * Rewrite the header doc's §8 `driveConnection` echo to `identity` through
   * the caller's NORMAL replicated write path — every active medium, server
   * included — and resolve once it has landed.
   *
   * It cannot be a Drive-side re-encrypt: a byte-copy would leave the encrypted
   * header naming the OLD principal, so words + the right Google login would no
   * longer discover the vault after the move; and for a replicated vault the
   * server's per-doc attestation rows would disagree with the new Drive bytes,
   * which is exactly what `PATCH /vaults/:id/media` verifies. Running it here,
   * before anything is written to the target, keeps both facts true at once.
   */
  rewriteDriveIdentityEcho(identity: DriveMigrationIdentity): Promise<void>;
  transition(request: PerVaultMediaTransitionRequest): Promise<PerVaultMediaState>;
}

export interface DriveMigrationCleanupFailure {
  docId: string;
  message: string;
}

export type DriveConnectionMigrationResult =
  | {
      status: 'ok';
      state: PerVaultMediaState;
      cleanupFailures: DriveMigrationCleanupFailure[];
    }
  | {
      status: 'failed';
      stage:
        | 'identity-echo'
        | 'source-read'
        | 'source-authentication'
        | 'target-write'
        | 'target-readback';
      docId: string;
      message: string;
    };

interface PreparedDocument {
  input: DriveMigrationDocument;
  cycle: DriveReplicaCycle;
  envelope: Uint8Array;
  docVersion: number;
  writeId: string;
}

/**
 * Replace a vault's Drive principal with the §7 ordering barrier:
 * rewrite the §8 identity echo to Z → authenticate Y → write Z → byte-exact
 * readback Z → commit binding → attempt deletion Y. A cleanup failure is
 * returned after the committed state and can never be collapsed into a failed
 * migration or silently swallowed.
 *
 * Composition seam, deliberately unwired here: the caller must supply one
 * source/target `DriveDataHome` PAIR PER DOCUMENT plus a replicated-write path
 * for `rewriteDriveIdentityEcho`, and the production runtime still composes the
 * single account-scoped envelope-v1 Drive home (`media/runtime.ts`), which has
 * neither. E6 (#1416) re-homes the client engine per vault/document and is
 * where Settings → Connections gets its `driveMoveVault`; E8 (#1418) brings the
 * vault UI that surfaces it — until then this module is reached only from
 * `driveMigration.test.ts`. Two acceptance lines of #1415 therefore complete
 * with #1416/#1418, not here: "both vaults sync" and "a failure to delete from
 * Y is reported to the user, not swallowed". Logged in PROJECTPLAN §16
 * (2026-08-22) so the gap is recorded rather than claimed as shipped.
 */
export async function migrateDriveConnection(
  options: DriveConnectionMigrationOptions,
): Promise<DriveConnectionMigrationResult> {
  if (
    options.expected.driveConnectionId !== options.fromConnectionId ||
    !options.expected.media.includes('drive')
  ) {
    throw new Error('Drive migration expected state does not name the source connection.');
  }
  // Source and target must differ. With `from === to` both homes resolve to the
  // SAME Drive object (same account/vault/doc ⇒ same name digest and
  // appProperties): the target read would return the source bytes, the write
  // would be skipped as already-equal, the binding flip would be a no-op, and
  // the cleanup would then delete the file precisely BECAUSE nothing had
  // changed — the only copy gone, reported as `status: 'ok'`. No guard further
  // down can catch that; they all confirm the source is untouched, which is the
  // state that makes deletion wrong here.
  if (options.fromConnectionId === options.toConnectionId) {
    throw new Error('Drive migration source and target connection must differ.');
  }
  if (!options.documents.some(({ docId }) => docId === options.headerDocId)) {
    throw new Error('Drive migration must carry the vault header document.');
  }

  // Before ANY target write: the encrypted header must name Z. This is a normal
  // replicated write, so the server's attestation rows and the Drive copy move
  // together and the roster attested at the flip below is the post-rewrite one.
  try {
    await options.rewriteDriveIdentityEcho(options.toIdentity);
  } catch (cause) {
    return {
      status: 'failed',
      stage: 'identity-echo',
      docId: options.headerDocId,
      message:
        cause instanceof Error
          ? cause.message
          : 'The vault header could not be rewritten for the target Drive connection.',
    };
  }

  // Read the source AFTER the rewrite, so the bytes copied to Z (and the
  // docVersion/writeId attested for the header) are the ones that name Z.
  const prepared: PreparedDocument[] = [];
  for (const input of options.documents) {
    const cycle = await input.source.observeReplicas();
    const readable = cycle.observations.filter(
      (result): result is Extract<(typeof cycle.observations)[number], { status: 'ok' }> =>
        result.status === 'ok',
    );
    if (readable.length !== 1 || cycle.observations.length !== 1) {
      return {
        status: 'failed',
        stage: 'source-read',
        docId: input.docId,
        message: 'The source Drive document is missing, unreadable, or has unresolved duplicates.',
      };
    }
    const source = readable[0]!;
    if (!(await options.authenticate(input.docId, source.envelope.slice()))) {
      return {
        status: 'failed',
        stage: 'source-authentication',
        docId: input.docId,
        message: 'The source Drive document did not authenticate with this vault key.',
      };
    }
    const inspected = inspectVaultDocEnvelope(source.envelope);
    if (
      inspected.status !== 'supported' ||
      inspected.header.vaultId !== options.vaultId ||
      inspected.header.docId !== input.docId
    ) {
      return {
        status: 'failed',
        stage: 'source-read',
        docId: input.docId,
        message: 'The source Drive document address does not match the vault migration.',
      };
    }
    prepared.push({
      input,
      cycle,
      envelope: source.envelope.slice(),
      docVersion: inspected.header.docVersion,
      writeId: inspected.header.writeId,
    });
  }

  for (const item of prepared) {
    const existing = await item.input.target.read();
    if (existing.status === 'ok' && equalBytes(existing.envelope, item.envelope)) continue;
    const written = await item.input.target.write(item.envelope, {
      ifVersion: existing.status === 'ok' ? existing.info.version : null,
    });
    if (written.status !== 'ok') {
      return {
        status: 'failed',
        stage: 'target-write',
        docId: item.input.docId,
        message: 'The target Drive connection did not accept the encrypted document.',
      };
    }
    const readback = await item.input.target.read();
    if (readback.status !== 'ok' || !equalBytes(readback.envelope, item.envelope)) {
      return {
        status: 'failed',
        stage: 'target-readback',
        docId: item.input.docId,
        message: 'The target Drive connection could not verify the written document.',
      };
    }
  }

  const state = await options.transition({
    transitionId: options.transitionId,
    expected: options.expected,
    next: {
      media: options.expected.media,
      driveConnectionId: options.toConnectionId,
    },
    verification: {
      kind: 'drive',
      driveConnectionId: options.toConnectionId,
      docs: prepared.map(({ input, docVersion, writeId }) => ({
        docId: input.docId,
        docVersion,
        writeId,
      })),
    },
  });

  const cleanupFailures: DriveMigrationCleanupFailure[] = [];
  for (const item of prepared) {
    const deleted = await item.cycle.deleteIfUnchanged(async (observations) => {
      const only = observations[0];
      return (
        observations.length === 1 &&
        only?.status === 'ok' &&
        equalBytes(only.envelope, item.envelope) &&
        (await options.authenticate(item.input.docId, only.envelope.slice()))
      );
    });
    if (deleted.status !== 'ok') {
      cleanupFailures.push({ docId: item.input.docId, message: deleted.failure.message });
    }
  }
  return { status: 'ok', state, cleanupFailures };
}
