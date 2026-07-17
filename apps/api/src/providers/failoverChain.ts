import type { AssetRef, AssetType } from '@bettertrack/contracts';

import type { AssetProvider } from './AssetProvider';
import type { CircuitState } from './circuitBreaker';
import type { ProviderRegistry } from './registry';

/**
 * Provider failover chain (PROJECTPLAN.md §13.5 V5-P1c). A second quote source
 * behind the §5.1 abstraction with health-based failover + recovery:
 *
 *  - The candidate order for an asset is `[primary, ...secondaries]`, where the
 *    primary is the asset's own provider (`ref.providerId`, e.g. `yahoo`) and the
 *    secondaries come from a per-asset-class config (planner-picked, e.g. Stooq
 *    for stocks/ETFs/indices). Adding a third source is config-only.
 *  - A provider is "unhealthy" when its circuit breaker is open; the chain never
 *    pre-filters on that (the breaker itself fails such a call fast), it just
 *    tries the next candidate. Recovery is automatic: once the primary's breaker
 *    half-opens and a probe succeeds, the primary serves again and a switch back
 *    is recorded.
 *  - It records which provider served each read (attribution) and the switch
 *    events, so the admin health surface can show who is serving and why.
 *
 * The chain sits INSIDE the market-data service's cache loader, so the cache key
 * stays keyed on the *asset's* provider (`ref.providerId`) regardless of which
 * source actually served — coalescing, serve-stale and negative caching behave
 * identically whichever provider answers. This module owns no cache or breaker
 * state of its own; the service passes in its breaker reader and its
 * `callUpstream` (timeout → retry-once → per-provider breaker) wrapper.
 */

/**
 * Per-asset-class failover config: the ordered *secondary* provider ids to try
 * after the asset's own provider, keyed by asset class. `default` covers classes
 * with no explicit entry. The empty config ({@link NO_FAILOVER}) means "primary
 * only" — behaviour byte-identical to a single-provider setup.
 */
export interface FailoverChains {
  /** Secondary provider ids per class; overrides `default` for that class. */
  byClass: Partial<Record<AssetType, readonly string[]>>;
  /** Secondary provider ids for classes not listed in `byClass`. */
  default: readonly string[];
}

/** The no-secondary config: every asset uses only its own provider. */
export const NO_FAILOVER: FailoverChains = { byClass: {}, default: [] };

/** Newest-first cap on the retained switch log (bounded memory). */
export const DEFAULT_MAX_SWITCH_EVENTS = 50;

export interface FailoverChainSummary {
  primaryId: string;
  /** Provider currently serving this chain, or null before any traffic. */
  serving: string | null;
  /** Epoch-ms the current serving provider took over, or null. */
  since: number | null;
  /** Full ordered candidate ids (primary first). */
  providerIds: string[];
}

export interface FailoverSwitchEvent {
  primaryId: string;
  /** Previously-serving provider, or null when nothing had served yet. */
  from: string | null;
  to: string;
  /** Epoch-ms of the switch. */
  at: number;
}

export interface ProviderServeStat {
  providerId: string;
  serves: number;
  /** Epoch-ms of the most recent read this provider served, or null. */
  lastServedAt: number | null;
}

/** Introspection snapshot for the admin health surface (§13.5 V5-P1c). */
export interface FailoverStatus {
  chains: FailoverChainSummary[];
  /** Recent switch events, newest first. */
  switches: FailoverSwitchEvent[];
  attribution: ProviderServeStat[];
}

export interface FailoverResolverDeps {
  registry: ProviderRegistry;
  chains: FailoverChains;
  /** Read-only breaker state for a provider (never creates one). */
  breakerState: (providerId: string) => CircuitState;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Retained switch-log cap; defaults to {@link DEFAULT_MAX_SWITCH_EVENTS}. */
  maxSwitchEvents?: number;
}

export interface FailoverResolver {
  /**
   * Ordered candidate providers for a ref: the primary followed by every
   * configured, registered secondary that {@link AssetProvider.canServe}s it.
   */
  candidates(ref: AssetRef): AssetProvider[];
  /** True if any candidate's breaker is not open — a fresh fetch could succeed. */
  anyAvailable(ref: AssetRef): boolean;
  /**
   * Run `op` down the chain via `callUpstream` (which applies the per-provider
   * breaker/retry/timeout). Returns the first candidate's value and records the
   * serve + any switch. A definitive not-found from the PRIMARY is authoritative
   * for the ref and is re-thrown immediately (so §5.3 negative-caches it) rather
   * than failing over to a source that might map a different instrument;
   * transient primary failures and open breakers fail over to the secondaries. A
   * secondary's own not-found never propagates as the primary's answer.
   */
  run<T>(
    ref: AssetRef,
    callUpstream: (providerId: string, fn: () => Promise<T>) => Promise<T>,
    op: (provider: AssetProvider) => Promise<T>,
    isNotFound: (err: unknown) => boolean,
  ): Promise<T>;
  /** Attribution + switch + chain snapshot for the admin health surface. */
  status(): FailoverStatus;
}

const METAL_CURRENCY_PREFIXES = ['XAU', 'XAG', 'XPT', 'XPD'];

