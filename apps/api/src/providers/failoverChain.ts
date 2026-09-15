import type { AssetRef, AssetType } from '@bettertrack/contracts';

import type { AssetProvider, ProviderCapability } from './AssetProvider';
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
 *    Attribution is tracked PER ASSET, not per provider: during a partial outage
 *    (one symbol degraded to the secondary while another is still on the
 *    primary) alternating reads must record one switch per asset, not one per
 *    read.
 *  - Capability-aware: a candidate that cannot serve a capability *equivalently*
 *    is skipped for it. Today that is the history price basis (see
 *    {@link AssetProvider.historyBasis}) — a money gate, since the series is
 *    cached under the primary's key and consumed as one continuous series.
 *
 * The chain sits INSIDE the market-data service's cache loader, so the cache key
 * stays keyed on the *asset's* provider (`ref.providerId`) regardless of which
 * source actually served — coalescing, serve-stale and negative caching behave
 * identically whichever provider answers. This module owns no cache or breaker
 * state of its own; the service passes in its breaker reader and its
 * `callUpstream` (timeout → retry-once → per-provider, per-capability breaker)
 * wrapper.
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

/**
 * Cap on the per-asset serving table (bounded memory): least-recently-served
 * assets are dropped. Forgetting an asset only means its next read looks like a
 * first serve — never a wrong price, and a still-degraded asset simply
 * re-records its switch.
 */
export const DEFAULT_MAX_TRACKED_ASSETS = 1000;

export interface FailoverChainSummary {
  primaryId: string;
  /**
   * Provider currently serving this chain, or null before any traffic. Derived
   * from the per-asset attribution: the chain reports a secondary as soon as ANY
   * of its assets is being served by one (the honest "partially failed over"
   * signal for the admin health panel), and the primary once every tracked asset
   * is back on it.
   */
  serving: string | null;
  /**
   * Epoch-ms the chain-level serving provider took over, or null. Stable across
   * alternating reads of a partially-degraded chain — it moves only when the
   * derived {@link serving} value itself changes.
   */
  since: number | null;
  /**
   * Full ordered candidate ids (primary first) — exactly what
   * {@link FailoverResolver.candidates} resolves for this chain's traffic, so a
   * class routed to no secondary (crypto/FX/commodities per §16 2026-07-26)
   * reports the primary alone. One summary per distinct candidate list.
   */
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
  /**
   * Read-only breaker state for a provider (never creates one). The breaker is
   * scoped per provider AND capability (§13.5 V5-P1c), so an open `history`
   * breaker must not make `quote` look unavailable; an omitted capability asks
   * for the provider's aggregate state.
   */
  breakerState: (providerId: string, capability?: ProviderCapability) => CircuitState;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Retained switch-log cap; defaults to {@link DEFAULT_MAX_SWITCH_EVENTS}. */
  maxSwitchEvents?: number;
  /** Per-asset serving-table cap; defaults to {@link DEFAULT_MAX_TRACKED_ASSETS}. */
  maxTrackedAssets?: number;
}

