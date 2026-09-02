import type {
  AdminOpsCacheStats,
  AdminOpsProvider,
  AdminOpsProvidersResponse,
} from '@bettertrack/contracts';

import { cacheEventsTotal, providerCallsTotal, readCounter } from '../../metrics';
import type { MarketDataService } from '../../providers';

/**
 * The provider half of the admin operations cockpit (#1406 W4).
 *
 * Three numbers an operator wants when market data looks wrong, none of which
 * had a JSON surface before: which capability's breaker is open (and why),
 * whether the cache is absorbing the load, and how many calls actually reached
 * upstream. All three already exist — the breakers keep their own state and the
 * Prometheus registry already counts calls and cache outcomes — so this is a
 * reading of instruments that are already running, not a new instrument.
 *
 * **No quota gauge.** The #1406 DECISION is explicit: Yahoo is keyless, there is
 * no authoritative quota to draw, and a made-up one would be worse than none.
 * The honest proxy for "are we being throttled" is the 429-tripped breaker,
 * which `tripImmediately: isRateLimitError` opens on the first 429 (§5.3) and
 * which this surface reports with its `lastError`.
 *
 * **Process-local, and the payload says so.** prom-client counters live in the
 * process that increments them, so an API process reports its own calls and not
 * the worker's, and everything resets on restart. `sampledSince` carries that
 * caveat into the UI instead of letting the number imply a deployment-wide
 * all-time total.
 */

export interface ProviderOpsDeps {
  marketData: MarketDataService;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Process uptime in seconds; the counters' epoch. Defaults to `process.uptime`. */
  uptimeSeconds?: () => number;
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/** Provider call outcomes, keyed by provider id, from `bettertrack_provider_calls_total`. */
async function readCalls(): Promise<Map<string, AdminOpsProvider['calls']>> {
  const byProvider = new Map<string, AdminOpsProvider['calls']>();
  for (const sample of await readCounter(providerCallsTotal)) {
    const provider = String(sample.labels.provider ?? 'unknown');
    const entry = byProvider.get(provider) ?? { success: 0, error: 0, circuitOpen: 0 };
    const outcome = String(sample.labels.outcome ?? '');
    if (outcome === 'success') entry.success += sample.value;
    else if (outcome === 'error') entry.error += sample.value;
    else if (outcome === 'circuit_open') entry.circuitOpen += sample.value;
    byProvider.set(provider, entry);
  }
  return byProvider;
}

/** Market-cache outcomes from `bettertrack_market_cache_events_total`. */
async function readCache(): Promise<AdminOpsCacheStats> {
  let hit = 0;
  let miss = 0;
  let stale = 0;
  let negative = 0;
  for (const sample of await readCounter(cacheEventsTotal)) {
    const result = String(sample.labels.result ?? '');
    if (result === 'hit') hit += sample.value;
    else if (result === 'miss') miss += sample.value;
    else if (result === 'stale') stale += sample.value;
    else if (result === 'negative') negative += sample.value;
  }
  const total = hit + miss + stale + negative;
  return {
    hit,
    miss,
    stale,
    negative,
    total,
    // Null, not zero: a cache that has answered nothing has no hit rate, and a
    // "0 %" tile reads as a catastrophe rather than as silence.
    hitRate: total === 0 ? null : hit / total,
    staleRate: total === 0 ? null : stale / total,
  };
}

/** One read of the cockpit's Providers tab. */
export async function readProviderOps(deps: ProviderOpsDeps): Promise<AdminOpsProvidersResponse> {
  const now = deps.now ?? Date.now;
  const uptime = deps.uptimeSeconds ?? (() => process.uptime());
  const at = now();

  const [calls, cache] = await Promise.all([readCalls(), readCache()]);

  const providers: AdminOpsProvider[] = deps.marketData.breakerSnapshots().map((snapshot) => ({
    providerId: snapshot.providerId,
    state: snapshot.state,
    capabilities: snapshot.capabilities.map((capability) => ({
      capability: capability.capability,
      state: capability.state,
      consecutiveFailures: capability.consecutiveFailures,
      failureThreshold: capability.failureThreshold,
      openedAt: iso(capability.openedAtMs),
      retryAt: iso(capability.retryAtMs),
      lastError: capability.lastError,
      lastErrorAt: iso(capability.lastErrorAtMs),
    })),
    calls: calls.get(snapshot.providerId) ?? { success: 0, error: 0, circuitOpen: 0 },
  }));

  return {
    checkedAt: new Date(at).toISOString(),
    // Counters started when this process did; clamp so a clock that jumped
    // backwards cannot report a sample window from the future.
    sampledSince: new Date(Math.min(at, at - Math.max(0, uptime()) * 1000)).toISOString(),
    providers,
    cache,
  };
}
