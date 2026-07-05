import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi, beforeEach } from 'vitest';

vi.mock('../../lib/socialApi', () => ({
  listMyShared: vi.fn(),
}));

vi.mock('../../lib/portfolioApi', () => ({
  updatePortfolio: vi.fn(),
}));

vi.mock('../../lib/conglomerateApi', () => ({
  updateConglomerate: vi.fn(),
}));

vi.mock('../../lib/workboardApi', () => ({
  updateWatchlistSharing: vi.fn(),
}));

import { updateConglomerate } from '../../lib/conglomerateApi';
import { updatePortfolio } from '../../lib/portfolioApi';
import { listMyShared } from '../../lib/socialApi';
import { updateWatchlistSharing } from '../../lib/workboardApi';
import { MySharedItemsPage } from './MySharedItemsPage';

/** No watchlist sharing, no items — the default My-Shared watchlist state. */
const WATCHLIST_OFF = { visibility: 'private', itemCount: 0 } as const;

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MySharedItemsPage />
    </QueryClientProvider>,
  );
}

const PORTFOLIO_ID = '00000000-0000-0000-0000-000000000001';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MySharedItemsPage', () => {
  test('shows an empty state when nothing is shared', async () => {
    vi.mocked(listMyShared).mockResolvedValue({
      portfolios: [],
      conglomerates: [],
      watchlist: WATCHLIST_OFF,
    });
    renderPage();

    await waitFor(() =>
      expect(screen.getByText("You're not sharing anything")).toBeInTheDocument(),
    );
  });

  test('lists a shared portfolio and toggles it off, removing it from the list', async () => {
    vi.mocked(listMyShared)
      .mockResolvedValueOnce({
        portfolios: [
          {
            id: PORTFOLIO_ID,
            name: 'Main',
            visibility: 'friends',
            sortOrder: 0,
            isDefault: true,
            defaultPayFromCash: false,
            archivedAt: null,
          },
        ],
        conglomerates: [],
        watchlist: WATCHLIST_OFF,
      })
      .mockResolvedValueOnce({ portfolios: [], conglomerates: [], watchlist: WATCHLIST_OFF });
    vi.mocked(updatePortfolio).mockResolvedValue({
      id: PORTFOLIO_ID,
      name: 'Main',
      visibility: 'private',
      sortOrder: 0,
      isDefault: true,
      defaultPayFromCash: false,
      archivedAt: null,
    });

    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(screen.getByText('Main')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Stop sharing' }));

    expect(updatePortfolio).toHaveBeenCalledWith(PORTFOLIO_ID, { visibility: 'private' });
    await waitFor(() =>
      expect(screen.getByText("You're not sharing anything")).toBeInTheDocument(),
    );
  });

  test('lists a shared conglomerate and toggles it off via updateConglomerate', async () => {
    const CID = '00000000-0000-0000-0000-0000000000c1';
    vi.mocked(listMyShared)
      .mockResolvedValueOnce({
        portfolios: [],
        conglomerates: [
          {
            id: CID,
            name: 'Tech basket',
            description: null,
            status: 'active',
            visibility: 'friends',
            positionCount: 2,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        watchlist: WATCHLIST_OFF,
      })
      .mockResolvedValueOnce({ portfolios: [], conglomerates: [], watchlist: WATCHLIST_OFF });
    vi.mocked(updateConglomerate).mockResolvedValue({
      id: CID,
      name: 'Tech basket',
      description: null,
      status: 'active',
      visibility: 'private',
      positionCount: 2,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      positions: [],
    });

    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(screen.getByText('Tech basket')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Stop sharing' }));

    expect(updateConglomerate).toHaveBeenCalledWith(CID, { visibility: 'private' });
    await waitFor(() =>
      expect(screen.getByText("You're not sharing anything")).toBeInTheDocument(),
    );
  });

  test('watchlist sharing toggle-off is wired to updateWatchlistSharing', async () => {
    vi.mocked(listMyShared)
      .mockResolvedValueOnce({
        portfolios: [],
        conglomerates: [],
        watchlist: { visibility: 'friends', itemCount: 3 },
      })
      .mockResolvedValueOnce({ portfolios: [], conglomerates: [], watchlist: WATCHLIST_OFF });
    vi.mocked(updateWatchlistSharing).mockResolvedValue(WATCHLIST_OFF);

    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(screen.getByText(/My watchlist/i)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Stop sharing' }));

    expect(updateWatchlistSharing).toHaveBeenCalledWith('private');
  });

  test('shows an error affordance when the fetch fails', async () => {
    vi.mocked(listMyShared).mockRejectedValue(new Error('boom'));
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/Could not load your shared items/i)).toBeInTheDocument(),
    );
  });
});
