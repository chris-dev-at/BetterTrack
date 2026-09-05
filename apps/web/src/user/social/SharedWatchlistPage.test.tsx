import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { SharedWatchlistDetailResponse } from '@bettertrack/contracts';

vi.mock('../../lib/socialApi', () => ({
  getSharedWatchlist: vi.fn(),
}));
vi.mock('./CommentThread', () => ({ CommentThread: () => null }));
vi.mock('./ItemFollowButton', () => ({ ItemFollowButton: () => null }));

import { ApiError } from '../../lib/apiClient';
import { getSharedWatchlist } from '../../lib/socialApi';
import { defaultProfileIconIdFor } from '../components/profileIcons';
import { SharedWatchlistPage } from './SharedWatchlistPage';

const WATCHLIST_ID = '00000000-0000-0000-0000-000000000001';
const DETAIL: SharedWatchlistDetailResponse = {
  watchlistId: WATCHLIST_ID,
  name: 'Long term',
  owner: {
    id: '00000000-0000-0000-0000-000000000002',
    username: 'ada',
    profileIcon: null,
  },
  items: [],
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/people/shared/watchlists/${WATCHLIST_ID}`]}>
        <Routes>
          <Route path="/people/shared/watchlists/:watchlistId" element={<SharedWatchlistPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...rendered, queryClient };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSharedWatchlist).mockResolvedValue(DETAIL);
});

describe('SharedWatchlistPage recovery and privacy states', () => {
  test('retries a recoverable outage in place', async () => {
    vi.mocked(getSharedWatchlist)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(DETAIL);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('ada’s Long term')).toBeInTheDocument();
    expect(getSharedWatchlist).toHaveBeenCalledTimes(2);
  });

  test('replaces stale shared data after a confirmed audience rejection', async () => {
    vi.mocked(getSharedWatchlist)
      .mockResolvedValueOnce(DETAIL)
      .mockRejectedValueOnce(new ApiError(404, 'NOT_FOUND', 'not found'));
    const { queryClient } = renderPage();

    expect(await screen.findByText('ada’s Long term')).toBeInTheDocument();
    await act(async () => {
      await queryClient.refetchQueries({
        queryKey: ['social', 'shared', 'watchlist', WATCHLIST_ID],
      });
    });

    expect(await screen.findByText("This watchlist isn't available")).toBeInTheDocument();
    expect(screen.queryByText('ada’s Long term')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(getSharedWatchlist).toHaveBeenCalledTimes(2);
  });
});

/** The curated icon a rendered avatar actually painted (inert `data-icon-id`). */
function avatarIconId(container: HTMLElement): string | null | undefined {
  return container.querySelector('.bt-avatar svg[data-icon-id]')?.getAttribute('data-icon-id');
}

describe('SharedWatchlistPage — the owner has a face (§6.9)', () => {
  test('renders the owner’s curated icon beside the title', async () => {
    vi.mocked(getSharedWatchlist).mockResolvedValue({
      ...DETAIL,
      owner: { ...DETAIL.owner, profileIcon: 'panda' as const },
    });
    const { container } = renderPage();

    expect(await screen.findByText('ada’s Long term')).toBeInTheDocument();
    expect(avatarIconId(container)).toBe('panda');
  });

  test('falls back to the deterministic default when the owner never picked one', async () => {
    const { container } = renderPage();

    expect(await screen.findByText('ada’s Long term')).toBeInTheDocument();
    expect(avatarIconId(container)).toBe(defaultProfileIconIdFor('ada'));
  });
});
