import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../lib/chatApi', () => ({
  listConversations: vi.fn(),
  openConversation: vi.fn(),
  getThread: vi.fn(),
  sendChatMessage: vi.fn(),
  markConversationRead: vi.fn(),
}));
vi.mock('../../lib/socialApi', () => ({
  listFriends: vi.fn(),
  listGroups: vi.fn(),
  getAudience: vi.fn(),
  setAudience: vi.fn(),
}));
vi.mock('../../lib/portfolioApi', () => ({ listPortfolios: vi.fn() }));
vi.mock('../../lib/conglomerateApi', () => ({ listConglomerates: vi.fn() }));
vi.mock('../../lib/ideasApi', () => ({ listIdeas: vi.fn() }));
vi.mock('../AuthContext', () => ({ useAuth: () => ({ user: { id: 'me', username: 'me' } }) }));

import { MemoryRouter, Route, Routes } from 'react-router-dom';

import {
  getThread,
  listConversations,
  markConversationRead,
  openConversation,
  sendChatMessage,
} from '../../lib/chatApi';
import { ApiError } from '../../lib/apiClient';
import { getAudience, listFriends, listGroups, setAudience } from '../../lib/socialApi';
import { listConglomerates } from '../../lib/conglomerateApi';
import { listPortfolios } from '../../lib/portfolioApi';
import { listIdeas } from '../../lib/ideasApi';
import { setViewportWidth } from '../../test/viewport';
import { ChatPage } from './ChatPage';

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
}

