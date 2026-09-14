import type { AssetRef, DividendEvent, DividendEvents } from '@bettertrack/contracts';
import { describe, expect, it } from 'vitest';

import type { AssetRepository } from '../../../data/repositories/assetRepository';
import { cachedIntel, createStubMarketData } from '../../../testing/marketDataStubs';
import { createMarketIntelService, DIVIDEND_HISTORY_MAX_EVENTS } from '../marketIntelService';

/**
 * Payout history is normalised in the READ SERVICE, where the news digest's
 * bound already lives — not in a provider mapper, which is per-provider and sits
 * on the wrong side of the trust boundary (#1790).
 */

const ASSET_ID = 'a-aapl';

/** Resolves the one asset under test; §10 scoping is covered by its own suite. */
const assetRepo = {
  findByIdForUser: async (id: string) =>
    id === ASSET_ID ? { id, providerId: 'yahoo', providerRef: 'AAPL', ownerId: null } : null,
} as unknown as AssetRepository;

/** The per-asset read never scans the book. */
const intelRepo = {
  listUserWatchAndHoldAssets: async () => [],
  listUserWatchAssets: async () => [],
};

function payout(exDate: string, amount: number): DividendEvent {
  return { exDate, payDate: null, amount, currency: 'USD' };
}

function serviceWith(history: DividendEvent[]) {
  const events: DividendEvents = {
    currency: 'USD',
    history,
    upcoming: [],
    forwardYield: null,
    trailingAmount: null,
    trailingAmountBasis: null,
  };
  return createMarketIntelService({
    marketData: createStubMarketData({ dividends: (_ref: AssetRef) => cachedIntel(events) }),
    assetRepo,
    intelRepo,
    enabled: true,
  });
}

describe('marketIntel.dividends — payout history normalisation (#1790)', () => {
  it('collapses a duplicated event and keeps an amended amount, ascending by ex-date', async () => {
    // Upstream re-sent the March payout verbatim, and re-sent June with a
    // corrected amount. The exact duplicate is noise — it drew a second
    // identical bar and shifted every later point of the only payout chart in
    // the product. The differing amount is NOT noise: from here an amendment and
    // a special paid on the same day are indistinguishable, and dropping one
    // would silently delete real money.
    const service = serviceWith([
      payout('2026-06-05T00:00:00.000Z', 0.25),
      payout('2026-03-06T00:00:00.000Z', 0.24),
      payout('2026-03-06T00:00:00.000Z', 0.24),
      payout('2026-06-05T00:00:00.000Z', 0.26),
    ]);

    const res = await service.dividends('u1', ASSET_ID);
    expect(res.history).toEqual([
      payout('2026-03-06T00:00:00.000Z', 0.24),
      payout('2026-06-05T00:00:00.000Z', 0.25),
      payout('2026-06-05T00:00:00.000Z', 0.26),
    ]);
  });

  it('bounds a flood to the most recent payouts', async () => {
    // A second dividend provider returning a company's whole century must not
    // flow straight through to the client. What survives is the RECENT end.
    const day = (i: number) => new Date(Date.UTC(1900, 0, 1) + i * 86_400_000).toISOString();
    const flood = Array.from({ length: DIVIDEND_HISTORY_MAX_EVENTS + 40 }, (_, i) =>
      payout(day(i), 0.1 + i / 1000),
    );

    const res = await serviceWith(flood).dividends('u1', ASSET_ID);
    expect(res.history).toHaveLength(DIVIDEND_HISTORY_MAX_EVENTS);
    expect(res.history[0]).toEqual(flood[40]);
    expect(res.history.at(-1)).toEqual(flood.at(-1));
  });

  it('leaves a well-formed history exactly as it is', async () => {
    const history = [
      payout('2026-03-06T00:00:00.000Z', 0.24),
      payout('2026-06-05T00:00:00.000Z', 0.25),
    ];
    const res = await serviceWith(history).dividends('u1', ASSET_ID);
    expect(res).toMatchObject({ available: true, history });
  });
});
