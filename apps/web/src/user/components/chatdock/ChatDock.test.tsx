import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Same mocking approach as ChatPage.test.tsx: the chat surface is the real
// component tree, only its data modules are stubbed.
vi.mock('../../../lib/chatApi', () => ({
  listConversations: vi.fn(),
  openConversation: vi.fn(),
  getThread: vi.fn(),
  sendChatMessage: vi.fn(),
  markConversationRead: vi.fn(),
}));
vi.mock('../../../lib/socialApi', () => ({
  listFriends: vi.fn(),
  getAudience: vi.fn(),
  setAudience: vi.fn(),
}));
vi.mock('../../../lib/portfolioApi', () => ({ listPortfolios: vi.fn() }));
vi.mock('../../../lib/conglomerateApi', () => ({ listConglomerates: vi.fn() }));
vi.mock('../../../lib/ideasApi', () => ({ listIdeas: vi.fn() }));
vi.mock('../../AuthContext', () => ({ useAuth: () => ({ user: { id: 'me', username: 'me' } }) }));

import { MemoryRouter } from 'react-router-dom';

import {
  getThread,
  listConversations,
  markConversationRead,
  openConversation,
  sendChatMessage,
} from '../../../lib/chatApi';
import { listConglomerates } from '../../../lib/conglomerateApi';
import { listIdeas } from '../../../lib/ideasApi';
import { listPortfolios } from '../../../lib/portfolioApi';
import { ChatDock } from './ChatDock';
import { ChatDockToggle } from './ChatDockToggle';
import { resetChatDockCache } from './chatDockStore';
import { DOCK_MIN_WIDTH } from './useDockEligible';

const STORAGE_KEY = 'bt.chatdock';

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

/** The shell's two mount points: the topbar trigger and the dock at the root. */
function renderShell() {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter initialEntries={['/portfolio']}>
        <ChatDockToggle />
        <ChatDock />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function setViewportWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width, writable: true });
}

const originalWidth = window.innerWidth;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  resetChatDockCache();
  setViewportWidth(1280); // a desktop viewport: the dock is eligible
  // jsdom has no scrollIntoView; the thread auto-scroll calls it.
  Element.prototype.scrollIntoView = vi.fn();
  vi.mocked(markConversationRead).mockResolvedValue(undefined);
  vi.mocked(listConversations).mockResolvedValue({ conversations: [], unreadTotal: 0 });
  vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [] });
  vi.mocked(listConglomerates).mockResolvedValue({ conglomerates: [] });
  vi.mocked(listIdeas).mockResolvedValue({ ideas: [] });
});

afterEach(() => {
  setViewportWidth(originalWidth);
  localStorage.clear();
  resetChatDockCache();
});

const toggle = () => screen.getByRole('button', { name: /^Chat/ });
const dock = () => screen.queryByRole('complementary', { name: 'Chat dock' });

