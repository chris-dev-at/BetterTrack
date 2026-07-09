import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi, beforeEach } from 'vitest';

vi.mock('../../lib/socialApi', () => ({
  sendFriendRequest: vi.fn(),
  listFriendRequests: vi.fn(),
  acceptFriendRequest: vi.fn(),
  declineFriendRequest: vi.fn(),
  cancelFriendRequest: vi.fn(),
  listFriends: vi.fn(),
  listSharedWithMe: vi.fn(),
  removeFriend: vi.fn(),
  setActivityAlert: vi.fn(),
}));

import { MemoryRouter } from 'react-router-dom';

import {
  acceptFriendRequest,
  cancelFriendRequest,
  declineFriendRequest,
  listFriendRequests,
  listFriends,
  listSharedWithMe,
  removeFriend,
  sendFriendRequest,
  setActivityAlert,
} from '../../lib/socialApi';
import { FriendsPage } from './FriendsPage';

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
}

function renderPage() {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter>
        <FriendsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const EMPTY_REQUESTS = { incoming: [], outgoing: [] };
const EMPTY_FRIENDS = { friends: [] };
const EMPTY_SHARED = { portfolios: [], conglomerates: [], watchlists: [] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listFriendRequests).mockResolvedValue(EMPTY_REQUESTS);
  vi.mocked(listFriends).mockResolvedValue(EMPTY_FRIENDS);
  vi.mocked(listSharedWithMe).mockResolvedValue(EMPTY_SHARED);
});

describe('FriendsPage', () => {
  test('sends a friend request and shows the same success feedback regardless of the target', async () => {
    vi.mocked(sendFriendRequest).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(screen.getByText('No friends yet')).toBeInTheDocument());
    await user.type(screen.getByLabelText('Username or email'), 'jane@example.com');
    await user.click(screen.getByRole('button', { name: 'Send request' }));

    expect(sendFriendRequest).toHaveBeenCalledWith({ identifier: 'jane@example.com' });
    await waitFor(() =>
      expect(screen.getByText(/we've sent your friend request/i)).toBeInTheDocument(),
    );
  });

  test('shows an error affordance when requests fail to load', async () => {
    vi.mocked(listFriendRequests).mockRejectedValue(new Error('nope'));
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/Could not load your friend requests/i)).toBeInTheDocument(),
    );
  });

  test('shows an error affordance when friends fail to load', async () => {
    vi.mocked(listFriends).mockRejectedValue(new Error('nope'));
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/Could not load your friends/i)).toBeInTheDocument(),
    );
  });

  test('accepts an incoming request and refreshes the lists', async () => {
    vi.mocked(listFriendRequests).mockResolvedValue({
      incoming: [
        {
          id: 'req-1',
          direction: 'incoming',
          status: 'pending',
          user: { id: 'u1', username: 'alice' },
          createdAt: '2026-01-01T00:00:00.000Z',
          respondedAt: null,
        },
      ],
      outgoing: [],
    });
    vi.mocked(acceptFriendRequest).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(screen.getByText('alice')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Accept' }));

    expect(acceptFriendRequest).toHaveBeenCalledWith('req-1');
    await waitFor(() => expect(listFriendRequests).toHaveBeenCalledTimes(2));
    expect(listFriends).toHaveBeenCalledTimes(2);
  });

  test('declines an incoming request', async () => {
    vi.mocked(listFriendRequests).mockResolvedValue({
      incoming: [
        {
          id: 'req-2',
          direction: 'incoming',
          status: 'pending',
          user: { id: 'u2', username: 'bob' },
          createdAt: '2026-01-01T00:00:00.000Z',
          respondedAt: null,
        },
      ],
      outgoing: [],
    });
    vi.mocked(declineFriendRequest).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(screen.getByText('bob')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Decline' }));

    expect(declineFriendRequest).toHaveBeenCalledWith('req-2');
    await waitFor(() => expect(listFriendRequests).toHaveBeenCalledTimes(2));
  });

  test('cancels an outgoing request', async () => {
    vi.mocked(listFriendRequests).mockResolvedValue({
      incoming: [],
      outgoing: [
        {
          id: 'req-3',
          direction: 'outgoing',
          status: 'pending',
          user: { id: 'u3', username: 'carol' },
          createdAt: '2026-01-01T00:00:00.000Z',
          respondedAt: null,
        },
      ],
    });
    vi.mocked(cancelFriendRequest).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(screen.getByText('carol')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(cancelFriendRequest).toHaveBeenCalledWith('req-3');
    await waitFor(() => expect(listFriendRequests).toHaveBeenCalledTimes(2));
  });

  test('expands a friend and removes them after confirming in the dialog', async () => {
    vi.mocked(listFriends).mockResolvedValue({
      friends: [{ user: { id: 'u4', username: 'dave' }, createdAt: '2026-01-01T00:00:00.000Z' }],
    });
    vi.mocked(removeFriend).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPage();

    // The card is clean — Remove lives in the friend overview, revealed on expand.
    await waitFor(() => expect(screen.getByText('dave')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'dave' }));
    await user.click(screen.getByRole('button', { name: 'Remove' }));

    const dialog = screen.getByRole('dialog', { name: 'Remove friend?' });
    expect(dialog).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

    expect(removeFriend).toHaveBeenCalledWith('u4');
    await waitFor(() => expect(listFriends).toHaveBeenCalledTimes(2));
  });

  test('a friend card exposes a chat entry point that routes to the future chat surface', async () => {
    vi.mocked(listFriends).mockResolvedValue({
      friends: [{ user: { id: 'u5', username: 'erin' }, createdAt: '2026-01-01T00:00:00.000Z' }],
    });
    renderPage();

    await waitFor(() => expect(screen.getByText('erin')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /message erin/i })).toHaveAttribute(
      'href',
      '/social/chat/u5',
    );
  });

  test('the per-item activity toggle lives in the friend overview and persists (#384)', async () => {
    const FRANK_ID = 'u6';
    const SHARED_PORTFOLIO_ID = '00000000-0000-0000-0000-000000000001';
    vi.mocked(listFriends).mockResolvedValue({
      friends: [
        { user: { id: FRANK_ID, username: 'frank' }, createdAt: '2026-01-01T00:00:00.000Z' },
      ],
    });
    // Frank shares one portfolio with me (surfaced in the friend overview).
    vi.mocked(listSharedWithMe).mockResolvedValue({
      portfolios: [
        {
          portfolioId: SHARED_PORTFOLIO_ID,
          name: "Frank's Main",
          owner: { id: FRANK_ID, username: 'frank' },
          totalValueEur: 1000,
          activityAlertsEnabled: false,
        },
      ],
      conglomerates: [],
      watchlists: [],
    });
    vi.mocked(setActivityAlert).mockResolvedValue({
      kind: 'portfolio',
      subjectId: SHARED_PORTFOLIO_ID,
      enabled: true,
    });
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(screen.getByText('frank')).toBeInTheDocument());
    // Expand the friend → the overview reveals their shared item + activity control.
    await user.click(screen.getByRole('button', { name: 'frank' }));
    // The clarified label names the friend and states what it does.
    expect(
      screen.getByText(/get notified when frank buys, sells, or updates this/i),
    ).toBeInTheDocument();
    // The honest "dormant until notifications go live" hint is present.
    expect(screen.getByText(/activates when notifications go live/i)).toBeInTheDocument();

    // Toggling persists the preference immediately (optimistic + PUT).
    const toggle = screen.getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle);
    expect(setActivityAlert).toHaveBeenCalledWith('portfolio', SHARED_PORTFOLIO_ID, true);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
  });
});
