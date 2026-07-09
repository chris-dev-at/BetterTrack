import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

// ─── API mocks ────────────────────────────────────────────────────────────────

vi.mock('../../lib/workboardApi', () => ({
  WORKBOARD_QUERY_KEY: ['workboard'],
  WATCHLIST_SHARING_QUERY_KEY: ['workboard', 'sharing'],
  listWorkboard: vi.fn(),
  removeFromWorkboard: vi.fn(),
  reorderWorkboard: vi.fn(),
  getWatchlistSharing: vi.fn(),
  updateWatchlistSharing: vi.fn(),
}));

vi.mock('../../lib/assetApi', () => ({
  getAssetQuote: vi.fn(),
  getAssetHistory: vi.fn(),
}));

import {
  getWatchlistSharing,
  listWorkboard,
  removeFromWorkboard,
  reorderWorkboard,
  updateWatchlistSharing,
} from '../../lib/workboardApi';
import { getAssetHistory, getAssetQuote } from '../../lib/assetApi';
import { WorkboardPage } from './WorkboardPage';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ITEM_A = {
  id: '00000000-0000-0000-0000-000000000001',
  watchlistId: 'c0000000-0000-0000-0000-0000000000c1',
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

const BASE_HISTORY = {
  range: '1M' as const,
  interval: '1d' as const,
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

function renderPage() {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter>
        <WorkboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAssetQuote).mockResolvedValue(BASE_QUOTE);
  vi.mocked(getAssetHistory).mockResolvedValue(BASE_HISTORY);
  vi.mocked(removeFromWorkboard).mockResolvedValue(undefined);
  vi.mocked(reorderWorkboard).mockResolvedValue(undefined);
  vi.mocked(getWatchlistSharing).mockResolvedValue({ visibility: 'private' });
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
  test('shows asset symbols and names for all items', async () => {
    vi.mocked(listWorkboard).mockResolvedValue({ items: [ITEM_A, ITEM_B] });
    renderPage();
    await waitFor(() => expect(screen.getByText('AAPL')).toBeInTheDocument());
    expect(screen.getByText('Apple Inc.')).toBeInTheDocument();
    expect(screen.getByText('MSFT')).toBeInTheDocument();
    expect(screen.getByText('Microsoft Corporation')).toBeInTheDocument();
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
  test('renders Alerts zone with placeholder', async () => {
    vi.mocked(listWorkboard).mockResolvedValue({ items: [] });
    renderPage();
    await waitFor(() => expect(screen.getByText('Alerts')).toBeInTheDocument());
    expect(screen.getByText(/Alerts panel coming soon/i)).toBeInTheDocument();
  });

  test('renders My Conglomerates zone with placeholder', async () => {
    vi.mocked(listWorkboard).mockResolvedValue({ items: [] });
    renderPage();
    await waitFor(() => expect(screen.getByText('My Conglomerates')).toBeInTheDocument());
    expect(screen.getByText(/Conglomerates coming soon/i)).toBeInTheDocument();
  });

  test('placeholder zones do not throw when watchlist has items', async () => {
    vi.mocked(listWorkboard).mockResolvedValue({ items: [ITEM_A] });
    renderPage();
    await waitFor(() => expect(screen.getByText('AAPL')).toBeInTheDocument());
    // Use role+level to target the <h2> headings, not the "Alerts" <th> column header.
    expect(screen.getByRole('heading', { name: 'Alerts', level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'My Conglomerates', level: 2 })).toBeInTheDocument();
  });
});

// ─── Watchlist sharing ────────────────────────────────────────────────────────

describe('WorkboardPage — watchlist sharing', () => {
  test('shows an inline error when toggling sharing fails', async () => {
    vi.mocked(listWorkboard).mockResolvedValue({ items: [ITEM_A] });
    vi.mocked(updateWatchlistSharing).mockRejectedValue(new Error('server error'));
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('AAPL')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Share with friends' }));

    await waitFor(() => expect(screen.getByText(/Could not update sharing/i)).toBeInTheDocument());
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
