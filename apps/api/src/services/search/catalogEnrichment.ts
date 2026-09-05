import { randomUUID } from 'node:crypto';

import type { Redis } from 'ioredis';

import type { AssetSearchResult } from '@bettertrack/contracts';

import type { AssetRepository } from '../../data/repositories/assetRepository';
import type { BackfillScheduler } from '../../jobs';
import type { Logger } from '../../logger';
import type { MarketDataService } from '../../providers';

/**
 * Provider-fallback orchestration for the local-first search (PROJECTPLAN.md
 * §6.2, §5.3): when the catalog comes up short, a provider search runs in the
 * **background** and upserts its hits into the catalog — the HTTP response
 * never waits on a provider. The client refetches after a short delay
 * ("Searching providers…") and the follow-up query is served the enriched rows
 * straight from Postgres.
 *
 * Coalescing is per normalized query, two layers deep:
 *  - an in-process in-flight map, so concurrent misses share one provider search;
 *  - a short-TTL Redis `SET NX` guard, so a just-enriched query — including one
 *    the providers had nothing for (a negative result) — is not re-fetched on
 *    every keystroke, and concurrent processes coalesce too. The guard value
 *    distinguishes an enrichment still `running` from one that is `done`, so a
 *    caller who loses the NX race still reports the right `enriching` flag.
 *
 * The Redis guard is a LEASE, not a flag (#1794). Two properties make the §5.3
 * "exactly one upstream fetch per key" promise hold across processes:
 *  - the lease cannot expire under its own holder: {@link ENRICH_RUN_TIMEOUT_MS}
 *    bounds one run strictly below {@link ENRICH_GUARD_TTL_SECONDS}, so no
 *    second process can win `NX` for a query that is still being fetched;
 *  - the completion write is a compare-and-set on an owner token, so a finisher
 *    can only move ITS OWN run to `done`. A blind `SET` would let a slow first
 *    holder overwrite a successor's `running` lease, after which a third caller
 *    reads `done` and is told `enriching: false` while a fetch is genuinely in
 *    flight — and the 60 s negative-cache window restarts from the wrong event.
 *
 * Per-provider request budgets are part of the §5.3 caching keystone (its own
 * P1 slice); this module consumes `marketData.search`, which is already
 * resilience-wrapped per provider. The two ceilings it does own are its own
 * write amplification (#1709): {@link ENRICH_MAX_HITS} bounds how much ONE
 * enrichment may write, and the per-user admission budget that decides HOW MANY
 * enrichments a caller may start lives one layer up, with the interactive
 * caller (`enrichmentBudget.ts` / `searchService.ts`).
 */
export interface CatalogEnrichment {
  /**
   * Request a background provider search for the (normalized) `query`.
   * Resolves as soon as the coalescing decision is made — never waits on a
   * provider. Returns true when an enrichment for this query is now running
   * (started by this call, or already in flight in this or another process),
   * false when the guard says it completed recently, so the caller knows
   * whether "Searching providers…" applies.
   */
  request(query: string): Promise<boolean>;
  /**
   * Resolves once every enrichment currently in flight has finished (graceful
   * shutdown, deterministic tests) — or once {@link ENRICH_SETTLE_TIMEOUT_MS}
   * has elapsed, whichever comes first. It is a courtesy wait, never a barrier:
   * shutdown must not be hostage to a provider that never answers.
   */
  settled(): Promise<void>;
}

/**
 * How long a query's enrichment result — including "the providers had nothing"
 * — is trusted before the fallback may run again (§5.3 negative-cache spirit).
 * The window restarts when the enrichment completes (guard flips to `done`).
 */
export const ENRICH_GUARD_TTL_SECONDS = 60;

/** Redis guard key per normalized query; lowercased so "BAYN" and "bayn" coalesce. */
export const enrichGuardKey = (query: string): string => `search:enrich:${query.toLowerCase()}`;

/**
 * How many provider hits ONE enrichment may write into the catalog (#1709).
 *
 * `marketData.search` is a `flatMap` over every registered provider with no
 * per-provider or total ceiling, and the upstream clients do not cap their own
 * result counts — so a single query could hand this loop an arbitrarily long
 * list, each entry costing a serialised upsert into the shared global `assets`
 * table plus a `prices.backfill` enqueue for every new row.
 *
 * 20 = `SEARCH_RESULT_LIMIT`: the follow-up catalog read shows at most twenty
 * rows, so hits past the twentieth cannot reach the user who caused the
 * enrichment. They are not lost either — the ranked catalog read is what
 * decides what is worth showing, and a narrower follow-up query re-runs the
 * fallback for whatever it did not admit.
 *
 * That argument only holds because {@link rankProviderHits} orders the list by
 * the SAME tiers the catalog read ranks on before this cap applies (#1794).
 */
export const ENRICH_MAX_HITS = 20;

/**
 * Guard value while the winning process is still running the provider search.
 * The shipped value carries an owner token — `running:<uuid>` — so the finisher
 * can compare-and-set (#1794); readers only ever look at this prefix, so a bare
 * `running` written by an older process still reads as "in flight".
 */
