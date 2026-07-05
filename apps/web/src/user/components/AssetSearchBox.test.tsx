import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  ConglomerateDetail,
  ConglomerateListResponse,
  PortfolioListResponse,
  SearchResultItem,
  SearchResponse,
  WorkboardListResponse,
} from '@bettertrack/contracts';

// Bypass the 300 ms debounce so tests don't need fake timers.
vi.mock('../hooks/useDebounce', () => ({ useDebounce: (v: unknown) => v }));

vi.mock('../../lib/searchApi');
vi.mock('../../lib/workboardApi');
vi.mock('../../lib/conglomerateApi');
vi.mock('../../lib/portfolioApi');
vi.mock('../../lib/assetApi');
import { ApiError } from '../../lib/apiClient';
import * as assetApi from '../../lib/assetApi';
import * as conglomerateApi from '../../lib/conglomerateApi';
import * as portfolioApi from '../../lib/portfolioApi';
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

function emptyWorkboard(): WorkboardListResponse {
  return { items: [] };
}

function workboardWith(assetId: string): WorkboardListResponse {
  return {
    items: [
      {
        id: 'item-1',
        assetId,
        sortOrder: 0,
        note: null,
        asset: {
          symbol: 'NVDA',
          name: 'NVIDIA Corporation',
          exchange: 'NASDAQ',
          currency: 'USD',
          type: 'stock',
        },
      },
    ],
  };
}

function onePortfolio(): PortfolioListResponse {
  return {
    portfolios: [
      { id: 'portfolio-1', name: 'Main', visibility: 'private', sortOrder: 0, isDefault: true },
    ],
  };
}

