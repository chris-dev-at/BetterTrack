import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

// Same mocking approach as ChatPage.test.tsx: the real chat surface, stubbed data.
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
vi.mock('../../lib/ideasApi', () => ({ listIdeas: vi.fn() }));
vi.mock('../AuthContext', () => ({ useAuth: () => ({ user: { id: 'me', username: 'me' } }) }));

import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import {
  getThread,
  listConversations,
  markConversationRead,
  openConversation,
  sendChatMessage,
} from '../../lib/chatApi';
import { listConglomerates } from '../../lib/conglomerateApi';
import { listIdeas } from '../../lib/ideasApi';
import { listPortfolios } from '../../lib/portfolioApi';
import { ChatPage } from './ChatPage';
import { ChatWindowPage } from './ChatWindowPage';
import { CHAT_WINDOW_FEATURES, CHAT_WINDOW_NAME } from './chatWindow';

const CONVO = {
  id: 'c1',
  user: { id: 'u2', username: 'bob' },
  unreadCount: 0,
  lastMessage: null,
  lastMessageAt: null,
};

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
}

/** Mirrors the live URL so the popup-blocked fallback can be asserted. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

/** The routes as UserApp registers them: the page inside the shell, the window outside. */
function renderAt(path: string) {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <LocationProbe />
        <Routes>
          <Route path="/people/chat" element={<ChatPage />} />
          <Route path="/people/chat/c/:conversationId" element={<ChatPage />} />
          <Route path="/people/chat/:userId" element={<ChatPage />} />
          <Route path="/chat-window" element={<ChatWindowPage />} />
          <Route path="/chat-window/c/:conversationId" element={<ChatWindowPage />} />
          <Route path="/chat-window/:userId" element={<ChatWindowPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const withConversation = () => {
  vi.mocked(listConversations).mockResolvedValue({
    conversations: [
      {
        ...CONVO,
        unreadCount: 2,
        lastMessage: {
          senderId: 'u2',
          body: 'hello there',
          chipKind: null,
          createdAt: '2026-01-01T10:00:00.000Z',
        },
        lastMessageAt: '2026-01-01T10:00:00.000Z',
      },
    ],
    unreadTotal: 2,
  });
  vi.mocked(openConversation).mockResolvedValue(CONVO);
  vi.mocked(getThread).mockResolvedValue({
    conversation: CONVO,
    nextCursor: null,
    messages: [
      {
        id: 'm1',
        conversationId: 'c1',
        senderId: 'u2',
        body: 'hello there',
        chip: null,
        createdAt: '2026-01-01T10:00:00.000Z',
      },
    ],
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom has no scrollIntoView; the thread auto-scroll calls it.
  Element.prototype.scrollIntoView = vi.fn();
  vi.mocked(markConversationRead).mockResolvedValue(undefined);
  vi.mocked(listConversations).mockResolvedValue({ conversations: [], unreadTotal: 0 });
  vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [] });
  vi.mocked(listConglomerates).mockResolvedValue({ conglomerates: [] });
  vi.mocked(listIdeas).mockResolvedValue({ ideas: [] });
});

describe('ChatPage — pop-out control', () => {
  test('opens a named, sized window at the pop-out route', async () => {
    // jsdom does not implement window.open; a stub is also how the blocked path
    // below is simulated.
    const open = vi.fn().mockReturnValue({ focus: vi.fn() });
    vi.stubGlobal('open', open);
    const user = userEvent.setup();

    renderAt('/people/chat');
    await user.click(await screen.findByRole('button', { name: 'Pop out' }));

    expect(open).toHaveBeenCalledWith('/chat-window', CHAT_WINDOW_NAME, CHAT_WINDOW_FEATURES);
    // The page itself is untouched — popping out must not close or replace it.
    expect(screen.getByTestId('location')).toHaveTextContent('/people/chat');
    vi.unstubAllGlobals();
  });

  test('carries the open thread into the pop-out', async () => {
    withConversation();
    const open = vi.fn().mockReturnValue({ focus: vi.fn() });
    vi.stubGlobal('open', open);
    const user = userEvent.setup();

    renderAt('/people/chat/u2');
    await user.click(await screen.findByRole('button', { name: 'Pop out' }));

    expect(open).toHaveBeenCalledWith('/chat-window/u2', CHAT_WINDOW_NAME, CHAT_WINDOW_FEATURES);
    vi.unstubAllGlobals();
  });

  test('a thread with a deleted partner pops out by conversation id (#362)', async () => {
    const open = vi.fn().mockReturnValue({ focus: vi.fn() });
    vi.stubGlobal('open', open);
    vi.mocked(getThread).mockResolvedValue({
      conversation: { ...CONVO, user: null },
      nextCursor: null,
      messages: [],
    });
    const user = userEvent.setup();

    renderAt('/people/chat/c/c1');
    await user.click(await screen.findByRole('button', { name: 'Pop out' }));

    expect(open).toHaveBeenCalledWith('/chat-window/c/c1', CHAT_WINDOW_NAME, CHAT_WINDOW_FEATURES);
    vi.unstubAllGlobals();
  });

  test('a blocked popup falls back to navigating to the same route', async () => {
    // A blocked popup is exactly what a null return means.
    vi.stubGlobal('open', vi.fn().mockReturnValue(null));
    const user = userEvent.setup();

    renderAt('/people/chat');
    await user.click(await screen.findByRole('button', { name: 'Pop out' }));

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/chat-window'));
    vi.unstubAllGlobals();
  });
});

describe('ChatWindowPage — the standalone second-screen window', () => {
  test('renders the chat with no shell chrome around it', async () => {
    withConversation();
    renderAt('/chat-window');

    // The real conversation list, unread state included.
    await waitFor(() => expect(screen.getByText('bob')).toBeInTheDocument());
    expect(screen.getByText('hello there')).toBeInTheDocument();

    // No rail, no topbar, no bottombar, no footer, no page head.
    expect(screen.queryByRole('navigation', { name: 'Primary' })).toBeNull();
    expect(screen.queryByRole('banner')).toBeNull();
    expect(screen.queryByRole('contentinfo')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pop out' })).toBeNull();
    expect(document.querySelector('.bt-topbar')).toBeNull();
    expect(document.querySelector('.bt-rail')).toBeNull();
  });

  test('a deep link opens straight into that thread and can send', async () => {
    withConversation();
    vi.mocked(sendChatMessage).mockResolvedValue({
      id: 'm2',
      conversationId: 'c1',
      senderId: 'me',
      body: 'from the popout',
      chip: null,
      createdAt: '2026-01-01T10:05:00.000Z',
    });
    const user = userEvent.setup();

    renderAt('/chat-window/u2');

    await waitFor(() => expect(openConversation).toHaveBeenCalledWith('u2'));
    expect(await screen.findByText('hello there')).toBeInTheDocument();

    const input = await screen.findByPlaceholderText('Message');
    await user.type(input, 'from the popout');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(sendChatMessage).toHaveBeenCalledWith('c1', { body: 'from the popout' }),
    );
    // Reading in the pop-out clears the badge, exactly as the page does.
    await waitFor(() => expect(markConversationRead).toHaveBeenCalledWith('c1'));
  });

  test('selecting a conversation routes the window, so a refresh stays put', async () => {
    withConversation();
    const user = userEvent.setup();

    renderAt('/chat-window');
    await user.click(await screen.findByRole('button', { name: /bob/ }));

    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/chat-window/u2'),
    );
    expect(await screen.findByPlaceholderText('Message')).toBeInTheDocument();
  });

  test('back inside the window returns to the conversation list', async () => {
    withConversation();
    const user = userEvent.setup();

    renderAt('/chat-window/u2');
    await screen.findByPlaceholderText('Message');

    await user.click(screen.getByRole('button', { name: 'Back' }));

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/chat-window'));
    expect(await screen.findByRole('button', { name: 'New message' })).toBeInTheDocument();
  });

  test('the in-app page keeps its own master-detail layout', async () => {
    withConversation();
    renderAt('/people/chat/u2');

    // The page still shows its head + list beside the thread (the pop-out is an
    // addition, not a replacement).
    expect(await screen.findByRole('button', { name: 'Pop out' })).toBeInTheDocument();
    const row = await screen.findByRole('button', { name: /bob/ });
    expect(within(row).getByText('hello there')).toBeInTheDocument();
    expect(await screen.findByPlaceholderText('Message')).toBeInTheDocument();
  });
});
