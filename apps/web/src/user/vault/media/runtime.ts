import type { VaultMediaState } from '@bettertrack/contracts';

import {
  discardParanoidServerCandidate,
  getParanoidMediaState,
  patchParanoidMedia,
  prepareParanoidMediaVerification,
  readParanoidServerCandidate,
  stageParanoidServerCandidate,
} from '../../../lib/userApi';
import type { VaultKeyMaterial } from '../crypto';
import type { DriveDataHome } from '../drive/driveDataHome';
import { createDriveDataHome } from '../drive/driveDataHome';
import type { GoogleDriveTokenClient } from '../drive/tokenClient';
import { createGoogleDriveTokenClient, googleDriveClientId } from '../drive/tokenClient';
import type { DataHome } from '../dataHome';
import { createLocalDataHome } from '../localDataHome';
import { createIndexedDbVaultQuarantineStore } from '../quarantine';
import { createServerBlobDataHome } from '../serverBlobDataHome';
import { createVaultSyncEngine } from '../sync';
import {
  createReplicatedVaultDataHome,
  createVaultReplicaMergeResolver,
} from './replicatedDataHome';
import { projectDriveSyncStatus, type ParanoidSyncStatusProjection } from './status';
import {
  createVaultEnvelopeAuthenticator,
  createBrowserVaultMediaTransitionStore,
  createVaultMediaSwitcher,
  type MediaSwitchResult,
  type VaultMediaStateApi,
  type VaultMediaSwitcher,
} from './switcher';

export type DriveConnectionState =
  | 'disconnected'
  | 'connected'
  | 'needs-sign-in'
  | 'needs-attention'
  | 'offline'
  | 'unavailable';

export interface VaultDriveConnectionController {
  prepare(): Promise<void>;
  state(media: VaultMediaState): DriveConnectionState;
  syncStatus(media: VaultMediaState): ParanoidSyncStatusProjection;
  connect(): Promise<MediaSwitchResult>;
  disconnect(): Promise<MediaSwitchResult>;
}

export interface VaultDriveSyncBridge {
  reconnect(): Promise<void>;
  snapshot(): {
    pendingLocalWrite: boolean;
    syncing: boolean;
    driveApiFailed?: boolean;
    lastWriteAt: string | null;
  };
}

export interface UnlockedVaultDriveRuntimeOptions {
  clientId?: string | null;
  tokens?: GoogleDriveTokenClient;
  server?: DataHome;
  drive?: DriveDataHome;
  state?: VaultMediaStateApi;
  sync?: VaultDriveSyncBridge;
}

let activeController: VaultDriveConnectionController | null = null;

/**
 * The unlocked PD5/PD8 vault runtime installs this narrow controller. Settings
 * can then request a switch without ever receiving the vault key, Drive token,
 * file id or raw envelope.
 */
export function installVaultDriveConnectionController(
  controller: VaultDriveConnectionController,
): () => void {
  activeController = controller;
  return () => {
    if (activeController === controller) activeController = null;
  };
}

export function driveConnectionState(media: VaultMediaState): DriveConnectionState {
  if (activeController) return activeController.state(media);
  return 'unavailable';
}

export function driveConnectionConfigured(): boolean {
  return googleDriveClientId() !== null;
}

export function driveConnectionReady(): boolean {
  return activeController !== null;
}

export function driveSyncStatus(media: VaultMediaState): ParanoidSyncStatusProjection {
  if (activeController) return activeController.syncStatus(media);
  return projectDriveSyncStatus({
    durable: media,
    token: { status: media.mediaSet.includes('drive') ? 'token-expired' : 'consent-required' },
    pendingLocalWrite: false,
    syncing: false,
    lastWriteAt: null,
  });
}

export async function prepareDriveConnection(): Promise<void> {
  await activeController?.prepare();
}

export async function connectDriveConnection(): Promise<MediaSwitchResult> {
  if (!activeController) return unavailableResult();
  return activeController.connect();
}

export async function disconnectDriveConnection(): Promise<MediaSwitchResult> {
  if (!activeController) return unavailableResult();
  return activeController.disconnect();
}

