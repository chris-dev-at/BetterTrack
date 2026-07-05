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

import { updatePortfolio } from '../../lib/portfolioApi';
import { listMyShared } from '../../lib/socialApi';
import { MySharedItemsPage } from './MySharedItemsPage';

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
    vi.mocked(listMyShared).mockResolvedValue({ portfolios: [] });
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
      })
      .mockResolvedValueOnce({ portfolios: [] });
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

  test('shows an error affordance when the fetch fails', async () => {
    vi.mocked(listMyShared).mockRejectedValue(new Error('boom'));
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/Could not load your shared items/i)).toBeInTheDocument(),
    );
  });
});
