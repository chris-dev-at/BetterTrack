import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

// ─── API mocks ────────────────────────────────────────────────────────────────

vi.mock('../../lib/workboardApi', () => ({
  WORKBOARD_QUERY_KEY: ['workboard'],
  WATCHLISTS_QUERY_KEY: ['workboard', 'watchlists'],
  listWorkboard: vi.fn(),
  listWatchlists: vi.fn(),
  removeFromWorkboard: vi.fn(),
  reorderWorkboard: vi.fn(),
}));

vi.mock('../../lib/assetApi', () => ({
  getAssetQuotes: vi.fn(),
  getAssetSparklines: vi.fn(),
  workboardQuotesQueryKey: (ids: readonly string[]) => ['assets', 'workboard', 'quotes', ids],
  workboardSparklinesQueryKey: (ids: readonly string[]) => [
    'assets',
    'workboard',
    'sparklines',
    ids,
  ],
}));

vi.mock('../../lib/marketIntelApi', () => ({
  EARNINGS_CALENDAR_QUERY_KEY: ['intel', 'earnings-calendar'],
  getEarningsCalendar: vi.fn(),
}));

vi.mock('../../lib/socialApi', () => ({
  getAudience: vi.fn(),
  listFriends: vi.fn(),
  listGroups: vi.fn(),
  setAudience: vi.fn(),
}));

import {
  WORKBOARD_QUERY_KEY,
  listWatchlists,
  listWorkboard,
  removeFromWorkboard,
  reorderWorkboard,
} from '../../lib/workboardApi';
import { getAssetQuotes, getAssetSparklines } from '../../lib/assetApi';
import { ApiError } from '../../lib/apiClient';
import { getEarningsCalendar } from '../../lib/marketIntelApi';
import { getAudience, listFriends, listGroups, setAudience } from '../../lib/socialApi';
import { MutationFeedbackProvider } from '../hooks/useMutationFeedback';
import { WorkboardPage } from './WorkboardPage';

const EMPTY_EARNINGS_CALENDAR = { available: false as const, entries: [] };
const DEFAULT_WATCHLIST_ID = 'c0000000-0000-0000-0000-0000000000c1';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ITEM_A = {
  id: '00000000-0000-0000-0000-000000000001',
  watchlistId: DEFAULT_WATCHLIST_ID,
  assetId: 'aa000000-0000-0000-0000-000000000001',
  sortOrder: 0,
  note: null,
  asset: {
    symbol: 'AAPL',
    name: 'Apple Inc.',
    exchange: 'NASDAQ',
    currency: 'USD',
    type: 'stock' as const,
  },
};

const ITEM_B = {
  id: '00000000-0000-0000-0000-000000000002',
  watchlistId: 'c0000000-0000-0000-0000-0000000000c1',
  assetId: 'bb000000-0000-0000-0000-000000000002',
  sortOrder: 1,
  note: null,
  asset: {
    symbol: 'MSFT',
    name: 'Microsoft Corporation',
    exchange: 'NASDAQ',
    currency: 'USD',
    type: 'stock' as const,
  },
};

const BASE_QUOTE = {
  quote: {
    price: 150.0,
    currency: 'USD' as const,
    prevClose: 148.0,
    dayChangePct: 1.35,
    asOf: '2024-06-01T12:00:00.000Z',
  },
  stale: false,
  asOf: '2024-06-01T12:00:00.000Z',
};

const BASE_SPARKLINE = {
  points: [
    { time: '2024-05-01T00:00:00.000Z', close: 140.0 },
    { time: '2024-05-15T00:00:00.000Z', close: 145.0 },
    { time: '2024-06-01T00:00:00.000Z', close: 150.0 },
  ],
  stale: false,
  asOf: '2024-06-01T12:00:00.000Z',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
}

