import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
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
  listGroups: vi.fn(),
  createGroup: vi.fn(),
  renameGroup: vi.fn(),
  deleteGroup: vi.fn(),
  addGroupMember: vi.fn(),
  removeGroupMember: vi.fn(),
}));
vi.mock('../../lib/mirrorApi');

import { MemoryRouter } from 'react-router-dom';

import {
  acceptFriendRequest,
  cancelFriendRequest,
  createGroup,
  declineFriendRequest,
  listFriendRequests,
  listFriends,
  listGroups,
  listSharedWithMe,
  removeFriend,
  sendFriendRequest,
  setActivityAlert,
} from '../../lib/socialApi';
import { ApiError } from '../../lib/apiClient';
import { listMirrorInvites } from '../../lib/mirrorApi';
import { setViewportWidth } from '../../test/viewport';
import { FriendsPage } from './FriendsPage';

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
}

function renderPage(client = makeQueryClient()) {
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <FriendsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

const EMPTY_REQUESTS = { incoming: [], outgoing: [] };
const EMPTY_FRIENDS = { friends: [] };
const EMPTY_SHARED = { portfolios: [], conglomerates: [], watchlists: [], ideas: [] };
const EMPTY_MIRROR_INVITES = { incoming: [], outgoing: [] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listFriendRequests).mockResolvedValue(EMPTY_REQUESTS);
  vi.mocked(listFriends).mockResolvedValue(EMPTY_FRIENDS);
  vi.mocked(listSharedWithMe).mockResolvedValue(EMPTY_SHARED);
  vi.mocked(listMirrorInvites).mockResolvedValue(EMPTY_MIRROR_INVITES);
  vi.mocked(listGroups).mockResolvedValue({ groups: [] });
});

