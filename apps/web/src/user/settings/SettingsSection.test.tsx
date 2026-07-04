import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../lib/settingsApi', () => ({
  getNotificationSettings: vi.fn(),
  updateNotificationSettings: vi.fn(),
}));

vi.mock('../../lib/notificationsApi', () => ({
  listNotifications: vi.fn(),
  markNotificationsRead: vi.fn(),
}));

import type { Notification, NotificationListResponse } from '@bettertrack/contracts';

import { listNotifications, markNotificationsRead } from '../../lib/notificationsApi';
import { getNotificationSettings, updateNotificationSettings } from '../../lib/settingsApi';
import { NotificationSettingsPage } from './SettingsSection';

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
}

function renderPage() {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <NotificationSettingsPage />
    </QueryClientProvider>,
  );
}

function notification(overrides: Partial<Notification>): Notification {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    type: 'friend.request',
    title: 'New friend request',
    body: 'jane sent you a friend request',
    payload: undefined,
    readAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const EMPTY_LIST_RESPONSE: NotificationListResponse = {
  items: [],
  nextCursor: null,
  unreadCount: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getNotificationSettings).mockResolvedValue({
    inapp: { enabled: true },
    email: { enabled: true },
  });
  vi.mocked(listNotifications).mockResolvedValue(EMPTY_LIST_RESPONSE);
  vi.mocked(markNotificationsRead).mockResolvedValue(undefined);
});

