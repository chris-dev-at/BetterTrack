import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { ApiError } from '../../lib/apiClient';

vi.mock('../../lib/portfolioApi');
import * as portfolioApi from '../../lib/portfolioApi';

import { CashDialog } from './CashDialog';

function renderDialog(initialKind: 'deposit' | 'withdrawal' = 'deposit') {
  const onClose = vi.fn();
  const onSubmitted = vi.fn();
  render(
    <CashDialog
      portfolioId="p1"
      initialKind={initialKind}
      onClose={onClose}
      onSubmitted={onSubmitted}
      today="2026-07-02"
    />,
  );
  return { onClose, onSubmitted };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(portfolioApi.previewCash).mockResolvedValue({
    availableEur: 1000,
    afterEur: 1500,
    sufficient: true,
    shortfallEur: 0,
  });
});

describe('CashDialog', () => {
  test('opens on the requested kind (deposit or withdrawal)', () => {
    renderDialog('withdrawal');
    const dialog = screen.getByRole('dialog', { name: 'Cash balance' });
    expect(within(dialog).getByRole('button', { name: 'Withdraw' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(dialog).getByRole('button', { name: 'Withdraw cash' })).toBeInTheDocument();
  });

  test('deposits an amount and reports success', async () => {
    vi.mocked(portfolioApi.depositCash).mockResolvedValue({
      movement: {
        id: 'm1',
        kind: 'deposit',
        amountEur: 500,
        transactionId: null,
        executedAt: '2026-07-02T00:00:00.000Z',
        note: null,
        createdAt: '2026-07-02T00:00:00.000Z',
      },
      balanceEur: 1500,
    });
    const user = userEvent.setup();
    const { onClose, onSubmitted } = renderDialog();

    await user.type(screen.getByLabelText('Amount'), '500');
    await waitFor(() => expect(screen.getByText(/Available/)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Deposit cash' }));

    await waitFor(() =>
      expect(portfolioApi.depositCash).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ amountEur: 500, executedAt: '2026-07-02T00:00:00.000Z' }),
      ),
    );
    expect(onSubmitted).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('blocks a withdrawal beyond the available balance via the live preview', async () => {
    vi.mocked(portfolioApi.previewCash).mockResolvedValue({
      availableEur: 100,
      afterEur: -400,
      sufficient: false,
      shortfallEur: 400,
    });
    const user = userEvent.setup();
    renderDialog('withdrawal');

    await user.type(screen.getByLabelText('Amount'), '500');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Withdraw cash' })).toBeDisabled(),
    );
    expect(screen.getByText(/short/i)).toBeInTheDocument();
    expect(portfolioApi.withdrawCash).not.toHaveBeenCalled();
  });

  test('surfaces the server insufficient-cash error if a race lets a bad withdrawal through', async () => {
    vi.mocked(portfolioApi.withdrawCash).mockRejectedValue(
      new ApiError(400, 'INSUFFICIENT_CASH', 'Insufficient cash balance.'),
    );
    const user = userEvent.setup();
    renderDialog('withdrawal');

    await user.type(screen.getByLabelText('Amount'), '10');
    await waitFor(() => expect(screen.getByText(/Available/)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Withdraw cash' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Insufficient cash balance/i);
  });
});
