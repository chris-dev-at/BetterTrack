import { describe, expect, it } from 'vitest';

import { createAssetRepository } from '../../../data/repositories/assetRepository';
import * as schema from '../../../data/schema';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import { createStubMarketData } from '../../../testing/marketDataStubs';
import { SEARCH_RESULT_LIMIT } from '../searchService';

/**
 * Table-driven ranking/merge tests for the local catalog search (§6.2).
 *
 * The fixture is built so each query hits every tier through a different row:
 * exact symbol (0) → symbol prefix (1) → name match (2) → trigram fuzzy (3).
 * Similarity values were verified against pg_trgm: e.g.
 * similarity('BAYN.DE', 'bayr') = 0.3 — exactly the fuzzy threshold, which is
 * what lets the owner's "bayr" misspelling resolve where a provider would 404.
 */

interface FixtureAsset {
  symbol: string;
  name: string;
  ownerKey?: 'user' | 'other';
}

const CATALOG: FixtureAsset[] = [
  { symbol: 'BAYR', name: 'Bravia Exact AG' },
  { symbol: 'BAYR.F', name: 'Frankfurt Cross List' },
  { symbol: 'MOT.DE', name: 'Bayrische Motoren' },
  { symbol: 'BAYN.DE', name: 'Bayer AG' },
  { symbol: 'AAPL', name: 'Apple Inc.' },
  // The caller's custom asset — merges in by the same ranking rules.
  { symbol: 'HOUSE', name: 'Bayrische Lake House', ownerKey: 'user' },
  // Another user's custom asset — must never appear (§10).
  { symbol: 'SECRET', name: 'Bayrische Secret Vault', ownerKey: 'other' },
];

async function seedFixture(h: TestHarness): Promise<{ userId: string; otherId: string }> {
  const user = await h.seedUser({ email: 'rank@s.test', username: 'rank' });
  const other = await h.seedUser({ email: 'rank2@s.test', username: 'rank2' });
  const ownerIds = { user: user.id, other: other.id };
  for (const a of CATALOG) {
    await h.db.insert(schema.assets).values({
      providerId: a.ownerKey ? 'manual' : 'yahoo',
      providerRef: a.symbol,
      ownerId: a.ownerKey ? ownerIds[a.ownerKey] : null,
      type: a.ownerKey ? 'custom' : 'stock',
      symbol: a.symbol,
      name: a.name,
      exchange: a.ownerKey ? null : 'XETRA',
      currency: 'EUR',
    });
  }
  return { userId: user.id, otherId: other.id };
}

describe('assetRepository.searchCatalog ranking', () => {
  // One case per row: query → the exact expected symbol order.
  const table: Array<{ query: string; expected: string[]; why: string }> = [
    {
      query: 'bayr',
      // BAYR = exact symbol, BAYR.F = symbol prefix, MOT.DE/HOUSE = name match
      // (ties break on similarity, then name), BAYN.DE = fuzzy (sim 0.3).
      expected: ['BAYR', 'BAYR.F', 'MOT.DE', 'HOUSE', 'BAYN.DE'],
      why: 'each tier in order: exact > prefix > name > fuzzy, custom merged in',
    },
    {
      query: 'BAYR',
      expected: ['BAYR', 'BAYR.F', 'MOT.DE', 'HOUSE', 'BAYN.DE'],
      why: 'ranking is case-insensitive',
    },
    {
      query: 'bayr.f',
      // Exact beats everything; BAYR survives only via fuzzy (sim 0.71).
      expected: ['BAYR.F', 'BAYR'],
      why: 'exact symbol match ranks first even for a dotted listing',
    },
    {
      query: 'bayer',
      // Name/word match on BAYN.DE ("Bayer AG"), then fuzzy BAYR (0.375) > BAYR.F (0.3).
      expected: ['BAYN.DE', 'BAYR', 'BAYR.F'],
      why: 'name tier beats fuzzy; fuzzy tier orders by similarity',
    },
    {
      query: 'mot',
      expected: ['MOT.DE'],
      why: 'symbol prefix works for non-bay symbols too',
    },
    {
      query: 'apple',
      expected: ['AAPL'],
      why: 'plain name match',
    },
    {
      query: 'zzzz',
      expected: [],
      why: 'nothing related returns nothing — not an error',
    },
  ];

  it.each(table)('ranks $query as $expected ($why)', async ({ query, expected }) => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const { userId } = await seedFixture(h);
    const repo = createAssetRepository(h.db);

    const matches = await repo.searchCatalog(userId, query, SEARCH_RESULT_LIMIT);
    expect(matches.map((m) => m.symbol)).toEqual(expected);
  });

  it('scopes custom assets to their owner and flags them via ownerId', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const { userId, otherId } = await seedFixture(h);
    const repo = createAssetRepository(h.db);

    // Name tier first (MOT.DE, then the caller's custom asset), then the
    // BAYR/BAYR.F symbols that only survive via trigram similarity (~0.36/0.31).
    const mine = await repo.searchCatalog(userId, 'bayrische', SEARCH_RESULT_LIMIT);
    expect(mine.map((m) => m.symbol)).toEqual(['MOT.DE', 'HOUSE', 'BAYR', 'BAYR.F']);
    expect(mine.find((m) => m.symbol === 'HOUSE')?.ownerId).toBe(userId);
    expect(mine.find((m) => m.symbol === 'MOT.DE')?.ownerId).toBeNull();

    // The other user sees their own custom asset instead — never someone else's.
    const theirs = await repo.searchCatalog(otherId, 'bayrische', SEARCH_RESULT_LIMIT);
    expect(theirs.map((m) => m.symbol)).toEqual(['MOT.DE', 'SECRET', 'BAYR', 'BAYR.F']);
  });

  it('answers a single-character query via the symbol prefix tier (owner override, §13.2)', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const user = await h.seedUser({ email: 'onechar@s.test', username: 'onechar' });
    await h.db.insert(schema.assets).values([
      {
        providerId: 'yahoo',
        providerRef: 'V',
        ownerId: null,
        type: 'stock',
        symbol: 'V',
        name: 'Visa Inc.',
        exchange: 'NYSE',
        currency: 'USD',
      },
      {
        providerId: 'yahoo',
        providerRef: 'VOD.L',
        ownerId: null,
        type: 'stock',
        symbol: 'VOD.L',
        name: 'Vodafone Group',
        exchange: 'LSE',
        currency: 'GBP',
      },
      {
        providerId: 'yahoo',
        providerRef: 'AAPL',
        ownerId: null,
        type: 'stock',
        symbol: 'AAPL',
        name: 'Apple Inc.',
        exchange: 'NASDAQ',
        currency: 'USD',
      },
    ]);
    const repo = createAssetRepository(h.db);

    const matches = await repo.searchCatalog(user.id, 'V', SEARCH_RESULT_LIMIT);
    expect(matches.map((m) => m.symbol)).toEqual(['V', 'VOD.L']);
  });

  it('honors the row limit', async () => {
    const h = await createTestApp({ marketData: createStubMarketData() });
    const { userId } = await seedFixture(h);
    const repo = createAssetRepository(h.db);

    const matches = await repo.searchCatalog(userId, 'bayr', 2);
    expect(matches.map((m) => m.symbol)).toEqual(['BAYR', 'BAYR.F']);
  });
});
