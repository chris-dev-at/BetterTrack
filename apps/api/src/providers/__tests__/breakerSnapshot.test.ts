import type { AssetRef } from '@bettertrack/contracts';
import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { beforeEach, describe, expect, it } from 'vitest';

import { CircuitBreaker } from '../circuitBreaker';
import { createMarketDataService } from '../marketDataService';
import { createProviderRegistry } from '../registry';

import { createFakeProvider, sampleHistory, sampleQuote } from './fakeProvider';

/**
 * Per-capability breaker introspection for the admin operations cockpit
 * (#1406 W4, over the §13.5 V5-P1c / #1552 isolation).
 *
 * `breakerStates()` collapses a provider to its worst capability, which is
 * exactly what hides the property the isolation was built for. These tests pin
 * the new `breakerSnapshots()` dimension AND assert the collapsed view still
 * agrees with it, so the two projections cannot drift.
 */

const REF: AssetRef = { providerId: 'fake', providerRef: 'ACME' };

let redis: Redis;

beforeEach(async () => {
  redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
});

describe('CircuitBreaker.snapshot()', () => {
  it('reports a closed breaker with no error and no open timestamps', () => {
    const breaker = new CircuitBreaker('fake', { now: () => 1_000 });
    expect(breaker.snapshot()).toEqual({
      state: 'closed',
      consecutiveFailures: 0,
      failureThreshold: 5,
      openedAtMs: null,
      retryAtMs: null,
      lastError: null,
      lastErrorAtMs: null,
    });
  });

  it('counts consecutive failures before the threshold without opening', async () => {
    const breaker = new CircuitBreaker('fake', { failureThreshold: 3, now: () => 1_000 });
    await expect(breaker.execute(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');

    const snapshot = breaker.snapshot();
    expect(snapshot.state).toBe('closed');
    expect(snapshot.consecutiveFailures).toBe(1);
    expect(snapshot.failureThreshold).toBe(3);
    // Nothing tripped, so there is no tripping error to report yet.
    expect(snapshot.lastError).toBeNull();
    expect(snapshot.openedAtMs).toBeNull();
  });

  it('records the tripping error class, the open time and the retry deadline', async () => {
    let clock = 5_000;
    const breaker = new CircuitBreaker('fake', {
      failureThreshold: 1,
      openMs: 30_000,
      now: () => clock,
    });
    const err = Object.assign(new Error('upstream said no'), { name: 'RateLimitError' });
    await expect(breaker.execute(() => Promise.reject(err))).rejects.toThrow('upstream said no');

    expect(breaker.snapshot()).toMatchObject({
      state: 'open',
      // The error CLASS, not the message — the same disclosure level the admin
      // health component's `detail` already carries.
      lastError: 'RateLimitError',
      lastErrorAtMs: 5_000,
      openedAtMs: 5_000,
      retryAtMs: 35_000,
    });

    // Once the cooldown elapses the breaker reads half-open and the next call is
    // the probe, so there is no longer a deadline to wait for.
    clock = 40_000;
    expect(breaker.snapshot()).toMatchObject({ state: 'half-open', retryAtMs: null });
  });

  it('falls back to the message when the error class is the generic Error', async () => {
    const breaker = new CircuitBreaker('fake', { failureThreshold: 1, now: () => 1 });
    await expect(
      breaker.execute(() => Promise.reject(new Error('socket hang up'))),
    ).rejects.toThrow('socket hang up');
    expect(breaker.snapshot().lastError).toBe('socket hang up');
  });

  it('bounds a huge error note so nothing can be pinned through it', async () => {
    const breaker = new CircuitBreaker('fake', { failureThreshold: 1, now: () => 1 });
    const huge = 'x'.repeat(5_000);
    await expect(breaker.execute(() => Promise.reject(new Error(huge)))).rejects.toThrow();

    const { lastError } = breaker.snapshot();
    expect(lastError).not.toBeNull();
    expect(lastError!.length).toBeLessThanOrEqual(300);
    expect(lastError!.endsWith('…')).toBe(true);
  });

  it('clears the retained note on reset', async () => {
    const breaker = new CircuitBreaker('fake', { failureThreshold: 1, now: () => 1 });
    await expect(breaker.execute(() => Promise.reject(new Error('boom')))).rejects.toThrow();
    breaker.reset();
    expect(breaker.snapshot()).toMatchObject({
      state: 'closed',
      lastError: null,
      lastErrorAtMs: null,
      openedAtMs: null,
    });
  });
});

describe('MarketDataService.breakerSnapshots() — the capability dimension (#1406 W4)', () => {
  it('reports NO capability for a provider that has never been called', () => {
    const { service } = {
      service: createMarketDataService({
        registry: createProviderRegistry([createFakeProvider('fake')]),
        redis,
      }),
    };
    expect(service.breakerSnapshots()).toEqual([
      { providerId: 'fake', state: 'closed', capabilities: [] },
    ]);
  });

  it('opens ONE capability and leaves the sibling capability closed', async () => {
    // `history` rejects transiently; `quote` is healthy. This is the exact
    // property #1552/V5-P1c bought, and the one `breakerStates()` cannot show.
    const provider = createFakeProvider('fake', {
      history: () =>
        Promise.reject(new Error('socket hang up')) as Promise<ReturnType<typeof sampleHistory>>,
    });
    const service = createMarketDataService({
      registry: createProviderRegistry([provider]),
      redis,
    });

    for (let i = 0; i < 5; i += 1) {
      await expect(
        service.getHistory({ providerId: 'fake', providerRef: `T${i}` }, '1Y', '1d'),
      ).rejects.toThrow();
    }
    // A healthy quote on the same provider still goes upstream (not fail-fast).
    expect((await service.getQuote(REF)).value.price).toBe(sampleQuote().price);
    expect(provider.calls.quote).toBe(1);

    const snapshots = service.breakerSnapshots();
    expect(snapshots).toHaveLength(1);
    const snapshot = snapshots[0]!;
    expect(snapshot.providerId).toBe('fake');
    // The provider-level roll-up is the WORST capability…
    expect(snapshot.state).toBe('open');

    const byCapability = Object.fromEntries(
      snapshot.capabilities.map((entry) => [entry.capability, entry]),
    );
    // …while the per-capability dimension keeps them apart.
    expect(byCapability.history?.state).toBe('open');
    expect(byCapability.history?.lastError).toBe('socket hang up');
    expect(byCapability.quote?.state).toBe('closed');
    expect(byCapability.quote?.lastError).toBeNull();

    // Worst-first ordering: the open one is what an operator must meet first.
    expect(snapshot.capabilities[0]?.state).toBe('open');

    // And the collapsed legacy view still agrees with the roll-up.
    expect(service.breakerStates()).toEqual([{ providerId: 'fake', state: 'open' }]);
  });

  it('never reports a local provider (there is no upstream to break)', async () => {
    const upstream = createFakeProvider('fake');
    const local = { ...createFakeProvider('manual'), local: true };
    const service = createMarketDataService({
      registry: createProviderRegistry([upstream, local]),
      redis,
    });
    await service.getQuote(REF);
    expect(service.breakerSnapshots().map((entry) => entry.providerId)).toEqual(['fake']);
  });
});
