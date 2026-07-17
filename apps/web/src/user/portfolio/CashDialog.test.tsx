import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { ApiError } from '../../lib/apiClient';

vi.mock('../../lib/portfolioApi');
import * as portfolioApi from '../../lib/portfolioApi';

import { CashDialog } from './CashDialog';

import type { CashSource } from '@bettertrack/contracts';

function cashSource(over: Partial<CashSource>): CashSource {
  return {
    id: 'src-x',
    name: 'Source',
    type: 'cash',
    isMain: false,
    archivedAt: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    balanceEur: 0,
    ...over,
  };
}

const MAIN = cashSource({ id: 'src-main', name: 'Main', isMain: true, balanceEur: 1000 });
const BANK = cashSource({ id: 'src-bank', name: 'Bank', type: 'bank', balanceEur: 500 });

function renderDialog(
  initialKind: 'deposit' | 'withdrawal' = 'deposit',
  extra: Partial<React.ComponentProps<typeof CashDialog>> = {},
) {
  const onClose = vi.fn();
  const onSubmitted = vi.fn();
  render(
    <CashDialog
      portfolioId="p1"
      initialKind={initialKind}
      onClose={onClose}
      onSubmitted={onSubmitted}
      today="2026-07-02"
      {...extra}
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
        sourceId: 'src-main',
        transactionId: null,
        transferId: null,
        counterpartSourceId: null,
        dividendId: null,
        taxYear: null,
        executedAt: '2026-07-02T00:00:00.000Z',
        note: null,
        source: 'manual',
        createdAt: '2026-07-02T00:00:00.000Z',
      },
      sourceBalanceEur: 1500,
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

  test('keeps the source picker out of the way when only Main exists', () => {
    renderDialog('deposit', { sources: [MAIN] });
    expect(screen.queryByLabelText('Cash source')).not.toBeInTheDocument();
  });

  test('offers a source picker (default Main) and posts the chosen source', async () => {
    vi.mocked(portfolioApi.depositCash).mockResolvedValue({
      movement: {
        id: 'm1',
        kind: 'deposit',
        amountEur: 500,
        sourceId: 'src-bank',
        transactionId: null,
        transferId: null,
        counterpartSourceId: null,
        dividendId: null,
        taxYear: null,
        executedAt: '2026-07-02T00:00:00.000Z',
        note: null,
        source: 'manual',
        createdAt: '2026-07-02T00:00:00.000Z',
      },
      sourceBalanceEur: 1000,
      balanceEur: 1500,
    });
    const user = userEvent.setup();
    renderDialog('deposit', { sources: [MAIN, BANK] });

    const picker = screen.getByLabelText('Cash source');
    expect(picker).toHaveValue('src-main');
    await user.selectOptions(picker, 'src-bank');
    await user.type(screen.getByLabelText('Amount'), '500');
    await user.click(screen.getByRole('button', { name: 'Deposit cash' }));

    await waitFor(() =>
      expect(portfolioApi.depositCash).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ amountEur: 500, sourceId: 'src-bank' }),
      ),
    );
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
