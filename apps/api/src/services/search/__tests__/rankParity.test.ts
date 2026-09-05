import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import type { AssetSearchResult } from '@bettertrack/contracts';

import { catalogSimilaritySql, catalogTierSql } from '../../../data/repositories/assetRepository';
import * as schema from '../../../data/schema';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import { createStubMarketData, providerHit } from '../../../testing/marketDataStubs';
import { providerHitRank, rankProviderHits, trigramSimilarity } from '../catalogEnrichment';

/**
 * Drift guard between the two rankings §6.2 requires to be the same one (#1810).
 *
 * The catalog read ranks ROWS in Postgres (`assetRepository.catalogTierSql` /
 * `catalogSimilaritySql`); the provider fallback ranks HITS in JS
 * (`rankProviderHits`), because they are not rows yet — and what it ranks below
 * twentieth it never writes, so the read never gets to rank it at all. The two
 * had already drifted apart: the mirror had only the ILIKE half of tier 2 and
 * no similarity ordering.
 *
 * So this runs BOTH over one shared fixture, the SQL through the very builders
 * the read uses, and asserts they agree — tier by tier, score by score, and in
 * the final order.
 */

interface Fixture {
  symbol: string;
  name: string;
}

/**
 * Shapes an instrument catalog actually holds: dotted listings, hyphenated
 * crypto pairs, `=X` FX refs, `^` indices, punctuated issuer names.
 */
const FIXTURES: Fixture[] = [
  { symbol: 'BAYN.DE', name: 'Bayer AG' },
  { symbol: 'BAYR', name: 'Bravia Exact AG' },
  { symbol: 'BAYR.F', name: 'Frankfurt Cross List' },
  { symbol: 'MOT.DE', name: 'Bayrische Motoren' },
  { symbol: 'AAPL', name: 'Apple Inc.' },
  { symbol: 'ETH-USD', name: 'Ethereum USD' },
  { symbol: 'BTC-USD', name: 'Bitcoin USD' },
  { symbol: '^GDAXI', name: 'DAX PERFORMANCE-INDEX' },
  { symbol: 'EURUSD=X', name: 'EUR/USD' },
  { symbol: 'GC=F', name: 'Gold Feb 25' },
  { symbol: 'VWCE.DE', name: 'Vanguard FTSE All-World UCITS ETF' },
  { symbol: 'BRK-B', name: 'Berkshire Hathaway Inc. New' },
  { symbol: 'META', name: 'Meta Platforms, Inc.' },
  { symbol: 'XAUEUR=X', name: 'Gold (EUR)' },
  // The two shapes a hand-rolled tokenizer gets wrong in the direction that
  // sheds a good hit (#1810 review): a hyphen inside a DOTTED run is one `host`
  // token (`brk-b.us`, no `brk` part), and a `float` that runs into a letter
  // stops there (`1.5` + `x`, not `1.5x`).
  { symbol: 'BRK-B.US', name: 'Berkshire Hathaway US Listing' },
  { symbol: 'LEV15.DE', name: 'Amundi 1.5x Daily Leveraged' },
];

/**
 * One query per behaviour the mirror has to reproduce: every tier, both arms of
 * tier 2 (substring and word/tsquery), the misspelling that only similarity
 * ordering can rank, and the compound tokens (`BTC-USD` splits, `BAYN.DE` does
 * not) where a hand-rolled tokenizer is most likely to be wrong.
 *
 * The last two isolate the word arm from the substring arm, which is the only
 * way a tokenizer bug is visible at all: `'us brk'` matches "BRK-B.US Berkshire
 * … US Listing" only if `brk-b.us` is wrongly split into parts, and
 * `'1.5 leveraged'` matches "Amundi 1.5x Daily Leveraged" only if `1.5x` is
 * correctly split into `1.5` + `x`. Neither is reachable through
 * `String.includes`, so each one grades purely on the lexemes.
 */
const QUERIES = [
  'bayer',
  'ag bayer',
  'bayr',
  'bayn.de',
  'bayrische motoren',
  'apple, inc',
  'inc',
  'etherium',
  'ethereum usd',
  'btc-usd',
  'btc usd',
  'usd',
  'de',
  'gold',
  'gold (eur)',
  'eur/usd',
  'all-world',
  'performance index',
  'meta platforms',
  'dax',
  '^GDAXI',
  'ETH',
  'v',
  'zzzz',
  'brk',
  'brk-b.us',
  '1.5x',
  'us brk',
  '1.5 leveraged',
];

const asHit = (fixture: Fixture): AssetSearchResult =>
  providerHit({ providerRef: fixture.symbol, symbol: fixture.symbol, name: fixture.name });

