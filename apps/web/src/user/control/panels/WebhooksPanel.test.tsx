import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  WEBHOOK_DELIVERY_REFUSED_ERROR,
  WEBHOOK_DELIVERY_SECRET_ERROR,
  WEBHOOK_DELIVERY_TIMEOUT_ERROR,
  WEBHOOK_DELIVERY_UNRESOLVED_ERROR,
  type CreateWebhookSubscriptionResponse,
  type WebhookDeliveryError,
  type WebhookDeliveryListResponse,
  type WebhookSubscriptionListResponse,
} from '@bettertrack/contracts';

vi.mock('../../../lib/webhooksApi', () => ({
  listWebhooks: vi.fn(),
  createWebhook: vi.fn(),
  updateWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
  listWebhookDeliveries: vi.fn(),
}));

import { createWebhook, listWebhookDeliveries, listWebhooks } from '../../../lib/webhooksApi';
import { ResolvedPrivacyModeProvider } from '../../vault/usePrivacyMode';
import { WebhooksPanel } from './WebhooksPanel';

const EMPTY: WebhookSubscriptionListResponse = { subscriptions: [] };

const ONE: WebhookSubscriptionListResponse = {
  subscriptions: [
    {
      id: '00000000-0000-0000-0000-0000000000aa',
      url: 'https://receiver.test/hook',
      description: null,
      eventTypes: ['alert.triggered'],
      enabled: true,
      disabledReason: null,
      disabledAt: null,
      consecutiveFailures: 0,
      lastDeliveryAt: null,
      lastSuccessAt: null,
      createdAt: '2026-07-01T08:00:00.000Z',
    },
  ],
};

const CREATED: CreateWebhookSubscriptionResponse = {
  subscription: {
    id: '00000000-0000-0000-0000-0000000000bb',
    url: 'https://example.com/webhooks',
    description: null,
    eventTypes: ['alert.triggered'],
    enabled: true,
    disabledReason: null,
    disabledAt: null,
    consecutiveFailures: 0,
    lastDeliveryAt: null,
    lastSuccessAt: null,
    createdAt: '2026-07-05T08:00:00.000Z',
  },
  secret: 'whsec_shown_once_secret',
};

/** One failed delivery row: no HTTP status, only a scrubbed reason string. */
function delivery(
  suffix: string,
  error: WebhookDeliveryError,
  attempts: number,
): WebhookDeliveryListResponse['deliveries'][number] {
  return {
    id: `00000000-0000-0000-0000-0000000000${suffix}`,
    eventType: 'alert.triggered',
    status: 'failed',
    responseStatus: null,
    attempts,
    error,
    createdAt: '2026-07-02T08:00:00.000Z',
  };
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <WebhooksPanel />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listWebhooks).mockResolvedValue(EMPTY);
});

