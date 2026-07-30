import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../lib/notificationsApi', () => ({
  listNotifications: vi.fn(),
  markNotificationsRead: vi.fn(),
  archiveNotification: vi.fn(),
  unarchiveNotification: vi.fn(),
  deleteNotification: vi.fn(),
  deleteNotifications: vi.fn(),
}));

import type { Notification, NotificationListResponse } from '@bettertrack/contracts';

import {
  archiveNotification,
  deleteNotification,
  deleteNotifications,
  listNotifications,
  markNotificationsRead,
  unarchiveNotification,
} from '../../../lib/notificationsApi';
import { NotificationLogPanel } from './NotificationLogPanel';

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
}

function renderPanel() {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <NotificationLogPanel />
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
    archivedAt: null,
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
  vi.mocked(listNotifications).mockResolvedValue(EMPTY_LIST_RESPONSE);
  vi.mocked(markNotificationsRead).mockResolvedValue(undefined);
  vi.mocked(archiveNotification).mockResolvedValue(undefined);
  vi.mocked(unarchiveNotification).mockResolvedValue(undefined);
  vi.mocked(deleteNotification).mockResolvedValue(undefined);
  vi.mocked(deleteNotifications).mockResolvedValue(undefined);
});

describe('NotificationLogPanel', () => {
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
    renderPanel();

    expect(await screen.findByText('Unread item')).toBeInTheDocument();
    expect(screen.getByText('Read item')).toBeInTheDocument();
    // R2 split: the routing grid is NOT here any more — it is the Notifications
    // panel's business. This panel is the inbox and nothing else.
    expect(
      screen.queryByRole('switch', { name: 'Friend requests via In-app' }),
    ).not.toBeInTheDocument();
  });

  test('shows an empty state when there are no notifications', async () => {
    renderPanel();

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
    renderPanel();

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
    renderPanel();

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
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Mark all read' }));

    await waitFor(() =>
      expect(vi.mocked(markNotificationsRead)).toHaveBeenCalledWith({ all: true }),
    );
    await waitFor(() => expect(screen.getByText('No notifications yet')).toBeInTheDocument());
  });

  test('"Mark all read" is disabled when there are no unread notifications', async () => {
    renderPanel();

    expect(await screen.findByRole('button', { name: 'Mark all read' })).toBeDisabled();
  });

  test('shows a loading skeleton before the full list resolves', async () => {
    let resolveFetch!: (value: NotificationListResponse) => void;
    vi.mocked(listNotifications).mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    renderPanel();

    expect(await screen.findAllByRole('status')).not.toHaveLength(0);

    resolveFetch(EMPTY_LIST_RESPONSE);
    await waitFor(() => expect(screen.getByText('No notifications yet')).toBeInTheDocument());
  });

  test('shows an error state when the full list fails to load', async () => {
    vi.mocked(listNotifications).mockRejectedValue(new Error('boom'));
    renderPanel();

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
    renderPanel();

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
    renderPanel();

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
    renderPanel();

    await user.click(await screen.findByText('First'));

    expect(screen.getByText('First').closest('button')).toBeDisabled();
    expect(screen.getByText('Second').closest('button')).not.toBeDisabled();

    resolveMarkRead();
    await waitFor(() => expect(vi.mocked(markNotificationsRead)).toHaveBeenCalled());
  });

  // ── Archive state + deletion (#437) ─────────────────────────────────────────

  test('defaults to the Active view and requests it from the API', async () => {
    renderPanel();

    await waitFor(() =>
      expect(vi.mocked(listNotifications)).toHaveBeenCalledWith(
        expect.objectContaining({ view: 'active' }),
        expect.anything(),
      ),
    );
    expect(screen.getByRole('tab', { name: 'Active' })).toHaveAttribute('aria-selected', 'true');
  });

  test('the Archived tab fetches the archived view and offers Unarchive', async () => {
    const user = userEvent.setup();
    vi.mocked(listNotifications).mockImplementation(async (params = {}) =>
      params.view === 'archived'
        ? {
            items: [
              notification({
                id: '00000000-0000-0000-0000-000000000002',
                title: 'Old news',
                readAt: new Date().toISOString(),
                archivedAt: new Date().toISOString(),
              }),
            ],
            nextCursor: null,
            unreadCount: 0,
          }
        : EMPTY_LIST_RESPONSE,
    );
    renderPanel();

    await user.click(await screen.findByRole('tab', { name: 'Archived' }));

    expect(await screen.findByText('Old news')).toBeInTheDocument();
    await waitFor(() =>
      expect(vi.mocked(listNotifications)).toHaveBeenCalledWith(
        expect.objectContaining({ view: 'archived' }),
        expect.anything(),
      ),
    );

    await user.click(screen.getByRole('button', { name: 'Unarchive “Old news”' }));
    await waitFor(() =>
      expect(vi.mocked(unarchiveNotification)).toHaveBeenCalledWith(
        '00000000-0000-0000-0000-000000000002',
      ),
    );
  });

  test('an empty Archived view gets its own empty state', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('tab', { name: 'Archived' }));

    expect(await screen.findByText('No archived notifications')).toBeInTheDocument();
  });

  test('the per-row Archive action calls the API', async () => {
    const user = userEvent.setup();
    vi.mocked(listNotifications).mockResolvedValue({
      items: [notification({ id: '00000000-0000-0000-0000-000000000002', title: 'Fresh' })],
      nextCursor: null,
      unreadCount: 1,
    });
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Archive “Fresh”' }));

    await waitFor(() =>
      expect(vi.mocked(archiveNotification)).toHaveBeenCalledWith(
        '00000000-0000-0000-0000-000000000002',
      ),
    );
  });

  test('the per-row Delete action hard-deletes via the API', async () => {
    const user = userEvent.setup();
    vi.mocked(listNotifications).mockResolvedValue({
      items: [notification({ id: '00000000-0000-0000-0000-000000000002', title: 'Doomed' })],
      nextCursor: null,
      unreadCount: 1,
    });
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Delete “Doomed”' }));

    await waitFor(() =>
      expect(vi.mocked(deleteNotification)).toHaveBeenCalledWith(
        '00000000-0000-0000-0000-000000000002',
      ),
    );
  });

  test('"Delete all archived" asks for confirmation before deleting', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Delete all archived' }));

    // Nothing deleted yet — the destructive confirm dialog gates it.
    expect(vi.mocked(deleteNotifications)).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog', {
      name: 'Delete all archived notifications?',
    });
    expect(dialog).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Delete permanently' }));

    await waitFor(() => expect(vi.mocked(deleteNotifications)).toHaveBeenCalledWith('archived'));
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Delete all archived notifications?' }),
      ).not.toBeInTheDocument(),
    );
  });

  test('"Delete everything" confirms, and Cancel aborts without deleting', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Delete everything' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete all notifications?' });
    expect(dialog).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(vi.mocked(deleteNotifications)).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('dialog', { name: 'Delete all notifications?' }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Delete everything' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Delete all notifications?' })).getByRole(
        'button',
        { name: 'Delete permanently' },
      ),
    );
    await waitFor(() => expect(vi.mocked(deleteNotifications)).toHaveBeenCalledWith('all'));
  });

  test('surfaces an archive/delete failure instead of doing nothing visibly', async () => {
    const user = userEvent.setup();
    vi.mocked(listNotifications).mockResolvedValue({
      items: [notification({ id: '00000000-0000-0000-0000-000000000002', title: 'Sticky' })],
      nextCursor: null,
      unreadCount: 1,
    });
    vi.mocked(archiveNotification).mockRejectedValue(new Error('boom'));
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Archive “Sticky”' }));

    expect(await screen.findByText(/Couldn't update your notifications/i)).toBeInTheDocument();
  });
});