function renderPage(client = makeQueryClient()) {
  const view = render(
    <QueryClientProvider client={client}>
      <MutationFeedbackProvider>
        <MemoryRouter>
          <WorkboardPage />
        </MemoryRouter>
      </MutationFeedbackProvider>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

/**
 * Holds every quote read open until the returned opener is called.
 *
 * A test that wants to observe the in-flight window cannot capture one call's
 * `resolve` and fire it: the batch for a freshly minted id set is started from
 * a passive effect, so it can be issued after the row it belongs to is already
 * in the DOM — i.e. after the capture. Calling a resolver captured too early
 * (or none at all) then leaves the read the assertions depend on pending
 * forever. Gating on one shared promise resolves every call whenever it
 * arrives, so only the opening is ordered, not the issuing.
 */
function gateQuoteReads() {
  let open: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  vi.mocked(getAssetQuotes).mockImplementation(async (ids) => {
    await gate;
    return { quotes: ids.map((assetId) => ({ assetId, ...BASE_QUOTE })), failed: [] };
  });
  return async () => {
    await act(async () => {
      open?.();
      await gate;
    });
  };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAssetQuotes).mockImplementation(async (ids) => ({
    quotes: ids.map((assetId) => ({ assetId, ...BASE_QUOTE })),
    failed: [],
  }));
  vi.mocked(getAssetSparklines).mockImplementation(async (ids) => ({
    sparklines: ids.map((assetId) => ({ assetId, ...BASE_SPARKLINE })),
    failed: [],
  }));
  vi.mocked(removeFromWorkboard).mockResolvedValue(undefined);
  vi.mocked(reorderWorkboard).mockResolvedValue(undefined);
  vi.mocked(listWatchlists).mockResolvedValue({
    watchlists: [
      {
        id: DEFAULT_WATCHLIST_ID,
        name: 'General',
        isDefault: true,
        itemCount: 2,
        audience: 'private',
      },
    ],
  });
  vi.mocked(getAudience).mockResolvedValue({
    kind: 'watchlist',
    subjectId: DEFAULT_WATCHLIST_ID,
    audience: 'private',
    friendIds: [],
    groupId: null,
    link: { active: false, createdAt: null },
  });
  vi.mocked(listFriends).mockResolvedValue({ friends: [] });
  vi.mocked(listGroups).mockResolvedValue({ groups: [] });
  // Earnings panel hidden by default (unconfigured); opt-in tests override.
  vi.mocked(getEarningsCalendar).mockResolvedValue(EMPTY_EARNINGS_CALENDAR);
});

// ─── Upcoming earnings panel (§13.5 V5-P5) ───────────────────────────────────