export const ENRICH_GUARD_RUNNING = 'running';
/** Guard value once the enrichment finished — negative-cache window (§5.3). */
export const ENRICH_GUARD_DONE = 'done';

/** The `running` lease held by `token`. */
const runningGuardValue = (token: string): string => `${ENRICH_GUARD_RUNNING}:${token}`;

/** Whether a guard value means "an enrichment is in flight right now". */
export const isRunningGuard = (value: string | null): boolean =>
  value !== null && value.split(':', 1)[0] === ENRICH_GUARD_RUNNING;

/**
 * Hard ceiling on ONE enrichment run, deliberately below the guard's lease
 * (`ENRICH_GUARD_TTL_SECONDS * 1000`) — the invariant that keeps §5.3's "exactly
 * one upstream fetch" true across processes (#1794).
 *
 * `run()` is unbounded by nature: a fan-out across every registered provider,
 * each with its own timeout, retry and queue wait, then up to
 * {@link ENRICH_MAX_HITS} sequential upserts and backfill enqueues. Under queue
 * backlog that can outlive a 60 s lease, and the moment it does a second process
 * wins `NX` for the same normalised query and fetches it again. Bounding the run
 * removes the window instead of papering over it with lease renewal, which would
 * make a genuinely wedged run block the query forever.
 *
 * On timeout the run is ABANDONED, not cancelled: its remaining upserts are
 * idempotent (`ON CONFLICT DO NOTHING`) and may still land, and the guard is
 * completed normally so the query is not hammered again for a window.
 */
export const ENRICH_RUN_TIMEOUT_MS = 45_000;

/**
 * Ceiling on {@link CatalogEnrichment.settled}. Graceful shutdown waits for
 * background enrichments so their writes are not torn off mid-flight, but it
 * must never be held hostage by one: past this budget the wait returns and the
 * process continues shutting down (#1794).
 */
export const ENRICH_SETTLE_TIMEOUT_MS = 10_000;

/**
 * Complete the guard only if it is still OUR lease: `running:<token>` → `done`
 * with a fresh negative-cache window. Returns 1 when this run owned the guard,
 * 0 when it had expired and someone else holds it (or it was evicted).
 */
const ENRICH_GUARD_COMPLETE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then redis.call('set', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3])) return 1 else return 0 end";

/**
 * Rank provider hits the way the catalog read ranks rows (§6.2) before the
 * {@link ENRICH_MAX_HITS} slice decides what one enrichment may write (#1794).
 *
 * `marketData.search` is a `flatMap` over the registered providers, so its order
 * is REGISTRATION order — not relevance. Slicing that raw meant a query whose
 * exact-symbol match sat at provider position 25 wrote twenty fuzzy rows and
 * dropped the one row the follow-up catalog read would have ranked tier 0; the
 * 60 s guard then suppressed the re-run, so the user's refetch showed junk and
 * no exact match. Tiers mirror the SQL exactly — exact symbol → symbol prefix →
 * name substring → the rest — and the sort is stable, so provider order still
 * decides ties within a tier.
 */
export function rankProviderHits(
  query: string,
  hits: readonly AssetSearchResult[],
): AssetSearchResult[] {
  const needle = query.trim().toLowerCase();
  const tier = (hit: AssetSearchResult): number => {
    const symbol = hit.symbol.toLowerCase();
    if (symbol === needle) return 0;
    if (symbol.startsWith(needle)) return 1;
    if (hit.name.toLowerCase().includes(needle)) return 2;
    return 3;
  };
  return hits
    .map((hit, index) => ({ hit, index, tier: tier(hit) }))
    .sort(
      // Array#sort is stable in V8, but the index tiebreak states the intent
      // rather than relying on it: within a tier, provider order is preserved.
      (a, b) => a.tier - b.tier || a.index - b.index,
    )
    .map((entry) => entry.hit);
}

export interface CatalogEnrichmentDeps {
  marketData: MarketDataService;
  assetRepo: AssetRepository;
  backfill: BackfillScheduler;
  redis: Redis;
  logger: Logger;
  /** Override for {@link ENRICH_RUN_TIMEOUT_MS} (tests drive the timeout deterministically). */
  runTimeoutMs?: number;
  /** Override for {@link ENRICH_SETTLE_TIMEOUT_MS} (tests drive the timeout deterministically). */
  settleTimeoutMs?: number;
}

/**
 * Resolve to `true` when `work` finishes inside `timeoutMs`, `false` when the
 * budget runs out first. The timer is cleared on the winning path and unref'd,
 * so neither outcome keeps the process (or a test worker) alive.
 */
