import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../schema';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import { createMarketIntelRepository } from '../marketIntelRepository';

/**
 * Archiving a portfolio retires its holdings from the market-intelligence
 * aggregation reads (§13.5 V5-P5, arcs b + c). The dividend-side queries have
 * always applied that guard; the earnings/news leg did not, so an archived
 * "Old Broker" book kept feeding the Workboard earnings panel, the news digest
 * and the daily `earnings.reminder` scan with positions the user had put away.
 * Watchlist membership is a separate, unarchivable relation and stays.
 */

// Deterministic TEST VECTOR identities — public fixtures, not credentials.
const VECTOR = {
  ownerId: '019c8600-0000-7000-8000-000000000001',
  archivedPortfolioId: '019c8600-0000-7000-8000-000000000010',
  activePortfolioId: '019c8600-0000-7000-8000-000000000011',
  archivedOnlyAssetId: '019c8600-0000-7000-8000-000000000020',
  archivedWatchedAssetId: '019c8600-0000-7000-8000-000000000021',
  activeAssetId: '019c8600-0000-7000-8000-000000000022',
  at: new Date('2026-08-21T07:00:00.000Z'),
} as const;

let h: TestHarness;

beforeEach(async () => {
  h = await createTestApp();

  await h.db.insert(schema.users).values({
    id: VECTOR.ownerId,
    email: 'archived-intel-owner@bettertrack.test',
    username: 'archived_intel_owner',
    passwordHash: 'TEST VECTOR password hash',
  });

  await h.db.insert(schema.portfolios).values([
    {
      id: VECTOR.archivedPortfolioId,
      userId: VECTOR.ownerId,
      name: 'TEST VECTOR old broker',
      archivedAt: VECTOR.at,
    },
    {
      id: VECTOR.activePortfolioId,
      userId: VECTOR.ownerId,
      name: 'TEST VECTOR live book',
    },
  ]);

  await h.db.insert(schema.assets).values([
    {
      id: VECTOR.archivedOnlyAssetId,
      providerId: 'yahoo',
      providerRef: 'INTEL-ARCHIVED-ONLY',
      type: 'stock',
      symbol: 'ARC',
      name: 'TEST VECTOR archived-only holding',
      currency: 'EUR',
    },
    {
      id: VECTOR.archivedWatchedAssetId,
      providerId: 'yahoo',
      providerRef: 'INTEL-ARCHIVED-WATCHED',
      type: 'stock',
      symbol: 'WCH',
      name: 'TEST VECTOR archived holding, still watched',
      currency: 'EUR',
    },
    {
      id: VECTOR.activeAssetId,
      providerId: 'yahoo',
      providerRef: 'INTEL-ACTIVE',
      type: 'stock',
      symbol: 'ACT',
      name: 'TEST VECTOR active holding',
      currency: 'EUR',
    },
  ]);

  await h.db.insert(schema.transactions).values([
    {
      portfolioId: VECTOR.archivedPortfolioId,
      assetId: VECTOR.archivedOnlyAssetId,
      side: 'buy',
      quantity: '100',
      price: '100',
      fee: '0',
      executedAt: VECTOR.at,
    },
    {
      portfolioId: VECTOR.archivedPortfolioId,
      assetId: VECTOR.archivedWatchedAssetId,
      side: 'buy',
      quantity: '5',
      price: '100',
      fee: '0',
      executedAt: VECTOR.at,
    },
    {
      portfolioId: VECTOR.activePortfolioId,
      assetId: VECTOR.activeAssetId,
      side: 'buy',
      quantity: '2',
      price: '100',
      fee: '0',
      executedAt: VECTOR.at,
    },
  ]);

  const [watchlist] = await h.db
    .insert(schema.watchlists)
    .values({ userId: VECTOR.ownerId, name: 'General', isDefault: true })
    .returning({ id: schema.watchlists.id });
  await h.db.insert(schema.workboardItems).values({
    userId: VECTOR.ownerId,
    watchlistId: watchlist!.id,
    assetId: VECTOR.archivedWatchedAssetId,
    sortOrder: 0,
  });
});

afterEach(async () => {
  await h.dispose();
});

describe('market-intel aggregation ignores archived portfolios (V5-P5)', () => {
  it('drops an asset held only inside an archived portfolio but keeps it when watched', async () => {
    const repo = createMarketIntelRepository(h.db);

    const rows = await repo.listUserWatchAndHoldAssets(VECTOR.ownerId);
    const bySymbol = new Map(rows.map((row) => [row.symbol, row]));

    expect([...bySymbol.keys()].sort()).toEqual(['ACT', 'WCH']);
    // The archived book's holding is gone entirely…
    expect(bySymbol.get('ARC')).toBeUndefined();
    // …and the one that is also watched survives on the WATCHLIST relation
    // alone, so its `held` flag must no longer be set.
    expect(bySymbol.get('WCH')).toMatchObject({
      assetId: VECTOR.archivedWatchedAssetId,
      held: false,
      watched: true,
    });
    expect(bySymbol.get('ACT')).toMatchObject({
      assetId: VECTOR.activeAssetId,
      held: true,
      watched: false,
    });
  });

  it('applies the same scoping to the all-user scan feeding the reminder job', async () => {
    const repo = createMarketIntelRepository(h.db);

    const rows = (await repo.listAllWatchAndHoldAssets()).filter(
      (row) => row.userId === VECTOR.ownerId,
    );
    expect(rows.map((row) => row.symbol).sort()).toEqual(['ACT', 'WCH']);
    expect(rows.find((row) => row.symbol === 'WCH')).toMatchObject({
      held: false,
      watched: true,
    });
  });

  it('restores the holding the moment the portfolio is un-archived', async () => {
    const repo = createMarketIntelRepository(h.db);
    await h.db
      .update(schema.portfolios)
      .set({ archivedAt: null })
      .where(eq(schema.portfolios.id, VECTOR.archivedPortfolioId));

    const rows = await repo.listUserWatchAndHoldAssets(VECTOR.ownerId);
    expect(rows.map((row) => row.symbol).sort()).toEqual(['ACT', 'ARC', 'WCH']);
    expect(rows.find((row) => row.symbol === 'WCH')).toMatchObject({
      held: true,
      watched: true,
    });
  });
});