describe('WorkboardPage — upcoming earnings panel', () => {
  const CAL_ENTRY = (over: Record<string, unknown>) => ({
    assetId: 'aa000000-0000-0000-0000-000000000009',
    symbol: 'AAA',
    name: 'Asset AAA',
    date: '2026-08-10T00:00:00.000Z',
    epsEstimate: 1.2,
    estimated: false,
    held: true,
    watched: false,
    ...over,
  });

  test('lists held + watched assets chronologically with confirmed/estimated flags', async () => {
    vi.mocked(listWorkboard).mockResolvedValue({ items: [] });
    vi.mocked(getEarningsCalendar).mockResolvedValue({
      available: true,
      entries: [
        CAL_ENTRY({
          symbol: 'MSFT',
          name: 'Microsoft',
          date: '2026-07-25T00:00:00.000Z',
          estimated: false,
          held: false,
          watched: true,
        }),
        CAL_ENTRY({
          symbol: 'AAPL',
          name: 'Apple',
          date: '2026-08-10T00:00:00.000Z',
          estimated: true,
          held: true,
          watched: false,
        }),
      ],
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('Upcoming earnings')).toBeInTheDocument());
    expect(screen.getByText('MSFT')).toBeInTheDocument();
    expect(screen.getByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText('Estimated')).toBeInTheDocument();
    expect(screen.getByText('Confirmed')).toBeInTheDocument();
  });

  test('says a capped calendar is partial rather than rendering it as complete', async () => {
    vi.mocked(listWorkboard).mockResolvedValue({ items: [] });
    vi.mocked(getEarningsCalendar).mockResolvedValue({
      available: true,
      entries: [CAL_ENTRY({ symbol: 'AAPL', name: 'Apple' })],
      truncated: true,
    });
    renderPage();
    expect(
      await screen.findByText(
        'Partial: you hold or watch more assets than we look up in one pass, so some are missing below.',
      ),
    ).toBeInTheDocument();
  });

  test('stays silent about truncation for a calendar that covered the whole book', async () => {
    vi.mocked(listWorkboard).mockResolvedValue({ items: [] });
    vi.mocked(getEarningsCalendar).mockResolvedValue({
      available: true,
      entries: [CAL_ENTRY({ symbol: 'AAPL', name: 'Apple' })],
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('Upcoming earnings')).toBeInTheDocument());
    expect(screen.queryByText(/^Partial:/)).not.toBeInTheDocument();
  });

  test('is absent when the calendar is unavailable (gate off / no capability)', async () => {
    vi.mocked(listWorkboard).mockResolvedValue({ items: [] });
    vi.mocked(getEarningsCalendar).mockResolvedValue({ available: false, entries: [] });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText('Your alerts live on the Alerts tab')).toBeInTheDocument(),
    );
    expect(screen.queryByText('Upcoming earnings')).not.toBeInTheDocument();
  });

  test('is absent when there are no upcoming events', async () => {
    vi.mocked(listWorkboard).mockResolvedValue({ items: [] });
    vi.mocked(getEarningsCalendar).mockResolvedValue({ available: true, entries: [] });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText('Your alerts live on the Alerts tab')).toBeInTheDocument(),
    );
    expect(screen.queryByText('Upcoming earnings')).not.toBeInTheDocument();
  });
});

// ─── Empty state ──────────────────────────────────────────────────────────────

describe('WorkboardPage — empty state', () => {
  test('shows empty state and search link when watchlist is empty', async () => {
    vi.mocked(listWorkboard).mockResolvedValue({ items: [] });
    renderPage();
    await waitFor(() => expect(screen.getByText(/Your watchlist is empty/i)).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /Search for an asset/i })).toBeInTheDocument();
  });
});

// ─── Item rendering ───────────────────────────────────────────────────────────

