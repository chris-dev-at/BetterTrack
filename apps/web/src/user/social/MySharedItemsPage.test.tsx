import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
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
const CONGLOMERATE_ID = '00000000-0000-0000-0000-0000000000e1';
const WATCHLIST_ID = '00000000-0000-0000-0000-0000000000c1';

const EMPTY: MySharedResponse = { portfolios: [], conglomerates: [], watchlists: [], ideas: [] };

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <MySharedItemsPage />
      </MemoryRouter>
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
  test('shows an empty state when the caller owns nothing', async () => {
    vi.mocked(listMyShared).mockResolvedValue(EMPTY);
    renderPage();
    await waitFor(() => expect(screen.getByText("You don't own anything yet")).toBeInTheDocument());
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
      ideas: [],
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

  test('lists all three kinds including a never-shared conglomerate + watchlist, each settable (#384)', async () => {
    vi.mocked(listMyShared).mockResolvedValue({
      portfolios: [
        { portfolioId: PORTFOLIO_ID, name: 'Main', audience: 'private', friendCount: 0 },
      ],
      conglomerates: [
        {
          conglomerateId: CONGLOMERATE_ID,
          name: 'Tech basket',
          positionCount: 3,
          audience: 'private',
          friendCount: 0,
        },
      ],
      watchlists: [
        {
          watchlistId: WATCHLIST_ID,
          name: 'General',
          itemCount: 2,
          audience: 'private',
          friendCount: 0,
        },
      ],
      ideas: [],
    });
    // The picker seeds from the conglomerate's current (private) audience.
    vi.mocked(getAudience).mockResolvedValue({
      kind: 'conglomerate',
      subjectId: CONGLOMERATE_ID,
      audience: 'private',
      friendIds: [],
      link: { active: false, createdAt: null },
    });
    renderPage();

    // Every kind is present — a private portfolio, a never-shared conglomerate
    // and a never-shared watchlist — under its own section heading.
    await waitFor(() => expect(screen.getByText('Tech basket')).toBeInTheDocument());
    expect(screen.getByText('Main')).toBeInTheDocument();
    expect(screen.getByText('General')).toBeInTheDocument();
    expect(screen.getByText('Portfolios')).toBeInTheDocument();
    expect(screen.getByText('Conglomerates')).toBeInTheDocument();
    expect(screen.getByText('Watchlists')).toBeInTheDocument();
    // All three read Private (never shared).
    expect(screen.getAllByText('Private')).toHaveLength(3);

    // The conglomerate has its own Share entry point → the picker for THAT basket.
    const user = userEvent.setup();
    const shareButtons = screen.getAllByRole('button', { name: /share/i });
    expect(shareButtons).toHaveLength(3);
    await user.click(shareButtons[1]!);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    expect(screen.getByRole('radio', { name: /only me/i })).toBeInTheDocument();
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
      ideas: [],
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

  test('shows an ideas group with a per-item audience entry point (V4-P9)', async () => {
    const IDEA_ID = '00000000-0000-0000-0000-0000000000a1';
    vi.mocked(listMyShared).mockResolvedValue({
      portfolios: [],
      conglomerates: [],
      watchlists: [],
      ideas: [
        {
          ideaId: IDEA_ID,
          name: 'Momentum basket',
          hasThesis: true,
          audience: 'private',
          friendCount: 0,
        },
      ],
    });
    vi.mocked(getAudience).mockResolvedValue({
      kind: 'idea',
      subjectId: IDEA_ID,
      audience: 'private',
      friendIds: [],
      link: { active: false, createdAt: null },
    });
    renderPage();

    await waitFor(() => expect(screen.getByText('Momentum basket')).toBeInTheDocument());
    expect(screen.getByText('Ideas')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /share/i }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    expect(getAudience).toHaveBeenCalledWith('idea', IDEA_ID, expect.anything());
  });
});
