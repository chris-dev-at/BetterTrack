import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../lib/settingsApi', () => ({
  getNotificationSettings: vi.fn(),
  updateNotificationSettings: vi.fn(),
  getTelegramSettings: vi.fn(),
  startTelegramLink: vi.fn(),
  confirmTelegramLink: vi.fn(),
  unlinkTelegram: vi.fn(),
  getDiscordSettings: vi.fn(),
  saveDiscordWebhook: vi.fn(),
  testDiscordWebhook: vi.fn(),
  removeDiscordWebhook: vi.fn(),
}));

vi.mock('../../lib/notificationsApi', () => ({
  listNotifications: vi.fn(),
  markNotificationsRead: vi.fn(),
  archiveNotification: vi.fn(),
  unarchiveNotification: vi.fn(),
  deleteNotification: vi.fn(),
  deleteNotifications: vi.fn(),
}));

import {
  NOTIFICATION_TYPES,
  type Notification,
  type NotificationListResponse,
  type NotificationMatrix,
  type NotificationSettingsResponse,
  type NotificationTypeRouting,
} from '@bettertrack/contracts';

import {
  archiveNotification,
  deleteNotification,
  deleteNotifications,
  listNotifications,
  markNotificationsRead,
  unarchiveNotification,
} from '../../lib/notificationsApi';
import {
  confirmTelegramLink,
  getDiscordSettings,
  getNotificationSettings,
  getTelegramSettings,
  removeDiscordWebhook,
  saveDiscordWebhook,
  startTelegramLink,
  testDiscordWebhook,
  unlinkTelegram,
  updateNotificationSettings,
} from '../../lib/settingsApi';
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

const ALL_ON: NotificationTypeRouting = {
  inapp: true,
  email: true,
  telegram: true,
  discord: true,
  push: true,
  webpush: true,
};

/** A full four-channel routing matrix (every cell on) with per-type overrides. */
function makeMatrix(overrides: Partial<NotificationMatrix> = {}): NotificationMatrix {
  return {
    ...(Object.fromEntries(
      NOTIFICATION_TYPES.map((type) => [type, { ...ALL_ON }]),
    ) as NotificationMatrix),
    ...overrides,
  };
}

/** The GET/PATCH response shape (#368): matrix + mute + channel availability. */
function makeSettings(
  overrides: Partial<NotificationSettingsResponse> = {},
): NotificationSettingsResponse {
  return {
    matrix: makeMatrix(),
    muted: false,
    // Email is live, the push channels are not — their columns must be absent.
    // Telegram + Discord default to unavailable in unit tests (no bot token,
    // no saved webhook), so their columns stay hidden.
    channels: {
      inapp: true,
      email: true,
      telegram: false,
      discord: false,
      push: false,
      webpush: false,
    },
    webPushPublicKey: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getNotificationSettings).mockResolvedValue(makeSettings());
  vi.mocked(listNotifications).mockResolvedValue(EMPTY_LIST_RESPONSE);
  vi.mocked(markNotificationsRead).mockResolvedValue(undefined);
  vi.mocked(archiveNotification).mockResolvedValue(undefined);
  vi.mocked(unarchiveNotification).mockResolvedValue(undefined);
  vi.mocked(deleteNotification).mockResolvedValue(undefined);
  vi.mocked(deleteNotifications).mockResolvedValue(undefined);
  // V4-P10: Telegram + Discord channels default to unavailable in unit tests.
  vi.mocked(getTelegramSettings).mockResolvedValue({
    available: false,
    linked: false,
    pending: false,
    chatIdMasked: null,
    botUsername: null,
    pendingCode: null,
    pendingExpiresAt: null,
  });
  vi.mocked(getDiscordSettings).mockResolvedValue({
    available: true,
    linked: false,
    webhookIdMasked: null,
    configuredAt: null,
  });
  vi.mocked(startTelegramLink).mockResolvedValue({
    available: true,
    linked: false,
    pending: true,
    chatIdMasked: null,
    botUsername: 'bettertrack_bot',
    pendingCode: 'abc123',
    pendingExpiresAt: new Date(Date.now() + 600_000).toISOString(),
  });
  vi.mocked(confirmTelegramLink).mockResolvedValue({
    linked: false,
    settings: {
      available: true,
      linked: false,
      pending: true,
      chatIdMasked: null,
      botUsername: 'bettertrack_bot',
      pendingCode: 'abc123',
      pendingExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    },
  });
  vi.mocked(unlinkTelegram).mockResolvedValue({
    available: true,
    linked: false,
    pending: false,
    chatIdMasked: null,
    botUsername: 'bettertrack_bot',
    pendingCode: null,
    pendingExpiresAt: null,
  });
  vi.mocked(saveDiscordWebhook).mockResolvedValue({
    available: true,
    linked: true,
    webhookIdMasked: '…abcd',
    configuredAt: new Date().toISOString(),
  });
  vi.mocked(testDiscordWebhook).mockResolvedValue({ ok: true });
  vi.mocked(removeDiscordWebhook).mockResolvedValue({
    available: true,
    linked: false,
    webhookIdMasked: null,
    configuredAt: null,
  });
});

