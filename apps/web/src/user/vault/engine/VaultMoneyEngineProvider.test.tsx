import { webcrypto } from 'node:crypto';
import { StrictMode } from 'react';

import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { MarketDataSource } from '../../../lib/marketDataSource';
import { VaultCryptoError } from '../errors';
import type { VaultDriveSyncCoordinator } from '../media/runtime';
import type { VaultSyncEngine, VaultSyncState } from '../sync';
import type { VaultMoneyOutcome } from './errors';
import type { StandingOrderMaterializationResult } from '../standingOrders/materialize';
import { createVaultMoneyEngine } from './index';
import {
  CLIENT_MONEY_IDS,
  createClientMoneyMarket,
  createMutableTestSync,
  decryptClientMoneyFixture,
} from './clientMoney.testSupport';
import type { VaultMoneyEngine } from './types';
import { useVaultMoneySession, type VaultMoneySession } from './VaultMoneyEngineContext';
import { moneyEngineSyncAccess, VaultMoneyEngineProvider } from './VaultMoneyEngineProvider';

const LOCKED: VaultSyncState = { status: 'locked', active: null, pending: null };

function fakeSync(): VaultSyncEngine {
  return {
    deviceId: 'device-test',
    state: LOCKED,
    start: async () => LOCKED,
    reconnect: async () => LOCKED,
    mutate: async () => LOCKED,
  };
}

function fakeMarket(): MarketDataSource {
  const unavailable = () => Promise.reject(new Error('unused in provider tests'));
  return { quote: unavailable, history: unavailable, search: unavailable, fx: unavailable };
}

function fakeEngine(): VaultMoneyEngine {
  const catchUp: VaultMoneyOutcome<StandingOrderMaterializationResult> = {
    ok: true,
    value: { today: '2026-07-28', booked: [], deferred: [], failed: [], skipped: [] },
  };
  return {
    onAppOpen: vi.fn(async () => catchUp),
    afterUnlock: vi.fn(async () => catchUp),
    getLastStandingOrderMaterialization: vi.fn(() => null),
    subscribeStandingOrderMaterialization: vi.fn(() => () => undefined),
    derivePortfolio: vi.fn(),
    deriveTaxReport: vi.fn(),
    clearCache: vi.fn(),
  };
}

function Probe() {
  const session = useVaultMoneySession();
  return <span>{session === null ? 'locked' : 'unlocked'}</span>;
}

