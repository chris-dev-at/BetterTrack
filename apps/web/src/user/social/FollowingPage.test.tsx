import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../lib/socialApi', () => ({
  listFollowing: vi.fn(),
  listItemFollows: vi.fn(),
  followUser: vi.fn(),
  unfollowUser: vi.fn(),
  updateFollow: vi.fn(),
  followItem: vi.fn(),
  unfollowItem: vi.fn(),
}));

// The follow button + auto-follow toggle only render for a logged-in viewer.
vi.mock('../AuthContext', () => ({
  useOptionalAuth: () => ({ status: 'authenticated', user: { id: 'me', username: 'me' } }),
}));

import { MemoryRouter } from 'react-router-dom';

import { listFollowing, listItemFollows, unfollowItem, updateFollow } from '../../lib/socialApi';
import { FollowingPage } from './FollowingPage';

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <FollowingPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const ALICE = {
  user: { id: 'u-alice', username: 'alice' },
  createdAt: '2026-07-01T00:00:00.000Z',
  autoFollowItems: false,
  notifyOnAlertCreate: false,
  notifyOnAlertFire: false,
};

const ITEMS = {
  items: [
    {
      kind: 'portfolio' as const,
      subjectId: 'p-1',
      followedAt: '2026-07-02T00:00:00.000Z',
      viewable: true,
      name: 'Growth',
      owner: { id: 'u-alice', username: 'alice' },
      via: 'friend' as const,
    },
    {
      kind: 'conglomerate' as const,
      subjectId: 'c-1',
      followedAt: '2026-07-03T00:00:00.000Z',
      viewable: true,
      name: 'My ETF',
      owner: { id: 'u-alice', username: 'alice' },
      via: 'public' as const,
    },
    {
      kind: 'watchlist' as const,
      subjectId: 'w-1',
      followedAt: '2026-07-04T00:00:00.000Z',
      viewable: false,
      name: null,
      owner: null,
      via: null,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listFollowing).mockResolvedValue({
    following: [ALICE],
    followingCount: 1,
    followerCount: 0,
  });
  vi.mocked(listItemFollows).mockResolvedValue(ITEMS);
});

describe('FollowingPage — followed items collection (#439)', () => {
  test('renders all three kinds with deep links, and a gone shell for an invisible item', async () => {
    renderPage();

    // Friend-visible portfolio links into the friend-shared read-only page.
    const growth = await screen.findByRole('link', { name: /Growth/ });
    expect(growth).toHaveAttribute('href', '/social/shared-with-me/p-1');

    // Public conglomerate links to the owner's public profile.
    expect(screen.getByRole('link', { name: /My ETF/ })).toHaveAttribute('href', '/u/alice');

    // The invisible watchlist renders as "gone": no name, no link, unfollow only.
    expect(screen.getByText('No longer available')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Unfollow this item' })).toHaveLength(3);
  });

  test('unfollowing an item calls the API with its kind + id', async () => {
    vi.mocked(unfollowItem).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPage();

    const buttons = await screen.findAllByRole('button', { name: 'Unfollow this item' });
    await user.click(buttons[2]!); // the gone watchlist row stays removable
    await waitFor(() => expect(unfollowItem).toHaveBeenCalledWith('watchlist', 'w-1'));
  });

  test('the per-person auto-follow switch PATCHes the follow row', async () => {
    vi.mocked(updateFollow).mockResolvedValue({ ...ALICE, autoFollowItems: true });
    const user = userEvent.setup();
    renderPage();

    const toggle = await screen.findByRole('switch', {
      name: 'Auto-follow new items from alice',
    });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle);
    await waitFor(() =>
      expect(updateFollow).toHaveBeenCalledWith('u-alice', { autoFollowItems: true }),
    );
  });

  test('the two alert-follow switches PATCH their trigger independently (#455)', async () => {
    vi.mocked(updateFollow).mockResolvedValue({ ...ALICE, notifyOnAlertCreate: true });
    const user = userEvent.setup();
    renderPage();

    const createToggle = await screen.findByRole('switch', {
      name: 'Notify me about new alerts from alice',
    });
    const fireToggle = screen.getByRole('switch', {
      name: 'Notify me when alerts from alice fire',
    });
    expect(createToggle).toHaveAttribute('aria-checked', 'false');
    expect(fireToggle).toHaveAttribute('aria-checked', 'false');

    await user.click(createToggle);
    await waitFor(() =>
      expect(updateFollow).toHaveBeenCalledWith('u-alice', { notifyOnAlertCreate: true }),
    );

    await user.click(fireToggle);
    await waitFor(() =>
      expect(updateFollow).toHaveBeenCalledWith('u-alice', { notifyOnAlertFire: true }),
    );
    // Each click patched ONLY its own trigger — never the sibling.
    expect(updateFollow).not.toHaveBeenCalledWith(
      'u-alice',
      expect.objectContaining({
        notifyOnAlertCreate: expect.anything(),
        notifyOnAlertFire: expect.anything(),
      }),
    );
  });
});