/**
 * Coarse asset-class bucket for a yahoo-style symbol, used ONLY to pick the
 * failover chain (never a stored value). Only the buckets that route
 * differently need to be distinguished: crypto (`BTC-USD`), fx (`EURUSD=X`) and
 * commodity (`GC=F`, `XAUUSD=X`) keep their primary-only chain; everything else
 * — stocks, ETFs, indices — falls through to the equity default. A
 * misclassification only changes *whether a secondary is tried*, never a price:
 * the secondary's own {@link AssetProvider.canServe} is the real safety gate.
 */
export function classifyRefClass(providerRef: string): AssetType {
  const s = providerRef.trim().toUpperCase();
  if (s.endsWith('=X')) {
    return METAL_CURRENCY_PREFIXES.some((p) => s.startsWith(p)) ? 'commodity' : 'fx';
  }
  if (s.endsWith('=F')) return 'commodity';
  const dash = s.lastIndexOf('-');
  if (dash > 0 && /^[A-Z]{3,5}$/.test(s.slice(dash + 1))) return 'crypto';
  return 'stock';
}

export function createFailoverResolver(deps: FailoverResolverDeps): FailoverResolver {
  const { registry, chains, breakerState } = deps;
  const now = deps.now ?? Date.now;
  const maxSwitchEvents = deps.maxSwitchEvents ?? DEFAULT_MAX_SWITCH_EVENTS;

  // primaryId → currently-serving provider (+ when it took over).
  const serving = new Map<string, { providerId: string; since: number }>();
  // providerId → attribution counters.
  const serves = new Map<string, { count: number; lastAt: number }>();
  // Newest-first bounded switch log.
  const switches: FailoverSwitchEvent[] = [];

  function secondaryIds(ref: AssetRef): readonly string[] {
    const cls = classifyRefClass(ref.providerRef);
    return chains.byClass[cls] ?? chains.default;
  }

  function candidates(ref: AssetRef): AssetProvider[] {
    const primaryId = ref.providerId;
    const out: AssetProvider[] = [];
    if (registry.has(primaryId)) out.push(registry.get(primaryId));
    const seen = new Set<string>(out.map((p) => p.id));
    for (const id of secondaryIds(ref)) {
      if (seen.has(id) || !registry.has(id)) continue;
      const provider = registry.get(id);
      // A secondary that cannot map this ref is skipped, so its "not found" is
      // never mistaken for the asset's answer.
      if (provider.canServe && !provider.canServe(ref)) continue;
      out.push(provider);
      seen.add(id);
    }
    return out;
  }

  function anyAvailable(ref: AssetRef): boolean {
    return candidates(ref).some((p) => breakerState(p.id) !== 'open');
  }

  function recordServe(primaryId: string, providerId: string): void {
    const at = now();
    const stat = serves.get(providerId) ?? { count: 0, lastAt: 0 };
    stat.count += 1;
    stat.lastAt = at;
    serves.set(providerId, stat);

    const current = serving.get(primaryId);
    if (current && current.providerId === providerId) return;
    const from = current?.providerId ?? null;
    serving.set(primaryId, { providerId, since: at });
    // The very first serve by the primary itself is a boot event, not a switch.
    if (from === null && providerId === primaryId) return;
    switches.unshift({ primaryId, from, to: providerId, at });
    if (switches.length > maxSwitchEvents) switches.length = maxSwitchEvents;
  }

  async function run<T>(
    ref: AssetRef,
    callUpstream: (providerId: string, fn: () => Promise<T>) => Promise<T>,
    op: (provider: AssetProvider) => Promise<T>,
    isNotFound: (err: unknown) => boolean,
  ): Promise<T> {
    const chain = candidates(ref);
    const primaryId = ref.providerId;
    // The transient primary error is what we surface if every source fails, so a
    // primary outage never looks like a not-found (which would be negative-cached).
    let primaryError: unknown;
    let sawPrimary = false;
    for (const provider of chain) {
      const isPrimary = provider.id === primaryId;
      try {
        const value = await callUpstream(provider.id, () => op(provider));
        recordServe(primaryId, provider.id);
        return value;
      } catch (err) {
        if (isPrimary) {
          sawPrimary = true;
          // An authoritative not-found from the primary ends the chain (§5.3).
          if (isNotFound(err)) throw err;
          primaryError = err;
        }
        // Secondary failures (incl. their own not-found) are swallowed: try next.
      }
    }
    if (sawPrimary) throw primaryError;
    // The primary was not even a candidate (unregistered); surface a clear error.
    throw new Error(`No market-data provider available for "${primaryId}".`);
  }

  function status(): FailoverStatus {
    const chainSummaries: FailoverChainSummary[] = [...serving.entries()].map(
      ([primaryId, current]) => {
        // A representative equity chain: the primary plus the default secondaries.
        const providerIds = [primaryId, ...chains.default].filter(
          (id, i, arr) => arr.indexOf(id) === i && (id === primaryId || registry.has(id)),
        );
        return { primaryId, serving: current.providerId, since: current.since, providerIds };
      },
    );
    const attribution: ProviderServeStat[] = [...serves.entries()].map(([providerId, stat]) => ({
      providerId,
      serves: stat.count,
      lastServedAt: stat.lastAt || null,
    }));
    return {
      chains: chainSummaries,
      switches: switches.map((s) => ({ ...s })),
      attribution,
    };
  }

  return { candidates, anyAvailable, run, status };
}