describe('VaultMoneyEngineProvider', () => {
  it('provides no money session while there is no unlocked sync seam', () => {
    render(
      <VaultMoneyEngineProvider dependencies={{ market: fakeMarket() }}>
        <Probe />
      </VaultMoneyEngineProvider>,
    );
    expect(screen.getByText('locked')).toBeInTheDocument();
  });

  it('creates one engine per unlocked seam and runs the after-unlock catch-up boundary', async () => {
    const sync = fakeSync();
    const market = fakeMarket();
    const engine = fakeEngine();
    const createEngine = vi.fn(() => engine);
    const { rerender } = render(
      <VaultMoneyEngineProvider dependencies={{ sync, market, createEngine }}>
        <Probe />
      </VaultMoneyEngineProvider>,
    );

    expect(screen.getByText('unlocked')).toBeInTheDocument();
    expect(createEngine).toHaveBeenCalledTimes(1);
    // The engine receives the session-scoped revocable seam, which delegates
    // to the injected sync while the session lives.
    const [seam, marketArg] = createEngine.mock.calls[0] as unknown as [
      VaultSyncEngine,
      MarketDataSource,
    ];
    expect(marketArg).toBe(market);
    expect(seam.deviceId).toBe(sync.deviceId);
    expect(seam.state).toBe(sync.state);
    await waitFor(() => expect(engine.afterUnlock).toHaveBeenCalledTimes(1));

    // A re-render with the same seam neither rebuilds the engine nor re-runs catch-up.
    rerender(
      <VaultMoneyEngineProvider dependencies={{ sync, market, createEngine }}>
        <Probe />
      </VaultMoneyEngineProvider>,
    );
    expect(createEngine).toHaveBeenCalledTimes(1);
    expect(engine.afterUnlock).toHaveBeenCalledTimes(1);
  });

  it('drops the session and clears derived caches when the vault locks', async () => {
    const sync = fakeSync();
    const market = fakeMarket();
    const engine = fakeEngine();
    const createEngine = vi.fn(() => engine);
    const { rerender } = render(
      <VaultMoneyEngineProvider dependencies={{ sync, market, createEngine }}>
        <Probe />
      </VaultMoneyEngineProvider>,
    );
    await waitFor(() => expect(engine.afterUnlock).toHaveBeenCalledTimes(1));

    rerender(
      <VaultMoneyEngineProvider dependencies={{ sync: null, market, createEngine }}>
        <Probe />
      </VaultMoneyEngineProvider>,
    );
    expect(screen.getByText('locked')).toBeInTheDocument();
    expect(engine.clearCache).toHaveBeenCalled();
  });

  it('locking revokes the session seam — stale holders fail locked, never reaching the old sync', async () => {
    const sync = fakeSync();
    const mutateSpy = vi.spyOn(sync, 'mutate');
    const reconnectSpy = vi.spyOn(sync, 'reconnect');
    const market = fakeMarket();
    const engine = fakeEngine();
    let seam: VaultSyncEngine | null = null;
    const createEngine = vi.fn((sessionSync: VaultSyncEngine) => {
      seam = sessionSync;
      return engine;
    });
    const { rerender } = render(
      <VaultMoneyEngineProvider dependencies={{ sync, market, createEngine }}>
        <Probe />
      </VaultMoneyEngineProvider>,
    );
    await waitFor(() => expect(engine.afterUnlock).toHaveBeenCalledTimes(1));
    expect(seam!.state).toBe(sync.state);

    rerender(
      <VaultMoneyEngineProvider dependencies={{ sync: null, market, createEngine }}>
        <Probe />
      </VaultMoneyEngineProvider>,
    );

    expect(() => seam!.state).toThrowError(VaultCryptoError);
    await expect(
      seam!.mutate(() => {
        throw new Error('a revoked seam must fail before invoking the mutator');
      }),
    ).rejects.toMatchObject({ code: 'locked' });
    await expect(seam!.reconnect()).rejects.toMatchObject({ code: 'locked' });
    expect(mutateSpy).not.toHaveBeenCalled();
    expect(reconnectSpy).not.toHaveBeenCalled();
  });

  it('keeps the session armed through StrictMode double-invoked effects', async () => {
    const sync = fakeSync();
    const market = fakeMarket();
    const engine = fakeEngine();
    let seam: VaultSyncEngine | null = null;
    const createEngine = vi.fn((sessionSync: VaultSyncEngine) => {
      seam = sessionSync;
      return engine;
    });
    render(
      <StrictMode>
        <VaultMoneyEngineProvider dependencies={{ sync, market, createEngine }}>
          <Probe />
        </VaultMoneyEngineProvider>
      </StrictMode>,
    );
    await waitFor(() => expect(engine.afterUnlock).toHaveBeenCalled());

    // StrictMode ran mount → cleanup (revoke) → mount (restore): still live.
    expect(screen.getByText('unlocked')).toBeInTheDocument();
    expect(seam!.state).toBe(sync.state);
  });

  it('a lock mid-catch-up stops the fire-and-forget standing-order run at the seam', async () => {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
    const fixture = await decryptClientMoneyFixture();
    const document = structuredClone(fixture.document);
    // Two occurrences due at the pinned clock: the lock lands inside the first
    // booking, so the second must never reach the underlying sync.
    document.entities.standingOrder = ['301', '302'].map((suffix, index) => ({
      id: `018f0000-0000-7000-8000-000000000${suffix}`,
      rev: 0,
      editedAt: '2026-07-20T08:00:00.000Z',
      editedBy: CLIENT_MONEY_IDS.device,
      deletedAt: null,
      data: {
        userId: CLIENT_MONEY_IDS.user,
        portfolioId: CLIENT_MONEY_IDS.portfolio,
        kind: 'cash-add',
        assetId: null,
        amount: '25',
        currency: 'EUR',
        label: `Salary ${index + 1}`,
        cadence: 'daily',
        anchorDay: null,
        startDate: '2026-07-20',
        endDate: null,
        status: 'active',
        lastRunAt: null,
        lastPeriodKey: null,
        createdAt: '2026-07-20T08:00:00.000Z',
        updatedAt: '2026-07-20T08:00:00.000Z',
      },
    }));
    const raw = createMutableTestSync(document, fixture.header, fixture.envelope);
    let signalMutateStarted!: () => void;
    const mutateStarted = new Promise<void>((resolve) => {
      signalMutateStarted = resolve;
    });
    let releaseMutate!: () => void;
    const mutateGate = new Promise<void>((resolve) => {
      releaseMutate = resolve;
    });
    const sync: VaultSyncEngine = {
      deviceId: raw.deviceId,
      get state() {
        return raw.state;
      },
      start: () => raw.start(),
      reconnect: () => raw.reconnect(),
      mutate: async (mutator) => {
        signalMutateStarted();
        await mutateGate;
        return raw.mutate(mutator);
      },
    };
    const market = createClientMoneyMarket().market;
    // The REAL engine with a pinned clock — only the wiring stays injectable.
    const createEngine: typeof createVaultMoneyEngine = (sessionSync, sessionMarket) =>
      createVaultMoneyEngine(sessionSync, sessionMarket, {
        now: () => Date.parse('2026-07-26T22:30:00.000Z'),
      });
    let captured: VaultMoneySession | null = null;
    function Capture() {
      const session = useVaultMoneySession();
      if (session !== null) captured = session;
      return null;
    }
    const { rerender } = render(
      <VaultMoneyEngineProvider dependencies={{ sync, market, createEngine }}>
        <Capture />
      </VaultMoneyEngineProvider>,
    );
    const session = captured!;
    expect(session).not.toBeNull();
    await mutateStarted; // the catch-up is parked inside its first booking

    rerender(
      <VaultMoneyEngineProvider dependencies={{ sync: null, market, createEngine }}>
        <Capture />
      </VaultMoneyEngineProvider>,
    );
    releaseMutate();

    // The stale session fails locked: the catch-up outcome gates derivations.
    await expect(
      session.engine.derivePortfolio(CLIENT_MONEY_IDS.portfolio, '1M'),
    ).resolves.toMatchObject({ ok: false, error: { code: 'VAULT_LOCKED' } });
    // Nothing was committed through the revoked seam — the in-flight booking's
    // own candidate revalidation fails locked inside the mutator, and the
    // second due occurrence is never even attempted.
    expect(raw.mutationCount).toBe(0);
    expect(() => session.sync.state).toThrowError(VaultCryptoError);
  });
});

describe('moneyEngineSyncAccess', () => {
  it('reflects the live coordinator state and delegates every operation', async () => {
    let state: VaultSyncState = LOCKED;
    const mutated: VaultSyncState = { status: 'synced', active: null, pending: null };
    const coordinator: VaultDriveSyncCoordinator = {
      deviceId: 'device-a',
      get state() {
        return state;
      },
      reconnect: vi.fn(async () => state),
      mutate: vi.fn(async () => mutated),
    };
    const access = moneyEngineSyncAccess(coordinator);

    expect(access.deviceId).toBe('device-a');
    expect(access.state).toBe(LOCKED);
    state = mutated;
    expect(access.state).toBe(mutated);

    const mutator = () => {
      throw new Error('never invoked by the adapter');
    };
    await expect(access.mutate(mutator)).resolves.toBe(mutated);
    expect(coordinator.mutate).toHaveBeenCalledWith(mutator);
    await expect(access.reconnect()).resolves.toBe(mutated);
    await expect(access.start()).resolves.toBe(mutated);
    expect(coordinator.reconnect).toHaveBeenCalledTimes(2);
  });
});
