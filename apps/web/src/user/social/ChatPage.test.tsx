import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../lib/chatApi', () => ({
  listConversations: vi.fn(),
  openConversation: vi.fn(),
  getThread: vi.fn(),
  sendChatMessage: vi.fn(),
  markConversationRead: vi.fn(),
}));
vi.mock('../../lib/socialApi', () => ({ listFriends: vi.fn() }));
vi.mock('../../lib/portfolioApi', () => ({ listPortfolios: vi.fn() }));
vi.mock('../../lib/conglomerateApi', () => ({ listConglomerates: vi.fn() }));
vi.mock('../AuthContext', () => ({ useAuth: () => ({ user: { id: 'me', username: 'me' } }) }));

import { MemoryRouter, Route, Routes } from 'react-router-dom';

import {
  getThread,
  listConversations,
  markConversationRead,
  openConversation,
} from '../../lib/chatApi';
import { ChatPage } from './ChatPage';

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
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