describe('WebhooksPanel', () => {
  // R2: the outer collapse is retired (the section IS the panel now), so the
  // create form renders immediately and the list query is unconditional. What
  // this case still asserts — the empty state, the form, exactly one fetch — is
  // unchanged; only the "collapsed until clicked" assertions are gone.
  test('renders expanded and loads the list on mount', async () => {
    renderPanel();

    expect(await screen.findByText(/no webhooks yet/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Payload URL')).toBeInTheDocument();
    expect(listWebhooks).toHaveBeenCalledTimes(1);
  });

  test('retries a failed subscription-list read in place', async () => {
    vi.mocked(listWebhooks)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(EMPTY);
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Try again' }));

    expect(await screen.findByText(/no webhooks yet/i)).toBeInTheDocument();
    expect(listWebhooks).toHaveBeenCalledTimes(2);
  });

  test('retries a failed on-demand delivery read', async () => {
    vi.mocked(listWebhooks).mockResolvedValue(ONE);
    vi.mocked(listWebhookDeliveries)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ deliveries: [] });
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Deliveries' }));
    await user.click(await screen.findByRole('button', { name: 'Try again' }));

    expect(await screen.findByText(/no deliveries recorded yet/i)).toBeInTheDocument();
    expect(listWebhookDeliveries).toHaveBeenCalledTimes(2);
  });

  test('creates a webhook and shows the signing secret exactly once', async () => {
    vi.mocked(createWebhook).mockResolvedValue(CREATED);
    const user = userEvent.setup();
    renderPanel();

    await user.type(await screen.findByLabelText('Payload URL'), 'https://example.com/webhooks');
    await user.click(screen.getByRole('checkbox', { name: /price alert triggered/i }));
    await user.click(screen.getByRole('button', { name: 'Add webhook' }));

    await waitFor(() =>
      expect(createWebhook).toHaveBeenCalledWith({
        url: 'https://example.com/webhooks',
        description: undefined,
        eventTypes: ['alert.triggered'],
      }),
    );

    // The one-time secret is revealed with a "won't be shown again" notice.
    const dialog = await screen.findByRole('dialog', { name: 'Your webhook signing secret' });
    expect(within(dialog).getByText(CREATED.secret)).toBeInTheDocument();
    expect(screen.getByText(/won't be shown again/i)).toBeInTheDocument();

    await user.keyboard('{Escape}');
    fireEvent.mouseDown(dialog.parentElement!);
    expect(screen.getByText(CREATED.secret)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Copy' }));
    expect(await within(dialog).findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    fireEvent.mouseDown(dialog.parentElement!);
    await waitFor(() => expect(screen.queryByText(CREATED.secret)).not.toBeInTheDocument());
  });

  test('blocks creation with no event selected', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.type(await screen.findByLabelText('Payload URL'), 'https://example.com/webhooks');
    await user.click(screen.getByRole('button', { name: 'Add webhook' }));

    expect(await screen.findByText(/select at least one event/i)).toBeInTheDocument();
    expect(createWebhook).not.toHaveBeenCalled();
  });

  test('lists an existing subscription with its active status', async () => {
    vi.mocked(listWebhooks).mockResolvedValue(ONE);
    renderPanel();

    expect(await screen.findByText('https://receiver.test/hook')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  // Four structurally different failures all record `responseStatus: null`, so
  // without a per-cause explanation they are one identical red badge and the
  // user cannot tell a broken DNS record from a blocked destination.
  test('explains each statusless failure cause distinctly, folded away by default', async () => {
    const failures: WebhookDeliveryListResponse = {
      deliveries: [
        delivery('01', WEBHOOK_DELIVERY_REFUSED_ERROR, 1),
        delivery('02', WEBHOOK_DELIVERY_TIMEOUT_ERROR, 5),
        delivery('03', WEBHOOK_DELIVERY_UNRESOLVED_ERROR, 4),
        delivery('04', WEBHOOK_DELIVERY_SECRET_ERROR, 3),
      ],
    };
    vi.mocked(listWebhooks).mockResolvedValue(ONE);
    vi.mocked(listWebhookDeliveries).mockResolvedValue(failures);
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Deliveries' }));

    // §13.5: the list is exactly as tall as before — the reasons are folded.
    const toggles = await screen.findAllByRole('button', { name: /Why\?$/ });
    expect(toggles).toHaveLength(4);
    expect(screen.queryByText(/did not respond in time/i)).not.toBeInTheDocument();

    for (const toggle of toggles) await user.click(toggle);

    expect(screen.getByText(/resolves to a network range webhooks may not reach/i)).toBeVisible();
    expect(screen.getByText(/did not respond in time/i)).toBeVisible();
    expect(screen.getByText(/host could not be resolved/i)).toBeVisible();
    expect(screen.getByText(/signing secret could not be read/i)).toBeVisible();
    // …and how much the delivery actually cost.
    expect(screen.getByText('Attempts: 5')).toBeVisible();
  });

  test('Paranoid mode marks a subscribed event it never fires instead of hiding it', async () => {
    vi.mocked(listWebhooks).mockResolvedValue({
      subscriptions: [
        { ...ONE.subscriptions[0]!, eventTypes: ['alert.triggered', 'mirror.invite'] },
      ],
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
    render(
      <QueryClientProvider client={client}>
        <ResolvedPrivacyModeProvider mode="paranoid">
          <WebhooksPanel />
        </ResolvedPrivacyModeProvider>
      </QueryClientProvider>,
    );

    // The subscription really carries the event and starts delivering again as
    // soon as paranoid mode is off, so the row states it — struck through.
    expect(await screen.findByText('mirror.invite')).toBeInTheDocument();
    expect(screen.getByText(/inactive in Paranoid mode/i)).toBeInTheDocument();
    expect(screen.getByText('alert.triggered')).toBeInTheDocument();
    // And the create form still refuses to offer the killed event.
    const createForm = screen.getByRole('button', { name: 'Add webhook' }).closest('form')!;
    expect(
      within(createForm).queryByRole('checkbox', { name: /group portfolio invite/i }),
    ).not.toBeInTheDocument();
  });
});