describe('WorkboardPage — item rendering', () => {
  test('renders terminal failures without retry and offers retry only for an outage', async () => {
    vi.mocked(listWorkboard).mockResolvedValue({ items: [ITEM_A] });
    vi.mocked(getAssetQuotes).mockRejectedValue(new ApiError(503, 'UNAVAILABLE', 'offline'));
    vi.mocked(getAssetSparklines).mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'missing'));
    vi.mocked(listWatchlists).mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'forbidden'));
    renderPage();

    // The 403 sharing read stays terminal and retry-less; the shared market
    // read presents ONE outage state with ONE retry, not one per row.
    await waitFor(() =>
      expect(screen.getByText('Something went wrong. Please try again.')).toBeInTheDocument(),
    );
    expect(screen.getByText("This information isn't available.")).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Try again' })).toHaveLength(1);
  });

  test('a terminal market read shows one zone-level unavailable state, no retry', async () => {
    vi.mocked(listWorkboard).mockResolvedValue({ items: [ITEM_A, ITEM_B] });
    vi.mocked(getAssetQuotes).mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'missing'));
    vi.mocked(getAssetSparklines).mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'missing'));
    renderPage();

    await waitFor(() =>
      expect(screen.getByText("This information isn't available.")).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  test('keeps cached quote and sparkline visible after a failed background refetch', async () => {
    vi.mocked(listWorkboard).mockResolvedValue({ items: [ITEM_A] });
    const { client } = renderPage();

    const row = (await screen.findByText('AAPL')).closest('tr');
    expect(row).not.toBeNull();
    expect(
      await within(row!).findByRole('img', { name: '1-month trend for AAPL' }),
    ).toBeInTheDocument();
    expect(await within(row!).findByText(/150/)).toBeInTheDocument();

    vi.mocked(getAssetQuotes).mockRejectedValue(new ApiError(503, 'UNAVAILABLE', 'quote offline'));
    vi.mocked(getAssetSparklines).mockRejectedValue(
      new ApiError(503, 'UNAVAILABLE', 'history offline'),
    );
    await act(async () => {
      await client.refetchQueries({ queryKey: ['assets', 'workboard'], type: 'active' });
    });

    expect(
      await within(row!).findByRole('img', { name: '1-month trend for AAPL' }),
    ).toBeInTheDocument();
    expect(within(row!).getByText(/150/)).toBeInTheDocument();
    // One retry for the shared read, offered outside the table rather than
    // stamped into every row.
    expect(await screen.findAllByRole('button', { name: 'Try again' })).toHaveLength(1);
    expect(within(row!).queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  test('keeps surviving rows rendered while a removal remints the batch key', async () => {
    vi.mocked(listWorkboard).mockResolvedValue({ items: [ITEM_A, ITEM_B] });
    renderPage();

    expect(await screen.findByRole('img', { name: '1-month trend for AAPL' })).toBeInTheDocument();

    // Removing MSFT changes the id set, so both aggregate queries get a brand
    // new cache key. `keepPreviousData` must keep AAPL's row rendered instead
    // of dropping every survivor back to a skeleton.
    vi.mocked(listWorkboard).mockResolvedValue({ items: [ITEM_A] });
    const openQuotes = gateQuoteReads();
    await userEvent.click(screen.getByRole('button', { name: 'Remove MSFT from watchlist' }));

    await waitFor(() => expect(screen.queryByText('MSFT')).not.toBeInTheDocument());
    expect(screen.getByRole('img', { name: '1-month trend for AAPL' })).toBeInTheDocument();
    expect(screen.getByText(/150/)).toBeInTheDocument();
    await openQuotes();
  });

  test('reports rows the provider could not price, with one retry for the zone', async () => {
    // A partial provider failure comes back as a 200 with the id in `failed`,
    // so neither query is in an error state. Without this the row would show
    // "—" forever and nothing would re-run it (the sparkline read has a
    // 15-minute stale window and no poll).
    vi.mocked(listWorkboard).mockResolvedValue({ items: [ITEM_A, ITEM_B] });
    vi.mocked(getAssetQuotes).mockImplementation(async (ids) => ({
      quotes: ids
        .filter((assetId) => assetId !== ITEM_B.assetId)
        .map((assetId) => ({ assetId, ...BASE_QUOTE })),
      failed: [ITEM_B.assetId],
    }));
    renderPage();

    expect(
      await screen.findByText("Market data for 1 asset couldn't be loaded."),
    ).toBeInTheDocument();
    // The healthy row is untouched — isolation, not an all-or-nothing failure.
    expect(screen.getByText(/150/)).toBeInTheDocument();

    const quoteCalls = vi.mocked(getAssetQuotes).mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(vi.mocked(getAssetQuotes).mock.calls.length).toBeGreaterThan(quoteCalls),
    );
    // Only the read that lost rows re-runs; the healthy sparkline read does not.
    expect(vi.mocked(getAssetSparklines)).toHaveBeenCalledTimes(1);
  });

  test('counts each failed asset once across both aggregate reads', async () => {
    vi.mocked(listWorkboard).mockResolvedValue({ items: [ITEM_A, ITEM_B] });
    vi.mocked(getAssetQuotes).mockImplementation(async () => ({
      quotes: [],
      failed: [ITEM_A.assetId, ITEM_B.assetId],
    }));
    vi.mocked(getAssetSparklines).mockImplementation(async () => ({
      sparklines: [],
      failed: [ITEM_B.assetId],
    }));
    renderPage();

    expect(
      await screen.findByText("Market data for 2 assets couldn't be loaded."),
    ).toBeInTheDocument();
  });

  test('reports a row the server omitted entirely, not only the ones it called failed', async () => {
    // An id the caller can no longer see is absent from BOTH `quotes` and
    // `failed` — the server keeps invisible ids indistinguishable from a foreign
    // custom asset (§10) — so only the client can notice the gap. Otherwise the
    // stranded row shows "—" forever with nothing to press.
    vi.mocked(listWorkboard).mockResolvedValue({ items: [ITEM_A, ITEM_B] });
    vi.mocked(getAssetQuotes).mockImplementation(async (ids) => ({
      quotes: ids
        .filter((assetId) => assetId !== ITEM_B.assetId)
        .map((assetId) => ({ assetId, ...BASE_QUOTE })),
      failed: [],
    }));
    renderPage();

    expect(
      await screen.findByText("Market data for 1 asset couldn't be loaded."),
    ).toBeInTheDocument();
    // Folded into the same zone alert, not a second one.
    expect(screen.getAllByRole('button', { name: 'Try again' })).toHaveLength(1);
    expect(screen.getByText(/150/)).toBeInTheDocument();
  });

  test('does not accuse a just-added row while the previous batch is still shown', async () => {
    // Adding a row remints the batch key, and `keepPreviousData` keeps showing
    // the previous id set's answer — which legitimately has no entry for the new
    // asset. That placeholder window must not read as "the server omitted it".
    vi.mocked(listWorkboard).mockResolvedValue({ items: [ITEM_A] });
    const { client } = renderPage();
    expect(await screen.findByText('AAPL')).toBeInTheDocument();

    vi.mocked(listWorkboard).mockResolvedValue({ items: [ITEM_A, ITEM_B] });
    const openQuotes = gateQuoteReads();
    await act(async () => {
      await client.invalidateQueries({ queryKey: WORKBOARD_QUERY_KEY });
    });

    await waitFor(() => expect(screen.getByText('MSFT')).toBeInTheDocument());
    // The placeholder window only opens once the batch for the new id set is
    // actually in flight — asserting before that would pass for the wrong
    // reason, on a row whose read has not been issued yet.
    await waitFor(() =>
      expect(getAssetQuotes).toHaveBeenCalledWith(
        [ITEM_A.assetId, ITEM_B.assetId],
        expect.anything(),
      ),
    );
    expect(screen.queryByText(/couldn't be loaded/)).not.toBeInTheDocument();

    await openQuotes();
    await waitFor(() => expect(screen.getAllByText(/150/).length).toBeGreaterThan(1));
    expect(screen.queryByText(/couldn't be loaded/)).not.toBeInTheDocument();
  });

  test('shows asset symbols and names for all items', async () => {
    vi.mocked(listWorkboard).mockResolvedValue({ items: [ITEM_A, ITEM_B] });
    renderPage();
    await waitFor(() => expect(screen.getByText('AAPL')).toBeInTheDocument());
    expect(screen.getByText('Apple Inc.')).toBeInTheDocument();
    expect(screen.getByText('MSFT')).toBeInTheDocument();
    expect(screen.getByText('Microsoft Corporation')).toBeInTheDocument();
  });

  test('loads 20 rows through one quote batch and one compact-sparkline batch', async () => {
    const items = Array.from({ length: 20 }, (_, index) => ({
      ...ITEM_A,
      id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      assetId: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      sortOrder: index,
      asset: {
        ...ITEM_A.asset,
        symbol: `ASSET${index}`,
        name: `Asset ${index}`,
      },
    }));
    vi.mocked(listWorkboard).mockResolvedValue({ items });

    renderPage();

    await waitFor(() => {
      expect(vi.mocked(getAssetQuotes)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(getAssetSparklines)).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(getAssetQuotes).mock.calls[0]?.[0]).toEqual(
      items.map((item) => item.assetId).sort(),
    );
    expect(vi.mocked(getAssetSparklines).mock.calls[0]?.[0]).toEqual(
      items.map((item) => item.assetId).sort(),
    );
    expect(
      await screen.findByRole('img', { name: '1-month trend for ASSET19' }),
    ).toBeInTheDocument();
  });

  test('symbol links navigate to asset detail page', async () => {
    vi.mocked(listWorkboard).mockResolvedValue({ items: [ITEM_A] });
    renderPage();
    await waitFor(() => expect(screen.getByText('AAPL')).toBeInTheDocument());
    const link = screen.getByRole('link', { name: 'AAPL' });
    expect(link).toHaveAttribute('href', `/assets/${ITEM_A.assetId}`);
  });

  test('shows remove button for each item', async () => {
    vi.mocked(listWorkboard).mockResolvedValue({ items: [ITEM_A, ITEM_B] });
    renderPage();
    await waitFor(() => expect(screen.getByText('AAPL')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Remove AAPL from watchlist/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Remove MSFT from watchlist/i })).toBeInTheDocument();
  });

  test('displays per-row note when present', async () => {
    const itemWithNote = { ...ITEM_A, note: 'Watching for earnings' };
    vi.mocked(listWorkboard).mockResolvedValue({ items: [itemWithNote] });
    renderPage();
    await waitFor(() => expect(screen.getByText('Watching for earnings')).toBeInTheDocument());
  });

  test('shows error state when API fails', async () => {
    vi.mocked(listWorkboard).mockRejectedValue(new Error('network error'));
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/Could not load your watchlist/i)).toBeInTheDocument(),
    );
  });
});

// ─── Refetch on mount (§13.2) ──────────────────────────────────────────────────

describe('WorkboardPage — refetch on mount', () => {
  test('refetches even when cached watchlist data is still fresh', async () => {
    // A long staleTime means the default `refetchOnMount: true` would skip the
    // network call and just show the cached (stale/empty) snapshot. The
    // watchlist must always hit the network on mount so an icon-add elsewhere
    // in the app shows up here without a manual reload.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
    });
    client.setQueryData(['workboard'], { items: [] });
    vi.mocked(listWorkboard).mockResolvedValue({ items: [ITEM_A] });

    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <WorkboardPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('AAPL')).toBeInTheDocument());
    expect(vi.mocked(listWorkboard)).toHaveBeenCalled();
  });
});

