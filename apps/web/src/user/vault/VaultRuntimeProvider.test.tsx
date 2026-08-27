import { webcrypto } from 'node:crypto';

import { useState } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { base64ToBytes } from './bytes';
import type { DataHomeReadResult } from './dataHome';
import type { DriveAccessTokenResult, DriveDataHome, GoogleDriveTokenClient } from './drive';
import {
  requestVaultLock,
  VAULT_LOCK_REQUEST_EVENT,
  vaultLockSignalStorageKey,
} from './lockSignal';
import type {
  DriveConnectionController,
  UnlockedVaultDriveRuntime,
  VaultDriveSyncCoordinator,
} from './media';
import { EndpointVaultKeystore } from './keystore/core';
import { createVaultTransferRuntime } from './qr/runtime';
import type { VaultSyncState } from './sync';
import {
  useVaultRuntime,
  VaultRuntimeProvider,
  type VaultRuntimeProviderDependencies,
} from './VaultRuntimeProvider';
import { vaultInteroperabilityFixture as fixture } from '@bettertrack/domain/vaultVectors';

const envelope = base64ToBytes(fixture.initial.envelopeBase64, 'envelope-invalid');

// Every unlock below derives the real production Argon2id profile (64 MiB,
// t=3) and then unwraps through WebCrypto, which costs seconds of wall clock on
// a CI runner shared with the rest of the suite. The 1s testing-library default
// expires mid-unlock and reports the still-locked DOM as a provider defect
// (#930), so each wait behind an unlock gets a KDF-sized budget instead. The
// per-test ceiling backing it lives in vite.config.ts.
const UNLOCK_WAIT = { timeout: 15_000 } as const;

/**
 * Mirrors `createReplicaReconcileCoordinator`: `state` is a GETTER that hands
 * out a fresh `{ ...state }` snapshot on every read. That is what makes the
 * provider's 1 Hz poll a re-render trap, so the test double has to reproduce
 * it rather than return one frozen object.
 */
