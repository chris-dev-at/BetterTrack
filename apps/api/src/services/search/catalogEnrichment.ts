import { randomUUID } from 'node:crypto';

import type { Redis } from 'ioredis';

import type { AssetSearchResult } from '@bettertrack/contracts';

import type {
  AssetRepository,
  RefreshableAssetField,
} from '../../data/repositories/assetRepository';
import type { BackfillScheduler } from '../../jobs';
import type { Logger } from '../../logger';
import type { MarketDataService } from '../../providers';
import { sha256Base64Url } from '../crypto/tokens';
import { isCuratedCatalogRef } from './catalogSeed';

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

/**
 * Redis guard key per normalized query; lowercased so "BAYN" and "bayn"
 * coalesce onto one lease (and onto one budget slot, `enrichmentBudget.ts`).
 *
 * The query is HASHED and lives under its own `q:` namespace (#1810). Both
 * halves matter, because the query is attacker-chosen: `searchQuerySchema`
 * accepts 64 arbitrary characters, and the raw query used to be pasted straight
 * into `search:enrich:<query>` — the same namespace the per-user admission
 * budget wrote `search:enrich:budget:<uuid>:<window>` into. Searching for the
 * literal string `budget:<someone-else's-uuid>:<window>` therefore planted a
 * guard STRING on that user's budget key, whose next `SCARD`/`SADD` failed
 * WRONGTYPE and, through the deliberate fail-closed catch, silently killed
 * their provider fallback for the window — repeatable once a minute.
 *
 * A hash is what makes that structural rather than a matter of escaping: no
 * input can shape the key at all, and key length stops depending on query
 * length. The cost is that a Redis key no longer shows which query it guards;
 * the query is in every log line this module writes.
 */