describe('NotificationSettingsPage', () => {
  test('renders the grid: category groups, per-cell toggles, only live channel columns', async () => {
    renderPage();

    const cell = await screen.findByRole('switch', { name: 'Friend requests via In-app' });
    expect(cell).toBeChecked();
    // Rows exist for the v2 types, grouped under category masters.
    expect(screen.getByRole('switch', { name: 'Shared watchlists via Email' })).toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: 'Toggle all Friends notifications' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: 'Toggle all Sharing & activity notifications' }),
    ).toBeInTheDocument();
    // Unconfigured channels render NO column (#350/#351 gating).
    expect(
      screen.queryByRole('switch', { name: 'Friend requests via Phone push' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('switch', { name: 'Friend requests via Browser push' }),
    ).not.toBeInTheDocument();
  });

  test('reflects a stored per-cell override as an unchecked toggle', async () => {
    vi.mocked(getNotificationSettings).mockResolvedValue(
      makeSettings({
        matrix: makeMatrix({
          'friend.request': {
            inapp: false,
            email: true,
            telegram: true,
            discord: true,
            push: true,
            webpush: true,
          },
        }),
      }),
    );
    renderPage();

    expect(
      await screen.findByRole('switch', { name: 'Friend requests via In-app' }),
    ).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'Friend requests via Email' })).toBeChecked();
  });

  test('toggling a cell PATCHes that type’s full routing', async () => {
    vi.mocked(updateNotificationSettings).mockResolvedValue(
      makeSettings({
        matrix: makeMatrix({
          'friend.request': {
            inapp: true,
            email: false,
            telegram: true,
            discord: true,
            push: true,
            webpush: true,
          },
        }),
      }),
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('switch', { name: 'Friend requests via Email' }));

    expect(updateNotificationSettings).toHaveBeenCalledWith({
      matrix: {
        'friend.request': {
          inapp: true,
          email: false,
          telegram: true,
          discord: true,
          push: true,
          webpush: true,
        },
      },
    });
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Friend requests via Email' })).not.toBeChecked(),
    );
  });

  test('the category master toggles every live cell of its types at once', async () => {
    vi.mocked(updateNotificationSettings).mockResolvedValue(makeSettings());
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole('switch', { name: 'Toggle all Friends notifications' }),
    );

    // Off: both social types, every LIVE channel false. Channels the deployment
    // hasn't configured (push/webpush here) are not rendered and stay untouched —
    // silently flipping invisible cells would surprise when the channel comes
    // online later.
    expect(updateNotificationSettings).toHaveBeenCalledWith({
      matrix: {
        'friend.request': {
          inapp: false,
          email: false,
          telegram: true,
          discord: true,
          push: true,
          webpush: true,
        },
        'friend.accepted': {
          inapp: false,
          email: false,
          telegram: true,
          discord: true,
          push: true,
          webpush: true,
        },
      },
    });
  });

  test('the global mute PATCHes muted and dims the grid', async () => {
    vi.mocked(updateNotificationSettings).mockResolvedValue(makeSettings({ muted: true }));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('switch', { name: 'Mute all notifications' }));

    expect(updateNotificationSettings).toHaveBeenCalledWith({ muted: true });
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Friend requests via In-app' })).toBeDisabled(),
    );
  });

  test('account rows: invite cells locked, temp-password email locked (transactional)', async () => {
    renderPage();

    expect(
      await screen.findByRole('switch', { name: 'Account invites via In-app' }),
    ).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Temporary passwords via Email' })).toBeDisabled();
    // The rest of the temp-password row stays user-controlled.
    expect(
      screen.getByRole('switch', { name: 'Temporary passwords via In-app' }),
    ).not.toBeDisabled();
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
    // The routing grid still renders alongside the list.
    expect(screen.getByRole('switch', { name: 'Friend requests via In-app' })).toBeInTheDocument();
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

  // ── Archive state + deletion (#437) ─────────────────────────────────────────

  test('defaults to the Active view and requests it from the API', async () => {
    renderPage();

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
    renderPage();

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
    renderPage();

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
    renderPage();

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
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Delete “Doomed”' }));

    await waitFor(() =>
      expect(vi.mocked(deleteNotification)).toHaveBeenCalledWith(
        '00000000-0000-0000-0000-000000000002',
      ),
    );
  });

  test('"Delete all archived" asks for confirmation before deleting', async () => {
    const user = userEvent.setup();
    renderPage();

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
    renderPage();

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
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Archive “Sticky”' }));

    expect(await screen.findByText(/Couldn't update your notifications/i)).toBeInTheDocument();
  });
});

describe('NotificationSettingsPage — Telegram & Discord channels (V4-P10)', () => {
  test('matrix columns absent when both channels are unconfigured', async () => {
    // channels.telegram: false and channels.discord: false (the default fixture)
    renderPage();
    expect(
      await screen.findByRole('switch', { name: 'Friend requests via In-app' }),
    ).toBeInTheDocument();
    // Neither column renders — the grid never lists Telegram / Discord cells.
    expect(
      screen.queryByRole('switch', { name: 'Friend requests via Telegram' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('switch', { name: 'Friend requests via Discord' }),
    ).not.toBeInTheDocument();
    // Setup cards likewise stay hidden — Telegram is unavailable server-side,
    // and Discord's card renders only once its query resolves (linked or not).
    expect(screen.queryByText(/Telegram-Verknüpfung|Start Telegram link/)).not.toBeInTheDocument();
  });

  test('renders columns + Discord webhook setup once the channels come online', async () => {
    vi.mocked(getNotificationSettings).mockResolvedValue(
      makeSettings({
        channels: {
          inapp: true,
          email: true,
          telegram: true,
          discord: true,
          push: false,
          webpush: false,
        },
      }),
    );
    renderPage();

    // Grid columns show for both new channels.
    expect(
      await screen.findByRole('switch', { name: 'Friend requests via Telegram' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Friend requests via Discord' })).toBeInTheDocument();
    // Discord card is available server-side but not yet linked → setup form renders.
    expect(await screen.findByLabelText('Webhook URL')).toBeInTheDocument();
  });

  test('surfaces an invalid webhook error at save time (no persistence)', async () => {
    const user = userEvent.setup();
    class ApiErrorLike extends Error {
      code = 'invalid_webhook';
    }
    vi.mocked(saveDiscordWebhook).mockRejectedValueOnce(new ApiErrorLike('invalid_webhook'));
    renderPage();

    const input = await screen.findByLabelText('Webhook URL');
    await user.type(input, 'https://discord.com/api/webhooks/1/x');
    await user.click(screen.getByRole('button', { name: 'Save webhook' }));

    expect(await screen.findByText(/Discord rejected this webhook/)).toBeInTheDocument();
  });

  test('starts + confirms the Telegram link handshake', async () => {
    vi.mocked(getTelegramSettings).mockResolvedValue({
      available: true,
      linked: false,
      pending: false,
      chatIdMasked: null,
      botUsername: 'bettertrack_bot',
      pendingCode: null,
      pendingExpiresAt: null,
    });
    vi.mocked(confirmTelegramLink).mockResolvedValueOnce({
      linked: true,
      settings: {
        available: true,
        linked: true,
        pending: false,
        chatIdMasked: '…1234',
        botUsername: 'bettertrack_bot',
        pendingCode: null,
        pendingExpiresAt: null,
      },
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Start Telegram link' }));
    expect(startTelegramLink).toHaveBeenCalledTimes(1);
    // The deep link + confirm button surface once the pending code lands.
    expect(await screen.findByRole('link', { name: 'Open Telegram bot' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: "I've started the bot" }));
    expect(confirmTelegramLink).toHaveBeenCalledTimes(1);
  });
});
