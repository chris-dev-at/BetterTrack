import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type { AssetQuotesResponse, WatchlistSummary, WorkboardItem } from '@bettertrack/contracts';

vi.mock('../../../lib/assetApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/assetApi')>()),
  getAssetQuotes: vi.fn(),
}));
vi.mock('../../../lib/workboardApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/workboardApi')>()),
  listWatchlists: vi.fn(),
  listWorkboard: vi.fn(),
}));

import {
  getAssetQuotes,
  matchesWorkboardQuotesForAsset,
  workboardQuotesQueryKey,
} from '../../../lib/assetApi';
import { listWatchlists, listWorkboard } from '../../../lib/workboardApi';

import { WatchlistWidget } from './WatchlistWidget';
import type { WidgetProps } from './types';

const assetId = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

const CORE_LIST: WatchlistSummary = {
  id: assetId(100),
  name: 'Core',
  isDefault: true,
  itemCount: 9,
  audience: 'private',
};

const SPEC_LIST: WatchlistSummary = {
  id: assetId(101),
  name: 'Speculative',
  isDefault: false,
  itemCount: 2,
  audience: 'private',
};

function item(index: number, watchlistId = CORE_LIST.id): WorkboardItem {
  return {
    id: assetId(1_000 + index),
    watchlistId,
    assetId: assetId(index),
    sortOrder: index,
    note: null,
    asset: {
      symbol: `SYM${index}`,
      name: `Asset ${index}`,
      exchange: 'XETRA',
      currency: 'EUR',
      type: 'stock',
    },
  };
}

function quote(asset: string): AssetQuotesResponse['quotes'][number] {
  return {
    assetId: asset,
    quote: {
      price: 190.5,
      currency: 'USD',
      prevClose: 188.15,
      dayChangePct: 1.25,
      asOf: '2026-08-13T12:00:00.000Z',
    },
    stale: false,
    asOf: '2026-08-13T12:00:00.000Z',
  };
}

const BASE_PROPS: Omit<WidgetProps, 'settings' | 'size'> = {
  onSettingsChange: vi.fn(),
  portfolios: [],
  scopedPortfolios: [],
  scopedPortfolio: null,
  portfoliosLoading: false,
};

function renderWidget({
  settings = {},
  size = 'm',
}: {
  settings?: WidgetProps['settings'];
  size?: WidgetProps['size'];
} = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const renderTree = (nextSettings: WidgetProps['settings'], nextSize: WidgetProps['size']) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <WatchlistWidget {...BASE_PROPS} settings={nextSettings} size={nextSize} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(renderTree(settings, size));

  return {
    client,
    ...view,
    rerenderWidget(next: { settings: WidgetProps['settings']; size: WidgetProps['size'] }) {
      view.rerender(renderTree(next.settings, next.size));
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listWatchlists).mockResolvedValue({ watchlists: [CORE_LIST, SPEC_LIST] });
  vi.mocked(listWorkboard).mockResolvedValue({ items: [] });
  vi.mocked(getAssetQuotes).mockImplementation(async (ids) => ({
    quotes: ids.map(quote),
    failed: [],
  }));
});

test('batches only rendered rows under the realtime-aware Workboard key', async () => {
  const coreItems = Array.from({ length: 9 }, (_, index) => item(index + 1));
  const specItems = [item(20, SPEC_LIST.id), item(21, SPEC_LIST.id)];
  vi.mocked(listWorkboard).mockResolvedValue({ items: [...coreItems, ...specItems] });

  const { client, rerenderWidget } = renderWidget();
  const mediumIds = coreItems.slice(0, 8).map((entry) => entry.assetId);

  await waitFor(() => expect(getAssetQuotes).toHaveBeenCalledTimes(1));
  expect(vi.mocked(getAssetQuotes).mock.calls[0]?.[0]).toEqual(mediumIds);

  const query = client.getQueryCache().find({
    queryKey: workboardQuotesQueryKey(mediumIds),
    exact: true,
  });
  expect(query).toBeDefined();
  if (!query) throw new Error('The rendered quote batch query was not cached.');
  // QueryCache types intentionally omit observer-only options, though the
  // cached query retains the options its observer supplied.
  const quoteOptions = query.options as typeof query.options & {
    staleTime?: number;
    refetchInterval?: number | false;
  };
  expect(quoteOptions.staleTime).toBe(60_000);
  expect(quoteOptions.refetchInterval).toBeFalsy();
  expect(matchesWorkboardQuotesForAsset(query.queryKey, mediumIds[0]!)).toBe(true);
  expect(matchesWorkboardQuotesForAsset(query.queryKey, specItems[0]!.assetId)).toBe(false);

  rerenderWidget({ settings: { watchlistId: SPEC_LIST.id }, size: 'm' });
  await waitFor(() => expect(getAssetQuotes).toHaveBeenCalledTimes(2));
  expect(vi.mocked(getAssetQuotes).mock.calls[1]?.[0]).toEqual(
    specItems.map((entry) => entry.assetId),
  );

  rerenderWidget({ settings: {}, size: 's' });
  await waitFor(() => expect(getAssetQuotes).toHaveBeenCalledTimes(3));
  expect(vi.mocked(getAssetQuotes).mock.calls[2]?.[0]).toEqual(
    coreItems.slice(0, 5).map((entry) => entry.assetId),
  );
});

test('keeps a failed batch row on the existing quote skeleton', async () => {
  const priced = item(1);
  const failed = item(2);
  vi.mocked(listWorkboard).mockResolvedValue({ items: [priced, failed] });
  vi.mocked(getAssetQuotes).mockResolvedValue({
    quotes: [quote(priced.assetId)],
    failed: [failed.assetId],
  });

  renderWidget();

  const pricedRow = (await screen.findByRole('link', { name: priced.asset.symbol })).closest('li');
  await waitFor(() => expect(pricedRow?.querySelector('.bt-skeleton')).toBeNull());

  const failedRow = screen.getByRole('link', { name: failed.asset.symbol }).closest('li');
  expect(failedRow?.querySelector('.bt-skeleton')).not.toBeNull();
});