export const enrichGuardKey = (query: string): string =>
  `search:enrich:q:${sha256Base64Url(query.toLowerCase())}`;

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
 * How many authoritative currency lookups ONE enrichment may make (#1875).
 *
 * A hit whose currency is flagged `currencyGuessed` is resolved through
 * `marketData.getMeta` before it becomes a stored denomination, which is an
 * upstream call — capped so a query that happens to return twenty unrecognised
 * venues cannot turn one background enrichment into twenty extra provider
 * requests through the shared §5.2 politeness queue, nor spend its whole
 * {@link ENRICH_RUN_TIMEOUT_MS} budget waiting on them before it writes a row.
 *
 * Nothing is lost past the cap: the un-resolved hit keeps the projection's
 * placeholder for its badge, writes no currency onto an existing row, and the
 * NEXT enrichment that admits it — the same query after the guard window, or a
 * narrower one — resolves it. Meta is cached for a day (§5.3), so a repeat
 * costs nothing upstream.
 */
export const ENRICH_MAX_CURRENCY_LOOKUPS = 4;

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
 * The two-character folds `bettertrack_search_fold` applies before its
 * `translate()` — the letters whose ASCII spelling is longer than one character.
 */
const FOLD_EXPANSIONS: readonly (readonly [string, string])[] = [
  ['ß', 'ss'],
  ['æ', 'ae'],
  ['œ', 'oe'],
  ['þ', 'th'],
];

/**
 * The `translate()` map of `bettertrack_search_fold`, character for character
 * (migration 0114). The two strings are index-aligned and must stay so — every
 * character of both is asserted against the database itself in
 * `__tests__/rankParity.test.ts`, so a one-character slip here fails the suite
 * rather than silently unfolding one letter of the catalog.
 */
const FOLD_FROM =
  'àáâãäåāăąçćĉċčďđðèéêëēĕėęěĝğġģĥħìíîïĩīĭįıĵķĺļľłñńņňòóôõöøōŏőŕŗřśŝşšţťŧùúûüũūŭůűųŵýÿŷźżž';
const FOLD_TO =
  'aaaaaaaaacccccdddeeeeeeeeegggghhiiiiiiiiijkllllnnnnooooooooorrrsssstttuuuuuuuuuuwyyyzzz';

/**
 * Every character the fold maps, as one string — the alphabet
 * `__tests__/rankParity.test.ts` replays through the database so that no entry
 * of the map above can drift from the migration's without failing.
 */
export const SEARCH_FOLD_ALPHABET = `${FOLD_FROM}${FOLD_EXPANSIONS.map(([from]) => from).join('')}`;

/** The German expansions `bettertrack_search_translit` applies before folding. */
const TRANSLIT_EXPANSIONS: readonly (readonly [string, string])[] = [
  ['ä', 'ae'],
  ['ö', 'oe'],
  ['ü', 'ue'],
];

function expand(text: string, pairs: readonly (readonly [string, string])[]): string {
  let value = text.toLowerCase();
  for (const [from, to] of pairs) value = value.split(from).join(to);
  return value;
}

/**
 * `bettertrack_search_fold` in JS (#1876) — the ASCII spelling of `text`:
 * lowercased, with every mapped Latin-1/Latin-Extended-A letter folded to its
 * base letter. This is what BOTH sides of every catalog tier are compared in,
 * so the mirror has to fold exactly as the database does.
 */
export function searchFold(text: string): string {
  const expanded = expand(text, FOLD_EXPANSIONS);
  let folded = '';
  for (const character of expanded) {
    const at = FOLD_FROM.indexOf(character);
    folded += at === -1 ? character : FOLD_TO[at];
  }
  return folded;
}

/**
 * `bettertrack_search_translit` in JS — the German spelling of `text`
 * (ä→ae, ö→oe, ü→ue; ß→ss the fold already does), then folded.
 */
export function searchTranslit(text: string): string {
  return searchFold(expand(text, TRANSLIT_EXPANSIONS));
}

/**
 * `bettertrack_search_document` in JS — what the row's `search_text` tsvector is
 * built over: the fold, plus the transliteration when the two differ. A row
 * without umlauts therefore tokenises exactly as it did before 0114.
 */
export function searchDocument(text: string): string {
  const folded = searchFold(text);
  const transliterated = searchTranslit(text);
  return transliterated === folded ? folded : `${folded} ${transliterated}`;
}

/**
 * Word tokens of `text` under the catalog's text-search configuration — the JS
 * side of `to_tsvector('simple', …)` / `plainto_tsquery('simple', …)` (#1810).
 *
 * The `simple` configuration does no stemming and drops no stop words, so a
 * lexeme is just a lowercased token, and what is left to mirror is the default
 * parser's tokenisation. Four rules cover everything a ticker catalog holds:
 *  - a token runs over letters/digits and may be joined by `.`, `-` or `/`
 *    (`^GDAXI` → `gdaxi`, `GC=F` → `gc` + `f`, `Inc.` → `inc`);
 *  - a run of the `asciihword` shape — hyphens, and NO `.` or `/` — also yields
 *    its parts (`BTC-USD` → `btc-usd`, `btc`, `usd`; `All-World` → `all-world`,
 *    `all`, `world`). A run that mixes them does not: `BRK-B.US` is the single
 *    `host` token `brk-b.us`, and splitting it would invent a lexeme `brk` that
 *    the row's own tsvector has not got (#1810 review);
 *  - a purely dotted or slashed run is likewise one token — `BAYN.DE` the `host`
 *    `bayn.de`, `EUR/USD` the `file` `eur/usd` — which is exactly why a query of
 *    `de` must not, and here does not, match `BAYN.DE`;
 *  - a `float` (digits `.` digits) that runs straight into a letter ends there:
 *    `1.5x` is `1.5` + `x` to the parser, not one token (a leveraged-fund name
 *    is where that shows up).
 *
 * Exotic token classes the parser knows and this does not — e-mail addresses,
 * URLs, versions like `v1.2.3` — would tokenise differently; none can occur in
 * a symbol or an instrument name, and `__tests__/rankParity.test.ts` holds the
 * result against the real `plainto_tsquery` for the shapes that do.
 */
export function simpleLexemes(text: string): Set<string> {
  const lexemes = new Set<string>();
  for (const [run] of text.toLowerCase().matchAll(/[\p{L}\p{N}]+(?:[.\-/][\p{L}\p{N}]+)*/gu)) {
    for (const token of splitFloatPrefixes(run)) {
      lexemes.add(token);
      // `asciihword` only: the parser reads a run carrying a `.` or `/` as one
      // host/file token, parts and all.
      if (token.includes('-') && !/[./]/.test(token)) {
        for (const part of token.split('-')) lexemes.add(part);
      }
    }
  }
  return lexemes;
}

/**
 * Split the leading `float`s off a run, the one place the parser stops inside
 * what this tokenizer would otherwise read as one word: `1.5x` → `1.5`, `x`.
 * A run whose float is followed by `.` or another digit (`1.5.2`, `v1.2.3`) is
 * a version/file token and is left whole.
 */
function splitFloatPrefixes(run: string): string[] {
  const tokens: string[] = [];
  let rest = run;
  for (;;) {
    const float = /^[0-9]+\.[0-9]+(?=\p{L})/u.exec(rest);
    if (!float) {
      tokens.push(rest);
      return tokens;
    }
    tokens.push(float[0]);
    rest = rest.slice(float[0].length);
  }
}

/**
 * pg_trgm's `similarity(a, b)` in JS (#1810) — the score the catalog read
 * orders every tier by and gates its fuzzy tier at 0.3.
 *
 * The definition is exactly the extension's: lowercase, split on non-alphanumeric
 * characters, pad each word with two leading and one trailing space, take the
 * DISTINCT set of 3-character windows, and return |A ∩ B| / |A ∪ B|. It is
 * reproduced rather than approximated because the ordering it drives is what
 * decides which fuzzy hits survive the cap: `similarity('BAYN.DE', 'bayr')` is
 * 0.3 here for the same reason it is 0.3 in Postgres.
 */
export function trigramSimilarity(a: string, b: string): number {
  const left = trigrams(a);
  const right = trigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** The distinct trigram set pg_trgm would build for `text`. */
function trigrams(text: string): Set<string> {
  const grams = new Set<string>();
  for (const [word] of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i += 1) grams.add(padded.slice(i, i + 3));
  }
  return grams;
}

/**
 * Rank provider hits the way the catalog read ranks rows (§6.2) before the
 * {@link ENRICH_MAX_HITS} slice decides what one enrichment may write (#1794).
 *
 * `marketData.search` is a `flatMap` over the registered providers, so its order
 * is REGISTRATION order — not relevance. Slicing that raw meant a query whose
 * exact-symbol match sat at provider position 25 wrote twenty fuzzy rows and
 * dropped the one row the follow-up catalog read would have ranked tier 0; the
 * 60 s guard then suppressed the re-run, so the user's refetch showed junk and
 * no exact match.
 *
 * This is a MIRROR of `assetRepository.catalogTierSql` /
 * `catalogSimilaritySql`, and the first version of it was not (#1810). It
 * carried only the ILIKE half of tier 2 and broke ties on provider registration
 * index, which left the whole fuzzy tier unsorted — so the §6.2 flagship
 * misspelling path failed on its own promise: `etherium` graded all 30 hits
 * tier 3, the sort was a no-op, and `ETH-USD / "Ethereum USD"` at provider
 * position 22 was dropped in favour of twenty junk rows. The follow-up catalog
 * read then filtered that junk out at the similarity floor and returned
 * nothing, with the guard sitting at `done` for a full minute. Both halves are
 * restored here:
 *  - tier 2 carries the word arm (`search_text @@ plainto_tsquery('simple', q)`)
 *    beside the substring arm, so `"ag bayer"` or `"apple, inc"` — order-free
 *    and punctuation-free in Postgres, invisible to `String.includes` — grade
 *    tier 2 as they will once written;
 *  - the sort is `tier, sim desc, name`, the read's own `ORDER BY`, with
 *    provider order as the last tiebreak only.
 *
 * `__tests__/rankParity.test.ts` runs the exported SQL builders over a fixture
 * set and asserts this function agrees, so the two cannot drift silently again.
 */
export function rankProviderHits(
  query: string,
  hits: readonly AssetSearchResult[],
): AssetSearchResult[] {
  const folded = searchFold(query.trim());
  const queryLexemes = simpleLexemes(folded);
  return hits
    .map((hit, index) => ({ hit, index, ...rankAgainst(folded, queryLexemes, hit) }))
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        b.sim - a.sim ||
        // `order by "name"`. CODEPOINT order, where the database applies its
        // own collation: on a `C`/`POSIX` database (and on the PGlite the tests
        // run) these are the same order, on a glibc `en_US.UTF-8` one they part
        // company wherever case or punctuation is the only difference
        // (`'EUR/USD'` vs `'Ethereum USD'`). That residue is deliberate — the
        // mirror can only implement one collation, and it is the third term of
        // three, so it moves a hit only among hits the first two terms have
        // already declared equally relevant. `__tests__/rankParity.test.ts`
        // pins the parity under `collate "C"` for that reason.
        (a.hit.name < b.hit.name ? -1 : a.hit.name > b.hit.name ? 1 : 0) ||
        // Array#sort is stable in V8, but the index tiebreak states the intent
        // rather than relying on it: all else equal, provider order is kept.
        a.index - b.index,
    )
    .map((entry) => entry.hit);
}