async function within(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([work.then(() => true), expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface InFlightEntry {
  /** The `request()` answer, resolved as soon as the coalescing decision is made. */
  enriching: Promise<boolean>;
  /** Resolves once the guard writes + provider search + upserts have all finished. */
  settled: Promise<void>;
}

export function createCatalogEnrichment(deps: CatalogEnrichmentDeps): CatalogEnrichment {
  const { marketData, assetRepo, backfill, redis, logger } = deps;
  const runTimeoutMs = deps.runTimeoutMs ?? ENRICH_RUN_TIMEOUT_MS;
  const settleTimeoutMs = deps.settleTimeoutMs ?? ENRICH_SETTLE_TIMEOUT_MS;
  const inFlight = new Map<string, InFlightEntry>();

  async function run(query: string): Promise<void> {
    try {
      const hits = await marketData.search(query);
      // Ranked BEFORE the cap: the cap's own justification ("hits past the
      // twentieth cannot reach the user") only holds if what is dropped is what
      // ranks last, and provider order is not relevance order (#1794).
      const admitted = rankProviderHits(query, hits).slice(0, ENRICH_MAX_HITS);
      if (admitted.length < hits.length) {
        logger.debug(
          { query, hits: hits.length, admitted: admitted.length },
          'catalog enrichment capped provider hits',
        );
      }
      for (const hit of admitted) {
        // A brand-new catalog row (§6.2 first touch): enqueue its history
        // backfill right away, exactly once. Rows that already existed —
        // seeded (§6.2(c)) or created by an earlier search — are warmed on
        // first *reference* instead (services/assets/referenceBackfill.ts).
        const { row, created } = await assetRepo.upsertGlobal({
          providerId: hit.providerId,
          providerRef: hit.providerRef,
          type: hit.type,
          symbol: hit.symbol,
          name: hit.name,
          exchange: hit.exchange ?? null,
          currency: hit.currency,
        });
        if (created) await backfill.enqueue(row.id);
      }
    } catch (err) {
      // A provider outage or 404 must never surface to the user (§6.2) — they
      // already got the catalog results; the fallback just found nothing new.
      logger.warn({ err, query }, 'catalog enrichment failed');
    }
  }

  /**
   * Start (or decline) an enrichment for `key`. The caller registers the entry
   * in the in-flight map *synchronously*, before any await — so a concurrent
   * same-process request always finds it and shares this entry's answer instead
   * of losing the Redis NX race and misreporting `enriching: false` while a
   * search is genuinely running.
   */
  function begin(key: string, query: string): InFlightEntry {
    let resolveEnriching!: (enriching: boolean) => void;
    const enriching = new Promise<boolean>((resolve) => (resolveEnriching = resolve));

    const settled = (async () => {
      try {
        const token = randomUUID();
        const lease = runningGuardValue(token);
        const acquired = await redis.set(key, lease, 'EX', ENRICH_GUARD_TTL_SECONDS, 'NX');
        if (acquired !== 'OK') {
          // Guard held elsewhere: `running` means another process is enriching
          // this query right now; anything else means it completed within the
          // TTL window (negative cache) — nothing is in flight.
          resolveEnriching(isRunningGuard(await redis.get(key)));
          return;
        }
        resolveEnriching(true);
        // Bounded strictly below the lease, so the guard cannot expire while
        // this run still holds it — no second process can fan out for the same
        // query (§5.3). An overrunning run is abandoned, not cancelled.
        if (!(await within(run(query), runTimeoutMs))) {
          logger.warn({ query, runTimeoutMs }, 'catalog enrichment run exceeded its budget');
        }
        // Flip OUR lease to `done` so cross-process callers stop reporting
        // "enriching"; the fresh TTL trusts the result for a full window from
        // completion. Compare-and-set: if the lease is gone (evicted, or an
        // abandoned predecessor's) a successor owns the query now and must keep
        // reporting `running` — losing one negative-cache window is the cheap
        // failure, clobbering a live lease is the expensive one.
        const completed = await redis.eval(
          ENRICH_GUARD_COMPLETE_SCRIPT,
          1,
          key,
          lease,
          ENRICH_GUARD_DONE,
          String(ENRICH_GUARD_TTL_SECONDS),
        );
        if (completed !== 1) {
          logger.debug({ query }, 'catalog enrichment guard no longer owned — completion skipped');
        }
      } catch (err) {
        // A Redis hiccup must never fail /search (§6.2): log, report "not
        // enriching", and skip this fallback round.
        logger.warn({ err, query }, 'catalog enrichment guard failed');
      } finally {
        resolveEnriching(false); // no-op when already resolved
      }
    })();

    return { enriching, settled };
  }

  return {
    async request(query) {
      const key = enrichGuardKey(query);
      const existing = inFlight.get(key);
      if (existing) return existing.enriching;

      const entry = begin(key, query);
      inFlight.set(key, entry);
      void entry.settled.finally(() => inFlight.delete(key));
      return entry.enriching;
    },

    // Bounded (#1794): the loop re-checks because a request may arrive while we
    // await, but the whole wait shares ONE deadline — an enrichment that never
    // settles (or a caller still typing into a shutting-down process) delays
    // shutdown by at most `settleTimeoutMs`, it does not stop it.
    async settled() {
      const deadline = Date.now() + settleTimeoutMs;
      while (inFlight.size > 0) {
        const pending = [...inFlight.values()].map((entry) => entry.settled);
        const remaining = deadline - Date.now();
        if (remaining <= 0 || !(await within(Promise.all(pending), remaining))) {
          logger.warn(
            { pending: inFlight.size, settleTimeoutMs },
            'catalog enrichment did not settle within its budget',
          );
          return;
        }
      }
    },
  };
}