/** A promise whose settlement the test controls, to hold a send in-flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderAt(path: string) {
  const queryClient = makeQueryClient();
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/social/chat" element={<ChatPage />} />
            <Route path="/social/chat/:userId" element={<ChatPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom has no scrollIntoView; the thread auto-scroll calls it.
  Element.prototype.scrollIntoView = vi.fn();
  vi.mocked(markConversationRead).mockResolvedValue(undefined);
  // The quick-share shortcut resolves a `group` audience against this roster.
  vi.mocked(listGroups).mockResolvedValue({ groups: [] });
  // Attach-picker sources default to empty; individual tests override.
  vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [] });
  vi.mocked(listConglomerates).mockResolvedValue({ conglomerates: [] });
  vi.mocked(listIdeas).mockResolvedValue({ ideas: [] });
});

describe('ChatPage — conversation list', () => {
  test('renders a friend-list read failure inside the new-message dialog', async () => {
    vi.mocked(listConversations).mockResolvedValue({ conversations: [], unreadTotal: 0 });
    vi.mocked(listFriends).mockRejectedValue(new Error('friends unavailable'));
    const user = userEvent.setup();
    renderAt('/social/chat');

    await user.click(screen.getByRole('button', { name: 'New message' }));
    expect(await screen.findByText("This information isn't available.")).toBeInTheDocument();
  });

  test('renders conversations with an unread badge', async () => {
    vi.mocked(listConversations).mockResolvedValue({
      conversations: [
        {
          id: 'c1',
          user: { id: 'u2', username: 'bob' },
          unreadCount: 3,
          lastMessage: {
            senderId: 'u2',
            body: 'hello there',
            chipKind: null,
            createdAt: '2026-01-01T10:00:00.000Z',
          },
          lastMessageAt: '2026-01-01T10:00:00.000Z',
        },
      ],
      unreadTotal: 3,
    });

    renderAt('/social/chat');

    await waitFor(() => expect(screen.getByText('bob')).toBeInTheDocument());
    expect(screen.getByText('hello there')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument(); // unread badge
  });

  test('shows an empty state when there are no conversations', async () => {
    vi.mocked(listConversations).mockResolvedValue({ conversations: [], unreadTotal: 0 });
    renderAt('/social/chat');
    await waitFor(() => expect(screen.getByText('No messages yet')).toBeInTheDocument());
  });

  test('retries a failed conversation-list read in place', async () => {
    vi.mocked(listConversations)
      .mockRejectedValueOnce(new ApiError(503, 'UNAVAILABLE', 'offline'))
      .mockResolvedValueOnce({ conversations: [], unreadTotal: 0 });
    const user = userEvent.setup();
    renderAt('/social/chat');

    expect(await screen.findByText(/couldn't load your chats/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('No messages yet')).toBeInTheDocument();
    expect(listConversations).toHaveBeenCalledTimes(2);
  });
});

describe('ChatPage — thread + share chip enforcement', () => {
  beforeEach(() => {
    vi.mocked(listConversations).mockResolvedValue({ conversations: [], unreadTotal: 0 });
    vi.mocked(openConversation).mockResolvedValue({
      id: 'c1',
      user: { id: 'u2', username: 'bob' },
      unreadCount: 0,
      lastMessage: null,
      lastMessageAt: null,
    });
  });

  test('renders a viewable chip with its identity and a not-shared chip with no data', async () => {
    vi.mocked(getThread).mockResolvedValue({
      conversation: {
        id: 'c1',
        user: { id: 'u2', username: 'bob' },
        unreadCount: 0,
        lastMessage: null,
        lastMessageAt: null,
      },
      nextCursor: null,
      messages: [
        {
          id: 'm1',
          conversationId: 'c1',
          senderId: 'u2',
          body: 'check this out',
          chip: {
            kind: 'portfolio',
            subjectId: 'p1',
            viewable: true,
            title: 'Growth Portfolio',
            subtitle: 'bob',
          },
          createdAt: '2026-01-01T10:00:00.000Z',
        },
        {
          id: 'm2',
          conversationId: 'c1',
          senderId: 'u2',
          body: null,
          chip: {
            kind: 'portfolio',
            subjectId: 'p2',
            viewable: false,
            title: null,
            subtitle: null,
          },
          createdAt: '2026-01-01T10:01:00.000Z',
        },
      ],
    });

    renderAt('/social/chat/u2');

    // Viewable chip shows the item identity + a View affordance.
    await waitFor(() => expect(screen.getByText('Growth Portfolio')).toBeInTheDocument());
    expect(screen.getByText('check this out')).toBeInTheDocument();
    expect(screen.getByText('View')).toBeInTheDocument();

    // Not-shared chip shows the locked state and NEVER the item's name.
    expect(screen.getByText('Not shared with you')).toBeInTheDocument();

    // The recipient's open thread is marked read (clears the badge).
    await waitFor(() => expect(markConversationRead).toHaveBeenCalledWith('c1'));
  });

  test('a non-friend chat shows a calm "not connected" state, never data', async () => {
    vi.mocked(openConversation).mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'not found'));
    renderAt('/social/chat/u2');
    await waitFor(() => expect(screen.getByText("You're not connected")).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  test('retries an outage while resolving a conversation without calling it private', async () => {
    vi.mocked(openConversation)
      .mockRejectedValueOnce(new ApiError(500, 'UNAVAILABLE', 'offline'))
      .mockResolvedValueOnce({
        id: 'c1',
        user: { id: 'u2', username: 'bob' },
        unreadCount: 0,
        lastMessage: null,
        lastMessageAt: null,
      });
    vi.mocked(getThread).mockResolvedValue({
      conversation: {
        id: 'c1',
        user: { id: 'u2', username: 'bob' },
        unreadCount: 0,
        lastMessage: null,
        lastMessageAt: null,
      },
      nextCursor: null,
      messages: [],
    });
    const user = userEvent.setup();
    renderAt('/social/chat/u2');

    expect(await screen.findByText(/couldn't load your chats/i)).toBeInTheDocument();
    expect(screen.queryByText("You're not connected")).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Say hi to bob')).toBeInTheDocument();
    expect(openConversation).toHaveBeenCalledTimes(2);
  });

  test('a failing thread load stays distinct from empty and retries in place', async () => {
    vi.mocked(getThread)
      .mockRejectedValueOnce(new ApiError(503, 'UNAVAILABLE', 'boom'))
      .mockResolvedValueOnce({
        conversation: {
          id: 'c1',
          user: { id: 'u2', username: 'bob' },
          unreadCount: 0,
          lastMessage: null,
          lastMessageAt: null,
        },
        nextCursor: null,
        messages: [],
      });
    const user = userEvent.setup();
    renderAt('/social/chat/u2');
    await waitFor(() => expect(screen.getByText(/couldn't load your chats/i)).toBeInTheDocument());
    expect(screen.queryByText(/say hi/i)).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Say hi to bob')).toBeInTheDocument();
    expect(getThread).toHaveBeenCalledTimes(2);
  });
});

describe('ChatPage — share-in-chat quick-share shortcut (#380)', () => {
  const convo = {
    id: 'c1',
    user: { id: 'u2', username: 'bob' },
    unreadCount: 0,
    lastMessage: null,
    lastMessageAt: null,
  };

  /** A thread with one chip the caller ('me') sent to bob, resolved for the owner. */
  function ownerChipThread(senderId: 'me' | 'u2' = 'me') {
    vi.mocked(getThread).mockResolvedValue({
      conversation: convo,
      nextCursor: null,
      messages: [
        {
          id: 'm1',
          conversationId: 'c1',
          senderId,
          body: null,
          chip: {
            kind: 'portfolio',
            subjectId: 'p1',
            viewable: true,
            title: 'Growth Portfolio',
            subtitle: null,
          },
          createdAt: '2026-01-01T10:00:00.000Z',
        },
      ],
    });
  }

  beforeEach(() => {
    vi.mocked(listConversations).mockResolvedValue({ conversations: [], unreadTotal: 0 });
    vi.mocked(openConversation).mockResolvedValue(convo);
  });

  test('offers the one-tap shortcut on my own chip the recipient cannot see', async () => {
    ownerChipThread('me');
    vi.mocked(getAudience).mockResolvedValue({
      kind: 'portfolio',
      subjectId: 'p1',
      audience: 'private',
      friendIds: [],
      groupId: null,
      link: { active: false, createdAt: null },
    });
    vi.mocked(setAudience).mockResolvedValue({
      state: {
        kind: 'portfolio',
        subjectId: 'p1',
        audience: 'specific_friends',
        friendIds: ['u2'],
        groupId: null,
        link: { active: false, createdAt: null },
      },
    });
    const user = userEvent.setup();

    renderAt('/social/chat/u2');

    await waitFor(() => expect(screen.getByText(/bob can't see this/i)).toBeInTheDocument());

    const share = screen.getByRole('button', { name: 'Share it with just them' });
    expect(share).toBeDisabled();
    expect(setAudience).not.toHaveBeenCalled();
    await user.click(screen.getByRole('checkbox', { name: /this widens access to bob/i }));
    expect(share).toBeEnabled();
    await user.click(share);

    // The shortcut only ever ADDS the named friend to a specific-friends audience.
    await waitFor(() =>
      expect(setAudience).toHaveBeenCalledWith('portfolio', 'p1', {
        audience: 'specific_friends',
        friendIds: ['u2'],
        confirmWiden: true,
      }),
    );
  });

  test('adds the friend to an existing specific-friends set without dropping anyone', async () => {
    ownerChipThread('me');
    vi.mocked(getAudience).mockResolvedValue({
      kind: 'portfolio',
      subjectId: 'p1',
      audience: 'specific_friends',
      friendIds: ['u9'],
      groupId: null,
      link: { active: false, createdAt: null },
    });
    vi.mocked(setAudience).mockResolvedValue({
      state: {
        kind: 'portfolio',
        subjectId: 'p1',
        audience: 'specific_friends',
        friendIds: ['u9', 'u2'],
        groupId: null,
        link: { active: false, createdAt: null },
      },
    });
    const user = userEvent.setup();

    renderAt('/social/chat/u2');

    // Carol is carried, so the label says "too" rather than "just them".
    const share = await screen.findByRole('button', { name: 'Share it with them too' });
    expect(share).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /this widens access to bob/i }));
    await user.click(share);

    await waitFor(() =>
      expect(setAudience).toHaveBeenCalledWith('portfolio', 'p1', {
        audience: 'specific_friends',
        friendIds: ['u9', 'u2'],
        confirmWiden: true,
      }),
    );
  });

  test('requires an explicit warning before replacing a group audience from chat', async () => {
    ownerChipThread('me');
    vi.mocked(getAudience).mockResolvedValue({
      kind: 'portfolio',
      subjectId: 'p1',
      audience: 'group',
      friendIds: [],
      groupId: 'g1',
      link: { active: false, createdAt: null },
    });
    // The circle exists but admits nobody, so it carries nobody into the write
    // and the replacement warning is the literal truth: only Bob is left.
    vi.mocked(listGroups).mockResolvedValue({
      groups: [{ id: 'g1', name: 'Investors', memberCount: 0, members: [], shareCount: 1 }],
    });
    vi.mocked(setAudience).mockResolvedValue({
      state: {
        kind: 'portfolio',
        subjectId: 'p1',
        audience: 'specific_friends',
        friendIds: ['u2'],
        groupId: null,
        link: { active: false, createdAt: null },
      },
    });
    const user = userEvent.setup();

    renderAt('/social/chat/u2');

    const share = await screen.findByRole('button', { name: 'Share it with just them' });
    expect(share).toBeDisabled();
    expect(
      screen.getByRole('checkbox', {
        name: /replaces the current friend-group audience with only bob/i,
      }),
    ).not.toBeChecked();
    expect(setAudience).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole('checkbox', {
        name: /replaces the current friend-group audience with only bob/i,
      }),
    );
    await user.click(share);

    await waitFor(() =>
      expect(setAudience).toHaveBeenCalledWith('portfolio', 'p1', {
        audience: 'specific_friends',
        friendIds: ['u2'],
        confirmWiden: true,
      }),
    );
  });

  test('treats a recipient inside the shared group as already admitted', async () => {
    ownerChipThread('me');
    vi.mocked(getAudience).mockResolvedValue({
      kind: 'portfolio',
      subjectId: 'p1',
      audience: 'group',
      friendIds: [],
      groupId: 'g1',
      link: { active: false, createdAt: null },
    });
    // Bob is in "Investors", so the server's `group` rung already admits him.
    vi.mocked(listGroups).mockResolvedValue({
      groups: [
        {
          id: 'g1',
          name: 'Investors',
          memberCount: 2,
          members: [
            { id: 'u2', username: 'bob', profileIcon: null },
            { id: 'u9', username: 'carol', profileIcon: null },
          ],
          shareCount: 1,
        },
      ],
    });

    const { queryClient } = renderAt('/social/chat/u2');

    await waitFor(() => expect(screen.getByText('Growth Portfolio')).toBeInTheDocument());
    // Anchor on the roster having SETTLED, not merely been requested: while the
    // read is in flight the shortcut is withheld anyway, so a call-time anchor
    // would pass without ever reaching the `admitted` branch under test.
    await waitFor(() =>
      expect(queryClient.getQueryState(['social', 'groups'])?.status).toBe('success'),
    );
    expect(screen.queryByText(/bob can't see this/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /share it with (just )?them/i })).toBeNull();
  });

  test('widening off a group keeps its other members instead of dropping them', async () => {
    ownerChipThread('me');
    vi.mocked(getAudience).mockResolvedValue({
      kind: 'portfolio',
      subjectId: 'p1',
      audience: 'group',
      friendIds: [],
      groupId: 'g1',
      link: { active: false, createdAt: null },
    });
    // Bob is NOT in the circle; carol is, and must keep her access.
    vi.mocked(listGroups).mockResolvedValue({
      groups: [
        {
          id: 'g1',
          name: 'Investors',
          memberCount: 1,
          members: [{ id: 'u9', username: 'carol', profileIcon: null }],
          shareCount: 1,
        },
      ],
    });
    vi.mocked(setAudience).mockResolvedValue({
      state: {
        kind: 'portfolio',
        subjectId: 'p1',
        audience: 'specific_friends',
        friendIds: ['u9', 'u2'],
        groupId: null,
        link: { active: false, createdAt: null },
      },
    });
    const user = userEvent.setup();

    renderAt('/social/chat/u2');

    const share = await screen.findByRole('button', { name: 'Share it with them too' });
    expect(share).toBeDisabled();
    // Nobody loses access, but the item stops following the circle — and the
    // confirmation has to say so, naming the group whose edits no longer count.
    const confirm = screen.getByRole('checkbox', {
      name: /keeps the current members of Investors and adds bob, but the item stops following that group/i,
    });
    expect(
      screen.queryByRole('checkbox', {
        name: /replaces the current friend-group audience with only bob/i,
      }),
    ).toBeNull();
    await user.click(confirm);
    await user.click(share);

    await waitFor(() =>
      expect(setAudience).toHaveBeenCalledWith('portfolio', 'p1', {
        audience: 'specific_friends',
        friendIds: ['u9', 'u2'],
        confirmWiden: true,
      }),
    );
  });

  test('offers no shortcut while the shared group roster is unresolved', async () => {
    ownerChipThread('me');
    vi.mocked(getAudience).mockResolvedValue({
      kind: 'portfolio',
      subjectId: 'p1',
      audience: 'group',
      friendIds: [],
      groupId: 'g1',
      link: { active: false, createdAt: null },
    });
    vi.mocked(listGroups).mockRejectedValue(new Error('groups unavailable'));

    const { queryClient } = renderAt('/social/chat/u2');

    // Settled-and-failed, not merely requested: the shortcut must stay absent
    // once the roster read has finished without an answer.
    await waitFor(() =>
      expect(queryClient.getQueryState(['social', 'groups'])?.status).toBe('error'),
    );
    expect(screen.queryByText(/bob can't see this/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /share it with (just )?them/i })).toBeNull();
  });

  test('shows no shortcut when the recipient can already see the item', async () => {
    ownerChipThread('me');
    vi.mocked(getAudience).mockResolvedValue({
      kind: 'portfolio',
      subjectId: 'p1',
      audience: 'all_friends',
      friendIds: [],
      groupId: null,
      link: { active: false, createdAt: null },
    });

    renderAt('/social/chat/u2');

    await waitFor(() => expect(screen.getByText('Growth Portfolio')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Share it with just them' })).toBeNull();
  });

  test('never offers the shortcut on a chip the friend sent me', async () => {
    ownerChipThread('u2');

    renderAt('/social/chat/u2');

    await waitFor(() => expect(screen.getByText('Growth Portfolio')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Share it with just them' })).toBeNull();
    // A chip I don't own never triggers an owner-only audience read.
    expect(getAudience).not.toHaveBeenCalled();
  });
});

describe('ChatPage — composer focus', () => {
  const convo = {
    id: 'c1',
    user: { id: 'u2', username: 'bob' },
    unreadCount: 0,
    lastMessage: null,
    lastMessageAt: null,
  };

  beforeEach(() => {
    vi.mocked(listConversations).mockResolvedValue({ conversations: [], unreadTotal: 0 });
    vi.mocked(openConversation).mockResolvedValue(convo);
    vi.mocked(getThread).mockResolvedValue({ conversation: convo, nextCursor: null, messages: [] });
  });

  test('labels the composer and focuses it on desktop', async () => {
    renderAt('/social/chat/u2');

    const input = await screen.findByRole('textbox', { name: 'Message' });
    expect(input).toHaveAttribute('placeholder', 'Message');
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  test('does not autofocus the composer on a touch or phone-sized viewport', async () => {
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: query === '(pointer: coarse)' || query === '(max-width: 767px)',
      })),
    });

    try {
      renderAt('/social/chat/u2');
      const input = await screen.findByRole('textbox', { name: 'Message' });
      expect(document.activeElement).not.toBe(input);
    } finally {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: originalMatchMedia,
      });
    }
  });

  test('waits for IME composition and keeps Shift+Enter as a newline', async () => {
    vi.mocked(sendChatMessage).mockResolvedValue(undefined as never);
    const user = userEvent.setup();

    renderAt('/social/chat/u2');
    const input = await screen.findByRole('textbox', { name: 'Message' });

    await user.type(input, 'hello');
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(sendChatMessage).not.toHaveBeenCalled();

    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(input).toHaveValue('hello\n');
    expect(sendChatMessage).not.toHaveBeenCalled();

    await user.keyboard('{Enter}');
    await waitFor(() => expect(sendChatMessage).toHaveBeenCalledWith('c1', { body: 'hello' }));
  });

  test('a resolved send clears the input and returns focus for the next message', async () => {
    const pending = deferred<Awaited<ReturnType<typeof sendChatMessage>>>();
    vi.mocked(sendChatMessage).mockReturnValue(pending.promise);
    const user = userEvent.setup();

    renderAt('/social/chat/u2');
    const input = await screen.findByPlaceholderText('Message');

    await user.type(input, 'hello');
    // Send via the button — that moves focus off the input (the real click path);
    // while in-flight the field is disabled, which is what drops focus today.
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(sendChatMessage).toHaveBeenCalledWith('c1', { body: 'hello' }));
    await waitFor(() => expect(input).toBeDisabled());

    await act(async () => {
      pending.resolve({
        id: 'm1',
        conversationId: 'c1',
        senderId: 'me',
        body: 'hello',
        chip: null,
        createdAt: '2026-01-01T10:00:00.000Z',
      });
    });

    // Once the send resolves the input clears and focus lands back on it —
    // surviving the re-enable and the success invalidation/refetch.
    await waitFor(() => {
      expect(input).toHaveValue('');
      expect(document.activeElement).toBe(input);
    });
  });

  test('a failed send keeps the text and the focus so it can be retried', async () => {
    const pending = deferred<Awaited<ReturnType<typeof sendChatMessage>>>();
    vi.mocked(sendChatMessage).mockReturnValue(pending.promise);
    const user = userEvent.setup();

    renderAt('/social/chat/u2');
    const input = await screen.findByPlaceholderText('Message');

    await user.type(input, 'retry me');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(input).toBeDisabled());

    await act(async () => {
      pending.reject(new Error('send failed'));
    });

    // The error surfaces, but the draft is preserved and the caret stays put.
    await waitFor(() =>
      expect(screen.getByText(/couldn't send your message/i)).toBeInTheDocument(),
    );
    await waitFor(() => {
      expect(input).toHaveValue('retry me');
      expect(document.activeElement).toBe(input);
    });
  });

  test('a CHAT_BANNED send swaps the composer for a neutral banned notice', async () => {
    vi.mocked(sendChatMessage).mockRejectedValue(
      new ApiError(403, 'CHAT_BANNED', 'You cannot send messages.'),
    );
    const user = userEvent.setup();

    renderAt('/social/chat/u2');
    const input = await screen.findByPlaceholderText('Message');

    await user.type(input, 'hi');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    // The neutral, localized notice appears and the composer is gone — reading the
    // history is unaffected.
    await waitFor(() =>
      expect(screen.getByText(/can't send messages right now/i)).toBeInTheDocument(),
    );
    expect(screen.queryByPlaceholderText('Message')).not.toBeInTheDocument();
    // The generic send-error alert is NOT shown for a ban.
    expect(screen.queryByText(/couldn't send your message/i)).not.toBeInTheDocument();
  });

  test('at 390 px sends from a keyboard-sized thread while the log owns scrolling', async () => {
    setViewportWidth(390);
    const originalVisualViewport = window.visualViewport;
    const visualViewport = new EventTarget();
    Object.defineProperty(visualViewport, 'height', { value: 500 });
    Object.defineProperty(visualViewport, 'offsetTop', { value: 0 });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: visualViewport,
    });
    const pending = deferred<Awaited<ReturnType<typeof sendChatMessage>>>();
    vi.mocked(sendChatMessage).mockReturnValue(pending.promise);
    vi.mocked(listConversations).mockResolvedValue({
      conversations: [convo],
      unreadTotal: 0,
    });
    const user = userEvent.setup();
    const { container } = renderAt('/social/chat/u2');

    const input = await screen.findByRole('textbox', { name: 'Message' });
    const surface = container.querySelector<HTMLElement>('.bt-chat-page__surface');
    const log = screen.getByRole('log');
    expect(surface).toHaveStyle({ '--bt-chat-viewport-height': '500px' });
    expect(log).toHaveClass('bt-chat-log', 'overflow-y-auto');
    expect(input.closest('form')).toHaveClass('bt-chat-composer');
    expect(container.querySelector('aside ul')).toHaveClass('overflow-y-auto');

    await user.type(input, 'hello from phone');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(sendChatMessage).toHaveBeenCalledWith('c1', { body: 'hello from phone' }),
    );
    await waitFor(() => expect(input).toBeDisabled());
    await act(async () => {
      pending.resolve({
        id: 'm-phone',
        conversationId: 'c1',
        senderId: 'me',
        body: 'hello from phone',
        chip: null,
        createdAt: '2026-08-04T00:00:00.000Z',
      });
    });
    await waitFor(() => expect(input).toHaveFocus());
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: originalVisualViewport,
    });
    setViewportWidth(1024);
  });
});