// ─── Zone placeholders ────────────────────────────────────────────────────────

describe('WorkboardPage — zone placeholders', () => {
  // The zones are still stubs, but ALERTS AND BLUEPRINTS SHIP — so the copy must
  // say the panel is unbuilt and route to the working tab, never that the
  // feature is "coming soon" (which it stopped being two phases ago).
  test('the Alerts zone points at the shipped Alerts tab instead of claiming it is unbuilt', async () => {
    vi.mocked(listWorkboard).mockResolvedValue({ items: [] });
    renderPage();
    await waitFor(() => expect(screen.getByText('Alerts')).toBeInTheDocument());
    expect(screen.getByText('Your alerts live on the Alerts tab')).toBeInTheDocument();
    expect(screen.queryByText(/coming soon/i)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Alerts →' })).toHaveAttribute(
      'href',
      '/workbench/alerts',
    );
  });

  test('the Blueprints zone points at the shipped Blueprints tab', async () => {
    vi.mocked(listWorkboard).mockResolvedValue({ items: [] });
    renderPage();
    await waitFor(() => expect(screen.getByText('My Blueprints')).toBeInTheDocument());
    expect(screen.getByText('Your Blueprints live on the Blueprints tab')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Blueprints →' })).toHaveAttribute(
      'href',
      '/workbench/blueprints',
    );
  });

  test('placeholder zones do not throw when watchlist has items', async () => {
    vi.mocked(listWorkboard).mockResolvedValue({ items: [ITEM_A] });
    renderPage();
    await waitFor(() => expect(screen.getByText('AAPL')).toBeInTheDocument());
    // Use role+level to target the <h2> headings, not the "Alerts" <th> column header.
    expect(screen.getByRole('heading', { name: 'Alerts', level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'My Blueprints', level: 2 })).toBeInTheDocument();
  });
});

