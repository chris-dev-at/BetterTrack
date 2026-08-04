import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { Alert } from '@bettertrack/contracts';

vi.mock('../../lib/alertsApi', () => ({
  ALERTS_QUERY_KEY: ['alerts'],
  listAlerts: vi.fn(),
  createAlert: vi.fn(),
  updateAlert: vi.fn(),
  rearmAlert: vi.fn(),
  deleteAlert: vi.fn(),
}));

import { deleteAlert, listAlerts, rearmAlert } from '../../lib/alertsApi';
import { setViewportWidth } from '../../test/viewport';
import { AlertsPage } from './AlertsPage';

function asset(overrides: Partial<Alert['asset']> = {}): Alert['asset'] {
  return {
    id: 'a1',
    symbol: 'AAPL',
    name: 'Apple Inc.',
    currency: 'USD',
    type: 'stock',
    ...overrides,
  };
}

function alert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: 'al1',
    kind: 'price_above',
    threshold: 200,
    refPrice: null,
    repeat: false,
    status: 'active',
    lastTriggeredAt: null,
    asset: asset(),
    ...overrides,
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AlertsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AlertsPage', () => {
  test('shows a designed empty state when there are no alerts', async () => {
    vi.mocked(listAlerts).mockResolvedValue({ items: [] });
    renderPage();
    await waitFor(() => expect(screen.getByText('No alerts yet')).toBeInTheDocument());
    expect(screen.getByText('New alert →')).toBeInTheDocument();
  });

  test('lists each alert with its rule, status and repeat mode', async () => {
    vi.mocked(listAlerts).mockResolvedValue({
      items: [
        alert({ id: 'al1', kind: 'price_above', threshold: 200, status: 'active' }),
        alert({
          id: 'al2',
          kind: 'pct_day_down',
          threshold: 5,
          repeat: true,
          status: 'triggered',
          lastTriggeredAt: '2026-07-01T10:00:00.000Z',
          asset: asset({ id: 'a2', symbol: 'MSFT' }),
        }),
      ],
    });
    renderPage();

    await waitFor(() => expect(screen.getByText(/Price rises above/)).toBeInTheDocument());
    expect(screen.getByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();

    expect(screen.getByText(/Down 5.*on the day/)).toBeInTheDocument();
    expect(screen.getByText('MSFT')).toBeInTheDocument();
    expect(screen.getByText('Triggered')).toBeInTheDocument();
    expect(screen.getByText('Repeat (24 h)')).toBeInTheDocument();
  });

  test('the create dialog offers all six §14 kinds', async () => {
    const user = userEvent.setup();
    vi.mocked(listAlerts).mockResolvedValue({ items: [] });
    renderPage();
    await waitFor(() => expect(screen.getByText('No alerts yet')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: '+ New alert' }));

    for (const label of [
      'Price rises above',
      'Price falls below',
      'Rises % from reference',
      'Falls % from reference',
      'Up % on the day',
      'Down % on the day',
    ]) {
      expect(screen.getByRole('option', { name: label })).toBeInTheDocument();
    }
  });

  test('re-arm on a triggered one-shot calls the API', async () => {
    const user = userEvent.setup();
    vi.mocked(listAlerts).mockResolvedValue({
      items: [alert({ status: 'triggered' })],
    });
    vi.mocked(rearmAlert).mockResolvedValue(alert({ status: 'active' }));
    renderPage();

    await waitFor(() => expect(screen.getByText('Re-arm')).toBeInTheDocument());
    await user.click(screen.getByText('Re-arm'));
    expect(rearmAlert).toHaveBeenCalledWith('al1');
  });

  test('delete asks for confirmation before it calls the API', async () => {
    const user = userEvent.setup();
    vi.mocked(listAlerts).mockResolvedValue({ items: [alert()] });
    vi.mocked(deleteAlert).mockResolvedValue(undefined);
    renderPage();

    await waitFor(() => expect(screen.getByText('Delete')).toBeInTheDocument());
    await user.click(screen.getByText('Delete'));

    // First click only arms the confirm — an alert is not destroyed by one slip
    // of a small danger button sitting next to Edit.
    expect(deleteAlert).not.toHaveBeenCalled();
    expect(
      screen.getByText("Delete this alert? It stops being evaluated and can't be restored."),
    ).toBeInTheDocument();

    await user.click(screen.getByText('Delete'));
    expect(deleteAlert).toHaveBeenCalledWith('al1');
  });

  test('cancelling the delete confirm leaves the alert alone', async () => {
    const user = userEvent.setup();
    vi.mocked(listAlerts).mockResolvedValue({ items: [alert()] });
    renderPage();

    await waitFor(() => expect(screen.getByText('Delete')).toBeInTheDocument());
    await user.click(screen.getByText('Delete'));
    await user.click(screen.getByText('Cancel'));

    expect(deleteAlert).not.toHaveBeenCalled();
    expect(screen.queryByText(/It stops being evaluated/)).not.toBeInTheDocument();
  });

  test('at 390 px opens alert creation as a bottom sheet', async () => {
    setViewportWidth(390);
    vi.mocked(listAlerts).mockResolvedValue({ items: [] });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: '+ New alert' }));
    expect(screen.getByRole('dialog', { name: 'New price alert' })).toHaveClass(
      'bt-dialog__panel--phone-sheet',
    );
  });
});
