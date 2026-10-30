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

/**
 * `upcoming` is a forward calendar: an event that has fully happened does not
 * belong in it (mobile board ask 2026-10-29 A3 — an exDate of 2026-08-10 was
 * still served weeks later). The rule is the shared display-day one (web
 * `apps/web/src/lib/dividendDates.ts`, calendar `eventSortKey`): an event stays
 * upcoming while ANY of its dates is today or later in Europe/Vienna; once all
 * of them are behind us it moves into `history`.
 */
describe('marketIntel.dividends — past events leave the forward calendar (A3)', () => {
  function event(exDate: string | null, payDate: string | null, amount = 0.5): DividendEvent {
    return { exDate, payDate, amount, currency: 'USD' };
  }

  function serviceAt(nowIso: string, upcoming: DividendEvent[], history: DividendEvent[] = []) {
    const events: DividendEvents = {
      currency: 'USD',
      history,
      upcoming,
      forwardYield: null,
      trailingAmount: null,
      trailingAmountBasis: null,
    };
    return createMarketIntelService({
      marketData: createStubMarketData({ dividends: (_ref: AssetRef) => cachedIntel(events) }),
      assetRepo,
      intelRepo,
      enabled: true,
      now: () => Date.parse(nowIso),
    });
  }

  it('moves a fully past event into history and keeps the future one upcoming', async () => {
    const past = event('2026-08-10T00:00:00.000Z', '2026-08-20T00:00:00.000Z');
    const future = event('2026-11-10T00:00:00.000Z', '2026-11-20T00:00:00.000Z');
    const older = payout('2026-05-09T00:00:00.000Z', 0.25);

    const res = await serviceAt('2026-10-30T10:00:00.000Z', [past, future], [older]).dividends(
      'u1',
      ASSET_ID,
    );

    expect(res.upcoming).toEqual([future]);
    expect(res.history).toEqual([older, past]);
  });

  it('folds a past event the provider ALSO lists in history in only once', async () => {
    const past = event('2026-08-10T00:00:00.000Z', null);
    const res = await serviceAt('2026-10-30T10:00:00.000Z', [past], [past]).dividends(
      'u1',
      ASSET_ID,
    );
    expect(res.upcoming).toEqual([]);
    expect(res.history).toEqual([past]);
  });

  it('keeps an event dated today, and an ex-but-unpaid one until its pay date passes', async () => {
    const today = event('2026-10-30T00:00:00.000Z', null);
    // 23:30 UTC on the 29th is 00:30 on the 30th in Vienna — the day it renders on.
    const lateUtcToday = event('2026-10-29T23:30:00.000Z', null);
    const exButUnpaid = event('2026-10-01T00:00:00.000Z', '2026-11-05T00:00:00.000Z');
    const paidYesterday = event('2026-10-01T00:00:00.000Z', '2026-10-29T00:00:00.000Z');

    const res = await serviceAt('2026-10-30T10:00:00.000Z', [
      today,
      lateUtcToday,
      exButUnpaid,
      paidYesterday,
    ]).dividends('u1', ASSET_ID);

    expect(res.upcoming).toEqual([today, lateUtcToday, exButUnpaid]);
    expect(res.history).toEqual([paidYesterday]);
  });

  it('keeps an undated event — it is not demonstrably past', async () => {
    const undated = event(null, null);
    const res = await serviceAt('2026-10-30T10:00:00.000Z', [undated]).dividends('u1', ASSET_ID);
    expect(res.upcoming).toEqual([undated]);
    expect(res.history).toEqual([]);
  });

  it('measures the boundary on the Vienna day across the spring DST switch (2026-03-29)', async () => {
    const onThe28th = event('2026-03-28T12:00:00.000Z', null);
    const onThe29th = event('2026-03-29T00:00:00.000Z', null); // 01:00 CET on the 29th
    const onThe30th = event('2026-03-29T22:00:00.000Z', null); // 00:00 CEST on the 30th

    // 00:30 CET on the 29th (UTC is still the 28th).
    const early = await serviceAt('2026-03-28T23:30:00.000Z', [
      onThe28th,
      onThe29th,
      onThe30th,
    ]).dividends('u1', ASSET_ID);
    expect(early.upcoming).toEqual([onThe29th, onThe30th]);
    expect(early.history).toEqual([onThe28th]);

    // 23:59 CEST on the 29th — the switch shortened the day, not the boundary.
    const late = await serviceAt('2026-03-29T21:59:00.000Z', [onThe29th, onThe30th]).dividends(
      'u1',
      ASSET_ID,
    );
    expect(late.upcoming).toEqual([onThe29th, onThe30th]);
    expect(late.history).toEqual([]);

    // 00:00 CEST on the 30th (UTC is still the 29th): the 29th is now past.
    const next = await serviceAt('2026-03-29T22:00:00.000Z', [onThe29th, onThe30th]).dividends(
      'u1',
      ASSET_ID,
    );
    expect(next.upcoming).toEqual([onThe30th]);
    expect(next.history).toEqual([onThe29th]);
  });

  it('measures the boundary on the Vienna day across the autumn DST switch (2026-10-25)', async () => {
    const lastOfThe24th = event('2026-10-24T21:59:00.000Z', null); // 23:59 CEST on the 24th
    const firstOfThe25th = event('2026-10-24T22:00:00.000Z', null); // 00:00 CEST on the 25th
    const onThe26th = event('2026-10-25T23:00:00.000Z', null); // 00:00 CET on the 26th

    // 00:00 CEST on the 25th (UTC is still the 24th).
    const early = await serviceAt('2026-10-24T22:00:00.000Z', [
      lastOfThe24th,
      firstOfThe25th,
      onThe26th,
    ]).dividends('u1', ASSET_ID);
    expect(early.upcoming).toEqual([firstOfThe25th, onThe26th]);
    expect(early.history).toEqual([lastOfThe24th]);

    // 23:59 CET on the 25th — the repeated hour lengthened the day, not the boundary.
    const late = await serviceAt('2026-10-25T22:59:00.000Z', [firstOfThe25th, onThe26th]).dividends(
      'u1',
      ASSET_ID,
    );
    expect(late.upcoming).toEqual([firstOfThe25th, onThe26th]);
    expect(late.history).toEqual([]);

    // 00:00 CET on the 26th: the 25th is now past.
    const next = await serviceAt('2026-10-25T23:00:00.000Z', [firstOfThe25th, onThe26th]).dividends(
      'u1',
      ASSET_ID,
    );
    expect(next.upcoming).toEqual([onThe26th]);
    expect(next.history).toEqual([firstOfThe25th]);
  });
});