describe('ChatPage — accessible message thread', () => {
  const conversation = {
    id: 'c1',
    user: { id: 'u2', username: 'bob' },
    unreadCount: 0,
    lastMessage: null,
    lastMessageAt: null,
  };
  type ThreadMessage = {
    id: string;
    conversationId: string;
    senderId: string;
    body: string | null;
    chip: null;
    createdAt: string;
  };
  const firstMessage: ThreadMessage = {
    id: 'm1',
    conversationId: 'c1',
    senderId: 'u2',
    body: 'First message',
    chip: null,
    createdAt: '2026-01-01T10:00:00.000Z',
  };

  function threadWith(messages: ThreadMessage[]) {
    return { conversation, nextCursor: null, messages };
  }

  async function refetchThread(queryClient: QueryClient) {
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['chat', 'thread', 'c1'] });
    });
  }

  function setScrollPosition(log: HTMLElement, scrollTop: number) {
    Object.defineProperties(log, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 1000 },
      scrollTop: { configurable: true, value: scrollTop, writable: true },
    });
    fireEvent.scroll(log);
  }

  beforeEach(() => {
    vi.mocked(listConversations).mockResolvedValue({ conversations: [], unreadTotal: 0 });
    vi.mocked(openConversation).mockResolvedValue(conversation);
  });

  test('renders incoming messages in a labelled, polite log and semantic list', async () => {
    const incoming: ThreadMessage = {
      id: 'm2',
      conversationId: 'c1',
      senderId: 'u2',
      body: 'A newer message',
      chip: null,
      createdAt: '2026-01-01T10:01:00.000Z',
    };
    vi.mocked(getThread).mockResolvedValue(threadWith([firstMessage]));

    const { queryClient } = renderAt('/social/chat/u2');
    const log = await screen.findByRole('log', { name: 'Messages with bob' });

    expect(log).toHaveAttribute('aria-live', 'polite');
    expect(log).toHaveAttribute('aria-relevant', 'additions text');
    await waitFor(() => expect(within(log).getByRole('list')).toBeInTheDocument());

    vi.mocked(getThread).mockResolvedValue(threadWith([incoming, firstMessage]));
    await refetchThread(queryClient);

    await waitFor(() => expect(within(log).getByText('A newer message')).toBeInTheDocument());
  });

  test('renders an own sent message once and returns to the latest message', async () => {
    const ownMessage: ThreadMessage = {
      id: 'm2',
      conversationId: 'c1',
      senderId: 'me',
      body: 'My reply',
      chip: null,
      createdAt: '2026-01-01T10:01:00.000Z',
    };
    vi.mocked(getThread).mockResolvedValue(threadWith([firstMessage]));
    vi.mocked(sendChatMessage).mockResolvedValue(undefined as never);
    const user = userEvent.setup();

    renderAt('/social/chat/u2');
    const log = await screen.findByRole('log', { name: 'Messages with bob' });
    const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView);
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    setScrollPosition(log, 0);
    scrollIntoView.mockClear();
    vi.mocked(getThread).mockResolvedValue(threadWith([ownMessage, firstMessage]));

    const input = screen.getByRole('textbox', { name: 'Message' });
    await user.type(input, 'My reply');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(within(log).getAllByText('My reply')).toHaveLength(1));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'end' });
    expect(screen.queryByRole('button', { name: 'New messages' })).not.toBeInTheDocument();
  });

  test('preserves older history and offers a new-message jump when scrolled away', async () => {
    const incoming: ThreadMessage = {
      id: 'm2',
      conversationId: 'c1',
      senderId: 'u2',
      body: 'A newer message',
      chip: null,
      createdAt: '2026-01-01T10:01:00.000Z',
    };
    vi.mocked(getThread).mockResolvedValue(threadWith([firstMessage]));
    const user = userEvent.setup();

    const { queryClient } = renderAt('/social/chat/u2');
    const log = await screen.findByRole('log', { name: 'Messages with bob' });
    const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView);
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    setScrollPosition(log, 0);
    scrollIntoView.mockClear();

    vi.mocked(getThread).mockResolvedValue(threadWith([incoming, firstMessage]));
    await refetchThread(queryClient);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'New messages' })).toBeInTheDocument(),
    );
    expect(log.scrollTop).toBe(0);
    expect(scrollIntoView).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'New messages' }));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'end' });
    expect(screen.queryByRole('button', { name: 'New messages' })).not.toBeInTheDocument();
  });

  test('continues following incoming messages while already near the bottom', async () => {
    const incoming: ThreadMessage = {
      id: 'm2',
      conversationId: 'c1',
      senderId: 'u2',
      body: 'A newer message',
      chip: null,
      createdAt: '2026-01-01T10:01:00.000Z',
    };
    vi.mocked(getThread).mockResolvedValue(threadWith([firstMessage]));

    const { queryClient } = renderAt('/social/chat/u2');
    const log = await screen.findByRole('log', { name: 'Messages with bob' });
    const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView);
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    setScrollPosition(log, 899);
    scrollIntoView.mockClear();

    vi.mocked(getThread).mockResolvedValue(threadWith([incoming, firstMessage]));
    await refetchThread(queryClient);

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'end' }));
    expect(screen.queryByRole('button', { name: 'New messages' })).not.toBeInTheDocument();
  });
});