// ─── Watchlist sharing ────────────────────────────────────────────────────────

describe('WorkboardPage — watchlist sharing', () => {
  test('requires the shared audience confirmation before replacing a narrower audience', async () => {
    vi.mocked(listWorkboard).mockResolvedValue({ items: [ITEM_A] });
    vi.mocked(listWatchlists).mockResolvedValue({
      watchlists: [
        {
          id: DEFAULT_WATCHLIST_ID,
          name: 'General',
          isDefault: true,
          itemCount: 1,
          audience: 'specific_friends',
        },
      ],
    });
    vi.mocked(getAudience).mockResolvedValue({
      kind: 'watchlist',
      subjectId: DEFAULT_WATCHLIST_ID,
      audience: 'specific_friends',
      friendIds: [],
      groupId: null,
      link: { active: false, createdAt: null },
    });
    vi.mocked(setAudience).mockResolvedValue({
      state: {
        kind: 'watchlist',
        subjectId: DEFAULT_WATCHLIST_ID,
        audience: 'all_friends',
        friendIds: [],
        groupId: null,
        link: { active: false, createdAt: null },
      },
    });
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('AAPL')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Shared with friends' }));
    await user.click(await screen.findByRole('radio', { name: /all friends/i }));
    expect(
      screen.getByText(/change access from specific friends to all friends/i),
    ).toBeInTheDocument();
    expect(setAudience).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(setAudience).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Shared with friends' }));
    await user.click(await screen.findByRole('radio', { name: /all friends/i }));
    await user.click(screen.getByRole('checkbox', { name: /this change widens access/i }));
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(setAudience).toHaveBeenCalledTimes(1));
    expect(setAudience).toHaveBeenCalledWith('watchlist', DEFAULT_WATCHLIST_ID, {
      audience: 'all_friends',
      friendIds: undefined,
      acknowledgePublic: undefined,
      confirmWiden: true,
    });
  });

  // The legacy read this control replaced mapped EVERY non-private audience to
  // "shared", and the server mirrors the same rule into the conglomerate
  // visibility column. Reading only `all_friends` as shared would tell a user
  // with a live public link that their General list is private (§6.9).
  test.each([
    ['private', 'Share with friends'],
    ['all_friends', 'Shared with friends'],
    ['specific_friends', 'Shared with friends'],
    ['group', 'Shared with friends'],
    ['public_link', 'Shared with friends'],
  ] as const)('labels a %s watchlist as "%s"', async (audience, label) => {
    vi.mocked(listWorkboard).mockResolvedValue({ items: [ITEM_A] });
    vi.mocked(listWatchlists).mockResolvedValue({
      watchlists: [
        {
          id: DEFAULT_WATCHLIST_ID,
          name: 'General',
          isDefault: true,
          itemCount: 1,
          audience,
        },
      ],
    });
    renderPage();

    expect(await screen.findByRole('button', { name: label })).toBeInTheDocument();
  });
});