describe('NotificationSettingsPage', () => {
  test('reads the settings and renders in-app locked on', async () => {
    renderPage();

    const inApp = await screen.findByRole('switch', { name: 'In-app' });
    expect(inApp).toBeChecked();
    expect(inApp).toBeDisabled();

    expect(screen.getByRole('switch', { name: 'Email' })).toBeChecked();
  });

  test('toggling email off writes the setting and reflects the new state', async () => {
    vi.mocked(updateNotificationSettings).mockResolvedValue({
      inapp: { enabled: true },
      email: { enabled: false },
    });
    const user = userEvent.setup();
    renderPage();

    const email = await screen.findByRole('switch', { name: 'Email' });
    expect(email).toBeChecked();

    await user.click(email);

    expect(updateNotificationSettings).toHaveBeenCalledWith({ email: { enabled: false } });
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Email' })).not.toBeChecked());
  });

  test('shows an error affordance when settings fail to load', async () => {
    vi.mocked(getNotificationSettings).mockRejectedValue(new Error('nope'));
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/Couldn't load your notification settings/i)).toBeInTheDocument(),
    );
  });

  test('renders the full notification list with read/unread distinction', async () => {
    vi.mocked(listNotifications).mockResolvedValue({
      items: [
        notification({
          id: '00000000-0000-0000-0000-000000000002',
          title: 'Unread item',
          readAt: null,
        }),
        notification({
          id: '00000000-0000-0000-0000-000000000003',
          title: 'Read item',
          readAt: new Date().toISOString(),
        }),
      ],
      nextCursor: null,
      unreadCount: 1,
    });
    renderPage();

    expect(await screen.findByText('Unread item')).toBeInTheDocument();
    expect(screen.getByText('Read item')).toBeInTheDocument();
    // The toggle panel still renders alongside the list.
    expect(screen.getByRole('switch', { name: 'Email' })).toBeInTheDocument();
  });

  test('shows an empty state when there are no notifications', async () => {
    renderPage();

    expect(await screen.findByText('No notifications yet')).toBeInTheDocument();
  });

  test('"Load more" pages beyond the first page via cursor', async () => {
    const user = userEvent.setup();
    vi.mocked(listNotifications).mockImplementation(async (params = {}) => {
      if (!params.cursor) {
        return {
          items: [notification({ id: '00000000-0000-0000-0000-000000000002', title: 'Page 1' })],
          nextCursor: '00000000-0000-0000-0000-000000000002',
          unreadCount: 2,
        };
      }
      return {
        items: [notification({ id: '00000000-0000-0000-0000-000000000003', title: 'Page 2' })],
        nextCursor: null,
        unreadCount: 2,
      };
    });
    renderPage();

    expect(await screen.findByText('Page 1')).toBeInTheDocument();
    expect(screen.queryByText('Page 2')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('Page 2')).toBeInTheDocument();
    expect(vi.mocked(listNotifications)).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: '00000000-0000-0000-0000-000000000002' }),
      expect.anything(),
    );
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  test('clicking an unread notification marks it read via the API', async () => {
    const user = userEvent.setup();
    vi.mocked(listNotifications)
      .mockResolvedValueOnce({
        items: [notification({ id: '00000000-0000-0000-0000-000000000002' })],
        nextCursor: null,
        unreadCount: 1,
      })
      .mockResolvedValue(EMPTY_LIST_RESPONSE);
    renderPage();

    await user.click(await screen.findByText('New friend request'));

    await waitFor(() =>
      expect(vi.mocked(markNotificationsRead)).toHaveBeenCalledWith({
        ids: ['00000000-0000-0000-0000-000000000002'],
      }),
    );
  });

  test('"Mark all read" calls the API and clears the badge without a page reload', async () => {
    const user = userEvent.setup();
    vi.mocked(listNotifications)
      .mockResolvedValueOnce({
        items: [
          notification({ id: '00000000-0000-0000-0000-000000000002' }),
          notification({ id: '00000000-0000-0000-0000-000000000003' }),
        ],
        nextCursor: null,
        unreadCount: 2,
      })
      .mockResolvedValue(EMPTY_LIST_RESPONSE);
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Mark all read' }));

    await waitFor(() =>
      expect(vi.mocked(markNotificationsRead)).toHaveBeenCalledWith({ all: true }),
    );
    await waitFor(() => expect(screen.getByText('No notifications yet')).toBeInTheDocument());
  });

  test('"Mark all read" is disabled when there are no unread notifications', async () => {
    renderPage();

    expect(await screen.findByRole('button', { name: 'Mark all read' })).toBeDisabled();
  });

  test('shows a loading skeleton before the full list resolves', async () => {
    let resolveFetch!: (value: NotificationListResponse) => void;
    vi.mocked(listNotifications).mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    renderPage();

    expect(await screen.findAllByRole('status')).not.toHaveLength(0);

    resolveFetch(EMPTY_LIST_RESPONSE);
    await waitFor(() => expect(screen.getByText('No notifications yet')).toBeInTheDocument());
  });

  test('shows an error state when the full list fails to load', async () => {
    vi.mocked(listNotifications).mockRejectedValue(new Error('boom'));
    renderPage();

    expect(await screen.findByText("Couldn't load your notifications")).toBeInTheDocument();
  });

  test('keeps the previously loaded list visible when a background refetch fails', async () => {
    const user = userEvent.setup();
    vi.mocked(listNotifications)
      .mockResolvedValueOnce({
        items: [notification({ id: '00000000-0000-0000-0000-000000000002' })],
        nextCursor: null,
        unreadCount: 1,
      })
      .mockRejectedValueOnce(new Error('network blip'));
    renderPage();

    expect(await screen.findByText('New friend request')).toBeInTheDocument();

    await user.click(screen.getByText('New friend request'));

    await waitFor(() => expect(vi.mocked(listNotifications)).toHaveBeenCalledTimes(2));
    expect(screen.getByText('New friend request')).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load your notifications")).not.toBeInTheDocument();
  });

  test('surfaces a mark-read failure instead of doing nothing visibly', async () => {
    const user = userEvent.setup();
    vi.mocked(listNotifications).mockResolvedValue({
      items: [notification({ id: '00000000-0000-0000-0000-000000000002' })],
      nextCursor: null,
      unreadCount: 1,
    });
    vi.mocked(markNotificationsRead).mockRejectedValue(new Error('boom'));
    renderPage();

    await user.click(await screen.findByText('New friend request'));

    expect(await screen.findByText(/Couldn't update that notification/i)).toBeInTheDocument();
  });

  test('only disables the row currently being marked read, not the whole list', async () => {
    const user = userEvent.setup();
    let resolveMarkRead!: () => void;
    vi.mocked(listNotifications).mockResolvedValue({
      items: [
        notification({ id: '00000000-0000-0000-0000-000000000002', title: 'First' }),
        notification({ id: '00000000-0000-0000-0000-000000000003', title: 'Second' }),
      ],
      nextCursor: null,
      unreadCount: 2,
    });
    vi.mocked(markNotificationsRead).mockReturnValue(
      new Promise((resolve) => {
        resolveMarkRead = () => resolve(undefined);
      }),
    );
    renderPage();

    await user.click(await screen.findByText('First'));

    expect(screen.getByText('First').closest('button')).toBeDisabled();
    expect(screen.getByText('Second').closest('button')).not.toBeDisabled();

    resolveMarkRead();
    await waitFor(() => expect(vi.mocked(markNotificationsRead)).toHaveBeenCalled());
  });
});
