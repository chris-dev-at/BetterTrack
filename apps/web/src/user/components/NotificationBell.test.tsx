import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../lib/notificationsApi', () => ({
  listNotifications: vi.fn(),
  markNotificationsRead: vi.fn(),
}));

import type { Notification, NotificationListResponse } from '@bettertrack/contracts';
import { REALTIME_SERVER_EVENTS } from '@bettertrack/contracts';

import { listNotifications, markNotificationsRead } from '../../lib/notificationsApi';
import { RealtimeContext, type RealtimeContextValue } from '../../lib/realtime';
import { NotificationBell } from './NotificationBell';

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
}

function renderBell() {
  // The dropdown always renders the "All notifications" footer Link (#437),
  // so every bell render needs a router context.
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter>
        <NotificationBell />
      </MemoryRouter>
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

const EMPTY_RESPONSE: NotificationListResponse = { items: [], nextCursor: null, unreadCount: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(markNotificationsRead).mockResolvedValue(undefined);
});

describe('NotificationBell', () => {
  test('shows no badge when there are no unread notifications', async () => {
    vi.mocked(listNotifications).mockResolvedValue(EMPTY_RESPONSE);
    renderBell();

    await waitFor(() => expect(vi.mocked(listNotifications)).toHaveBeenCalled());
    expect(screen.queryByText(/^\d+$/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument();
  });

  test('badge reflects unread count from GET /notifications', async () => {
    vi.mocked(listNotifications).mockResolvedValue({
      items: [notification({ id: '00000000-0000-0000-0000-000000000002' })],
      nextCursor: null,
      unreadCount: 3,
    });
    renderBell();

    expect(await screen.findByText('3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Notifications (3 unread)' })).toBeInTheDocument();
  });

  test('opening the bell shows the dropdown with read/unread distinction', async () => {
    const user = userEvent.setup();
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
    renderBell();

    await user.click(await screen.findByRole('button', { name: /Notifications/ }));

    expect(await screen.findByRole('dialog', { name: 'Notifications' })).toBeInTheDocument();
    expect(screen.getByText('Unread item')).toBeInTheDocument();
    expect(screen.getByText('Read item')).toBeInTheDocument();
  });

  test('renders an empty state when there are no notifications', async () => {
    const user = userEvent.setup();
    vi.mocked(listNotifications).mockResolvedValue(EMPTY_RESPONSE);
    renderBell();

    await user.click(await screen.findByRole('button', { name: 'Notifications' }));

    expect(await screen.findByText('No notifications yet')).toBeInTheDocument();
  });

  test('clicking an unread notification marks it read and clears the badge', async () => {
    const user = userEvent.setup();
    vi.mocked(listNotifications)
      .mockResolvedValueOnce({
        items: [notification({ id: '00000000-0000-0000-0000-000000000002' })],
        nextCursor: null,
        unreadCount: 1,
      })
      .mockResolvedValue(EMPTY_RESPONSE);
    renderBell();

    await user.click(await screen.findByRole('button', { name: /Notifications/ }));
    await user.click(await screen.findByText('New friend request'));

    await waitFor(() =>
      expect(vi.mocked(markNotificationsRead)).toHaveBeenCalledWith({
        ids: ['00000000-0000-0000-0000-000000000002'],
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument(),
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
      .mockResolvedValue(EMPTY_RESPONSE);
    renderBell();

    await user.click(await screen.findByRole('button', { name: /Notifications/ }));
    await user.click(await screen.findByRole('button', { name: 'Mark all read' }));

    await waitFor(() =>
      expect(vi.mocked(markNotificationsRead)).toHaveBeenCalledWith({ all: true }),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument(),
    );
  });

  test('"Mark all read" is disabled when there are no unread notifications', async () => {
    const user = userEvent.setup();
    vi.mocked(listNotifications).mockResolvedValue({
      items: [
        notification({
          id: '00000000-0000-0000-0000-000000000002',
          readAt: new Date().toISOString(),
        }),
      ],
      nextCursor: null,
      unreadCount: 0,
    });
    renderBell();

    await user.click(await screen.findByRole('button', { name: 'Notifications' }));

    expect(await screen.findByRole('button', { name: 'Mark all read' })).toBeDisabled();
  });

  test('shows a loading skeleton before the first fetch resolves', async () => {
    const user = userEvent.setup();
    let resolveFetch!: (value: NotificationListResponse) => void;
    vi.mocked(listNotifications).mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    renderBell();

    await user.click(await screen.findByRole('button', { name: 'Notifications' }));

    expect(await screen.findAllByRole('status')).not.toHaveLength(0);

    resolveFetch(EMPTY_RESPONSE);
    await waitFor(() => expect(screen.queryAllByRole('status')).toHaveLength(0));
  });

  test('shows an error state when the dropdown fails to load', async () => {
    const user = userEvent.setup();
    vi.mocked(listNotifications).mockRejectedValue(new Error('boom'));
    renderBell();

    await user.click(await screen.findByRole('button', { name: 'Notifications' }));

    expect(await screen.findByText("Couldn't load notifications")).toBeInTheDocument();
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
    renderBell();

    await user.click(await screen.findByRole('button', { name: /Notifications/ }));
    expect(await screen.findByText('New friend request')).toBeInTheDocument();

    await user.click(screen.getByText('New friend request'));

    await waitFor(() => expect(vi.mocked(listNotifications)).toHaveBeenCalledTimes(2));
    expect(screen.getByText('New friend request')).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load notifications")).not.toBeInTheDocument();
  });

  test('surfaces a "Mark all read" failure instead of doing nothing visibly', async () => {
    const user = userEvent.setup();
    vi.mocked(listNotifications).mockResolvedValue({
      items: [notification({ id: '00000000-0000-0000-0000-000000000002' })],
      nextCursor: null,
      unreadCount: 1,
    });
    vi.mocked(markNotificationsRead).mockRejectedValue(new Error('boom'));
    renderBell();

    await user.click(await screen.findByRole('button', { name: /Notifications/ }));
    await user.click(screen.getByRole('button', { name: 'Mark all read' }));

    expect(await screen.findByText(/Couldn't update that notification/i)).toBeInTheDocument();
  });

  test('a realtime notification.new push refreshes the bell without waiting for the poll (§4.5)', async () => {
    vi.mocked(listNotifications)
      .mockResolvedValueOnce(EMPTY_RESPONSE)
      .mockResolvedValue({
        items: [notification({ id: '00000000-0000-0000-0000-000000000002' })],
        nextCursor: null,
        unreadCount: 1,
      });

    // Connected gateway double: capture what the bell subscribes to.
    const handlers = new Map<string, (payload: unknown) => void>();
    const realtime: RealtimeContextValue = {
      connected: true,
      on: (event, handler) => {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      },
      joinRoom: () => () => {},
      watchLive: () => Promise.resolve(null),
      unwatchLive: () => {},
      presenceEnter: () => {},
      presenceLeave: () => {},
    };
    render(
      <QueryClientProvider client={makeQueryClient()}>
        <RealtimeContext.Provider value={realtime}>
          <NotificationBell />
        </RealtimeContext.Provider>
      </QueryClientProvider>,
    );

    // First load: no badge.
    await waitFor(() => expect(vi.mocked(listNotifications)).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('1')).not.toBeInTheDocument();
    const push = handlers.get(REALTIME_SERVER_EVENTS.notificationNew);
    expect(push).toBeTruthy();

    // Server push arrives → the bell refetches immediately and shows the badge.
    push!({ notificationId: '00000000-0000-0000-0000-000000000002', occurredAt: 'now' });
    await waitFor(() => expect(vi.mocked(listNotifications)).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('1')).toBeInTheDocument();
  });

  test('the dropdown carries an "All notifications" footer link to the settings page (#437)', async () => {
    const user = userEvent.setup();
    vi.mocked(listNotifications).mockResolvedValue(EMPTY_RESPONSE);
    renderBell();

    await user.click(await screen.findByRole('button', { name: 'Notifications' }));

    const link = await screen.findByRole('link', { name: 'All notifications' });
    expect(link).toHaveAttribute('href', '/settings/notifications');
  });

  test('an alert.triggered notification links to its asset (§14)', async () => {
    const user = userEvent.setup();
    vi.mocked(listNotifications).mockResolvedValue({
      items: [
        notification({
          id: '00000000-0000-0000-0000-000000000003',
          type: 'alert.triggered',
          title: 'AAPL alert triggered',
          body: 'AAPL rose above $200',
          payload: { assetId: 'asset-42', alertId: 'al1', kind: 'price_above' },
        }),
      ],
      nextCursor: null,
      unreadCount: 1,
    });
    render(
      <QueryClientProvider client={makeQueryClient()}>
        <MemoryRouter>
          <NotificationBell />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await user.click(await screen.findByRole('button', { name: /Notifications/ }));
    const link = screen.getByRole('link', { name: /AAPL alert triggered/ });
    expect(link).toHaveAttribute('href', '/assets/asset-42');

    await user.click(link);
    expect(markNotificationsRead).toHaveBeenCalledWith({
      ids: ['00000000-0000-0000-0000-000000000003'],
    });
  });
});
