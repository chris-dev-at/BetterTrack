import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../lib/socialApi', () => ({
  listSharedWithMe: vi.fn(),
}));

import { listSharedWithMe } from '../../lib/socialApi';
import { SharedWithMePage } from './SharedWithMePage';

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <SharedWithMePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SharedWithMePage', () => {
  test('shows an empty state when no friend has shared a portfolio', async () => {
    vi.mocked(listSharedWithMe).mockResolvedValue({ portfolios: [] });
    renderPage();

    await waitFor(() =>
      expect(screen.getByText('Nothing shared with you yet')).toBeInTheDocument(),
    );
  });

  test('lists a friend-shared portfolio with owner, name and total', async () => {
    vi.mocked(listSharedWithMe).mockResolvedValue({
      portfolios: [
        {
          portfolioId: '00000000-0000-0000-0000-000000000001',
          name: "Jane's Main",
          owner: { id: '00000000-0000-0000-0000-000000000002', username: 'jane' },
          totalValueEur: 1234.56,
        },
      ],
    });
    renderPage();

    await waitFor(() => expect(screen.getByText("Jane's Main")).toBeInTheDocument());
    expect(screen.getByText('jane')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Jane's Main/i });
    expect(link).toHaveAttribute(
      'href',
      '/social/shared-with-me/00000000-0000-0000-0000-000000000001',
    );
  });

  test('shows an error affordance when the fetch fails', async () => {
    vi.mocked(listSharedWithMe).mockRejectedValue(new Error('boom'));
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/Could not load shared portfolios/i)).toBeInTheDocument(),
    );
  });
});