/** What one row is worth to the catalog read: its tier, and the score that orders within it. */
export interface ProviderHitRank {
  /** `catalogTierSql`: 0 exact symbol, 1 symbol prefix, 2 name/word match, 3 the rest. */
  tier: number;
  /** `catalogSimilaritySql`: the better of the symbol and name trigram scores. */
  sim: number;
}

/** Rank ONE hit as the catalog read would — the unit `__tests__/rankParity.test.ts` compares. */
export function providerHitRank(
  query: string,
  hit: Pick<AssetSearchResult, 'symbol' | 'name'>,
): ProviderHitRank {
  const folded = searchFold(query.trim());
  return rankAgainst(folded, simpleLexemes(folded), hit);
}

/** {@link providerHitRank} with the query's derived forms hoisted out of the loop. */
function rankAgainst(
  folded: string,
  queryLexemes: ReadonlySet<string>,
  hit: Pick<AssetSearchResult, 'symbol' | 'name'>,
): ProviderHitRank {
  return {
    tier: tierOf(folded, queryLexemes, hit),
    // `catalogSimilaritySql`: the best of the four folded spellings, the query
    // folded once. For an ASCII hit the transliterated pair scores identically.
    sim: Math.max(
      trigramSimilarity(searchFold(hit.symbol), folded),
      trigramSimilarity(searchTranslit(hit.symbol), folded),
      trigramSimilarity(searchFold(hit.name), folded),
      trigramSimilarity(searchTranslit(hit.name), folded),
    ),
  };
}

