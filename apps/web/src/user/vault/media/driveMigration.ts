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

export interface DriveConnectionMigrationOptions {
  vaultId: string;
  transitionId: string;
  fromConnectionId: string;
  toConnectionId: string;
  expected: PerVaultMediaExpectedState;
  documents: readonly DriveMigrationDocument[];
  /** Authenticate the exact source envelope with the unlocked vault key. */
  authenticate(docId: string, envelope: Uint8Array): Promise<boolean>;
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
      stage: 'source-read' | 'source-authentication' | 'target-write' | 'target-readback';
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
 * authenticate Y → write Z → byte-exact readback Z → commit binding → attempt
 * deletion Y. A cleanup failure is returned after the committed state and can
 * never be collapsed into a failed migration or silently swallowed.
 *
 * Composition seam, deliberately unwired here: the caller must supply one
 * source/target `DriveDataHome` PAIR PER DOCUMENT, and the production runtime
 * still composes the single account-scoped Drive home (`media/runtime.ts`).
 * E6 (#1416) re-homes the client engine per vault/document and is where
 * Settings → Connections gets its `driveMoveVault` — until then this module is
 * reached only from `driveMigration.test.ts`.
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
