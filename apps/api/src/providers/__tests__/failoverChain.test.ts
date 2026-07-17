import type { AssetRef, Quote } from '@bettertrack/contracts';
import { describe, expect, it } from 'vitest';

import type { AssetProvider } from '../AssetProvider';
import { CircuitOpenError, type CircuitState } from '../circuitBreaker';
import { AssetNotFoundError, isNotFoundError } from '../errors';
import {
  classifyRefClass,
  createFailoverResolver,
  NO_FAILOVER,
  type FailoverChains,
} from '../failoverChain';
import { createProviderRegistry } from '../registry';

const REF: AssetRef = { providerId: 'yahoo', providerRef: 'AAPL' };
const Q = (price: number): Quote => ({
  price,
  currency: 'USD',
  prevClose: null,
  dayChangePct: null,
  asOf: '2026-07-16T00:00:00.000Z',
});
const op = (p: AssetProvider): Promise<Quote> => p.getQuote(REF);
const passthrough = async <T>(_id: string, fn: () => Promise<T>): Promise<T> => fn();

function provider(
  id: string,
  quote: () => Quote | Promise<Quote>,
  canServe?: (ref: AssetRef) => boolean,
): AssetProvider {
  return {
    id,
    ...(canServe ? { canServe } : {}),
    search: async () => [],
    getQuote: async () => quote(),
    getHistory: async () => [],
    getMeta: async () => ({
      providerId: id,
      providerRef: 'AAPL',
      symbol: 'AAPL',
      name: 'Apple',
      exchange: null,
      currency: 'USD',
      type: 'stock',
    }),
  };
}

describe('classifyRefClass (§13.5 V5-P1c chain routing)', () => {
  it.each([
    ['AAPL', 'stock'],
    ['BAYN.DE', 'stock'],
    ['^GSPC', 'stock'], // indices fall through to the equity default chain
    ['BRK-B', 'stock'], // a class-share dash is not crypto
    ['BTC-USD', 'crypto'],
    ['ETH-USDT', 'crypto'],
    ['EURUSD=X', 'fx'],
    ['XAUUSD=X', 'commodity'],
    ['GC=F', 'commodity'],
  ] as const)('%s → %s', (ref, cls) => {
    expect(classifyRefClass(ref)).toBe(cls);
  });
});

describe('FailoverResolver.candidates', () => {
  const yahoo = provider('yahoo', () => Q(1));
  const backup = provider('backup', () => Q(2));

  it('is primary-only under NO_FAILOVER (byte-identical default)', () => {
    const registry = createProviderRegistry([yahoo, backup]);
    const resolver = createFailoverResolver({
      registry,
      chains: NO_FAILOVER,
      breakerState: () => 'closed',
    });
    expect(resolver.candidates(REF).map((p) => p.id)).toEqual(['yahoo']);
  });

  it('appends configured secondaries, but not for classes routed to []', () => {
    const registry = createProviderRegistry([yahoo, backup]);
    const chains: FailoverChains = { byClass: { crypto: [] }, default: ['backup'] };
    const resolver = createFailoverResolver({ registry, chains, breakerState: () => 'closed' });
    expect(resolver.candidates(REF).map((p) => p.id)).toEqual(['yahoo', 'backup']);
    expect(
      resolver.candidates({ providerId: 'yahoo', providerRef: 'BTC-USD' }).map((p) => p.id),
    ).toEqual(['yahoo']);
  });

  it('skips a secondary whose canServe declines the ref (no spurious not-found)', () => {
    const picky = provider(
      'picky',
      () => Q(3),
      (r) => r.providerRef === 'AAPL',
    );
    const registry = createProviderRegistry([yahoo, picky]);
    const chains: FailoverChains = { byClass: {}, default: ['picky'] };
    const resolver = createFailoverResolver({ registry, chains, breakerState: () => 'closed' });
    expect(resolver.candidates(REF).map((p) => p.id)).toEqual(['yahoo', 'picky']);
    expect(
      resolver.candidates({ providerId: 'yahoo', providerRef: 'MSFT' }).map((p) => p.id),
    ).toEqual(['yahoo']);
  });
});

