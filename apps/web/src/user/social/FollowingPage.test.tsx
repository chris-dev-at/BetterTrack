import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../lib/socialApi', () => ({
  followItem: vi.fn(),
  followUser: vi.fn(),
  listFollowing: vi.fn(),
  listItemFollows: vi.fn(),
  unfollowItem: vi.fn(),
  unfollowUser: vi.fn(),
  updateFollow: vi.fn(),
}));

vi.mock('../AuthContext', () => ({
  useOptionalAuth: () => ({ status: 'authenticated', user: { id: 'me', username: 'me' } }),
}));

import { listFollowing, listItemFollows, unfollowItem } from '../../lib/socialApi';
import { setViewportWidth } from '../../test/viewport';
import { FollowingPage } from './FollowingPage';

const ALICE_ID = '00000000-0000-4000-8000-000000000001';

const ALICE = {
  user: { id: ALICE_ID, username: 'alice', profileIcon: 'fox' as const },
  createdAt: '2026-07-01T00:00:00.000Z',
  autoFollowItems: false,
  notifyOnAlertCreate: false,
  notifyOnAlertFire: false,
  sharesAlertActivity: false,
};

const FOLLOWED_ITEMS = {
  items: [
    {
      kind: 'portfolio' as const,
      subjectId: '00000000-0000-4000-8000-000000000011',
      followedAt: '2026-07-02T00:00:00.000Z',
      viewable: true,
      name: 'Growth',
      owner: ALICE.user,
      via: 'friend' as const,
    },
    {
      kind: 'idea' as const,
      subjectId: '00000000-0000-4000-8000-000000000012',
      followedAt: '2026-07-03T00:00:00.000Z',
      viewable: true,
      name: 'Durable compounders',
      owner: ALICE.user,
      via: 'public' as const,
    },
    {
      kind: 'watchlist' as const,
      subjectId: '00000000-0000-4000-8000-000000000013',
      followedAt: '2026-07-04T00:00:00.000Z',
      viewable: false,
      name: null,
      owner: null,
      via: null,
    },
  ],
};

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <FollowingPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  setViewportWidth(1024);
  vi.mocked(listFollowing).mockResolvedValue({
    following: [ALICE],
    followingCount: 1,
    followerCount: 0,
  });
  vi.mocked(listItemFollows).mockResolvedValue(FOLLOWED_ITEMS);
  vi.mocked(unfollowItem).mockResolvedValue(undefined);
});

describe('FollowingPage', () => {
  test('at 390 px lists followed people and visibility-safe items from both endpoints', async () => {
    setViewportWidth(390);
    const user = userEvent.setup();
    renderPage();

    expect(screen.getAllByRole('status')).toHaveLength(2);

    expect(await screen.findByRole('link', { name: '@alice' })).toHaveAttribute('href', '/u/alice');
    expect(screen.getByRole('button', { name: 'Unfollow alice' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Growth/ })).toHaveAttribute(
      'href',
      '/people/shared/00000000-0000-4000-8000-000000000011',
    );
    expect(screen.getByRole('link', { name: /Durable compounders/ })).toHaveAttribute(
      'href',
      '/u/alice',
    );
    expect(screen.getByText('No longer available')).toBeInTheDocument();

    const itemButtons = screen.getAllByRole('button', { name: 'Unfollow this item' });
    await user.click(itemButtons[2]!);
    await waitFor(() =>
      expect(unfollowItem).toHaveBeenCalledWith(
        'watchlist',
        '00000000-0000-4000-8000-000000000013',
      ),
    );
  });

  test('at desktop width renders both empty states', async () => {
    vi.mocked(listFollowing).mockResolvedValue({
      following: [],
      followingCount: 0,
      followerCount: 0,
    });
    vi.mocked(listItemFollows).mockResolvedValue({ items: [] });

    renderPage();

    expect(await screen.findByText("You're not following anyone yet.")).toBeInTheDocument();
    expect(screen.getByText("You're not following any items yet.")).toBeInTheDocument();
  });

  test('keeps each collection error visible and retryable', async () => {
    vi.mocked(listFollowing).mockRejectedValue(new Error('people failed'));
    vi.mocked(listItemFollows).mockRejectedValue(new Error('items failed'));

    renderPage();

    expect(
      await screen.findByText("Couldn't load who you follow. Please refresh the page."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Couldn't load your followed items. Please refresh the page."),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Try again' })).toHaveLength(2);
  });
});
