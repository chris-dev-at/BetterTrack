import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { SearchResultItem, SearchResponse } from '@bettertrack/contracts';

// Bypass the 300 ms debounce so tests don't need fake timers.
vi.mock('../hooks/useDebounce', () => ({ useDebounce: (v: unknown) => v }));

vi.mock('../../lib/searchApi');
vi.mock('../../lib/workboardApi');
import * as searchApi from '../../lib/searchApi';
import * as workboardApi from '../../lib/workboardApi';
import { AssetSearchBox } from './AssetSearchBox';

const NVDA: SearchResultItem = {
  id: 'asset-nvda',
  providerId: 'yahoo',
  providerRef: 'NVDA',
  symbol: 'NVDA',
  name: 'NVIDIA Corporation',
  exchange: 'NASDAQ',
  type: 'stock',
  currency: 'USD',
  isCustom: false,
};

const BAYN: SearchResultItem = {
  id: 'asset-bayn',
  providerId: 'yahoo',
  providerRef: 'BAYN.DE',
  symbol: 'BAYN.DE',
  name: 'Bayer AG',
  exchange: 'XETRA',
  type: 'stock',
  currency: 'EUR',
  isCustom: false,
};

function makeSearchResponse(items: SearchResultItem[]): SearchResponse {
  return { results: items };
}

function renderSearchBox(props: Partial<React.ComponentProps<typeof AssetSearchBox>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AssetSearchBox {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AssetSearchBox', () => {
  test('renders the search input', () => {
    renderSearchBox();
    expect(screen.getByRole('searchbox', { name: /search assets/i })).toBeInTheDocument();
  });

  test('shows a hint when the raw query is shorter than min length', async () => {
    const user = userEvent.setup();
    renderSearchBox();

    await user.type(screen.getByRole('searchbox'), 'N');

    expect(screen.getByText(/type at least 2 characters/i)).toBeInTheDocument();
  });

  test('does not call searchAssets when query is below min length', async () => {
    const user = userEvent.setup();
    renderSearchBox();

    await user.type(screen.getByRole('searchbox'), 'N');

    expect(vi.mocked(searchApi.searchAssets)).not.toHaveBeenCalled();
  });

  test('calls searchAssets once query meets the min-length threshold', async () => {
    vi.mocked(searchApi.searchAssets).mockResolvedValue(makeSearchResponse([NVDA]));
    const user = userEvent.setup();
    renderSearchBox();

    await user.type(screen.getByRole('searchbox'), 'NV');

    await waitFor(() =>
      expect(searchApi.searchAssets).toHaveBeenCalledWith('NV', expect.any(AbortSignal)),
    );
  });

  test('renders result rows with symbol, name, exchange, currency, and type badge', async () => {
    vi.mocked(searchApi.searchAssets).mockResolvedValue(makeSearchResponse([NVDA, BAYN]));
    const user = userEvent.setup();
    renderSearchBox();

    await user.type(screen.getByRole('searchbox'), 'NV');

    expect(await screen.findByText('NVDA')).toBeInTheDocument();
    // Name + exchange + currency are in one span; use regex for partial matching.
    expect(screen.getByText(/NVIDIA Corporation/)).toBeInTheDocument();
    expect(screen.getByText(/NASDAQ/)).toBeInTheDocument();
    expect(screen.getByText('BAYN.DE')).toBeInTheDocument();
    expect(screen.getByText(/Bayer AG/)).toBeInTheDocument();
    expect(screen.getAllByText('stock')).toHaveLength(2);
  });

  test('renders all three action buttons on each result', async () => {
    vi.mocked(searchApi.searchAssets).mockResolvedValue(makeSearchResponse([NVDA]));
    const user = userEvent.setup();
    renderSearchBox();

    await user.type(screen.getByRole('searchbox'), 'NV');
    await screen.findByText('NVDA');

    expect(screen.getByRole('button', { name: /workboard/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /conglomerate/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /record a buy/i })).toBeInTheDocument();
  });

  test('→ Workboard calls the API and shows "Watchlisted ✓" on success', async () => {
    vi.mocked(searchApi.searchAssets).mockResolvedValue(makeSearchResponse([NVDA]));
    vi.mocked(workboardApi.addToWorkboard).mockResolvedValue();

    const user = userEvent.setup();
    renderSearchBox();

    await user.type(screen.getByRole('searchbox'), 'NV');
    await screen.findByText('NVDA');
    await user.click(screen.getByRole('button', { name: /add nvda to workboard/i }));

    expect(workboardApi.addToWorkboard).toHaveBeenCalledWith('asset-nvda');
    expect(await screen.findByText(/watchlisted/i)).toBeInTheDocument();
  });

  test('→ Workboard shows retry label on API error', async () => {
    vi.mocked(searchApi.searchAssets).mockResolvedValue(makeSearchResponse([NVDA]));
    vi.mocked(workboardApi.addToWorkboard).mockRejectedValue(new Error('network error'));

    const user = userEvent.setup();
    renderSearchBox();

    await user.type(screen.getByRole('searchbox'), 'NV');
    await screen.findByText('NVDA');
    await user.click(screen.getByRole('button', { name: /add nvda to workboard/i }));

    expect(await screen.findByText(/retry workboard/i)).toBeInTheDocument();
  });

  test('shows skeleton rows while loading (no prior data)', async () => {
    let resolveSearch!: (v: SearchResponse) => void;
    vi.mocked(searchApi.searchAssets).mockReturnValue(
      new Promise<SearchResponse>((r) => (resolveSearch = r)),
    );

    const user = userEvent.setup();
    renderSearchBox();

    await user.type(screen.getByRole('searchbox'), 'NV');

    expect(await screen.findByRole('list', { name: /loading results/i })).toBeInTheDocument();
    resolveSearch(makeSearchResponse([]));
  });

  test('shows empty state when the query returns no results', async () => {
    vi.mocked(searchApi.searchAssets).mockResolvedValue(makeSearchResponse([]));
    const user = userEvent.setup();
    renderSearchBox();

    await user.type(screen.getByRole('searchbox'), 'ZZZZZ');

    expect(await screen.findByText(/no results found/i)).toBeInTheDocument();
  });

  test('shows error state when the API rejects', async () => {
    vi.mocked(searchApi.searchAssets).mockRejectedValue(new Error('server error'));
    const user = userEvent.setup();
    renderSearchBox();

    await user.type(screen.getByRole('searchbox'), 'NV');

    expect(await screen.findByRole('alert')).toHaveTextContent(/search failed/i);
  });

  test('calls onAction after a successful workboard add', async () => {
    vi.mocked(searchApi.searchAssets).mockResolvedValue(makeSearchResponse([NVDA]));
    vi.mocked(workboardApi.addToWorkboard).mockResolvedValue();

    const onAction = vi.fn();
    const user = userEvent.setup();
    renderSearchBox({ onAction });

    await user.type(screen.getByRole('searchbox'), 'NV');
    await screen.findByText('NVDA');
    await user.click(screen.getByRole('button', { name: /add nvda to workboard/i }));

    await waitFor(() => expect(onAction).toHaveBeenCalledOnce());
  });
});
