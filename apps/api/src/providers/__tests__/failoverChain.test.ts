import type { AssetRef, PricePoint, Quote } from '@bettertrack/contracts';
import { describe, expect, it } from 'vitest';

import type { AssetProvider, HistoryBasis } from '../AssetProvider';
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

describe('FailoverResolver — the history basis gate (§13.5 V5-P1c, money)', () => {
  const ADJUSTED: PricePoint[] = [{ time: '2026-07-15T00:00:00.000Z', close: 100 }];
  const RAW: PricePoint[] = [{ time: '2026-07-15T00:00:00.000Z', close: 140 }];

  /** A provider that declares (or withholds) a history basis and counts its reads. */
  function historyProvider(
    id: string,
    historyBasis: HistoryBasis | undefined,
    history: () => Promise<PricePoint[]>,
    quote: () => Promise<Quote> = () => Promise.resolve(Q(1)),
  ): AssetProvider & { calls: { history: number } } {
    const calls = { history: 0 };
    return {
      id,
      calls,
      ...(historyBasis ? { historyBasis } : {}),
      search: async () => [],
      getQuote: quote,
      getHistory: async () => {
        calls.history += 1;
        return history();
      },
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

  function chainOf(primary: AssetProvider, secondary: AssetProvider) {
    return createFailoverResolver({
      registry: createProviderRegistry([primary, secondary]),
      chains: { byClass: {}, default: [secondary.id] },
      breakerState: () => 'closed',
    });
  }

  const readHistory = (resolver: ReturnType<typeof chainOf>) =>
    resolver.run(
      REF,
      passthrough,
      (p) => p.getHistory(REF, '1Y', '1d'),
      isNotFoundError,
      'history',
    );

  it('drops an unadjusted secondary from the history chain while quotes keep flowing', async () => {
    const yahoo = historyProvider(
      'yahoo',
      'adjusted',
      () => Promise.reject(new Error('yahoo history down')),
      () => Promise.reject(new Error('yahoo down')),
    );
    const stooq = historyProvider(
      'stooq',
      'unadjusted',
      () => Promise.resolve(RAW),
      () => Promise.resolve(Q(2)),
    );
    const resolver = chainOf(yahoo, stooq);

    expect(resolver.candidates(REF, 'history').map((p) => p.id)).toEqual(['yahoo']);
    expect(resolver.candidates(REF, 'quote').map((p) => p.id)).toEqual(['yahoo', 'stooq']);

    // The backtest read surfaces the PRIMARY's error instead of silently
    // handing back a raw series, and the secondary is never even asked.
    await expect(readHistory(resolver)).rejects.toThrowError('yahoo history down');
    expect(stooq.calls.history).toBe(0);

    // Quotes for the same dead primary still fail over (§13.5 acceptance clause):
    // the gate is history-only, because a spot price has no adjustment basis.
    const quote = await resolver.run<Quote>(REF, passthrough, op, isNotFoundError, 'quote');
    expect(quote.price).toBe(2);
  });

  it('lets a secondary declaring the SAME basis serve history', async () => {
    const yahoo = historyProvider('yahoo', 'adjusted', () =>
      Promise.reject(new Error('yahoo history down')),
    );
    const mirror = historyProvider('mirror', 'adjusted', () => Promise.resolve(ADJUSTED));
    const resolver = chainOf(yahoo, mirror);

    expect(resolver.candidates(REF, 'history').map((p) => p.id)).toEqual(['yahoo', 'mirror']);
    await expect(readHistory(resolver)).resolves.toEqual(ADJUSTED);
    expect(mirror.calls.history).toBe(1);
  });

  it('treats an UNDECLARED basis as unknown, never as "equal"', async () => {
    const adjustedPrimary = historyProvider('yahoo', 'adjusted', () => Promise.resolve(ADJUSTED));
    const mystery = historyProvider('mystery', undefined, () => Promise.resolve(RAW));
    expect(
      chainOf(adjustedPrimary, mystery)
        .candidates(REF, 'history')
        .map((p) => p.id),
    ).toEqual(['yahoo']);

    const undeclaredPrimary = historyProvider('yahoo', undefined, () => Promise.resolve(ADJUSTED));
    const declaredSecondary = historyProvider('stooq', 'unadjusted', () => Promise.resolve(RAW));
    expect(
      chainOf(undeclaredPrimary, declaredSecondary)
        .candidates(REF, 'history')
        .map((p) => p.id),
    ).toEqual(['yahoo']);
  });
});

describe('FailoverResolver — partial outage: one switch per ASSET, not per read', () => {
  const A: AssetRef = { providerId: 'yahoo', providerRef: 'AAPL' };
  const B: AssetRef = { providerId: 'yahoo', providerRef: 'BAYN.DE' };

  /** A provider whose behaviour depends on the ref (partial outages). */
  function refProvider(id: string, quote: (ref: AssetRef) => Promise<Quote>): AssetProvider {
    return {
      id,
      search: async () => [],
      getQuote: quote,
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

  it('records one switch for the degraded ref and leaves `since` stable across alternating reads', async () => {
    let t = 1000;
    let aplBroken = true;
    // Yahoo is broken for AAPL only; BAYN.DE keeps being served by the primary.
    const yahoo = refProvider('yahoo', (ref) =>
      ref.providerRef === 'AAPL' && aplBroken
        ? Promise.reject(new Error('yahoo down for AAPL'))
        : Promise.resolve(Q(1)),
    );
    const backup = refProvider('backup', () => Promise.resolve(Q(2)));
    const resolver = createFailoverResolver({
      registry: createProviderRegistry([yahoo, backup]),
      chains: { byClass: {}, default: ['backup'] },
      breakerState: () => 'closed',
      now: () => t,
    });
    const read = (ref: AssetRef): Promise<Quote> =>
      resolver.run(ref, passthrough, (p) => p.getQuote(ref), isNotFoundError, 'quote');

    // Three alternating rounds: A degraded to the secondary, B still primary.
    for (let i = 0; i < 3; i += 1) {
      t = 2000 + i * 100;
      expect((await read(A)).price).toBe(2);
      t += 10;
      expect((await read(B)).price).toBe(1);
    }

    const status = resolver.status();
    // ONE switch — the moment AAPL moved — not one per alternating read.
    expect(status.switches).toEqual([{ primaryId: 'yahoo', from: null, to: 'backup', at: 2000 }]);
    expect(status.chains).toEqual([
      { primaryId: 'yahoo', serving: 'backup', since: 2000, providerIds: ['yahoo', 'backup'] },
    ]);
    expect(status.attribution).toEqual(
      expect.arrayContaining([
        { providerId: 'backup', serves: 3, lastServedAt: 2200 },
        { providerId: 'yahoo', serves: 3, lastServedAt: 2210 },
      ]),
    );

    // AAPL recovers ⇒ the chain is back on the primary, and only THEN does
    // `since` move: it marks a real transition, not the last read.
    aplBroken = false;
    t = 3000;
    expect((await read(A)).price).toBe(1);
    const recovered = resolver.status();
    expect(recovered.chains[0]).toMatchObject({ serving: 'yahoo', since: 3000 });
    expect(recovered.switches[0]).toEqual({
      primaryId: 'yahoo',
      from: 'backup',
      to: 'yahoo',
      at: 3000,
    });
    expect(recovered.switches).toHaveLength(2);
  });
});

describe('FailoverResolver.status — the reported chain is class-specific (§16 2026-07-26)', () => {
  it('an fx ref reports the primary alone, exactly as candidates() resolves it', async () => {
    const yahoo = provider('yahoo', () => Q(1));
    const backup = provider('backup', () => Q(2));
    const resolver = createFailoverResolver({
      registry: createProviderRegistry([yahoo, backup]),
      // Crypto/FX/commodities stay single-source in v5; equities get the secondary.
      chains: { byClass: { crypto: [], fx: [], commodity: [] }, default: ['backup'] },
      breakerState: () => 'closed',
      now: () => 5000,
    });
    const EURUSD: AssetRef = { providerId: 'yahoo', providerRef: 'EURUSD=X' };

    await resolver.run(EURUSD, passthrough, (p) => p.getQuote(EURUSD), isNotFoundError, 'quote');
    expect(resolver.candidates(EURUSD).map((p) => p.id)).toEqual(['yahoo']);
    expect(resolver.status().chains).toEqual([
      { primaryId: 'yahoo', serving: 'yahoo', since: 5000, providerIds: ['yahoo'] },
    ]);

    // An equity read adds the chain that DOES have a secondary; the fx row is
    // still reported honestly rather than being widened to ['yahoo','backup'].
    await resolver.run(REF, passthrough, op, isNotFoundError, 'quote');
    expect(resolver.status().chains).toEqual([
      { primaryId: 'yahoo', serving: 'yahoo', since: 5000, providerIds: ['yahoo'] },
      { primaryId: 'yahoo', serving: 'yahoo', since: 5000, providerIds: ['yahoo', 'backup'] },
    ]);
  });
});
