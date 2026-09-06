import type {
  AssetRef,
  DividendEvent,
  DividendEvents,
  EarningsEvent,
  EarningsEvents,
  NewsHeadline,
  SplitEvent,
  SplitEvents,
} from '@bettertrack/contracts';
import { describe, expect, it } from 'vitest';

import type { AssetRepository } from '../../../data/repositories/assetRepository';
import { cachedIntel, createStubMarketData } from '../../../testing/marketDataStubs';
import {
  createMarketIntelService,
  DIVIDEND_HISTORY_MAX_EVENTS,
  DIVIDEND_UPCOMING_MAX_EVENTS,
  EARNINGS_RECENT_MAX_EVENTS,
  NEWS_HEADLINES_MAX,
  SPLIT_EVENTS_MAX,
} from '../marketIntelService';

/**
 * Every per-asset intel payload is bounded in the READ SERVICE (#1873), where
 * the dividend history's bound and the news digest's already live — not in a
 * provider mapper, which is per-provider and sits on the wrong side of the trust
 * boundary. Each test hands the service a provider payload longer than any real
 * issuer produces and asserts what reaches the caller.
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

/** Day `i` of an ISO series, so every fixture row carries a distinct date. */
const day = (i: number) => new Date(Date.UTC(2000, 0, 1) + i * 86_400_000).toISOString();
/** Month `i` of an ISO series — the cadence a monthly distributor pays on. */
const month = (i: number) => new Date(Date.UTC(2000, i, 1)).toISOString();

function serviceWith(controls: {
  dividends?: DividendEvents;
  earnings?: EarningsEvents;
  news?: NewsHeadline[];
  splits?: SplitEvents;
}) {
  const { dividends: div, earnings: earn, news, splits } = controls;
  return createMarketIntelService({
    marketData: createStubMarketData({
      ...(div ? { dividends: (_ref: AssetRef) => cachedIntel(div) } : {}),
      ...(earn ? { earnings: (_ref: AssetRef) => cachedIntel(earn) } : {}),
      ...(news ? { news: (_ref: AssetRef) => cachedIntel(news) } : {}),
      ...(splits ? { splits: (_ref: AssetRef) => cachedIntel(splits) } : {}),
    }),
    assetRepo,
    intelRepo,
    enabled: true,
  });
}

function payout(exDate: string, amount: number): DividendEvent {
  return { exDate, payDate: null, amount, currency: 'USD' };
}

function dividends(over: Partial<DividendEvents>): DividendEvents {
  return {
    currency: 'USD',
    history: [],
    upcoming: [],
    forwardYield: null,
    trailingAmount: null,
    trailingAmountBasis: null,
    ...over,
  };
}

function report(periodEnd: string, epsActual: number): EarningsEvent {
  return { date: null, periodEnd, epsEstimate: epsActual, epsActual, estimated: false };
}

function headline(i: number): NewsHeadline {
  return {
    id: `n-${i}`,
    title: `Headline ${i}`,
    publisher: 'Wire',
    url: `https://news.example.com/${i}`,
    publishedAt: day(i),
  };
}

function split(date: string, numerator: number): SplitEvent {
  return { date, numerator, denominator: 1, ratio: `${numerator}:1` };
}