function conglomerateList(): ConglomerateListResponse {
  return {
    conglomerates: [
      {
        id: 'cong-1',
        name: 'World Basket',
        description: null,
        status: 'draft',
        positionCount: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  };
}

function emptyConglomerateDetail(id: string, name: string): ConglomerateDetail {
  return {
    id,
    name,
    description: null,
    status: 'draft',
    positionCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    positions: [],
  };
}

/** A non-empty conglomerate: SPY 70 / BND 30, mirroring a live 70/30 basket. */
function twoPositionConglomerateDetail(id: string, name: string): ConglomerateDetail {
  return {
    id,
    name,
    description: null,
    status: 'active',
    positionCount: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    positions: [
      {
        assetId: 'asset-spy',
        weightPct: 70,
        sortOrder: 0,
        asset: { symbol: 'SPY', name: 'SPDR S&P 500 ETF', currency: 'USD', type: 'etf' },
      },
      {
        assetId: 'asset-bnd',
        weightPct: 30,
        sortOrder: 1,
        asset: { symbol: 'BND', name: 'Vanguard Total Bond ETF', currency: 'USD', type: 'etf' },
      },
    ],
  };
}

function renderSearchBox(props: Partial<React.ComponentProps<typeof AssetSearchBox>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<AssetSearchBox {...props} />} />
          <Route path="/assets/:id" element={<div>Asset detail page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(workboardApi.listWorkboard).mockResolvedValue(emptyWorkboard());
  vi.mocked(assetApi.getAssetDailyCloses).mockResolvedValue({
    asOf: null,
    stale: false,
    points: [],
  });
});

describe('AssetSearchBox', () => {
  test('renders the search input', () => {
    renderSearchBox();
    expect(screen.getByRole('searchbox', { name: /search assets/i })).toBeInTheDocument();
  });

  test('calls searchAssets once a single character is typed (owner override, §13.2)', async () => {
    vi.mocked(searchApi.searchAssets).mockResolvedValue(makeSearchResponse([NVDA]));
    const user = userEvent.setup();
    renderSearchBox();

    await user.type(screen.getByRole('searchbox'), 'V');

    await waitFor(() =>
      expect(searchApi.searchAssets).toHaveBeenCalledWith('V', expect.any(AbortSignal)),
    );
  });

  test('does not call searchAssets for an empty query', () => {
    renderSearchBox();
    expect(vi.mocked(searchApi.searchAssets)).not.toHaveBeenCalled();
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

  test('renders every direct action on each result', async () => {
    vi.mocked(searchApi.searchAssets).mockResolvedValue(makeSearchResponse([NVDA]));
    const user = userEvent.setup();
    renderSearchBox();

    await user.type(screen.getByRole('searchbox'), 'NV');
    await screen.findByText('NVDA');

    expect(screen.getByRole('button', { name: /add nvda to watchlist/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /conglomerate/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /record a buy/i })).toBeInTheDocument();
  });

  test('clicking a result row navigates to its asset detail page and closes the search', async () => {
    vi.mocked(searchApi.searchAssets).mockResolvedValue(makeSearchResponse([NVDA]));
    const onAction = vi.fn();
    const user = userEvent.setup();
    renderSearchBox({ onAction });

    await user.type(screen.getByRole('searchbox'), 'NV');
    await screen.findByText('NVDA');
    await user.click(screen.getByRole('button', { name: /open nvda/i }));

    expect(await screen.findByText('Asset detail page')).toBeInTheDocument();
    expect(onAction).toHaveBeenCalledOnce();
  });

  describe('watchlist icon (state-aware, §13.2)', () => {
    test('shows the already-added state from existing membership, with no click required', async () => {
      vi.mocked(workboardApi.listWorkboard).mockResolvedValue(workboardWith(NVDA.id));
      vi.mocked(searchApi.searchAssets).mockResolvedValue(makeSearchResponse([NVDA]));
      const user = userEvent.setup();
      renderSearchBox();

      await user.type(screen.getByRole('searchbox'), 'NV');
      await screen.findByText('NVDA');

      expect(screen.getByRole('button', { name: /nvda is on your watchlist/i })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });

    test('clicking adds to the watchlist and flips to the added state', async () => {
      vi.mocked(searchApi.searchAssets).mockResolvedValue(makeSearchResponse([NVDA]));
      vi.mocked(workboardApi.addToWorkboard).mockResolvedValue();
      const user = userEvent.setup();
      renderSearchBox();

      await user.type(screen.getByRole('searchbox'), 'NV');
      await screen.findByText('NVDA');
      await user.click(screen.getByRole('button', { name: /add nvda to watchlist/i }));

      expect(workboardApi.addToWorkboard).toHaveBeenCalledWith('asset-nvda');
      expect(
        await screen.findByRole('button', { name: /nvda is on your watchlist/i }),
      ).toHaveAttribute('aria-pressed', 'true');
    });

    test('does not close the search after adding to the watchlist', async () => {
      vi.mocked(searchApi.searchAssets).mockResolvedValue(makeSearchResponse([NVDA]));
      vi.mocked(workboardApi.addToWorkboard).mockResolvedValue();
      const onAction = vi.fn();
      const user = userEvent.setup();
      renderSearchBox({ onAction });

      await user.type(screen.getByRole('searchbox'), 'NV');
      await screen.findByText('NVDA');
      await user.click(screen.getByRole('button', { name: /add nvda to watchlist/i }));

      await screen.findByRole('button', { name: /nvda is on your watchlist/i });
      expect(onAction).not.toHaveBeenCalled();
    });

    test('a second click on an already-added asset never surfaces the ALREADY_WATCHING error', async () => {
      vi.mocked(searchApi.searchAssets).mockResolvedValue(makeSearchResponse([NVDA]));
      vi.mocked(workboardApi.addToWorkboard).mockRejectedValue(
        new ApiError(409, 'ALREADY_WATCHING', 'Asset is already on your workboard.'),
      );
      const user = userEvent.setup();
      renderSearchBox();

      await user.type(screen.getByRole('searchbox'), 'NV');
      await screen.findByText('NVDA');
      await user.click(screen.getByRole('button', { name: /add nvda to watchlist/i }));

      expect(
        await screen.findByRole('button', { name: /nvda is on your watchlist/i }),
      ).toHaveAttribute('aria-pressed', 'true');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    test('shows a retry affordance on a genuine failure', async () => {
      vi.mocked(searchApi.searchAssets).mockResolvedValue(makeSearchResponse([NVDA]));
      vi.mocked(workboardApi.addToWorkboard).mockRejectedValue(new Error('network error'));
      const user = userEvent.setup();
      renderSearchBox();

      await user.type(screen.getByRole('searchbox'), 'NV');
      await screen.findByText('NVDA');
      await user.click(screen.getByRole('button', { name: /add nvda to watchlist/i }));

      expect(await screen.findByRole('button', { name: /retry adding nvda/i })).toBeInTheDocument();
    });

    test('exposes a stub multiple-watchlists affordance', async () => {
      vi.mocked(searchApi.searchAssets).mockResolvedValue(makeSearchResponse([NVDA]));
      const user = userEvent.setup();
      renderSearchBox();

      await user.type(screen.getByRole('searchbox'), 'NV');
      await screen.findByText('NVDA');
      await user.click(screen.getByRole('button', { name: /choose a watchlist for nvda/i }));

      expect(await screen.findByText('General')).toBeInTheDocument();
      expect(screen.getByText(/more lists coming soon/i)).toBeInTheDocument();
    });
  });

  describe('→ Portfolio (inline Buy/Sell dialog, §13.2)', () => {
    test('opens the dialog pre-targeted to the searched asset without navigating away', async () => {
      vi.mocked(searchApi.searchAssets).mockResolvedValue(makeSearchResponse([NVDA]));
      vi.mocked(portfolioApi.listPortfolios).mockResolvedValue(onePortfolio());
      const user = userEvent.setup();
      renderSearchBox();

      await user.type(screen.getByRole('searchbox'), 'NV');
      await screen.findByText('NVDA');
      await user.click(screen.getByRole('button', { name: /record a buy for nvda/i }));

      expect(
        await screen.findByRole('dialog', { name: /record transaction/i }),
      ).toBeInTheDocument();
      // The asset is locked, not re-searched: no second search box appears.
      expect(screen.getAllByRole('searchbox')).toHaveLength(1);
    });
  });

  describe('→ Conglomerate (picker, §13.2)', () => {
    test('opens a picker listing the caller’s conglomerates', async () => {
      vi.mocked(searchApi.searchAssets).mockResolvedValue(makeSearchResponse([NVDA]));
      vi.mocked(conglomerateApi.listConglomerates).mockResolvedValue(conglomerateList());
      const user = userEvent.setup();
      renderSearchBox();

      await user.type(screen.getByRole('searchbox'), 'NV');
      await screen.findByText('NVDA');
      await user.click(screen.getByRole('button', { name: /add nvda to a conglomerate/i }));

      expect(await screen.findByRole('menuitem', { name: 'World Basket' })).toBeInTheDocument();
    });

    test('picking a conglomerate adds the asset and confirms in place', async () => {
      vi.mocked(searchApi.searchAssets).mockResolvedValue(makeSearchResponse([NVDA]));
      vi.mocked(conglomerateApi.listConglomerates).mockResolvedValue(conglomerateList());
      vi.mocked(conglomerateApi.getConglomerate).mockResolvedValue(
        emptyConglomerateDetail('cong-1', 'World Basket'),
      );
      vi.mocked(conglomerateApi.replaceConglomeratePositions).mockResolvedValue(
        emptyConglomerateDetail('cong-1', 'World Basket'),
      );
      const user = userEvent.setup();
      renderSearchBox();

      await user.type(screen.getByRole('searchbox'), 'NV');
      await screen.findByText('NVDA');
      await user.click(screen.getByRole('button', { name: /add nvda to a conglomerate/i }));
      await user.click(await screen.findByRole('menuitem', { name: 'World Basket' }));

      await waitFor(() =>
        expect(conglomerateApi.replaceConglomeratePositions).toHaveBeenCalledWith('cong-1', [
          { assetId: 'asset-nvda', weightPct: 100 },
        ]),
      );
      expect(await screen.findByText(/added to world basket/i)).toBeInTheDocument();
    });

    test('adding to a non-empty conglomerate scales existing weights down proportionally instead of equalizing them', async () => {
      vi.mocked(searchApi.searchAssets).mockResolvedValue(makeSearchResponse([NVDA]));
      vi.mocked(conglomerateApi.listConglomerates).mockResolvedValue(conglomerateList());
      vi.mocked(conglomerateApi.getConglomerate).mockResolvedValue(
        twoPositionConglomerateDetail('cong-1', 'World Basket'),
      );
      vi.mocked(conglomerateApi.replaceConglomeratePositions).mockResolvedValue(
        twoPositionConglomerateDetail('cong-1', 'World Basket'),
      );
      const user = userEvent.setup();
      renderSearchBox();

      await user.type(screen.getByRole('searchbox'), 'NV');
      await screen.findByText('NVDA');
      await user.click(screen.getByRole('button', { name: /add nvda to a conglomerate/i }));
      await user.click(await screen.findByRole('menuitem', { name: 'World Basket' }));

      // The existing SPY 70 / BND 30 ratio (70:30) must survive the resize —
      // never flattened to an equal three-way split.
      await waitFor(() =>
        expect(conglomerateApi.replaceConglomeratePositions).toHaveBeenCalledWith('cong-1', [
          { assetId: 'asset-spy', weightPct: 46.667 },
          { assetId: 'asset-bnd', weightPct: 20 },
          { assetId: 'asset-nvda', weightPct: 33.333 },
        ]),
      );
    });
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

  describe('enriching (§6.2 background provider fetch)', () => {
    test('shows a subtle inline message and polls again while enriching:true', async () => {
      vi.mocked(searchApi.searchAssets)
        .mockResolvedValueOnce(makeSearchResponse([], true))
        .mockResolvedValueOnce(makeSearchResponse([BAYN], false));

      const user = userEvent.setup();
      renderSearchBox();

      // One char only: with `useDebounce` bypassed in tests and MIN_CHARS = 1,
      // a longer string would fire one fetch per enabled intermediate query state.
      await user.type(screen.getByRole('searchbox'), 'N');

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

      await user.type(screen.getByRole('searchbox'), 'N');
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

      await user.click(screen.getByRole('button', { name: /add nvda to watchlist/i }));
      expect(
        await screen.findByRole('button', { name: /nvda is on your watchlist/i }),
      ).toHaveAttribute('aria-pressed', 'true');
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
