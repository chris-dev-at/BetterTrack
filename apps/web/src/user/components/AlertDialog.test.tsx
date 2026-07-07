import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { Alert } from '@bettertrack/contracts';

vi.mock('../../lib/alertsApi', () => ({
  ALERTS_QUERY_KEY: ['alerts'],
  createAlert: vi.fn(),
  updateAlert: vi.fn(),
}));

import { createAlert, updateAlert } from '../../lib/alertsApi';
import { AlertDialog, type AlertDialogAsset } from './AlertDialog';

const ASSET: AlertDialogAsset = { id: 'a1', symbol: 'AAPL', name: 'Apple Inc.', currency: 'USD' };

function renderDialog(props: Partial<React.ComponentProps<typeof AlertDialog>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AlertDialog onClose={onClose} {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AlertDialog (asset-locked inline create)', () => {
  test('prefills the threshold with the current quote for a price kind', () => {
    renderDialog({ asset: ASSET, referencePrice: 187.5 });
    expect(screen.getByLabelText(/Threshold price \(USD\)/)).toHaveValue(187.5);
  });

  test('switching to a percent kind changes the threshold unit', async () => {
    const user = userEvent.setup();
    renderDialog({ asset: ASSET, referencePrice: 187.5 });

    await user.selectOptions(screen.getByLabelText('When'), 'pct_day_up');
    expect(screen.getByLabelText('Percent change')).toBeInTheDocument();
    // The reference-context hint appears for the *_from_ref kinds only.
    await user.selectOptions(screen.getByLabelText('When'), 'pct_up_from_ref');
    expect(screen.getByText(/captured as the reference/)).toBeInTheDocument();
  });

  test('creating posts the asset, kind, threshold and repeat', async () => {
    const user = userEvent.setup();
    vi.mocked(createAlert).mockResolvedValue({} as Alert);
    const { onClose } = renderDialog({ asset: ASSET, referencePrice: 100 });

    await user.selectOptions(screen.getByLabelText('When'), 'price_below');
    const input = screen.getByLabelText(/Threshold price/);
    await user.clear(input);
    await user.type(input, '90');
    await user.click(screen.getByRole('button', { name: 'Create alert' }));

    await waitFor(() =>
      expect(createAlert).toHaveBeenCalledWith({
        assetId: 'a1',
        kind: 'price_below',
        threshold: 90,
        repeat: false,
      }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  test('rejects a non-positive threshold before calling the API', async () => {
    const user = userEvent.setup();
    renderDialog({ asset: ASSET, referencePrice: null });
    const input = screen.getByLabelText(/Threshold price/);
    await user.clear(input);
    await user.type(input, '0');
    await user.click(screen.getByRole('button', { name: 'Create alert' }));

    expect(await screen.findByText(/greater than 0/)).toBeInTheDocument();
    expect(createAlert).not.toHaveBeenCalled();
  });
});

describe('AlertDialog (edit)', () => {
  const EXISTING: Alert = {
    id: 'al1',
    kind: 'pct_up_from_ref',
    threshold: 10,
    refPrice: 150,
    repeat: false,
    status: 'active',
    lastTriggeredAt: null,
    asset: { id: 'a1', symbol: 'AAPL', name: 'Apple Inc.', currency: 'USD', type: 'stock' },
  };

  test('locks the kind and patches threshold + repeat', async () => {
    const user = userEvent.setup();
    vi.mocked(updateAlert).mockResolvedValue(EXISTING);
    renderDialog({ existing: EXISTING });

    // Kind is immutable — no selector, just static text.
    expect(screen.queryByLabelText('When')).not.toBeInstanceOf(HTMLSelectElement);
    expect(screen.getByText('Rises % from reference')).toBeInTheDocument();

    const input = screen.getByLabelText('Percent change');
    await user.clear(input);
    await user.type(input, '15');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(updateAlert).toHaveBeenCalledWith('al1', { threshold: 15, repeat: false }),
    );
  });
});