export function createVaultDriveConnectionController(options: {
  tokens: GoogleDriveTokenClient;
  switcher: VaultMediaSwitcher;
  sync?: VaultDriveSyncBridge;
}): VaultDriveConnectionController {
  return {
    async prepare() {
      await options.tokens.prepare();
      if (options.tokens.status().status === 'ready') {
        await options.sync?.reconnect();
      }
    },

    state(media) {
      if (options.switcher.needsDriveCleanup()) return 'needs-attention';
      if (!media.mediaSet.includes('drive')) return 'disconnected';
      switch (options.tokens.status().status) {
        case 'ready':
          return 'connected';
        case 'offline':
          return 'offline';
        case 'consent-required':
        case 'token-expired':
        case 'gesture-required':
          return 'needs-sign-in';
        case 'authorization-failed':
          return 'unavailable';
      }
    },

    syncStatus(media) {
      const snapshot = options.sync?.snapshot() ?? {
        pendingLocalWrite: false,
        syncing: false,
        lastWriteAt: null,
      };
      return projectDriveSyncStatus({
        durable: media,
        token: options.tokens.status(),
        ...snapshot,
      });
    },

    async connect() {
      const authorized = await options.tokens.authorize();
      if (authorized.status !== 'ok') {
        return {
          status: 'failed',
          reason: authorized.reason,
          authoritativeState: null,
        };
      }
      const result = await options.switcher.add('drive');
      if (result.status !== 'failed') await options.sync?.reconnect();
      return result;
    },

    async disconnect() {
      if (options.switcher.needsDriveCleanup() && options.tokens.status().status !== 'ready') {
        const authorized = await options.tokens.authorize();
        if (authorized.status !== 'ok') {
          return {
            status: 'failed',
            reason: authorized.reason,
            authoritativeState: null,
          };
        }
      }
      const result = await options.switcher.remove('drive');
      if (result.status === 'ok' || result.status === 'no-op') {
        await options.tokens.disconnect();
      }
      // A leftover ciphertext warning intentionally keeps the token live so the
      // user can retry cleanup from their own Drive.
      return result;
    },
  };
}

/**
 * Real browser composition boundary installed by the vault lock after a
 * successful unlock. This is the only place that combines the in-memory GIS
 * client, Drive/server DataHomes, signed transition API, switcher and optional
 * PD5 sync bridge; Settings receives only the narrow controller above.
 */
export function installUnlockedVaultDriveRuntime(
  vaultKey: VaultKeyMaterial,
  keyId: string,
  options: UnlockedVaultDriveRuntimeOptions = {},
): () => void {
  const clientId = options.clientId === undefined ? googleDriveClientId() : options.clientId;
  if (!clientId) return () => undefined;

  const tokens = options.tokens ?? createGoogleDriveTokenClient({ clientId });
  const server = options.server ?? createServerBlobDataHome();
  const drive = options.drive ?? createDriveDataHome({ tokens });
  const state: VaultMediaStateApi = options.state ?? {
    get: getParanoidMediaState,
    prepare: prepareParanoidMediaVerification,
    patch: patchParanoidMedia,
    stageServer: stageParanoidServerCandidate,
    readServerCandidate: readParanoidServerCandidate,
    discardServerCandidate: discardParanoidServerCandidate,
  };
  const switcher = createVaultMediaSwitcher({
    state,
    server,
    drive,
    authenticate: createVaultEnvelopeAuthenticator(vaultKey),
    transitions: createBrowserVaultMediaTransitionStore(keyId),
  });
  const sync =
    options.sync ??
    createDefaultSyncBridge({
      vaultKey,
      keyId,
      state,
      server,
      drive,
    });
  const dispose = installVaultDriveConnectionController(
    createVaultDriveConnectionController({
      tokens,
      switcher,
      sync,
    }),
  );
  // Unlock is itself a reconnect boundary: start/reconcile the encrypted local
  // cache immediately. If Drive needs a fresh gesture the engine keeps the
  // candidate pending, and the controller's connect path retries after consent.
  void sync.reconnect().catch(() => undefined);
  return dispose;
}

function createDefaultSyncBridge(options: {
  vaultKey: VaultKeyMaterial;
  keyId: string;
  state: VaultMediaStateApi;
  server: DataHome;
  drive: DriveDataHome;
}): VaultDriveSyncBridge {
  const scope = `vault:${options.keyId}`;
  const local = createLocalDataHome({ scope });
  const deviceId = browserVaultDeviceId(options.keyId);
  const writeId = () => globalThis.crypto.randomUUID();
  const primary = createReplicatedVaultDataHome({
    ...options,
    authenticate: createVaultEnvelopeAuthenticator(options.vaultKey),
    resolveDivergence: createVaultReplicaMergeResolver({
      vaultKey: options.vaultKey,
      deviceId,
      writeId,
    }),
  });
  const engine = createVaultSyncEngine({
    local,
    primary,
    vaultKey: options.vaultKey,
    deviceId,
    writeId,
    quarantine: createIndexedDbVaultQuarantineStore({ scope }),
  });
  let reconnecting = false;

  return {
    async reconnect() {
      reconnecting = true;
      try {
        await engine.reconnect();
      } finally {
        reconnecting = false;
      }
    },
    snapshot() {
      const state = engine.state;
      return {
        pendingLocalWrite: state.pending !== null || state.status === 'pending-offline',
        syncing: reconnecting,
        driveApiFailed: state.status === 'conflict' || state.status === 'corrupt',
        lastWriteAt: state.active?.header.writtenAt ?? null,
      };
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

function unavailableResult(): Extract<MediaSwitchResult, { status: 'failed' }> {
  return {
    status: 'failed',
    reason: 'source-unavailable',
    authoritativeState: null,
  };
}