describe('FriendsPage', () => {
  test('renders the friends list above the requests section (V4-P0 h)', async () => {
    vi.mocked(listFriendRequests).mockResolvedValue({
      incoming: [
        {
          id: 'req-order',
          direction: 'incoming',
          status: 'pending',
          user: { id: 'u-inc', username: 'ivan' },
          createdAt: '2026-01-01T00:00:00.000Z',
          respondedAt: null,
        },
      ],
      outgoing: [],
    });
    vi.mocked(listFriends).mockResolvedValue({
      friends: [
        { user: { id: 'u-fri', username: 'fiona' }, createdAt: '2026-01-01T00:00:00.000Z' },
      ],
    });
    renderPage();

    await waitFor(() => expect(screen.getByText('fiona')).toBeInTheDocument());
    const friend = screen.getByText('fiona');
    const incomingHeader = screen.getByText('Incoming requests');
    expect(
      friend.compareDocumentPosition(incomingHeader) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

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
    vi.mocked(listFriendRequests)
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValueOnce(EMPTY_REQUESTS);
    const user = userEvent.setup();
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/Could not load your friend requests/i)).toBeInTheDocument(),
    );
    const error = screen.getByText(/Could not load your friend requests/i).parentElement!;
    await user.click(within(error).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Incoming requests')).toBeInTheDocument();
    expect(listFriendRequests).toHaveBeenCalledTimes(2);
  });

  test('shows an error affordance when friends fail to load', async () => {
    vi.mocked(listFriends)
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValueOnce(EMPTY_FRIENDS);
    const user = userEvent.setup();
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/Could not load your friends/i)).toBeInTheDocument(),
    );
    const error = screen.getByText(/Could not load your friends/i).parentElement!;
    await user.click(within(error).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No friends yet')).toBeInTheDocument();
    expect(listFriends).toHaveBeenCalledTimes(2);
  });

  test('shows a loading state for group-portfolio invites instead of silently omitting them', async () => {
    let resolveInvites!: (value: typeof EMPTY_MIRROR_INVITES) => void;
    vi.mocked(listMirrorInvites).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInvites = resolve;
        }),
    );
    const { container } = renderPage();

    await screen.findByText('Incoming requests');
    const requests = container.querySelector<HTMLElement>('#requests');
    expect(requests).not.toBeNull();
    expect(within(requests!).getByRole('status', { name: 'Loading' })).toBeInTheDocument();

    await act(async () => resolveInvites(EMPTY_MIRROR_INVITES));
    await waitFor(() =>
      expect(within(requests!).queryByRole('status', { name: 'Loading' })).not.toBeInTheDocument(),
    );
  });

  test('retries a failed group-portfolio invite read', async () => {
    vi.mocked(listMirrorInvites)
      .mockRejectedValueOnce(new ApiError(503, 'UNAVAILABLE', 'offline'))
      .mockResolvedValueOnce(EMPTY_MIRROR_INVITES);
    const user = userEvent.setup();
    renderPage();

    const message = await screen.findByText(/Could not load your group portfolio invites/i);
    await user.click(within(message.parentElement!).getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(message).not.toBeInTheDocument());
    expect(listMirrorInvites).toHaveBeenCalledTimes(2);
  });

  test.each([403, 404])(
    'keeps a confirmed %i group-portfolio invite rejection unavailable without retry',
    async (status) => {
      vi.mocked(listMirrorInvites).mockRejectedValue(
        new ApiError(status, 'NOT_AVAILABLE', 'private detail'),
      );
      renderPage();

      expect(await screen.findByText("This information isn't available.")).toBeInTheDocument();
      expect(screen.queryByText('private detail')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    },
  );

  test('keeps shared-item loading distinct from a genuine empty result', async () => {
    let resolveShared!: (value: typeof EMPTY_SHARED) => void;
    vi.mocked(listFriends).mockResolvedValue({
      friends: [
        { user: { id: 'u-loading', username: 'hannah' }, createdAt: '2026-01-01T00:00:00.000Z' },
      ],
    });
    vi.mocked(listSharedWithMe).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveShared = resolve;
        }),
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'hannah' }));
    const friendsSection = screen
      .getByRole('heading', { level: 2, name: 'Friends' })
      .closest('section');
    expect(friendsSection).not.toBeNull();
    expect(within(friendsSection!).getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(screen.queryByText(/hannah isn't sharing anything/i)).not.toBeInTheDocument();

    await act(async () => resolveShared(EMPTY_SHARED));
    expect(await screen.findByText(/hannah isn't sharing anything/i)).toBeInTheDocument();
  });

  test('hides retained shared-item data after a confirmed rejection and recovers on retry', async () => {
    const friendId = 'u-revoked';
    const sharedPortfolioId = '00000000-0000-0000-0000-000000000123';
    vi.mocked(listFriends).mockResolvedValue({
      friends: [
        { user: { id: friendId, username: 'iris' }, createdAt: '2026-01-01T00:00:00.000Z' },
      ],
    });
    vi.mocked(listSharedWithMe)
      .mockResolvedValueOnce({
        portfolios: [
          {
            portfolioId: sharedPortfolioId,
            name: 'Revoked portfolio',
            owner: { id: friendId, username: 'iris' },
            totalValueEur: 1_000,
            activityAlertsEnabled: false,
          },
        ],
        conglomerates: [],
        watchlists: [],
        ideas: [],
      })
      .mockRejectedValueOnce(new ApiError(404, 'NOT_FOUND', 'Not found'))
      .mockResolvedValueOnce(EMPTY_SHARED);
    const user = userEvent.setup();
    const { client } = renderPage();

    await user.click(await screen.findByRole('button', { name: 'iris' }));
    expect(await screen.findByText('Revoked portfolio')).toBeInTheDocument();

    await act(async () => {
      await client.refetchQueries({ queryKey: ['social', 'shared-with-me'], type: 'active' });
    });

    const message = await screen.findByText(/Could not load this shared item/i);
    expect(screen.queryByText('Revoked portfolio')).not.toBeInTheDocument();
    expect(screen.queryByText(/iris isn't sharing anything/i)).not.toBeInTheDocument();

    await user.click(within(message.parentElement!).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/iris isn't sharing anything/i)).toBeInTheDocument();
    expect(listSharedWithMe).toHaveBeenCalledTimes(3);
  });

  test('accepts an incoming request and refreshes every friendship-dependent list', async () => {
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
    expect(listSharedWithMe).toHaveBeenCalledTimes(2);
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

  test('removing a friend drops them from the circles on the same page visit', async () => {
    // `socialService.removeFriend` runs `groups.removeMutualMemberships` inside
    // the unfriend transaction, so a circle card still listing the ex-friend —
    // with a Remove button and a memberCount including them — is an owner
    // surface claiming a reach the server no longer grants.
    vi.mocked(listFriends)
      .mockResolvedValueOnce({
        friends: [{ user: { id: 'u9', username: 'bob' }, createdAt: '2026-01-01T00:00:00.000Z' }],
      })
      .mockResolvedValue(EMPTY_FRIENDS);
    vi.mocked(listGroups)
      .mockResolvedValueOnce({
        groups: [
          {
            id: 'g1',
            name: 'Family',
            memberCount: 1,
            members: [{ id: 'u9', username: 'bob', profileIcon: null }],
            shareCount: 0,
          },
        ],
      })
      .mockResolvedValue({
        groups: [{ id: 'g1', name: 'Family', memberCount: 0, members: [], shareCount: 0 }],
      });
    vi.mocked(removeFriend).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPage();

    // The circle, open, shows bob as a live member.
    await user.click(await screen.findByRole('button', { name: /family/i }));
    expect(screen.getByText('1 member')).toBeInTheDocument();
    const circle = screen.getByText('Family').closest('li') as HTMLElement;
    expect(within(circle).getByText('bob')).toBeInTheDocument();

    // Unfriend him from the friend overview beside it (Remove lives there, on
    // expand — the circle's own member row carries a Remove of its own).
    await user.click(screen.getByRole('button', { name: 'bob' }));
    const friendCard = screen.getByRole('button', { name: 'bob' }).closest('li') as HTMLElement;
    await user.click(within(friendCard).getByRole('button', { name: 'Remove' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove friend?' });
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

    expect(removeFriend).toHaveBeenCalledWith('u9');
    await waitFor(() => expect(listGroups).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText('0 members')).toBeInTheDocument());
    expect(screen.queryByText('bob')).not.toBeInTheDocument();
  });

  test('a friend card exposes a chat entry point that routes to the future chat surface', async () => {
    vi.mocked(listFriends).mockResolvedValue({
      friends: [{ user: { id: 'u5', username: 'erin' }, createdAt: '2026-01-01T00:00:00.000Z' }],
    });
    renderPage();

    await waitFor(() => expect(screen.getByText('erin')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /message erin/i })).toHaveAttribute(
      'href',
      '/people/chat/u5',
    );
  });

  test('at 390 px accepts a request and creates a friend group from stacked controls', async () => {
    setViewportWidth(390);
    vi.mocked(listFriendRequests).mockResolvedValue({
      incoming: [
        {
          id: 'req-phone',
          direction: 'incoming',
          status: 'pending',
          user: { id: 'u-phone', username: 'phia' },
          createdAt: '2026-08-04T00:00:00.000Z',
          respondedAt: null,
        },
      ],
      outgoing: [],
    });
    vi.mocked(acceptFriendRequest).mockResolvedValue(undefined);
    vi.mocked(createGroup).mockResolvedValue({
      id: '00000000-0000-0000-0000-000000000099',
      name: 'Family',
      memberCount: 0,
      members: [],
      shareCount: 0,
    });
    const user = userEvent.setup();
    const { container } = renderPage();

    await user.click(await screen.findByRole('button', { name: 'Accept' }));
    expect(acceptFriendRequest).toHaveBeenCalledWith('req-phone');
    await user.type(screen.getByLabelText('New group name'), 'Family');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(createGroup).toHaveBeenCalledWith('Family');
    expect(container.querySelector('.bt-friends-page')).toBeInTheDocument();
    setViewportWidth(1024);
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
      ideas: [],
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

  test('shows a friend-shared idea in the expanded friend overview (V4-P9)', async () => {
    const GRACE_ID = 'u7';
    const SHARED_IDEA_ID = '00000000-0000-0000-0000-0000000000a1';
    vi.mocked(listFriends).mockResolvedValue({
      friends: [
        { user: { id: GRACE_ID, username: 'grace' }, createdAt: '2026-01-01T00:00:00.000Z' },
      ],
    });
    vi.mocked(listSharedWithMe).mockResolvedValue({
      portfolios: [],
      conglomerates: [],
      watchlists: [],
      ideas: [
        {
          ideaId: SHARED_IDEA_ID,
          name: 'Momentum basket',
          owner: { id: GRACE_ID, username: 'grace' },
          hasThesis: true,
          activityAlertsEnabled: false,
        },
      ],
    });
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(screen.getByText('grace')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'grace' }));
    // The idea appears as a read-only deep link into the shared-idea view.
    const link = screen.getByRole('link', { name: /momentum basket/i });
    expect(link).toHaveAttribute('href', `/people/shared/ideas/${SHARED_IDEA_ID}`);
  });

  // The aggregated "Followed items" collection was removed from Social (#532):
  // item-follows survive only as notification subscriptions, with no list here.
  test('renders no Followed-items section', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByText('No friends yet')).toBeInTheDocument());
    expect(screen.queryByText('Followed items')).not.toBeInTheDocument();
  });
});
