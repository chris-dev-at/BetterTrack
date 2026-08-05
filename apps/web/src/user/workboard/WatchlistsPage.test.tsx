import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../lib/workboardApi', () => ({
  WATCHLISTS_QUERY_KEY: ['workboard', 'watchlists'],
  WORKBOARD_QUERY_KEY: ['workboard'],
  addToWorkboard: vi.fn(),
  createWatchlist: vi.fn(),
  deleteWatchlist: vi.fn(),
  listWatchlists: vi.fn(),
  listWorkboard: vi.fn(),
  removeFromWorkboard: vi.fn(),
  renameWatchlist: vi.fn(),
}));
vi.mock('../components/AudiencePicker', () => ({ AudiencePicker: () => null }));
vi.mock('../components/AssetSearchBox', () => ({
  AssetSearchBox: ({ onSelect }: { onSelect?: (item: { id: string }) => void }) => (
    <button
      type="button"
      onClick={() => onSelect?.({ id: '00000000-0000-0000-0000-000000000004' })}
    >
      Choose Apple
    </button>
  ),
}));

import {
  addToWorkboard,
  createWatchlist,
  listWatchlists,
  listWorkboard,
  removeFromWorkboard,
} from '../../lib/workboardApi';
import { setViewportWidth } from '../../test/viewport';
import { WatchlistDetailPage } from './WatchlistDetailPage';
import { WatchlistsPage } from './WatchlistsPage';

const WATCHLIST_ID = '00000000-0000-0000-0000-000000000001';
const ITEM_ID = '00000000-0000-0000-0000-000000000002';
const ASSET_ID = '00000000-0000-0000-0000-000000000003';

function renderPage(initialPath = '/assets/watchlists') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/assets/watchlists" element={<WatchlistsPage />} />
          <Route path="/assets/watchlists/:watchlistId" element={<WatchlistDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listWatchlists).mockResolvedValue({ watchlists: [] });
  vi.mocked(listWorkboard).mockResolvedValue({ items: [] });
  vi.mocked(addToWorkboard).mockResolvedValue(undefined);
  vi.mocked(removeFromWorkboard).mockResolvedValue(undefined);
});

describe('WatchlistsPage recovery', () => {
  test('retries a failed list read in place', async () => {
    vi.mocked(listWatchlists)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ watchlists: [] });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('No watchlists yet.')).toBeInTheDocument();
    expect(listWatchlists).toHaveBeenCalledTimes(2);
  });

  test('at 390 px creates a named watchlist without a horizontal action row', async () => {
    setViewportWidth(390);
    vi.mocked(createWatchlist).mockResolvedValue({
      id: 'wl-tech',
      name: 'Tech',
      isDefault: false,
      itemCount: 0,
      audience: 'private',
    });
    const user = userEvent.setup();
    const { container } = renderPage();

    await screen.findByText('No watchlists yet.');
    await user.type(screen.getByLabelText('New watchlist'), 'Tech');
    await user.click(screen.getByRole('button', { name: 'New watchlist' }));

    expect(createWatchlist).toHaveBeenCalledWith('Tech');
    expect(container.querySelector('.bt-watchlists-page')).toBeInTheDocument();
  });

  test('honors the global create intent by focusing the inline create flow', async () => {
    renderPage('/assets/watchlists?create=1');

    const name = await screen.findByLabelText('New watchlist');
    await waitFor(() => expect(name).toHaveFocus());
  });

  test('opens a list and renders its manageable assets at 390 px', async () => {
    setViewportWidth(390);
    vi.mocked(listWatchlists).mockResolvedValue({
      watchlists: [
        {
          id: WATCHLIST_ID,
          name: 'Semiconductors',
          isDefault: false,
          itemCount: 1,
          audience: 'private',
        },
      ],
    });
    vi.mocked(listWorkboard).mockResolvedValue({
      items: [
        {
          id: ITEM_ID,
          watchlistId: WATCHLIST_ID,
          assetId: ASSET_ID,
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
    });
    const user = userEvent.setup();
    const { container } = renderPage();

    await user.click(await screen.findByRole('link', { name: 'Semiconductors' }));

    expect(await screen.findByRole('heading', { name: 'Semiconductors' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'NVDA · NVIDIA Corporation' })).toBeInTheDocument();
    expect(listWorkboard).toHaveBeenCalledWith(WATCHLIST_ID, expect.any(AbortSignal));
    expect(container.querySelector('.bt-phone-surface')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Choose Apple' }));
    expect(addToWorkboard).toHaveBeenCalledWith(
      '00000000-0000-0000-0000-000000000004',
      WATCHLIST_ID,
    );

    await user.click(screen.getByRole('button', { name: 'Remove NVDA from watchlist' }));
    expect(removeFromWorkboard).toHaveBeenCalledWith(ITEM_ID);
  });

  test('explains the disabled actions on the default list', async () => {
    vi.mocked(listWatchlists).mockResolvedValue({
      watchlists: [
        {
          id: WATCHLIST_ID,
          name: 'General',
          isDefault: true,
          itemCount: 0,
          audience: 'private',
        },
      ],
    });
    renderPage();

    expect(
      await screen.findByText("The default watchlist can't be renamed or deleted."),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
  });
});