describe('FailoverResolver.run — failover, recovery, attribution', () => {
  function harness() {
    const open = new Set<string>();
    let t = 1000;
    const yahoo = provider('yahoo', () => Q(1));
    const backup = provider('backup', () => Q(2));
    const registry = createProviderRegistry([yahoo, backup]);
    const chains: FailoverChains = { byClass: {}, default: ['backup'] };
    const resolver = createFailoverResolver({
      registry,
      chains,
      breakerState: (id): CircuitState => (open.has(id) ? 'open' : 'closed'),
      now: () => t,
    });
    // Faithful callUpstream: an open breaker fails fast without calling upstream.
    const callUpstream = async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
      if (open.has(id)) throw new CircuitOpenError(id);
      return fn();
    };
    return { resolver, open, callUpstream, setTime: (v: number) => (t = v) };
  }

  it('primary serves when healthy, secondary serves when the primary breaker is open, primary again on recovery', async () => {
    const h = harness();

    expect((await h.resolver.run(REF, h.callUpstream, op, isNotFoundError)).price).toBe(1);

    // Primary "mocked dead": its breaker is open ⇒ quotes keep flowing from backup.
    h.open.add('yahoo');
    h.setTime(2000);
    expect((await h.resolver.run(REF, h.callUpstream, op, isNotFoundError)).price).toBe(2);
    expect(h.resolver.anyAvailable(REF)).toBe(true); // backup still available

    // Recovery: primary breaker closes ⇒ traffic returns to the primary.
    h.open.delete('yahoo');
    h.setTime(3000);
    expect((await h.resolver.run(REF, h.callUpstream, op, isNotFoundError)).price).toBe(1);

    const status = h.resolver.status();
    expect(status.chains[0]).toMatchObject({
      primaryId: 'yahoo',
      serving: 'yahoo',
      since: 3000,
      providerIds: ['yahoo', 'backup'],
    });
    // The initial boot serve is not a switch; the fail-over and fail-back are.
    expect(status.switches).toEqual([
      { primaryId: 'yahoo', from: 'backup', to: 'yahoo', at: 3000 },
      { primaryId: 'yahoo', from: 'yahoo', to: 'backup', at: 2000 },
    ]);
    expect(status.attribution).toEqual(
      expect.arrayContaining([
        { providerId: 'yahoo', serves: 2, lastServedAt: 3000 },
        { providerId: 'backup', serves: 1, lastServedAt: 2000 },
      ]),
    );
  });

  it('anyAvailable is false only when every candidate breaker is open', () => {
    const h = harness();
    expect(h.resolver.anyAvailable(REF)).toBe(true);
    h.open.add('yahoo');
    expect(h.resolver.anyAvailable(REF)).toBe(true); // backup still closed
    h.open.add('backup');
    expect(h.resolver.anyAvailable(REF)).toBe(false);
  });
});

describe('FailoverResolver.status — empty without a configured secondary', () => {
  const yahoo = provider('yahoo', () => Q(1));

  it('reports empty status under NO_FAILOVER even after a successful serve', async () => {
    const registry = createProviderRegistry([yahoo]);
    const resolver = createFailoverResolver({
      registry,
      chains: NO_FAILOVER,
      breakerState: () => 'closed',
    });

    // A real serve by the primary — the boot serve populates the internal maps —
    // yet the admin projection stays empty (byte-identical single-provider default).
    expect((await resolver.run(REF, passthrough, op, isNotFoundError)).price).toBe(1);
    expect(resolver.status()).toEqual({ chains: [], switches: [], attribution: [] });
  });

  it('treats a config whose only entries are empty as no-secondary', async () => {
    const registry = createProviderRegistry([yahoo]);
    const chains: FailoverChains = { byClass: { crypto: [] }, default: [] };
    const resolver = createFailoverResolver({ registry, chains, breakerState: () => 'closed' });

    await resolver.run(REF, passthrough, op, isNotFoundError);
    expect(resolver.status()).toEqual({ chains: [], switches: [], attribution: [] });
  });
});

describe('FailoverResolver.run — not-found semantics', () => {
  it('re-throws a PRIMARY not-found without failing over (authoritative for the ref)', async () => {
    const yahoo = provider('yahoo', () => Promise.reject(new AssetNotFoundError('gone')));
    let backupCalls = 0;
    const backup = provider('backup', () => {
      backupCalls += 1;
      return Q(2);
    });
    const registry = createProviderRegistry([yahoo, backup]);
    const resolver = createFailoverResolver({
      registry,
      chains: { byClass: {}, default: ['backup'] },
      breakerState: () => 'closed',
    });
    await expect(resolver.run(REF, passthrough, op, isNotFoundError)).rejects.toBeInstanceOf(
      AssetNotFoundError,
    );
    expect(backupCalls).toBe(0); // authoritative not-found ends the chain
  });

  it('surfaces the PRIMARY transient error (not a secondary not-found) so a switch never negative-caches', async () => {
    const yahoo = provider('yahoo', () => Promise.reject(new Error('network blip')));
    const backup = provider('backup', () => Promise.reject(new AssetNotFoundError('stooq gap')));
    const registry = createProviderRegistry([yahoo, backup]);
    const resolver = createFailoverResolver({
      registry,
      chains: { byClass: {}, default: ['backup'] },
      breakerState: () => 'closed',
    });
    const err = await resolver.run(REF, passthrough, op, isNotFoundError).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isNotFoundError(err)).toBe(false);
    expect((err as Error).message).toBe('network blip');
  });
});