function testSyncCoordinator(onStateRead: () => void = () => undefined) {
  const state: VaultSyncState = { status: 'synced', active: null, pending: null };
  return {
    deviceId: 'test-device',
    get state() {
      onStateRead();
      return { ...state };
    },
    reconnect: async () => ({ ...state }),
    mutate: async () => ({ ...state }),
  } satisfies VaultDriveSyncCoordinator;
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

function memoryTokenClient(): GoogleDriveTokenClient {
  const okToken: DriveAccessTokenResult = {
    status: 'ok',
    accessToken: 'memory-only',
    expiresAt: Date.now() + 60_000,
  };
  return {
    state: 'connected',
    getAccessToken: vi.fn(() => okToken),
    subscribe: vi.fn(() => () => undefined),
    prepare: vi.fn(async () => undefined),
    authorize: vi.fn(async () => okToken),
    clear: vi.fn(),
    markExpired: vi.fn(),
    markRevoked: vi.fn(),
    identify: vi.fn(),
  };
}

/**
 * §12 is binding: after logout, an explicit lock or the PIN idle-lock, the NEXT
 * vault read prompts again. `unlockFromDevice` decides that from one persisted
 * marker, and nothing pinned that marker until this block — which is exactly
 * how a released `lock()` refactor could stop writing it unnoticed.
 */
describe('VaultRuntimeProvider §12 device-lock marker', () => {
  const userId = '018f0000-0000-7000-8000-0000000000d4';
  const markerKey = `bettertrack:vault-device-locked:${userId}`;

  it('records the marker when the shared lock signal fires', async () => {
    render(
      <VaultRuntimeProvider
        authenticated
        userId={userId}
        dependencies={{ clientId: null, tokens: memoryTokenClient() }}
      >
        <TrustedDeviceHarness />
      </VaultRuntimeProvider>,
    );
    expect(localStorage.getItem(markerKey)).toBeNull();

    await act(async () => {
      globalThis.dispatchEvent(new Event(VAULT_LOCK_REQUEST_EVENT));
    });

    expect(localStorage.getItem(markerKey)).toBe('1');
  });

  it('refuses the trusted-device unlock afterwards without reading any medium', async () => {
    const readEnvelope = vi.fn(async () => envelope);
    render(
      <VaultRuntimeProvider
        authenticated
        userId={userId}
        dependencies={{ clientId: null, tokens: memoryTokenClient(), readEnvelope }}
      >
        <TrustedDeviceHarness />
      </VaultRuntimeProvider>,
    );

    await act(async () => {
      globalThis.dispatchEvent(new Event(VAULT_LOCK_REQUEST_EVENT));
    });
    await userEvent.setup().click(screen.getByRole('button', { name: 'trusted unlock' }));

    expect(await screen.findByText('device unlock refused', undefined, UNLOCK_WAIT)).toBeVisible();
    expect(readEnvelope).not.toHaveBeenCalled();
  });

  it('keeps broadcasting the account-scoped cross-tab lock from the relocated seam', async () => {
    render(
      <VaultRuntimeProvider
        authenticated
        userId={userId}
        dependencies={{ clientId: null, tokens: memoryTokenClient() }}
      >
        <TrustedDeviceHarness />
      </VaultRuntimeProvider>,
    );

    await act(async () => {
      requestVaultLock(userId);
    });

    expect(localStorage.getItem(vaultLockSignalStorageKey(userId))).not.toBeNull();
    expect(localStorage.getItem(markerKey)).toBe('1');
  });
});

describe('VaultRuntimeProvider Drive bootstrap', () => {
  it('synchronously revokes the endpoint transfer session on manual and cross-tab locks', async () => {
    const userId = '018f0000-0000-7000-8000-000000000099';
    const keystore = new EndpointVaultKeystore();
    const sessionEnded = vi.fn();
    keystore.subscribeToSessionEnd(sessionEnded);
    const transferRuntime = createVaultTransferRuntime({
      keystore,
      bindLockSignal: false,
      requestJson: vi.fn(),
    });

    render(
      <VaultRuntimeProvider authenticated userId={userId} dependencies={{ transferRuntime }}>
        <ManualLockHarness />
      </VaultRuntimeProvider>,
    );

    await userEvent.setup().click(screen.getByRole('button', { name: 'manual lock' }));
    expect(sessionEnded).toHaveBeenCalledTimes(1);

    globalThis.dispatchEvent(
      new StorageEvent('storage', {
        key: `bettertrack:vault-lock:${userId}`,
        newValue: 'remote-lock',
      }),
    );
    await waitFor(() => expect(sessionEnded).toHaveBeenCalledTimes(2));
  });

  it('authorizes Drive-only before unlock and obeys a same-account second-tab lock', async () => {
    const events: string[] = [];
    let authorization: GoogleDriveTokenClient['state'] = 'consent-required';
    const tokens: GoogleDriveTokenClient = {
      get state() {
        return authorization;
      },
      getAccessToken: vi.fn(
        (): DriveAccessTokenResult =>
          authorization === 'connected'
            ? { status: 'ok', accessToken: 'memory-only', expiresAt: Date.now() + 60_000 }
            : { status: authorization, message: 'sign in' },
      ),
      subscribe: vi.fn(() => () => undefined),
      prepare: vi.fn(async () => undefined),
      authorize: vi.fn(async (): Promise<DriveAccessTokenResult> => {
        events.push('authorize');
        authorization = 'connected';
        return { status: 'ok', accessToken: 'memory-only', expiresAt: Date.now() + 60_000 };
      }),
      clear: vi.fn(() => {
        authorization = 'consent-required';
      }),
      markExpired: vi.fn(() => {
        authorization = 'token-expired';
      }),
      markRevoked: vi.fn(() => {
        authorization = 'revoked';
      }),
      identify: vi.fn(),
    };
    const drive: DriveDataHome = {
      medium: 'drive',
      read: vi.fn(async (): Promise<DataHomeReadResult> => {
        events.push('drive-read');
        return {
          status: 'ok',
          medium: 'drive',
          envelope,
          info: {
            medium: 'drive',
            version: fixture.initial.header.vaultVersion,
            sizeBytes: envelope.byteLength,
            updatedAt: fixture.initial.header.writtenAt,
          },
        };
      }),
      async observeReplicas() {
        return {
          observations: [await this.read()],
          async converge() {
            throw new Error('The single-file test Drive cannot converge duplicates.');
          },
          async deleteIfUnchanged() {
            throw new Error('The provider regression does not delete Drive.');
          },
        };
      },
      write: vi.fn(),
      info: vi.fn(),
    };
    const controller = connection();
    const dispose = vi.fn();
    const createRuntime: NonNullable<VaultRuntimeProviderDependencies['createRuntime']> = vi.fn(
      (_vaultKey, keyId): UnlockedVaultDriveRuntime => {
        events.push('runtime');
        expect(keyId).toBe(fixture.initial.header.keyId);
        return {
          controller,
          sync: testSyncCoordinator(),
          ready: Promise.resolve(),
          syncState: { status: 'synced', active: null, pending: null },
          reconnect: vi.fn(async () => ({
            status: 'synced' as const,
            active: null,
            pending: null,
          })),
          dispose,
        };
      },
    );
    const serverRead = vi.fn();
    const rendered = render(
      <VaultRuntimeProvider
        authenticated
        userId="018f0000-0000-7000-8000-000000000099"
        dependencies={{
          clientId: 'browser-client-id',
          tokens,
          drive,
          readEnvelope: serverRead,
          createRuntime,
        }}
      >
        <UnlockHarness />
      </VaultRuntimeProvider>,
    );

    await userEvent.setup().click(screen.getByRole('button', { name: 'unlock' }));
    expect(await screen.findByText('unlocked', undefined, UNLOCK_WAIT)).toBeInTheDocument();

    expect(events).toEqual(['authorize', 'drive-read', 'runtime']);
    expect(serverRead).not.toHaveBeenCalled();
    expect(createRuntime).toHaveBeenCalledTimes(1);

    globalThis.dispatchEvent(
      new StorageEvent('storage', {
        key: 'bettertrack:vault-lock:018f0000-0000-7000-8000-000000000099',
        newValue: 'remote-lock',
      }),
    );
    await waitFor(() => expect(screen.getByText('no connection')).toBeInTheDocument(), UNLOCK_WAIT);
    expect(dispose).toHaveBeenCalledTimes(1);

    rendered.unmount();
    await waitFor(() => expect(dispose).toHaveBeenCalledTimes(1), UNLOCK_WAIT);
    expect(tokens.clear).toHaveBeenCalled();
  });

  it('recreates the account-scoped Drive adapter when the BetterTrack user changes', async () => {
    const okToken: DriveAccessTokenResult = {
      status: 'ok',
      accessToken: 'memory-only',
      expiresAt: Date.now() + 60_000,
    };
    const tokens: GoogleDriveTokenClient = {
      state: 'connected',
      getAccessToken: vi.fn(() => okToken),
      subscribe: vi.fn(() => () => undefined),
      prepare: vi.fn(async () => undefined),
      authorize: vi.fn(async () => okToken),
      clear: vi.fn(),
      markExpired: vi.fn(),
      markRevoked: vi.fn(),
      identify: vi.fn(),
    };
    const driveHomes: DriveDataHome[] = [];
    const runtimeOwners: string[] = [];
    const createRuntime: NonNullable<VaultRuntimeProviderDependencies['createRuntime']> = vi.fn(
      (_vaultKey, _keyId, options): UnlockedVaultDriveRuntime => {
        if (!options.drive) throw new Error('Expected an account-scoped Drive adapter.');
        driveHomes.push(options.drive);
        runtimeOwners.push(options.userId);
        return {
          controller: connection(),
          sync: testSyncCoordinator(),
          ready: Promise.resolve(),
          syncState: { status: 'synced', active: null, pending: null },
          reconnect: vi.fn(async () => ({
            status: 'synced' as const,
            active: null,
            pending: null,
          })),
          dispose: vi.fn(),
        };
      },
    );
    const dependencies: VaultRuntimeProviderDependencies = {
      clientId: 'browser-client-id',
      tokens,
      readEnvelope: vi.fn(async () => envelope),
      createRuntime,
    };
    const firstUser = '018f0000-0000-7000-8000-0000000000a1';
    const secondUser = '018f0000-0000-7000-8000-0000000000b2';
    const rendered = render(
      <VaultRuntimeProvider authenticated userId={firstUser} dependencies={dependencies}>
        <UnlockHarness driveOnly={false} />
      </VaultRuntimeProvider>,
    );

    await userEvent.setup().click(screen.getByRole('button', { name: 'unlock' }));
    await waitFor(() => expect(createRuntime).toHaveBeenCalledTimes(1), UNLOCK_WAIT);

    rendered.rerender(
      <VaultRuntimeProvider authenticated userId={secondUser} dependencies={dependencies}>
        <UnlockHarness driveOnly={false} />
      </VaultRuntimeProvider>,
    );
    await waitFor(() => expect(screen.getByText('no connection')).toBeInTheDocument(), UNLOCK_WAIT);
    await userEvent.setup().click(screen.getByRole('button', { name: 'unlocked' }));
    await waitFor(() => expect(createRuntime).toHaveBeenCalledTimes(2), UNLOCK_WAIT);

    expect(runtimeOwners).toEqual([firstUser, secondUser]);
    expect(driveHomes).toHaveLength(2);
    expect(driveHomes[1]).not.toBe(driveHomes[0]);
  });

  it('leaves consumers untouched while the polled sync snapshot is unchanged', async () => {
    const okToken: DriveAccessTokenResult = {
      status: 'ok',
      accessToken: 'memory-only',
      expiresAt: Date.now() + 60_000,
    };
    const tokens: GoogleDriveTokenClient = {
      state: 'connected',
      getAccessToken: vi.fn(() => okToken),
      subscribe: vi.fn(() => () => undefined),
      prepare: vi.fn(async () => undefined),
      authorize: vi.fn(async () => okToken),
      clear: vi.fn(),
      markExpired: vi.fn(),
      markRevoked: vi.fn(),
      identify: vi.fn(),
    };
    let reads = 0;
    const createRuntime: NonNullable<VaultRuntimeProviderDependencies['createRuntime']> = vi.fn(
      (): UnlockedVaultDriveRuntime => {
        const sync = testSyncCoordinator(() => {
          reads += 1;
        });
        return {
          controller: connection(),
          sync,
          ready: Promise.resolve(),
          get syncState() {
            return sync.state;
          },
          reconnect: vi.fn(async () => sync.state),
          dispose: vi.fn(),
        };
      },
    );
    let renders = 0;
    render(
      <VaultRuntimeProvider
        authenticated
        userId="018f0000-0000-7000-8000-0000000000c3"
        dependencies={{
          clientId: 'browser-client-id',
          tokens,
          readEnvelope: vi.fn(async () => envelope),
          createRuntime,
        }}
      >
        <UnlockHarness driveOnly={false} />
        <RuntimeConsumer
          onRender={() => {
            renders += 1;
          }}
        />
      </VaultRuntimeProvider>,
    );

    await userEvent.setup().click(screen.getByRole('button', { name: 'unlock' }));
    expect(
      await screen.findByText('connection installed', undefined, UNLOCK_WAIT),
    ).toBeInTheDocument();

    // One poll tick lets every unlock-driven update flush, then two more prove
    // the interval is running while the consumer stays put. Before the bailout
    // the fresh `{ ...state }` snapshot rebuilt the memoised context value on
    // every tick, re-rendering every `useVaultRuntime()` consumer at 1 Hz for
    // as long as the vault stayed unlocked.
    await pollTicks(() => reads, 1);
    const settled = renders;
    await pollTicks(() => reads, 2);

    expect(renders).toBe(settled);
  });

  it.each(['authorization', 'envelope read', 'runtime readiness'] as const)(
    'rejects a stale unlock after logout during deferred %s',
    async (stage) => {
      const authorization = deferred<DriveAccessTokenResult>();
      const envelopeRead = deferred<Uint8Array>();
      const runtimeReady = deferred<void>();
      const okToken: DriveAccessTokenResult = {
        status: 'ok',
        accessToken: 'memory-only',
        expiresAt: Date.now() + 60_000,
      };
      const tokens: GoogleDriveTokenClient = {
        state: 'connected',
        getAccessToken: vi.fn(() => okToken),
        subscribe: vi.fn(() => () => undefined),
        prepare: vi.fn(async () => undefined),
        authorize: vi.fn(() =>
          stage === 'authorization' ? authorization.promise : Promise.resolve(okToken),
        ),
        clear: vi.fn(),
        markExpired: vi.fn(),
        markRevoked: vi.fn(),
        identify: vi.fn(),
      };
      const readEnvelope = vi.fn(() =>
        stage === 'envelope read' ? envelopeRead.promise : Promise.resolve(envelope),
      );
      const dispose = vi.fn();
      const createRuntime: NonNullable<VaultRuntimeProviderDependencies['createRuntime']> = vi.fn(
        (): UnlockedVaultDriveRuntime => ({
          controller: connection(),
          sync: testSyncCoordinator(),
          ready: stage === 'runtime readiness' ? runtimeReady.promise : Promise.resolve(),
          syncState: { status: 'synced', active: null, pending: null },
          reconnect: vi.fn(async () => ({
            status: 'synced' as const,
            active: null,
            pending: null,
          })),
          dispose,
        }),
      );
      const dependencies: VaultRuntimeProviderDependencies = {
        clientId: 'browser-client-id',
        tokens,
        readEnvelope,
        createRuntime,
      };
      const userId = '018f0000-0000-7000-8000-000000000099';
      const rendered = render(
        <VaultRuntimeProvider authenticated userId={userId} dependencies={dependencies}>
          <UnlockHarness driveOnly={false} />
        </VaultRuntimeProvider>,
      );

      await userEvent.setup().click(screen.getByRole('button', { name: 'unlock' }));
      if (stage === 'authorization') {
        await waitFor(() => expect(tokens.authorize).toHaveBeenCalledTimes(1), UNLOCK_WAIT);
      } else if (stage === 'envelope read') {
        await waitFor(() => expect(readEnvelope).toHaveBeenCalledTimes(1), UNLOCK_WAIT);
      } else {
        await waitFor(() => expect(createRuntime).toHaveBeenCalledTimes(1), UNLOCK_WAIT);
      }

      rendered.rerender(
        <VaultRuntimeProvider authenticated={false} userId={userId} dependencies={dependencies}>
          <UnlockHarness driveOnly={false} />
        </VaultRuntimeProvider>,
      );
      await waitFor(() => expect(tokens.clear).toHaveBeenCalled(), UNLOCK_WAIT);

      if (stage === 'authorization') authorization.resolve(okToken);
      else if (stage === 'envelope read') envelopeRead.resolve(envelope);
      else runtimeReady.resolve();

      expect(
        await screen.findByRole('button', { name: 'rejected' }, UNLOCK_WAIT),
      ).toBeInTheDocument();
      expect(screen.getByText('no connection')).toBeInTheDocument();
      if (stage === 'authorization') expect(readEnvelope).not.toHaveBeenCalled();
      if (stage !== 'runtime readiness') expect(createRuntime).not.toHaveBeenCalled();
      else expect(dispose).toHaveBeenCalled();
    },
  );
});

function UnlockHarness({ driveOnly = true }: { driveOnly?: boolean }) {
  const runtime = useVaultRuntime();
  const [status, setStatus] = useState<'unlock' | 'unlocked' | 'rejected'>('unlock');
  return (
    <>
      <button
        type="button"
        onClick={() => {
          void runtime
            .unlockWithPassphrase(fixture.passphrase, {
              authorizeDrive: true,
              driveOnly,
            })
            .then(
              () => setStatus('unlocked'),
              () => setStatus('rejected'),
            );
        }}
      >
        {status}
      </button>
      <span>{runtime.connection ? 'connection installed' : 'no connection'}</span>
    </>
  );
}

/** Renders once per context value, so its count IS the consumer re-render count. */
function RuntimeConsumer({ onRender }: { onRender(): void }) {
  useVaultRuntime();
  onRender();
  return null;
}

/** Drives the trusted-device ("keep unlocked on this device") unlock path. */
function TrustedDeviceHarness() {
  const runtime = useVaultRuntime();
  const [result, setResult] = useState('device unlock idle');
  return (
    <>
      <button
        onClick={() => {
          void runtime
            .unlockFromDevice({ authorizeDrive: false, driveOnly: false })
            .then((unlocked) =>
              setResult(unlocked ? 'device unlock accepted' : 'device unlock refused'),
            );
        }}
        type="button"
      >
        trusted unlock
      </button>
      <span>{result}</span>
    </>
  );
}

function ManualLockHarness() {
  const runtime = useVaultRuntime();
  return (
    <button onClick={() => void runtime.lock()} type="button">
      manual lock
    </button>
  );
}

/** Wait until the provider's poll has read the coordinator `count` more times. */
async function pollTicks(reads: () => number, count: number): Promise<void> {
  const from = reads();
  await waitFor(() => expect(reads()).toBeGreaterThanOrEqual(from + count), { timeout: 10_000 });
}

function connection(): DriveConnectionController {
  return {
    authorization: 'connected',
    subscribeAuthorization: vi.fn(() => () => undefined),
    connect: vi.fn(async () => ({
      status: 'authorization-required' as const,
      authorization: 'gesture-required' as const,
    })),
    disconnect: vi.fn(async () => ({
      status: 'authorization-required' as const,
      authorization: 'gesture-required' as const,
    })),
    useDriveOnly: vi.fn(async () => ({
      status: 'authorization-required' as const,
      authorization: 'gesture-required' as const,
    })),
    addServerCopy: vi.fn(async () => ({
      status: 'authorization-required' as const,
      authorization: 'gesture-required' as const,
    })),
    resume: vi.fn(async () => ({
      status: 'ok' as const,
      state: { status: 'synced' as const, active: null, pending: null },
    })),
    purgeRetiredServer: vi.fn(async () => ({
      status: 'authorization-required' as const,
      authorization: 'gesture-required' as const,
    })),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
