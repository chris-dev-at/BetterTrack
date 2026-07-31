import {
  VAULT_DOCUMENT_V1_VERSION,
  VAULT_FORMAT_VERSION,
  type ParanoidEnableRequest,
  type ParanoidEnableResponse,
  type VaultDocument,
  type VaultMediaSet,
  type VaultWrappedKey,
} from '@bettertrack/contracts';

import { enableParanoidMode } from '../../../lib/userApi';
import { equalBytes, zeroBytes } from '../bytes';
import {
  deriveVaultKek,
  encryptVaultDocument,
  generateVaultKey,
  newKdfParams,
  wrapVaultKey,
} from '../crypto';
import type { DataHome, DataHomeReadResult } from '../dataHome';
import { openVaultSession } from '../engine/session';
import { VaultCryptoError } from '../errors';
import { toStrictRestoreDocument } from '../paranoidDisable';
import { serializeRecoveryKit, type RecoveryKitDownload } from '../recovery';

export type VaultEnableStage =
  | 'migrate'
  | 'validate'
  | 'encrypt'
  | 'write-server'
  | 'write-drive'
  | 'verify-server'
  | 'verify-drive'
  | 'commit';

export class VaultEnableError extends Error {
  constructor(
    readonly stage: VaultEnableStage,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'VaultEnableError';
  }
}

export interface PreparedVaultMaterial {
  readonly keyId: string;
  readonly vaultKey: Uint8Array;
  readonly wrappedKey: VaultWrappedKey;
  readonly recoveryKit: RecoveryKitDownload;
  dispose(): void;
}

export interface EnableVaultDependencies {
  server: DataHome;
  drive?: DataHome;
  migrate(signal?: AbortSignal): Promise<VaultDocument>;
  commit?(body: ParanoidEnableRequest): Promise<ParanoidEnableResponse>;
  now?: () => string;
  id?: () => string;
}

export interface EnableVaultInput {
  mediaSet: VaultMediaSet;
  material: PreparedVaultMaterial;
  signal?: AbortSignal;
  onStage?: (stage: VaultEnableStage) => void;
}

export interface EnabledVault {
  envelope: Uint8Array;
  version: number;
  receipt: ParanoidEnableResponse;
}

/** Generate one VK, passphrase wrapper, and the forced recovery artifact. */
export async function prepareVaultMaterial(
  passphrase: string,
  options: { id?: () => string } = {},
): Promise<PreparedVaultMaterial> {
  const keyId = (options.id ?? (() => globalThis.crypto.randomUUID()))();
  const vaultKey = generateVaultKey();
  const kdf = newKdfParams();
  const kek = await deriveVaultKek(passphrase, kdf);
  try {
    const wrappedKey = await wrapVaultKey(vaultKey, kek, keyId, kdf);
    const recoveryKit = serializeRecoveryKit({
      keyId,
      vaultKey,
      formatVersion: VAULT_FORMAT_VERSION,
    });
    let disposed = false;
    return {
      keyId,
      vaultKey,
      wrappedKey,
      recoveryKit,
      dispose() {
        if (disposed) return;
        disposed = true;
        zeroBytes(vaultKey);
      },
    };
  } catch (cause) {
    zeroBytes(vaultKey);
    throw cause;
  } finally {
    zeroBytes(kek);
  }
}

/**
 * Migrate → encrypt → write/read-verify each selected medium → commit the
 * destructive server transaction. Nothing clears normal data before commit.
 */