interface SqlRank {
  symbol: string;
  name: string;
  tier: number;
  sim: number;
}

/** PGlite wraps its rows; postgres-js returns them directly. */
function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: unknown }).rows ?? []) as T[];
}

/**
 * The tier + score the catalog read computes, in the read's own `ORDER BY`.
 *
 * The name tiebreak is taken `collate "C"` (#1810 review). The JS mirror sorts
 * names by codepoint, which is what `C`/`POSIX` — and the PGlite these tests run
 * on — do, but a glibc `en_US.UTF-8` database folds case and ignores punctuation
 * at the primary level and would order `'EUR/USD'` and `'Ethereum USD'` the
 * other way round. Without the explicit collation this assertion would pass here
 * and fail the moment it moved to the real-Postgres slice — and it would be
 * asserting the database's locale, not the parity the test is about. The tier
 * and similarity assertions above are collation-free and stay unqualified.
 */
async function sqlRanking(h: TestHarness, query: string): Promise<SqlRank[]> {
  const result = await h.db.execute(sql`
    select ${schema.assets.symbol} as "symbol",
           ${schema.assets.name} as "name",
           ${catalogTierSql(query)} as "tier",
           ${catalogSimilaritySql(query)} as "sim"
    from ${schema.assets}
    where ${schema.assets.ownerId} is null
    order by ${catalogTierSql(query)},
             ${catalogSimilaritySql(query)} desc,
             ${schema.assets.name} collate "C"
  `);
  return rows<{ symbol: string; name: string; tier: number | string; sim: number | string }>(
    result,
  ).map((row) => ({
    symbol: row.symbol,
    name: row.name,
    tier: Number(row.tier),
    sim: Number(row.sim),
  }));
}

async function seedFixtures(): Promise<TestHarness> {
  const h = await createTestApp({ marketData: createStubMarketData() });
  await h.db.insert(schema.assets).values(
    FIXTURES.map((fixture) => ({
      providerId: 'yahoo',
      providerRef: fixture.symbol,
      ownerId: null,
      type: 'stock' as const,
      symbol: fixture.symbol,
      name: fixture.name,
      exchange: 'XETRA',
      currency: 'EUR',
    })),
  );
  return h;
}

describe('provider-hit ranking mirrors the catalog read (#1810)', () => {
  it('assigns the same tier and the same similarity to every fixture row', async () => {
    const h = await seedFixtures();

    for (const query of QUERIES) {
      const expected = await sqlRanking(h, query);
      expect(expected, `fixture missing for "${query}"`).toHaveLength(FIXTURES.length);

      for (const row of expected) {
        const rank = providerHitRank(query, { symbol: row.symbol, name: row.name });
        expect(rank.tier, `tier for "${query}" / ${row.symbol}`).toBe(row.tier);
        // `similarity()` is a real4, so compare at float precision.
        expect(rank.sim, `similarity for "${query}" / ${row.symbol}`).toBeCloseTo(row.sim, 6);
      }
    }
  });

  it('orders the hits exactly as the read would order the rows it writes', async () => {
    const h = await seedFixtures();
    const hits = FIXTURES.map(asHit);

    for (const query of QUERIES) {
      const expected = (await sqlRanking(h, query)).map((row) => row.symbol);
      expect(
        rankProviderHits(query, hits).map((hit) => hit.symbol),
        `order for "${query}"`,
      ).toEqual(expected);
    }
  });

  it('reproduces pg_trgm similarity, including the 0.3 the fuzzy tier is gated on', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const pairs: [string, string][] = [
      ['BAYN.DE', 'bayr'],
      ['Bayer AG', 'bayer'],
      ['Ethereum USD', 'etherium'],
      ['ETH-USD', 'etherium'],
      ['Vanguard FTSE All-World UCITS ETF', 'all world'],
      ['Gold (EUR)', 'gold'],
      ['AAPL', 'zzzz'],
      ['', 'gold'],
    ];

    for (const [left, right] of pairs) {
      const result = await h.db.execute(sql`select similarity(${left}, ${right}) as "sim"`);
      const sim = Number(rows<{ sim: number | string }>(result)[0]!.sim);
      expect(trigramSimilarity(left, right), `similarity(${left}, ${right})`).toBeCloseTo(sim, 6);
    }

    // The value the misspelling promise rests on (§6.2): at the threshold, not
    // below it — `assetRepository.FUZZY_SIMILARITY_THRESHOLD`.
    expect(trigramSimilarity('BAYN.DE', 'bayr')).toBeCloseTo(0.3, 6);
  });
});