describe('marketIntel — per-asset payload bounds (#1873)', () => {
  it('news: a provider returning hundreds is cut to the NEWEST headlines', async () => {
    // The Yahoo provider asks for 20; a second news provider is not a trust
    // boundary, and its flood must not expand the asset page's "show more".
    // This one lists oldest-first — the cut must still keep the newest, which a
    // plain head-slice on the provider's order would not.
    const flood = Array.from({ length: NEWS_HEADLINES_MAX + 60 }, (_, i) => headline(i));

    const res = await serviceWith({ news: flood }).news('u1', ASSET_ID);

    expect(res.available).toBe(true);
    expect(res.headlines).toHaveLength(NEWS_HEADLINES_MAX);
    expect(res.headlines).toEqual([...flood].reverse().slice(0, NEWS_HEADLINES_MAX));
    // Not the head the provider offered.
    expect(res.headlines).not.toContainEqual(headline(0));
  });

  it('news: a payload that fits is passed through in the provider order', async () => {
    // The bound decides which end a CUT takes; it does not re-order a response
    // that was never truncated.
    const few = [headline(3), headline(1), headline(2)];

    const res = await serviceWith({ news: few }).news('u1', ASSET_ID);

    expect(res.headlines).toEqual(few);
  });

  it('earnings: a flooded report history keeps the MOST RECENT reports', async () => {
    const flood = Array.from({ length: EARNINGS_RECENT_MAX_EVENTS + 25 }, (_, i) =>
      report(day(i), 1 + i / 100),
    );
    const next: EarningsEvent = {
      date: '2026-07-31T00:00:00.000Z',
      periodEnd: null,
      epsEstimate: 1.4,
      epsActual: null,
      estimated: true,
    };

    const res = await serviceWith({ earnings: { next, recent: flood } }).earnings('u1', ASSET_ID);

    expect(res.recent).toHaveLength(EARNINGS_RECENT_MAX_EVENTS);
    // Ascending by the date each row carries, so the recent end is the tail.
    expect(res.recent[0]).toEqual(flood[25]);
    expect(res.recent.at(-1)).toEqual(flood.at(-1));
    // The upcoming report is untouched by the history bound.
    expect(res.next).toEqual(next);
  });

  it('splits: BOTH arrays are bounded — history keeps the recent end, upcoming the soonest', async () => {
    const history = Array.from({ length: SPLIT_EVENTS_MAX + 12 }, (_, i) => split(day(i), 2));
    const upcoming = Array.from({ length: SPLIT_EVENTS_MAX + 7 }, (_, i) => split(day(900 + i), 4));

    const res = await serviceWith({ splits: { history, upcoming } }).splits('u1', ASSET_ID);

    expect(res.history).toHaveLength(SPLIT_EVENTS_MAX);
    expect(res.history[0]).toEqual(history[12]);
    expect(res.history.at(-1)).toEqual(history.at(-1));

    expect(res.upcoming).toHaveLength(SPLIT_EVENTS_MAX);
    expect(res.upcoming[0]).toEqual(upcoming[0]);
    expect(res.upcoming.at(-1)).toEqual(upcoming[SPLIT_EVENTS_MAX - 1]);
  });

  it('dividends: the forward calendar is bounded to the soonest announced events', async () => {
    const upcoming = Array.from({ length: DIVIDEND_UPCOMING_MAX_EVENTS + 30 }, (_, i) =>
      payout(day(i), 0.1),
    );

    const res = await serviceWith({ dividends: dividends({ upcoming }) }).dividends('u1', ASSET_ID);

    expect(res.upcoming).toHaveLength(DIVIDEND_UPCOMING_MAX_EVENTS);
    expect(res.upcoming).toEqual(upcoming.slice(0, DIVIDEND_UPCOMING_MAX_EVENTS));
  });

  it('dividends: the longest monthly record a provider carries survives UNCUT', async () => {
    // What the old bounds got wrong: quarterly payers cleared them, a monthly
    // distributor did not, and the cut was silent — no `truncated` marker, under
    // a `historyRange` label the asset page reads off the SURVIVING first row.
    // The named counterexample is Realty Income: monthly since its Oct-1994
    // listing, so the provider's own history is ~380 payouts and grows by one a
    // month. The whole of it has to reach the caller, not "most of it".
    const monthsSinceListing = 32 * 12; // Oct 1994 → Sep 2026, one payout a month.
    const sinceListing = Array.from({ length: monthsSinceListing }, (_, i) =>
      payout(month(i), 0.2),
    );
    expect(sinceListing.length).toBeGreaterThan(380);
    expect(sinceListing.length).toBeLessThanOrEqual(DIVIDEND_HISTORY_MAX_EVENTS);

    const res = await serviceWith({
      dividends: dividends({ history: sinceListing }),
    }).dividends('u1', ASSET_ID);

    expect(res.history).toEqual(sinceListing);
  });

  it('dividends: beyond the bound the OLD end is what is cut — the documented trade', async () => {
    // The comment on DIVIDEND_HISTORY_MAX_EVENTS no longer claims nothing can
    // exceed it; it states what happens when something does. Pin that: the most
    // recent payouts survive and the oldest are dropped, silently.
    const longer = Array.from({ length: DIVIDEND_HISTORY_MAX_EVENTS + 48 }, (_, i) =>
      payout(month(i), 0.2),
    );

    const res = await serviceWith({
      dividends: dividends({ history: longer }),
    }).dividends('u1', ASSET_ID);

    expect(res.history).toHaveLength(DIVIDEND_HISTORY_MAX_EVENTS);
    expect(res.history[0]).toEqual(longer[48]);
    expect(res.history.at(-1)).toEqual(longer.at(-1));
    // No marker travels with the array — that is the trade, not an oversight.
    expect(res).not.toHaveProperty('truncated');
  });

  it('cuts the end each bound claims even when the provider orders its arrays backwards', async () => {
    // The constants say which end survives; a provider is not a trust boundary,
    // so the ordering the cut relies on is established HERE (#1873). Every array
    // below arrives in the reverse of its documented order.
    const upcoming = Array.from({ length: DIVIDEND_UPCOMING_MAX_EVENTS + 30 }, (_, i) =>
      payout(day(i), 0.1),
    ).reverse(); // latest-first
    const recent = Array.from({ length: EARNINGS_RECENT_MAX_EVENTS + 25 }, (_, i) =>
      report(day(i), 1 + i / 100),
    ).reverse(); // newest-first
    const splitHistory = Array.from({ length: SPLIT_EVENTS_MAX + 12 }, (_, i) =>
      split(day(i), 2),
    ).reverse(); // newest-first
    const splitUpcoming = Array.from({ length: SPLIT_EVENTS_MAX + 7 }, (_, i) =>
      split(day(900 + i), 4),
    ).reverse(); // latest-first

    const service = serviceWith({
      dividends: dividends({ upcoming }),
      earnings: { next: null, recent },
      splits: { history: splitHistory, upcoming: splitUpcoming },
    });
    const [div, earn, spl] = await Promise.all([
      service.dividends('u1', ASSET_ID),
      service.earnings('u1', ASSET_ID),
      service.splits('u1', ASSET_ID),
    ]);

    // Forward calendars keep the SOONEST, not the head of what arrived.
    expect(div.upcoming).toHaveLength(DIVIDEND_UPCOMING_MAX_EVENTS);
    expect(div.upcoming[0]).toEqual(payout(day(0), 0.1));
    expect(div.upcoming.at(-1)).toEqual(payout(day(DIVIDEND_UPCOMING_MAX_EVENTS - 1), 0.1));

    expect(spl.upcoming).toHaveLength(SPLIT_EVENTS_MAX);
    expect(spl.upcoming[0]).toEqual(split(day(900), 4));
    expect(spl.upcoming.at(-1)).toEqual(split(day(900 + SPLIT_EVENTS_MAX - 1), 4));

    // Histories keep the MOST RECENT, not the tail of what arrived.
    expect(earn.recent).toHaveLength(EARNINGS_RECENT_MAX_EVENTS);
    expect(earn.recent[0]).toEqual(report(day(25), 1.25));
    expect(earn.recent.at(-1)).toEqual(report(day(EARNINGS_RECENT_MAX_EVENTS + 24), 1 + 0.64));

    expect(spl.history).toHaveLength(SPLIT_EVENTS_MAX);
    expect(spl.history[0]).toEqual(split(day(12), 2));
    expect(spl.history.at(-1)).toEqual(split(day(SPLIT_EVENTS_MAX + 11), 2));
  });
});