/** The read's `case` expression: exact symbol → symbol prefix → name/word → the rest. */
function tierOf(
  folded: string,
  queryLexemes: ReadonlySet<string>,
  hit: Pick<AssetSearchResult, 'symbol' | 'name'>,
): number {
  // Each arm is tried against both of the row's spellings (#1876); the query
  // carries only its fold, exactly as `catalogTierSql` builds it.
  const symbolFold = searchFold(hit.symbol);
  const symbolTranslit = searchTranslit(hit.symbol);
  if (symbolFold === folded || symbolTranslit === folded) return 0;
  if (symbolFold.startsWith(folded) || symbolTranslit.startsWith(folded)) return 1;
  if (searchFold(hit.name).includes(folded) || searchTranslit(hit.name).includes(folded)) return 2;
  // `search_text` is `to_tsvector('simple', bettertrack_search_document(symbol
  // || ' ' || name))`, and plainto_tsquery ANDs the query's lexemes: every one
  // must be present. An empty query has no lexemes, and an empty tsquery
  // matches nothing.
  if (queryLexemes.size > 0) {
    const document = simpleLexemes(searchDocument(`${hit.symbol} ${hit.name}`));
    let all = true;
    for (const lexeme of queryLexemes) {
      if (!document.has(lexeme)) {
        all = false;
        break;
      }
    }
    if (all) return 2;
  }
  return 3;
}

/**
 * Which columns of an ALREADY EXISTING catalog row this provider search hit is
 * allowed to correct (#1810 review). Empty is the common answer, and empty means
 * the upsert writes nothing at all.
 *
 * A hit is not a description of an instrument, it is the projection
 * `AssetProvider.search` can build from a picker payload — and two of its fields
 * are openly guesses. Yahoo's search returns no currency, so
 * `currencyForSearchResult` infers one from the symbol shape and otherwise
 * answers `'USD'`; `mapAssetType` answers `'stock'` for a quote type it does not
 * know. Both are documented as safe because they only tint a badge, which was
 * true while an existing row was write-once. It stopped being true the moment
 * this upsert could UPDATE: `^ATX` is a seeded EUR index whose currency the
 * search projection would guess as USD (no `=X`, no `-`, no venue suffix, no
 * `VIE` in the exchange table), and `assets.currency` is money — a pay-from-cash
 * buy books a PERSISTED cash movement converted through it
 * (`portfolioService`), tax, snapshots and the asset page value through it, the
 * CSV import rejects rows that disagree with it, and paranoid rehydration
 * refuses on it. So `type` is never refreshed here, and the projection's OWN
 * currency never is either.
 *
 * `currency` is refreshable in exactly one case, and the `authoritativeCurrency`
 * argument says so: the caller replaced the projection's value with one re-read
 * from `getMeta` + `normalizeCurrency` (#1875 — see
 * {@link needsAuthoritativeCurrency} and the resolution in
 * `createCatalogEnrichment`). That is the same authority the curated seed list
 * carries, so a row stored with a wrong guess is corrected instead of being
 * wrong forever; without it the enrichment writes no currency at all.
 *
 * What is left is what the projection genuinely carries:
 *  - `name`, but only when the provider actually supplied one. `yahooProvider`
 *    falls back to the bare symbol when a quote has neither `longname` nor
 *    `shortname`, and writing that would replace `'DAX Performance Index'` with
 *    `'^GDAXI'` — destroying exactly the findability-by-name §6.2 ranks on;
 *  - `exchange`, when non-blank, for the same reason.
 * A curated row is refreshed by none of them: {@link isCuratedCatalogRef}.
 */
