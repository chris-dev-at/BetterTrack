import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

function makeSearchResponse(items: SearchResultItem[], enriching?: boolean): SearchResponse {
  return enriching === undefined ? { results: items } : { results: items, enriching };
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

  describe('enriching (§6.2 background provider fetch)', () => {
    test('shows a subtle inline message and polls again while enriching:true', async () => {
      vi.mocked(searchApi.searchAssets)
        .mockResolvedValueOnce(makeSearchResponse([], true))
        .mockResolvedValueOnce(makeSearchResponse([BAYN], false));

      const user = userEvent.setup();
      renderSearchBox();

      // Two chars only: with `useDebounce` bypassed in tests, a longer string
      // would fire one fetch per enabled intermediate query state.
      await user.type(screen.getByRole('searchbox'), 'NV');

      expect(await screen.findByText(/searching the market/i)).toBeInTheDocument();

      await waitFor(() => expect(searchApi.searchAssets).toHaveBeenCalledTimes(2), {
        timeout: 3000,
      });
      expect(await screen.findByText('BAYN.DE')).toBeInTheDocument();
      expect(screen.queryByText(/searching the market/i)).not.toBeInTheDocument();
    });

    test('enriching:false responses never show the inline message or trigger a second fetch', async () => {
      vi.mocked(searchApi.searchAssets).mockResolvedValue(makeSearchResponse([NVDA], false));
      const user = userEvent.setup();
      renderSearchBox();

      await user.type(screen.getByRole('searchbox'), 'NV');
      await screen.findByText('NVDA');

      expect(screen.queryByText(/searching the market/i)).not.toBeInTheDocument();
      await new Promise((r) => setTimeout(r, 50));
      expect(searchApi.searchAssets).toHaveBeenCalledTimes(1);
    });

    test('selecting an already-visible result still works while enriching is in progress', async () => {
      vi.mocked(searchApi.searchAssets).mockResolvedValue(makeSearchResponse([NVDA], true));
      vi.mocked(workboardApi.addToWorkboard).mockResolvedValue();

      const user = userEvent.setup();
      renderSearchBox();

      await user.type(screen.getByRole('searchbox'), 'NV');
      await screen.findByText('NVDA');
      expect(await screen.findByText(/searching the market/i)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /add nvda to workboard/i }));
      expect(await screen.findByText(/watchlisted/i)).toBeInTheDocument();
    });

    test('stops polling once the ~10s enrichment window elapses', async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(searchApi.searchAssets).mockResolvedValue(makeSearchResponse([], true));
        renderSearchBox();

        // Fire the DOM event directly: userEvent's own internal scheduling
        // doesn't mix well with fake timers.
        fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'NV' } });
        await vi.advanceTimersByTimeAsync(0);
        expect(screen.getByText(/searching the market/i)).toBeInTheDocument();

        await vi.advanceTimersByTimeAsync(11_000);
        expect(screen.queryByText(/searching the market/i)).not.toBeInTheDocument();

        const callsAtCutoff = vi.mocked(searchApi.searchAssets).mock.calls.length;
        await vi.advanceTimersByTimeAsync(5_000);
        expect(vi.mocked(searchApi.searchAssets).mock.calls.length).toBe(callsAtCutoff);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
