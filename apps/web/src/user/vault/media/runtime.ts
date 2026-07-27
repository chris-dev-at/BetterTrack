import {
  discardVaultServerCandidate,
  getVaultMediaState,
  patchVaultMedia,
  purgeRetiredVaultServer,
  readVaultServerCandidate,
  stageVaultServerCandidate,
} from '../../../lib/userApi';
import type { VaultKeyMaterial } from '../crypto';
import type { DataHome } from '../dataHome';
import {
  createDriveDataHome,
  createGoogleDriveTokenClient,
  type DriveDataHome,
  type GoogleDriveTokenClient,
} from '../drive';
import { createLocalDataHome } from '../localDataHome';
import { createIndexedDbVaultQuarantineStore } from '../quarantine';
import { createServerBlobDataHome } from '../serverBlobDataHome';
import { createVaultSyncEngine } from '../sync';
import {
  createDriveConnectionController,
  installDriveConnectionController,
} from './driveConnection';
import { createVaultMediaSwitcher, type VaultMediaApi } from './mediaSwitcher';
import { createReplicatedVaultDataHome } from './replicatedDataHome';
import { createVaultEnvelopeAuthenticator } from './verification';

export interface VaultDriveSyncCoordinator {
  reconnect(): Promise<unknown>;
}

export interface UnlockedVaultDriveRuntimeOptions {
  clientId?: string | null;
  tokens?: GoogleDriveTokenClient;
  server?: DataHome;
  drive?: DriveDataHome;
  api?: VaultMediaApi;
  sync?: VaultDriveSyncCoordinator;
}

/**
 * Production composition boundary for one unlocked vault. The in-memory key,
 * GIS client, Drive/server DataHomes, media switcher and existing PD5 sync
 * coordinator meet only here; Settings receives the narrow controller.
 */
export function installUnlockedVaultDriveRuntime(
  vaultKey: VaultKeyMaterial,
  keyId: string,
  options: UnlockedVaultDriveRuntimeOptions = {},
): () => void {
  const clientId =
    options.clientId === undefined
      ? (import.meta.env.VITE_GOOGLE_DRIVE_CLIENT_ID?.trim() ?? null)
      : options.clientId;
  if (!clientId) return () => undefined;

  const tokens = options.tokens ?? createGoogleDriveTokenClient({ clientId });
  const server = options.server ?? createServerBlobDataHome();
  const drive = options.drive ?? createDriveDataHome({ tokens });
  const api: VaultMediaApi = options.api ?? {
    getState: getVaultMediaState,
    patch: patchVaultMedia,
    purgeDriveRetired: purgeRetiredVaultServer,
    stageServerCandidate: stageVaultServerCandidate,
    readServerCandidate: readVaultServerCandidate,
    discardServerCandidate: discardVaultServerCandidate,
  };
  const authenticate = createVaultEnvelopeAuthenticator(vaultKey);
  const switcher = createVaultMediaSwitcher({
    api,
    server,
    drive,
    authenticate,
  });
  const sync =
    options.sync ??
    createDefaultSyncCoordinator({
      vaultKey,
      keyId,
      api,
      server,
      drive,
      authenticate,
    });
  const disposeController = installDriveConnectionController(
    createDriveConnectionController({
      tokens,
      switcher,
      resumeSync: async () => {
        await sync.reconnect();
      },
    }),
  );

  // Unlock is a reconnect boundary. Drive authorization failures remain typed
  // pending/offline state until the user's next gesture invokes the controller.
  void sync.reconnect().catch(() => undefined);

  return () => {
    disposeController();
    tokens.clear();
  };
}

function createDefaultSyncCoordinator(options: {
  vaultKey: VaultKeyMaterial;
  keyId: string;
  api: VaultMediaApi;
  server: DataHome;
  drive: DriveDataHome;
  authenticate: ReturnType<typeof createVaultEnvelopeAuthenticator>;
}): VaultDriveSyncCoordinator {
  const scope = `vault:${options.keyId}`;
  const engine = createVaultSyncEngine({
    local: createLocalDataHome({ scope }),
    primary: createReplicatedVaultDataHome(options),
    vaultKey: options.vaultKey,
    deviceId: browserVaultDeviceId(options.keyId),
    writeId: () => globalThis.crypto.randomUUID(),
    quarantine: createIndexedDbVaultQuarantineStore({ scope }),
  });
  return {
    reconnect() {
      return engine.reconnect();
    },
  };
}

function browserVaultDeviceId(keyId: string): string {
  const storageKey = `bettertrack:vault-device:${keyId}`;
  try {
    const stored = globalThis.localStorage?.getItem(storageKey);
    if (stored) return stored;
    const created = globalThis.crypto.randomUUID();
    globalThis.localStorage?.setItem(storageKey, created);
    return created;
  } catch {
    return globalThis.crypto.randomUUID();
  }
}