export async function enablePreparedVault(
  input: EnableVaultInput,
  dependencies: EnableVaultDependencies,
): Promise<EnabledVault> {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const id = dependencies.id ?? (() => globalThis.crypto.randomUUID());
  const commit = dependencies.commit ?? enableParanoidMode;
  const homes = selectedHomes(input.mediaSet, dependencies);

  input.onStage?.('migrate');
  let document: VaultDocument;
  try {
    input.signal?.throwIfAborted();
    document = await dependencies.migrate(input.signal);
    input.signal?.throwIfAborted();
  } catch (cause) {
    throw stageError('migrate', 'Your existing data could not be prepared safely.', cause);
  }

  /*
   * The pre-commit proof. Enable is one-way and destructive: after the commit
   * the vault is the only copy, so a document either validator rejects is
   * unrecoverable account destruction. Prove BOTH acceptances now, before the
   * first medium write, while "your normal account is unchanged" is still true:
   *
   * 1. `openVaultSession` — the exact client path every later unlock takes
   *    (`engine/session.ts`: strict entities, frozen tax facts, tax settings,
   *    the full relationship graph).
   * 2. `toStrictRestoreDocument` — the exact restore-boundary conversion the
   *    disable exit ships to `validateCustomAssetFacts`/`validateGraph`, so a
   *    document that opens but could never be disabled also stops here.
   */
  input.onStage?.('validate');
  try {
    const session = openVaultSession(document);
    toStrictRestoreDocument(session.document);
  } catch (cause) {
    throw stageError(
      'validate',
      'The prepared vault failed its pre-enable safety check. Nothing was written and your normal account is unchanged.',
      cause,
    );
  }

  const observations = await Promise.all(
    homes.map(async ({ stage, home }) => {
      const result = await home.read();
      return { stage, home, result };
    }),
  );
  const nextVersion =
    observations.reduce((highest, observation) => {
      if (observation.result.status === 'absent') return highest;
      if (observation.result.status !== 'ok') {
        throw stageError(
          observation.stage === 'write-server' ? 'write-server' : 'write-drive',
          'The existing encrypted storage copy could not be inspected safely.',
          readFailure(observation.result),
        );
      }
      return Math.max(highest, observation.result.info.version);
    }, 0) + 1;

  input.onStage?.('encrypt');
  let envelope: Uint8Array;
  try {
    const encrypted = await encryptVaultDocument({
      document,
      vaultKey: input.material.vaultKey,
      header: {
        keyId: input.material.keyId,
        wrappedKeys: [input.material.wrappedKey],
        vaultVersion: nextVersion,
        deviceId: id(),
        writeId: id(),
        writtenAt: now(),
      },
    });
    envelope = encrypted.envelope;
  } catch (cause) {
    throw stageError('encrypt', 'The vault could not be encrypted on this device.', cause);
  }

  try {
    for (const observation of observations) {
      input.signal?.throwIfAborted();
      input.onStage?.(observation.stage);
      const ifVersion = observation.result.status === 'ok' ? observation.result.info.version : null;
      const written = await observation.home.write(envelope, { ifVersion });
      if (written.status !== 'ok') {
        throw stageError(
          observation.stage,
          'The encrypted vault copy could not be saved. Your normal account is unchanged.',
          'failure' in written ? written.failure : written,
        );
      }
    }

    for (const observation of observations) {
      input.signal?.throwIfAborted();
      const verifyStage = observation.stage === 'write-server' ? 'verify-server' : 'verify-drive';
      input.onStage?.(verifyStage);
      const readBack = await observation.home.read();
      if (
        readBack.status !== 'ok' ||
        readBack.info.version !== nextVersion ||
        !equalBytes(readBack.envelope, envelope)
      ) {
        throw stageError(
          verifyStage,
          'The encrypted copy could not be verified. Your normal account is unchanged.',
          readFailure(readBack),
        );
      }
    }

    input.onStage?.('commit');
    try {
      const driveSelected = input.mediaSet.includes('drive');
      const receipt = await commit({
        mediaSet: input.mediaSet,
        vaultVersion: nextVersion,
        driveAttestation: driveSelected
          ? { verifiedRoundTrip: true, vaultVersion: nextVersion }
          : null,
      });
      return { envelope, version: nextVersion, receipt };
    } catch (cause) {
      throw stageError(
        'commit',
        'BetterTrack did not switch modes. Your normal account data is still usable.',
        cause,
      );
    }
  } catch (cause) {
    zeroBytes(envelope);
    throw cause;
  }
}

export function emptyVaultDocument(): VaultDocument {
  return { schemaVersion: VAULT_DOCUMENT_V1_VERSION, entities: {}, mergeLog: [] };
}

function selectedHomes(
  mediaSet: VaultMediaSet,
  dependencies: EnableVaultDependencies,
): Array<{ stage: 'write-server' | 'write-drive'; home: DataHome }> {
  return mediaSet.map((medium) => {
    if (medium === 'server') return { stage: 'write-server' as const, home: dependencies.server };
    if (dependencies.drive == null) {
      throw new VaultEnableError(
        'write-drive',
        'Google Drive storage is unavailable for this deployment.',
      );
    }
    return { stage: 'write-drive' as const, home: dependencies.drive };
  });
}

function readFailure(result: DataHomeReadResult): unknown {
  if (result.status === 'transport-failure') return result.failure;
  return result;
}

function stageError(stage: VaultEnableStage, message: string, cause: unknown): VaultEnableError {
  if (cause instanceof DOMException && cause.name === 'AbortError') {
    return new VaultEnableError(stage, 'Vault setup was cancelled.', { cause });
  }
  if (cause instanceof VaultEnableError) return cause;
  if (cause instanceof VaultCryptoError && cause.code === 'update-required') {
    return new VaultEnableError(stage, 'This encrypted copy needs a newer BetterTrack version.', {
      cause,
    });
  }
  return new VaultEnableError(stage, message, { cause });
}
