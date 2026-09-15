import type { Redis } from 'ioredis';

import type { Logger } from '../../logger';

/**
 * Per-user admission budget for the INTERACTIVE provider fallback (§6.2, #1709).
 *
 * `GET /search` is local-first, but a thin result set also starts a background
 * provider search that upserts into the **shared global** `assets` table and
 * enqueues a history backfill per new row ({@link CatalogEnrichment}). The
 * enrichment's own coalescing is per normalised query, so *distinct* queries
 * never coalesce: without a budget, one authenticated account could turn its
 * whole request allowance (`rateLimits.search`, 300/min) into 300 provider
 * fan-outs and 300 new global rows a minute.
 *
 * This is the interactive half of the decision the import path already made as
 * `IMPORT_ENRICHMENT_QUERY_BUDGET` (16 admissions per import,
 * `services/imports/importService.ts`); the defaults and their modelling live
 * next to that reasoning in `config/env.ts`
 * (`BT_SEARCH_ENRICHMENT_BUDGET` / `BT_SEARCH_ENRICHMENT_WINDOW_SEC`).
 *
 * Shape: a fixed window per user holding the set of *distinct* queries admitted
 * in it. A re-poll of an already-admitted query costs nothing *within that
 * window* — the client refetches every 1.5 s while the server reports
 * `enriching: true`, and that loop must not spend the budget it just paid for.
 * A poll that straddles the window boundary lands on the next window's key and
 * is charged once more, which is the fixed window's normal behaviour: the query
 * is genuinely being asked again in a new accounting period, and one slot of
 * thirty is not worth a per-query timestamp log to avoid. A refused query is
 * removed again, so the set never holds more than the budget and a refused
 * query cannot be replayed as an "already admitted" one.
 */
export interface SearchEnrichmentBudget {
  /**
   * Whether `userId` may start (or join) a provider enrichment for `query` now.
   * False means the budget is spent: the caller skips the fallback entirely and
   * reports `enriching: false`, so the catalog read still answers in full.
   */
  admit(userId: string, query: string): Promise<boolean>;
}

/**
 * Redis key for a user's admission set in the window containing `nowMs`.
 *
 * `search:enrich-budget:` and not `search:enrich:budget:` (#1810): the guard
 * keys of `catalogEnrichment.ts` occupy `search:enrich:` and used to embed the
 * raw, user-chosen query, so a query of the literal form
 * `budget:<uuid>:<window>` landed exactly here and left a string where this set
 * belongs — WRONGTYPE on the next admission, and a fail-closed refusal that
 * silently disabled another account's provider fallback. The guard key is now
 * hashed under `search:enrich:q:`, which alone closes the collision; the
 * namespaces are disjoint as well so neither side has to keep the other's
 * escaping rules in mind.
 */
export const enrichmentBudgetKey = (userId: string, windowSeconds: number, nowMs: number): string =>
  `search:enrich-budget:${userId}:${Math.floor(nowMs / (windowSeconds * 1000))}`;

export interface SearchEnrichmentBudgetDeps {
  redis: Redis;
  logger: Logger;
  /** Distinct enrichment queries admitted per user per window. */
  budget: number;
  /** Window length in seconds. */
  windowSeconds: number;
}

/** Budget that admits everything — the batch paths that carry their own ceiling. */
export const unlimitedEnrichmentBudget: SearchEnrichmentBudget = {
  admit: async () => true,
};

export function createSearchEnrichmentBudget(
  deps: SearchEnrichmentBudgetDeps,
): SearchEnrichmentBudget {
  const { redis, logger, budget, windowSeconds } = deps;

  return {
    async admit(userId, query) {
      // The window id is part of the key, so correctness never depends on the
      // TTL landing: a lost EXPIRE can only leak one dead key, never lock a
      // user out past the window. (Fixed window — a caller straddling the
      // boundary may see up to 2× the budget, the standard trade for not
      // keeping a per-request timestamp log.)
      const key = enrichmentBudgetKey(userId, windowSeconds, Date.now());
      // Lowercased so "BAYN" and "bayn" spend one slot, exactly as they
      // coalesce onto one guard key in the enrichment itself.
      const member = query.toLowerCase();
      try {
        // SCARD and SADD in one transaction, so the size this decision is made
        // on is the size the member was added to. Read separately they can
        // interleave: two concurrent DISTINCT queries at `budget - 1` both add
        // before either counts, and the pair either over-admits (`budget + 1`
        // fan-outs) or refuses one that was inside the budget.
        const replies = await redis.multi().scard(key).sadd(key, member).exec();
        const [countReply, addReply] = replies ?? [];
        if (!countReply || !addReply) throw new Error('enrichment budget transaction aborted');
        if (countReply[0]) throw countReply[0];
        if (addReply[0]) throw addReply[0];

        const sizeBefore = Number(countReply[1]);
        if (Number(addReply[1]) === 0) return true; // already admitted in this window — free
        if (sizeBefore === 0) await redis.expire(key, windowSeconds * 2);
        if (sizeBefore + 1 <= budget) return true;
        await redis.srem(key, member);
        logger.debug({ userId, budget, windowSeconds }, 'search enrichment budget spent');
        return false;
      } catch (err) {
        // Fail CLOSED. A Redis hiccup must never fail /search (§6.2) — the
        // catalog read is unaffected — but it must not open the fan-out either:
        // the enrichment's own cross-process guard runs on the same Redis, so
        // with Redis down there is no coalescing left to bound it.
        logger.warn({ err, userId }, 'search enrichment budget unavailable');
        return false;
      }
    },
  };
}
