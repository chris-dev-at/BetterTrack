import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../lib/settingsApi', () => ({
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

import {
  DEFAULT_NOTIFICATION_CADENCE,
  NOTIFICATION_TYPES,
  type NotificationCadenceMap,
  type NotificationMatrix,
  type NotificationSettingsResponse,
  type NotificationTypeRouting,
} from '@bettertrack/contracts';

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
} from '../../../lib/settingsApi';
import { NotificationsPanel } from './NotificationsPanel';

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
}

function renderPanel() {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <NotificationsPanel />
    </QueryClientProvider>,
  );
}

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

/** A full per-type cadence map, all types on the default `instant` (V5-P3). */
function makeCadence(overrides: Partial<NotificationCadenceMap> = {}): NotificationCadenceMap {
  return {
    ...(Object.fromEntries(
      NOTIFICATION_TYPES.map((type) => [type, DEFAULT_NOTIFICATION_CADENCE]),
    ) as NotificationCadenceMap),
    ...overrides,
  };
}

/** The GET/PATCH response shape (#368): matrix + cadence + mute + channel availability. */
function makeSettings(
  overrides: Partial<NotificationSettingsResponse> = {},
): NotificationSettingsResponse {
  return {
    matrix: makeMatrix(),
    cadence: makeCadence(),
    quietHours: { enabled: false, startMinute: 22 * 60, endMinute: 7 * 60, timezone: null },
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
    // V5-P0 kill-switch: deployment-level "offered at all?" flag. Default OFF
    // in unit tests so the setup rows stay hidden by default; tests that want
    // to exercise the setup surfaces flip these to true (mirroring an
    // opt-in deployment with `BT_TELEGRAM_DISCORD_ENABLED=true`).
    channelsConfigurable: {
      telegram: false,
      discord: false,
    },
    webPushPublicKey: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getNotificationSettings).mockResolvedValue(makeSettings());
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

describe('NotificationsPanel', () => {
  test('renders the grid: category groups, per-cell toggles, only live channel columns', async () => {
    renderPanel();

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
    renderPanel();

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
    renderPanel();

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
    renderPanel();

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
    renderPanel();

    await user.click(await screen.findByRole('switch', { name: 'Mute all notifications' }));

    expect(updateNotificationSettings).toHaveBeenCalledWith({ muted: true });
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Friend requests via In-app' })).toBeDisabled(),
    );
  });

  test('the digest cadence selector PATCHes that type’s cadence (V5-P3)', async () => {
    vi.mocked(updateNotificationSettings).mockResolvedValue(
      makeSettings({ cadence: makeCadence({ 'alert.triggered': 'daily' }) }),
    );
    const user = userEvent.setup();
    renderPanel();

    // The block is collapsed by default (anti-bloat) — expand it first.
    await user.click(await screen.findByText('Delivery frequency'));
    const select = await screen.findByRole('combobox', {
      name: 'Delivery frequency for Price alerts',
    });
    expect(select).toHaveValue('instant');
    await user.selectOptions(select, 'daily');

    expect(updateNotificationSettings).toHaveBeenCalledWith({
      cadence: { 'alert.triggered': 'daily' },
    });
  });

  test('account rows: invite cells locked, temp-password email locked (transactional)', async () => {
    renderPanel();

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
    vi.mocked(getNotificationSettings)
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValueOnce(makeSettings());
    const user = userEvent.setup();
    renderPanel();

    await waitFor(() =>
      expect(screen.getByText(/Couldn't load your notification settings/i)).toBeInTheDocument(),
    );
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('switch', { name: 'Friend requests via In-app' }),
    ).toBeInTheDocument();
    expect(getNotificationSettings).toHaveBeenCalledTimes(2);
  });
});

describe('NotificationsPanel — Telegram & Discord channels (V4-P10)', () => {
  test('renders channel setup read failures when the global switch exposes them', async () => {
    vi.mocked(getNotificationSettings).mockResolvedValue(
      makeSettings({ channelsConfigurable: { telegram: true, discord: true } }),
    );
    vi.mocked(getTelegramSettings).mockRejectedValue(new Error('telegram unavailable'));
    vi.mocked(getDiscordSettings).mockRejectedValue(new Error('discord unavailable'));
    renderPanel();

    expect(await screen.findByText("This information isn't available.")).toBeInTheDocument();
  });

  test('matrix columns absent when both channels are unconfigured', async () => {
    // channels.telegram: false and channels.discord: false (the default fixture)
    renderPanel();
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
    // Setup rows likewise stay hidden — Telegram is unavailable server-side,
    // and Discord's row renders only once its query resolves (linked or not).
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
        // Kill-switch is on AND the caller has completed setup — both rows
        // AND matrix columns render.
        channelsConfigurable: { telegram: true, discord: true },
      }),
    );
    renderPanel();

    // Grid columns show for both new channels.
    expect(
      await screen.findByRole('switch', { name: 'Friend requests via Telegram' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Friend requests via Discord' })).toBeInTheDocument();
    // Discord row is available server-side but not yet linked → setup form renders.
    expect(await screen.findByLabelText('Webhook URL')).toBeInTheDocument();
  });

  test('surfaces an invalid webhook error at save time (no persistence)', async () => {
    // The setup row only renders when the V5-P0 kill-switch is on.
    vi.mocked(getNotificationSettings).mockResolvedValue(
      makeSettings({ channelsConfigurable: { telegram: true, discord: true } }),
    );
    const user = userEvent.setup();
    class ApiErrorLike extends Error {
      code = 'invalid_webhook';
    }
    vi.mocked(saveDiscordWebhook).mockRejectedValueOnce(new ApiErrorLike('invalid_webhook'));
    renderPanel();

    const input = await screen.findByLabelText('Webhook URL');
    await user.type(input, 'https://discord.com/api/webhooks/1/x');
    await user.click(screen.getByRole('button', { name: 'Save webhook' }));

    expect(await screen.findByText(/Discord rejected this webhook/)).toBeInTheDocument();
  });

  test('the V5-P0 kill-switch hides the setup rows without probing endpoints', async () => {
    // Default fixture already has channelsConfigurable off; assert we NEVER
    // hit `getTelegramSettings`/`getDiscordSettings` when the flag is off.
    renderPanel();
    // Wait for the main matrix row so we know the panel has settled.
    expect(
      await screen.findByRole('switch', { name: 'Friend requests via In-app' }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Webhook URL')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start Telegram link' })).not.toBeInTheDocument();
    // The setup endpoints are NEVER probed when the flag is off (no 404 storm).
    expect(getTelegramSettings).not.toHaveBeenCalled();
    expect(getDiscordSettings).not.toHaveBeenCalled();
  });

  test('starts + confirms the Telegram link handshake', async () => {
    // Kill-switch must be ON for the Telegram row to render.
    vi.mocked(getNotificationSettings).mockResolvedValue(
      makeSettings({ channelsConfigurable: { telegram: true, discord: true } }),
    );
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
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Start Telegram link' }));
    expect(startTelegramLink).toHaveBeenCalledTimes(1);
    // The deep link + confirm button surface once the pending code lands.
    expect(await screen.findByRole('link', { name: 'Open Telegram bot' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: "I've started the bot" }));
    expect(confirmTelegramLink).toHaveBeenCalledTimes(1);
  });
});
