/**
 * The per-request fan-out budget shared by the market-intel roll-ups (§13.5
 * V5-P5) — the news digest, the dividend calendar and the dividend projection.
 *
 * Every roll-up walks the caller's held + watched book and asks the provider
 * keystone for one payload per asset. Those calls land on the SAME outbound
 * queue as every other user's quotes and charts (`providers/requestQueue.ts`:
 * concurrency 4, ≥250 ms spacing), so an uncapped book is a per-user loop
 * bypassing the §5.3 politeness keystone: a 200-asset book serializes into ~50 s
 * of queue budget and starves everyone else for that whole window.
 *
 * The cap bounds one request's cold cost at {@link MARKET_INTEL_ROLLUP_MAX_ASSETS}
 * × 250 ms ≈ 12.5 s worst case, and in practice far less — the roll-up families
 * cache for hours (news for an hour, see `providers/ttl.ts`), so a warm book
 * costs zero upstream calls. It is a cap on *provider fan-out*, not on what a
 * user may own: nothing else about the book is restricted.
 */

/**
 * Maximum assets one roll-up request may fan out over. Sized against the shared
 * queue above rather than against a product limit; a book larger than this is
 * covered by the deterministic selection below and the response says it was
 * truncated.
 */
export const MARKET_INTEL_ROLLUP_MAX_ASSETS = 50;

/** The identity a roll-up needs to rank a book deterministically. */
export interface RollupSubject {
  assetId: string;
  symbol: string;
  /** True for a currently-held position; false for a watchlist-only subject. */
  held: boolean;
}

export interface CappedRollup<T> {
  /** The subjects this request will spend provider budget on. */
  readonly selected: readonly T[];
  /** True when the book exceeded the cap and `selected` is a subset of it. */
  readonly truncated: boolean;
}

/**
 * Rank a book and keep at most `max` of it. The ordering is fixed and
 * documented so a truncated roll-up is reproducible rather than arbitrary:
 *
 *   1. held positions before watchlist-only subjects — money you own outranks
 *      money you are watching;
 *   2. then symbol ascending;
 *   3. then asset id ascending, so two rows sharing a symbol still order.
 *
 * Callers re-sort their own output (by headline date, by event date), so for a
 * book inside the cap this selection is invisible: the response is identical to
 * the uncapped one.
 */
export function capRollupSubjects<T extends RollupSubject>(
  subjects: readonly T[],
  max: number = MARKET_INTEL_ROLLUP_MAX_ASSETS,
): CappedRollup<T> {
  if (subjects.length <= max) return { selected: [...subjects], truncated: false };
  const ranked = [...subjects].sort((a, b) => {
    if (a.held !== b.held) return a.held ? -1 : 1;
    const bySymbol = a.symbol.localeCompare(b.symbol);
    return bySymbol !== 0 ? bySymbol : a.assetId.localeCompare(b.assetId);
  });
  return { selected: ranked.slice(0, max), truncated: true };
}
