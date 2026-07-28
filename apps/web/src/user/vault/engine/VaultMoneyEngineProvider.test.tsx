import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { MarketDataSource } from '../../../lib/marketDataSource';
import type { VaultDriveSyncCoordinator } from '../media/runtime';
import type { VaultSyncEngine, VaultSyncState } from '../sync';
import type { VaultMoneyOutcome } from './errors';
import type { StandingOrderMaterializationResult } from '../standingOrders/materialize';
import type { VaultMoneyEngine } from './types';
import {
  moneyEngineSyncAccess,
  useVaultMoneySession,
  VaultMoneyEngineProvider,
} from './VaultMoneyEngineProvider';

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
    value: { today: '2026-07-28', booked: [], deferred: [] },
  };
  return {
    onAppOpen: vi.fn(async () => catchUp),
    afterUnlock: vi.fn(async () => catchUp),
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
    expect(createEngine).toHaveBeenCalledWith(sync, market);
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
