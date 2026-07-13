import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
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
  getAudience: vi.fn(),
  setAudience: vi.fn(),
}));
vi.mock('../../lib/portfolioApi', () => ({ listPortfolios: vi.fn() }));
vi.mock('../../lib/conglomerateApi', () => ({ listConglomerates: vi.fn() }));
vi.mock('../AuthContext', () => ({ useAuth: () => ({ user: { id: 'me', username: 'me' } }) }));

import { MemoryRouter, Route, Routes } from 'react-router-dom';

import {
  getThread,
  listConversations,
  markConversationRead,
  openConversation,
  sendChatMessage,
} from '../../lib/chatApi';
import { getAudience, setAudience } from '../../lib/socialApi';
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
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/social/chat" element={<ChatPage />} />
          <Route path="/social/chat/:userId" element={<ChatPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom has no scrollIntoView; the thread auto-scroll calls it.
  Element.prototype.scrollIntoView = vi.fn();
  vi.mocked(markConversationRead).mockResolvedValue(undefined);
});

describe('ChatPage — conversation list', () => {
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
    vi.mocked(openConversation).mockRejectedValue(new Error('not found'));
    renderAt('/social/chat/u2');
    await waitFor(() => expect(screen.getByText("You're not connected")).toBeInTheDocument());
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
      link: { active: false, createdAt: null },
    });
    vi.mocked(setAudience).mockResolvedValue({
      state: {
        kind: 'portfolio',
        subjectId: 'p1',
        audience: 'specific_friends',
        friendIds: ['u2'],
        link: { active: false, createdAt: null },
      },
    });
    const user = userEvent.setup();

    renderAt('/social/chat/u2');

    await waitFor(() => expect(screen.getByText(/bob can't see this/i)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Share it with just them' }));

    // The shortcut only ever ADDS the named friend to a specific-friends audience.
    await waitFor(() =>
      expect(setAudience).toHaveBeenCalledWith('portfolio', 'p1', {
        audience: 'specific_friends',
        friendIds: ['u2'],
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
      link: { active: false, createdAt: null },
    });
    vi.mocked(setAudience).mockResolvedValue({
      state: {
        kind: 'portfolio',
        subjectId: 'p1',
        audience: 'specific_friends',
        friendIds: ['u9', 'u2'],
        link: { active: false, createdAt: null },
      },
    });
    const user = userEvent.setup();

    renderAt('/social/chat/u2');

    await user.click(await screen.findByRole('button', { name: 'Share it with just them' }));

    await waitFor(() =>
      expect(setAudience).toHaveBeenCalledWith('portfolio', 'p1', {
        audience: 'specific_friends',
        friendIds: ['u9', 'u2'],
      }),
    );
  });

  test('shows no shortcut when the recipient can already see the item', async () => {
    ownerChipThread('me');
    vi.mocked(getAudience).mockResolvedValue({
      kind: 'portfolio',
      subjectId: 'p1',
      audience: 'all_friends',
      friendIds: [],
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

  test('opening a conversation puts the caret in the message input', async () => {
    renderAt('/social/chat/u2');

    const input = await screen.findByPlaceholderText('Message');
    await waitFor(() => expect(document.activeElement).toBe(input));
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
});
