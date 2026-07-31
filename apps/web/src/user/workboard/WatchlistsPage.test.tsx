import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../lib/workboardApi', () => ({
  WATCHLISTS_QUERY_KEY: ['workboard', 'watchlists'],
  createWatchlist: vi.fn(),
  deleteWatchlist: vi.fn(),
  listWatchlists: vi.fn(),
  renameWatchlist: vi.fn(),
}));
vi.mock('../components/AudiencePicker', () => ({ AudiencePicker: () => null }));

import { listWatchlists } from '../../lib/workboardApi';
import { WatchlistsPage } from './WatchlistsPage';

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <WatchlistsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listWatchlists).mockResolvedValue({ watchlists: [] });
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
});
