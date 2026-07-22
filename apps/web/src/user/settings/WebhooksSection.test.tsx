import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  CreateWebhookSubscriptionResponse,
  WebhookSubscriptionListResponse,
} from '@bettertrack/contracts';

vi.mock('../../lib/webhooksApi', () => ({
  listWebhooks: vi.fn(),
  createWebhook: vi.fn(),
  updateWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
  listWebhookDeliveries: vi.fn(),
}));

import { createWebhook, listWebhooks } from '../../lib/webhooksApi';
import { WebhooksSection } from './WebhooksSection';

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

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <WebhooksSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listWebhooks).mockResolvedValue(EMPTY);
});

describe('WebhooksSection', () => {
  test('is collapsed by default and loads nothing until expanded (anti-bloat)', async () => {
    renderSection();
    // No create form and no list request while collapsed.
    expect(screen.queryByLabelText('Payload URL')).not.toBeInTheDocument();
    expect(listWebhooks).not.toHaveBeenCalled();

    await userEvent.setup().click(screen.getByRole('button', { name: /webhooks/i }));

    // Expanding loads the (empty) list and reveals the create form.
    expect(await screen.findByText(/no webhooks yet/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Payload URL')).toBeInTheDocument();
    expect(listWebhooks).toHaveBeenCalledTimes(1);
  });

  test('creates a webhook and shows the signing secret exactly once', async () => {
    vi.mocked(createWebhook).mockResolvedValue(CREATED);
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole('button', { name: /webhooks/i }));
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
    expect(await screen.findByText(CREATED.secret)).toBeInTheDocument();
    expect(screen.getByText(/won't be shown again/i)).toBeInTheDocument();
  });

  test('blocks creation with no event selected', async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole('button', { name: /webhooks/i }));
    await user.type(await screen.findByLabelText('Payload URL'), 'https://example.com/webhooks');
    await user.click(screen.getByRole('button', { name: 'Add webhook' }));

    expect(await screen.findByText(/select at least one event/i)).toBeInTheDocument();
    expect(createWebhook).not.toHaveBeenCalled();
  });

  test('lists an existing subscription with its active status', async () => {
    vi.mocked(listWebhooks).mockResolvedValue(ONE);
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole('button', { name: /webhooks/i }));
    expect(await screen.findByText('https://receiver.test/hook')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });
});