export interface FailoverResolver {
  /**
   * Ordered candidate providers for a ref: the primary followed by every
   * configured, registered secondary that {@link AssetProvider.canServe}s it.
   * With a `capability`, secondaries that cannot serve it equivalently are
   * dropped too — today that is the `history` price basis (money gate). Omitted
   * ⇒ the capability-independent chain (what the admin surface reports).
   */
  candidates(ref: AssetRef, capability?: ProviderCapability): AssetProvider[];
  /** True if any candidate's breaker is not open — a fresh fetch could succeed. */
  anyAvailable(ref: AssetRef, capability?: ProviderCapability): boolean;
  /**
   * Run `op` down the chain via `callUpstream` (which applies the per-provider,
   * per-capability breaker/retry/timeout). Returns the first candidate's value
   * and records the serve + any switch. A definitive not-found from the PRIMARY
   * is authoritative for the ref and is re-thrown immediately (so §5.3
   * negative-caches it) rather than failing over to a source that might map a
   * different instrument; transient primary failures and open breakers fail over
   * to the secondaries. A secondary's own not-found never propagates as the
   * primary's answer.
   *
   * `capability` names the read being made: it scopes the breaker lookups and
   * gates which secondaries may answer (history basis). It is the LAST parameter
   * and optional so the capability-independent chain stays callable as-is;
   * every production call site passes one.
   */
  run<T>(
    ref: AssetRef,
    callUpstream: (providerId: string, fn: () => Promise<T>) => Promise<T>,
    op: (provider: AssetProvider) => Promise<T>,
    isNotFound: (err: unknown) => boolean,
    capability?: ProviderCapability,
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

/**
 * True when any secondary is configured (an explicit per-class entry or the
 * default). With none, the chain is the single-provider default: not only is the
 * market-data *fetch* byte-identical, the admin surface is too — {@link
 * FailoverResolver.status} reports empty arrays so the health panel renders no
 * chrome on a default install (contract invariant: "the failover arrays are empty
 * when no secondary source is configured"; §13.5 V5-P1c AC#4 + anti-bloat).
 */
function hasConfiguredSecondary(chains: FailoverChains): boolean {
  return (
    chains.default.length > 0 || Object.values(chains.byClass).some((ids) => (ids?.length ?? 0) > 0)
  );
}

/**
 * Chain-level state derived from the per-asset attribution. One entry per
 * distinct candidate list, so a primary that routes classes differently (equity
 * → `[yahoo, stooq]`, FX → `[yahoo]`) reports each chain honestly instead of
 * advertising a secondary that would never be tried.
 */
interface ChainState {
  primaryId: string;
  /** Ordered candidate ids, primary first — the chain's identity. */
  providerIds: string[];
  /** How many currently-tracked assets each provider serves in this chain. */
  counts: Map<string, number>;
  serving: string;
  since: number;
}

export function createFailoverResolver(deps: FailoverResolverDeps): FailoverResolver {
  const { registry, chains, breakerState } = deps;
  const now = deps.now ?? Date.now;
  const maxSwitchEvents = deps.maxSwitchEvents ?? DEFAULT_MAX_SWITCH_EVENTS;
  // At least one asset is always tracked, so the serve being recorded can never
  // be the one evicted.
  const maxTrackedAssets = Math.max(1, deps.maxTrackedAssets ?? DEFAULT_MAX_TRACKED_ASSETS);
  const secondaryConfigured = hasConfiguredSecondary(chains);

  // asset (primary + ref) → which provider currently serves THAT asset. Keyed
  // per asset, not per provider: under a partial outage (AAPL on the secondary,
  // BAYN.DE still on the primary) a per-provider key would emit a spurious
  // switch on every alternating read, flushing the bounded log and making
  // `since` meaningless. Insertion order is kept LRU so the table stays bounded.
  const assetServing = new Map<string, { chainKey: string; providerId: string }>();
  // chain identity (candidate ids) → derived chain state.
  const chainStates = new Map<string, ChainState>();
  // providerId → attribution counters.
  const serves = new Map<string, { count: number; lastAt: number }>();
  // Newest-first bounded switch log. Events are per asset (deduped by the table
  // above); the admin payload shape carries no ref, so two assets failing over
  // read as two switches of the same chain — which is what happened.
  const switches: FailoverSwitchEvent[] = [];

  function secondaryIds(ref: AssetRef): readonly string[] {
    const cls = classifyRefClass(ref.providerRef);
    return chains.byClass[cls] ?? chains.default;
  }

  /**
   * Money gate (§13.5 V5-P1c): a secondary may serve `history` only when it
   * declares the SAME price basis as the asset's own provider. The series is
   * cached under the primary's key and consumed by backtests and portfolio
   * history as one continuous series, so an adjusted→unadjusted swap would
   * silently restate returns. An undeclared basis is unknown, never equal.
   */
  function servesEquivalently(
    primary: AssetProvider | undefined,
    secondary: AssetProvider,
    capability: ProviderCapability | undefined,
  ): boolean {
    if (capability !== 'history') return true;
    const basis = primary?.historyBasis;
    return basis !== undefined && secondary.historyBasis === basis;
  }

  function candidates(ref: AssetRef, capability?: ProviderCapability): AssetProvider[] {
    const primaryId = ref.providerId;
    const out: AssetProvider[] = [];
    const primary = registry.has(primaryId) ? registry.get(primaryId) : undefined;
    if (primary) out.push(primary);
    const seen = new Set<string>(out.map((p) => p.id));
    for (const id of secondaryIds(ref)) {
      if (seen.has(id) || !registry.has(id)) continue;
      const provider = registry.get(id);
      // A secondary that cannot map this ref is skipped, so its "not found" is
      // never mistaken for the asset's answer.
      if (provider.canServe && !provider.canServe(ref)) continue;
      if (!servesEquivalently(primary, provider, capability)) continue;
      out.push(provider);
      seen.add(id);
    }
    return out;
  }

  /** The chain's candidate ids for the admin surface, primary first. */
  function chainIds(ref: AssetRef): string[] {
    const ids = candidates(ref).map((p) => p.id);
    return ids.includes(ref.providerId) ? ids : [ref.providerId, ...ids];
  }

  function anyAvailable(ref: AssetRef, capability?: ProviderCapability): boolean {
    return candidates(ref, capability).some((p) => breakerState(p.id, capability) !== 'open');
  }

  function addCount(chain: ChainState, providerId: string, delta: number): void {
    const next = (chain.counts.get(providerId) ?? 0) + delta;
    if (next > 0) chain.counts.set(providerId, next);
    else chain.counts.delete(providerId);
  }

  /**
   * Chain-level serving provider: any asset on a secondary means the chain is
   * (at least partly) failed over — report that secondary, the one carrying the
   * most assets. Otherwise the primary, once it serves anything. Null while the
   * chain tracks no asset at all (everything evicted), in which case the last
   * known value is kept rather than invented.
   */
  function aggregateServing(chain: ChainState): string | null {
    let best: string | null = null;
    let bestCount = 0;
    for (const id of chain.providerIds) {
      if (id === chain.primaryId) continue;
      const count = chain.counts.get(id) ?? 0;
      if (count > bestCount) {
        best = id;
        bestCount = count;
      }
    }
    if (best !== null) return best;
    return (chain.counts.get(chain.primaryId) ?? 0) > 0 ? chain.primaryId : null;
  }

  function refreshChainServing(chainKey: string, at: number): void {
    const chain = chainStates.get(chainKey);
    if (!chain) return;
    const next = aggregateServing(chain);
    if (next === null || next === chain.serving) return;
    chain.serving = next;
    chain.since = at;
  }

  /** Drop the least-recently-served asset, keeping its chain's counts honest. */
  function evictOldestAsset(at: number): void {
    const oldest = assetServing.entries().next();
    if (oldest.done) return;
    const [key, entry] = oldest.value;
    assetServing.delete(key);
    const chain = chainStates.get(entry.chainKey);
    if (!chain) return;
    addCount(chain, entry.providerId, -1);
    refreshChainServing(entry.chainKey, at);
  }

  function recordServe(ref: AssetRef, providerId: string): void {
    const at = now();
    const primaryId = ref.providerId;
    const stat = serves.get(providerId) ?? { count: 0, lastAt: 0 };
    stat.count += 1;
    stat.lastAt = at;
    serves.set(providerId, stat);

    const ids = chainIds(ref);
    const chainKey = ids.join('>');
    let chain = chainStates.get(chainKey);
    if (!chain) {
      chain = { primaryId, providerIds: ids, counts: new Map(), serving: providerId, since: at };
      chainStates.set(chainKey, chain);
    }

    const assetKey = `${primaryId}\u0000${ref.providerRef}`;
    const previous = assetServing.get(assetKey);
    // Re-insert so the table is ordered least-recently-served first.
    assetServing.delete(assetKey);
    assetServing.set(assetKey, { chainKey, providerId });
    while (assetServing.size > maxTrackedAssets) evictOldestAsset(at);

    // Same asset, same source ⇒ nothing changed: no switch, no chain movement.
    if (previous && previous.chainKey === chainKey && previous.providerId === providerId) return;

    if (previous) {
      const previousChain = chainStates.get(previous.chainKey);
      if (previousChain) addCount(previousChain, previous.providerId, -1);
    }
    addCount(chain, providerId, 1);

    const from = previous?.providerId ?? null;
    // The very first serve of an asset by its primary is a boot event, not a switch.
    if (from !== null || providerId !== primaryId) {
      switches.unshift({ primaryId, from, to: providerId, at });
      if (switches.length > maxSwitchEvents) switches.length = maxSwitchEvents;
    }

    refreshChainServing(chainKey, at);
    if (previous && previous.chainKey !== chainKey) refreshChainServing(previous.chainKey, at);
  }

  async function run<T>(
    ref: AssetRef,
    callUpstream: (providerId: string, fn: () => Promise<T>) => Promise<T>,
    op: (provider: AssetProvider) => Promise<T>,
    isNotFound: (err: unknown) => boolean,
    capability?: ProviderCapability,
  ): Promise<T> {
    const chain = candidates(ref, capability);
    const primaryId = ref.providerId;
    // The transient primary error is what we surface if every source fails, so a
    // primary outage never looks like a not-found (which would be negative-cached).
    let primaryError: unknown;
    let sawPrimary = false;
    for (const provider of chain) {
      const isPrimary = provider.id === primaryId;
      try {
        const value = await callUpstream(provider.id, () => op(provider));
        recordServe(ref, provider.id);
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
    // No secondary configured ⇒ the failover surface is the byte-identical
    // default: report nothing, even after the primary has served traffic, so the
    // admin health panel renders no chrome on a single-provider deploy.
    if (!secondaryConfigured) return { chains: [], switches: [], attribution: [] };
    // One summary per distinct candidate list actually exercised, so the
    // advertised candidates always match what `candidates()` would resolve for
    // that traffic (a class routed to no secondary reports the primary alone).
    const chainSummaries: FailoverChainSummary[] = [...chainStates.values()].map((chain) => ({
      primaryId: chain.primaryId,
      serving: chain.serving,
      since: chain.since,
      providerIds: [...chain.providerIds],
    }));
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
