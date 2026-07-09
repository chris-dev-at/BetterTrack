import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../lib/socialApi', () => ({
  listSharedWithMe: vi.fn(),
  setActivityAlert: vi.fn(),
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

describe('SharedWithMePage — grouped by person (V3-P6)', () => {
  test('shows an empty state when nobody shares with me', async () => {
    vi.mocked(listSharedWithMe).mockResolvedValue({
      portfolios: [],
      conglomerates: [],
      watchlists: [],
    });
    renderPage();

    await waitFor(() =>
      expect(screen.getByText('Nothing shared with you yet')).toBeInTheDocument(),
    );
  });

  test('a lone sharer is auto-expanded: their portfolio links read-only with a value', async () => {
    vi.mocked(listSharedWithMe).mockResolvedValue({
      portfolios: [
        {
          portfolioId: '00000000-0000-0000-0000-000000000001',
          name: "Jane's Main",
          owner: { id: '00000000-0000-0000-0000-000000000002', username: 'jane' },
          totalValueEur: 1234.56,
          activityAlertsEnabled: false,
        },
      ],
      conglomerates: [],
      watchlists: [],
    });
    renderPage();

    // The person heading names the sharer.
    await waitFor(() => expect(screen.getByText('jane')).toBeInTheDocument());
    // A single sharer auto-expands, so the item is visible in one glance.
    const link = screen.getByRole('link', { name: /Jane's Main/i });
    expect(link).toHaveAttribute(
      'href',
      '/social/shared-with-me/00000000-0000-0000-0000-000000000001',
    );
    // The activity-alert toggle is present per shared item.
    expect(screen.getByRole('switch')).toBeInTheDocument();
  });

  test('multiple sharers collapse; expanding one reveals their items with links', async () => {
    vi.mocked(listSharedWithMe).mockResolvedValue({
      portfolios: [],
      conglomerates: [
        {
          conglomerateId: '00000000-0000-0000-0000-0000000000c1',
          name: 'Tech basket',
          owner: { id: '00000000-0000-0000-0000-000000000002', username: 'jane' },
          status: 'active',
          positionCount: 3,
          activityAlertsEnabled: false,
        },
      ],
      watchlists: [
        {
          watchlistId: '00000000-0000-0000-0000-0000000000d1',
          name: 'General',
          owner: { id: '00000000-0000-0000-0000-000000000003', username: 'bob' },
          itemCount: 2,
          activityAlertsEnabled: false,
        },
      ],
    });
    const user = userEvent.setup();
    renderPage();

    // Two sharers → both collapsed; items are hidden until expanded.
    await waitFor(() => expect(screen.getByText('jane')).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: /Tech basket/i })).not.toBeInTheDocument();

    // Expand jane → her conglomerate appears with a read-only link.
    await user.click(screen.getByRole('button', { name: /jane/i }));
    expect(screen.getByRole('link', { name: /Tech basket/i })).toHaveAttribute(
      'href',
      '/social/shared-with-me/conglomerates/00000000-0000-0000-0000-0000000000c1',
    );

    // Expand bob → his watchlist appears.
    await user.click(screen.getByRole('button', { name: /bob/i }));
    expect(screen.getByRole('link', { name: /General/i })).toHaveAttribute(
      'href',
      '/social/shared-with-me/watchlists/00000000-0000-0000-0000-0000000000d1',
    );
  });

  test('shows an error affordance when the fetch fails', async () => {
    vi.mocked(listSharedWithMe).mockRejectedValue(new Error('boom'));
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/Could not load shared items/i)).toBeInTheDocument(),
    );
  });
});