describe('ChatPage — idea chips (V4-P9)', () => {
  beforeEach(() => {
    vi.mocked(listConversations).mockResolvedValue({ conversations: [], unreadTotal: 0 });
    vi.mocked(openConversation).mockResolvedValue({
      id: 'c1',
      user: { id: 'u2', username: 'bob' },
      unreadCount: 0,
      lastMessage: null,
      lastMessageAt: null,
    });
  });

  test('a not-shared idea chip shows the locked state and never the idea name', async () => {
    vi.mocked(getThread).mockResolvedValue({
      conversation: {
        id: 'c1',
        user: { id: 'u2', username: 'bob' },
        unreadCount: 0,
        lastMessage: null,
        lastMessageAt: null,
      },
      nextCursor: null,
      messages: [
        {
          id: 'm1',
          conversationId: 'c1',
          senderId: 'u2',
          body: null,
          chip: { kind: 'idea', subjectId: 'idea1', viewable: false, title: null, subtitle: null },
          createdAt: '2026-01-01T10:00:00.000Z',
        },
      ],
    });

    renderAt('/social/chat/u2');
    await waitFor(() => expect(screen.getByText('Not shared with you')).toBeInTheDocument());
    // The kind is named, but never a title/name (the server never resolves it).
    expect(screen.getByText('Idea')).toBeInTheDocument();
    expect(screen.queryByText('View')).not.toBeInTheDocument();
  });

  test('renders an attachable-item read failure inside the share picker', async () => {
    vi.mocked(getThread).mockResolvedValue({
      conversation: {
        id: 'c1',
        user: { id: 'u2', username: 'bob' },
        unreadCount: 0,
        lastMessage: null,
        lastMessageAt: null,
      },
      nextCursor: null,
      messages: [],
    });
    vi.mocked(listIdeas).mockRejectedValue(new Error('ideas unavailable'));
    const user = userEvent.setup();
    renderAt('/social/chat/u2');

    await user.click(await screen.findByRole('button', { name: 'Share an item' }));
    expect(await screen.findByText("This information isn't available.")).toBeInTheDocument();
  });

  // The picker's three sources are classified individually. A `??` collapse let
  // whichever error was declared first decide the class for all three, so both
  // orders are pinned here.
  test.each([
    {
      order: 'outage first',
      portfolios: new ApiError(503, 'UNAVAILABLE', 'down'),
      ideas: new ApiError(403, 'FORBIDDEN', 'secret'),
      recovered: listPortfolios,
      untouched: listIdeas,
    },
    {
      order: 'confirmed rejection first',
      portfolios: new ApiError(403, 'FORBIDDEN', 'secret'),
      ideas: new ApiError(503, 'UNAVAILABLE', 'down'),
      recovered: listIdeas,
      untouched: listPortfolios,
    },
  ])(
    'retries only the recoverable share-picker read ($order)',
    async ({ portfolios, ideas, recovered, untouched }) => {
      vi.mocked(getThread).mockResolvedValue({
        conversation: {
          id: 'c1',
          user: { id: 'u2', username: 'bob' },
          unreadCount: 0,
          lastMessage: null,
          lastMessageAt: null,
        },
        nextCursor: null,
        messages: [],
      });
      vi.mocked(listPortfolios).mockRejectedValue(portfolios);
      vi.mocked(listIdeas).mockRejectedValue(ideas);
      const user = userEvent.setup();
      renderAt('/social/chat/u2');

      await user.click(await screen.findByRole('button', { name: 'Share an item' }));
      const retry = await screen.findByRole('button', { name: 'Try again' });
      const recoveredBefore = vi.mocked(recovered).mock.calls.length;
      const untouchedBefore = vi.mocked(untouched).mock.calls.length;

      await user.click(retry);

      await waitFor(() => expect(vi.mocked(recovered).mock.calls.length).toBe(recoveredBefore + 1));
      // The confirmed rejection is never re-run on the outage's behalf.
      expect(vi.mocked(untouched).mock.calls.length).toBe(untouchedBefore);
      expect(screen.queryByText('secret')).not.toBeInTheDocument();
    },
  );

  test('attaches an idea chip from the share picker (never widens access)', async () => {
    vi.mocked(getThread).mockResolvedValue({
      conversation: {
        id: 'c1',
        user: { id: 'u2', username: 'bob' },
        unreadCount: 0,
        lastMessage: null,
        lastMessageAt: null,
      },
      nextCursor: null,
      messages: [],
    });
    vi.mocked(listIdeas).mockResolvedValue({
      ideas: [
        {
          id: 'idea1',
          name: 'Momentum basket',
          thesis: null,
          state: {
            source: { kind: 'adhoc', positions: [{ assetId: 'a1', weight: 1 }] },
            range: '5Y',
            benchmark: null,
            mode: 'clip',
            rebalance: 'none',
          },
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    vi.mocked(sendChatMessage).mockResolvedValue(undefined as never);

    const user = userEvent.setup();
    renderAt('/social/chat/u2');
    await screen.findByPlaceholderText('Message');

    await user.click(screen.getByRole('button', { name: 'Share an item' }));
    await user.click(await screen.findByRole('button', { name: /momentum basket/i }));

    await waitFor(() =>
      expect(sendChatMessage).toHaveBeenCalledWith('c1', {
        chip: { kind: 'idea', subjectId: 'idea1' },
      }),
    );
  });

  test('never offers a vaulted portfolio in the chat share picker', async () => {
    vi.mocked(getThread).mockResolvedValue({
      conversation: {
        id: 'c1',
        user: { id: 'u2', username: 'bob' },
        unreadCount: 0,
        lastMessage: null,
        lastMessageAt: null,
      },
      nextCursor: null,
      messages: [],
    });
    vi.mocked(listPortfolios).mockResolvedValue({
      portfolios: [
        {
          id: '018f0000-0000-7000-8000-000000000001',
          name: 'Plain portfolio',
          sortOrder: 0,
          visibility: 'private',
          isDefault: true,
          defaultPayFromCash: false,
          archivedAt: null,
        },
        {
          id: '018f0000-0000-7000-8000-000000000002',
          name: 'Secret vaulted name',
          vaultId: '018f0000-0000-7000-8000-000000000003',
          vaultAlias: 'Vault portfolio 1',
          sortOrder: 1,
          visibility: 'private',
          isDefault: false,
          defaultPayFromCash: false,
          archivedAt: null,
        },
      ],
    });
    const user = userEvent.setup();
    renderAt('/social/chat/u2');

    await user.click(await screen.findByRole('button', { name: 'Share an item' }));
    expect(await screen.findByText('Plain portfolio')).toBeInTheDocument();
    expect(screen.queryByText('Secret vaulted name')).not.toBeInTheDocument();
    expect(screen.queryByText('Vault portfolio 1')).not.toBeInTheDocument();
  });
});
