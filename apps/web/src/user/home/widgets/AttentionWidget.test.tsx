import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('../../../lib/notificationsApi', () => ({
  listNotifications: vi.fn(),
}));

import type { Notification } from '@bettertrack/contracts';

import { I18nProvider } from '../../../i18n';
import { listNotifications } from '../../../lib/notificationsApi';

import { AttentionWidget } from './AttentionWidget';
import type { WidgetProps } from './types';

/**
 * The Home board's inbox tile — the third surface that renders dispatcher
 * notification rows, and the most-seen one (it ships in the default layout).
 * What is pinned here is that it reads its copy through the same localized
 * renderer the bell and the notification log use (#1138): one unread row may
 * never appear in EN here while the bell shows the same row in DE.
 */

function notification(overrides: Partial<Notification>): Notification {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    type: 'friend.request',
    title: 'New friend request',
    body: 'anna sent you a friend request.',
    payload: undefined,
    readAt: null,
    archivedAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function renderWidget(locale = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const props: WidgetProps = {
    settings: {},
    onSettingsChange: vi.fn(),
    portfolios: [],
    scopedPortfolios: [],
    scopedPortfolio: null,
    portfoliosLoading: false,
    size: 'm',
  };
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <I18nProvider initialLocale={locale}>
          <AttentionWidget {...props} />
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

test('renders keyed rows in the active locale and historical rows verbatim', async () => {
  vi.mocked(listNotifications).mockResolvedValue({
    items: [
      notification({
        id: '00000000-0000-0000-0000-000000000002',
        payload: {
          eventKey: 'friend.request:req-new',
          message: { key: 'friendRequest', params: { actor: 'anna' } },
        },
      }),
      notification({
        id: '00000000-0000-0000-0000-000000000003',
        title: 'Legacy title',
        body: 'Legacy body',
        payload: { eventKey: 'friend.request:req-old' },
      }),
    ],
    nextCursor: null,
    unreadCount: 2,
  });
  renderWidget('de');

  expect(await screen.findByText('Neue Freundschaftsanfrage')).toBeInTheDocument();
  expect(screen.getByText('anna hat dir eine Freundschaftsanfrage gesendet.')).toBeInTheDocument();
  // No descriptor ⇒ the persisted server text, untouched.
  expect(screen.getByText('Legacy title')).toBeInTheDocument();
  expect(screen.getByText('Legacy body')).toBeInTheDocument();
  // ...and never the raw catalog path.
  expect(screen.queryByText(/notificationContent\./)).not.toBeInTheDocument();
});

test('keeps the same row on its English copy for an EN account', async () => {
  vi.mocked(listNotifications).mockResolvedValue({
    items: [
      notification({
        payload: {
          eventKey: 'friend.request:req-new',
          message: { key: 'friendRequest', params: { actor: 'anna' } },
        },
      }),
    ],
    nextCursor: null,
    unreadCount: 1,
  });
  renderWidget('en');

  expect(await screen.findByText('New friend request')).toBeInTheDocument();
  expect(screen.getByText('anna sent you a friend request.')).toBeInTheDocument();
});

test('skips read and archived rows', async () => {
  vi.mocked(listNotifications).mockResolvedValue({
    items: [
      notification({ id: '00000000-0000-0000-0000-000000000004', readAt: '2026-08-06T00:00:00Z' }),
      notification({
        id: '00000000-0000-0000-0000-000000000005',
        title: 'Archived title',
        archivedAt: '2026-08-06T00:00:00Z',
      }),
    ],
    nextCursor: null,
    unreadCount: 0,
  });
  renderWidget('en');

  expect(await screen.findByText(/All clear/)).toBeInTheDocument();
  expect(screen.queryByText('Archived title')).not.toBeInTheDocument();
});