// ─── Remove ───────────────────────────────────────────────────────────────────

describe('WorkboardPage — remove', () => {
  test('calls removeFromWorkboard with correct itemId', async () => {
    vi.mocked(listWorkboard).mockResolvedValue({ items: [ITEM_A] });
    renderPage();
    await waitFor(() => expect(screen.getByText('AAPL')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Remove AAPL from watchlist/i }));

    await waitFor(() => expect(vi.mocked(removeFromWorkboard)).toHaveBeenCalledWith(ITEM_A.id));
  });

  test('shows error alert when remove API call fails', async () => {
    vi.mocked(listWorkboard).mockResolvedValue({ items: [ITEM_A] });
    vi.mocked(removeFromWorkboard).mockRejectedValue(new Error('server error'));
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('AAPL')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Remove AAPL from watchlist/i }));

    await waitFor(() => expect(screen.getByText(/Failed to remove/i)).toBeInTheDocument());
  });
});

// ─── Drag-to-reorder ─────────────────────────────────────────────────────────

describe('WorkboardPage — reorder', () => {
  test('calls reorderWorkboard with new order after drag-and-drop', async () => {
    vi.mocked(listWorkboard).mockResolvedValue({ items: [ITEM_A, ITEM_B] });
    renderPage();
    await waitFor(() => expect(screen.getByText('AAPL')).toBeInTheDocument());

    const rowA = screen.getByText('AAPL').closest('tr')!;
    const rowB = screen.getByText('MSFT').closest('tr')!;

    fireEvent.dragStart(rowA);
    fireEvent.dragOver(rowB);
    fireEvent.drop(rowB);

    await waitFor(() =>
      expect(vi.mocked(reorderWorkboard)).toHaveBeenCalledWith([ITEM_B.id, ITEM_A.id]),
    );
    expect(await screen.findByText('Watchlist order saved.')).toBeInTheDocument();
  });

  test('reorders items optimistically — MSFT appears before AAPL after drop', async () => {
    vi.mocked(listWorkboard).mockResolvedValue({ items: [ITEM_A, ITEM_B] });
    renderPage();
    await waitFor(() => expect(screen.getByText('AAPL')).toBeInTheDocument());

    const rowA = screen.getByText('AAPL').closest('tr')!;
    const rowB = screen.getByText('MSFT').closest('tr')!;

    fireEvent.dragStart(rowA);
    fireEvent.dragOver(rowB);
    fireEvent.drop(rowB);

    // After optimistic update, MSFT should appear before AAPL in the DOM.
    await waitFor(() => {
      const symbols = screen
        .getAllByRole('link')
        .filter((el) => ['AAPL', 'MSFT'].includes(el.textContent ?? ''))
        .map((el) => el.textContent);
      expect(symbols[0]).toBe('MSFT');
      expect(symbols[1]).toBe('AAPL');
    });
  });

  test('drop on same item does not call reorderWorkboard', async () => {
    vi.mocked(listWorkboard).mockResolvedValue({ items: [ITEM_A, ITEM_B] });
    renderPage();
    await waitFor(() => expect(screen.getByText('AAPL')).toBeInTheDocument());

    const rowA = screen.getByText('AAPL').closest('tr')!;

    fireEvent.dragStart(rowA);
    fireEvent.dragOver(rowA);
    fireEvent.drop(rowA);

    // reorderWorkboard must not be called for a no-op drag.
    await new Promise((r) => setTimeout(r, 50));
    expect(vi.mocked(reorderWorkboard)).not.toHaveBeenCalled();
  });

  test('shows reorder error and reverts when API fails', async () => {
    vi.mocked(listWorkboard).mockResolvedValue({ items: [ITEM_A, ITEM_B] });
    vi.mocked(reorderWorkboard).mockRejectedValue(new Error('server error'));
    renderPage();
    await waitFor(() => expect(screen.getByText('AAPL')).toBeInTheDocument());

    const rowA = screen.getByText('AAPL').closest('tr')!;
    const rowB = screen.getByText('MSFT').closest('tr')!;

    fireEvent.dragStart(rowA);
    fireEvent.dragOver(rowB);
    fireEvent.drop(rowB);

    await waitFor(() => expect(screen.getByText(/Failed to save new order/i)).toBeInTheDocument());
  });
});