describe('ChatDock — open, close, persistence', () => {
  test('the topbar toggle opens and closes the dock and reports aria-expanded', async () => {
    const user = userEvent.setup();
    renderShell();

    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(dock()).toBeNull();

    await user.click(toggle());
    await waitFor(() => expect(dock()).toBeInTheDocument());
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');

    await user.click(toggle());
    await waitFor(() => expect(dock()).toBeNull());
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
  });

  test('the dock is NON-MODAL: no scrim, no aria-modal, no scroll lock', async () => {
    const user = userEvent.setup();
    const { container } = renderShell();

    await user.click(toggle());
    await waitFor(() => expect(dock()).toBeInTheDocument());

    // The page underneath must stay fully interactive — that is the whole point.
    expect(container.querySelector('.bt-scrim')).toBeNull();
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  test('the close button dismisses the dock', async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(toggle());
    await user.click(await screen.findByRole('button', { name: 'Close chat' }));

    await waitFor(() => expect(dock()).toBeNull());
  });

  test('Escape closes the dock while focus is inside it', async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(toggle());
    const close = await screen.findByRole('button', { name: 'Close chat' });
    close.focus();

    await user.keyboard('{Escape}');

    await waitFor(() => expect(dock()).toBeNull());
  });

  test('open state and the last tab persist to localStorage', async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(toggle());
    await user.click(await screen.findByRole('tab', { name: 'Ask BetterTrack' }));

    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toEqual({
        open: true,
        tab: 'ask',
      }),
    );
  });

  test('a persisted open dock is restored on its last tab', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ open: true, tab: 'ask' }));
    resetChatDockCache();

    renderShell();

    await waitFor(() => expect(dock()).toBeInTheDocument());
    expect(await screen.findByRole('tab', { name: 'Ask BetterTrack' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  test('corrupt persisted state degrades to a closed dock instead of throwing', async () => {
    localStorage.setItem(STORAGE_KEY, 'not json at all');
    resetChatDockCache();

    renderShell();

    expect(dock()).toBeNull();
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('ChatDock — tabs', () => {
  test('switches between the real chat and the parked Ask surface', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(toggle());

    // Chats is the default tab — the real conversation list header.
    expect(await screen.findByRole('tab', { name: 'Chats' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('button', { name: 'New message' })).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Ask BetterTrack' }));

    // The Ask tab reuses the /ask parked copy verbatim — no invented AI claims.
    expect(await screen.findByText('In the works')).toBeInTheDocument();
    expect(
      screen.getByText(/You choose exactly which portfolios the answer may read/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New message' })).toBeNull();
  });

  test('the Ask composer is present but inert — no fake AI conversation', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(toggle());
    await user.click(await screen.findByRole('tab', { name: 'Ask BetterTrack' }));

    const input = await screen.findByPlaceholderText('Ask about your portfolios');
    expect(input).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    await user.type(input, 'what is my exposure?');
    expect(input).toHaveValue('');
  });
});

describe('ChatDock — the real chat inside the dock', () => {
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

  test('shows the unread gold dot on the toggle when a conversation is unread', async () => {
    withConversation();
    renderShell();

    await waitFor(() => expect(toggle()).toHaveAccessibleName('Chat (unread messages)'));
    expect(toggle().querySelector('.bt-dot--gold')).not.toBeNull();
  });

  test('opens a conversation in the dock and sends a message', async () => {
    withConversation();
    vi.mocked(sendChatMessage).mockResolvedValue({
      id: 'm2',
      conversationId: 'c1',
      senderId: 'me',
      body: 'hi back',
      chip: null,
      createdAt: '2026-01-01T10:05:00.000Z',
    });
    const user = userEvent.setup();
    renderShell();
    await user.click(toggle());

    // The conversation list is the real one, unread state included.
    const panel = within(dock()!);
    await user.click(await panel.findByRole('button', { name: /bob/ }));

    // The thread opens IN the dock, with the existing history.
    await waitFor(() => expect(openConversation).toHaveBeenCalledWith('u2'));
    expect(await panel.findByText('hello there')).toBeInTheDocument();

    const input = await panel.findByPlaceholderText('Message');
    await user.type(input, 'hi back');
    await user.click(panel.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(sendChatMessage).toHaveBeenCalledWith('c1', { body: 'hi back' }));
    // Opening the thread marks it read, exactly as the page does.
    await waitFor(() => expect(markConversationRead).toHaveBeenCalledWith('c1'));
  });

  test('back returns to the conversation list without navigating the page', async () => {
    withConversation();
    const user = userEvent.setup();
    renderShell();
    await user.click(toggle());

    const panel = within(dock()!);
    await user.click(await panel.findByRole('button', { name: /bob/ }));
    await panel.findByPlaceholderText('Message');

    await user.click(panel.getByRole('button', { name: 'Back' }));

    // The list is back and the composer is gone — all inside the dock.
    expect(await panel.findByRole('button', { name: 'New message' })).toBeInTheDocument();
    expect(panel.queryByPlaceholderText('Message')).toBeNull();
    // The dock never routes: the page under it is still /portfolio.
    expect(dock()).toBeInTheDocument();
  });
});

describe('ChatDock — below the dock breakpoint', () => {
  test('the toggle becomes a link to /people/chat and the dock never opens', async () => {
    setViewportWidth(DOCK_MIN_WIDTH - 100);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ open: true, tab: 'chats' }));
    resetChatDockCache();

    renderShell();

    // A navigation, not a disclosure — so no aria-expanded, and no dock.
    const link = screen.getByRole('link', { name: 'Chat' });
    expect(link).toHaveAttribute('href', '/people/chat');
    expect(link).not.toHaveAttribute('aria-expanded');
    expect(dock()).toBeNull();
  });
});
