import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { MySharedResponse } from '@bettertrack/contracts';

vi.mock('../../lib/socialApi', () => ({
  listMyShared: vi.fn(),
  getAudience: vi.fn(),
  listFriends: vi.fn(),
  setAudience: vi.fn(),
}));

import { getAudience, listFriends, listMyShared } from '../../lib/socialApi';
import { MySharedItemsPage } from './MySharedItemsPage';

const PORTFOLIO_ID = '00000000-0000-0000-0000-000000000001';
const WATCHLIST_ID = '00000000-0000-0000-0000-0000000000c1';

const EMPTY: MySharedResponse = { portfolios: [], conglomerates: [], watchlists: [] };

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MySharedItemsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAudience).mockResolvedValue({
    kind: 'portfolio',
    subjectId: PORTFOLIO_ID,
    audience: 'all_friends',
    friendIds: [],
    link: { active: false, createdAt: null },
  });
  vi.mocked(listFriends).mockResolvedValue({ friends: [] });
});

describe('MySharedItemsPage', () => {
  test('shows an empty state when nothing is shared', async () => {
    vi.mocked(listMyShared).mockResolvedValue(EMPTY);
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("You're not sharing anything")).toBeInTheDocument(),
    );
  });

  test('lists shared portfolios and watchlists with a who-sees-this summary and opens the AudiencePicker', async () => {
    vi.mocked(listMyShared).mockResolvedValue({
      portfolios: [
        { portfolioId: PORTFOLIO_ID, name: 'Main', audience: 'all_friends', friendCount: 0 },
      ],
      conglomerates: [],
      watchlists: [
        {
          watchlistId: WATCHLIST_ID,
          name: 'General',
          audience: 'public_link',
          itemCount: 3,
          friendCount: 0,
        },
      ],
    });
    renderPage();

    await waitFor(() => expect(screen.getByText('Main')).toBeInTheDocument());
    expect(screen.getByText('General')).toBeInTheDocument();
    // The per-item "who can see this" summary renders (portfolio → All friends,
    // watchlist → Public link).
    expect(screen.getByText('All friends')).toBeInTheDocument();
    expect(screen.getByText('Public link')).toBeInTheDocument();

    // Clicking Share opens the reusable picker dialog.
    const user = userEvent.setup();
    await user.click(screen.getAllByRole('button', { name: /share/i })[0]!);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    // The reusable AudiencePicker renders the audience ladder.
    expect(screen.getByRole('radio', { name: /all friends/i })).toBeInTheDocument();
  });

  test('lists a private (non-shared) portfolio so a secondary one can be shared here (#377)', async () => {
    const SECONDARY_ID = '00000000-0000-0000-0000-000000000002';
    vi.mocked(listMyShared).mockResolvedValue({
      portfolios: [
        { portfolioId: PORTFOLIO_ID, name: 'Main', audience: 'all_friends', friendCount: 0 },
        { portfolioId: SECONDARY_ID, name: 'Trading', audience: 'private', friendCount: 0 },
      ],
      conglomerates: [],
      watchlists: [],
    });
    // The AudiencePicker seeds from the subject's current (private) audience.
    vi.mocked(getAudience).mockResolvedValue({
      kind: 'portfolio',
      subjectId: SECONDARY_ID,
      audience: 'private',
      friendIds: [],
      link: { active: false, createdAt: null },
    });
    renderPage();

    // The private secondary portfolio is listed with the dimmed "Private" badge —
    // the entry point that used to be missing, so it can now be shared.
    await waitFor(() => expect(screen.getByText('Trading')).toBeInTheDocument());
    expect(screen.getByText('Private')).toBeInTheDocument();

    // Its own Share control opens the picker for THAT portfolio (private selected).
    const user = userEvent.setup();
    const shareButtons = screen.getAllByRole('button', { name: /share/i });
    await user.click(shareButtons[shareButtons.length - 1]!);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    expect(screen.getByRole('radio', { name: /only me/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /all friends/i })).toBeInTheDocument();
  });
});