export function providerRefreshFields(
  hit: AssetSearchResult,
  authoritativeCurrency = false,
): RefreshableAssetField[] {
  if (isCuratedCatalogRef(hit.providerId, hit.providerRef)) return [];
  const fields: RefreshableAssetField[] = [];
  const name = hit.name.trim();
  if (name !== '' && name !== hit.symbol.trim()) fields.push('name');
  if (hit.exchange != null && hit.exchange.trim() !== '') fields.push('exchange');
  if (authoritativeCurrency) fields.push('currency');
  return fields;
}

/**
 * True for a hit whose currency must be re-read before it can be stored: the
 * provider flagged it as its own default rather than something it read off the
 * hit (`currencyGuessed`, #1875).
 *
 * A CURATED ref is excluded, and not just because {@link providerRefreshFields}
 * would refuse the write anyway: the seed list carries a hand-checked native
 * currency and `seedAssetCatalog` has already inserted the row before any
 * search can reach it, so there is nothing an upstream call could improve —
 * spending one on `^ATX` every time it ranks into an enrichment would be pure
 * upstream traffic for a value we would then discard.
 */
function needsAuthoritativeCurrency(hit: AssetSearchResult): boolean {
  return hit.currencyGuessed === true && !isCuratedCatalogRef(hit.providerId, hit.providerRef);
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

  /**
   * The asset's real native currency, from the one path that knows it: the
   * provider's own `getMeta`, normalised by `normalizeCurrency` (§5.4) and
   * cached for a day (§5.3 `META_TTL_SECONDS`), so a repeat costs no upstream
   * call at all.
   *
   * Best-effort by design — null means "we still do not know", never "USD".
   * A create then falls back to the projection's placeholder so the row (and
   * its badge) still exists, an existing row keeps whatever it has, and the
   * next enrichment that admits this hit tries again: a provider outage delays
   * the correction, it does not decide the denomination.
   */
  async function authoritativeCurrency(hit: AssetSearchResult): Promise<string | null> {
    try {
      const meta = await marketData.getMeta({
        providerId: hit.providerId,
        providerRef: hit.providerRef,
      });
      return meta.value.currency;
    } catch (err) {
      logger.debug(
        { err, providerId: hit.providerId, providerRef: hit.providerRef },
        'catalog enrichment could not resolve an authoritative currency',
      );
      return null;
    }
  }

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
      let currencyLookups = 0;
      for (const hit of admitted) {
        // Money first (#1875): a hit that only DEFAULTED its currency gets it
        // re-read from the authoritative `getMeta` path before the value is
        // stored, so `^IBEX` is written EUR instead of the projection's `USD`
        // placeholder — and an existing row that already holds the placeholder
        // is corrected, which is the only path that can ever fix it.
        let resolved: string | null = null;
        if (needsAuthoritativeCurrency(hit)) {
          if (currencyLookups < ENRICH_MAX_CURRENCY_LOOKUPS) {
            currencyLookups += 1;
            resolved = await authoritativeCurrency(hit);
          } else {
            logger.debug(
              { query, providerRef: hit.providerRef },
              'catalog enrichment capped authoritative currency lookups',
            );
          }
        }

        // A brand-new catalog row (§6.2 first touch): enqueue its history
        // backfill right away, exactly once. Rows that already existed —
        // seeded (§6.2(c)) or created by an earlier search — are warmed on
        // first *reference* instead (services/assets/referenceBackfill.ts).
        // A create writes the whole projection (there is nothing to destroy and
        // the badge has to say something); an existing row is corrected only in
        // the columns this hit is authoritative for.
        const { row, created } = await assetRepo.upsertGlobal(
          {
            providerId: hit.providerId,
            providerRef: hit.providerRef,
            type: hit.type,
            symbol: hit.symbol,
            name: hit.name,
            exchange: hit.exchange ?? null,
            currency: resolved ?? hit.currency,
          },
          { refresh: providerRefreshFields(hit, resolved !== null) },
        );
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
